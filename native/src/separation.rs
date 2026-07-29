use std::path::Path;

use anyhow::{Context, Result, ensure};
use babycat::{
    Signal, Waveform, WaveformArgs,
    constants::{DECODING_BACKEND_SYMPHONIA, RESAMPLE_MODE_LIBSAMPLERATE},
};
use mb_roformer_mlx::MelBandRoformer;
use mlx_rs::{
    Array,
    ops::{self, indexing},
};

const AUDIO_CHANNELS: i32 = 2;
const MODEL_SAMPLE_RATE: u32 = 44_100;
const CHUNK_SIZE_SAMPLES: i32 = 352_800;

pub struct Separator {
    model: MelBandRoformer,
}

impl Separator {
    pub fn load(path: &Path) -> Result<Self> {
        let mut model = MelBandRoformer::new();
        model
            .load(path)
            .with_context(|| format!("failed to load separation model {}", path.display()))?;
        Ok(Self { model })
    }

    pub fn separate(
        &mut self,
        input: &Path,
        vocal_out: &Path,
        instrumental_out: &Path,
        num_overlap: i32,
        mut progress: impl FnMut(&str, f64),
    ) -> Result<()> {
        ensure!(num_overlap >= 1, "num_overlap must be positive");
        progress("load audio", 0.0);
        let audio = load_audio(input)?;
        let vocal = demix_track(&mut self.model, &audio, num_overlap, &mut progress)?;
        let instrumental = ops::subtract(&audio, &vocal)?;
        progress("write output", 1.0);
        save_audio(&vocal, vocal_out, MODEL_SAMPLE_RATE)?;
        save_audio(&instrumental, instrumental_out, MODEL_SAMPLE_RATE)?;
        Ok(())
    }
}

fn path_to_str(path: &Path) -> Result<&str> {
    path.to_str()
        .ok_or_else(|| anyhow::anyhow!("path is not valid UTF-8: {path:?}"))
}

fn load_audio(input_path: &Path) -> Result<Array> {
    let waveform_args = WaveformArgs {
        frame_rate_hz: MODEL_SAMPLE_RATE,
        resample_mode: RESAMPLE_MODE_LIBSAMPLERATE,
        decoding_backend: DECODING_BACKEND_SYMPHONIA,
        ..Default::default()
    };
    let waveform = Waveform::from_file(path_to_str(input_path)?, waveform_args)?;
    ensure!(
        waveform.num_frames() > 0,
        "input audio contains no decoded frames"
    );
    ensure!(
        waveform.num_channels() > 0,
        "input audio contains no decoded channels"
    );

    let audio = Array::from_slice(
        waveform.to_interleaved_samples(),
        &[waveform.num_frames() as i32, waveform.num_channels() as i32],
    );
    let audio = ops::transpose_axes(&audio, &[1, 0])?;
    if waveform.num_channels() == 1 {
        Ok(ops::repeat_axis::<f32>(audio, AUDIO_CHANNELS, 0)?)
    } else if waveform.num_channels() == 2 {
        Ok(audio)
    } else {
        let indices = Array::from_slice(&[0i64, 1], &[2]);
        Ok(indexing::take_axis(&audio, &indices, 0)?)
    }
}

fn reflect_pad_for_overlap(audio: &Array, border: i32) -> Result<Array> {
    let shape = audio.shape();
    let audio_len = shape[1];
    let padded_len = audio_len + border * 2;
    let pos = ops::arange::<_, i32>(0, padded_len, None)?;
    let left_source = ops::subtract(Array::from_slice(&[border], &[]), &pos)?;
    let middle_source = ops::subtract(&pos, Array::from_slice(&[border], &[]))?;
    let right_source = ops::subtract(Array::from_slice(&[2 * audio_len + border - 2], &[]), &pos)?;
    let left_mask = pos.lt(Array::from_slice(&[border], &[]))?;
    let right_mask = pos.ge(Array::from_slice(&[audio_len + border], &[]))?;
    let indices = ops::which(&left_mask, &left_source, &middle_source)?;
    let indices = ops::which(&right_mask, &right_source, &indices)?;
    Ok(indexing::take_axis(audio, &indices, 1)?)
}

fn windowing_array() -> Result<Array> {
    let fade_size = CHUNK_SIZE_SAMPLES / 10;
    let pos = ops::arange::<_, f32>(0.0, CHUNK_SIZE_SAMPLES as f32, None)?;
    let ones = ops::ones::<f32>(&[CHUNK_SIZE_SAMPLES])?;
    let denom = Array::from_slice(&[(fade_size - 1) as f32], &[]);
    let fade_in = ops::divide(&pos, &denom)?;
    let fade_out = ops::divide(
        &ops::subtract(
            Array::from_slice(&[(CHUNK_SIZE_SAMPLES - 1) as f32], &[]),
            &pos,
        )?,
        &denom,
    )?;
    let left_mask = pos.lt(Array::from_slice(&[fade_size as f32], &[]))?;
    let right_mask = pos.ge(Array::from_slice(
        &[(CHUNK_SIZE_SAMPLES - fade_size) as f32],
        &[],
    ))?;
    let window = ops::which(&left_mask, &fade_in, &ones)?;
    Ok(ops::which(&right_mask, &fade_out, &window)?)
}

fn pad_chunk_to_model_size(part: &Array, length: i32) -> Result<Array> {
    if length == CHUNK_SIZE_SAMPLES {
        return Ok(part.clone());
    }

    if length > CHUNK_SIZE_SAMPLES / 2 + 1 {
        let pos = ops::arange::<_, i32>(0, CHUNK_SIZE_SAMPLES, None)?;
        let right_source = ops::subtract(Array::from_slice(&[2 * length - 2], &[]), &pos)?;
        let in_audio = pos.lt(Array::from_slice(&[length], &[]))?;
        let indices = ops::which(&in_audio, &pos, &right_source)?;
        Ok(indexing::take_axis(part, &indices, 1)?)
    } else {
        let padding = ops::zeros::<f32>(&[AUDIO_CHANNELS, CHUNK_SIZE_SAMPLES - length])?;
        Ok(ops::concatenate_axis(&[part, &padding], 1)?)
    }
}

fn scatter_add_overlap(
    destination: &Array,
    updates: &Array,
    start: i32,
    length: i32,
    total_length: i32,
) -> Result<Array> {
    let channel_offsets = ops::multiply(
        &ops::arange::<_, i64>(0i64, AUDIO_CHANNELS as i64, None)?.reshape(&[
            1,
            AUDIO_CHANNELS,
            1,
        ])?,
        Array::from_slice(&[total_length as i64], &[]),
    )?;
    let time_offsets = ops::arange::<_, i64>(start as i64, (start + length) as i64, None)?
        .reshape(&[1, 1, length])?;
    let indices = ops::add(&channel_offsets, &time_offsets)?;
    let indices = ops::reshape(&indices, &[AUDIO_CHANNELS * length])?;
    let flat_destination = ops::reshape(destination, &[AUDIO_CHANNELS * total_length])?;
    let flat_updates = ops::reshape(updates, &[AUDIO_CHANNELS * length, 1])?;
    let flat_output = indexing::scatter_add_single(flat_destination, &indices, &flat_updates, 0)?;
    Ok(ops::reshape(
        &flat_output,
        &[1, AUDIO_CHANNELS, total_length],
    )?)
}

fn demix_track(
    model: &mut MelBandRoformer,
    audio: &Array,
    num_overlap: i32,
    progress: &mut impl FnMut(&str, f64),
) -> Result<Array> {
    let step = CHUNK_SIZE_SAMPLES / num_overlap;
    let fade_size = CHUNK_SIZE_SAMPLES / 10;
    let border = CHUNK_SIZE_SAMPLES - step;
    let original_len = audio.shape()[1];
    let padded = original_len > 2 * border && border > 0;
    let mix = if padded {
        reflect_pad_for_overlap(audio, border)?
    } else {
        audio.clone()
    };
    let total_length = mix.shape()[1];
    let base_window = windowing_array()?;
    let window_pos = ops::arange::<_, i32>(0, CHUNK_SIZE_SAMPLES, None)?;
    let window_ones = ops::ones::<f32>(&[CHUNK_SIZE_SAMPLES])?;
    let mut result = ops::zeros::<f32>(&[1, AUDIO_CHANNELS, total_length])?;
    let mut counter = ops::zeros::<f32>(&[1, AUDIO_CHANNELS, total_length])?;
    let mix_strides = mix.strides();
    let mut offset = 0;
    let total_chunks = (total_length + step - 1) / step;
    let mut chunk_index = 0;

    while offset < total_length {
        progress(
            "separate",
            chunk_index as f64 / total_chunks as f64,
        );
        let length = (total_length - offset).min(CHUNK_SIZE_SAMPLES);
        let part = ops::as_strided(
            &mix,
            &[AUDIO_CHANNELS, length],
            &[mix_strides[0] as i64, mix_strides[1] as i64],
            offset as usize * mix_strides[1],
        )?;
        let part = pad_chunk_to_model_size(&part, length)?;
        let model_input = part.expand_dims(0)?;
        let model_output = model.infer(&model_input)?;
        let output_strides = model_output.strides();
        let model_output = ops::as_strided(
            &model_output,
            &[1, AUDIO_CHANNELS, length],
            &[
                output_strides[0] as i64,
                output_strides[1] as i64,
                output_strides[2] as i64,
            ],
            0,
        )?;

        let window = if offset == 0 {
            let mask = window_pos.lt(Array::from_slice(&[fade_size], &[]))?;
            ops::which(&mask, &window_ones, &base_window)?
        } else if offset + CHUNK_SIZE_SAMPLES >= total_length {
            let mask = window_pos.ge(Array::from_slice(&[CHUNK_SIZE_SAMPLES - fade_size], &[]))?;
            ops::which(&mask, &window_ones, &base_window)?
        } else {
            base_window.clone()
        };
        let window_strides = window.strides();
        let window = ops::as_strided(&window, &[length], &[window_strides[0] as i64], 0)?;
        let window = window.reshape(&[1, 1, length])?;
        let weighted = ops::multiply(&model_output, &window)?;
        let counter_update = ops::broadcast_to(&window, &[1, AUDIO_CHANNELS, length])?;
        result = scatter_add_overlap(&result, &weighted, offset, length, total_length)?;
        counter = scatter_add_overlap(&counter, &counter_update, offset, length, total_length)?;
        offset += step;
        chunk_index += 1;
    }

    let estimated = ops::divide(&result, &counter)?;
    let estimated = estimated.squeeze_axes(&[0])?;
    if padded {
        let strides = estimated.strides();
        Ok(ops::as_strided(
            &estimated,
            &[AUDIO_CHANNELS, original_len],
            &[strides[0] as i64, strides[1] as i64],
            border as usize * strides[1],
        )?)
    } else {
        Ok(estimated)
    }
}

fn save_audio(audio: &Array, output_path: &Path, sample_rate: u32) -> Result<()> {
    let interleaved = ops::transpose_axes(audio, &[1, 0])?;
    let interleaved = ops::flatten(&interleaved, None, None)?;
    let waveform = Waveform::new(
        sample_rate,
        AUDIO_CHANNELS as u16,
        interleaved.as_slice::<f32>().to_vec(),
    );
    waveform.to_wav_file(path_to_str(output_path)?)?;
    Ok(())
}

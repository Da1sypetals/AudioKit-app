mod separation;

use anyhow::{Context, Result, ensure};
use separation::Separator;
use std::cell::RefCell;
use std::ffi::{CStr, CString, c_char, c_double, c_int};
use std::fs::File;
use std::io::{BufWriter, Write};
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::path::{Path, PathBuf};
use std::ptr;
use yingmusic::{InferParams, MelVideo, Progress, YingMusicSvc, YingMusicSvcPaths};

pub enum Engine {
    Svc(Box<YingMusicSvc>),
    Sep(Box<Separator>),
}

pub type AkProgressCallback = extern "C" fn(*const c_char, c_double);

thread_local! {
    static LAST_ERROR: RefCell<CString> = RefCell::new(CString::default());
}

fn set_last_error(message: impl std::fmt::Display) {
    LAST_ERROR.with(|slot| {
        *slot.borrow_mut() = CString::new(message.to_string()).expect("error message contains NUL")
    });
}

#[unsafe(no_mangle)]
pub extern "C" fn ak_last_error() -> *const c_char {
    LAST_ERROR.with(|slot| slot.borrow().as_ptr())
}

fn read_cstr(ptr: *const c_char) -> Result<String> {
    ensure!(!ptr.is_null(), "unexpected null string argument");
    let value = unsafe { CStr::from_ptr(ptr) }
        .to_str()
        .context("string argument is not valid UTF-8")?;
    Ok(value.to_owned())
}

fn run_ffi<T>(operation: &str, f: impl FnOnce() -> Result<T>) -> Option<T> {
    match catch_unwind(AssertUnwindSafe(f)) {
        Ok(Ok(value)) => Some(value),
        Ok(Err(error)) => {
            set_last_error(format!("{error:#}"));
            None
        }
        Err(payload) => {
            let detail = payload
                .downcast_ref::<&str>()
                .map(|value| (*value).to_owned())
                .or_else(|| payload.downcast_ref::<String>().cloned())
                .unwrap_or_else(|| "unknown panic payload".to_owned());
            set_last_error(format!("{operation} panicked: {detail}"));
            None
        }
    }
}

fn progress_trampoline(callback: Option<AkProgressCallback>) -> impl FnMut(&str, f64) {
    move |stage, fraction| {
        if let Some(callback) = callback {
            let stage = CString::new(stage).expect("stage name contains NUL");
            callback(stage.as_ptr(), fraction);
        }
    }
}

fn write_mel_video(path: &Path, video: &MelVideo) -> Result<()> {
    ensure!(
        video.values.len() == video.steps * video.num_mels * video.num_frames,
        "mel video data length mismatch"
    );
    let steps = u32::try_from(video.steps).context("mel video has too many steps")?;
    let num_mels = u32::try_from(video.num_mels).context("mel video has too many mel bins")?;
    let num_frames =
        u32::try_from(video.num_frames).context("mel video has too many timeline frames")?;
    let mut output = BufWriter::new(File::create(path)?);
    output.write_all(b"AKMV0001")?;
    output.write_all(&steps.to_le_bytes())?;
    output.write_all(&num_mels.to_le_bytes())?;
    output.write_all(&num_frames.to_le_bytes())?;
    for value in &video.values {
        output.write_all(&value.to_le_bytes())?;
    }
    output.flush()?;
    Ok(())
}

#[unsafe(no_mangle)]
pub extern "C" fn ak_svc_create(
    whisper: *const c_char,
    fcpe: *const c_char,
    campplus: *const c_char,
    yingmusic: *const c_char,
    pupu_vocoder: *const c_char,
    pc_nsf_hifigan: *const c_char,
) -> *mut Engine {
    let result = run_ffi("ak_svc_create", || {
        let paths = YingMusicSvcPaths {
            whisper: PathBuf::from(read_cstr(whisper)?),
            fcpe: PathBuf::from(read_cstr(fcpe)?),
            campplus: PathBuf::from(read_cstr(campplus)?),
            yingmusic: PathBuf::from(read_cstr(yingmusic)?),
            pupu_vocoder: PathBuf::from(read_cstr(pupu_vocoder)?),
            pc_nsf_hifigan: PathBuf::from(read_cstr(pc_nsf_hifigan)?),
        };
        Ok(Engine::Svc(Box::new(YingMusicSvc::new(&paths)?)))
    });
    result
        .map(|engine| Box::into_raw(Box::new(engine)))
        .unwrap_or(ptr::null_mut())
}

#[unsafe(no_mangle)]
pub extern "C" fn ak_sep_create(model_path: *const c_char) -> *mut Engine {
    let result = run_ffi("ak_sep_create", || {
        let model_path = PathBuf::from(read_cstr(model_path)?);
        Ok(Engine::Sep(Box::new(Separator::load(&model_path)?)))
    });
    result
        .map(|engine| Box::into_raw(Box::new(engine)))
        .unwrap_or(ptr::null_mut())
}

#[unsafe(no_mangle)]
/// # Safety
/// `engine` 必须是 `ak_svc_create` / `ak_sep_create` 返回的句柄，且只能释放一次。
pub unsafe extern "C" fn ak_engine_free(engine: *mut Engine) {
    if engine.is_null() {
        return;
    }
    drop(unsafe { Box::from_raw(engine) });
}

#[unsafe(no_mangle)]
/// # Safety
/// `engine` 必须是 `ak_svc_create` 返回的存活句柄；字符串参数必须是合法的 NUL 结尾 UTF-8。
pub unsafe extern "C" fn ak_svc_infer(
    engine: *mut Engine,
    source: *const c_char,
    reference: *const c_char,
    diffusion_steps: c_int,
    pitch_shift: c_double,
    cfg_rate: c_double,
    input_gain_db: c_double,
    resynth_with_explicit_f0: c_int,
    generate_video: c_int,
    output: *const c_char,
    re_f0_output: *const c_char,
    video_mel_output: *const c_char,
    on_progress: Option<AkProgressCallback>,
) -> c_int {
    let result = run_ffi("ak_svc_infer", || {
        ensure!(!engine.is_null(), "engine handle is null");
        ensure!(diffusion_steps > 0, "diffusion_steps must be positive");
        ensure!(
            matches!(resynth_with_explicit_f0, 0 | 1),
            "resynth_with_explicit_f0 must be 0 or 1"
        );
        ensure!(
            matches!(generate_video, 0 | 1),
            "generate_video must be 0 or 1"
        );
        let engine = unsafe { &mut *engine };
        let Engine::Svc(svc) = engine else {
            anyhow::bail!("engine handle is not an SVC engine");
        };
        let source = read_cstr(source)?;
        let reference = read_cstr(reference)?;
        let output = read_cstr(output)?;
        let resynth_with_explicit_f0 = resynth_with_explicit_f0 == 1;
        let generate_video = generate_video == 1;
        let re_f0_output = if resynth_with_explicit_f0 {
            Some(read_cstr(re_f0_output)?)
        } else {
            None
        };
        let video_mel_output = if generate_video {
            Some(read_cstr(video_mel_output)?)
        } else {
            None
        };
        let params = InferParams {
            diffusion_steps: diffusion_steps as usize,
            pitch_shift: pitch_shift as f32,
            cfg_rate: cfg_rate as f32,
            input_gain_db: input_gain_db as f32,
            resynth_with_explicit_f0,
            collect_video_mel: generate_video,
        };
        let mut report = progress_trampoline(on_progress);
        let inference = svc.infer(
            Path::new(&source),
            Path::new(&reference),
            &params,
            Path::new(&output),
            re_f0_output.as_deref().map(Path::new),
            Some(&mut |event: Progress| match event {
                Progress::Stage(name) => report(name, -1.0),
                Progress::Diffusion { done, total } => {
                    report("diffusion", done as f64 / total as f64)
                }
                Progress::ChunkStage { name, chunk, total } => {
                    let stage = format!("{name}:{chunk}/{total}");
                    report(&stage, -1.0);
                }
            }),
        )?;
        if let Some(video_mel_output) = video_mel_output {
            report("write video mel", -1.0);
            let mel_video = inference
                .mel_video
                .as_ref()
                .context("inference did not return mel video data")?;
            write_mel_video(Path::new(&video_mel_output), mel_video)?;
        }
        Ok(())
    });
    if result.is_some() { 0 } else { -1 }
}

#[unsafe(no_mangle)]
/// # Safety
/// `engine` 必须是 `ak_sep_create` 返回的存活句柄；字符串参数必须是合法的 NUL 结尾 UTF-8。
pub unsafe extern "C" fn ak_sep_infer(
    engine: *mut Engine,
    input: *const c_char,
    vocal_out: *const c_char,
    instrumental_out: *const c_char,
    num_overlap: c_int,
    on_progress: Option<AkProgressCallback>,
) -> c_int {
    let result = run_ffi("ak_sep_infer", || {
        ensure!(!engine.is_null(), "engine handle is null");
        let engine = unsafe { &mut *engine };
        let Engine::Sep(separator) = engine else {
            anyhow::bail!("engine handle is not a separation engine");
        };
        let input = read_cstr(input)?;
        let vocal_out = read_cstr(vocal_out)?;
        let instrumental_out = read_cstr(instrumental_out)?;
        separator.separate(
            Path::new(&input),
            Path::new(&vocal_out),
            Path::new(&instrumental_out),
            num_overlap,
            progress_trampoline(on_progress),
        )?;
        Ok(())
    });
    if result.is_some() { 0 } else { -1 }
}

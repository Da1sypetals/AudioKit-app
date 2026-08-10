const { parentPort, workerData } = require('worker_threads');
const koffi = require('koffi');
const fs = require('fs');

const lib = koffi.load(workerData.nativeLibPath);
const VIDEO_SAMPLING_MULTIPLIERS = new Set([1, 2, 4, 8, 16, 32, 64, 128]);

koffi.proto('void ak_progress_cb(const char *stage, double fraction)');

const akLastError = lib.func('str ak_last_error(void)');
const akSvcCreate = lib.func(
  'void *ak_svc_create(str whisper, str rmvpe, str fcpe, str campplus, str yingmusic, str pupu_vocoder, str pc_nsf_hifigan)'
);
const akSepCreate = lib.func('void *ak_sep_create(str model_path)');
const akEngineFree = lib.func('void ak_engine_free(void *engine)');
const akSvcInfer = lib.func(
  'int ak_svc_infer(void *engine, str source, str reference, int f0_estimator, int diffusion_steps, double pitch_shift, double cfg_rate, double input_gain_db, int keep_first_vocoder_output, int generate_video, str output, str first_vocoder_output, str video_mel_output, ak_progress_cb *cb)'
);
const akSepInfer = lib.func(
  'int ak_sep_infer(void *engine, str input, str vocal_out, str instrumental_out, int num_overlap, ak_progress_cb *cb)'
);

let svcEngine = null;
let svcKey = null;
let sepEngine = null;
let sepKey = null;

function lastError() {
  return akLastError() || 'unknown native error';
}

function getSvcEngine(paths) {
  const key = JSON.stringify(paths);
  if (svcEngine && svcKey === key) return svcEngine;
  if (svcEngine) {
    akEngineFree(svcEngine);
    svcEngine = null;
  }
  const handle = akSvcCreate(
    paths.whisper,
    paths.rmvpe,
    paths.fcpe,
    paths.campplus,
    paths.yingmusic,
    paths.pupuVocoder,
    paths.pcNsfHifigan
  );
  if (!handle) throw new Error(`加载 YingMusic 模型失败: ${lastError()}`);
  svcEngine = handle;
  svcKey = key;
  return handle;
}

function getSepEngine(modelPath) {
  if (sepEngine && sepKey === modelPath) return sepEngine;
  if (sepEngine) {
    akEngineFree(sepEngine);
    sepEngine = null;
  }
  const handle = akSepCreate(modelPath);
  if (!handle) throw new Error(`加载分离模型失败: ${lastError()}`);
  sepEngine = handle;
  sepKey = modelPath;
  return handle;
}

function makeProgressCallback(jobId) {
  let lastSent = 0;
  return (stage, fraction) => {
    const now = Date.now();
    if (fraction >= 0 && now - lastSent < 50) return;
    lastSent = now;
    parentPort.postMessage({ type: 'progress', jobId, stage, fraction });
  };
}

parentPort.on('message', (msg) => {
  const { type, jobId } = msg;
  try {
    if (type === 'run-svc') {
      if (
        msg.generateVideo &&
        (!Number.isInteger(msg.videoDuration) || msg.videoDuration < 20 || msg.videoDuration > 120)
      ) {
        throw new RangeError('视频时长必须是 20 到 120 秒之间的整数');
      }
      if (
        msg.generateVideo &&
        !VIDEO_SAMPLING_MULTIPLIERS.has(msg.videoSamplingMultiplier)
      ) {
        throw new RangeError('模拟采样倍数必须是 1、2、4、8、16、32、64 或 128');
      }
      const engine = getSvcEngine(msg.paths);
      const f0Estimator = { rmvpe: 0, fcpe: 1 }[msg.f0Estimator];
      if (f0Estimator === undefined) {
        throw new RangeError(`不支持的 F0 estimator: ${msg.f0Estimator}`);
      }
      const rc = akSvcInfer(
        engine,
        msg.source,
        msg.reference,
        f0Estimator,
        msg.diffusionSteps,
        msg.pitchShift,
        msg.cfgRate,
        msg.inputGainDb,
        msg.keepFirstVocoderOutput ? 1 : 0,
        msg.generateVideo ? 1 : 0,
        msg.output,
        msg.firstVocoderOutput,
        msg.videoMelOutput,
        makeProgressCallback(jobId)
      );
      if (rc !== 0) throw new Error(lastError());
      const outputs = msg.keepFirstVocoderOutput
        ? [msg.output, msg.firstVocoderOutput]
        : [msg.output];
      if (msg.generateVideo) {
        const binary = fs.readFileSync(msg.videoMelOutput);
        fs.unlinkSync(msg.videoMelOutput);
        const melData = binary.buffer.slice(binary.byteOffset, binary.byteOffset + binary.byteLength);
        parentPort.postMessage(
          {
            type: 'video-data',
            jobId,
            outputs,
            videoOutput: msg.videoOutput,
            videoDuration: msg.videoDuration,
            videoSamplingMultiplier: msg.videoSamplingMultiplier,
            melData,
          },
          [melData]
        );
      } else {
        parentPort.postMessage({ type: 'done', jobId, outputs });
      }
    } else if (type === 'run-sep') {
      const engine = getSepEngine(msg.modelPath);
      const rc = akSepInfer(
        engine,
        msg.input,
        msg.vocalOut,
        msg.instrumentalOut,
        msg.numOverlap,
        makeProgressCallback(jobId)
      );
      if (rc !== 0) throw new Error(lastError());
      parentPort.postMessage({ type: 'done', jobId, outputs: [msg.vocalOut, msg.instrumentalOut] });
    }
  } catch (error) {
    parentPort.postMessage({ type: 'error', jobId, message: error.message });
  }
});

parentPort.postMessage({ type: 'ready' });

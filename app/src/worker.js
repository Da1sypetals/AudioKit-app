const { parentPort, workerData } = require('worker_threads');
const koffi = require('koffi');

const lib = koffi.load(workerData.nativeLibPath);

koffi.proto('void ak_progress_cb(const char *stage, double fraction)');

const akLastError = lib.func('str ak_last_error(void)');
const akSvcCreate = lib.func(
  'void *ak_svc_create(str whisper, str fcpe, str campplus, str yingmusic, str pupu_vocoder, str pc_nsf_hifigan)'
);
const akSepCreate = lib.func('void *ak_sep_create(str model_path)');
const akEngineFree = lib.func('void ak_engine_free(void *engine)');
const akSvcInfer = lib.func(
  'int ak_svc_infer(void *engine, str source, str reference, int diffusion_steps, double pitch_shift, double cfg_rate, str output, ak_progress_cb *cb)'
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
      const engine = getSvcEngine(msg.paths);
      const rc = akSvcInfer(
        engine,
        msg.source,
        msg.reference,
        msg.diffusionSteps,
        msg.pitchShift,
        msg.cfgRate,
        msg.output,
        makeProgressCallback(jobId)
      );
      if (rc !== 0) throw new Error(lastError());
      parentPort.postMessage({ type: 'done', jobId, outputs: [msg.output] });
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

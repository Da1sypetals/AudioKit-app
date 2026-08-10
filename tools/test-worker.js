// 无 GUI 端到端测试：通过 worker_threads + koffi 跑真实推理
// 用法: node tools/test-worker.js [sep|svc|all]
const path = require('path');
const fs = require('fs');
const { Worker } = require('worker_threads');

const root = path.join(__dirname, '..');
const nativeLibPath = path.join(root, 'app', 'native', 'libaudiokit_native.dylib');
const modelsDir = path.join(root, 'app', 'Models');
const outRoot = path.join(root, 'scratch');
fs.mkdirSync(outRoot, { recursive: true });

const SVC_PATHS = {
  whisper: path.join(modelsDir, 'yingmusic', 'whisper.safetensors'),
  rmvpe: path.join(modelsDir, 'yingmusic', 'rmvpe.safetensors'),
  fcpe: path.join(modelsDir, 'yingmusic', 'fcpe.safetensors'),
  campplus: path.join(modelsDir, 'yingmusic', 'campplus.safetensors'),
  yingmusic: path.join(modelsDir, 'yingmusic', 'yingmusic_step_000640.safetensors'),
  pupuVocoder: path.join(modelsDir, 'yingmusic', 'pupu-vocoder-large.safetensors'),
  pcNsfHifigan: path.join(modelsDir, 'yingmusic', 'pc-nsf-hifigan.safetensors'),
};

const mode = process.argv[2] || 'all';
const omittedFirstVocoderOutput = path.join(outRoot, 'test_svc_omitted_first_vocoder.wav');
const videoMelOutput = path.join(outRoot, 'test_svc_mel.akmv');
if (fs.existsSync(omittedFirstVocoderOutput)) fs.unlinkSync(omittedFirstVocoderOutput);
if (fs.existsSync(videoMelOutput)) fs.unlinkSync(videoMelOutput);

const worker = new Worker(path.join(root, 'app', 'src', 'worker.js'), {
  workerData: { nativeLibPath },
});

const jobs = [];
if (mode === 'sep' || mode === 'all') {
  const input = path.join(root, 'yingmusic-svc-mlx', 'audio', '骨簪干音.wav');
  jobs.push({
    type: 'run-sep',
    jobId: 'test-sep',
    modelPath: path.join(modelsDir, 'separation', 'melband-roformer.safetensors'),
    input,
    vocalOut: path.join(outRoot, 'test_vocal.wav'),
    instrumentalOut: path.join(outRoot, 'test_instrumental.wav'),
    numOverlap: 2,
  });
}
if (mode === 'svc' || mode === 'svc-video' || mode === 'all') {
  jobs.push({
    type: 'run-svc',
    jobId: 'test-svc-keep-first-vocoder',
    paths: SVC_PATHS,
    source: path.join(root, 'yingmusic-svc-mlx', 'audio', '骨簪干音.wav'),
    reference: path.join(root, 'yingmusic-svc-mlx', 'audio', 'timbre', 'xiaoke.wav'),
    f0Estimator: 'rmvpe',
    diffusionSteps: 4,
    pitchShift: 14.0,
    cfgRate: 0.9,
    inputGainDb: -2.0,
    keepFirstVocoderOutput: true,
    generateVideo: true,
    videoDuration: 20,
    videoSamplingMultiplier: 32,
    output: path.join(outRoot, 'test_svc.wav'),
    firstVocoderOutput: path.join(outRoot, 'test_svc_first_vocoder.wav'),
    videoMelOutput,
    videoOutput: path.join(outRoot, 'test_svc_mel.mp4'),
  });
}
if (mode === 'svc' || mode === 'all') {
  jobs.push({
    type: 'run-svc',
    jobId: 'test-svc-output-only',
    paths: SVC_PATHS,
    source: path.join(root, 'yingmusic-svc-mlx', 'audio', '骨簪干音.wav'),
    reference: path.join(root, 'yingmusic-svc-mlx', 'audio', 'timbre', 'xiaoke.wav'),
    f0Estimator: 'fcpe',
    diffusionSteps: 4,
    pitchShift: 14.0,
    cfgRate: 0.9,
    inputGainDb: -2.0,
    keepFirstVocoderOutput: false,
    generateVideo: false,
    videoDuration: 20,
    videoSamplingMultiplier: 32,
    output: path.join(outRoot, 'test_svc_output_only.wav'),
    firstVocoderOutput: omittedFirstVocoderOutput,
    videoMelOutput,
    videoOutput: path.join(outRoot, 'test_svc_output_only_mel.mp4'),
  });
}

let pending = jobs.length;
let failed = false;

worker.on('message', (msg) => {
  if (msg.type === 'ready') {
    console.log('[test] worker ready, starting', pending, 'job(s)');
    for (const job of jobs) worker.postMessage(job);
    return;
  }
  if (msg.type === 'progress') {
    const pct = msg.fraction >= 0 ? ` ${(msg.fraction * 100).toFixed(0)}%` : '';
    process.stdout.write(`\r[test] ${msg.jobId}: ${msg.stage}${pct}   `);
    return;
  }
  if (msg.type === 'video-data') {
    const data = Buffer.from(msg.melData);
    fs.writeFileSync(videoMelOutput, data);
    const steps = data.readUInt32LE(8);
    const numMels = data.readUInt32LE(12);
    const numFrames = data.readUInt32LE(16);
    const valid =
      data.subarray(0, 8).toString() === 'AKMV0001' &&
      steps === 5 &&
      numMels === 128 &&
      numFrames >= 1 &&
      numFrames <= 1280 &&
      msg.videoSamplingMultiplier === 32 &&
      data.length === 20 + steps * numMels * numFrames * 4;
    if (!valid) {
      failed = true;
      console.error(`\n[test] ${msg.jobId} ERROR: invalid mel video data`);
    }
    pending -= 1;
    console.log(`\n[test] ${msg.jobId} mel video: ${steps} × ${numMels} × ${numFrames}`);
    for (const output of msg.outputs) {
      const stat = fs.statSync(output);
      console.log(`  ${output} (${(stat.size / 1024 / 1024).toFixed(2)} MB)`);
    }
  } else if (msg.type === 'done') {
    pending -= 1;
    console.log(`\n[test] ${msg.jobId} done:`);
    for (const output of msg.outputs) {
      const stat = fs.statSync(output);
      console.log(`  ${output} (${(stat.size / 1024 / 1024).toFixed(2)} MB)`);
    }
  } else if (msg.type === 'error') {
    pending -= 1;
    failed = true;
    console.error(`\n[test] ${msg.jobId} ERROR: ${msg.message}`);
  }
  if (pending === 0) {
    if (fs.existsSync(omittedFirstVocoderOutput)) {
      console.error(`\n[test] unexpected output: ${omittedFirstVocoderOutput}`);
      failed = true;
    }
    worker.terminate().then(() => process.exit(failed ? 1 : 0));
  }
});

worker.on('error', (error) => {
  console.error('[test] worker error:', error);
  process.exit(1);
});

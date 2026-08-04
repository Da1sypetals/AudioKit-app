const { app, BrowserWindow, ipcMain, shell, dialog, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const { Worker } = require('worker_threads');
const ffmpegStatic = require('ffmpeg-static');

app.setName('AudioKit');
app.setAboutPanelOptions({ applicationName: 'AudioKit' });

const AUDIO_EXTENSIONS = new Set([
  '.wav',
  '.mp3',
  '.m4a',
  '.aac',
  '.flac',
  '.ogg',
  '.aiff',
  '.aif',
  '.mp4',
  '.opus',
]);
const VIDEO_EXTENSIONS = new Set(['.mp4']);

const resourcesRoot = app.isPackaged ? process.resourcesPath : path.join(__dirname, '..');
const modelsDir = path.join(resourcesRoot, 'Models');
const nativeLibPath = path.join(resourcesRoot, 'native', 'libaudiokit_native.dylib');
const ffmpegPath = app.isPackaged
  ? ffmpegStatic.replace(`${path.sep}app.asar${path.sep}`, `${path.sep}app.asar.unpacked${path.sep}`)
  : ffmpegStatic;

const userDataDir = app.getPath('userData');
const timbreDir = path.join(userDataDir, 'audio', 'timbre');
const cacheRoot = path.join(os.homedir(), 'Library', 'Caches', 'AudioKit');
const inputDir = path.join(cacheRoot, 'input');
const outputDir = path.join(cacheRoot, 'output');

const SVC_MODEL_PATHS = {
  whisper: path.join(modelsDir, 'yingmusic', 'whisper.safetensors'),
  fcpe: path.join(modelsDir, 'yingmusic', 'fcpe.safetensors'),
  campplus: path.join(modelsDir, 'yingmusic', 'campplus.safetensors'),
  yingmusic: path.join(modelsDir, 'yingmusic', 'yingmusic_step_000640.safetensors'),
  pupuVocoder: path.join(modelsDir, 'yingmusic', 'pupu-vocoder-large.safetensors'),
  pcNsfHifigan: path.join(modelsDir, 'yingmusic', 'pc-nsf-hifigan.safetensors'),
};
const SEP_MODEL_PATH = path.join(modelsDir, 'separation', 'melband-roformer.safetensors');

let mainWindow = null;
let worker = null;
let jobCounter = 0;
let dragIcon = null;
let dragInProgress = false;

function ensureDirs() {
  for (const dir of [timbreDir, inputDir, outputDir]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function ensureWorker() {
  if (worker) return worker;
  worker = new Worker(path.join(__dirname, 'worker.js'), {
    workerData: { nativeLibPath },
  });
  worker.on('message', (msg) => {
    if (msg.type === 'ready') return;
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('job:event', msg);
    }
  });
  worker.on('error', (error) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('job:event', {
        type: 'error',
        jobId: null,
        message: `推理线程错误: ${error.message}`,
      });
    }
  });
  worker.on('exit', (code) => {
    worker = null;
    if (code !== 0) {
      console.error(`worker exited with code ${code}`);
    }
  });
  return worker;
}

function isAudioFile(filePath) {
  return AUDIO_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

function isVideoFile(filePath) {
  return VIDEO_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

function isOutputMediaFile(filePath) {
  return isAudioFile(filePath) || isVideoFile(filePath);
}

function timestamp() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, '0');
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

function copyInto(sourcePath, destDir) {
  const base = path.basename(sourcePath);
  const ext = path.extname(base);
  const stem = path.basename(base, ext);
  let dest = path.join(destDir, base);
  let counter = 2;
  while (fs.existsSync(dest)) {
    dest = path.join(destDir, `${stem}-${counter}${ext}`);
    counter += 1;
  }
  fs.copyFileSync(sourcePath, dest);
  // copyFileSync 保留源 mtime；刷新为导入时间，保证最新导入排在列表最前
  const now = new Date();
  fs.utimesSync(dest, now, now);
  return dest;
}

function audioFileInfo(filePath) {
  const stat = fs.statSync(filePath);
  return {
    name: path.basename(filePath),
    path: filePath,
    size: stat.size,
    mtime: stat.mtimeMs,
    kind: isVideoFile(filePath) ? 'video' : 'audio',
  };
}

function listAudioFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .map((name) => path.join(dir, name))
    .filter((filePath) => fs.statSync(filePath).isFile() && isAudioFile(filePath))
    .map(audioFileInfo)
    .sort((a, b) => b.mtime - a.mtime);
}

function listOutputs() {
  if (!fs.existsSync(outputDir)) return [];
  const groups = [];
  for (const name of fs.readdirSync(outputDir)) {
    const dir = path.join(outputDir, name);
    if (!fs.statSync(dir).isDirectory()) continue;
    let meta = {};
    const metaPath = path.join(dir, 'meta.json');
    if (fs.existsSync(metaPath)) {
      meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    }
    const files = fs
      .readdirSync(dir)
      .map((fileName) => path.join(dir, fileName))
      .filter((filePath) => fs.statSync(filePath).isFile() && isOutputMediaFile(filePath))
      .map(audioFileInfo)
      .sort((a, b) => a.name.localeCompare(b.name));
    groups.push({
      dir,
      name,
      type: meta.type || 'unknown',
      source: meta.source || '',
      params: meta.params || {},
      mtime: fs.statSync(dir).mtimeMs,
      files,
    });
  }
  return groups.sort((a, b) => b.mtime - a.mtime);
}

function createOutputGroup(type, source, params, stemParts) {
  const dirName = `${timestamp()}-${stemParts.join('-')}`;
  const dir = path.join(outputDir, dirName);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'meta.json'),
    JSON.stringify({ type, source, params, createdAt: Date.now() }, null, 2)
  );
  return dir;
}

function stemOf(filePath) {
  return path.basename(filePath, path.extname(filePath));
}

function resolveDragFile(filePath) {
  if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) {
    throw new TypeError('拖拽文件路径必须是绝对路径');
  }
  const resolvedOutputDir = fs.realpathSync(outputDir);
  const resolvedFile = fs.realpathSync(filePath);
  const relativePath = path.relative(resolvedOutputDir, resolvedFile);
  if (!relativePath || relativePath.startsWith(`..${path.sep}`) || path.isAbsolute(relativePath)) {
    throw new Error(`拖拽文件不在输出目录中: ${resolvedFile}`);
  }
  if (!fs.statSync(resolvedFile).isFile() || !isOutputMediaFile(resolvedFile)) {
    throw new Error(`拖拽目标不是媒体文件: ${resolvedFile}`);
  }
  return resolvedFile;
}

function resolveVideoOutput(filePath) {
  if (typeof filePath !== 'string' || !path.isAbsolute(filePath) || !isVideoFile(filePath)) {
    throw new TypeError('视频输出路径必须是绝对 MP4 路径');
  }
  const resolvedOutputDir = fs.realpathSync(outputDir);
  const resolvedParent = fs.realpathSync(path.dirname(filePath));
  const relativeParent = path.relative(resolvedOutputDir, resolvedParent);
  if (relativeParent.startsWith(`..${path.sep}`) || path.isAbsolute(relativeParent)) {
    throw new Error(`视频输出路径不在输出目录中: ${filePath}`);
  }
  return path.join(resolvedParent, path.basename(filePath));
}

function transcodeVideo(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, [
      '-hide_banner',
      '-loglevel',
      'error',
      '-n',
      '-i',
      inputPath,
      '-c:v',
      'libx264',
      '-preset',
      'medium',
      '-crf',
      '18',
      '-pix_fmt',
      'yuv420p',
      '-movflags',
      '+faststart',
      '-an',
      outputPath,
    ]);
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`FFmpeg 转码失败 (${code}): ${stderr.trim()}`));
    });
  });
}

function registerIpc() {
  ipcMain.handle('paths:get', () => ({
    timbreDir,
    inputDir,
    outputDir,
    modelsDir,
  }));

  ipcMain.handle('dialog:pick-audio', async (_event, options = {}) => {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: options.multi ? ['openFile', 'multiSelections'] : ['openFile'],
      filters: [
        { name: '音频文件', extensions: [...AUDIO_EXTENSIONS].map((ext) => ext.slice(1)) },
        { name: '所有文件', extensions: ['*'] },
      ],
    });
    return result.canceled ? [] : result.filePaths;
  });

  ipcMain.handle('timbre:list', () => listAudioFiles(timbreDir));

  ipcMain.handle('timbre:import', (_event, filePaths) => {
    const imported = [];
    for (const filePath of filePaths) {
      if (!isAudioFile(filePath)) continue;
      imported.push(audioFileInfo(copyInto(filePath, timbreDir)));
    }
    return imported;
  });

  ipcMain.handle('timbre:delete', (_event, name) => {
    const target = path.join(timbreDir, path.basename(name));
    if (fs.existsSync(target)) fs.unlinkSync(target);
    return listAudioFiles(timbreDir);
  });

  ipcMain.handle('timbre:rename', (_event, oldName, newStem) => {
    const oldPath = path.join(timbreDir, path.basename(oldName));
    const ext = path.extname(oldName);
    const clean = String(newStem).trim().replace(/[\\/]/g, '');
    if (!clean) return { ok: false, error: '名称不能为空' };
    const newPath = path.join(timbreDir, clean + ext);
    if (newPath === oldPath) return { ok: true, name: clean + ext, path: newPath };
    // APFS 不区分大小写：仅大小写变化时 existsSync 会误判为冲突
    const sameFile = newPath.toLowerCase() === oldPath.toLowerCase();
    if (!sameFile && fs.existsSync(newPath)) {
      return { ok: false, error: `已存在同名文件 ${clean + ext}` };
    }
    fs.renameSync(oldPath, newPath);
    return { ok: true, name: clean + ext, path: newPath };
  });

  ipcMain.handle('input:list', () => listAudioFiles(inputDir));

  ipcMain.handle('input:import', (_event, filePaths) => {
    const imported = [];
    for (const filePath of filePaths) {
      if (!isAudioFile(filePath)) continue;
      imported.push(audioFileInfo(copyInto(filePath, inputDir)));
    }
    return imported;
  });

  ipcMain.handle('input:delete', (_event, name) => {
    const target = path.join(inputDir, path.basename(name));
    if (fs.existsSync(target)) fs.unlinkSync(target);
    return listAudioFiles(inputDir);
  });

  ipcMain.handle('outputs:list', () => listOutputs());

  ipcMain.handle('outputs:delete', (_event, dirName) => {
    const target = path.join(outputDir, path.basename(dirName));
    if (fs.existsSync(target)) fs.rmSync(target, { recursive: true });
    return listOutputs();
  });

  ipcMain.handle('video:write', async (_event, filePath, bytes) => {
    if (!(bytes instanceof Uint8Array)) {
      throw new TypeError('视频数据必须是 Uint8Array');
    }
    const outputPath = resolveVideoOutput(filePath);
    if (fs.existsSync(outputPath)) throw new Error(`视频输出已存在: ${outputPath}`);
    const intermediatePath = path.join(path.dirname(outputPath), '.mel-video.webm');
    await fs.promises.writeFile(intermediatePath, bytes);
    try {
      await transcodeVideo(intermediatePath, outputPath);
      const stat = await fs.promises.stat(outputPath);
      if (stat.size === 0) throw new Error('FFmpeg 未产生有效 MP4 文件');
    } catch (error) {
      if (fs.existsSync(outputPath)) await fs.promises.unlink(outputPath);
      throw error;
    } finally {
      await fs.promises.unlink(intermediatePath);
    }
    return audioFileInfo(outputPath);
  });

  ipcMain.handle('file:reveal', (_event, filePath) => {
    shell.showItemInFolder(filePath);
  });

  ipcMain.handle('job:sep', (event, options) => {
    const { inputPath, numOverlap } = options;
    const jobId = `sep-${++jobCounter}`;
    const groupDir = createOutputGroup('separation', path.basename(inputPath), { numOverlap }, [
      stemOf(inputPath),
      'separation',
    ]);
    ensureWorker().postMessage({
      type: 'run-sep',
      jobId,
      modelPath: SEP_MODEL_PATH,
      input: inputPath,
      vocalOut: path.join(groupDir, `${stemOf(inputPath)}_vocal.wav`),
      instrumentalOut: path.join(groupDir, `${stemOf(inputPath)}_instrumental.wav`),
      numOverlap,
    });
    return { jobId };
  });

  ipcMain.handle('job:svc', (event, options) => {
    const {
      sourcePath,
      referencePath,
      diffusionSteps,
      pitchShift,
      cfgRate,
      inputGainDb,
      resynthWithExplicitF0,
      generateVideo,
      videoDuration,
    } = options;
    if (!Number.isFinite(inputGainDb) || inputGainDb < -12 || inputGainDb > 3) {
      throw new RangeError('Input gain 必须在 -12 dB 到 +3 dB 之间');
    }
    if (!Number.isInteger(inputGainDb * 2)) {
      throw new RangeError('Input gain 必须使用 0.5 dB 步长');
    }
    if (typeof resynthWithExplicitF0 !== 'boolean') {
      throw new TypeError('resynth w/ explicit f0 必须是 boolean');
    }
    if (typeof generateVideo !== 'boolean') {
      throw new TypeError('generateVideo 必须是 boolean');
    }
    if (generateVideo && (!Number.isInteger(videoDuration) || videoDuration < 15 || videoDuration > 30)) {
      throw new RangeError('视频时长必须是 15 到 30 秒之间的整数');
    }
    const jobId = `svc-${++jobCounter}`;
    const groupDir = createOutputGroup(
      'svc',
      path.basename(sourcePath),
      {
        diffusionSteps,
        pitchShift,
        cfgRate,
        inputGainDb,
        resynthWithExplicitF0,
        generateVideo,
        videoDuration: generateVideo ? videoDuration : null,
        reference: path.basename(referencePath),
      },
      [stemOf(sourcePath), 'to', stemOf(referencePath)]
    );
    const outputStem = `${stemOf(sourcePath)}_to_${stemOf(referencePath)}`;
    const videoOutput = path.join(groupDir, `${outputStem}_mel.mp4`);
    ensureWorker().postMessage({
      type: 'run-svc',
      jobId,
      paths: SVC_MODEL_PATHS,
      source: sourcePath,
      reference: referencePath,
      diffusionSteps,
      pitchShift,
      cfgRate,
      inputGainDb,
      resynthWithExplicitF0,
      generateVideo,
      videoDuration,
      output: path.join(groupDir, `${outputStem}.wav`),
      reF0Output: path.join(groupDir, `${outputStem}_re_f0.wav`),
      videoMelOutput: path.join(groupDir, '.mel-video.akmv'),
      videoOutput,
    });
    return { jobId };
  });

  ipcMain.on('drag:start', (event, filePath) => {
    if (dragInProgress) return;
    const resolvedFile = resolveDragFile(filePath);
    dragInProgress = true;
    try {
      event.sender.startDrag({ file: resolvedFile, icon: dragIcon });
    } finally {
      dragInProgress = false;
    }
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 980,
    minHeight: 600,
    backgroundColor: '#ffffff',
    title: 'AudioKit',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

app.whenReady().then(() => {
  const dockIcon = path.join(resourcesRoot, 'dock-icon.png');
  dragIcon = nativeImage.createFromPath(dockIcon).resize({ width: 32, height: 32 });
  if (dragIcon.isEmpty()) {
    throw new Error(`无法加载拖拽图标: ${dockIcon}`);
  }
  if (process.platform === 'darwin') {
    app.dock.setIcon(nativeImage.createFromPath(dockIcon));
  }
  ensureDirs();
  registerIpc();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('quit', () => {
  if (worker) {
    worker.terminate();
    worker = null;
  }
});

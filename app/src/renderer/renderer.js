const ICONS = {
  play: '<svg viewBox="0 0 16 16" width="13" height="13" fill="currentColor"><path d="M4.5 3l8 5-8 5z"/></svg>',
  pause:
    '<svg viewBox="0 0 16 16" width="13" height="13" fill="currentColor"><rect x="4" y="3" width="2.6" height="10" rx="0.5"/><rect x="9.4" y="3" width="2.6" height="10" rx="0.5"/></svg>',
  folder:
    '<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor"><path d="M2 4.5a1 1 0 0 1 1-1h3.6l1.4 1.7h5a1 1 0 0 1 1 1v6.3a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1z"/></svg>',
  trash:
    '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"><path d="M3 4.5h10M6.5 4.5v-1h3v1M4.5 4.5l.6 8.5h5.8l.6-8.5M6.6 6.8v4M9.4 6.8v4"/></svg>',
  plus: '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><path d="M8 3v10M3 8h10"/></svg>',
};

const state = {
  view: 'separation',
  running: false,
  sep: { input: null, numOverlap: 2 },
  svc: {
    source: null,
    reference: null,
    steps: 16,
    pitchShift: 12,
    cfgRate: 0.9,
    inputGainDb: -2,
    resynthWithExplicitF0: true,
    videoDuration: 20,
  },
  timbres: [],
  inputs: [],
  outputs: [],
};

const $ = (id) => document.getElementById(id);
const api = window.audiokit;

let audioPlayer = null;
let playbackPath = null;
let isPlaying = false;
let playbackProgress = 0;
let seeking = false;

/* ---------------- helpers ---------------- */

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatTime(mtime) {
  const date = new Date(mtime);
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function setStatus(text, isError = false) {
  $('status-text').textContent = text;
  $('statusbar').classList.toggle('error', isError);
}

function setProgress(fraction) {
  const bar = $('status-progress');
  if (fraction == null || fraction < 0) {
    bar.classList.add('hidden');
    return;
  }
  bar.classList.remove('hidden');
  $('status-progress-fill').style.width = `${Math.round(fraction * 100)}%`;
}

const STAGE_LABELS = {
  'load audio': '加载音频',
  'extract features': '提取特征',
  'encode content': '编码内容',
  diffusion: '扩散采样',
  separate: '分离推理',
  'write output': '写出音频',
  'render video': '生成频谱视频',
};

function stageLabel(stage) {
  return STAGE_LABELS[stage] || stage;
}

function parseMelVideo(buffer) {
  const bytes = new Uint8Array(buffer);
  const magic = new TextDecoder().decode(bytes.subarray(0, 8));
  if (magic !== 'AKMV0001') throw new Error('mel 视频数据格式无效');
  const header = new DataView(buffer, 8, 12);
  const steps = header.getUint32(0, true);
  const numMels = header.getUint32(4, true);
  const numFrames = header.getUint32(8, true);
  if (steps < 1 || numMels < 1 || numFrames < 1) {
    throw new Error('mel 视频维度无效');
  }
  const expectedBytes = 20 + steps * numMels * numFrames * Float32Array.BYTES_PER_ELEMENT;
  if (buffer.byteLength !== expectedBytes) throw new Error('mel 视频数据长度不匹配');
  return {
    steps,
    numMels,
    numFrames,
    values: new Float32Array(buffer, 20),
  };
}

function makeMelPalette() {
  const stops = [
    [0.0, [8, 7, 24]],
    [0.22, [69, 18, 111]],
    [0.48, [169, 48, 126]],
    [0.74, [244, 114, 92]],
    [1.0, [252, 253, 191]],
  ];
  return Array.from({ length: 256 }, (_, index) => {
    const value = index / 255;
    const rightIndex = stops.findIndex(([position]) => position >= value);
    const right = stops[Math.max(1, rightIndex)];
    const left = stops[Math.max(0, rightIndex - 1)];
    const fraction = (value - left[0]) / (right[0] - left[0]);
    return left[1].map((channel, channelIndex) =>
      Math.round(channel + (right[1][channelIndex] - channel) * fraction)
    );
  });
}

function melValueRange(values) {
  const stride = Math.max(1, Math.ceil(values.length / 200000));
  const sampled = [];
  for (let index = 0; index < values.length; index += stride) {
    const value = values[index];
    if (Number.isFinite(value)) sampled.push(value);
  }
  sampled.sort((a, b) => a - b);
  if (sampled.length < 2) throw new Error('mel 视频缺少有效数据');
  const low = sampled[Math.floor((sampled.length - 1) * 0.02)];
  const high = sampled[Math.floor((sampled.length - 1) * 0.98)];
  if (!(high > low)) throw new Error('mel 视频动态范围无效');
  return { low, high };
}

function createMelStepCanvases(video) {
  const palette = makeMelPalette();
  const { low, high } = melValueRange(video.values);
  const scale = 255 / (high - low);
  const canvases = [];
  for (let step = 0; step < video.steps; step += 1) {
    const canvas = document.createElement('canvas');
    canvas.width = video.numFrames;
    canvas.height = video.numMels;
    const context = canvas.getContext('2d');
    const pixels = context.createImageData(video.numFrames, video.numMels);
    for (let mel = 0; mel < video.numMels; mel += 1) {
      for (let frame = 0; frame < video.numFrames; frame += 1) {
        const sourceIndex = (step * video.numMels + mel) * video.numFrames + frame;
        const level = Math.max(0, Math.min(255, Math.round((video.values[sourceIndex] - low) * scale)));
        const color = palette[level];
        const targetIndex = ((video.numMels - mel - 1) * video.numFrames + frame) * 4;
        pixels.data[targetIndex] = color[0];
        pixels.data[targetIndex + 1] = color[1];
        pixels.data[targetIndex + 2] = color[2];
        pixels.data[targetIndex + 3] = 255;
      }
    }
    context.putImageData(pixels, 0, 0);
    canvases.push(canvas);
  }
  return canvases;
}

function drawMelVideoFrame(context, stepCanvases, progress) {
  const width = context.canvas.width;
  const height = context.canvas.height;
  const plot = { x: 58, y: 82, width: width - 92, height: height - 144 };
  const stepPosition = progress * stepCanvases.length;
  const stepIndex = Math.min(stepCanvases.length - 1, Math.floor(stepPosition));
  const fade = stepPosition >= stepCanvases.length ? 1 : stepPosition - stepIndex;

  context.fillStyle = '#080a12';
  context.fillRect(0, 0, width, height);
  context.fillStyle = '#111525';
  context.fillRect(plot.x, plot.y, plot.width, plot.height);
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  if (stepIndex > 0) {
    context.globalAlpha = 1;
    context.drawImage(stepCanvases[stepIndex - 1], plot.x, plot.y, plot.width, plot.height);
  }
  context.globalAlpha = fade;
  context.drawImage(stepCanvases[stepIndex], plot.x, plot.y, plot.width, plot.height);
  context.globalAlpha = 1;

  context.strokeStyle = '#3b4255';
  context.lineWidth = 1;
  context.strokeRect(plot.x + 0.5, plot.y + 0.5, plot.width - 1, plot.height - 1);
  context.fillStyle = '#f0f3f7';
  context.font = '600 24px -apple-system, BlinkMacSystemFont, sans-serif';
  context.fillText('YingMusic · MEL SPECTROGRAM', plot.x, 44);
  context.fillStyle = '#9ba7ba';
  context.font = '15px -apple-system, BlinkMacSystemFont, sans-serif';
  context.fillText(`Integration ${stepIndex + 1} / ${stepCanvases.length}`, plot.x, 67);
  context.fillText('LOW', 17, plot.y + plot.height - 3);
  context.fillText('HIGH', 12, plot.y + 14);
  context.fillText('FULL AUDIO TIMELINE', plot.x, height - 28);
  context.textAlign = 'right';
  context.fillText(`${Math.round(progress * 100)}%`, plot.x + plot.width, height - 28);
  context.textAlign = 'left';
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function encodeMelVideo(buffer, durationSeconds, onProgress) {
  const mimeType = 'video/webm;codecs=vp9';
  if (!MediaRecorder.isTypeSupported(mimeType)) {
    throw new Error('当前环境不支持 VP9 WebM 编码');
  }
  const video = parseMelVideo(buffer);
  const stepCanvases = createMelStepCanvases(video);
  const canvas = document.createElement('canvas');
  canvas.width = 1280;
  canvas.height = 720;
  const context = canvas.getContext('2d');
  const stream = canvas.captureStream(30);
  const recorder = new MediaRecorder(stream, {
    mimeType,
    videoBitsPerSecond: 8000000,
  });
  const chunks = [];
  recorder.addEventListener('dataavailable', (event) => {
    if (event.data.size > 0) chunks.push(event.data);
  });
  const stopped = new Promise((resolve, reject) => {
    recorder.addEventListener('stop', resolve, { once: true });
    recorder.addEventListener('error', (event) => reject(event.error), { once: true });
  });

  const frameRate = 30;
  const totalFrames = durationSeconds * frameRate;
  recorder.start();
  const startedAt = performance.now();
  try {
    for (let frame = 0; frame < totalFrames; frame += 1) {
      const progress = totalFrames === 1 ? 1 : frame / (totalFrames - 1);
      drawMelVideoFrame(context, stepCanvases, progress);
      onProgress((frame + 1) / totalFrames);
      const targetTime = startedAt + ((frame + 1) * 1000) / frameRate;
      await delay(Math.max(0, targetTime - performance.now()));
    }
    recorder.stop();
    await stopped;
  } finally {
    for (const track of stream.getTracks()) track.stop();
  }
  const output = new Blob(chunks, { type: mimeType });
  if (output.size === 0) throw new Error('视频编码器未产生有效数据');
  return output;
}

/* ---------------- rendering ---------------- */

function renderFileList(element, files, { selectedPath, onSelect, onDelete, emptyText, itemTitleSuffix = '' }) {
  element.innerHTML = '';
  if (files.length === 0) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = emptyText;
    element.appendChild(li);
    return;
  }
  for (const file of files) {
    const li = document.createElement('li');
    if (selectedPath === file.path) li.classList.add('selected');

    const name = document.createElement('span');
    name.className = 'file-name';
    name.textContent = file.name;
    name.title = file.path + itemTitleSuffix;
    li.appendChild(name);

    const del = document.createElement('button');
    del.className = 'row-action danger';
    del.innerHTML = ICONS.trash;
    del.title = '删除';
    del.addEventListener('click', (event) => {
      event.stopPropagation();
      onDelete(file);
    });
    li.appendChild(del);

    li.addEventListener('click', () => onSelect(file));
    element.appendChild(li);
  }
}

function renderSidebar() {
  const isSep = state.view === 'separation';
  $('sidebar-separation').classList.toggle('hidden', !isSep);
  $('sidebar-svc').classList.toggle('hidden', isSep);

  renderFileList($('sep-input-list'), state.inputs, {
    selectedPath: state.sep.input?.path,
    emptyText: '拖放音频到此处',
    onSelect: (file) => {
      state.sep.input = file;
      updateInputDisplays();
      renderSidebar();
    },
    onDelete: async (file) => {
      state.inputs = await api.deleteInput(file.name);
      if (state.sep.input?.path === file.path) state.sep.input = null;
      updateInputDisplays();
      renderSidebar();
    },
  });

  renderFileList($('timbre-list'), state.timbres, {
    selectedPath: state.svc.reference?.path,
    emptyText: '拖放音频到此处加入音色库',
    itemTitleSuffix: '\n选中后按 Enter 改名',
    onSelect: (file) => {
      state.svc.reference = file;
      updateInputDisplays();
      renderSidebar();
    },
    onDelete: async (file) => {
      state.timbres = await api.deleteTimbre(file.name);
      if (state.svc.reference?.path === file.path) state.svc.reference = null;
      updateInputDisplays();
      renderSidebar();
    },
  });

  renderFileList($('svc-input-list'), state.inputs, {
    selectedPath: state.svc.source?.path,
    emptyText: '拖放音频到此处',
    onSelect: (file) => {
      state.svc.source = file;
      updateInputDisplays();
      renderSidebar();
    },
    onDelete: async (file) => {
      state.inputs = await api.deleteInput(file.name);
      if (state.svc.source?.path === file.path) state.svc.source = null;
      updateInputDisplays();
      renderSidebar();
    },
  });

  updateRunButtons();
}

function setInputDisplay(id, file, unsetText) {
  const element = $(id);
  if (file) {
    element.textContent = file.name;
    element.classList.remove('unset');
  } else {
    element.textContent = unsetText;
    element.classList.add('unset');
  }
}

function updateInputDisplays() {
  setInputDisplay('sep-input-name', state.sep.input, '未选择 — 从左侧列表选择，或直接拖入音频');
  setInputDisplay('svc-input-name', state.svc.source, '未选择 — 从左侧列表选择，或直接拖入音频');
  setInputDisplay('svc-reference-name', state.svc.reference, '未选择 — 从左侧音色库选择');
}

function onTimeUpdate() {
  if (!audioPlayer || !audioPlayer.duration || seeking) return;
  playbackProgress = audioPlayer.currentTime / audioPlayer.duration;
  const fill = document.getElementById('playback-fill');
  if (fill) fill.style.width = `${playbackProgress * 100}%`;
}

function seekTo(clientX, track) {
  if (!audioPlayer || !audioPlayer.duration) return;
  const rect = track.getBoundingClientRect();
  const fraction = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
  playbackProgress = fraction;
  const fill = document.getElementById('playback-fill');
  if (fill) fill.style.width = `${fraction * 100}%`;
  audioPlayer.currentTime = fraction * audioPlayer.duration;
}

function setupSeek(strip, track) {
  strip.addEventListener('pointerdown', (event) => {
    if (!audioPlayer || !audioPlayer.duration) return;
    seeking = true;
    seekTo(event.clientX, track);
    event.preventDefault();
  });
}

function setupSeekGlobal() {
  window.addEventListener('pointermove', (event) => {
    if (!seeking) return;
    const track = document.querySelector('.playback-track');
    if (track) seekTo(event.clientX, track);
  });
  window.addEventListener('pointerup', () => {
    seeking = false;
  });
}

function onEnded() {
  isPlaying = false;
  playbackProgress = 0;
  audioPlayer.currentTime = 0;
  renderOutputs();
}

function playOrPause(filePath) {
  if (playbackPath === filePath && audioPlayer) {
    if (audioPlayer.paused) {
      audioPlayer.play();
      isPlaying = true;
    } else {
      audioPlayer.pause();
      isPlaying = false;
    }
  } else {
    if (audioPlayer) audioPlayer.pause();
    playbackPath = filePath;
    playbackProgress = 0;
    audioPlayer = new Audio(`file://${filePath}`);
    audioPlayer.addEventListener('timeupdate', onTimeUpdate);
    audioPlayer.addEventListener('ended', onEnded);
    audioPlayer.play();
    isPlaying = true;
  }
  renderOutputs();
}

function renderOutputs() {
  seeking = false;
  for (const [containerId, type] of [
    ['sep-outputs', 'separation'],
    ['svc-outputs', 'svc'],
  ]) {
    const container = $(containerId);
    container.innerHTML = '';
    const groups = state.outputs.filter((group) => group.type === type);
    if (groups.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'output-empty';
      empty.textContent = '暂无输出';
      container.appendChild(empty);
      continue;
    }
    for (const group of groups) {
      const groupEl = document.createElement('div');
      groupEl.className = 'output-group';

      const header = document.createElement('div');
      header.className = 'output-group-header';

      const groupName = document.createElement('span');
      groupName.className = 'group-name';
      groupName.textContent = group.name;
      groupName.title = group.dir;
      header.appendChild(groupName);

      const groupTime = document.createElement('span');
      groupTime.className = 'group-time';
      groupTime.textContent = formatTime(group.mtime);
      header.appendChild(groupTime);

      const reveal = document.createElement('button');
      reveal.className = 'row-action';
      reveal.innerHTML = ICONS.folder;
      reveal.title = '在 Finder 中显示';
      reveal.addEventListener('click', () => api.reveal(group.dir));
      header.appendChild(reveal);

      const del = document.createElement('button');
      del.className = 'row-action danger';
      del.innerHTML = ICONS.trash;
      del.title = '删除输出';
      del.addEventListener('click', async () => {
        state.outputs = await api.deleteOutput(group.name);
        renderOutputs();
      });
      header.appendChild(del);

      groupEl.appendChild(header);

      for (const file of group.files) {
        const entry = document.createElement('div');
        entry.className = 'output-entry';

        const row = document.createElement('div');
        row.className = 'output-file';
        row.draggable = true;
        row.title = `${file.path}\n可拖出到其他应用`;

        const active = playbackPath === file.path;
        if (file.kind === 'audio') {
          const playBtn = document.createElement('button');
          playBtn.className = 'play-btn';
          playBtn.innerHTML = active && isPlaying ? ICONS.pause : ICONS.play;
          playBtn.title = active && isPlaying ? '暂停' : '播放';
          playBtn.addEventListener('click', () => playOrPause(file.path));
          row.appendChild(playBtn);
        } else {
          const kind = document.createElement('span');
          kind.className = 'media-kind';
          kind.textContent = 'MP4';
          row.appendChild(kind);
        }

        const fileName = document.createElement('span');
        fileName.className = 'file-name';
        fileName.textContent = file.name;
        row.appendChild(fileName);

        const fileSize = document.createElement('span');
        fileSize.className = 'file-size';
        fileSize.textContent = formatSize(file.size);
        row.appendChild(fileSize);

        const revealBtn = document.createElement('button');
        revealBtn.className = 'row-action';
        revealBtn.innerHTML = ICONS.folder;
        revealBtn.title = '在 Finder 中显示';
        revealBtn.addEventListener('click', () => api.reveal(file.path));
        row.appendChild(revealBtn);

        row.addEventListener('dragstart', (event) => {
          event.preventDefault();
          event.stopPropagation();
          api.startDrag(file.path);
        });

        entry.appendChild(row);

        if (active && file.kind === 'audio') {
          const strip = document.createElement('div');
          strip.className = 'playback';
          const track = document.createElement('div');
          track.className = 'playback-track';
          const fill = document.createElement('div');
          fill.className = 'playback-fill';
          fill.id = 'playback-fill';
          fill.style.width = `${playbackProgress * 100}%`;
          track.appendChild(fill);
          strip.appendChild(track);
          entry.appendChild(strip);
          setupSeek(strip, track);
        }

        groupEl.appendChild(entry);
      }

      container.appendChild(groupEl);
    }
  }
}

function updateRunButtons() {
  $('sep-run').disabled = state.running || !state.sep.input;
  $('svc-run').disabled = state.running || !state.svc.source || !state.svc.reference;
  $('svc-run-video').disabled = state.running || !state.svc.source || !state.svc.reference;
}

/* ---------------- timbre rename ---------------- */

function startTimbreRename(file) {
  renderSidebar();
  const li = [...$('timbre-list').children].find(
    (el) => el.querySelector('.file-name')?.title.startsWith(file.path)
  );
  if (!li) return;
  const nameSpan = li.querySelector('.file-name');
  const ext = file.name.slice(file.name.lastIndexOf('.'));
  const stem = file.name.slice(0, file.name.length - ext.length);

  const editor = document.createElement('input');
  editor.className = 'inline-edit';
  editor.value = stem;
  nameSpan.replaceWith(editor);
  editor.focus();
  editor.select();

  let finished = false;
  const finish = async (commit) => {
    if (finished) return;
    finished = true;
    if (commit) {
      const result = await api.renameTimbre(file.name, editor.value);
      if (!result.ok) {
        setStatus(`改名失败: ${result.error}`, true);
        finished = false;
        editor.focus();
        return;
      }
      state.timbres = await api.listTimbre();
      const renamed = state.timbres.find((t) => t.path === result.path);
      if (renamed) state.svc.reference = renamed;
      updateInputDisplays();
      setStatus(`已改名为 ${result.name}`);
    }
    renderSidebar();
  };

  editor.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') finish(true);
    else if (event.key === 'Escape') finish(false);
  });
  editor.addEventListener('blur', () => finish(true));
}

function setupTimbreRename() {
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    if (state.view !== 'svc') return;
    if (event.target.tagName === 'INPUT') return;
    if (!state.svc.reference) return;
    event.preventDefault();
    startTimbreRename(state.svc.reference);
  });
}

/* ---------------- data loading ---------------- */

async function refreshAll() {
  [state.timbres, state.inputs, state.outputs] = await Promise.all([
    api.listTimbre(),
    api.listInputs(),
    api.listOutputs(),
  ]);
  renderSidebar();
  renderOutputs();
  updateRunButtons();
}

/* ---------------- events ---------------- */

function switchView(view) {
  state.view = view;
  document.querySelectorAll('.activity').forEach((button) => {
    button.classList.toggle('active', button.dataset.view === view);
  });
  $('view-separation').classList.toggle('hidden', view !== 'separation');
  $('view-svc').classList.toggle('hidden', view !== 'svc');
  renderSidebar();
}

function setupPaneDrop(section, onFiles) {
  section.addEventListener('dragover', (event) => {
    event.preventDefault();
    section.classList.add('dragover');
  });
  section.addEventListener('dragleave', () => section.classList.remove('dragover'));
  section.addEventListener('drop', (event) => {
    event.preventDefault();
    section.classList.remove('dragover');
    const paths = [...event.dataTransfer.files].map((file) => api.getPathForFile(file));
    if (paths.length > 0) onFiles(paths);
  });
}

async function importInputs(paths) {
  const imported = await api.importInput(paths);
  if (imported.length > 0) {
    state.inputs = await api.listInputs();
  }
  return imported;
}

function setPitch(value) {
  state.svc.pitchShift = value;
  $('svc-pitch').value = value;
  $('svc-pitch-value').textContent = value > 0 ? `+${value}` : `${value}`;
}

function formatDb(value) {
  return `${value > 0 ? '+' : ''}${value.toFixed(1)} dB`;
}

function setupParams() {
  const bind = (id, valueId, get, set, format) => {
    const slider = $(id);
    slider.addEventListener('input', () => {
      set(parseFloat(slider.value));
      $(valueId).textContent = format(parseFloat(slider.value));
    });
    $(valueId).textContent = format(get());
    slider.value = get();

    // 双击数值直接编辑；提交时吸附到定义域与步长
    const valueEl = $(valueId);
    valueEl.title = '双击编辑';
    valueEl.addEventListener('dblclick', () => {
      const editor = document.createElement('input');
      editor.type = 'number';
      editor.className = 'param-value-edit';
      editor.min = slider.min;
      editor.max = slider.max;
      editor.step = slider.step;
      editor.value = slider.value;
      valueEl.replaceWith(editor);
      editor.focus();
      editor.select();

      let finished = false;
      const finish = (commit) => {
        if (finished) return;
        finished = true;
        if (commit) {
          let value = parseFloat(editor.value);
          if (Number.isNaN(value)) value = get();
          const min = parseFloat(slider.min);
          const max = parseFloat(slider.max);
          const step = parseFloat(slider.step);
          value = Math.min(max, Math.max(min, value));
          value = Math.round(value / step) * step;
          value = parseFloat(value.toFixed(6));
          set(value);
          slider.value = value;
          valueEl.textContent = format(value);
        }
        editor.replaceWith(valueEl);
      };
      editor.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') finish(true);
        else if (event.key === 'Escape') finish(false);
      });
      editor.addEventListener('blur', () => finish(true));
    });
  };
  bind('sep-overlap', 'sep-overlap-value', () => state.sep.numOverlap, (v) => (state.sep.numOverlap = v), (v) => `${v}`);
  bind('svc-steps', 'svc-steps-value', () => state.svc.steps, (v) => (state.svc.steps = v), (v) => `${v}`);
  bind('svc-pitch', 'svc-pitch-value', () => state.svc.pitchShift, (v) => (state.svc.pitchShift = v), (v) => (v > 0 ? `+${v}` : `${v}`));
  bind('svc-cfg', 'svc-cfg-value', () => state.svc.cfgRate, (v) => (state.svc.cfgRate = v), (v) => v.toFixed(2));
  bind(
    'svc-input-gain',
    'svc-input-gain-value',
    () => state.svc.inputGainDb,
    (v) => (state.svc.inputGainDb = v),
    formatDb
  );
  bind(
    'svc-video-duration',
    'svc-video-duration-value',
    () => state.svc.videoDuration,
    (v) => (state.svc.videoDuration = v),
    (v) => `${v} 秒`
  );

  $('svc-pitch-plus12').addEventListener('click', () => setPitch(12));
  $('svc-pitch-minus12').addEventListener('click', () => setPitch(-12));
  const resynthToggle = $('svc-resynth-f0');
  resynthToggle.checked = state.svc.resynthWithExplicitF0;
  resynthToggle.addEventListener('change', () => {
    state.svc.resynthWithExplicitF0 = resynthToggle.checked;
  });
}

function setupJobs() {
  $('sep-run').addEventListener('click', async () => {
    if (!state.sep.input) return;
    state.running = true;
    updateRunButtons();
    setStatus('分离任务启动中…');
    try {
      await api.runSep({
        inputPath: state.sep.input.path,
        numOverlap: state.sep.numOverlap,
      });
    } catch (error) {
      state.running = false;
      updateRunButtons();
      setStatus(`启动失败: ${error.message}`, true);
    }
  });

  const startSvc = async (generateVideo) => {
    if (!state.svc.source || !state.svc.reference) return;
    state.running = true;
    updateRunButtons();
    setStatus('转换任务启动中…');
    try {
      await api.runSvc({
        sourcePath: state.svc.source.path,
        referencePath: state.svc.reference.path,
        diffusionSteps: state.svc.steps,
        pitchShift: state.svc.pitchShift,
        cfgRate: state.svc.cfgRate,
        inputGainDb: state.svc.inputGainDb,
        resynthWithExplicitF0: state.svc.resynthWithExplicitF0,
        generateVideo,
        videoDuration: state.svc.videoDuration,
      });
    } catch (error) {
      state.running = false;
      updateRunButtons();
      setStatus(`启动失败: ${error.message}`, true);
    }
  };

  $('svc-run').addEventListener('click', () => startSvc(false));
  $('svc-run-video').addEventListener('click', () => startSvc(true));

  api.onJobEvent(async (msg) => {
    if (msg.type === 'progress') {
      const label = stageLabel(msg.stage);
      if (msg.fraction >= 0) {
        setStatus(`${label} ${Math.round(msg.fraction * 100)}%`);
        setProgress(msg.fraction);
      } else {
        setStatus(label);
        setProgress(null);
      }
    } else if (msg.type === 'video-data') {
      try {
        setStatus('生成频谱视频 0%');
        setProgress(0);
        const video = await encodeMelVideo(msg.melData, msg.videoDuration, (fraction) => {
          setStatus(`生成频谱视频 ${Math.round(fraction * 100)}%`);
          setProgress(fraction);
        });
        const bytes = new Uint8Array(await video.arrayBuffer());
        await api.writeVideo(msg.videoOutput, bytes);
        state.running = false;
        updateRunButtons();
        setProgress(null);
        setStatus('完成');
        state.outputs = await api.listOutputs();
        renderOutputs();
      } catch (error) {
        state.running = false;
        updateRunButtons();
        setProgress(null);
        setStatus(`视频生成失败: ${error.message}`, true);
        state.outputs = await api.listOutputs();
        renderOutputs();
      }
    } else if (msg.type === 'done') {
      state.running = false;
      updateRunButtons();
      setProgress(null);
      setStatus('完成');
      state.outputs = await api.listOutputs();
      renderOutputs();
    } else if (msg.type === 'error') {
      state.running = false;
      updateRunButtons();
      setProgress(null);
      setStatus(`推理失败: ${msg.message}`, true);
    }
  });
}

function setupSidebarActions() {
  for (const id of ['sep-add-input', 'svc-add-input', 'svc-add-timbre']) {
    $(id).innerHTML = ICONS.plus;
  }

  $('sep-add-input').addEventListener('click', async () => {
    const paths = await api.pickAudio({ multi: true });
    if (paths.length > 0) {
      await importInputs(paths);
      renderSidebar();
    }
  });
  $('svc-add-input').addEventListener('click', async () => {
    const paths = await api.pickAudio({ multi: true });
    if (paths.length > 0) {
      await importInputs(paths);
      renderSidebar();
    }
  });
  $('svc-add-timbre').addEventListener('click', async () => {
    const paths = await api.pickAudio({ multi: true });
    if (paths.length === 0) return;
    await api.importTimbre(paths);
    state.timbres = await api.listTimbre();
    renderSidebar();
  });

  setupPaneDrop($('sep-input-pane'), async (paths) => {
    const imported = await importInputs(paths);
    if (imported.length > 0) {
      state.sep.input = imported[0];
      updateInputDisplays();
      renderSidebar();
      updateRunButtons();
      setStatus(`已导入并选中 ${imported[0].name}`);
    }
  });

  setupPaneDrop($('svc-input-pane'), async (paths) => {
    const imported = await importInputs(paths);
    if (imported.length > 0) {
      state.svc.source = imported[0];
      updateInputDisplays();
      renderSidebar();
      updateRunButtons();
      setStatus(`已导入并选中 ${imported[0].name}`);
    }
  });

  setupPaneDrop($('timbre-pane'), async (paths) => {
    await api.importTimbre(paths);
    state.timbres = await api.listTimbre();
    renderSidebar();
    setStatus(`已导入 ${paths.length} 个音色参考`);
  });
}

function init() {
  document.querySelectorAll('.activity').forEach((button) => {
    button.addEventListener('click', () => switchView(button.dataset.view));
  });
  setupParams();
  setupJobs();
  setupSidebarActions();
  setupTimbreRename();
  setupSeekGlobal();
  refreshAll();
  setStatus('就绪');
}

init();

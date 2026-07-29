const ICONS = {
  play: '<svg viewBox="0 0 16 16" width="13" height="13" fill="currentColor"><path d="M4.5 3l8 5-8 5z"/></svg>',
  stop: '<svg viewBox="0 0 16 16" width="13" height="13" fill="currentColor"><rect x="3.5" y="3.5" width="9" height="9" rx="1"/></svg>',
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
  svc: { source: null, reference: null, steps: 16, pitchShift: 0, cfgRate: 0.7 },
  timbres: [],
  inputs: [],
  outputs: [],
};

const $ = (id) => document.getElementById(id);
const api = window.audiokit;

let audioPlayer = null;
let playingPath = null;

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
};

function stageLabel(stage) {
  return STAGE_LABELS[stage] || stage;
}

/* ---------------- rendering ---------------- */

function renderFileList(element, files, { selectedPath, onSelect, onDelete, emptyText }) {
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
    name.title = file.path;
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

function stopPlayback() {
  if (audioPlayer) {
    audioPlayer.pause();
    audioPlayer = null;
    playingPath = null;
  }
}

function renderOutputs() {
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
        const row = document.createElement('div');
        row.className = 'output-file';
        row.draggable = true;
        row.title = `${file.path}\n可拖出到 Logic Pro 等宿主软件`;

        const playBtn = document.createElement('button');
        playBtn.className = 'play-btn';
        playBtn.innerHTML = playingPath === file.path ? ICONS.stop : ICONS.play;
        playBtn.title = playingPath === file.path ? '停止' : '播放';
        playBtn.addEventListener('click', () => togglePlay(file.path));
        row.appendChild(playBtn);

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
          event.dataTransfer.effectAllowed = 'copy';
          api.startDrag(file.path);
        });

        groupEl.appendChild(row);
      }

      container.appendChild(groupEl);
    }
  }
}

function togglePlay(filePath) {
  if (playingPath === filePath) {
    stopPlayback();
  } else {
    stopPlayback();
    audioPlayer = new Audio(`file://${filePath}`);
    audioPlayer.addEventListener('ended', () => {
      stopPlayback();
      renderOutputs();
    });
    audioPlayer.play();
    playingPath = filePath;
  }
  renderOutputs();
}

function updateRunButtons() {
  $('sep-run').disabled = state.running || !state.sep.input;
  $('svc-run').disabled = state.running || !state.svc.source || !state.svc.reference;
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

  $('svc-pitch-plus12').addEventListener('click', () => setPitch(12));
  $('svc-pitch-minus12').addEventListener('click', () => setPitch(-12));
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

  $('svc-run').addEventListener('click', async () => {
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
      });
    } catch (error) {
      state.running = false;
      updateRunButtons();
      setStatus(`启动失败: ${error.message}`, true);
    }
  });

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
  refreshAll();
  setStatus('就绪');
}

init();

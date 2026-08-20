/* 歌词视频：网易云 LRC 抓取、片段选取、字幕样式与 MP4 导出 */

const LRC_LEAD_IN = 2.4; // 片头时长（标题卡 + 首行入场）
const LRC_TAIL = 2.6; // 片尾停留
const LRC_FADE_IN = 0.5;
const LRC_FADE_OUT = 0.8;
const LRC_TRANSITION = 0.45; // 换行滚动过渡
const LRC_FPS = 30;
const LRC_FONT_STACK = '"PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif';
const LRC_ANCHOR_ROWS = ['上', '偏上', '正中', '偏下', '下'];
const LRC_ANCHOR_COLS = ['靠左', '偏左', '居中', '偏右', '靠右'];
const LRC_ASPECTS = [
  { label: '9:16', w: 1080, h: 1920 },
  { label: '3:4', w: 1440, h: 1920 },
  { label: '1:1', w: 1440, h: 1440 },
  { label: '4:3', w: 1920, h: 1440 },
  { label: '16:9', w: 1920, h: 1080 },
];

const lrcState = {
  song: null,
  lines: [],
  startIdx: null,
  endIdx: null,
  image: null, // { bitmap, name, width, height }
  anchor: 22, // 5x5 锚点，默认下排居中
  fontSize: 52,
  textColor: '#ffffff',
  shadow: true,
  shadowColor: '#000000',
  blur: 0,
  darken: 0,
  aspectIndex: 4, // 默认 16:9
  aspectFit: false,
  playing: false,
  playT: 0,
  playStart: 0,
  playStartT: 0,
  generating: false,
  scene: null,
  sceneDirty: true,
  plateCache: null, // { image, w, h, plate }
};

/* ---------------- LRC 解析 ---------------- */

function parseLrc(text) {
  const lines = [];
  let offsetMs = 0;
  const tagRe = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;
  for (const rawLine of text.split('\n')) {
    const offsetMatch = rawLine.match(/^\[offset:\s*([+-]?\d+)\s*\]/);
    if (offsetMatch) {
      offsetMs = parseInt(offsetMatch[1], 10);
      continue;
    }
    tagRe.lastIndex = 0;
    const times = [];
    let lastEnd = 0;
    let match;
    while ((match = tagRe.exec(rawLine)) !== null) {
      let frac = 0;
      if (match[3] !== undefined) frac = parseInt(match[3], 10) / 10 ** match[3].length;
      times.push(parseInt(match[1], 10) * 60 + parseInt(match[2], 10) + frac);
      lastEnd = tagRe.lastIndex;
    }
    if (times.length === 0) continue;
    // 去掉增强 LRC 的逐字时间标签
    const lyricText = rawLine.slice(lastEnd).replace(/<[^>]*>/g, '').trim();
    if (!lyricText) continue;
    for (const t of times) lines.push({ t, text: lyricText });
  }
  lines.sort((a, b) => a.t - b.t);
  if (offsetMs !== 0) {
    for (const line of lines) line.t = Math.max(0, line.t - offsetMs / 1000);
  }
  return lines;
}

/* ---------------- 场景构建与绘制 ---------------- */

function clamp01(value) {
  return Math.min(1, Math.max(0, value));
}

function easeOutCubic(p) {
  return 1 - (1 - p) ** 3;
}

function easeInOutCubic(p) {
  return p < 0.5 ? 4 * p * p * p : 1 - (-2 * p + 2) ** 3 / 2;
}

function hexWithAlpha(hex, alpha) {
  const value = parseInt(hex.slice(1), 16);
  const r = (value >> 16) & 255;
  const g = (value >> 8) & 255;
  const b = value & 255;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function lrcVideoSize(image) {
  if (!lrcState.aspectFit) {
    const { w, h } = LRC_ASPECTS[lrcState.aspectIndex];
    return { w, h };
  }
  // 适应背景图片：长边 1920、短边按图片比例，均为偶数；极端全景图保证短边至少 720
  const ar = image.width / image.height;
  let w;
  let h;
  if (ar >= 1) {
    w = 1920;
    h = Math.round(1920 / ar);
  } else {
    h = 1920;
    w = Math.round(1920 * ar);
  }
  if (Math.min(w, h) < 720) {
    if (w < h) {
      w = 720;
      h = Math.round(720 / ar);
    } else {
      h = 720;
      w = Math.round(720 * ar);
    }
  }
  w -= w % 2;
  h -= h % 2;
  return { w, h };
}

const PLATE_SCALE = 1.15; // 底板相对视频画面的放大倍数，为 Ken Burns 推近预留裁切余量

function buildPlate(image, w, h, blur, darken) {
  // 背景底板：图片 contain 到中央视频画面区域（pad 黑边、完整不变形），烘焙后供逐帧裁切
  const pw = Math.round(w * PLATE_SCALE);
  const ph = Math.round(h * PLATE_SCALE);
  const plate = document.createElement('canvas');
  plate.width = pw;
  plate.height = ph;
  const ctx = plate.getContext('2d');
  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, pw, ph);
  const contain = Math.min(w / image.width, h / image.height);
  const dw = image.width * contain * PLATE_SCALE;
  const dh = image.height * contain * PLATE_SCALE;
  // blur 以输出画面像素为单位，底板放大后等比例放大
  if (blur > 0) ctx.filter = `blur(${(blur * PLATE_SCALE).toFixed(1)}px)`;
  ctx.drawImage(image.bitmap, (pw - dw) / 2, (ph - dh) / 2, dw, dh);
  ctx.filter = 'none';
  if (darken > 0) {
    ctx.fillStyle = `rgba(8, 10, 18, ${(darken / 100).toFixed(3)})`;
    ctx.fillRect(0, 0, pw, ph);
  }
  // 图片是否恰好填满视频画面（同比例）：决定 Ken Burns 能否推近图片本身
  const fillsFrame = Math.abs(dw - pw / PLATE_SCALE) < pw * 0.01;
  return { plate, fillsFrame };
}

function buildScene() {
  const { lines, startIdx, endIdx, image, song } = lrcState;
  if (!song || lines.length === 0) return null;
  if (startIdx == null || endIdx == null) return null;
  if (!image) return null;
  const { w, h } = lrcVideoSize(image);
  const { blur, darken } = lrcState;
  if (
    !lrcState.plateCache ||
    lrcState.plateCache.image !== image ||
    lrcState.plateCache.w !== w ||
    lrcState.plateCache.h !== h ||
    lrcState.plateCache.blur !== blur ||
    lrcState.plateCache.darken !== darken
  ) {
    const { plate, fillsFrame } = buildPlate(image, w, h, blur, darken);
    lrcState.plateCache = { image, w, h, blur, darken, plate, fillsFrame };
  }
  const t0 = lines[startIdx].t;
  const start = Math.max(0, t0 - LRC_LEAD_IN);
  const leadIn = t0 - start;
  const duration = lines[endIdx].t + LRC_TAIL - start;
  return {
    w,
    h,
    plate: lrcState.plateCache.plate,
    // 同比例图片：窗口在画面内推近（始终无黑边）；异比例：窗口从含黑边推近到正好画面（图片全程完整）
    kenBurnsStart: lrcState.plateCache.fillsFrame ? 1 : 1.065,
    kenBurnsEnd: lrcState.plateCache.fillsFrame ? 1 / 1.065 : 1,
    darken,
    vignette: null,
    vignetteAlpha: 0,
    lines,
    startIdx,
    endIdx,
    start,
    leadIn,
    duration,
    song,
    style: {
      anchor: lrcState.anchor,
      fontSize: lrcState.fontSize,
      textColor: lrcState.textColor,
      shadow: lrcState.shadow,
      shadowColor: lrcState.shadowColor,
    },
  };
}

// 焦点行（浮点行号）：片头从 startIdx-1 滑入，换行时从上一行 ease 到当前行
function focusAt(scene, t) {
  const { lines, startIdx, endIdx, start, leadIn } = scene;
  const tl = start + t;
  if (t < leadIn) {
    const enterBegin = Math.max(0, leadIn - 0.8);
    const p = clamp01((t - enterBegin) / Math.max(0.001, leadIn - enterBegin));
    return startIdx - 1 + easeInOutCubic(p);
  }
  let cur = startIdx;
  for (let k = startIdx + 1; k <= endIdx; k += 1) {
    if (lines[k].t <= tl) cur = k;
    else break;
  }
  if (cur > startIdx) {
    const p = clamp01((tl - lines[cur].t) / LRC_TRANSITION);
    if (p < 1) return cur - 1 + easeOutCubic(p);
  }
  return cur;
}

function applyTextShadow(ctx, style, size) {
  if (!style.shadow) return;
  ctx.shadowColor = hexWithAlpha(style.shadowColor, 0.85);
  ctx.shadowBlur = size * 0.3;
  ctx.shadowOffsetY = size * 0.045;
}

// 长行按可用宽度等比缩小字号，避免溢出画面
function fitFont(ctx, text, weight, size, maxWidth) {
  let fitted = size;
  ctx.font = `${weight} ${fitted}px ${LRC_FONT_STACK}`;
  const measured = ctx.measureText(text).width;
  if (measured > maxWidth) {
    fitted = (fitted * maxWidth) / measured;
    ctx.font = `${weight} ${fitted}px ${LRC_FONT_STACK}`;
  }
  return fitted;
}

function drawScene(ctx, scene, t) {
  const { w, h, plate, lines, startIdx, leadIn, duration, song, style } = scene;

  // 背景：Ken Burns 缓慢推近，裁切窗口以视频画面区域为基准
  const progress = clamp01(t / duration);
  const frameW = plate.width / PLATE_SCALE;
  const k = scene.kenBurnsStart + (scene.kenBurnsEnd - scene.kenBurnsStart) * progress;
  const sw = frameW * k;
  const sh = sw * (h / w);
  ctx.drawImage(plate, (plate.width - sw) / 2, (plate.height - sh) / 2, sw, sh, 0, 0, w, h);

  // 暗角：强度随压暗参数，压暗为 0 时完全不加
  const darkenAlpha = scene.darken / 100;
  if (darkenAlpha > 0) {
    if (!scene.vignette || scene.vignetteAlpha !== darkenAlpha) {
      const gradient = ctx.createRadialGradient(
        w / 2, h / 2, Math.hypot(w, h) * 0.36,
        w / 2, h / 2, Math.hypot(w, h) * 0.72
      );
      gradient.addColorStop(0, 'rgba(0, 0, 0, 0)');
      gradient.addColorStop(1, `rgba(0, 0, 0, ${(darkenAlpha * 0.83).toFixed(3)})`);
      scene.vignette = gradient;
      scene.vignetteAlpha = darkenAlpha;
    }
    ctx.fillStyle = scene.vignette;
    ctx.fillRect(0, 0, w, h);
  }

  const S = style.fontSize * (Math.min(w, h) / 1080);
  const lineHeight = S * 2.0;
  ctx.letterSpacing = `${(S * 0.03).toFixed(1)}px`;

  // 标题卡：片头展示歌名与歌手
  if (leadIn >= 1.2 && t < leadIn - 0.1) {
    const alpha = Math.min(clamp01((t - 0.15) / 0.5), clamp01((leadIn - 0.45 - t) / 0.45));
    if (alpha > 0) {
      ctx.save();
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      applyTextShadow(ctx, style, S);
      ctx.fillStyle = style.textColor;
      ctx.globalAlpha = alpha;
      const nameSize = fitFont(ctx, song.name, 600, S * 1.02, w * 0.8);
      applyTextShadow(ctx, style, nameSize);
      ctx.fillText(song.name, w / 2, h / 2 - S * 0.42);
      ctx.globalAlpha = alpha * 0.72;
      fitFont(ctx, song.artists, 400, S * 0.44, w * 0.7);
      ctx.fillText(song.artists, w / 2, h / 2 + S * 0.62);
      ctx.restore();
    }
  }

  // 歌词块：前一句（暗）、当前句（亮）、后一句（暗）
  // 5x5 锚点：列决定水平位置与对齐（居中列才居中，其余列靠对应侧对齐），行决定垂直位置
  const ax = style.anchor % 5;
  const ay = Math.floor(style.anchor / 5);
  const marginX = w * 0.08;
  const marginY = h * 0.09;
  const topY = marginY + lineHeight;
  const bottomY = h - marginY - lineHeight;
  const focusY = topY + (ay / 4) * (bottomY - topY);
  const textX = marginX + (ax / 4) * (w - marginX * 2);
  const blockAlpha = clamp01((t - Math.max(0, leadIn - 0.55)) / 0.5);
  const focus = focusAt(scene, t);

  ctx.save();
  ctx.textAlign = ax === 2 ? 'center' : ax < 2 ? 'left' : 'right';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = style.textColor;
  const maxTextWidth =
    ax === 2
      ? Math.min(textX - marginX, w - marginX - textX) * 2 * 0.96
      : ax < 2
        ? (w - marginX - textX) * 0.96
        : (textX - marginX) * 0.96;
  const lo = Math.max(0, Math.ceil(focus - 1.6));
  const hi = Math.min(lines.length - 1, Math.floor(focus + 1.6));
  for (let j = lo; j <= hi; j += 1) {
    const d = j - focus;
    const ad = Math.abs(d);
    const alpha = Math.max(0, 1 - 0.64 * ad) * blockAlpha;
    if (alpha <= 0.004) continue;
    const size = fitFont(
      ctx,
      lines[j].text,
      ad < 0.5 ? 600 : 500,
      S * (1 - 0.34 * Math.min(1, ad)),
      maxTextWidth
    );
    ctx.globalAlpha = alpha;
    applyTextShadow(ctx, style, size);
    ctx.fillText(lines[j].text, textX, focusY + d * lineHeight);
  }
  ctx.restore();

  // 首尾淡入淡出
  const fade = Math.min(clamp01(t / LRC_FADE_IN), clamp01((duration - t) / LRC_FADE_OUT));
  if (fade < 1) {
    ctx.fillStyle = `rgba(0, 0, 0, ${1 - fade})`;
    ctx.fillRect(0, 0, w, h);
  }
}

/* ---------------- 预览 ---------------- */

function currentScene() {
  if (lrcState.sceneDirty) {
    lrcState.scene = buildScene();
    lrcState.sceneDirty = false;
    const canvas = $('lrc-preview');
    const w = lrcState.scene ? lrcState.scene.w : 1280;
    const h = lrcState.scene ? lrcState.scene.h : 720;
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    if (lrcState.scene) lrcState.playT = Math.min(lrcState.playT, lrcState.scene.duration);
  }
  return lrcState.scene;
}

function formatClock(seconds) {
  const total = Math.max(0, Math.round(seconds));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

function drawPreviewPlaceholder(ctx, w, h) {
  ctx.fillStyle = '#0a0c12';
  ctx.fillRect(0, 0, w, h);
  ctx.letterSpacing = '0px';
  ctx.fillStyle = '#59667a';
  ctx.font = `400 ${Math.round(h * 0.028)}px ${LRC_FONT_STACK}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('获取歌词、选取起止行并选择背景图片后，在此预览效果', w / 2, h / 2);
}

function updatePreviewControls(scene) {
  const scrub = $('lrc-scrub');
  if (!scene) {
    scrub.value = 0;
    $('lrc-preview-time').textContent = '0:00 / 0:00';
    return;
  }
  scrub.value = Math.round((lrcState.playT / scene.duration) * 1000);
  $('lrc-preview-time').textContent = `${formatClock(lrcState.playT)} / ${formatClock(scene.duration)}`;
}

function renderPreview() {
  const canvas = $('lrc-preview');
  const ctx = canvas.getContext('2d');
  const scene = currentScene();
  if (!scene) {
    drawPreviewPlaceholder(ctx, canvas.width, canvas.height);
    updatePreviewControls(null);
    return;
  }
  drawScene(ctx, scene, lrcState.playT);
  updatePreviewControls(scene);
  $('lrc-preview-meta').textContent = `输出 ${scene.w} × ${scene.h}，亮框以内（含黑边）即视频内容`;
}

function stopPreview() {
  lrcState.playing = false;
  $('lrc-play').textContent = '播放';
}

function previewTick(now) {
  if (!lrcState.playing) return;
  const scene = lrcState.scene;
  if (!scene) {
    stopPreview();
    return;
  }
  lrcState.playT = lrcState.playStartT + (now - lrcState.playStart) / 1000;
  if (lrcState.playT >= scene.duration) {
    lrcState.playT = scene.duration;
    renderPreview();
    stopPreview();
    return;
  }
  renderPreview();
  requestAnimationFrame(previewTick);
}

function playPreview() {
  const scene = currentScene();
  if (!scene) return;
  if (lrcState.playT >= scene.duration - 0.01) lrcState.playT = 0;
  lrcState.playing = true;
  $('lrc-play').textContent = '暂停';
  lrcState.playStart = performance.now();
  lrcState.playStartT = lrcState.playT;
  requestAnimationFrame(previewTick);
}

/* ---------------- 歌词列表与选区 ---------------- */

function formatLineTime(t) {
  const minutes = Math.floor(t / 60);
  const seconds = t - minutes * 60;
  return `${String(minutes).padStart(2, '0')}:${seconds.toFixed(1).padStart(4, '0')}`;
}

function renderRangeInfo() {
  const info = $('lrc-range-info');
  const { lines, startIdx, endIdx } = lrcState;
  if (startIdx == null) {
    info.textContent = lines.length
      ? '点击一句歌词设为起点，再点击一句设为终点'
      : '';
    return;
  }
  const startLine = lines[startIdx];
  if (endIdx == null) {
    info.textContent = `起点 ${formatLineTime(startLine.t)}「${startLine.text}」 — 再点击一句设为终点`;
    return;
  }
  const endLine = lines[endIdx];
  const count = endIdx - startIdx + 1;
  const duration = endLine.t + LRC_TAIL - Math.max(0, startLine.t - LRC_LEAD_IN);
  info.textContent =
    `起 ${formatLineTime(startLine.t)} → 终 ${formatLineTime(endLine.t)} · 共 ${count} 行 · 视频时长约 ${duration.toFixed(1)} 秒`;
}

function renderLrcList() {
  const list = $('lrc-list');
  list.innerHTML = '';
  if (lrcState.lines.length === 0) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = '获取歌词后在此选取片段';
    list.appendChild(li);
    renderRangeInfo();
    return;
  }
  lrcState.lines.forEach((line, idx) => {
    const li = document.createElement('li');
    const { startIdx, endIdx } = lrcState;
    if (startIdx != null && endIdx != null && idx >= startIdx && idx <= endIdx) {
      li.classList.add('in-range');
    }
    if (idx === startIdx) li.classList.add('range-start');
    if (idx === endIdx) li.classList.add('range-end');

    const time = document.createElement('span');
    time.className = 'lrc-time';
    time.textContent = formatLineTime(line.t);
    li.appendChild(time);

    const text = document.createElement('span');
    text.className = 'lrc-text';
    text.textContent = line.text;
    li.appendChild(text);

    if (idx === lrcState.startIdx || idx === lrcState.endIdx) {
      const badge = document.createElement('span');
      badge.className = 'lrc-badge';
      badge.textContent = idx === lrcState.startIdx ? '起点' : '终点';
      li.appendChild(badge);
    }

    li.addEventListener('click', () => selectLine(idx));
    list.appendChild(li);
  });
  renderRangeInfo();
}

function selectLine(idx) {
  const { startIdx, endIdx } = lrcState;
  if (startIdx == null || endIdx != null) {
    lrcState.startIdx = idx;
    lrcState.endIdx = null;
  } else if (idx >= startIdx) {
    lrcState.endIdx = idx;
  } else {
    lrcState.endIdx = startIdx;
    lrcState.startIdx = idx;
  }
  lrcState.sceneDirty = true;
  lrcState.playT = 0;
  stopPreview();
  renderLrcList();
  renderPreview();
  updateLrcGenerateButton();
}

/* ---------------- 视频编码导出 ---------------- */

async function encodeLrcVideo(scene, onProgress) {
  const { w, h, duration } = scene;
  const totalFrames = Math.round(duration * LRC_FPS);
  const bitrate = Math.min(40000000, Math.round(w * h * LRC_FPS * 0.18));
  let codec = null;
  for (const candidate of ['avc1.640834', 'avc1.64082a', 'avc1.4d0034', 'avc1.42e034']) {
    const support = await VideoEncoder.isConfigSupported({
      codec: candidate,
      width: w,
      height: h,
      bitrate,
      framerate: LRC_FPS,
      avc: { format: 'avc' },
    });
    if (support.supported) {
      codec = candidate;
      break;
    }
  }
  if (!codec) throw new Error('当前环境不支持 H.264 视频编码');

  const muxer = new Mp4Muxer.Muxer({
    target: new Mp4Muxer.ArrayBufferTarget(),
    video: { codec: 'avc', width: w, height: h, frameRate: LRC_FPS },
    fastStart: 'in-memory',
  });
  let encoderError = null;
  const encoder = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: (error) => {
      encoderError = error;
    },
  });
  encoder.configure({
    codec,
    width: w,
    height: h,
    bitrate,
    framerate: LRC_FPS,
    avc: { format: 'avc' },
  });

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');

  for (let frame = 0; frame < totalFrames; frame += 1) {
    if (encoderError) throw encoderError;
    drawScene(ctx, scene, frame / LRC_FPS);
    const videoFrame = new VideoFrame(canvas, {
      timestamp: Math.round((frame * 1e6) / LRC_FPS),
      duration: Math.round(1e6 / LRC_FPS),
    });
    encoder.encode(videoFrame, { keyFrame: frame % (LRC_FPS * 2) === 0 });
    videoFrame.close();
    if (encoder.encodeQueueSize > 8) {
      await new Promise((resolve) => encoder.addEventListener('dequeue', resolve, { once: true }));
    }
    if (frame % 15 === 0) {
      onProgress(
        frame / totalFrames,
        `编码视频 ${Math.round((frame / totalFrames) * 100)}%（${frame}/${totalFrames} 帧）`
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
  await encoder.flush();
  if (encoderError) throw encoderError;
  encoder.close();
  muxer.finalize();
  return new Uint8Array(muxer.target.buffer);
}

async function generateVideo() {
  if (!lrcState.song || lrcState.lines.length === 0) {
    setStatus('请先获取歌词', true);
    return;
  }
  if (lrcState.startIdx == null || lrcState.endIdx == null) {
    setStatus('请先选取歌词的起点和终点', true);
    return;
  }
  if (!lrcState.image) {
    setStatus('请先选择背景图片', true);
    return;
  }
  const scene = buildScene();
  lrcState.generating = true;
  updateLrcGenerateButton();
  stopPreview();
  try {
    const bytes = await encodeLrcVideo(scene, (fraction, text) => {
      setStatus(text);
      setProgress(fraction);
    });
    setStatus('写入文件…');
    const info = await api.saveLrcVideo({
      bytes,
      songName: lrcState.song.name,
      artists: lrcState.song.artists,
      songId: lrcState.song.id,
      width: scene.w,
      height: scene.h,
    });
    state.outputs = await api.listOutputs();
    renderOutputs();
    setStatus(`已生成 ${info.name}`);
  } catch (error) {
    setStatus(`生成视频失败: ${error.message}`, true);
  } finally {
    lrcState.generating = false;
    setProgress(null);
    updateLrcGenerateButton();
  }
}

function updateLrcGenerateButton() {
  const button = $('lrc-generate');
  if (!button) return;
  button.disabled =
    state.running ||
    lrcState.generating ||
    !lrcState.song ||
    lrcState.startIdx == null ||
    lrcState.endIdx == null ||
    !lrcState.image;
}

/* ---------------- 事件 ---------------- */

async function fetchLyrics() {
  const input = $('lrc-url').value.trim();
  if (!input) {
    setStatus('请先粘贴歌曲链接或 ID', true);
    return;
  }
  $('lrc-fetch').disabled = true;
  setStatus('正在获取歌词…');
  try {
    const song = await api.fetchLrc(input);
    const lines = parseLrc(song.lrc);
    if (lines.length === 0) throw new Error('未解析出带时间戳的歌词行');
    lrcState.song = song;
    lrcState.lines = lines;
    lrcState.startIdx = null;
    lrcState.endIdx = null;
    lrcState.playT = 0;
    lrcState.sceneDirty = true;
    stopPreview();
    const info = $('lrc-song-info');
    info.textContent = song.album
      ? `${song.name} - ${song.artists}《${song.album}》`
      : `${song.name} - ${song.artists}`;
    info.classList.remove('unset');
    renderLrcList();
    renderPreview();
    updateLrcGenerateButton();
    setStatus(`已获取歌词：${song.name} - ${song.artists}，共 ${lines.length} 行`);
  } catch (error) {
    setStatus(`获取歌词失败: ${error.message}`, true);
  } finally {
    $('lrc-fetch').disabled = false;
  }
}

async function selectLrcImage({ bytes, name }) {
  const bitmap = await createImageBitmap(new Blob([bytes]));
  lrcState.image = { bitmap, name, width: bitmap.width, height: bitmap.height };
  lrcState.plateCache = null;
  lrcState.sceneDirty = true;
  const nameEl = $('lrc-image-name');
  nameEl.textContent = `${name}（${bitmap.width}×${bitmap.height}）`;
  nameEl.classList.remove('unset');
  renderPreview();
  updateLrcGenerateButton();
}

function markSceneDirty() {
  lrcState.sceneDirty = true;
  renderPreview();
}

// 模糊/压暗需要重烘背景底板，拖动滑杆时防抖重建
let plateRebuildTimer = null;

function markPlateDirty() {
  if (plateRebuildTimer) clearTimeout(plateRebuildTimer);
  plateRebuildTimer = setTimeout(() => {
    plateRebuildTimer = null;
    markSceneDirty();
  }, 120);
}

function setupLrcParams() {
  const fontSizeSlider = $('lrc-font-size');
  fontSizeSlider.value = lrcState.fontSize;
  fontSizeSlider.addEventListener('input', () => {
    lrcState.fontSize = parseInt(fontSizeSlider.value, 10);
    $('lrc-font-size-value').textContent = fontSizeSlider.value;
    markSceneDirty();
  });

  const textColor = $('lrc-text-color');
  textColor.addEventListener('input', () => {
    lrcState.textColor = textColor.value;
    markSceneDirty();
  });

  const shadowToggle = $('lrc-shadow');
  shadowToggle.checked = lrcState.shadow;
  shadowToggle.addEventListener('change', () => {
    lrcState.shadow = shadowToggle.checked;
    markSceneDirty();
  });

  const shadowColor = $('lrc-shadow-color');
  shadowColor.addEventListener('input', () => {
    lrcState.shadowColor = shadowColor.value;
    markSceneDirty();
  });

  const aspectSlider = $('lrc-aspect');
  const aspectValue = $('lrc-aspect-value');
  aspectSlider.value = lrcState.aspectIndex;
  aspectSlider.addEventListener('input', () => {
    lrcState.aspectIndex = parseInt(aspectSlider.value, 10);
    aspectValue.textContent = LRC_ASPECTS[lrcState.aspectIndex].label;
    markSceneDirty();
  });

  const aspectFit = $('lrc-aspect-fit');
  aspectFit.checked = lrcState.aspectFit;
  aspectFit.addEventListener('change', () => {
    lrcState.aspectFit = aspectFit.checked;
    aspectSlider.disabled = lrcState.aspectFit;
    markSceneDirty();
  });

  const blurSlider = $('lrc-blur');
  blurSlider.value = lrcState.blur;
  blurSlider.addEventListener('input', () => {
    lrcState.blur = parseFloat(blurSlider.value);
    $('lrc-blur-value').textContent = `${parseFloat(blurSlider.value).toFixed(1)} px`;
    markPlateDirty();
  });

  const darkenSlider = $('lrc-darken');
  darkenSlider.value = lrcState.darken;
  darkenSlider.addEventListener('input', () => {
    lrcState.darken = parseInt(darkenSlider.value, 10);
    $('lrc-darken-value').textContent = `${darkenSlider.value}%`;
    markPlateDirty();
  });

  const grid = $('lrc-anchor-grid');
  for (let i = 0; i < 25; i += 1) {
    const button = document.createElement('button');
    button.title = `${LRC_ANCHOR_ROWS[Math.floor(i / 5)]}·${LRC_ANCHOR_COLS[i % 5]}`;
    if (i === lrcState.anchor) button.classList.add('active');
    button.addEventListener('click', () => {
      lrcState.anchor = i;
      grid.querySelectorAll('button').forEach((el, j) => el.classList.toggle('active', j === i));
      markSceneDirty();
    });
    grid.appendChild(button);
  }
}

function initLrcvideo() {
  $('lrc-fetch').addEventListener('click', fetchLyrics);
  $('lrc-url').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') fetchLyrics();
  });
  $('lrc-pick-image').addEventListener('click', async () => {
    const result = await api.pickImage();
    if (result) await selectLrcImage(result);
  });
  $('lrc-play').addEventListener('click', () => {
    if (lrcState.playing) stopPreview();
    else playPreview();
  });
  $('lrc-scrub').addEventListener('input', () => {
    const scene = currentScene();
    if (!scene) return;
    lrcState.playT = (parseInt($('lrc-scrub').value, 10) / 1000) * scene.duration;
    if (lrcState.playing) {
      lrcState.playStart = performance.now();
      lrcState.playStartT = lrcState.playT;
    }
    renderPreview();
  });
  $('lrc-generate').addEventListener('click', generateVideo);
  setupLrcParams();
  renderLrcList();
  renderPreview();
  updateLrcGenerateButton();
}

initLrcvideo();

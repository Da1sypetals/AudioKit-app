/* 歌词封面：在背景图片上排版多行文字，导出 PNG / JPEG */

const COVER_PREVIEW_MAX = 1400; // 预览画布最长边上限，导出始终按背景图片原始尺寸

const coverState = {
  image: null, // { bitmap, name, width, height }
  blur: 0.8, // 背景模糊，单位为输出画面像素
  darken: 20, // 背景压暗百分比
  saturation: 100, // 背景饱和度百分比，100 为原图
  text: '',
  subText: '',
  subScale: 0.45, // 次要文字字号 = 主要文字字号 × 倍数
  anchor: 31, // 9x7 锚点，默认正中（行 3 列 4）
  align: 1, // 0 靠左 / 1 居中 / 2 靠右
  fontSize: 90,
  lineSpacing: 1.0, // 行间距倍数：1.0 = 行高 1.4 倍字号
  textColor: '#ffffff',
  textTransparency: 0.08, // 0 为不透明，越大越透明
  shadow: true,
  shadowColor: '#000000',
  shadowStrength: 150, // 百分比，100 为初始设计效果
  fontFamily: '我欲见你何惧春秋', // 空 = 默认系统字体栈
  format: 'png',
  generating: false,
};

// 去掉首尾空行，保留中间空行作为间距
function coverTextLines(text) {
  const raw = text.split('\n');
  let start = 0;
  let end = raw.length;
  while (start < end && raw[start].trim() === '') start += 1;
  while (end > start && raw[end - 1].trim() === '') end -= 1;
  return raw.slice(start, end);
}

// 主要文字在前、次要文字在后，次要文字按倍数缩小字号
function coverLines() {
  const primary = coverTextLines(coverState.text).map((text) => ({ text, scale: 1 }));
  const secondary = coverTextLines(coverState.subText).map((text) => ({ text, scale: coverState.subScale }));
  return primary.concat(secondary);
}

function coverStyle() {
  return {
    fontStack: coverState.fontFamily ? `"${coverState.fontFamily}", ${LRC_FONT_STACK}` : LRC_FONT_STACK,
    fontSize: coverState.fontSize,
    lineSpacing: coverState.lineSpacing,
    textColor: coverState.textColor,
    textAlpha: 1 - coverState.textTransparency,
    shadow: coverState.shadow,
    shadowColor: coverState.shadowColor,
    shadowStrength: coverState.shadowStrength,
    anchor: coverState.anchor,
    align: coverState.align,
  };
}

function drawCoverText(ctx, w, h, style, lines) {
  const S = style.fontSize * (Math.min(w, h) / 1080);
  const ax = style.anchor % 9;
  const ay = Math.floor(style.anchor / 9);
  const marginX = w * 0.03;
  const marginY = h * 0.09;
  const textX = marginX + (ax / 8) * (w - marginX * 2);
  const maxTextWidth =
    style.align === 1
      ? Math.min(textX - marginX, w - marginX - textX) * 2 * 0.96
      : style.align === 0
        ? (w - marginX - textX) * 0.96
        : (textX - marginX) * 0.96;

  if (lines.length > 0 && maxTextWidth > 0) {
    // 统一收缩系数：既保证最长行不溢出，又保持主次文字的固定比例
    let shrink = 1;
    for (const line of lines) {
      const size = S * line.scale;
      ctx.font = `600 ${size.toFixed(1)}px ${style.fontStack}`;
      const width = ctx.measureText(line.text).width;
      if (width > maxTextWidth) shrink = Math.min(shrink, maxTextWidth / width);
    }
    const sized = lines.map((line) => {
      const size = S * line.scale * shrink;
      return { text: line.text, size, lineHeight: size * 1.4 * style.lineSpacing };
    });
    const total = sized.reduce((sum, line) => sum + line.lineHeight, 0);
    const topEdge = marginY + total / 2;
    const bottomEdge = h - marginY - total / 2;
    const centerY = topEdge + (ay / 6) * (bottomEdge - topEdge);

    ctx.save();
    ctx.textAlign = ['left', 'center', 'right'][style.align];
    ctx.textBaseline = 'middle';
    ctx.fillStyle = style.textColor;
    ctx.globalAlpha = style.textAlpha;
    let y = centerY - total / 2;
    for (const line of sized) {
      ctx.font = `600 ${line.size.toFixed(1)}px ${style.fontStack}`;
      applyTextShadow(ctx, style, line.size);
      ctx.fillText(line.text, textX, y + line.lineHeight / 2);
      y += line.lineHeight;
    }
    ctx.restore();
  }
}

let coverPlate = null; // { image, blur, saturation, canvas } 背景底板缓存

function coverPlateCanvas() {
  const image = coverState.image;
  const blur = coverState.blur;
  const saturation = coverState.saturation;
  if (
    coverPlate &&
    coverPlate.image === image &&
    coverPlate.blur === blur &&
    coverPlate.saturation === saturation
  ) {
    return coverPlate.canvas;
  }
  const canvas = document.createElement('canvas');
  canvas.width = image.width;
  canvas.height = image.height;
  const ctx = canvas.getContext('2d');
  const filters = [];
  if (blur > 0) filters.push(`blur(${blur}px)`);
  if (saturation !== 100) filters.push(`saturate(${(saturation / 100).toFixed(3)})`);
  if (filters.length > 0) {
    // 模糊会向画面外取样，绘制时外扩，避免边缘发虚
    const pad = blur > 0 ? Math.ceil(blur * 3) : 0;
    ctx.filter = filters.join(' ');
    ctx.drawImage(image.bitmap, -pad, -pad, image.width + pad * 2, image.height + pad * 2);
    ctx.filter = 'none';
  } else {
    ctx.drawImage(image.bitmap, 0, 0, image.width, image.height);
  }
  coverPlate = { image, blur, saturation, canvas };
  return canvas;
}

function drawCover(ctx, w, h) {
  ctx.clearRect(0, 0, w, h);
  ctx.drawImage(coverPlateCanvas(), 0, 0, w, h);

  // 压暗：整体压暗 + 随压暗强度递增的暗角，压暗为 0 时完全不加
  const darkenAlpha = coverState.darken / 100;
  if (darkenAlpha > 0) {
    ctx.fillStyle = `rgba(8, 10, 18, ${darkenAlpha.toFixed(3)})`;
    ctx.fillRect(0, 0, w, h);
    const gradient = ctx.createRadialGradient(
      w / 2, h / 2, Math.hypot(w, h) * 0.36,
      w / 2, h / 2, Math.hypot(w, h) * 0.72
    );
    gradient.addColorStop(0, 'rgba(0, 0, 0, 0)');
    gradient.addColorStop(1, `rgba(0, 0, 0, ${(darkenAlpha * 0.83).toFixed(3)})`);
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, w, h);
  }

  drawCoverText(ctx, w, h, coverStyle(), coverLines());
}

/* ---------------- 预览 ---------------- */

function drawCoverPlaceholder(ctx, w, h) {
  ctx.fillStyle = '#0a0c12';
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = '#59667a';
  ctx.font = `400 ${Math.round(h * 0.028)}px ${LRC_FONT_STACK}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('选择背景图片后在此预览封面效果', w / 2, h / 2);
}

function renderCoverPreview() {
  const canvas = $('lrc-cover-preview');
  const ctx = canvas.getContext('2d');
  const image = coverState.image;
  if (!image) {
    canvas.width = 1280;
    canvas.height = 720;
    drawCoverPlaceholder(ctx, 1280, 720);
    $('lrc-cover-preview-meta').textContent = '选择背景图片后在此预览';
    updateLrcCoverGenerateButton();
    return;
  }
  // 画布等于背景图片原始尺寸；预览按最长边折半，导出始终全分辨率
  const maxDim = Math.max(image.width, image.height);
  const scale = maxDim > COVER_PREVIEW_MAX ? COVER_PREVIEW_MAX / maxDim : 1;
  const w = Math.max(1, Math.round(image.width * scale));
  const h = Math.max(1, Math.round(image.height * scale));
  canvas.width = w;
  canvas.height = h;
  drawCover(ctx, w, h);
  $('lrc-cover-preview-meta').textContent =
    `输出 ${image.width} × ${image.height} · ${coverState.format === 'jpeg' ? 'JPEG' : 'PNG'}`;
  updateLrcCoverGenerateButton();
}

/* ---------------- 图片导出 ---------------- */

async function generateCover() {
  if (!coverState.image) {
    setStatus('请先选择背景图片', true);
    return;
  }
  const lines = coverLines();
  if (lines.length === 0) {
    setStatus('请输入封面文字', true);
    return;
  }
  coverState.generating = true;
  updateLrcCoverGenerateButton();
  try {
    const { width, height } = coverState.image;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    drawCover(canvas.getContext('2d'), width, height);
    const mime = coverState.format === 'jpeg' ? 'image/jpeg' : 'image/png';
    const blob = await new Promise((resolve, reject) => {
      canvas.toBlob(
        (result) => (result ? resolve(result) : reject(new Error('封面编码失败'))),
        mime,
        0.92
      );
    });
    const bytes = new Uint8Array(await blob.arrayBuffer());
    setStatus('写入文件…');
    const info = await api.saveLrcCover({ bytes, format: coverState.format, title: lines[0].text });
    state.outputs = await api.listOutputs();
    renderOutputs();
    setStatus(`已生成 ${info.name}`);
  } catch (error) {
    setStatus(`生成封面失败: ${error.message}`, true);
  } finally {
    coverState.generating = false;
    updateLrcCoverGenerateButton();
  }
}

function updateLrcCoverGenerateButton() {
  const button = $('lrc-cover-generate');
  if (!button) return;
  button.disabled =
    state.running ||
    coverState.generating ||
    !coverState.image ||
    coverLines().length === 0;
}

/* ---------------- 事件 ---------------- */

async function selectCoverImage({ bytes, name }) {
  const bitmap = await createImageBitmap(new Blob([bytes]));
  coverState.image = { bitmap, name, width: bitmap.width, height: bitmap.height };
  coverPlate = null;
  const nameEl = $('lrc-cover-image-name');
  nameEl.textContent = `${name}（${bitmap.width}×${bitmap.height}）`;
  nameEl.classList.remove('unset');
  renderCoverPreview();
}

// 模糊需要重烘背景底板，拖动滑杆时防抖重建
let coverPlateTimer = null;

function markCoverPlateDirty() {
  if (coverPlateTimer) clearTimeout(coverPlateTimer);
  coverPlateTimer = setTimeout(() => {
    coverPlateTimer = null;
    renderCoverPreview();
  }, 120);
}

function setupCoverAnchorGrid(updateAlignUI) {
  const grid = $('lrc-cover-anchor-grid');
  for (let i = 0; i < 63; i += 1) {
    const button = document.createElement('button');
    button.title = `${LRC_ANCHOR_ROWS[Math.floor(i / 9)]}·${LRC_ANCHOR_COLS[i % 9]}`;
    if (i === coverState.anchor) button.classList.add('active');
    button.addEventListener('click', () => {
      coverState.anchor = i;
      // 锚点联动默认对齐，用户仍可单独调整
      coverState.align = anchorAlign(i);
      updateAlignUI();
      grid.querySelectorAll('button').forEach((el, j) => el.classList.toggle('active', j === i));
      renderCoverPreview();
    });
    grid.appendChild(button);
  }
}

function setupCoverParams() {
  const makeSegmented = (id, current, onPick) => {
    const group = $(id);
    const update = () => {
      group.querySelectorAll('button').forEach((el) => {
        el.classList.toggle('active', el.dataset.value === current());
      });
    };
    group.querySelectorAll('button').forEach((button) => {
      button.addEventListener('click', () => {
        onPick(button.dataset.value);
        update();
        renderCoverPreview();
      });
    });
    update();
    return update;
  };

  const updateAlignUI = makeSegmented('lrc-cover-align', () => String(coverState.align), (value) => {
    coverState.align = parseInt(value, 10);
  });
  makeSegmented('lrc-cover-format', () => coverState.format, (value) => {
    coverState.format = value;
  });

  const text = $('lrc-cover-text');
  text.addEventListener('input', () => {
    coverState.text = text.value;
    renderCoverPreview();
  });

  const subText = $('lrc-cover-subtext');
  subText.addEventListener('input', () => {
    coverState.subText = subText.value;
    renderCoverPreview();
  });

  const subScale = $('lrc-cover-subscale');
  subScale.value = coverState.subScale;
  subScale.addEventListener('input', () => {
    coverState.subScale = parseFloat(subScale.value);
    $('lrc-cover-subscale-value').textContent = `${coverState.subScale.toFixed(2)}x`;
    renderCoverPreview();
  });

  const textColor = $('lrc-cover-text-color');
  textColor.addEventListener('input', () => {
    coverState.textColor = textColor.value;
    renderCoverPreview();
  });

  const blur = $('lrc-cover-blur');
  blur.value = coverState.blur;
  blur.addEventListener('input', () => {
    coverState.blur = parseFloat(blur.value);
    $('lrc-cover-blur-value').textContent = `${coverState.blur.toFixed(1)} px`;
    markCoverPlateDirty();
  });

  const darken = $('lrc-cover-darken');
  darken.value = coverState.darken;
  darken.addEventListener('input', () => {
    coverState.darken = parseInt(darken.value, 10);
    $('lrc-cover-darken-value').textContent = `${coverState.darken}%`;
    renderCoverPreview();
  });

  const saturation = $('lrc-cover-saturation');
  saturation.value = coverState.saturation;
  saturation.addEventListener('input', () => {
    coverState.saturation = parseInt(saturation.value, 10);
    $('lrc-cover-saturation-value').textContent = `${coverState.saturation}%`;
    markCoverPlateDirty();
  });

  const textTransparency = $('lrc-cover-text-transparency');
  textTransparency.value = coverState.textTransparency;
  textTransparency.addEventListener('input', () => {
    coverState.textTransparency = parseFloat(textTransparency.value);
    $('lrc-cover-text-transparency-value').textContent = `${Math.round(coverState.textTransparency * 100)}%`;
    renderCoverPreview();
  });

  const shadowToggle = $('lrc-cover-shadow');
  shadowToggle.checked = coverState.shadow;
  shadowToggle.addEventListener('change', () => {
    coverState.shadow = shadowToggle.checked;
    renderCoverPreview();
  });

  const shadowColor = $('lrc-cover-shadow-color');
  shadowColor.addEventListener('input', () => {
    coverState.shadowColor = shadowColor.value;
    renderCoverPreview();
  });

  const shadowStrength = $('lrc-cover-shadow-strength');
  shadowStrength.value = coverState.shadowStrength;
  shadowStrength.addEventListener('input', () => {
    coverState.shadowStrength = parseInt(shadowStrength.value, 10);
    $('lrc-cover-shadow-strength-value').textContent = `${shadowStrength.value}%`;
    renderCoverPreview();
  });

  const fontSize = $('lrc-cover-font-size');
  fontSize.value = coverState.fontSize;
  fontSize.addEventListener('input', () => {
    coverState.fontSize = parseInt(fontSize.value, 10);
    $('lrc-cover-font-size-value').textContent = fontSize.value;
    renderCoverPreview();
  });

  const lineSpacing = $('lrc-cover-line-spacing');
  lineSpacing.value = coverState.lineSpacing;
  lineSpacing.addEventListener('input', () => {
    coverState.lineSpacing = parseFloat(lineSpacing.value);
    $('lrc-cover-line-spacing-value').textContent = `${parseFloat(lineSpacing.value).toFixed(2)}x`;
    renderCoverPreview();
  });

  setupCoverAnchorGrid(updateAlignUI);
}

async function setupCoverFontSelect() {
  const select = $('lrc-cover-font-family');
  select.addEventListener('change', async () => {
    coverState.fontFamily = select.value ? await loadLrcFont(select.value) : '';
    renderCoverPreview();
  });
  const files = await api.listFonts();
  for (const file of files) {
    const option = document.createElement('option');
    option.value = file;
    option.textContent = file.replace(/\.[^.]+$/, '');
    select.appendChild(option);
  }
  // 默认字体：文件缺失或加载失败时回退系统默认字体栈
  if (coverState.fontFamily) {
    const file = files.find((f) => f.replace(/\.[^.]+$/, '') === coverState.fontFamily);
    if (file) {
      select.value = file;
      await loadLrcFont(file);
    } else {
      coverState.fontFamily = '';
    }
  }
}

function initLrccover() {
  $('lrc-cover-pick-image').addEventListener('click', async () => {
    const result = await api.pickImage();
    if (result) await selectCoverImage(result);
  });
  $('lrc-cover-generate').addEventListener('click', generateCover);
  setupCoverParams();
  setupCoverFontSelect();
  renderCoverPreview();
}

initLrccover();

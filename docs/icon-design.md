# AudioKit 应用图标设计流程

## Apple 设计语言规范

依据 [Apple Human Interface Guidelines — App Icons](https://developer.apple.com/design/human-interface-guidelines/app-icons/)：

- macOS 图标布局为 **1024×1024 px** 正方形画布，最终形态为圆角矩形；系统遮罩产生的圆角曲率与系统内其他圆角元素精确一致。
- 实际产物惯例（macOS Big Sur 起）：**824×824** 圆角矩形居中于 1024 画布，四周留边距（不撑满整个画布），矩形下方带轻微投影。
- 圆角为连续曲率（squircle / 超椭圆），视觉上近似 22.37% 圆角半径，不可用普通圆弧代替。
- 内部图形在矩形内保持充分留白，不得贴边。

## 本图标参数

| 参数 | 值 | 说明 |
| --- | --- | --- |
| 画布 | 1024×1024 | iconset 最大尺寸 |
| 圆角矩形 | 824×824 居中 | Apple 网格，四周各留 100px |
| 曲率 | 超椭圆 n=4.5 | 逼近 Apple 连续曲率 |
| 投影 | 24% 黑，Y 偏移 12px，模糊 22px | 矩形下方 |
| glyph 占比 | 约 62%（矩形内） | 继承源图相对布局 |
| 背景色 | `#e0f2ff` | 源图背景中位色 |
| glyph 色 | `#6abafa` | 源图波形中位色 |
| 抗锯齿 | 2× 超采样 | 2048 绘制后降采样 |

## 处理流程

源图 `icon/icon.png` 仅 354×354，直接放大到 824 会模糊，因此采用分离重建：

1. **分离**：按颜色将蓝色波形 glyph 与浅蓝背景分离为掩膜，分别取样中位色。
2. **重建**：glyph 掩膜用 LANCZOS 放大到目标尺寸后重新填充纯色，边缘在 1024 下保持锐利；背景直接用取样色填充。
3. **合成**：2× 超采样画布上依次叠加投影（squircle 黑块高斯模糊、下移）、squircle 背景、glyph，最后 LANCZOS 降采样到 1024。
4. **打包**：从 1024 主图生成 16/32/128/256/512（含 @2x）共 10 张 iconset，经 `iconutil` 产出 `icon.icns`。

## 重新生成

```sh
python3 tools/make-icon.py
```

依赖：Pillow、numpy（glyph 分离假设"蓝色图形 + 浅色背景"的配色，换图后如配色不同需调整分割阈值）。

## 产物与接入点

| 产物 | 用途 |
| --- | --- |
| `icon/icon-1024.png` | 1024 主图 |
| `icon/icon.icns` | 打包用图标（复制到 `app/icon.icns`） |
| `app/icon.icns` | electron-builder `mac.icon`，打包后 .app 的图标 |
| `app/dock-icon.png` | 开发模式 `app.dock.setIcon` 的 dock 图标 |
| `tools/patch-electron-dev.sh` | 开发模式 cmd-tab 名称/图标 patch（npm postinstall 自动执行） |

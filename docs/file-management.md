# 文件列表同步与手动分类设计

## 背景

文件列表没有数据库，文件系统本身就是持久化层：`main.js` 通过 `listAudioFiles` 扫目录（`readdirSync` + `audioFileInfo`）生成列表，renderer 通过 `refreshAll()` 显式拉取。当前没有任何文件系统监听，也没有右键菜单。

涉及目录（`app/src/main.js:34-38`）：

- 音色库：`~/Library/Application Support/AudioKit/audio/timbre`
- 输入音频：`~/Library/Caches/AudioKit/input`
- 推理输出：`~/Library/Caches/AudioKit/output`

---

## 一、文件删除后自动同步列表

两层机制：

### 1. 目录监听

在 `main.js` 中对 `timbreDir`、`inputDir`、`outputDir` 各挂一个 `fs.watch(dir, { recursive: true })`（macOS 上 Node 的 `fs.watch` 底层走 FSEvents，原生支持 recursive，无需新增依赖）。

- 事件做 300ms debounce（一次删除/移动会触发一串事件）。
- debounce 后通过 `webContents.send('files:changed', { which })` 推给 renderer，`which` 为 `'timbre' | 'input' | 'output'`。
- renderer 收到后只重拉对应列表并更新 state；若被删文件正好是当前选中的 `state.sep.input` / `state.svc.source` / `state.svc.reference`，同时清空选中态并调用 `updateRunButtons()`。
- 监听器生命周期挂在 app 上，`will-quit` 时 `close()`。

### 2. 推理前存在性校验（兜底）

在 `job:sep` / `job:svc` 的 handler 开头对所有输入路径做 `fs.existsSync` 检查。文件不存在时直接返回明确错误（`文件已被移动或删除：xxx`），并顺带推送一次列表刷新。这样即使 watcher 漏了事件，用户得到的也是清晰报错和已同步的列表，不会走到 Rust 解码层才失败。

---

## 二、手动分类（Vocal / Instrumental / Mix / Unclassified）

### 数据流

1. 用户拖入文件 → 导入后默认 `unclassified`，无 sidecar 文件。
2. 用户在文件列表项上右键 → 弹出上下文菜单 → 选择分类。
3. renderer 调用 `api.setInputCategory(name, category)`。
4. main 进程写 sidecar 文件，返回更新后的列表，renderer 重渲染。

### 持久化：sidecar 文件

每个输入文件配一个同目录 sidecar：`<文件名>.ak.json`，内容：

```json
{ "category": "vocal" }
```

- `category` 取值：`unclassified` | `vocal` | `instrumental` | `mix`。
- `audioFileInfo`（`main.js:128`）扫描时顺带读 sidecar，把 `category` 合并进列表条目；sidecar 不存在或读取失败时默认 `unclassified`。
- `listAudioFiles` 的 `isAudioFile` 过滤天然不会让 `.ak.json` 出现在列表里。
- 文件被删除/移动后 sidecar 成为孤儿文件，由第一部分的 watcher 逻辑顺带清理。

### IPC

新增一个 handler：

- `input:set-category(name, category)` → 校验 category 合法 → 写 sidecar → 返回最新 `listAudioFiles(inputDir)`。

preload 暴露 `api.setInputCategory(name, category)`。

### 右键菜单

当前项目没有任何上下文菜单，在 renderer 里实现一个轻量自定义菜单（单个绝对定位的 `div`，全局只有一个实例）：

- 在 `renderFileList` 的 `li` 上监听 `contextmenu` 事件，`preventDefault()` 后在鼠标位置显示菜单。
- 菜单四项：Vocal、Instrumental、Mix、Unclassified，每项带对应字母标识，当前分类项高亮。
- 点击菜单项 → 调用 `api.setInputCategory` → 用返回的列表更新 `state.inputs` 并重渲染。
- 点击页面任意位置、按 Esc、窗口失焦时关闭菜单。

### 分类标识 UI

在 `renderFileList` 中，文件名左边插入一个纯文字字母（`<span class="cat-letter">`），无方块背景；整行（`li`）按分类改变背景色，字母与行背景同色系、更深：

| 分类 | 字母 | 行背景 | 字母颜色 |
|------|------|--------|----------|
| Unclassified | U | 不变色（保持默认） | 继承文件名原本的颜色 |
| Instrumental | I | 浅红 `#f9d6d8` | 深红 `#b03a42` |
| Vocal | V | 浅蓝 `#d3e4f8` | 深蓝 `#2f6db3` |
| Mix | M | 浅黄绿 `#e3ebc8` | 深黄绿 `#758a12` |

样式要点：

- 字母宽 12px 居中，等宽字体加粗，作为 `li` 的第一个 flex 子元素。
- hover / 选中态用 `color-mix` 把行背景向字母颜色加深（88% / 72%），保持可区分。
- Unclassified 行完全保持默认样式，只有字母 U 以原本颜色显示。

### 适用范围

仅两个输入列表（`#sep-input-list`、`#svc-input-list`，共用 `state.inputs`）启用分类标识和右键菜单，`renderFileList` 通过 `categorizable` 选项开启。音色库列表（`#timbre-list`）不使用该功能。

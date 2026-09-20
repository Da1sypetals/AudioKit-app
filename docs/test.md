# 测试

## 位置

端到端测试脚本在 `scratch/lrcvideo-test/`，文件名 `drive<N>.mjs`（新功能用新编号），打包版冒烟脚本为 `smoke.mjs`。`scratch/` 在 `.gitignore` 中，不进版本库。

## 测试方式

没有单元测试框架。测试通过 CDP 驱动 Electron 渲染进程：脚本以 `--remote-debugging-port=<PORT>` 启动应用，轮询 `http://127.0.0.1:<PORT>/json/list` 找到 `index.html` 页面，用 WebSocket 发 `Runtime.evaluate` 直接读写页面内的全局变量与函数（渲染层是普通 script，`lrcState`、`buildScene`、`selectLine`、`renderPreview` 等都在全局作用域），用 `Page.captureScreenshot` 存图。断言失败即 throw，进程退出码为 1。

开发版由脚本自己 `spawn('npx', ['electron', '.', '--remote-debugging-port=NNNN'], { cwd: app })` 启动，结束时 `kill('SIGTERM')`。打包版冒烟用 `open -na /Applications/AudioKit.app --args --remote-debugging-port=9225`。

## 运行

```sh
cd /Users/daisy/develop/audiokit/scratch/lrcvideo-test
node drive19.mjs
```

前置条件：

- `app/` 已执行过 `npm install`，`app/native` 与 `app/fonts` 就位
- 涉及推理的脚本需要 `checkpoints/mlx/` 模型齐全、`app/Models` 链接有效
- 涉及抓歌词的脚本需要网络

每个脚本使用自己固定的调试端口，同一端口同时只能有一个实例；运行中的 app 实例占用端口时脚本会连接失败。

## 编写新的测试

1. 复制 `scratch/lrcvideo-test/` 下任意一个 `drive*.mjs`（如 `drive19.mjs`）作为起点。
2. 改文件头注释说明本轮验证内容，改 `PORT` 为未被占用的端口（现有脚本从 9223 起递增，取当前最大值 +1）。
3. 在 `main()` 里 `waitFor` 应用初始化完成后，用 `evaluate` 构造场景、改状态、读结果，用 `assert` 断言。
4. 需要看画面效果时用 `shot('name')` 存 `scratch/lrcvideo-test/name.png`。

骨架：

```js
// 端到端驱动：启动 Electron，通过 CDP 操作歌词视频功能页
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { writeFileSync } from 'node:fs';

const APP_DIR = '/Users/daisy/develop/audiokit/app';
const PORT = 9244;
const OUT = '/Users/daisy/develop/audiokit/scratch/lrcvideo-test';

const exceptions = [];
let ws;
let msgId = 0;
const pending = new Map();

function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++msgId;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(expression) {
  const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) {
    throw new Error(`页面内执行失败: ${result.exceptionDetails.exception?.description || result.exceptionDetails.text}`);
  }
  return result.result.value;
}

async function waitFor(expression, timeoutMs = 20000, label = expression) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await evaluate(expression).catch(() => false);
    if (value) return value;
    await delay(400);
  }
  throw new Error(`等待超时: ${label}`);
}

async function shot(name) {
  const result = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(`${OUT}/${name}.png`, Buffer.from(result.data, 'base64'));
}

function assert(cond, msg) {
  if (!cond) throw new Error(`断言失败: ${msg}`);
}

async function main() {
  const electron = spawn('npx', ['electron', '.', `--remote-debugging-port=${PORT}`], {
    cwd: APP_DIR,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    let targets = null;
    for (let i = 0; i < 60; i += 1) {
      await delay(500);
      try {
        const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
        targets = await res.json();
        if (targets.some((t) => t.type === 'page')) break;
      } catch {}
    }
    const page = targets.find((t) => t.type === 'page');
    ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', reject, { once: true });
    });
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id && pending.has(msg.id)) {
        const { resolve, reject } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
        return;
      }
      if (msg.method === 'Runtime.exceptionThrown') {
        exceptions.push(msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text);
      }
    });
    await send('Runtime.enable');
    await send('Page.enable');
    await waitFor(`typeof lrcState === 'object' && !!document.getElementById('lrc-tail-hold')`, 20000, '应用初始化');

    // 断言写在这里
    assert(await evaluate(`lrcState.tailHold`) === 8, 'tailHold 默认值应为 8');

    console.log('页面异常:', JSON.stringify(exceptions));
    if (exceptions.length > 0) throw new Error('页面存在异常');
    console.log('E2E OK');
  } finally {
    electron.kill('SIGTERM');
  }
}

main().catch((error) => {
  console.error('E2E FAIL:', error.message);
  process.exit(1);
});
```

约定：

- 脚本断言的是当时的默认值与取值域。默认值或范围变化后，要同步改掉断言它的脚本，否则脚本会失败。
- 场景构造直接写 `lrcState` 字段（`song`、`lines`、`startIdx`、`endIdx`），背景图用 `window.audiokit.readImage(path)` + `selectLrcImage(img)`。
- 页面异常（`Runtime.exceptionThrown`）单独收集，脚本结束前断言为空，避免异常被断言逻辑掩盖。
- 需要测导出/推理链路的脚本参考 `scratch/cdp-test-packaged.js`（走 `window.audiokit` 的 job API）。

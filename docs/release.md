# AudioKit 编译、构建、安装

## 前置条件

- Rust（cargo）、Node.js（npm）、Python 3（Pillow、numpy）
- 模型文件位于 `checkpoints/mlx/`（不进 git），`app/Models/` 已链接到该目录；新机器需先补齐模型

## 构建并安装

```sh
cd app
npm install        # 仅首次
npm run release
```

完成后 `/Applications/AudioKit.app` 即为最新版，从 Spotlight / Launchpad / Dock 启动。重复执行即更新。

## 开发模式

```sh
cd app
npm start
```

## 单项操作

| 操作 | 命令 |
| --- | --- |
| 只构建 Rust FFI | `sh tools/build-native.sh` |
| 只重新生成图标 | `python3 tools/make-icon.py` |
| 只打包不安装（产物在 `app/dist.noindex/`） | `cd app && npm run dist` |

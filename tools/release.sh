#!/bin/sh
# 快速构建并安装：构建 native → 生成图标 → 打包 → ad-hoc 签名 → 增量安装到 /Applications
set -e
cd "$(dirname "$0")/.."

echo "==> [1/5] 构建 Rust FFI"
sh tools/build-native.sh

echo "==> [2/5] 生成图标"
python3 tools/make-icon.py

echo "==> [3/5] electron-builder 打包"
(cd app && CSC_IDENTITY_AUTO_DISCOVERY=false npx electron-builder --dir)

# 输出目录名为 dist.noindex：Spotlight 跳过 .noindex 目录，dist 副本不会出现在搜索结果
APP_OUT="app/dist.noindex/mac-arm64/AudioKit.app"
TARGET="/Applications/AudioKit.app"

echo "==> [4/5] ad-hoc 签名"
codesign --force --deep --sign - "$APP_OUT"

echo "==> [5/5] 安装到 $TARGET"
# rsync 增量：模型未变化时只同步差异，秒级完成
rsync -a --delete "$APP_OUT/" "$TARGET/"

touch "$TARGET"
LSREGISTER=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister
"$LSREGISTER" -f "$TARGET"

echo "==> 完成: $TARGET"

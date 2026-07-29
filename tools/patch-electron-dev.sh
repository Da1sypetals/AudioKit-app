#!/bin/sh
# 开发模式下把 Electron.app 改名/重注册为 AudioKit，
# 使 cmd-tab、dock tooltip 等系统级展示位置显示应用自身名称与图标。
# 机制：重命名 .app（新路径无 Dock/LaunchServices 陈旧缓存）+ plist 改写 +
# 唯一 bundle ID（避免与其他 Electron 安装按 ID 冲突时返回先注册者）。
# 幂等：可反复执行。打包产物由 electron-builder 的 productName 与 mac.icon 负责，不经过此脚本。
set -e

APP_DIR="$(cd "$(dirname "$0")/../app" && pwd)"
ELECTRON_PKG="$APP_DIR/node_modules/electron"
DIST_DIR="$ELECTRON_PKG/dist"
OLD_APP="$DIST_DIR/Electron.app"
NEW_APP="$DIST_DIR/AudioKit.app"

if [ -d "$OLD_APP" ]; then
    mv "$OLD_APP" "$NEW_APP"
fi
if [ ! -d "$NEW_APP" ]; then
    echo "AudioKit.app not found at $NEW_APP" >&2
    exit 1
fi

PLIST="$NEW_APP/Contents/Info.plist"

set_or_add() {
    /usr/libexec/PlistBuddy -c "Set :$1 $2" "$PLIST" 2>/dev/null ||
        /usr/libexec/PlistBuddy -c "Add :$1 string $2" "$PLIST"
}

set_or_add CFBundleName AudioKit
set_or_add CFBundleDisplayName AudioKit
set_or_add CFBundleIdentifier com.daisy.audiokit.dev

if [ -f "$APP_DIR/icon.icns" ]; then
    cp "$APP_DIR/icon.icns" "$NEW_APP/Contents/Resources/icon.icns"
    set_or_add CFBundleIconFile icon
fi

# npm electron 包通过 path.txt 定位可执行文件
printf 'AudioKit.app/Contents/MacOS/Electron' > "$ELECTRON_PKG/path.txt"

# 刷新 LaunchServices 缓存
touch "$NEW_APP"
LSREGISTER=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister
"$LSREGISTER" -f "$NEW_APP"

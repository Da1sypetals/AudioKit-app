#!/bin/sh
# 开发模式下把 Electron.app 的名称/图标 patch 为 AudioKit，
# 使 cmd-tab、dock tooltip 等系统级展示位置显示应用自身标识。
# 打包产物由 electron-builder 的 productName 与 mac.icon 负责，不经过此脚本。
set -e

APP_DIR="$(cd "$(dirname "$0")/../app" && pwd)"
ELECTRON_APP="$APP_DIR/node_modules/electron/dist/Electron.app"
PLIST="$ELECTRON_APP/Contents/Info.plist"

if [ ! -f "$PLIST" ]; then
    echo "Electron.app not found at $ELECTRON_APP" >&2
    exit 1
fi

set_or_add() {
    /usr/libexec/PlistBuddy -c "Set :$1 $2" "$PLIST" 2>/dev/null ||
        /usr/libexec/PlistBuddy -c "Add :$1 string $2" "$PLIST"
}

set_or_add CFBundleName AudioKit
set_or_add CFBundleDisplayName AudioKit

if [ -f "$APP_DIR/icon.icns" ]; then
    cp "$APP_DIR/icon.icns" "$ELECTRON_APP/Contents/Resources/icon.icns"
    set_or_add CFBundleIconFile icon
fi

# 刷新 LaunchServices 缓存
touch "$ELECTRON_APP"
LSREGISTER=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister
"$LSREGISTER" -f "$ELECTRON_APP"
echo "patched: $ELECTRON_APP"

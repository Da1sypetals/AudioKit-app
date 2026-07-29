#!/bin/sh
# 构建 Rust FFI 动态库，并把 dylib 与 mlx.metallib 收集到 app/native/
# CMAKE_POLICY_VERSION_MINIMUM: libsamplerate-sys 的旧 CMakeLists 需要兼容模式
set -e
cd "$(dirname "$0")/.."

CMAKE_POLICY_VERSION_MINIMUM=3.5 cargo build --release --manifest-path native/Cargo.toml

mkdir -p app/native
cp native/target/release/libaudiokit_native.dylib app/native/
METALLIB=$(find native/target/release/build -path "*mlx-sys*/out/build/lib/mlx.metallib" | head -1)
if [ -z "$METALLIB" ]; then
    echo "mlx.metallib not found under native/target/release/build" >&2
    exit 1
fi
cp "$METALLIB" app/native/
echo "collected: app/native/libaudiokit_native.dylib, app/native/mlx.metallib"

import subprocess
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "icon" / "icon.png"
OUT_DIR = ROOT / "icon"
APP_DIR = ROOT / "app"

CANVAS = 1024
RECT = 824  # Apple 网格：1024 画布内 824 圆角矩形，不撑满
SQUIRCLE_N = 4.5  # 超椭圆指数，逼近 Apple 连续曲率
SS = 2  # 超采样抗锯齿

SHADOW_BLUR = 22  # 1024 坐标系下的模糊半径
SHADOW_OFFSET_Y = 12
SHADOW_ALPHA = 0.24


def squircle_mask(size: int, rect: int, n: float) -> Image.Image:
    """生成居中的超椭圆（squircle）灰度掩膜，rect 为矩形边长。"""
    mask = np.zeros((size, size), dtype=np.float32)
    center = size / 2
    half = rect / 2
    y, x = np.mgrid[0:size, 0:size].astype(np.float64)
    xn = np.abs(x + 0.5 - center) / half
    yn = np.abs(y + 0.5 - center) / half
    inside = (xn**n + yn**n) <= 1.0
    mask[inside] = 1.0
    return Image.fromarray((mask * 255).astype(np.uint8), "L")


def main() -> None:
    src = Image.open(SRC).convert("RGBA")
    arr = np.asarray(src).astype(np.float64)
    r, g, b, a = arr[..., 0], arr[..., 1], arr[..., 2], arr[..., 3]

    # 分离 glyph：蓝色波形 R 明显低于 B；背景为浅蓝
    glyph_px = (a > 128) & ((b - r) > 60) & (r < 200)
    bg_px = (a > 128) & ~glyph_px
    if glyph_px.sum() == 0 or bg_px.sum() == 0:
        sys.exit("glyph/background 分离失败，请检查源图配色")

    glyph_color = np.median(arr[glyph_px][:, :3], axis=0).astype(np.uint8)
    bg_color = np.median(arr[bg_px][:, :3], axis=0).astype(np.uint8)
    print(f"glyph color: #{glyph_color[0]:02x}{glyph_color[1]:02x}{glyph_color[2]:02x}")
    print(f"bg color:    #{bg_color[0]:02x}{bg_color[1]:02x}{bg_color[2]:02x}")

    glyph_mask = Image.fromarray((glyph_px * 255).astype(np.uint8), "L")

    # 超采样画布
    big = CANVAS * SS
    rect_big = RECT * SS

    # glyph 掩膜按同一比例放大（保持源图内的相对尺寸与位置，即 62% 内容占比）
    glyph_mask_big = glyph_mask.resize((rect_big, rect_big), Image.LANCZOS)
    glyph_big = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    glyph_layer = Image.new("RGBA", (rect_big, rect_big), (*glyph_color, 255))
    pad = (big - rect_big) // 2
    glyph_big.paste(glyph_layer, (pad, pad), glyph_mask_big)

    # 阴影：squircle 形黑块高斯模糊、下移
    rect_mask_big = squircle_mask(big, rect_big, SQUIRCLE_N)
    shadow = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    shadow_layer = Image.new("RGBA", (big, big), (0, 0, 0, int(255 * SHADOW_ALPHA)))
    shadow.paste(
        shadow_layer,
        (0, SHADOW_OFFSET_Y * SS),
        rect_mask_big.filter(ImageFilter.GaussianBlur(SHADOW_BLUR * SS)),
    )

    # 背景 squircle
    bg_big = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    bg_big.paste(Image.new("RGBA", (big, big), (*bg_color, 255)), (0, 0), rect_mask_big)

    canvas = Image.alpha_composite(shadow, bg_big)
    canvas = Image.alpha_composite(canvas, glyph_big)
    icon = canvas.resize((CANVAS, CANVAS), Image.LANCZOS)

    master = OUT_DIR / "icon-1024.png"
    icon.save(master)
    print(f"wrote {master}")

    # iconset → icns
    iconset = OUT_DIR / "icon.iconset"
    iconset.mkdir(exist_ok=True)
    for size in (16, 32, 128, 256, 512):
        icon.resize((size, size), Image.LANCZOS).save(iconset / f"icon_{size}x{size}.png")
        icon.resize((size * 2, size * 2), Image.LANCZOS).save(
            iconset / f"icon_{size}x{size}@2x.png"
        )
    icns = OUT_DIR / "icon.icns"
    subprocess.run(["iconutil", "-c", "icns", str(iconset), "-o", str(icns)], check=True)
    print(f"wrote {icns}")

    # 复制到 app/：electron-builder 图标 + 开发模式 dock 图标
    (APP_DIR / "icon.icns").write_bytes(icns.read_bytes())
    icon.resize((512, 512), Image.LANCZOS).save(APP_DIR / "dock-icon.png")
    print(f"wrote {APP_DIR / 'icon.icns'}, {APP_DIR / 'dock-icon.png'}")


if __name__ == "__main__":
    main()

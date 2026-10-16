import sys
import numpy as np
from PIL import Image, ImageDraw

# 在截图上画出识别到的方块网格, 供人工核对与微调.
# 用法: python3 draw_grid.py <图片> --tilew 19.5 --tileh 18.5 --phasex 16.5 --phasey 13.5 [--out 路径]
if __name__ == "__main__":
    def opt(name, default=None):
        return float(sys.argv[sys.argv.index(name) + 1]) if name in sys.argv else default

    src = sys.argv[1]
    tw = opt("--tilew", 19.5)
    th = opt("--tileh", 18.5)
    px = opt("--phasex", 0.0)
    py = opt("--phasey", 0.0)
    out = sys.argv[sys.argv.index("--out") + 1] if "--out" in sys.argv else "grid.png"

    im = Image.open(src).convert("RGB")
    W, H = im.size
    d = ImageDraw.Draw(im)
    # 方块边界: 每隔一格画一条竖线/横线
    x = px
    k = 0
    while x < W:
        d.line([(x, 0), (x, H)], fill=(255, 40, 40), width=1)
        if k % 5 == 0:
            d.line([(x, 0), (x, H)], fill=(255, 220, 0), width=1)
        x += tw
        k += 1
    y = py
    k = 0
    while y < H:
        d.line([(0, y), (W, y)], fill=(60, 200, 255), width=1)
        if k % 5 == 0:
            d.line([(0, y), (W, y)], fill=(0, 255, 120), width=1)
        y += th
        k += 1
    im.save(out)
    print(f"已写出 {out}: {W}x{H}, 格宽 {tw}, 格高 {th}, 相位 ({px}, {py})")
    print(f"  竖线数量 {int((W - px) / tw) + 1}, 横线数量 {int((H - py) / th) + 1}")

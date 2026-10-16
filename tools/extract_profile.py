#!/usr/bin/env python3
# 从地图截图里抽地表轮廓. 思路: 逐列找最长的"天空"游程, 地表就是游程底部下方第一个地形像素.
# 这样能自动跳过弹幕文字, UI 边框和图标.
#
# 用法:
#   python3 extract_profile.py <image> [x1 y1 x2 y2] [--min-sky N] [--dump]
import sys
import numpy as np
from PIL import Image

if __name__ == "__main__":
    ARGS = [a for a in sys.argv[1:] if not a.startswith("--")]
    FLAGS = {a for a in sys.argv[1:] if a.startswith("--")}
    path = ARGS[0]
    region = tuple(int(v) for v in ARGS[1:5]) if len(ARGS) >= 5 else None
    min_sky = 3
    if "--min-sky" in sys.argv:
        min_sky = int(sys.argv[sys.argv.index("--min-sky") + 1])
else:
    path = region = None
    FLAGS = set()
    min_sky = 3


def masks(a):
    r, g, b = a[:, :, 0], a[:, :, 1], a[:, :, 2]
    black = (r < 30) & (g < 30) & (b < 30)
    sky = (b > 110) & (b - r > 25) & (g > 80)
    body = (~black) & (~sky)
    return sky, body, black


def profile(path, region=None, min_sky=3, search_down=25):
    a = np.asarray(Image.open(path).convert("RGB")).astype(np.int16)
    if region:
        x1, y1, x2, y2 = region
        a = a[y1:y2, x1:x2]
    sky, body, black = masks(a)
    h, w = body.shape
    prof = np.full(w, np.nan)
    for x in range(w):
        col_sky = sky[:, x]
        # 找最长天空游程
        best_len, best_end = 0, -1
        y = 0
        while y < h:
            if col_sky[y]:
                y0 = y
                while y < h and col_sky[y]:
                    y += 1
                if y - y0 > best_len:
                    best_len, best_end = y - y0, y - 1
            else:
                y += 1
        if best_len < min_sky or best_end < 0:
            continue
        # 游程底部往下找第一个地形像素
        for y in range(best_end + 1, min(h, best_end + 1 + search_down)):
            if body[y, x]:
                prof[x] = y
                break
    return prof, (a.shape[1], a.shape[0])


if __name__ == "__main__":
    prof, (w, h) = profile(path, region, min_sky)
    ok = np.flatnonzero(~np.isnan(prof))
    print(f"{path} 区域={region} min_sky={min_sky} 尺寸 {w}x{h}")
    if ok.size:
        vals = prof[ok]
        print(f"  有轮廓的列 {ok.min()}..{ok.max()} 共 {ok.size} 列, 地表 y 中位 {np.median(vals):.0f}, "
              f"范围 {vals.min():.0f}..{vals.max():.0f}")
        if "--dump" in FLAGS:
            step = max(1, ok.size // 40)
            print("  采样:", " ".join(f"{x}:{prof[x]:.0f}" for x in ok[::step][:40]))
    else:
        print("  没有提取到轮廓")
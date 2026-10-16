#!/usr/bin/env python3
# 用树干宽度反推每格像素数. 树干在地表之上, 颜色偏木色, 通常宽 2 格.
# 做法: 逐列统计"地表之上的木色像素"数量, 得到树干列掩码, 再看连续段的宽度分布.
import sys
import numpy as np
from PIL import Image

sys.path.insert(0, ".")
from extract_profile import profile

path = sys.argv[1]
region = tuple(int(v) for v in sys.argv[2:6]) if len(sys.argv) >= 6 else None
min_sky = int(sys.argv[6]) if len(sys.argv) > 6 else 5

a = np.asarray(Image.open(path).convert("RGB")).astype(np.int16)
if region:
    x1, y1, x2, y2 = region
    a = a[y1:y2, x1:x2]
prof, _ = profile(path, region, min_sky)
h, w, _ = a.shape
r, g, b = a[:, :, 0], a[:, :, 1], a[:, :, 2]
wood = (r > 90) & (r > g + 15) & (g > b) & (b < 110)   # 木色

counts = np.zeros(w, dtype=int)
for x in range(w):
    if np.isnan(prof[x]):
        continue
    ysurf = int(prof[x])
    counts[x] = wood[: max(0, ysurf - 1), x].sum()

mask = counts > 3           # 地表之上有木色像素的列, 视为树干所在列
runs = []
x = 0
while x < w:
    if mask[x]:
        x0 = x
        while x < w and mask[x]:
            x += 1
        runs.append(x - x0)
    else:
        x += 1

print(f"{path} 区域={region} 尺寸 {w}x{h}")
print(f"  树干列数 {mask.sum()}, 连续段数 {len(runs)}")
if runs:
    vals = np.array(runs)
    print(f"  段宽分布: 最小 {vals.min()} 中位 {int(np.median(vals))} 最大 {vals.max()}")
    uniq, cnt = np.unique(vals, return_counts=True)
    print("  段宽计数:", ", ".join(f"{u}:{c}" for u, c in zip(uniq[:12], cnt[:12])))
    print(f"  若树干宽 2 格, 则每格像素 ≈ 最小段宽/2 = {vals.min()/2:.2f}")

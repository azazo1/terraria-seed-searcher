#!/usr/bin/env python3
# 量一下 spawn-map-02.png 的实际像素结构: 已探索区域的边界, 天空/地表/未探索的分类, 地表轮廓.
import sys
from PIL import Image
import numpy as np

path = sys.argv[1] if len(sys.argv) > 1 else "shots/spawn-map-02.png"
im = Image.open(path).convert("RGB")
a = np.asarray(im).astype(np.int16)
h, w, _ = a.shape
r, g, b = a[:, :, 0], a[:, :, 1], a[:, :, 2]

# 分类
black = (r < 30) & (g < 30) & (b < 30)                      # 未探索 / 世界外
sky = (b > 150) & (b > r + 30) & (g > r) & (g > 100)        # 天空蓝
terrain = (~black) & (~sky)                                  # 其它: 地形, 树, UI, 图标

print(f"图片 {w}x{h}")
print(f"黑色像素占比 {black.mean():.3f} | 天空 {sky.mean():.3f} | 其它 {terrain.mean():.3f}")

# 每个 x 列: 天空的上下界, 地形的起点
print("\n列扫描 (每 20 列取一个采样):")
print(f"{'x':>5} {'sky_top':>8} {'sky_bot':>8} {'surf':>6}")
cols = list(range(0, w, 20))
for x in cols:
    col_sky = np.flatnonzero(sky[:, x])
    col_terr = np.flatnonzero(terrain[:, x])
    sky_top = col_sky.min() if col_sky.size else -1
    sky_bot = col_sky.max() if col_sky.size else -1
    # 地表 = 天空下方第一个地形像素
    surf = -1
    if sky_bot >= 0:
        below = col_terr[col_terr > sky_bot]
        if below.size:
            surf = int(below.min())
    print(f"{x:>5} {sky_top:>8} {sky_bot:>8} {surf:>6}")

# 已探索区域 (非黑) 的包围盒
expl = ~black
ys, xs = np.nonzero(expl)
print(f"\n非黑区域包围盒: x {xs.min()}..{xs.max()} ({xs.max()-xs.min()+1} px), y {ys.min()}..{ys.max()} ({ys.max()-ys.min()+1} px)")

# 只看中间的横带 (排除左右 UI 边框): 找每列是否有天空
sky_cols = np.flatnonzero(sky.any(axis=0))
if sky_cols.size:
    print(f"含天空像素的列: {sky_cols.min()}..{sky_cols.max()} ({sky_cols.size} px)")
terr_cols = np.flatnonzero(terrain.any(axis=0))
print(f"含地形像素的列: {terr_cols.min()}..{terr_cols.max()} ({terr_cols.size} px)")

# 左右边缘的颜色特征 (看是不是木纹 UI 边框)
for x in (2, 20, 40, 46, 50, w - 3, w - 20, 840, 843, 846):
    px = a[h // 2, x]
    print(f"  中间行 x={x}: RGB={tuple(int(v) for v in px)}")

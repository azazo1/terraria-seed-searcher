#!/usr/bin/env python3
# 把 spawn-map-01.png (宽视野地图) 的剖面与 scaled.png (已知 1 像素 = 1 格) 对齐,
# 求出图 1 的 px/格 以及它在世界里的横向位置.
#
# 用法: python3 align_two_maps.py [--verbose]
import sys

import numpy as np
from PIL import Image

import os
W = os.environ.get("TERRARIA_WORK", os.path.expanduser("~/terraria-work"))


def masks(a):
    r, g, b = a[:, :, 0].astype(int), a[:, :, 1].astype(int), a[:, :, 2].astype(int)
    black = (r < 30) & (g < 30) & (b < 30)
    sky = (b > 110) & (b - r > 25) & (g > 80)
    return sky, (~black) & (~sky)


def profile(path, region=None, min_sky=3, search_down=30):
    a = np.asarray(Image.open(path).convert("RGB"))
    if region:
        x1, y1, x2, y2 = region
        a = a[y1:y2, x1:x2]
    sky, body = masks(a)
    h, w = body.shape
    prof = np.full(w, np.nan)
    for x in range(w):
        col = sky[:, x]
        best_len, best_end, y = 0, -1, 0
        while y < h:
            if col[y]:
                y0 = y
                while y < h and col[y]:
                    y += 1
                if y - y0 > best_len:
                    best_len, best_end = y - y0, y - 1
            else:
                y += 1
        if best_len < min_sky:
            continue
        for yy in range(best_end + 1, min(h, best_end + 1 + search_down)):
            if body[yy, x]:
                prof[x] = yy
                break
    return prof


def main():
    p1 = profile(f"{W}/shots/spawn-map-01.png", min_sky=20)
    p2 = profile(f"{W}/shots/scaled.png", min_sky=5)
    x1 = np.flatnonzero(~np.isnan(p1))
    x2 = np.flatnonzero(~np.isnan(p2))
    print(f"图1: {x1.size} 列有效, y {np.nanmin(p1):.0f}..{np.nanmax(p1):.0f}")
    print(f"图2(scaled): {x2.size} 列有效, y {np.nanmin(p2):.0f}..{np.nanmax(p2):.0f}")

    # 图 1 的剖面里, 逐段取局部形状, 与 scaled 的剖面比对, 搜索缩放比与偏移
    # 关系: p1(i) ≈ g * p2(f * i + s) + c
    y1 = p1[x1]
    y2 = p2[x2]
    # 各向同性约束: 地图缩放只能等比, 所以横向缩放比与纵向缩放比必须相同.
    # 关系: 图1 的列 i 与行 y1 对应图2 的 (i - d)/f 与 (y1 - c)/f
    best = None
    for f in np.arange(0.20, 4.0, 0.02):
        lo_u = (x1[0] - 0) / f
        hi_u = (x1[-1] - 0) / f
        span = hi_u - lo_u
        for d in np.arange(-span - 200, x2[-1] + 200, max(2, int(20 / f))):
            u = (x1 - d) / f
            ok = (u >= x2[0]) & (u <= x2[-1])
            if ok.sum() < 150:
                continue
            ref = np.interp(u[ok], x2, y2) * f
            cur = y1[ok].astype(float)
            c = float(np.median(cur - ref))
            resid = np.abs(cur - ref - c)
            mad = float(np.median(resid))
            if best is None or mad < best[0]:
                best = (mad, f, d, c, int(ok.sum()))
    if best is None:
        print("没找到可用对齐")
        return 1
    mad, f, d, c, n = best
    print(f"\n最佳对齐 (各向同性): 缩放 f={f:.2f} px/格  横向偏移 d={d:.0f}  纵向截距 c={c:.0f}")
    print(f"  中位绝对差 {mad:.2f} px,  样本 {n}")
    print(f"  图1 覆盖的世界宽度约 {len(x1) / f:.0f} 格")
    if mad > 3.0:
        print("  判定: 残差过大, 该图不能作为第二观测")
    else:
        print("  判定: 残差可接受, 可用作第二观测")
    return 0


if __name__ == "__main__":
    sys.exit(main())

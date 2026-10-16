#!/usr/bin/env python3
# 从游戏主画面截图抽出"一格一列"的地表剖面.
#
# 前提: 截图是游戏主画面 (不是地图), 方块在屏幕上占 N 个像素 (由 --tile 给出).
# 主画面的好处是每个方块清清楚楚, 不存在地图上"云被当成地表"的问题.
#
# 流程:
#   1. 逐像素列找第一个暖色像素 (r 明显大于 b). 背景森林是冷绿色, 天空是蓝色,
#      树叶是亮绿偏冷, 只有泥土与草地是暖色, 这一条把大部分干扰挡掉.
#   2. 按格宽把像素列归入格子, 每格取中位数 (抗单列噪声).
#   3. 剔除离群的格子: 树冠会让某几格比邻居高一两个格, 这种格子标为无效,
#      留空比填错值好 —— 判据本身支持掩码, 无效列不参与打分.
#
# 用法:
#   python3 ingame_profile.py <image> --tile 23 --phase 0 [--marker 52] [--save out.txt]
import sys
import numpy as np
from PIL import Image


def warm_surface(a, y_lo, y_hi, gap_check=15):
    """逐像素列: 自上而下第一个暖色像素的 y.

    gap_check: 候选位置往下这么多像素内若出现天空间隙, 判为树冠而非地表.
    宽树冠有十几格厚且横跨多列, 只靠"比邻居高一格"的离群剔除抓不到, 会被整体误判为地表;
    而树冠下面紧邻树干两侧的缝隙 (天空), 真实地表下面则是厚实土层.
    """
    sub = a[y_lo:y_hi]
    r, g, b = sub[:, :, 0], sub[:, :, 1], sub[:, :, 2]
    warm = (r - b > 8) & (g - b > 4)
    sky = (b - r > 20) & (b > 100)
    h, w = warm.shape
    out = np.full(w, np.nan)
    for x in range(w):
        for y in np.flatnonzero(warm[:, x]):
            lo = y + 1
            hi = min(h, y + 1 + gap_check)
            if hi > lo and sky[lo:hi, x].any():
                continue          # 下方有天空 -> 是树冠
            out[x] = y_lo + y
            break
    return out


def to_tiles(pix, tile, phase, y_lo):
    """把逐像素剖面归到格子: 每格取中位数, 返回以"格"为单位的高度 (越大越低)"""
    n = int((len(pix) - phase) / tile)
    vals = np.full(n, np.nan)
    for k in range(n):
        lo = int(phase + k * tile)
        hi = int(phase + (k + 1) * tile)
        seg = pix[lo:hi]
        seg = seg[~np.isnan(seg)]
        if seg.size >= tile * 0.5:
            # 该格内地表的最低位置 (最大 y) 更接近真实地表: 树冠只遮住部分像素列
            vals[k] = (np.percentile(seg, 75) - y_lo) / tile
    return vals


def drop_outliers(vals, win=4, max_dev=1.0):
    """剔除比邻居高一格以上的格子 (树冠), 返回清洗后的剖面与剔除数"""
    out = vals.copy()
    n = 0
    for i in range(len(vals)):
        lo, hi = max(0, i - win), min(len(vals), i + win + 1)
        seg = vals[lo:hi]
        seg = seg[~np.isnan(seg)]
        if seg.size < 2:
            continue
        med = np.median(seg)
        if not np.isnan(vals[i]) and med - vals[i] > max_dev:
            out[i] = np.nan
            n += 1
    return out, n


if __name__ == "__main__":
    def opt(name, default=None):
        return float(sys.argv[sys.argv.index(name) + 1]) if name in sys.argv else default

    path = sys.argv[1]
    tile = opt("--tile", 23.0)
    phase = opt("--phase", 0.0)
    y_lo, y_hi = int(opt("--ylo", 260)), int(opt("--yhi", 480))
    marker = opt("--marker", None)

    a = np.asarray(Image.open(path).convert("RGB")).astype(int)
    pix = warm_surface(a, y_lo, y_hi)
    have = np.flatnonzero(~np.isnan(pix))
    print(f"{path} 尺寸 {a.shape[1]}x{a.shape[0]}, 格宽 {tile} px, 相位 {phase}")
    print(f"  像素列中有暖色地表的: {have.size}/{len(pix)}")
    vals = to_tiles(pix, tile, phase, y_lo)
    clean, dropped = drop_outliers(vals)
    ok = ~np.isnan(clean)
    print(f"  格子数 {len(vals)}, 有效 {ok.sum()}, 树冠剔除 {dropped}")
    if ok.sum() > 3:
        d = np.abs(np.diff(clean[ok]))
        print(f"  相邻格跳变: 中位 {np.median(d):.2f} 格, >=1 格的占 {(d>=1).mean()*100:.0f}%")
    if marker is not None:
        print(f"  出生点所在格 (由玩家位置换算): {marker}")
    if "--save" in sys.argv:
        out = sys.argv[sys.argv.index("--save") + 1]
        with open(out, "w") as f:
            # 必须保留小数: 提取精度是 0.042 格, 写成整数会把这部分信息丢掉,
            # 完全对齐时残差变成 +-0.5 的均匀抖动, 真种子满分被压到约 0.84, 与假候选混在一起.
            f.write(" ".join(f"{v:.3f}" if not np.isnan(v) else "-999" for v in clean) + "\n")
        print(f"  已写出 {out}")

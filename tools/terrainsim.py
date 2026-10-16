#!/usr/bin/env python3
# TerrainPass 地表剖面模拟器.
#
# 移植自 ref/terraria-decompiled/Terraria/GameContent/Biomes/TerrainPass.cs 的
# ApplyPass 中"逐列决定地表高度"的部分 (不含铺土, 不含 surfaceHistory 的重定位).
# 关键前提: 每个 pass 开始前 Main.rand 都会用世界种子重新播种 (WorldGenerator.RunPass),
# 所以 TerrainPass 只依赖种子与几个外部参数, 与前面的 pass 无关.
#
# 用法:
#   python3 terrainsim.py 123456 [--cols 3600] [--left-beach 340]
import sys
import numpy as np

from rng_probe import UnifiedRandom

W_MEDIUM, H_MEDIUM = 6400, 1800

PLATEAU, HILL, DALE, MOUNTAIN, VALLEY = 0, 1, 2, 3, 4


def surface_offset(rand, feature):
    """GenerateWorldSurfaceOffset 的普通世界分支 (非醉汉/非 remix/非 getGood)."""
    num = 0.0
    if feature == PLATEAU:
        while rand.next(7) == 0:
            num += rand.next(-1, 2)
    elif feature == HILL:
        while rand.next(4) == 0:
            num -= 1.0
        while rand.next(10) == 0:
            num += 1.0
    elif feature == DALE:
        while rand.next(4) == 0:
            num += 1.0
        while rand.next(10) == 0:
            num -= 1.0
    elif feature == MOUNTAIN:
        while rand.next(2) == 0:
            num -= 1.0
        while rand.next(6) == 0:
            num += 1.0
    elif feature == VALLEY:
        while rand.next(2) == 0:
            num += 1.0
        while rand.next(5) == 0:
            num -= 1.0
    return num


def terrain_profile(seed, w=W_MEDIUM, h=H_MEDIUM, left_beach_end=340, right_beach_start=None,
                    flat_pad=5, cols=None, feature_trace=False):
    if right_beach_start is None:
        right_beach_start = w - 340
    cols = cols or w
    rand = UnifiedRandom(seed)
    num2 = h * 0.3 * (rand.next(90, 110) * 0.005)
    num3 = (num2 + h * 0.2) * (rand.next(90, 110) * 0.01)
    num8 = h * 0.23
    num9 = left_beach_end + flat_pad
    feature = PLATEAU
    heights = np.empty(cols)
    features = np.empty(cols, dtype=np.int8)
    for i in range(cols):
        if num9 <= 0:
            feature = rand.next(5)
            num9 = rand.next(5, 40)
            if feature == PLATEAU:
                num9 *= int(rand.next(5, 30) * 0.2)
        num9 -= 1
        if w * 0.45 < i < w * 0.55 and feature in (MOUNTAIN, VALLEY):
            feature = rand.next(3)
        if w * 0.48 < i < w * 0.52:
            feature = PLATEAU
        num2 += surface_offset(rand, feature)
        num10, num11 = 0.17, 0.26
        if i < left_beach_end + flat_pad or i > right_beach_start - flat_pad:
            if num2 < h * num10:
                num2 = h * num10
            elif num2 > num8:
                num2 = num8
        elif num2 < h * num10:
            num2 = h * num10
            num9 = 0
        elif num2 > h * num11:
            num2 = h * num11
            num9 = 0
        while rand.next(3) == 0:
            num3 += rand.next(-2, 3)
        if num3 < num2 + h * 0.06:
            num3 += 1.0
        if num3 > num2 + h * 0.35:
            num3 -= 1.0
        heights[i] = num2
        features[i] = feature
    if feature_trace:
        return heights, features
    return heights


def _sparkline(vals, width=100):
    if len(vals) > width:
        idx = np.linspace(0, len(vals) - 1, width).astype(int)
        vals = vals[idx]
    lo, hi = float(np.min(vals)), float(np.max(vals))
    rows = 12
    grid = [[" "] * len(vals) for _ in range(rows)]
    for x, v in enumerate(vals):
        r = int((v - lo) / (hi - lo + 1e-9) * (rows - 1))
        grid[rows - 1 - r][x] = "#"
    return "\n".join("".join(r) for r in grid)


if __name__ == "__main__":
    seed = int(sys.argv[1]) if len(sys.argv) > 1 else 123456
    cols = int(sys.argv[sys.argv.index("--cols") + 1]) if "--cols" in sys.argv else 3600
    lbe = int(sys.argv[sys.argv.index("--left-beach") + 1]) if "--left-beach" in sys.argv else 340
    hs, fs = terrain_profile(seed, cols=cols, left_beach_end=lbe, feature_trace=True)
    print(f"种子 {seed}, 模拟前 {cols} 列, leftBeachEnd={lbe}")
    print(f"  地表高度: 最小 {hs.min():.0f} 中位 {np.median(hs):.0f} 最大 {hs.max():.0f}")
    print(f"  理论夹取范围: 内地区间 [{1800*0.17:.0f}, {1800*0.26:.0f}] 海滩区 [{1800*0.17:.0f}, {1800*0.23:.0f}]")
    names = ["Plateau", "Hill", "Dale", "Mountain", "Valley"]
    uniq, cnt = np.unique(fs, return_counts=True)
    print("  地形特征分布:", ", ".join(f"{names[u]}={c}" for u, c in zip(uniq, cnt)))
    print(f"  x=3200 附近: " + " ".join(f"{hs[x]:.0f}" for x in range(3180, 3240, 5)))
    print("  形状预览:")
    print(_sparkline(hs))

#!/usr/bin/env python3
# 用真实世界的存档剖面验证 TerrainPass 模拟器.
#
# 思路: 模拟剖面的"特征边界序列"与 leftBeachEnd 有关 (它决定序列从第几列开始),
# 所以对 leftBeachEnd 在合理区间内逐个试, 再对每份模拟做横向偏移搜索, 看能否与真实剖面吻合.
#
# 用法: python3 validate_port.py <surface.npz> <seed> [--window 2600 3800]
import sys
import numpy as np

from terrainsim import terrain_profile

npz = sys.argv[1]
seed = int(sys.argv[2])
win = (2600, 3800)
if "--window" in sys.argv:
    i = sys.argv.index("--window")
    win = (int(sys.argv[i + 1]), int(sys.argv[i + 2]))

d = np.load(npz)
real = d["first_soil"].astype(float)
real[real < 0] = np.nan
valid = ~np.isnan(real)
print(f"真实剖面: 有效列 {valid.sum()} / {real.size}, 高度中位 {np.nanmedian(real):.0f}")

lo, hi = win
sel = valid[lo:hi]
if sel.sum() < 100:
    print("窗口内有效列太少")
    sys.exit(1)
target = real[lo:hi]

results = []
for lbe in range(300, 400, 2):
    sim = terrain_profile(seed, cols=6400, left_beach_end=lbe)
    for shift in range(-60, 61, 1):
        # 模拟的第 i 列对应真实的第 i+shift 列
        idx = np.arange(lo, hi) - shift
        ok = (idx >= 0) & (idx < len(sim)) & np.array(valid[lo:hi])
        if ok.sum() < 200:
            continue
        diff = sim[idx[ok]] - target[ok]
        mad = float(np.median(np.abs(diff)))
        rms = float(np.sqrt(np.mean(diff ** 2)))
        results.append((mad, rms, lbe, shift, int(ok.sum())))

results.sort()
print("\n最佳 6 组 (中位绝对差, 均方根, leftBeachEnd, 横向偏移, 样本数):")
for r in results[:6]:
    print(f"  中位差={r[0]:.2f} rms={r[1]:.2f} leftBeachEnd={r[2]} shift={r[3]} n={r[4]}")

if results and results[0][0] <= 2.0:
    print("\n结论: 中位绝对差小于 2 格, 移植基本正确")
elif results:
    print(f"\n结论: 最佳中位绝对差 {results[0][0]:.2f} 格, 偏大, 需要排查移植细节")

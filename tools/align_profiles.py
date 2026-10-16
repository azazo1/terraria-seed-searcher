#!/usr/bin/env python3
# 求两张地图截图的相对缩放. 做法: 从各自图里抽地表轮廓, 再搜索
#   prof_a(x) ≈ g * prof_b(f * x + s) + c
# 其中 f 就是两张图的 px/格 之比.
#
# 用法: python3 align_profiles.py 图A 图B [--min-sky-a N] [--min-sky-b N] [--region-a x1,y1,x2,y2]
import sys
import numpy as np
from extract_profile import profile

ARGS = [a for a in sys.argv[1:] if not a.startswith("--")]


def opt(name, default=None):
    if name in sys.argv:
        return sys.argv[sys.argv.index(name) + 1]
    return default


pa_path, pb_path = ARGS[0], ARGS[1]
msa = int(opt("--min-sky-a", "5"))
msb = int(opt("--min-sky-b", "5"))
ra = tuple(int(v) for v in opt("--region-a").split(",")) if opt("--region-a") else None
rb = tuple(int(v) for v in opt("--region-b").split(",")) if opt("--region-b") else None

pa, size_a = profile(pa_path, ra, msa)
pb, size_b = profile(pb_path, rb, msb)
print(f"A={pa_path} 尺寸={size_a} 有效列={np.sum(~np.isnan(pa))}")
print(f"B={pb_path} 尺寸={size_b} 有效列={np.sum(~np.isnan(pb))}")

xa = np.flatnonzero(~np.isnan(pa))
xb = np.flatnonzero(~np.isnan(pb))
if xa.size < 30 or xb.size < 30:
    print("有效列太少, 无法对齐")
    sys.exit(1)

results = []
for f in np.geomspace(0.4, 40, 300):
    xb_scaled = xb * f
    lo = max(xa.min(), xb_scaled.min())
    hi = min(xa.max(), xb_scaled.max())
    if hi - lo < 40:
        continue
    span = hi - lo
    for s in np.linspace(-span, span, 120):
        xs = xb_scaled + s
        sel = (xs >= lo) & (xs <= hi)
        if sel.sum() < 40:
            continue
        xq = xs[sel]
        pb_at = np.interp(xq, xb_scaled, pb[xb])
        pa_at = np.interp(xq, xa, pa[xa])
        A = np.vstack([pb_at, np.ones_like(pb_at)]).T
        coef, *_ = np.linalg.lstsq(A, pa_at, rcond=None)
        rms = float(np.sqrt(np.mean((A @ coef - pa_at) ** 2)))
        std = float(np.std(pa_at)) or 1.0
        results.append((rms / std, f, s, coef[0], coef[1], rms, int(sel.sum())))

results.sort()
print("\n最佳 8 个候选 (相对残差, f, 偏移, 纵向增益 g, 常数, rms, 样本数):")
for r in results[:8]:
    print(f"  残差={r[0]:.4f} f={r[1]:.3f} shift={r[2]:.1f} g={r[3]:.3f} c={r[4]:.1f} rms={r[5]:.2f} n={r[6]}")

# 全图残差是否只是"平的直线"造成的假匹配
best = results[0] if results else None
if best:
    print(f"\n结论: A/B 的 px 比约 {best[1]:.3f}, 也就是 A 每格像素是 B 的 {best[1]:.3f} 倍")

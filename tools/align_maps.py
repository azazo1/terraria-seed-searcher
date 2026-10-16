#!/usr/bin/env python3
# 从三张地图截图里抽出地表轮廓, 并求它们之间的缩放/偏移关系.
# 用法: python3 align_maps.py shots/spawn-map-01.png shots/spawn-map-02.png shots/scaled.png
import sys
import numpy as np
from PIL import Image


def load(path):
    return np.asarray(Image.open(path).convert("RGB")).astype(np.int16)


def masks(a):
    r, g, b = a[:, :, 0], a[:, :, 1], a[:, :, 2]
    black = (r < 28) & (g < 28) & (b < 28)
    sky = (b > 120) & (b - r > 30) & (g > 90)
    body = (~black) & (~sky)
    return sky, body


def surface_profile(path, run=5, rows=2):
    """逐列找地表: 该列往下的第一个位置, 满足以它起始的连续 rows 行都是 body,
    并且横向 run 列也都是 body (用来排除树干这种细长物)."""
    a = load(path)
    sky, body = masks(a)
    h, w = body.shape
    prof = np.full(w, np.nan)
    for x in range(run // 2, w - run // 2):
        col = body[:, x]
        idx = np.flatnonzero(col)
        if idx.size == 0:
            continue
        for y in idx:
            if y + rows >= h:
                break
            ok = True
            for dy in range(rows):
                if not (body[y + dy, x - run // 2 : x + run // 2 + 1].all()):
                    ok = False
                    break
            if ok:
                prof[x] = y
                break
    return prof, sky, body


def align(pa, pb, f_range=(0.5, 40.0), n_f=200, n_shift=160):
    """假设 pa(x) = g * pb(f*(x) + s) + c, 搜索 f, 用最小二乘拟合 g 和 c, 返回最优."""
    xa = np.flatnonzero(~np.isnan(pa))
    xb = np.flatnonzero(~np.isnan(pb))
    if xa.size < 20 or xb.size < 20:
        return None
    best = None
    for f in np.geomspace(f_range[0], f_range[1], n_f):
        # 把 b 映射到 a 的 x 轴上: xb_a = f * xb (先只做缩放, 偏移靠滑动窗口)
        xb_scaled = xb * f
        # 在 a 轴上的重叠范围内滑动偏移
        lo = max(xa.min(), xb_scaled.min())
        hi = min(xa.max(), xb_scaled.max())
        if hi - lo < 30:
            continue
        span = hi - lo
        for s in np.linspace(-span, span, int(n_shift)) if n_shift else [0]:
            xs = xb_scaled + s
            sel = (xs >= lo) & (xs <= hi)
            if sel.sum() < 25:
                continue
            xq = xs[sel]
            pb_at = np.interp(xq, xb_scaled, pb[xb])
            pa_at = np.interp(xq, xa, pa[xa])
            A = np.vstack([pb_at, np.ones_like(pb_at)]).T
            try:
                coef, res, *_ = np.linalg.lstsq(A, pa_at, rcond=None)
            except Exception:
                continue
            pred = A @ coef
            rms = float(np.sqrt(np.mean((pred - pa_at) ** 2)))
            denom = float(np.std(pa_at)) or 1.0
            score = rms / denom
            if best is None or score < best["score"]:
                best = {"f": float(f), "shift": float(s), "g": float(coef[0]),
                        "c": float(coef[1]), "rms": rms, "score": score,
                        "n": int(sel.sum())}
    return best


def main():
    paths = sys.argv[1:]
    profs = {}
    for p in paths:
        prof, sky, body = surface_profile(p)
        profs[p] = prof
        ok = ~np.isnan(prof)
        xs = np.flatnonzero(ok)
        if xs.size:
            print(f"{p}: 尺寸 {body.shape[1]}x{body.shape[0]}, 有地表轮廓的列 {xs.min()}..{xs.max()} "
                  f"(共 {xs.size}), 地表 y 范围 {np.nanmin(prof):.0f}..{np.nanmax(prof):.0f}")
        else:
            print(f"{p}: 没提取到轮廓")
    print()
    for i in range(len(paths)):
        for j in range(len(paths)):
            if i == j:
                continue
            pa, pb = profs[paths[i]], profs[paths[j]]
            b = align(pa, pb)
            if b:
                print(f"{paths[i].split('/')[-1]:<20} vs {paths[j].split('/')[-1]:<20} "
                      f"f={b['f']:.3f} shift={b['shift']:.1f} g={b['g']:.3f} "
                      f"相对残差={b['score']:.3f} 样本={b['n']}")

    # 存档轮廓, 方便后续复用
    np.savez("tools/profiles.npz", **{p.split("/")[-1].replace(".png", ""): v for p, v in profs.items()})
    print("\n轮廓已存到 tools/profiles.npz")


if __name__ == "__main__":
    main()

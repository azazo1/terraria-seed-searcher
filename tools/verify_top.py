#!/usr/bin/env python3
# 批量复核候选: 对候选榜里每个种子做一次更严格的对齐 (多个尺度 + 精细偏移 + 中位纵向对齐),
# 按命中率排序输出, 并把最好的那个画成对照图.
#
# 用法: python3 verify_top.py <候选文件> [--top 60] [--out 图.png]
import re
import sys

import numpy as np

sys.path.insert(0, ".")
from setup_beach import setup_beach          # noqa: E402
from terrainsim import terrain_profile       # noqa: E402

import os
W = os.environ.get("TERRARIA_WORK", os.path.expanduser("~/terraria-work"))
MARKER = 471
SCALES = [1.00, 0.97, 1.03, 0.94, 1.06]   # 与 tools/sweep.c 的 g_scales 保持一致
SLOPES = [-0.02, -0.01, 0.0, 0.01, 0.02]   # 容忍图片纵向轻微拉伸


def load_obs(path=None):
    obs = np.loadtxt(path or f"{W}/data/observed_profile.txt")
    return obs, obs > -900


def evaluate(seed, obs, valid, spawn_lo=3160, spawn_hi=3240, marker=MARKER):
    """对候选种子做精细对齐: 尺度 x 纵向斜率 x 横向偏移 三维搜索.

    纵向斜率用来容忍"图片被轻微拉伸"造成的偏移漂移 (恒定偏移会在两端失配).
    """
    lbe, rbs, _ = setup_beach(seed)
    sim = terrain_profile(seed, cols=3550, left_beach_end=lbe, right_beach_start=rbs).astype(float)
    n = obs.size
    col = np.arange(n, dtype=float)
    best = None
    for scale in SCALES:
        shift = np.round(col * scale).astype(int)   # 与 C/CUDA 的 shift = round(j*scale) 一致
        for slope in SLOPES:
            # 纵向偏移 = 常量 + 斜率 * (列号 - 均值), 常量取残差中位数 (稳健)
            for sx in range(spawn_lo, spawn_hi + 1):
                idx = (sx - marker) + shift
                ok = valid & (idx >= 0) & (idx < sim.size)
                if ok.sum() < 20:      # 主画面观测只有约 74 列有效, 不能沿用 200
                    continue
                cv = col[ok] - col[ok].mean()
                # 两侧统一量化到 1/8 格, 与 GPU 内核一致.
                # 不量化的话, 模拟是小数而观测可能是整数, 完全对齐时残差仍是 [0,1) 的随机小数,
                # 只有约一半能过 0.5 容差, 真种子会被假候选压过.
                q = lambda v: np.round(np.asarray(v, dtype=float) * 8.0) / 8.0
                d = q(sim[idx[ok]]) - q(obs[ok])
                off = float(np.median(d - slope * cv))
                resid = np.abs(d - (off + slope * cv))
                hit = float((resid <= 1.5).mean())
                exact = float((resid <= 0.5).mean())
                keep_n = max(50, int(resid.size * 0.70))
                thr = np.partition(resid, keep_n - 1)[keep_n - 1]
                trim = float((resid[resid <= thr] <= 1.5).mean())
                # 用逐格命中率挑最优对齐. 之前用 trim (截尾 +-1.5 松容差) 挑, 结果
                # 会选中错误的对齐, 再把该对齐下的逐格率打出来 —— 真种子会被判低分.
                if best is None or exact > best["exact"]:
                    best = {"trim": trim, "hit": hit, "exact": exact, "spawn": sx, "scale": scale,
                            "slope": slope, "mad": float(np.median(resid)),
                            "n": int(ok.sum()), "lbe": lbe, "idx": idx, "ok": ok,
                            "off": off, "resid": resid}
    return best, sim


def main():
    path = sys.argv[1]
    top = int(sys.argv[sys.argv.index("--top") + 1]) if "--top" in sys.argv else 60
    obs_path = sys.argv[sys.argv.index("--obs") + 1] if "--obs" in sys.argv else None
    marker = int(sys.argv[sys.argv.index("--marker") + 1]) if "--marker" in sys.argv else MARKER
    obs, valid = load_obs(obs_path)
    rows = []
    for line in open(path):
        m = re.search(r"seed=(\d+)\s+spawn_x=(\d+).*?score=([\d.]+)", line)
        if m:
            rows.append((int(m.group(1)), int(m.group(2)), float(m.group(3))))
    rows.sort(key=lambda r: -r[2])
    print(f"候选 {len(rows)} 个, 复核前 {min(top, len(rows))} 个")
    results = []
    for i, (seed, sx_c, sc_c) in enumerate(rows[:top]):
        best, sim = evaluate(seed, obs, valid, marker=marker)
        if best is None:
            continue
        results.append((best["exact"], best["trim"], seed, best, sim))
        if (i + 1) % 5 == 0:
            top_hit = results[0][0] * 100 if results else 0.0
            print(f"  已复核 {i + 1}/{min(top, len(rows))}  当前最好 {top_hit:.1f}%")
    results.sort(key=lambda r: -r[0])
    print("\n复核结果 (按逐格命中率排序, 逐格 = 残差<=0.5 格的列占比):")
    print(f"{'seed':>12} {'C 分':>6} {'逐格':>7} {'截尾命中':>8} {'全列命中':>8} {'spawn':>6} {'尺度':>5} {'斜率':>8}")
    for v_exact, v_trim, seed, best, _ in results[:25]:
        c = next((r[2] for r in rows if r[0] == seed), 0.0)
        print(f"{seed:>12} {c:>6.3f} {v_exact*100:>6.1f}% {v_trim*100:>7.1f}% {best['hit']*100:>7.1f}% {best['spawn']:>6} {best['scale']:>5.2f} {best['slope']:>+7.4f}")
    if results:
        v_exact, v_trim, seed, best, sim = results[0]
        out = sys.argv[sys.argv.index("--out") + 1] if "--out" in sys.argv else f"{W}/data/verify_top_{seed}.png"
        from PIL import Image, ImageDraw
        n = obs.size
        xs = np.arange(n)[best["ok"]]
        real_y = obs[best["ok"]]
        sim_y = sim[best["idx"][best["ok"]]] - best["slope"] * (np.arange(n, dtype=float)[best["ok"]] - np.arange(n, dtype=float)[best["ok"]].mean())
        lo_y = min(real_y.min(), (sim_y - best["off"]).min()) - 5
        hi_y = max(real_y.max(), (sim_y - best["off"]).max()) + 5
        Wp, H = 1400, 420
        img = Image.new("RGB", (Wp, H), (250, 250, 250))
        d = ImageDraw.Draw(img)
        span = max(1.0, hi_y - lo_y)
        for i, x in enumerate(xs):
            px = int(x / n * (Wp - 40)) + 30
            d.point((px, int((real_y[i] - lo_y) / span * (H - 40)) + 20), fill=(200, 60, 60))
            d.point((px, int(((sim_y[i] - best["off"]) - lo_y) / span * (H - 40)) + 20), fill=(60, 90, 200))
        d.text((10, 4), f"seed={seed} scale={best['scale']:.2f} spawn_x={best['spawn']} exact={v_exact*100:.1f}% trim={v_trim*100:.1f}%", fill=(0, 0, 0))
        d.text((10, H - 14), "red = observed (screenshot)   blue = simulated", fill=(0, 0, 0))
        img.save(out)
        print(f"\n最佳候选 seed={seed} 的对照图: {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

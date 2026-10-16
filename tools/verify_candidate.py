#!/usr/bin/env python3
# 候选种子验证: 把某个种子的模拟地表剖面与截图剖面画在一起, 并给出各项指标.
#
# 用法: python3 verify_candidate.py <seed> [--spawn-lo 3160] [--spawn-hi 3240] [--out report.png]
import sys

import numpy as np
from PIL import Image, ImageDraw

sys.path.insert(0, ".")
from setup_beach import setup_beach          # noqa: E402
from terrainsim import terrain_profile       # noqa: E402

import os
W = os.environ.get("TERRARIA_WORK", os.path.expanduser("~/terraria-work"))
MARKER = 471                                  # scaled.png 里出生点图标的列
SCALES = [1.00, 0.97, 1.03, 0.94, 1.06]


def load_obs():
    obs = np.loadtxt(f"{W}/data/observed_profile.txt")
    valid = obs > -900
    return obs, valid


def best_alignment(sim, obs, valid, spawn_lo, spawn_hi, scale):
    n = obs.size
    shift = np.round(np.arange(n) / scale).astype(int)
    best = None
    for sx in range(spawn_lo, spawn_hi + 1):
        base = sx - MARKER
        idx = base + shift
        ok = valid & (idx >= 0) & (idx < sim.size)
        if ok.sum() < 200:
            continue
        d = sim[idx[ok]] - obs[ok]
        off = np.median(d)
        dd = np.abs(d - off)
        for tol in (0.5, 1.5):
            hit = (dd <= tol).mean()
            if best is None or hit > best["hit"]:
                best = {"hit": hit, "spawn": sx, "scale": scale, "off": off,
                        "tol": tol, "n": int(ok.sum()), "mad": float(np.median(dd)),
                        "idx": idx, "ok": ok}
    return best


def main():
    seed = int(sys.argv[1])
    lo = int(sys.argv[sys.argv.index("--spawn-lo") + 1]) if "--spawn-lo" in sys.argv else 3160
    hi = int(sys.argv[sys.argv.index("--spawn-hi") + 1]) if "--spawn-hi" in sys.argv else 3240
    out = sys.argv[sys.argv.index("--out") + 1] if "--out" in sys.argv else f"{W}/data/verify_{seed}.png"

    lbe, rbs, info = setup_beach(seed)
    print(f"种子 {seed}: leftBeachEnd={lbe} rightBeachStart={rbs} 地牢方位={'右' if info['dungeon_side'] else '左'}")
    print(f"  猩红在左: {info['crimson_left']}  空岛/背景: setBG={ {k.replace('setBG', ''): v for k, v in info.items() if k.startswith('setBG')} }")
    print(f"  世界 ID: {info['world_id']}  moon={info['moon']}  雪原 x {info['snow_left']}..{info['snow_right']}")

    sim = terrain_profile(seed, cols=3550, left_beach_end=lbe, right_beach_start=rbs).astype(int)
    obs, valid = load_obs()
    results = [best_alignment(sim, obs, valid, lo, hi, s) for s in SCALES]
    results = [r for r in results if r]
    results.sort(key=lambda r: -r["hit"])
    print("\n对齐结果 (按容差 1.5 格命中率排序):")
    for r in results[:5]:
        print(f"  尺度 {r['scale']:.2f}  spawn_x={r['spawn']}  命中率 {r['hit']*100:.1f}%  "
              f"中位绝对差 {r['mad']:.2f}  纵向偏移 {r['off']:+.0f}  有效列 {r['n']}")

    b = results[0]
    # 画对照图
    n = obs.size
    xs = np.arange(n)[b["ok"]]
    real_y = obs[b["ok"]]
    sim_y = sim[b["idx"][b["ok"]]]
    base_y = min(real_y.min(), (sim_y - b["off"]).min()) - 5
    H, Wp = 420, 1400
    img = Image.new("RGB", (Wp, H), (250, 250, 250))
    d = ImageDraw.Draw(img)
    lo_y = base_y
    hi_y = max(real_y.max(), (sim_y - b["off"]).max()) + 5
    span = max(1.0, hi_y - lo_y)
    for i, x in enumerate(xs):
        px = int(x / n * (Wp - 40)) + 30
        pr = int((real_y[i] - lo_y) / span * (H - 40)) + 20
        ps = int(((sim_y[i] - b["off"]) - lo_y) / span * (H - 40)) + 20
        d.point((px, pr), fill=(200, 60, 60))
        d.point((px, ps), fill=(60, 90, 200))
    d.text((10, 4), f"seed={seed} scale={b['scale']:.2f} spawn_x={b['spawn']} hit={b['hit']*100:.1f}%", fill=(0, 0, 0))
    d.text((10, H - 14), "red = observed (screenshot)   blue = simulated", fill=(0, 0, 0))
    img.save(out)
    print(f"\n对照图已存: {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

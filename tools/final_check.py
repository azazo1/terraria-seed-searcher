#!/usr/bin/env python3
# 最终核对: 给出一个种子, 输出它作为"主播世界种子"的全部证据.
#
# 用法: python3 final_check.py <seed> [--out 图.png]
#
# 证据分三部分:
#   1. 初始化段的可核对字段 (这些来自 60 次取数, 与地形无关)
#   2. 与两份观测剖面 (v1 原始抽取, v2 浮空物修正) 的精细对齐指标
#   3. 判定: 按阈值 0.55 / 逐格命中率 / 双观测一致性 给出结论
import sys

import numpy as np

sys.path.insert(0, ".")
from setup_beach import setup_beach              # noqa: E402
from terrainsim import terrain_profile           # noqa: E402
from verify_top import evaluate                  # noqa: E402

import os
W = os.environ.get("TERRARIA_WORK", os.path.expanduser("~/terraria-work"))
SCALES = [1.00, 0.97, 1.03]


def load(path):
    obs = np.loadtxt(path)
    return obs, obs > -900


def main():
    seed = int(sys.argv[1])
    obs1 = sys.argv[sys.argv.index("--obs") + 1] if "--obs" in sys.argv else f"{W}/data/observed_profile.txt"
    obs2 = sys.argv[sys.argv.index("--obs2") + 1] if "--obs2" in sys.argv else f"{W}/data/observed_profile_v2.txt"
    out = sys.argv[sys.argv.index("--out") + 1] if "--out" in sys.argv else f"{W}/data/final_{seed}.png"
    lbe, rbs, info = setup_beach(seed)

    print(f"=== 种子 {seed} ===")
    print("\n[1] 初始化段字段 (可与存档或游戏内信息核对)")
    print(f"  leftBeachEnd     {lbe}      (左海滩结束, 决定整条流的相位)")
    print(f"  rightBeachStart  {rbs}")
    print(f"  地牢方位         {'右' if info['dungeon_side'] else '左'}")
    print(f"  猩红在左         {info['crimson_left']}")
    print(f"  WorldId          {info['world_id']}")
    print(f"  moonType         {info['moon']}")
    print(f"  雪原范围         x {info['snow_left']} .. {info['snow_right']}")
    bg = {k.replace('setBG', '').replace('_', ' '): v for k, v in info.items() if k.startswith('setBG')}
    print(f"  背景样式         {bg}")

    sim = terrain_profile(seed, cols=3550, left_beach_end=lbe, right_beach_start=rbs).astype(float)
    print("\n[2] 与观测剖面的对齐 (三维搜索: 尺度 x 纵向斜率 x 横向偏移)")
    results = {}
    for name, path in (("主观测", obs1), ("交叉观测", obs2)):
        obs, valid = load(path)
        best = evaluate(seed, obs, valid)[0]
        results[name] = best
        print(f"  {name:>16}: 尺度 {best['scale']:.2f}  spawn_x={best['spawn']}  "
              f"逐格 {best['exact']*100:.1f}%  截尾 {best['trim']*100:.1f}%  全列 {best['hit']*100:.1f}%")

    print("\n[3] 判定")
    v1 = results["主观测"]
    v2 = results["交叉观测"]
    # 阈值来自实测: 真种子的逐格命中率为 中噪声 39.0% / 重噪声 31.7%,
    # 而最好的假候选为 24.2% / 20.5%. 截尾命中率在重噪声下真假颠倒 (假候选 64.0% 高于真种子 63.1%),
    # 因此不作为判据, 只作展示.
    checks = [
        (f"逐格命中率 >= 35%", v1["exact"] >= 0.35, f"{v1['exact']*100:.1f}%"),
        (f"交叉观测逐格 >= 30%", v2["exact"] >= 0.30, f"{v2['exact']*100:.1f}%"),
        (f"spawn_x 落在 3190~3210", 3190 <= v1["spawn"] <= 3210, str(v1["spawn"])),
    ]
    for label, ok, val in checks:
        print(f"  [{'通过' if ok else '未过'}] {label:32} 实际 {val}")
    passed = sum(1 for _, ok, _ in checks if ok)
    print(f"\n  结论: {passed}/{len(checks)} 项通过", end="")
    print(" —— 可以认定为该世界的种子" if passed == len(checks) else " —— 证据不足, 需要人工进一步确认")

    print("\n[4] 对照图")
    from PIL import Image, ImageDraw
    obs, valid = load(f"{W}/data/observed_profile.txt")
    n = obs.size
    xs = np.arange(n)[v1["ok"]]
    real_y = obs[v1["ok"]]
    sim_y = sim[v1["idx"][v1["ok"]]]
    lo_y = min(real_y.min(), (sim_y - v1["off"]).min()) - 5
    hi_y = max(real_y.max(), (sim_y - v1["off"]).max()) + 5
    Wp, H = 1400, 420
    img = Image.new("RGB", (Wp, H), (250, 250, 250))
    d = ImageDraw.Draw(img)
    span = max(1.0, hi_y - lo_y)
    for i, x in enumerate(xs):
        px = int(x / n * (Wp - 40)) + 30
        d.point((px, int((real_y[i] - lo_y) / span * (H - 40)) + 20), fill=(200, 60, 60))
        d.point((px, int(((sim_y[i] - v1["off"]) - lo_y) / span * (H - 40)) + 20), fill=(60, 90, 200))
    d.text((10, 4), f"seed={seed} scale={v1['scale']:.2f} spawn_x={v1['spawn']} "
                    f"exact={v1['exact']*100:.1f}%", fill=(0, 0, 0))
    d.text((10, H - 14), "red = observed (screenshot)   blue = simulated", fill=(0, 0, 0))
    img.save(out)
    print(f"  已保存 {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

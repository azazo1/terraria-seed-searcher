#!/usr/bin/env python3
# 把多张主画面截图拼成一条长地表剖面.
#
# 场景: 玩家边走边截图, 相邻两张有重叠地形. 单张只有约 95 格, 拼起来能到几百格.
# 判据的分辨力几乎正比于列数, 所以这一步价值很大.
#
# 做法:
#   1. 逐张按给定格宽与相位提取"一格一列"的剖面 (复用 ingame_profile).
#   2. 相邻两张用重叠区搜索最优偏移: 使两张重叠部分的形状最吻合.
#   3. 按偏移拼接, 重叠处取两边的中位数; 任一张判为无效列 (树冠) 时用另一张的值.
#
# 用法:
#   python3 stitch_profiles.py --tile 21.25 --phase 10.62 --marker 56 \
#       f1.png f2.png f3.png --save data/observed_stitched.txt
import sys
import numpy as np
from PIL import Image
import ingame_profile as IP


def load_frame(path, tile, phase, y_lo, y_hi):
    a = np.asarray(Image.open(path).convert("RGB")).astype(int)
    pix = IP.warm_surface(a, y_lo, y_hi)
    vals = IP.to_tiles(pix, tile, phase, y_lo)
    clean, dropped = IP.drop_outliers(vals)
    return clean, dropped


def best_shift(a, b, min_overlap=25, ratios=None):
    """找 b 相对 a 的偏移与尺度比: 使 a[i] ≈ b[round(i*ratio)+off] 的部分最多.

    两帧若不是同一缩放, 各自的"格宽"估计会差几个百分点, 只搜偏移会在几十列后漂移,
    所以尺度比也要一起搜.
    """
    if ratios is None:
        # 范围放宽: 逐帧定出的格宽彼此可能差几个百分点, 真值有时落在 0.90/1.10 之外
        ratios = np.arange(0.75, 1.351, 0.01)
    best = None
    for ratio in ratios:
        for off in range(-(len(b) - min_overlap), len(a) - min_overlap + 1):
            pairs = []
            for i in range(len(a)):
                j = int(round(i * ratio)) + off
                if 0 <= j < len(b):
                    va, vb = a[i], b[j]
                    if not np.isnan(va) and not np.isnan(vb):
                        pairs.append((va, vb))
            if len(pairs) < min_overlap:
                continue
            pa = np.array([p[0] for p in pairs])
            pb = np.array([p[1] for p in pairs])
            ra = pa - np.median(pa)
            rb = pb - np.median(pb)
            hit = np.mean(np.abs(ra - rb) <= 0.5)
            if best is None or hit > best[0]:
                best = (hit, off, len(pairs), float(ratio))
    return best


if __name__ == "__main__":
    def opt(name, default):
        return float(sys.argv[sys.argv.index(name) + 1]) if name in sys.argv else default

    # 只把"非选项且不是选项值"的参数当作图片路径
    paths = []
    skip_next = False
    for a in sys.argv[1:]:
        if skip_next:
            skip_next = False
            continue
        if a.startswith("--"):
            skip_next = True
            continue
        paths.append(a)
    tile = opt("--tile", 21.25)
    phase = opt("--phase", 10.62)
    y_lo, y_hi = int(opt("--ylo", 260)), int(opt("--yhi", 480))
    marker = opt("--marker", 56)
    # 逐帧参数: 各图分辨率/构图可能不同, 定出的格宽与相位也不同, 用逗号列表分别给出
    def per_frame(name, default):
        if name in sys.argv:
            return [float(x) for x in sys.argv[sys.argv.index(name) + 1].split(",")]
        return [float(default)] * len(paths)

    tiles = per_frame("--tiles", tile)
    phases = per_frame("--phases", phase)
    ylos = [int(x) for x in per_frame("--ylos", y_lo)]
    yhis = [int(x) for x in per_frame("--yhis", y_hi)]

    frames = []
    for k, p in enumerate(paths):
        v, dropped = load_frame(p, tiles[k], phases[k], ylos[k], yhis[k])
        # --masks "帧号:起-止,..." : 排除被玩家改造过的格区间 (建屋子, 挖平地等)
        if "--masks" in sys.argv:
            for spec in sys.argv[sys.argv.index("--masks") + 1].split(","):
                fk, rng = spec.split(":")
                lo_s, hi_s = rng.split("-")
                if int(fk) == k:
                    v[int(lo_s):int(hi_s) + 1] = np.nan
                    print(f"  排除第 {k} 帧第 {lo_s}~{hi_s} 格 (人工改造区)")
        ok = (~np.isnan(v)).sum()
        frames.append(v)
        print(f"{p}: {len(v)} 格, 有效 {ok}, 树冠剔除 {dropped}")
    if len(frames) < 2:
        print("只给了一张, 直接输出")
        stitched = frames[0]
        anchor = marker
    else:
        # 统一到第一帧的尺度: 逐帧重采样, 这样帧间关系退化为纯偏移
        base = [frames[0]]
        offsets = [0]
        for k in range(1, len(frames)):
            r = best_shift(base[-1], frames[k])
            if r is None:
                print(f"第 {k} 与第 {k+1} 张找不到重叠, 放弃拼接")
                sys.exit(1)
            hit, off, n, ratio = r
            print(f"第 {k}->{k+1} 张: 尺度比 {ratio:.2f}, 偏移 {off}, 重叠 {n} 格, 形状一致率 {hit*100:.0f}%")
            cur = frames[k]
            m = min(len(cur), int(len(cur) / max(ratio, 1e-6)) + 1)
            idx = np.minimum((np.arange(m) * ratio).astype(int), len(cur) - 1)
            base.append(cur[idx])
            offsets.append(offsets[-1] - off)
        frames = base
        lo = min(0, min(offsets))
        hi = max(offsets[k] + len(frames[k]) for k in range(len(frames)))
        n = hi - lo
        acc = [[] for _ in range(n)]
        for k, v in enumerate(frames):
            for i, val in enumerate(v):
                if not np.isnan(val):
                    acc[i + offsets[k] - lo].append(val)
        stitched = np.array([np.median(x) if x else np.nan for x in acc])
        anchor = marker + (0 - lo)      # 第一张里出生点所在格, 换算到拼接后的坐标
    ok = ~np.isnan(stitched)
    print(f"\n拼接结果: {len(stitched)} 格, 有效 {ok.sum()} ({ok.mean()*100:.0f}%), 出生点在第 {anchor:.0f} 格")
    if ok.sum() > 3:
        d = np.abs(np.diff(stitched[ok]))
        print(f"  相邻格跳变 >=1 的占 {(d>=1).mean()*100:.0f}%, 高度范围 {stitched[ok].min():.1f}~{stitched[ok].max():.1f}")
    if "--save" in sys.argv:
        out = sys.argv[sys.argv.index("--save") + 1]
        with open(out, "w") as f:
            f.write(" ".join(f"{v:.0f}" if not np.isnan(v) else "-999" for v in stitched) + "\n")
        print(f"  已写出 {out}  (出生点格 {anchor:.0f} 需作为 --marker)")

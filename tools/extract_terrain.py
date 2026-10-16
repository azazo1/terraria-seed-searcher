#!/usr/bin/env python3
# 从地图截图里抽地表轮廓 (第三版).
#
# 前两版的问题:
#   v1 用"天空游程底部往下第一个非天空像素". 但地图上会画云 (白灰, 不满足"天空"定义)
#      和树冠 (绿色暗色), 它们都会被误当成地表, 使该列报高 4~15 格.
#   v2 只是用中值滤波压了一下, 顺带抹平了真实特征.
#
# 本版的两条判据:
#   1. 颜色: 地表是暖色 (r 明显大于 b, g 也不小于 b). 蓝天 (b 远大于 r) 与白云
#      (r,g,b 接近且都亮) 都不满足. 代价是雪原与冰原这类冷色地形会被判为无轮廓,
#      这些列留空不用, 总比填进错误高度好.
#   2. 厚度: 树冠是一层薄薄的绿色, 下面立刻又是天空; 真正的地表往下连续几十格
#      都是地形色. 因此要求候选位置向下连续 K 格都满足暖色判据.
#
# 用法:
#   python3 extract_terrain.py <image> [x1 y1 x2 y2] [--min-sky N] [--thick K] [--search-down M] [--dump]
import sys
import numpy as np
from PIL import Image


def masks(a):
    r, g, b = a[:, :, 0], a[:, :, 1], a[:, :, 2]
    sky = (b - r > 20) & (b > 100)
    warm = (r - b > 8) & (g - b > 4)
    return sky, warm


def profile(a, min_sky=3, thick=10, search_down=80):
    sky, warm = masks(a)
    h, w = a.shape[0], a.shape[1]
    prof = np.full(w, np.nan)
    for x in range(w):
        col_sky = sky[:, x]
        # 最长天空游程 (主天空)
        best_len, best_end = 0, -1
        y = 0
        while y < h:
            if col_sky[y]:
                y0 = y
                while y < h and col_sky[y]:
                    y += 1
                if y - y0 > best_len:
                    best_len, best_end = y - y0, y - 1
            else:
                y += 1
        if best_len < min_sky or best_end < 0:
            continue
        # 从天空游程底部向下, 找第一个"向下连续 thick 格都是暖色"的位置
        for y in range(best_end + 1, min(h - thick + 1, best_end + 1 + search_down)):
            if warm[y:y + thick, x].all():
                prof[x] = y
                break
    return prof, (w, h)


def clean(prof, win=30, max_dev=20):
    """把偏离局部趋势太远的列判为无效.
    厚度判据偶尔会跳过地表落到更深的层位, 造成几十到上百格的跳变; 这种列留空比填错好."""
    ok = ~np.isnan(prof)
    if ok.sum() < 5:
        return prof, 0
    trend = np.full(len(prof), np.nan)
    for i in range(len(prof)):
        lo, hi = max(0, i - win), min(len(prof), i + win + 1)
        seg = prof[lo:hi]
        seg = seg[~np.isnan(seg)]
        if seg.size:
            trend[i] = np.median(seg)
    bad = ok & (np.abs(prof - trend) > max_dev)
    prof = prof.copy()
    prof[bad] = np.nan
    return prof, int(bad.sum())


if __name__ == "__main__":
    ARGS = [v for v in sys.argv[1:] if not v.startswith("--")]
    FLAGS = {v for v in sys.argv[1:] if v.startswith("--")}

    def opt(name, default):
        return int(sys.argv[sys.argv.index(name) + 1]) if name in sys.argv else default

    path = ARGS[0]
    region = tuple(int(v) for v in ARGS[1:5]) if len(ARGS) >= 5 else None
    img = np.asarray(Image.open(path).convert("RGB")).astype(np.int16)
    if region:
        x1, y1, x2, y2 = region
        img = img[y1:y2, x1:x2]
    prof, (w, h) = profile(img, opt("--min-sky", 3), opt("--thick", 10), opt("--search-down", 80))
    dropped = 0
    if "--clean" in FLAGS:
        prof, dropped = clean(prof, opt("--clean-win", 30), opt("--clean-dev", 20))
    ok = np.flatnonzero(~np.isnan(prof))
    print(f"{path} 区域={region} 尺寸 {w}x{h} 厚度判据={opt('--thick', 10)}"
          + (f" 离群剔除={dropped} 列" if "--clean" in FLAGS else ""))
    if "--save" in sys.argv:
        out = sys.argv[sys.argv.index("--save") + 1]
        vals = np.where(np.isnan(prof), -999.0, prof)
        with open(out, "w") as f:
            f.write(" ".join(f"{v:.0f}" for v in vals) + "\n")
        print(f"  已写出 {out} ({len(vals)} 列, 其中无效 {int(np.isnan(prof).sum())} 列)")
    if ok.size:
        vals = prof[ok]
        d = np.abs(np.diff(vals))
        print(f"  有轮廓的列 {ok.min()}..{ok.max()} 共 {ok.size} 列 "
              f"(占 {ok.size/w:.1%}), 地表 y 中位 {np.median(vals):.0f}, 范围 {vals.min():.0f}..{vals.max():.0f}")
        print(f"  相邻列跳变: |d|>=1 {(d>=1).mean()*100:.1f}%,  |d|>=2 {(d>=2).mean()*100:.1f}%,  最大 {d.max():.0f}")
        if "--dump" in FLAGS:
            step = max(1, ok.size // 40)
            print("  采样:", " ".join(f"{x}:{prof[x]:.0f}" for x in ok[::step][:40]))
    else:
        print("  没有提取到轮廓")

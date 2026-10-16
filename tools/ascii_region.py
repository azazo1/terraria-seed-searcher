#!/usr/bin/env python3
# 把图片某个区域按颜色分类打印成字符网格, 用来在没有视觉能力时"看"像素结构.
# 用法: python3 ascii_region.py <image> x1 y1 x2 y2 [step]
import sys
import numpy as np
from PIL import Image

path = sys.argv[1]
x1, y1, x2, y2 = (int(v) for v in sys.argv[2:6])
step = int(sys.argv[6]) if len(sys.argv) > 6 else 1

a = np.asarray(Image.open(path).convert("RGB")).astype(np.int16)
region = a[y1:y2, x1:x2]


def classify(px):
    r, g, b = int(px[0]), int(px[1]), int(px[2])
    if r < 28 and g < 28 and b < 28:
        return " "        # 未探索 / 世界外
    if b > 120 and b - r > 30 and g > 90:
        return "."        # 天空
    if g > r + 15 and g > b + 15:
        return "g"        # 草 / 植物
    if r > 100 and g > 60 and b < 90:
        return "w"        # 木 / 树干
    if r > 90 and abs(r - g) < 40 and b < r:
        return "#"        # 土 / 石
    if r > 150 and g > 100 and b > 100:
        return "o"        # 亮色 (图标 / UI)
    return "*"

print(f"{path} 区域 x[{x1},{x2}) y[{y1},{y2}) 每 {step} 像素取一点")
print("图例: ' '黑 . 天空 g 草 w 木 # 土石 o 亮色 * 其它")
for y in range(0, region.shape[0], step):
    row = "".join(classify(region[y, x]) for x in range(0, region.shape[1], step))
    print(f"{y1 + y:>4} {row}")
print("     " + "".join(str(((x1 + x) // 10) % 10) for x in range(0, region.shape[1], step)))

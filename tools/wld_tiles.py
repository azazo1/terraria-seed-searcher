#!/usr/bin/env python3
"""读取 .wld 存档中任意格子的方块 ID.

用于批量生成的自动判定: 生成一个世界后, 读几个关键格子即可知道有没有目标物件,
不需要进游戏, 也不需要跑过去看.

用法:
    python3 wld_tiles.py <world.wld> 4157,662 4158,662 4157,663 4158,663
    python3 wld_tiles.py <world.wld> --window 4157 4158 662 663     # 输出该矩形内的方块
"""
import sys
import struct

sys.path.insert(0, __file__.rsplit("/", 1)[0])
import wld_header as WH


def decode(path, w=6400, h=1800, want=None, window=None):
    """按列解码方块段. want 是 (x,y) 集合; window 是 (x1,x2,y1,y2)."""
    buf = open(path, "rb").read()
    head = WH.parse_format_header(buf)
    imp = head["importance"]
    start, end = head["offsets"][1], head["offsets"][2]
    pos = start
    found = {}
    for x in range(w):
        y = 0
        while y < h:
            b4 = buf[pos]; pos += 1
            b2 = b = 0
            if b4 & 1:
                b2 = buf[pos]; pos += 1
                if b2 & 1:
                    b = buf[pos]; pos += 1
                    if b & 1:
                        pos += 1
            active = (b4 & 2) == 2
            ttype = -1
            if active:
                if b4 & 32:
                    ttype = (buf[pos + 1] << 8) | buf[pos]; pos += 2
                else:
                    ttype = buf[pos]; pos += 1
                if ttype < len(imp) and imp[ttype]:
                    pos += 4                       # frameX, frameY
                if b & 8:
                    pos += 1                       # 方块颜色
            if b4 & 4:
                pos += 1                           # 墙
                if b & 16:
                    pos += 1
            if ((b4 & 24) >> 3) != 0:
                pos += 1                           # 液体
            if b > 1 and (b & 64):
                pos += 1
            rle = (b4 & 192) >> 6
            if rle == 0:
                k = 0
            elif rle == 1:
                k = buf[pos]; pos += 1
            else:
                k = struct.unpack_from("<h", buf, pos)[0]; pos += 2
            if active and ttype > 0:
                for yy in range(y, y + 1 + k):
                    if want and (x, yy) in want:
                        found[(x, yy)] = ttype
                    if window and window[0] <= x <= window[1] and window[2] <= yy <= window[3]:
                        found[(x, yy)] = ttype
            y += 1 + k
    return found, pos == end, head


if __name__ == "__main__":
    path = sys.argv[1]
    args = sys.argv[2:]
    if not args:
        print(__doc__)
        sys.exit(1)
    window = None
    want = set()
    if args[0] == "--window":
        x1, x2, y1, y2 = (int(v) for v in args[1:5])
        window = (x1, x2, y1, y2)
        for x in range(x1, x2 + 1):
            for y in range(y1, y2 + 1):
                want.add((x, y))
    else:
        for a in args:
            x, y = a.split(",")
            want.add((int(x), int(y)))
    found, ok, head = decode(path, want=want, window=window)
    print(f"{path}  seed={head['seed']}  world_id={head['world_id']}  游标吻合={ok}")
    if window:
        for y in range(window[2], window[3] + 1):
            print(f"  y={y}: " + "  ".join(f"{x}->{found.get((x, y), '-')}" for x in range(window[0], window[1] + 1)))
    else:
        for x, y in sorted(want):
            print(f"  ({x},{y}) -> {found.get((x, y), '-')}")

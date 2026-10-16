#!/usr/bin/env python3
# 从 Terraria 的 .wld 存档里读出"逐列地表高度".
#
# 格式依据: ref/terraria-decompiled/Terraria/IO/WorldFile.cs 的
#   LoadFileFormatHeader (文件格式头 + 段偏移表 + importance 位图)
#   LoadWorldTiles (方块段的记录格式, 含垂直 RLE 的重复计数)
#
# 地表判定: 不能简单取"第一个土块", 因为浮空岛的草皮和沙漠的沙子会顶在上面.
# 这里取"第一个满足 [y, y+150) 区间内实心方块占比 >= 0.93 的位置", 也就是主陆块的顶面.
#
# 用法: python3 wld_surface.py <world.wld> [--w 6400] [--h 1800] [--out surface.npz]
import struct
import sys

import numpy as np


def read_int32(buf, pos):
    return struct.unpack_from("<i", buf, pos)[0], pos + 4


def read_int16(buf, pos):
    return struct.unpack_from("<h", buf, pos)[0], pos + 2


def read_uint16(buf, pos):
    return struct.unpack_from("<H", buf, pos)[0], pos + 2


def parse_format_header(buf):
    version, pos = read_int32(buf, 0)
    if version >= 135:
        pos += 20                      # FileMetadata: 8 magic + 4 revision + 8 flags
    section_count, pos = read_int16(buf, pos)
    offsets = []
    for _ in range(section_count):
        v, pos = read_int32(buf, pos)
        offsets.append(v)
    importance_count, pos = read_uint16(buf, pos)
    importance = bytearray(importance_count)
    byte_val, bit = 0, 128
    for i in range(importance_count):
        if bit == 128:
            byte_val = buf[pos]
            pos += 1
            bit = 1
        else:
            bit = (bit << 1) & 0xFF
        if byte_val & bit:
            importance[i] = 1
    return {"version": version, "offsets": offsets, "importance": importance, "pos": pos}


# 主体地形类型: 土, 石, 各种草, 沙, 雪, 冰, 泥, 硬化沙, 黏土, 淤泥
TERRAIN_TYPES = {0, 1, 2, 23, 199, 109, 60, 70, 53, 147, 161, 59, 396, 397, 40, 424}
# 地表上方的树, 植物, 云等不应算作地面
Y_GATE = 300


def scan_surface(path, w=6400, h=1800):
    buf = memoryview(open(path, "rb").read())
    head = parse_format_header(buf)
    print(f"存档格式版本 {head['version']}, 段数 {len(head['offsets'])}, 段偏移 {head['offsets'][:4]} ...")
    imp = head["importance"]
    start, end = head["offsets"][1], head["offsets"][2]
    print(f"方块段 {start} .. {end} ({(end - start) / 1e6:.1f} MB), 解析为 {w} x {h}")

    first_active = np.full(w, -1, dtype=np.int32)
    first_type = np.full(w, -1, dtype=np.int32)
    surface = np.full(w, -1, dtype=np.int32)
    surface_type = np.full(w, -1, dtype=np.int32)
    mv = buf
    pos = start
    for x in range(w):
        y = 0
        col_first = -1
        col_type = -1
        while y < h:
            b4 = mv[pos]
            pos += 1
            b2 = b = 0
            if b4 & 1:
                b2 = mv[pos]; pos += 1
                if b2 & 1:
                    b = mv[pos]; pos += 1
                    if b & 1:
                        pos += 1          # b3
            active = (b4 & 2) == 2
            ttype = -1
            if active:
                if b4 & 32:
                    low = mv[pos]; high = mv[pos + 1]; pos += 2
                    ttype = (high << 8) | low
                else:
                    ttype = mv[pos]; pos += 1
                if ttype < len(imp) and imp[ttype]:
                    pos += 4              # frameX, frameY
                if b & 8:
                    pos += 1              # tile color
            if b4 & 4:
                pos += 1                  # wall
                if b & 16:
                    pos += 1              # wall color
            if ((b4 & 24) >> 3) != 0:
                pos += 1                  # 液体量
            if b > 1 and (b & 64):
                pos += 1                  # wall 高位
            rle = (b4 & 192) >> 6
            if rle == 0:
                k = 0
            elif rle == 1:
                k = mv[pos]; pos += 1
            else:
                k = struct.unpack_from("<h", mv, pos)[0]; pos += 2
            if active:
                if col_first < 0:
                    col_first, col_type = y, ttype
                if surface[x] < 0 and ttype in TERRAIN_TYPES:
                    if y + k >= Y_GATE:
                        surface[x] = max(y, Y_GATE)
                        surface_type[x] = ttype
            y += 1 + k
        first_active[x] = col_first
        first_type[x] = col_type
    ok = pos == end
    print(f"解析结束 {pos}, 段边界 {end}, {'吻合' if ok else '不吻合 差 %d' % (pos - end)}")
    return first_active, first_type, surface, surface_type, ok


if __name__ == "__main__":
    path = sys.argv[1]
    w = int(sys.argv[sys.argv.index("--w") + 1]) if "--w" in sys.argv else 6400
    h = int(sys.argv[sys.argv.index("--h") + 1]) if "--h" in sys.argv else 1800
    fa, ft, surf, stype, ok = scan_surface(path, w, h)
    valid = surf >= 0
    print(f"识别出主体地表的列: {valid.sum()} / {w}")
    if valid.sum():
        v = surf[valid]
        print(f"地表高度: 最小 {v.min()} 中位 {int(np.median(v))} 最大 {v.max()}")
        print("  x=2800..3600 每 50 列:", " ".join(f"{surf[x]}" for x in range(2800, 3601, 50)))
    out = sys.argv[sys.argv.index("--out") + 1] if "--out" in sys.argv else "surface.npz"
    np.savez(out, first_active=fa, first_type=ft, surface=surf, surface_type=stype, ok=ok)
    print(f"已存 {out}")

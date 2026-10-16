#!/usr/bin/env python3
# 解析 .wld 的世界头部, 取出可以和我方模拟对照的字段.
# 字段顺序依据 ref/terraria-decompiled/Terraria/IO/WorldFile.cs 的 LoadHeader / LoadWorldFlags.
#
# 用法: python3 wld_header.py <world.wld>
import struct
import sys

from wld_surface import parse_format_header


def read_string(buf, pos):
    length = 0
    shift = 0
    while True:
        b = buf[pos]
        pos += 1
        length |= (b & 0x7F) << shift
        shift += 7
        if not (b & 0x80):
            break
    s = bytes(buf[pos:pos + length]).decode("utf-8", "replace")
    return s, pos + length


def take(fmt, buf, pos):
    vals = struct.unpack_from(fmt, buf, pos)
    return vals, pos + struct.calcsize(fmt)


def read_header(path):
    buf = memoryview(open(path, "rb").read())
    head = parse_format_header(buf)
    version = head["version"]
    pos = head["offsets"][0]
    out = {"version": version}

    out["world_name"], pos = read_string(buf, pos)
    out["seed"], pos = read_string(buf, pos)
    (out["world_gen_version"],) = struct.unpack_from("<Q", buf, pos); pos += 8
    out["unique_id"] = bytes(buf[pos:pos + 16]).hex(); pos += 16
    (out["world_id"],) = struct.unpack_from("<i", buf, pos); pos += 4
    lw, rw, tw, bw = struct.unpack_from("<4i", buf, pos); pos += 16
    out["bounds"] = (lw, rw, tw, bw)
    maxy, maxx = struct.unpack_from("<2i", buf, pos); pos += 8
    out["max_tiles_x"], out["max_tiles_y"] = maxx, maxy
    (out["game_mode"],) = struct.unpack_from("<i", buf, pos); pos += 4

    flags = ["drunk", "good", "tenth", "dont_starve", "not_the_bees", "remix", "no_traps", "zenith", "skyblock"]
    out["flags"] = {}
    for name in flags:
        out["flags"][name] = bool(buf[pos]); pos += 1

    if version >= 141:
        pos += 8                                   # CreationTime
    if version >= 284:
        pos += 8                                   # LastPlayed
    out["moon_type"] = buf[pos]; pos += 1
    out["tree_x"] = list(struct.unpack_from("<3i", buf, pos)); pos += 12
    out["tree_style"] = list(struct.unpack_from("<4i", buf, pos)); pos += 16
    out["cave_back_x"] = list(struct.unpack_from("<3i", buf, pos)); pos += 12
    out["cave_back_style"] = list(struct.unpack_from("<4i", buf, pos)); pos += 16
    out["ice_back_style"], out["jungle_back_style"], out["hell_back_style"] = struct.unpack_from("<3i", buf, pos)
    pos += 12
    out["spawn_tile_x"], out["spawn_tile_y"] = struct.unpack_from("<2i", buf, pos); pos += 8
    out["world_surface"], out["rock_layer"] = struct.unpack_from("<2d", buf, pos); pos += 16

    # 继续按 LoadHeader 的顺序读到 setBG 那 8 个字节
    pos += 8                                        # _tempTime (double)
    pos += 1                                        # _tempDayTime
    pos += 4                                        # _tempMoonPhase
    pos += 1                                        # _tempBloodMoon
    pos += 1                                        # _tempEclipse
    out["dungeon_x"], out["dungeon_y"] = struct.unpack_from("<2i", buf, pos); pos += 8
    out["crimson"] = bool(buf[pos]); pos += 1
    pos += 10                                       # downedBoss1..3, queenBee, mech1..3, any, plant, golem
    pos += 1                                        # downedSlimeKing (>=118)
    pos += 7                                        # savedGoblin..downedPirates
    pos += 2                                        # shadowOrbSmashed, spawnMeteor
    pos += 1                                        # shadowOrbCount (byte)
    pos += 4                                        # altarCount
    pos += 1                                        # hardMode
    pos += 1                                        # afterPartyOfDoom (>=257)
    pos += 12                                       # invasionDelay/Size/Type
    pos += 8                                        # invasionX (double)
    pos += 8                                        # slimeRainTime (double, >=118)
    pos += 1                                        # sundialCooldown (byte, >=113)
    pos += 1                                        # _tempRaining
    pos += 4                                        # _tempRainTime
    pos += 4                                        # _tempMaxRain (float)
    pos += 12                                       # Cobalt / Mythril / Adamantite
    out["bg_styles"] = [buf[pos + i] for i in range(8)]
    pos += 8
    out["mushroom_bg"] = buf[pos]
    out["underworld_bg"] = buf[pos + 1]
    return out


if __name__ == "__main__":
    h = read_header(sys.argv[1])
    for k, v in h.items():
        print(f"  {k} = {v}")

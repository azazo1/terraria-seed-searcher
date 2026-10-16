#!/usr/bin/env python3
# 世界生成初始化段 (WorldGen.Reset, WorldGen.cs 7192 ~ 7482) 的随机数序列模拟.
#
# 目的: 精确算出每个种子的 GenVars.leftBeachEnd / rightBeachStart, 因为 TerrainPass
# 的整条随机流相位由 leftBeachEnd 决定, 而它有约 80 个可能取值.
#
# 已经用 dev1 (种子 123456, 中型, 专家, 猩红) 的存档逐字段校验通过:
#   WorldId, treeX, treeStyle, caveBackX, caveBackStyle, ice/hell/jungleBackStyle,
#   8 个背景样式, moonType, 地牢方位, leftBeachEnd
#
# 两个容易漏掉的取数点 (都踩过):
#   1. RandomizeWeather (7277): 1 次 Next(10,200) 加循环里的 NextDouble + Next(2)
#   2. RandomizeCaveBackgrounds 分支之后的公共收尾: iceBackStyle / hellBackStyle / jungleBackStyle
#
# 用法: python3 setup_beach.py <seed> [--w 6400]
import sys

from rng_probe import UnifiedRandom

W_MEDIUM = 6400
INT_MAX = 2147483647


def roll_random_forest_bg(r):
    """WorldGen.RollRandomForestBGStyle"""
    num = 14
    n = r.next(num)
    if (n == 1 or n == 2) and r.next(2) == 0:
        n = r.next(num)
    if n == 0:
        n = r.next(num)
    if n == 3 and r.next(3) == 0:
        n = 31
    if n == 5 and r.next(2) == 0:
        n = 51
    if n == 7 and r.next(4) == 0:
        n = r.next(71, 74)
    return n


def randomize_weather(r):
    """WorldGen.RandomizeWeather"""
    r.next(10, 200)
    guard = 0
    while True:
        v = r.next_double() * 0.35 * (r.next(2) * 2 - 1)      # Utils.NextFloat == (float)NextDouble()
        if v != 0.0:
            break
        guard += 1
        if guard > 100:
            break


def randomize_tree_style(r, w):
    """WorldGen.RandomizeTreeStyle"""
    if w == 6400:
        tree_x = [r.next(int(w * 0.334 - w * 0.2), int(w * 0.334 + w * 0.2)),
                  r.next(int(w * 0.667 - w * 0.2), int(w * 0.667 + w * 0.2)), w]
        ts = [r.next(6) for _ in range(3)]
        while ts[1] == ts[0]:
            ts[1] = r.next(6)
        while ts[2] == ts[0] or ts[2] == ts[1]:
            ts[2] = r.next(6)
        for j in range(3):
            if ts[j] == 0 and r.next(3) != 0:
                ts[j] = 4
    else:
        tree_x = [r.next(int(w * 0.25 - w * 0.15), int(w * 0.25 + w * 0.15)),
                  r.next(int(w * 0.5 - w * 0.15), int(w * 0.5 + w * 0.15)),
                  r.next(int(w * 0.75 - w * 0.15), int(w * 0.75 + w * 0.15))]
        ts = [r.next(6) for _ in range(4)]
        while ts[1] == ts[0]:
            ts[1] = r.next(6)
        while ts[2] == ts[0] or ts[2] == ts[1]:
            ts[2] = r.next(6)
        while ts[3] == ts[0] or ts[3] == ts[1] or ts[3] == ts[2]:
            ts[3] = r.next(6)
        for k in range(4):
            if ts[k] == 0 and r.next(3) != 0:
                ts[k] = 4
    tree_style = ts + [0] * (4 - len(ts))
    return tree_x, tree_style


def randomize_cave_backgrounds(r, w):
    """WorldGen.RandomizeCaveBackgrounds, 含分支之后的公共收尾取数"""
    num = 8
    if w == 6400:
        cave_x = [r.next(int(w * 0.334 - w * 0.2), int(w * 0.334 + w * 0.2)),
                  r.next(int(w * 0.667 - w * 0.2), int(w * 0.667 + w * 0.2)), w]
        style = [r.next(num) for _ in range(3)]
        while style[1] == style[0]:
            style[1] = r.next(num)
        while style[2] == style[0] or style[2] == style[1]:
            style[2] = r.next(num)
        style.append(0)
    else:
        cave_x = [r.next(int(w * 0.25 - w * 0.15), int(w * 0.25 + w * 0.15)),
                  r.next(int(w * 0.5 - w * 0.15), int(w * 0.5 + w * 0.15)),
                  r.next(int(w * 0.75 - w * 0.15), int(w * 0.75 + w * 0.15))]
        style = [r.next(num) for _ in range(4)]
        while style[1] == style[0]:
            style[1] = r.next(num)
        while style[2] == style[0] or style[2] == style[1]:
            style[2] = r.next(num)
        while style[3] == style[0] or style[3] == style[1] or style[3] == style[2]:
            style[3] = r.next(num)
    ice_back = r.next(4)
    hell_back = r.next(3)
    jungle_back = r.next(2)
    return cave_x, style, ice_back, hell_back, jungle_back


def randomize_backgrounds(r):
    """WorldGen.RandomizeBackgrounds, 返回 setBG(0..9) 的取值"""
    tree_bg = [roll_random_forest_bg(r)]
    for k in (1, 2, 3):
        v = roll_random_forest_bg(r)
        while v in tree_bg:
            v = roll_random_forest_bg(r)
        tree_bg.append(v)

    corrupt = r.next(6)
    if corrupt == 5:
        corrupt = 51 if r.next(2) == 0 else 52
    jungle = r.next(7)
    snow = r.next(9)
    for base in (2, 3, 4):
        if snow == base and r.next(2) == 0:
            snow = base * 10 + 1 if r.next(2) == 0 else base * 10 + 2
    hallow = r.next(6)
    crimson = r.next(7)
    desert = r.next(6)
    if desert == 5:
        desert = 51 + r.next(5) // 2
    ocean = r.next(8)
    mushroom = r.next(5)
    underworld = r.next(3)
    return {
        "setBG0_treeBG1": tree_bg[0], "setBG1_corrupt": corrupt, "setBG2_jungle": jungle,
        "setBG3_snow": snow, "setBG4_hallow": hallow, "setBG5_crimson": crimson,
        "setBG6_desert": desert, "setBG7_ocean": ocean, "setBG8_mushroom": mushroom,
        "setBG9_underworld": underworld,
    }


def setup_beach(seed, w=W_MEDIUM, verbose=False):
    """返回 (leftBeachEnd, rightBeachStart, 明细)"""
    r = UnifiedRandom(seed)
    jungle_hut = r.next(5)                       # 7215
    crimson_left = r.next(2) != 0                # 7264
    randomize_weather(r)                         # 7277

    for count in (5, 4, 3, 2, 1):                # 7300 地狱箱物品洗牌
        r.next(count)
    r.next(86400 * 2, 86400 * 3)                 # 7309 slimeRainTime
    r.next(8640, 86400)                          # 7314 cloudBGActive
    for _ in range(4):                           # 7323 / 7329 / 7335 / 7341 四种矿的变体
        r.next(2)
    r.next(2)                                    # 7354 猩红 / 腐化
    world_id = r.next(INT_MAX)                   # 7386

    tree_x, tree_style = randomize_tree_style(r, w)                       # 7387
    cave_x, cave_style, ice_b, hell_b, jungle_b = randomize_cave_backgrounds(r, w)   # 7388
    bg = randomize_backgrounds(r)                                         # 7389
    moon = r.next(9)                                                      # 7390
    dungeon_side = 0 if r.next(2) == 0 else 1                             # 7393, 0 左 1 右
    jungle_draw = r.next(15, 30)                                          # 7418 / 7423
    jungle_origin = int(w * (1.0 - jungle_draw * 0.01)) if dungeon_side == 0 else int(w * jungle_draw * 0.01)

    num11 = r.next(w)                                                     # 7427 雪原中心
    if dungeon_side == 1:
        while num11 < w * 0.6 or num11 > w * 0.75:
            num11 = r.next(w)
    else:
        while num11 < w * 0.25 or num11 > w * 0.4:
            num11 = r.next(w)

    n13 = w / 4200.0
    num12 = r.next(50, 90) + int(r.next(20, 40) * n13) + int(r.next(20, 40) * n13)
    snow_left = max(0, num11 - num12)
    num12 = r.next(50, 90) + int(r.next(20, 40) * n13) + int(r.next(20, 40) * n13)
    snow_right = min(w, num11 + num12)

    left_draw = r.next(300, 340)                                          # 7469
    left_beach_end = left_draw + (40 if dungeon_side == 1 else 20)
    right_draw = r.next(300, 340)                                         # 7482
    right_beach_start = w - right_draw - (40 if dungeon_side == 0 else 20)

    info = {
        "jungle_hut": jungle_hut, "crimson_left": crimson_left, "world_id": world_id,
        "tree_x": tree_x, "tree_style": tree_style,
        "cave_x": cave_x, "cave_style": cave_style,
        "ice_back": ice_b, "hell_back": hell_b, "jungle_back": jungle_b,
        "moon": moon, "dungeon_side": dungeon_side, "jungle_origin": jungle_origin,
        "snow_left": snow_left, "snow_right": snow_right,
        "left_draw": left_draw, "right_draw": right_draw,
    }
    info.update(bg)
    if verbose:
        for k, v in info.items():
            print(f"  {k} = {v}")
    return left_beach_end, right_beach_start, info


if __name__ == "__main__":
    seed = int(sys.argv[1])
    lbe, rbs, info = setup_beach(seed, verbose=True)
    print(f"种子 {seed}: leftBeachEnd={lbe}, rightBeachStart={rbs}")

#!/usr/bin/env python3
# 扫描反编译出来的 WorldGen.cs, 统计每个世界生成 pass 的随机数消耗点分布.
# 目的: 判断哪些生成决策发生在"地形无关的固定前缀"里, 可以纯算术筛选种子;
#       哪些补在依赖地形的循环里, 序号浮动, 只能真跑世界生成.
#
# 用法: python3 scan_passes.py <WorldGen.cs 路径>
import bisect
import re
import sys
from pathlib import Path

# 判定"这个循环体碰了地形数据"的特征词
TERRAIN = re.compile(
    r"Main\.tile|\.active\(\)|SolidTile|maxTilesX|maxTilesY|worldSurface|"
    r"rockLayer|UnderworldLayer|\.liquid|TileID\.|InWorld\("
)
LOOP_KINDS = ("for", "while", "do")
KWS = (
    "for", "while", "do", "if", "else", "switch", "try", "catch", "finally",
    "lock", "using", "unsafe", "fixed", "checked", "unchecked",
    "namespace", "class", "struct", "interface", "enum",
)


def classify(pending):
    low = pending.lower()
    for kw in KWS:
        if re.search(r"\b" + kw + r"\b", low):
            return kw
    if "delegate" in low or "=>" in pending:
        return "lambda"
    if "(" in pending and pending.strip().endswith(")"):
        return "method"
    return "block"


def main():
    path = Path(sys.argv[1])
    text = path.read_text(encoding="utf-8", errors="replace")

    line_starts = [0]
    for i, ch in enumerate(text):
        if ch == "\n":
            line_starts.append(i + 1)

    def lineno(off):
        return bisect.bisect_right(line_starts, off)

    frames, stack, sites = [], [], []
    pending = ""
    i, n, in_block = 0, len(text), False

    while i < n:
        if in_block:
            j = text.find("*/", i)
            if j < 0:
                break
            i, in_block = j + 2, False
            continue
        c = text[i]
        if text.startswith("//", i):
            j = text.find("\n", i)
            i = n if j < 0 else j
            pending = ""
            continue
        if text.startswith("/*", i):
            in_block, i = True, i + 2
            continue
        if c in "\"'":
            q = c
            i += 1
            while i < n:
                if text[i] == "\\":
                    i += 2
                    continue
                if text[i] == q:
                    i += 1
                    break
                if text[i] == "\n":
                    break
                i += 1
            pending += " "
            continue
        if c == "{":
            f = {"open": i, "kind": classify(pending), "pend": pending[-600:], "close": None}
            stack.append(f)
            frames.append(f)
            pending = ""
            i += 1
            continue
        if c == "}":
            if stack:
                stack.pop()["close"] = i
            pending = ""
            i += 1
            continue
        if c == ";":
            pending = ""
            i += 1
            continue
        if text.startswith("genRand", i) and re.match(r"genRand\s*\.", text[i:i + 12]):
            sites.append((i, list(stack)))
            i += 7
            continue
        pending += c
        i += 1

    passes = [f for f in frames if "AddGenerationPass" in f["pend"] and "delegate" in f["pend"]]
    passes.sort(key=lambda f: f["open"])
    for idx, f in enumerate(passes, 1):
        m = re.search(r"GenPassNameID\.(\w+)", f["pend"])
        f["name"] = m.group(1) if m else "?"
        f["idx"] = idx

    rows = []
    for f in passes:
        end = f["close"] or 10 ** 12
        inside = [(o, st) for (o, st) in sites if f["open"] < o < end]
        in_loop = [(o, st) for (o, st) in inside if any(fr["kind"] in LOOP_KINDS for fr in st)]
        terr = 0
        for (o, st) in in_loop:
            for fr in st:
                if fr["kind"] in LOOP_KINDS and fr["close"]:
                    if TERRAIN.search(text[fr["open"]:fr["close"]]):
                        terr += 1
                        break
        body = text[f["open"]:end]
        calls = []
        for m in re.finditer(r"([A-Za-z_]\w*)\.([A-Za-z_]\w*)\(", body):
            name = m.group(1) + "." + m.group(2)
            if name.startswith("genRand") or name.startswith("WorldGen.genRand"):
                continue
            if name not in calls:
                calls.append(name)
        rows.append(
            {
                "idx": f["idx"],
                "name": f["name"],
                "line": lineno(f["open"]),
                "sites": len(inside),
                "in_loop": len(in_loop),
                "terrain_loop": terr,
                "calls": ";".join(calls[:6]),
            }
        )

    out = Path(__file__).with_name("pass_scan.tsv")
    with out.open("w", encoding="utf-8") as fh:
        fh.write("idx\tname\topen_line\tsites\tin_loop\tterrain_loop\tcalls\n")
        for r in rows:
            fh.write(
                f"{r['idx']}\t{r['name']}\t{r['line']}\t{r['sites']}\t"
                f"{r['in_loop']}\t{r['terrain_loop']}\t{r['calls']}\n"
            )

    print(f"pass 总数: {len(rows)}")
    print(f"零随机数消耗点的 pass: {sum(1 for r in rows if r['sites'] == 0)}")
    print(f"含地形相关循环取数的 pass: {sum(1 for r in rows if r['terrain_loop'] > 0)}")
    print(f"表格已写入: {out}")
    print()
    print("前 30 个 pass:")
    print(f"{'#':>4} {'pass':<42} {'行':>7} {'取数':>5} {'循环内':>7} {'地形循环':>9}")
    for r in rows[:30]:
        print(
            f"{r['idx']:>4} {r['name'][:42]:<42} {r['line']:>7} {r['sites']:>5} "
            f"{r['in_loop']:>7} {r['terrain_loop']:>9}"
        )


if __name__ == "__main__":
    main()

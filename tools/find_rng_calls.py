#!/usr/bin/env python3
# 静态分析: 给定 WorldGen.cs 的一个行区间, 找出这段代码直接和间接 (一层) 消耗随机数的方法.
#
# 做法: 先用大括号配对把候选文件里的方法体切出来, 再在体内找 genRand / Main.rand / random.Next.
#
# 用法: python3 find_rng_calls.py <file> <start> <end> [--depth 2]
import os
import re
import sys

sys.setrecursionlimit(10000)

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "ref", "terraria-decompiled")

RAND_RE = re.compile(r"genRand\s*\.|Main\.rand\s*\.|random\.Next|rand\.Next|\br\s*\.Next\(")
CALL_RE = re.compile(r"\b([A-Z][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)\s*\(")
DEF_RE = re.compile(
    r"^\t\t(?:public|private|internal|protected|static|override|virtual|sealed|async|\s)*"
    r"[\w<>\[\],\.\?\s]+?\s([A-Za-z_][A-Za-z0-9_]*)\s*\([^;{]*\)\s*$"
)


def strip_comments(text):
    out = []
    i = 0
    n = len(text)
    while i < n:
        c = text[i]
        if c == '"':
            j = i + 1
            while j < n:
                if text[j] == "\\":
                    j += 2
                    continue
                if text[j] == '"':
                    break
                j += 1
            out.append(text[i:j + 1])
            i = j + 1
        elif text.startswith("//", i):
            j = text.find("\n", i)
            i = n if j < 0 else j
        elif text.startswith("/*", i):
            j = text.find("*/", i)
            i = n if j < 0 else j + 2
        else:
            out.append(c)
            i += 1
    return "".join(out)


def load_methods(path):
    """返回 {方法名: (起行, 止行, 去掉注释的函数体)}"""
    with open(path, encoding="utf-8", errors="replace") as f:
        lines = f.readlines()
    text = strip_comments("".join(lines))
    # 行号索引
    starts = [0]
    for ln in lines:
        starts.append(starts[-1] + len(ln))

    def line_of(pos):
        lo, hi = 0, len(starts) - 1
        while lo < hi:
            mid = (lo + hi + 1) // 2
            if starts[mid] <= pos:
                lo = mid
            else:
                hi = mid - 1
        return lo + 1

    methods = {}
    for m in re.finditer(r"\n((?:\t{2})[^\n]*\([^;{}\n]*\)\s*\n(?:\t{2})\{)", text):
        sig = m.group(1).splitlines()[0].strip()
        name_m = re.search(r"([A-Za-z_][A-Za-z0-9_]*)\s*\(", sig)
        if not name_m:
            continue
        name = name_m.group(1)
        body_start = m.end(1) - 1
        depth = 0
        i = body_start
        while i < len(text):
            if text[i] == "{":
                depth += 1
            elif text[i] == "}":
                depth -= 1
                if depth == 0:
                    break
            i += 1
        methods.setdefault(name, []).append((line_of(m.start(1)), line_of(i), text[body_start:i + 1]))
    return methods, text


def main():
    path = os.path.join(ROOT, sys.argv[1])
    start, end = int(sys.argv[2]), int(sys.argv[3])
    depth = int(sys.argv[sys.argv.index("--depth") + 1]) if "--depth" in sys.argv else 2

    methods, text = load_methods(path)
    others = {}
    for extra in ("Terraria/Main.cs", "Terraria/Liquid.cs", "Terraria/GameContent/TreeTopsInfo.cs"):
        p = os.path.join(ROOT, extra)
        if os.path.exists(p):
            try:
                m, _ = load_methods(p)
                for k, v in m.items():
                    others.setdefault(k, []).extend([(extra, a, b, c) for a, b, c in v])
            except Exception as exc:
                print(f"(跳过 {extra}: {exc})")

    with open(path, encoding="utf-8", errors="replace") as f:
        region = "".join(f.readlines()[start - 1:end])
    region = strip_comments(region)

    print(f"区间 {sys.argv[1]}:{start}-{end} 内直接调用且会消耗随机数的方法 (递归深度 {depth}):")
    seen = set()

    def inspect(name, depth_left, indent, via):
        if name in seen or depth_left < 0:
            return
        cands = methods.get(name, []) + others.get(name, [])
        if not cands:
            return
        # 选第一个函数体
        if name in methods:
            ln0, ln1, body = methods[name][0]
            where = f"{sys.argv[1]}:{ln0}-{ln1}"
        else:
            f_, a_, b_, body = others[name][0]
            where = f"{f_}:{a_}-{b_}"
        hits = [l for l in body.splitlines() if RAND_RE.search(l)]
        if not hits:
            return
        seen.add(name)
        print(f"{indent}- {name}  ({where})  来自 {via}, 体内取数行 {len(hits)} 处:")
        for h in hits[:8]:
            print(f"{indent}    {h.strip()[:120]}")
        if depth_left:
            for c in sorted({f"{m.group(1)}.{m.group(2)}" for m in CALL_RE.finditer(body)}):
                inspect(c.split(".")[1], depth_left - 1, indent + "  ", name)

    for m in sorted({f"{x.group(1)}.{x.group(2)}" for x in CALL_RE.finditer(region)}):
        inspect(m.split(".")[1], depth, "  ", "区间内直接调用")


if __name__ == "__main__":
    main()

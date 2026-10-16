#!/usr/bin/env python3
# UnifiedRandom (Terraria.Utilities) 的逐行移植, 外加社区仿射公式的校验.
#
# 源码: ref/terraria-decompiled/Terraria/Utilities/UnifiedRandom.cs
# 校验: 粉史莱姆给出的 种子 -> 第 n 随机数 的线性公式
#   r1 = ((1121899819*seed + 1559595546) mod (2^31-1)) / (2^31-1)
#   r2 = (( 630111683*seed + 1755192844) mod (2^31-1)) / (2^31-1)
#   r3 = ((1501065279*seed + 1649316166) mod (2^31-1)) / (2^31-1)
#   r9 = (( 265679591*seed + 2099272109) mod (2^31-1)) / (2^31-1)
import sys

M = 2147483647  # int.MaxValue / MBIG
MSEED = 161803398
SCALE = 4.656612875245797e-10  # UnifiedRandom.Sample() 里的常量


def i32(x):
    """C# 的 int 是 32 位有符号, 溢出回绕."""
    x &= 0xFFFFFFFF
    return x - 0x100000000 if x >= 0x80000000 else x


class UnifiedRandom:
    def __init__(self, seed):
        self.seed_array = [0] * 56
        self.inext = 0
        self.set_seed(seed)

    def set_seed(self, seed):
        sa = self.seed_array
        for i in range(len(sa)):
            sa[i] = 0
        num = M if seed == -2147483648 else abs(seed)
        num2 = i32(MSEED - num)
        sa[55] = num2
        num3 = 1
        for j in range(1, 55):
            num4 = 21 * j % 55
            sa[num4] = num3
            num3 = i32(num2 - num3)
            if num3 < 0:
                num3 = i32(num3 + M)
            num2 = sa[num4]
        for _k in range(1, 5):
            for l in range(1, 56):
                sa[l] = i32(sa[l] - sa[1 + (l + 30) % 55])
                if sa[l] < 0:
                    sa[l] = i32(sa[l] + M)
        self.inext = 0

    def internal_sample(self):
        num = self.inext + 1
        if num > 55:
            num = 1
        num2 = num + 21
        if num2 > 55:
            num2 -= 55
        sa = self.seed_array
        num3 = i32(sa[num] - sa[num2])
        if num3 == M:
            num3 -= 1
        num3 = i32(num3 + ((num3 >> 31) & M))
        sa[num] = num3
        self.inext = num
        return num3

    def sample(self):
        return self.internal_sample() * SCALE

    def next_double(self):
        return self.sample()

    def next(self, min_value=None, max_value=None):
        if min_value is None:
            return self.internal_sample()
        if max_value is None:
            return int(self.sample() * min_value)
        span = max_value - min_value
        return int(self.sample() * span) + min_value


AFFINE = {
    1: (1121899819, 1559595546),
    2: (630111683, 1755192844),
    3: (1501065279, 1649316166),
    9: (265679591, 2099272109),
}


def affine(seed, k):
    a, b = AFFINE[k]
    return ((a * seed + b) % M) / M


def main():
    seeds = [int(s) for s in (sys.argv[1:] or ["1", "123456", "1168621868", "456789012", "3200"])]
    print("校验: 移植的 UnifiedRandom 前 9 次输出 vs 社区仿射公式")
    ok_all = True
    for seed in seeds:
        r = UnifiedRandom(seed)
        vals = [r.internal_sample() for _ in range(9)]
        print(f"\nseed={seed}")
        for k in (1, 2, 3, 9):
            mine = vals[k - 1] / M
            ref = affine(seed, k)
            ok = abs(mine - ref) < 1e-9
            ok_all &= ok
            print(
                f"  r{k}: 移植={mine:.12f}  公式={ref:.12f}  {'一致' if ok else '不一致'}"
            )
    print()
    print("结论:", "全部一致, 移植正确" if ok_all else "存在不一致, 需要排查")
    return 0 if ok_all else 1


if __name__ == "__main__":
    sys.exit(main())

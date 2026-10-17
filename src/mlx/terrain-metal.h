/* MLX 自定义 Metal 内核源码.
 *
 * 与 web/gpu/search.wgsl 以及 src/cuda/sweep.cu 共享同一套整数随机数与评分口径,
 * 三者必须保持一致; 改动任何一处都要同步另外两处, 并用 tests/test_search_backends.py 对拍.
 *
 * 世界尺寸按中世界写死 (6400 x 1800, 地表限制 306 / 414 / 468, 地形分段 2880 / 3072 / 3520 / 3328),
 * 与默认构建的 CPU 和 CUDA 搜索器一致. 非中世界构建需要对这份内核单独处理.
 */
#pragma once

/* 两个内核共用同一个 int32 参数数组. */
enum {
    P_SEED_START = 0,
    P_COUNT = 1,
    P_COLS = 2,
    P_W0 = 3,
    P_W1 = 4,
    P_OBS_N = 5,
    P_NSCALE = 6,
    P_NBASE = 7,
    P_RADIUS = 8,
    P_BASE_LO = 9,
    P_SIZE = 12,
};

inline constexpr const char* kMetalHeader = R"MSL(
/* Next(max) 的原语义是 (int)(Sample() * max), 而 Sample() 的乘数是 1/2147483647
 * 的双精度表示, 因此它等于 sample * max / 2147483647 向下取整.
 * 这里用两个 32 位字完成 32x32 乘法, 再用 2^31-1 的整除技巧求商:
 * 苹果 GPU 的 64 位整数除法很慢, 实测比这套 32 位模拟慢 1.5 倍. */
inline int rng_scaled(uint s, int m) {
    uint s0 = s & 65535u, s1 = s >> 16u;
    uint m0 = (uint)m & 65535u, m1 = (uint)m >> 16u;
    uint w0 = s0 * m0;
    uint t = s1 * m0 + (w0 >> 16u);
    uint w1 = (t & 65535u) + s0 * m1;
    uint hi = s1 * m1 + (t >> 16u) + (w1 >> 16u);
    uint lo = (w1 << 16u) | (w0 & 65535u);
    uint q = (hi << 1u) | (lo >> 31u);
    uint rem = (lo & 2147483647u) + q;
    if (rem >= 2147483647u) q++;
    return (int)q;
}

/* 随机数状态放在 threadgroup 内存里: 每线程 56 个整数, 按数据相关下标读写.
 * 放在线程私有数组里会退化到本地内存, 实测吞吐只有此处的 56%. */
inline int rng_sample(threadgroup int *sa, threadgroup uint *inext) {
    uint i1 = *inext + 1u;
    if (i1 > 55u) i1 = 1u;
    uint i2 = i1 + 21u;
    if (i2 > 55u) i2 -= 55u;
    int v = sa[i1] - sa[i2];
    if (v == 2147483647) v--;
    if (v < 0) v += 2147483647;
    sa[i1] = v;
    *inext = i1;
    return v;
}

inline int rng_next(threadgroup int *sa, threadgroup uint *inext, int m) {
    return rng_scaled((uint)rng_sample(sa, inext), m);
}

inline int rng_between(threadgroup int *sa, threadgroup uint *inext, int lo, int hi) {
    return rng_next(sa, inext, hi - lo) + lo;
}

inline void rng_seed(threadgroup int *sa, threadgroup uint *inext, int seed) {
    for (int i = 0; i < 56; i++) sa[i] = 0;
    int a = 161803398 - seed;
    int b = 1;
    sa[55] = a;
    for (int j = 1; j < 55; j++) {
        int k = 21 * j % 55;
        sa[k] = b;
        b = a - b;
        if (b < 0) b += 2147483647;
        a = sa[k];
    }
    for (int k = 1; k < 5; k++) {
        for (int j = 1; j < 56; j++) {
            int v = sa[j] - sa[1 + (j + 30) % 55];
            if (v < 0) v += 2147483647;
            sa[j] = v;
        }
    }
    *inext = 0;
}

inline int roll_random_forest_bg(threadgroup int *sa, threadgroup uint *inext) {
    int n = rng_next(sa, inext, 14);
    if ((n == 1 || n == 2) && rng_next(sa, inext, 2) == 0) n = rng_next(sa, inext, 14);
    if (n == 0) n = rng_next(sa, inext, 14);
    if (n == 3 && rng_next(sa, inext, 3) == 0) n = 31;
    if (n == 5 && rng_next(sa, inext, 2) == 0) n = 51;
    if (n == 7 && rng_next(sa, inext, 4) == 0) n = rng_between(sa, inext, 71, 74);
    return n;
}

/* 世界生成里的树和洞穴样式只消耗随机数, 结果不进入地形剖面. */
inline void consume_styles(threadgroup int *sa, threadgroup uint *inext, int maximum) {
    (void)rng_between(sa, inext, 857, 3417);
    (void)rng_between(sa, inext, 2988, 5548);
    int values[3];
    for (int j = 0; j < 3; j++) values[j] = rng_next(sa, inext, maximum);
    while (values[1] == values[0]) values[1] = rng_next(sa, inext, maximum);
    while (values[2] == values[0] || values[2] == values[1]) values[2] = rng_next(sa, inext, maximum);
    if (maximum == 6) {
        for (int j = 0; j < 3; j++) {
            if (values[j] == 0 && rng_next(sa, inext, 3) != 0) values[j] = 4;
        }
    } else {
        (void)rng_next(sa, inext, 4);
        (void)rng_next(sa, inext, 3);
        (void)rng_next(sa, inext, 2);
    }
}

/* 海滩左右边界: 只有这两个值进入地形生成, 其余分支只为保持随机数消耗顺序. */
inline int2 setup_beach(threadgroup int *sa, threadgroup uint *inext, int seed) {
    rng_seed(sa, inext, seed);
    (void)rng_next(sa, inext, 5);
    (void)rng_next(sa, inext, 2);
    (void)rng_between(sa, inext, 10, 200);
    for (int j = 0; j < 100; j++) {
        int value = rng_sample(sa, inext);
        (void)rng_next(sa, inext, 2);
        if (value != 0) break;
    }
    for (int j = 5; j >= 1; j--) (void)rng_next(sa, inext, j);
    (void)rng_between(sa, inext, 172800, 259200);
    (void)rng_between(sa, inext, 8640, 86400);
    for (int j = 0; j < 5; j++) (void)rng_next(sa, inext, 2);
    (void)rng_next(sa, inext, 2147483647);
    consume_styles(sa, inext, 6);
    consume_styles(sa, inext, 8);
    int backgrounds[4];
    backgrounds[0] = roll_random_forest_bg(sa, inext);
    for (int j = 1; j < 4; j++) {
        int v = roll_random_forest_bg(sa, inext);
        while (true) {
            bool repeated = false;
            for (int k = 0; k < j; k++) if (v == backgrounds[k]) repeated = true;
            if (!repeated) break;
            v = roll_random_forest_bg(sa, inext);
        }
        backgrounds[j] = v;
    }
    if (rng_next(sa, inext, 6) == 5) (void)rng_next(sa, inext, 2);
    (void)rng_next(sa, inext, 7);
    int snow = rng_next(sa, inext, 9);
    for (int j = 2; j <= 4; j++) {
        if (snow == j && rng_next(sa, inext, 2) == 0) {
            snow = (rng_next(sa, inext, 2) == 0) ? j * 10 + 1 : j * 10 + 2;
        }
    }
    (void)rng_next(sa, inext, 6);
    (void)rng_next(sa, inext, 7);
    if (rng_next(sa, inext, 6) == 5) (void)rng_next(sa, inext, 5);
    (void)rng_next(sa, inext, 8);
    (void)rng_next(sa, inext, 5);
    (void)rng_next(sa, inext, 3);
    (void)rng_next(sa, inext, 9);
    int side = rng_next(sa, inext, 2);
    (void)rng_between(sa, inext, 15, 30);
    int dungeon = rng_next(sa, inext, 6400);
    int low = (side == 1) ? 3840 : 1600;
    int high = (side == 1) ? 4800 : 2560;
    while (dungeon < low || dungeon > high) dungeon = rng_next(sa, inext, 6400);
    for (int j = 0; j < 2; j++) {
        (void)rng_between(sa, inext, 50, 90);
        (void)rng_between(sa, inext, 20, 40);
        (void)rng_between(sa, inext, 20, 40);
    }
    int left = rng_between(sa, inext, 300, 340) + ((side == 1) ? 40 : 20);
    int right = 6400 - rng_between(sa, inext, 300, 340) - ((side == 1) ? 20 : 40);
    return int2(left, right);
}

inline int surface_offset(threadgroup int *sa, threadgroup uint *inext, int kind) {
    int v = 0;
    if (kind == 0) {
        while (rng_next(sa, inext, 7) == 0) v += rng_between(sa, inext, -1, 2);
        return v;
    }
    bool down = (kind == 1 || kind == 3);
    int first = (kind <= 2) ? 4 : 2;
    int second = (kind <= 2) ? 10 : ((kind == 3) ? 6 : 5);
    while (rng_next(sa, inext, first) == 0) v += down ? -1 : 1;
    while (rng_next(sa, inext, second) == 0) v += down ? 1 : -1;
    return v;
}
)MSL";

/* 剖面内核: 每线程一个种子, 生成到观测窗口末尾, 只写窗口内的列. */
inline constexpr const char* kProfileSource = R"MSL(
    int tid = (int)thread_position_in_grid.x;
    int count = params[1];
    if (tid >= count) return;
    int cols = params[2];
    int w0 = params[3];
    int w1 = params[4];
    int lane = (int)thread_position_in_threadgroup.x;
    threadgroup int state_all[128 * 56];
    threadgroup uint index_all[128];
    threadgroup int *sa = &state_all[lane * 56];
    threadgroup uint *inext = &index_all[lane];

    int seed = params[0] + tid;
    int2 beach = setup_beach(sa, inext, seed);
    rng_seed(sa, inext, seed);
    /* 初始地表高度与 rock 高度, 两者的结果都不影响窗口内的剖面, 只保留消耗次数. */
    (void)rng_between(sa, inext, 90, 110);
    (void)rng_between(sa, inext, 90, 110);

    int surface = 0;
    int remaining = beach.x + 5;
    int feature = 0;
    int width = w1 - w0;
    device int *dst = profiles + (long)tid * width;
    for (int x = 0; x < cols; x++) {
        if (remaining <= 0) {
            feature = rng_next(sa, inext, 5);
            remaining = rng_between(sa, inext, 5, 40);
            if (feature == 0) remaining = remaining * (rng_between(sa, inext, 5, 30) / 5);
        }
        remaining--;
        if (x > 2880 && x < 3520 && (feature == 3 || feature == 4)) feature = rng_next(sa, inext, 3);
        if (x > 3072 && x < 3328) feature = 0;
        surface += surface_offset(sa, inext, feature);
        if (x < beach.x + 5 || x > beach.y - 5) {
            surface = clamp(surface, 306, 414);
        } else if (surface < 306) {
            surface = 306;
            remaining = 0;
        } else if (surface > 468) {
            surface = 468;
            remaining = 0;
        }
        while (rng_next(sa, inext, 3) == 0) (void)rng_between(sa, inext, -2, 3);
        if (x >= w0 && x < w1) dst[x - w0] = surface * 8;
    }
)MSL";

/* 评分内核: 每个种子一个线程组, 组内线程分摊 偏移 x 尺度 组合, 归约出最佳组合.
 * 比较规则必须与 CPU 和 CUDA 一致: 分数相同取更大的组合序号. */
inline constexpr const char* kScoreSource = R"MSL(
    /* MLX 的 grid 是线程总数: 每个种子占一个 64 线程组, 因此按全局线程号取种子序号. */
    int idx = (int)thread_position_in_grid.x >> 6;
    int lane = (int)thread_position_in_threadgroup.x;
    int count = params[1];
    if (idx >= count) return;
    int w0 = params[3];
    int w1 = params[4];
    int width = w1 - w0;
    int obs_n = params[5];
    int nscale = params[6];
    int nbase = params[7];
    int radius = params[8];
    int base_lo = params[9];

    device const int *profile = profiles + (long)idx * width;
    int combos = nbase * nscale;
    uint best = 0;
    uint best_q = 0;
    for (int q = lane; q < combos; q += 64) {
        int b = q / nscale;
        int scale = q - b * nscale;
        int base = base_lo + b;
        device const int *shift = shifts + scale * obs_n;
        int hist[33];
        for (int k = 0; k < 33; k++) hist[k] = 0;
        int first = 0;
        int count_valid = 0;
        bool have = false;
        for (int j = 0; j < obs_n; j++) {
            int height = observed[j];
            if (height == (int)0x80000000u) continue;
            int x = base + shift[j];
            if (x < w0 || x >= w1) continue;
            int d = profile[x - w0] - height;
            if (!have) { first = d; have = true; }
            d -= first;
            if (d >= -16 && d <= 16) hist[d + 16]++;
            count_valid++;
        }
        if (count_valid < 20) continue;
        int accumulated = 0;
        int median = 16;
        for (int k = 0; k < 33; k++) { accumulated += hist[k]; if (accumulated >= count_valid / 2) { median = k; break; } }
        int hits = 0;
        for (int k = max(0, median - radius); k <= min(32, median + radius); k++) hits += hist[k];
        /* 与 WGSL 相同的 32 位写法: 等价于 hits * 10^7 / count_valid, 避开苹果 GPU 上很慢的 64 位除法. */
        uint weighted = (uint)hits * 10000u;
        uint score = (weighted / (uint)count_valid) * 1000u + ((weighted % (uint)count_valid) * 1000u) / (uint)count_valid;
        if (score > best || (score == best && (uint)q > best_q)) { best = score; best_q = (uint)q; }
    }

    threadgroup uint group_score[64];
    threadgroup uint group_order[64];
    group_score[lane] = best;
    group_order[lane] = best_q;
    threadgroup_barrier(mem_flags::mem_threadgroup);
    for (int step = 32; step > 0; step >>= 1) {
        if (lane < step) {
            uint other_score = group_score[lane + step];
            uint other_order = group_order[lane + step];
            if (other_score > group_score[lane] || (other_score == group_score[lane] && other_order > group_order[lane])) {
                group_score[lane] = other_score;
                group_order[lane] = other_order;
            }
        }
        threadgroup_barrier(mem_flags::mem_threadgroup);
    }
    if (lane == 0) {
        best_out[idx * 2] = (int)group_score[0];
        best_out[idx * 2 + 1] = (int)group_order[0];
    }
)MSL";

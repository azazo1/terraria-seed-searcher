/* 泰拉瑞亚世界种子反查: CUDA 版.
 *
 * 与 tools/sweep.c 的算法完全一致 (同一个 UnifiedRandom, 同一个初始化段, 同一个 TerrainPass),
 * 区别是这里不保存整条剖面, 而是"边生成边对齐": 每个线程固定一个横向偏移 (spawn_x - 标记列),
 * 生成到该偏移对应的观测列时立刻比较, 用 7 格直方图在线估计纵向偏移.
 *
 * 编译 (在 WSL 里调用 Windows 侧 nvcc):
 *   "/mnt/c/Program Files/NVIDIA GPU Computing Toolkit/CUDA/v13.4/bin/nvcc.exe" \
 *     -O3 -arch=sm_89 -fmad=false sweep.cu -o sweep.exe
 *
 * 用法: sweep.exe <观测文件> [--scale 1.0] [--cols 3550] [--tol 1.5] [--offer 0.55]
 *                  [--spawn-lo 3160] [--spawn-hi 3240] [--check <seed>]
 */
#include "../search/candidate-file.h"
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <cmath>
#include <vector>
#include <algorithm>
#ifndef TERRARIA_HOST_ONLY
#include <cuda_runtime.h>
#else
#define __device__
#define __host__
#endif

/* 世界尺寸. 默认中世界; 用 -DWORLD_LARGE / -DWORLD_SMALL 编译出对应尺寸的版本 */
#if defined(WORLD_LARGE)
#define W_MEDIUM 8400
#define H_MEDIUM 2400
#elif defined(WORLD_SMALL)
#define W_MEDIUM 4200
#define H_MEDIUM 1200
#else
#define W_MEDIUM 6400
#define H_MEDIUM 1800
#endif
#define INT_MAX_ 2147483647
#define MAX_OBS 700

/* ---------------- UnifiedRandom ---------------- */

/* 状态槽位号按 55 循环确定推进, 所以下一个样本要读的两个槽位可以提前读进寄存器,
 * 让共享内存延迟与当前样本的运算和分支重叠. */
struct RNG { int *sa; unsigned *inext; int preA, preB; unsigned preIdx; };

__device__ __host__ static inline int i32d(long long x) { return (int)(unsigned int)(x & 0xFFFFFFFFu); }

__device__ __host__ static void rng_seed(RNG *r, int seed) {
    for (int i = 0; i < 56; i++) r->sa[i] = 0;
    int num = abs(seed);
    int num2 = i32d(161803398LL - (long long)num);
    r->sa[55] = num2;
    int num3 = 1;
    for (int j = 1; j < 55; j++) {
        int num4 = 21 * j % 55;
        r->sa[num4] = num3;
        num3 = i32d((long long)num2 - num3);
        if (num3 < 0) num3 = i32d((long long)num3 + INT_MAX_);
        num2 = r->sa[num4];
    }
    for (int k = 1; k < 5; k++)
        for (int l = 1; l < 56; l++) {
            r->sa[l] = i32d((long long)r->sa[l] - r->sa[1 + (l + 30) % 55]);
            if (r->sa[l] < 0) r->sa[l] = i32d((long long)r->sa[l] + INT_MAX_);
        }
    *r->inext = 0;
    r->preIdx = 1u;
    r->preA = r->sa[1];
    r->preB = r->sa[22];
}

/* 一次样本. 槽位号只依赖计数, 不依赖取值, 所以可以把下一步要读的两个槽位提前读好.
 * 这只改变读取顺序, 不改变取值; GPU 上让共享内存延迟与当前样本的分支重叠, 实测约 1.2 倍.
 * 主机上同一改动的差异落在测量噪声内, 因此两条路径共用. */
__device__ __host__ static inline int rng_sample(RNG *r) {
    unsigned num = r->preIdx;
    int num3 = i32d((long long)r->preA - r->preB);
    if (num3 == INT_MAX_) num3--;
    num3 = i32d((long long)num3 + ((num3 >> 31) & INT_MAX_));
    unsigned next = num + 1u;
    if (next > 55u) next = 1u;
    unsigned nextB = next + 21u;
    if (nextB > 55u) nextB -= 55u;
    r->preA = r->sa[next];
    r->preB = r->sa[nextB];
    r->sa[num] = num3;
    *r->inext = num;
    r->preIdx = next;
    return num3;
}

__device__ __host__ static inline double rng_sample_d(RNG *r) {
    return (double)rng_sample(r) * 4.656612875245797E-10;
}

/* Next(max) 的原语义是 (int)(Sample() * max), 而 Sample() 的乘数正好是 1/2147483647
 * 的双精度表示, 因此它就是 sample * max / 2147483647 向下取整.
 * 双精度两次舍入的绝对误差不超过 2^-52 * max; 当 max <= 2^20 时该误差 (2.4e-10)
 * 仍小于任何非整数结果到整数的距离 (至少 1/2147483647), 且 2147483647 是质数不会
 * 整除 sample * max, 所以整数除法与双精度式逐位等价.
 * 更大的 max 保留原来的双精度式: 已实测 max = 2147483647 时双精度会少 1. */
#define RNG_INT_MAX 1048576

__device__ __host__ static inline int rng_scaled(unsigned sample, int delta) {
    if (delta <= RNG_INT_MAX) return (int)((unsigned long long)sample * (unsigned)delta / 2147483647ull);
    return (int)((double)sample * 4.656612875245797E-10 * (double)delta);
}

__device__ __host__ static inline int rng_next(RNG *r, int maxValue) {
    return rng_scaled((unsigned)rng_sample(r), maxValue);
}

__device__ __host__ static inline int rng_next2(RNG *r, int minValue, int maxValue) {
    return rng_scaled((unsigned)rng_sample(r), maxValue - minValue) + minValue;
}

/* ---------------- 初始化段 ---------------- */

__device__ __host__ static int roll_random_forest_bg(RNG *r) {
    int n = rng_next(r, 14);
    if ((n == 1 || n == 2) && rng_next(r, 2) == 0) n = rng_next(r, 14);
    if (n == 0) n = rng_next(r, 14);
    if (n == 3 && rng_next(r, 3) == 0) n = 31;
    if (n == 5 && rng_next(r, 2) == 0) n = 51;
    if (n == 7 && rng_next(r, 4) == 0) n = rng_next2(r, 71, 74);
    return n;
}

__device__ __host__ static void randomize_weather(RNG *r) {
    rng_next2(r, 10, 200);
    for (int g = 0; g < 100; g++) {
        double f = rng_sample_d(r);
        double v = f * 0.35 * (double)(rng_next(r, 2) * 2 - 1);
        if (v != 0.0) return;
    }
}

__device__ __host__ static void randomize_tree_style(RNG *r, int w) {
    rng_next2(r, (int)((double)w * 0.334 - (double)w * 0.2), (int)((double)w * 0.334 + (double)w * 0.2));
    rng_next2(r, (int)((double)w * 0.667 - (double)w * 0.2), (int)((double)w * 0.667 + (double)w * 0.2));
    int ts[3];
    for (int i = 0; i < 3; i++) ts[i] = rng_next(r, 6);
    while (ts[1] == ts[0]) ts[1] = rng_next(r, 6);
    while (ts[2] == ts[0] || ts[2] == ts[1]) ts[2] = rng_next(r, 6);
    for (int j = 0; j < 3; j++) if (ts[j] == 0 && rng_next(r, 3) != 0) ts[j] = 4;
}

__device__ __host__ static void randomize_cave_backgrounds(RNG *r, int w) {
    rng_next2(r, (int)((double)w * 0.334 - (double)w * 0.2), (int)((double)w * 0.334 + (double)w * 0.2));
    rng_next2(r, (int)((double)w * 0.667 - (double)w * 0.2), (int)((double)w * 0.667 + (double)w * 0.2));
    int st[3];
    for (int i = 0; i < 3; i++) st[i] = rng_next(r, 8);
    while (st[1] == st[0]) st[1] = rng_next(r, 8);
    while (st[2] == st[0] || st[2] == st[1]) st[2] = rng_next(r, 8);
    rng_next(r, 4); rng_next(r, 3); rng_next(r, 2);     /* 分支之后的公共收尾 */
}

__device__ __host__ static void randomize_backgrounds(RNG *r) {
    int tb[4];
    tb[0] = roll_random_forest_bg(r);
    for (int k = 1; k < 4; k++) {
        int v = roll_random_forest_bg(r);
        while (v == tb[0] || (k > 1 && v == tb[1]) || (k > 2 && v == tb[2])) v = roll_random_forest_bg(r);
        tb[k] = v;
    }
    int corrupt = rng_next(r, 6);
    if (corrupt == 5) rng_next(r, 2);
    rng_next(r, 7);
    int snow = rng_next(r, 9);
    for (int base = 2; base <= 4; base++)
        if (snow == base && rng_next(r, 2) == 0) snow = (rng_next(r, 2) == 0) ? base * 10 + 1 : base * 10 + 2;
    rng_next(r, 6);
    rng_next(r, 7);
    int desert = rng_next(r, 6);
    if (desert == 5) rng_next(r, 5);
    rng_next(r, 8);
    rng_next(r, 5);
    rng_next(r, 3);
}

__device__ __host__ static int setup_beach(RNG *rp, int seed, int w, int *out_right) {
    RNG r = *rp;
    rng_seed(&r, seed);
    *rp = r;
    rng_next(&r, 5);
    rng_next(&r, 2);
    randomize_weather(&r);
    for (int c = 5; c >= 1; c--) rng_next(&r, c);
    rng_next2(&r, 86400 * 2, 86400 * 3);
    rng_next2(&r, 8640, 86400);
    for (int i = 0; i < 4; i++) rng_next(&r, 2);
    rng_next(&r, 2);
    rng_next(&r, INT_MAX_);
    randomize_tree_style(&r, w);
    randomize_cave_backgrounds(&r, w);
    randomize_backgrounds(&r);
    rng_next(&r, 9);
    int dungeon_side = (rng_next(&r, 2) == 0) ? 0 : 1;
    rng_next2(&r, 15, 30);
    int num11 = rng_next(&r, w);
    if (dungeon_side == 1) {
        while (num11 < (int)((double)w * 0.6) || num11 > (int)((double)w * 0.75)) num11 = rng_next(&r, w);
    } else {
        while (num11 < (int)((double)w * 0.25) || num11 > (int)((double)w * 0.4)) num11 = rng_next(&r, w);
    }
    double n13 = (double)w / 4200.0;
    rng_next2(&r, 50, 90);
    (void)((int)((double)rng_next2(&r, 20, 40) * n13));
    (void)((int)((double)rng_next2(&r, 20, 40) * n13));
    rng_next2(&r, 50, 90);
    (void)((int)((double)rng_next2(&r, 20, 40) * n13));
    (void)((int)((double)rng_next2(&r, 20, 40) * n13));
    int left = rng_next2(&r, 300, 340) + (dungeon_side == 1 ? 40 : 20);
    int right = w - rng_next2(&r, 300, 340) - (dungeon_side == 0 ? 40 : 20);
    *out_right = right;
    *rp = r;
    return left;
}

/* ---------------- TerrainPass ---------------- */

/* next(k) == 0 等价于 sample * k < 2^31 - 1, 也就是 sample <= (2^31 - 2) / k.
 * 这里的 k 全是编译期常量, 阈值被折叠成一条整数比较, 省掉一次乘法与常数除法. */
__device__ __host__ static inline bool rng_zero(RNG *r, int k) {
    return (unsigned)rng_sample(r) <= (unsigned)(2147483646u / (unsigned)k);
}

/* 坡度增量始终是整数, 用 int 累加后一次性并入地表高度, 结果逐位不变. */
__device__ __host__ static int surface_offset(RNG *r, int feature) {
    int num = 0;
    switch (feature) {
        case 0: while (rng_zero(r, 7)) num += rng_next2(r, -1, 2); break;
        case 1: while (rng_zero(r, 4)) num -= 1; while (rng_zero(r, 10)) num += 1; break;
        case 2: while (rng_zero(r, 4)) num += 1; while (rng_zero(r, 10)) num -= 1; break;
        case 3: while (rng_zero(r, 2)) num -= 1; while (rng_zero(r, 6)) num += 1; break;
        default: while (rng_zero(r, 2)) num += 1; while (rng_zero(r, 5)) num -= 1; break;
    }
    return num;
}

/* 边生成边与观测对齐. 每个线程只处理一个横向偏移 base.
 * shift[j] = round(j / scale), 也就是观测第 j 列对应的相对格偏移.
 * 返回命中率; 命中数写入 *hits, 有效列数写入 *cnt. */
__device__ __host__ static double stream_score(RNG *rp, int seed, int left, int right, int cols, int base,
                                     const double *obs, const unsigned char *valid, const int *shift,
                                     int obs_n, double tol, int *hits_out, int *cnt_out) {
    RNG r = *rp;
    rng_seed(&r, seed);
    double num2 = (double)H_MEDIUM * 0.3;
    num2 *= (double)rng_next2(&r, 90, 110) * 0.005;
    double num3 = num2 + (double)H_MEDIUM * 0.2;
    num3 *= (double)rng_next2(&r, 90, 110) * 0.01;
    double num8 = (double)H_MEDIUM * 0.23;
    int num9 = left + 5;
    int feature = 0;
    int hist[7] = {0, 0, 0, 0, 0, 0, 0};
    int off = 0;
    bool have_off = false;
    int cnt = 0;
    int j = 0;                     /* 观测列游标 */
    /* 先把 base + shift[0] 之前的列推进 (shift 单调不减) */
    for (int i = 0; i < cols; i++) {
        if (num9 <= 0) {
            feature = rng_next2(&r, 0, 5);
            num9 = rng_next2(&r, 5, 40);
            if (feature == 0) num9 *= (int)((double)rng_next2(&r, 5, 30) * 0.2);
        }
        num9--;
        if ((double)i > (double)W_MEDIUM * 0.45 && (double)i < (double)W_MEDIUM * 0.55 && (feature == 3 || feature == 4))
            feature = rng_next(&r, 3);
        if ((double)i > (double)W_MEDIUM * 0.48 && (double)i < (double)W_MEDIUM * 0.52) feature = 0;
        num2 += surface_offset(&r, feature);
        double num10 = 0.17, num11 = 0.26;
        if (i < left + 5 || i > right - 5) {
            if (num2 < (double)H_MEDIUM * num10) num2 = (double)H_MEDIUM * num10;
            else if (num2 > num8) num2 = num8;
        } else if (num2 < (double)H_MEDIUM * num10) {
            num2 = (double)H_MEDIUM * num10; num9 = 0;
        } else if (num2 > (double)H_MEDIUM * num11) {
            num2 = (double)H_MEDIUM * num11; num9 = 0;
        }
        while (rng_next(&r, 3) == 0) num3 += (double)rng_next2(&r, -2, 3);
        if (num3 < num2 + (double)H_MEDIUM * 0.06) num3 += 1.0;
        if (num3 > num2 + (double)H_MEDIUM * 0.35) num3 -= 1.0;

        int tile = (int)num2;
        /* 该列是否落在窗口内 */
        while (j < obs_n && base + shift[j] < i) j++;
        if (j < obs_n && base + shift[j] == i && valid[j]) {
            if (!have_off) { off = tile - (int)obs[j]; have_off = true; }
            int d = (tile - (int)obs[j]) - off;
            if (d >= -3 && d <= 3) hist[d + 3]++;
            cnt++;
        }
    }
    int best = 0;
    for (int k = 0; k < 7; k++) {
        int s = hist[k];
        if (k > 0) s += hist[k - 1];
        if (k < 6) s += hist[k + 1];
        if (s > best) best = s;
    }
    *hits_out = best;
    *cnt_out = cnt;
    *rp = r;
    return cnt > 0 ? (double)best / (double)cnt : -1.0;
}

/* ================= 新版 GPU 扫描: 剖面只算一次 =================
 *
 * 旧版的瓶颈: 每个横向偏移一个 kernel, 每个种子被完整重新模拟 81 次.
 * 新版拆成两个 kernel:
 *   A) profile_kernel: 每个种子模拟一次, 把需要的列窗口 [w0, w1) 写进全局缓冲.
 *      该窗口覆盖所有偏移与尺度需要的列 (偏移范围宽 + 最大尺度映射).
 *   B) score_kernel: 每个种子一个 block, 剖面先拷进共享内存, 再由 256 个线程
 *      并行处理 偏移数 x 尺度数 个组合, 每个组合算一个命中率, 用 atomicMax 归并到
 *      每种子一个"最佳组合"。
 * 这样模拟只做一次, 且 B 的并行度是 种子数 x 243。
 */

/* 主机 CPU 与 CUDA 共用逐列生成逻辑, 保持随机数消费顺序一致. */
__device__ __host__ static void generate_profile(RNG *rp, int seed, int cols, int w0, int w1, int *dst) {
    int right;
    int left = setup_beach(rp, seed, W_MEDIUM, &right);
    rng_seed(rp, seed);
    /* 初始地表高度与 rock 高度都不进入输出, 只保留随机数消耗.
     * 地表改用 1/8 格整数: 首列必被限制到 306, 之后增量都是整数, 因此整数累加精确. */
    (void)rng_next2(rp, 90, 110);
    (void)rng_next2(rp, 90, 110);
    int surface = 0;
    int remaining = left + 5, feature = 0;
    /* 窗口右侧之后的地形不会写入输出, 也不会再被读取, 无需继续推进. */
    int end = w1 < cols ? w1 : cols;
    for (int x = 0; x < end; x++) {
        if (remaining <= 0) {
            feature = rng_next2(rp, 0, 5);
            remaining = rng_next2(rp, 5, 40);
            if (feature == 0) remaining *= (int)((double)rng_next2(rp, 5, 30) * 0.2);
        }
        remaining--;
        /* 6400 * 0.55 的双精度舍入略大于 3520, 所以原条件实际包含 x = 3520, 这里保留该边界. */
        if (x > 2880 && x <= 3520 && (feature == 3 || feature == 4)) feature = rng_next(rp, 3);
        if (x > 3072 && x < 3328) feature = 0;
        surface += surface_offset(rp, feature) * 8;
        if (x < left + 5 || x > right - 5) {
            if (surface < 306 * 8) surface = 306 * 8;
            else if (surface > 414 * 8) surface = 414 * 8;
        } else if (surface < 306 * 8) { surface = 306 * 8; remaining = 0; }
        else if (surface > 468 * 8) { surface = 468 * 8; remaining = 0; }
        while (rng_zero(rp, 3)) (void)rng_next2(rp, -2, 3);
        if (x >= w0 && x < w1) dst[x - w0] = surface;
    }
}

#ifndef TERRARIA_HOST_ONLY
struct Args2 {
    const int *obs8;          /* 观测高度, 单位 1/8 格 */
    const unsigned char *valid;
    const int *shift3;        /* 3 个尺度, 布局 [s * obs_n + j] */
    int obs_n;
    int scale_n;
    int cols;
    int w0, w1;               /* 剖面窗口 */
    int base_lo, nbase;
    int seed_from, seed_to;   /* 本批种子区间 */
    double tol, offer;
    int *prof;                /* batch x (w1 - w0) */
    unsigned long long *best; /* 每种子一个打包结果 */
};

/* 每线程一个种子, 模拟一次, 把窗口内的列写出去 */
__global__ void profile_kernel(Args2 a) {
    extern __shared__ int smem[];
    int *sa = smem + threadIdx.x * 56;
    unsigned *inext = (unsigned *)(smem + blockDim.x * 56) + threadIdx.x;
    for (int i = 0; i < 56; i++) sa[i] = 0;
    *inext = 0;
    RNG rng = { sa, inext };
    int nthis = a.seed_to - a.seed_from;
    int W = a.w1 - a.w0;
    int stride = gridDim.x * blockDim.x;
    for (int idx = blockIdx.x * blockDim.x + threadIdx.x; idx < nthis; idx += stride) {
        int seed = a.seed_from + idx;
        generate_profile(&rng, seed, a.cols, a.w0, a.w1, a.prof + (long long)idx * W);
    }
}

/* 每个种子一个 block: 共享内存里放剖面, 线程分摊 偏移 x 尺度 组合 */
__global__ void score_kernel(Args2 a) {
    extern __shared__ int sp[];
    int idx = blockIdx.x;
    if (idx >= a.seed_to - a.seed_from) return;
    int W = a.w1 - a.w0;
    const int *src = a.prof + (long long)idx * W;
    for (int t = threadIdx.x; t < W; t += blockDim.x) sp[t] = src[t];
    __syncthreads();
    int nb = a.nbase * a.scale_n;
    for (int q = threadIdx.x; q < nb; q += blockDim.x) {
        int b = q / a.scale_n;
        int s = q - b * a.scale_n;
        int base = a.base_lo + b;
        const int *sh = a.shift3 + s * a.obs_n;
        int hist[33];                       /* 偏移 d 在 [-16, 16] 的整数分布 */
        for (int k = 0; k < 33; k++) hist[k] = 0;
        int off = 0, cnt = 0;
        bool have = false;
        for (int j = 0; j < a.obs_n; j++) {
            if (!a.valid[j]) continue;
            int k = base + sh[j] - a.w0;
            if (k < 0 || k >= W) continue;
            int d = sp[k] - a.obs8[j];
            if (!have) { off = d; have = true; }
            d -= off;
            if (d >= -16 && d <= 16) hist[d + 16]++;
            cnt++;
        }
        if (cnt < 20) continue;   /* 有效列下限. 主画面观测只有 74 列有效, 不能沿用 658 列时代的 200 */
        /* 取中位数所在的箱: 与 CPU 端和 Python 复核的中位偏移语义一致.
         * 取最大箱 (众数) 会让选出的候选与复核口径完全不同。 */
        int half = cnt / 2, acc = 0, med = 16;
        for (int k = 0; k < 33; k++) { acc += hist[k]; if (acc >= half) { med = k; break; } }
        /* 用相同的 1/8 格观测单位解释容差, 与 CPU 和 WebGPU 一致. */
        int hit = 0, radius = (int)(a.tol * 8.0 + 1e-6);
        for (int k = med - radius; k <= med + radius; k++) if (k >= 0 && k < 33) hit += hist[k];
        unsigned qq = (unsigned)((unsigned long long)hit * 10000000ull / (unsigned)cnt);
        unsigned long long packed = ((unsigned long long)qq << 32) | (unsigned long long)(unsigned)q;
        atomicMax(&a.best[idx], packed);
    }
}

/* ---------------- host ---------------- */

static int load_obs(const char *path, double *obs, unsigned char *valid, int *n) {
    FILE *f = fopen(path, "r");
    if (!f) { perror(path); return -1; }
    double v; int i = 0;
    while (i < MAX_OBS && fscanf(f, "%lf", &v) == 1) {
        if (v < -900.0) { obs[i] = 0; valid[i] = 0; }
        else { obs[i] = v; valid[i] = 1; }
        i++;
    }
    fclose(f);
    *n = i;
    return 0;
}

int main(int argc, char **argv) {
    if (argc < 2) { fprintf(stderr, "用法: sweep2.exe <观测文件> [选项]\n"); return 1; }
    double h_obs[MAX_OBS]; unsigned char h_valid[MAX_OBS]; int obs_n = 0;
    if (load_obs(argv[1], h_obs, h_valid, &obs_n) < 0) return 1;

    double tol = 0.5, offer = 0.20;
    int cols = 3550, spawn_lo = 3160, spawn_hi = 3240, marker = 471, check = -1;
    long long from = 0, to = 2147483647LL;
    int batch = 400000, device = 0;
    double scales[8] = {1.00, 0.97, 1.03};
    int nscale = 3;
    for (int i = 2; i < argc; i++) {
        if (!strcmp(argv[i], "--tol") && i + 1 < argc) tol = atof(argv[++i]);
        else if (!strcmp(argv[i], "--offer") && i + 1 < argc) offer = atof(argv[++i]);
        else if (!strcmp(argv[i], "--cols") && i + 1 < argc) cols = atoi(argv[++i]);
        else if (!strcmp(argv[i], "--spawn-lo") && i + 1 < argc) spawn_lo = atoi(argv[++i]);
        else if (!strcmp(argv[i], "--spawn-hi") && i + 1 < argc) spawn_hi = atoi(argv[++i]);
        else if (!strcmp(argv[i], "--marker") && i + 1 < argc) marker = atoi(argv[++i]);
        else if (!strcmp(argv[i], "--range") && i + 2 < argc) { from = atoll(argv[++i]); to = atoll(argv[++i]); }
        else if (!strcmp(argv[i], "--batch") && i + 1 < argc) batch = atoi(argv[++i]);
        else if (!strcmp(argv[i], "--device") && i + 1 < argc) device = atoi(argv[++i]);
        else if (!strcmp(argv[i], "--check") && i + 1 < argc) check = atoi(argv[++i]);
        else if (!strcmp(argv[i], "--scale") && i + 1 < argc) { scales[0] = atof(argv[++i]); nscale = 1; }
        else if (!strcmp(argv[i], "--scales") && i + 1 < argc) {
            nscale = 0;
            for (char *tok = strtok(argv[++i], ","); tok && nscale < 8; tok = strtok(NULL, ","))
                scales[nscale++] = atof(tok);
        }
    }
    cudaSetDevice(device);

    /* 多尺度映射表; 与 CPU 版一致: shift[j] = round(j * scale) */
    int shift3[8 * MAX_OBS];
    for (int s = 0; s < nscale; s++)
        for (int j = 0; j < obs_n; j++)
            shift3[s * obs_n + j] = (int)((double)j * scales[s] + 0.5);

    if (check >= 0) {
        int hsa[56]; unsigned hinext = 0; RNG hrng = { hsa, &hinext }; rng_seed(&hrng, check);
        int right; int left = setup_beach(&hrng, check, W_MEDIUM, &right);
        printf("seed %d leftBeachEnd %d rightBeachStart %d\n", check, left, right);
        int shift[MAX_OBS];
        for (int j = 0; j < obs_n; j++) shift[j] = (int)((double)j * scales[0] + 0.5);
        double best = -1; int best_base = 0;
        for (int sx = spawn_lo; sx <= spawn_hi; sx++) {
            int hits, cnt;
            rng_seed(&hrng, check);
            double sc = stream_score(&hrng, check, left, right, cols, sx - marker, h_obs, h_valid, shift, obs_n, tol, &hits, &cnt);
            if (sc > best) { best = sc; best_base = sx; }
        }
        printf("最佳对齐 spawn_x=%d 得分 %.4f\n", best_base, best);
        return 0;
    }

    int nbase = spawn_hi - spawn_lo + 1;
    int base_lo = spawn_lo - marker;
    int shift_max = 0;
    for (int s = 0; s < nscale; s++) {
        int v = shift3[s * obs_n + obs_n - 1];
        if (v > shift_max) shift_max = v;
    }
    int w0 = base_lo;
    int w1 = base_lo + (nbase - 1) + shift_max + 1;
    if (w0 < 0) w0 = 0;
    if (w1 > cols) w1 = cols;
    int W = w1 - w0;
    printf("剖面窗口 [%d, %d) 共 %d 列; 偏移 %d 个, 尺度 %d 个\n", w0, w1, W, nbase, nscale);
    printf("扫描 %lld..%lld, 容差 %.2f, 阈值 %.3f, 批大小 %d, GPU %d\n",
           from, to, tol, offer, batch, device);
    fflush(stdout);

    cudaDeviceProp prop; cudaGetDeviceProperties(&prop, device);
    printf("GPU: %s, SM %d, 显存 %.1f GB\n", prop.name, prop.multiProcessorCount, prop.totalGlobalMem / 1073741824.0);
    fflush(stdout);

    int h_obs8[MAX_OBS];
    for (int i = 0; i < obs_n; i++) h_obs8[i] = h_valid[i] ? (int)(h_obs[i] * 8.0 + (h_obs[i] >= 0 ? 0.5 : -0.5)) : 0;
    int *d_obs; unsigned char *d_valid; int *d_shift3;
    cudaMalloc(&d_obs, sizeof(int) * obs_n);
    cudaMalloc(&d_valid, obs_n);
    cudaMalloc(&d_shift3, sizeof(int) * 8 * obs_n);
    cudaMemcpy(d_obs, h_obs8, sizeof(int) * obs_n, cudaMemcpyHostToDevice);
    cudaMemcpy(d_valid, h_valid, obs_n, cudaMemcpyHostToDevice);
    cudaMemcpy(d_shift3, shift3, sizeof(int) * 8 * obs_n, cudaMemcpyHostToDevice);

    int *d_prof; unsigned long long *d_best;
    cudaMalloc(&d_prof, sizeof(int) * (size_t)batch * W);
    cudaMalloc(&d_best, sizeof(unsigned long long) * batch);

    const int MAX_OUT = 500000;   /* 按当前密度全空间约 12.6 万条, 留足余量 */
    std::vector<int> h_seed, h_base, h_scale;
    std::vector<float> h_score;
    std::vector<int> live_order;
    auto save_candidates = [&](const std::vector<int>& order) {
        return save_candidate_file("candidates_gpu2.txt", [&](std::ostream& output) {
            for (int k : order) output << "seed=" << h_seed[k] << " spawn_x=" << h_base[k] + marker << " scale=" << scales[h_scale[k]] << " score=" << h_score[k] << '\n';
        });
    };
    if (!save_candidates(live_order)) { fprintf(stderr, "cannot initialize candidates_gpu2.txt\n"); return 1; }

    unsigned long long *h_best = (unsigned long long *)malloc(sizeof(unsigned long long) * batch);
    int threads = 128;
    size_t shmem_a = (size_t)threads * (56 * sizeof(int) + sizeof(unsigned));
    size_t shmem_b = (size_t)W * sizeof(int);
    if (shmem_b > 48 * 1024) {                       /* 需要时显式提高上限 */
        cudaFuncSetAttribute(score_kernel, cudaFuncAttributeMaxDynamicSharedMemorySize, (int)shmem_b);
    }
    printf("kernel A 共享内存 %zu B, kernel B 共享内存 %zu B\n", shmem_a, shmem_b);
    fflush(stdout);

    long long total = to - from;
    for (long long start = from; start < to; start += batch) {
        int nthis = (int)((to - start < batch) ? (to - start) : batch);
        Args2 a;
        a.obs8 = d_obs; a.valid = d_valid; a.shift3 = d_shift3; a.obs_n = obs_n;
        a.scale_n = nscale; a.cols = cols; a.w0 = w0; a.w1 = w1;
        a.base_lo = base_lo; a.nbase = nbase;
        a.seed_from = (int)start; a.seed_to = (int)(start + nthis);
        a.tol = tol; a.offer = offer;
        a.prof = d_prof; a.best = d_best;

        cudaMemset(d_best, 0, sizeof(unsigned long long) * nthis);
        int blocks_a = prop.multiProcessorCount * 12;
        profile_kernel<<<blocks_a, threads, shmem_a>>>(a);
        cudaError_t err = cudaGetLastError();
        if (err != cudaSuccess) { printf("kernel A 启动失败: %s\n", cudaGetErrorString(err)); return 1; }
        score_kernel<<<nthis, 256, shmem_b>>>(a);
        err = cudaGetLastError();
        if (err != cudaSuccess) { printf("kernel B 启动失败: %s\n", cudaGetErrorString(err)); return 1; }
        err = cudaDeviceSynchronize();
        if (err != cudaSuccess) { printf("内核错误: %s\n", cudaGetErrorString(err)); return 1; }

        cudaMemcpy(h_best, d_best, sizeof(unsigned long long) * nthis, cudaMemcpyDeviceToHost);
        /* 每批只保留得分最高的 KEEP_PER_BATCH 条.
         * 之前是"发现顺序取前 MAX_OUT 条", 在短窗口观测下假候选会瞬间打满上限,
         * 导致后面出现的高分种子被丢掉. */
        std::vector<int> ord;
        ord.reserve(4096);
        for (int i = 0; i < nthis; i++) {
            if (!h_best[i]) continue;
            double sc = (double)(h_best[i] >> 32) / 10000000.0;
            if (sc < offer) continue;
            ord.push_back(i);
        }
        const int KEEP_PER_BATCH = 100;
        if ((int)ord.size() > KEEP_PER_BATCH) {
            std::partial_sort(ord.begin(), ord.begin() + KEEP_PER_BATCH, ord.end(),
                              [&](int x, int y) { return h_best[x] > h_best[y]; });
            ord.resize(KEEP_PER_BATCH);
        } else {
            std::sort(ord.begin(), ord.end(), [&](int x, int y) { return h_best[x] > h_best[y]; });
        }
        for (int i : ord) {
            int q = (int)(h_best[i] & 0xffffffffu);
            if ((int)h_seed.size() < MAX_OUT) {
                live_order.push_back((int)h_seed.size());
                h_seed.push_back(a.seed_from + i);
                h_base.push_back(base_lo + q / nscale);
                h_scale.push_back(q % nscale);
                h_score.push_back((float)((double)(h_best[i] >> 32) / 10000000.0));
            }
        }
        // 运行时只发布最高分的 2000 条, 每批最多合并 100 条新记录.
        std::sort(live_order.begin(), live_order.end(), [&](int x, int y) { return h_score[x] > h_score[y] || (h_score[x] == h_score[y] && h_seed[x] < h_seed[y]); });
        if (live_order.size() > 2000) live_order.resize(2000);
        if (!save_candidates(live_order)) { fprintf(stderr, "cannot save candidates_gpu2.txt\n"); return 1; }
        printf("  批 %lld..%lld 完成, 本批达标 %zu 条, 累计候选 %zu, 进度 %.3f%%\n",
               start, start + nthis, ord.size(), h_seed.size(),
               100.0 * (start + nthis - from) / (double)total);
        fflush(stdout);
    }

    /* 结果排序输出 (全部在主机侧) */
    int count = (int)h_seed.size();
    std::vector<int> order(count);
    for (int i = 0; i < count; i++) order[i] = i;
    std::sort(order.begin(), order.end(), [&](int x, int y) { return h_score[x] > h_score[y]; });
    printf("候选 %d 个, 前 40:\n", count);
    for (int i = 0; i < count && i < 40; i++) {
        int k = order[i];
        printf("  seed=%d spawn_x=%d scale=%.2f score=%.4f\n",
               h_seed[k], h_base[k] + marker, scales[h_scale[k]], h_score[k]);
    }
    if (!save_candidates(order)) { fprintf(stderr, "cannot save candidates_gpu2.txt\n"); return 1; }
    return 0;
}
#endif // TERRARIA_HOST_ONLY

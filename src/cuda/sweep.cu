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
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <cmath>
#include <vector>
#include <algorithm>
#include <cuda_runtime.h>

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

struct RNG { int *sa; unsigned *inext; };

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
}

__device__ __host__ static inline int rng_sample(RNG *r) {
    unsigned num = *r->inext + 1u;
    if (num > 55u) num = 1u;
    unsigned num2 = num + 21u;
    if (num2 > 55u) num2 -= 55u;
    int num3 = i32d((long long)r->sa[num] - r->sa[num2]);
    if (num3 == INT_MAX_) num3--;
    num3 = i32d((long long)num3 + ((num3 >> 31) & INT_MAX_));
    r->sa[num] = num3;
    *r->inext = num;
    return num3;
}

__device__ __host__ static inline double rng_sample_d(RNG *r) {
    return (double)rng_sample(r) * 4.656612875245797E-10;
}

__device__ __host__ static inline int rng_next(RNG *r, int maxValue) {
    return (int)(rng_sample_d(r) * (double)maxValue);
}

__device__ __host__ static inline int rng_next2(RNG *r, int minValue, int maxValue) {
    return (int)(rng_sample_d(r) * (double)((long long)maxValue - minValue)) + minValue;
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

__device__ __host__ static double surface_offset(RNG *r, int feature) {
    double num = 0.0;
    switch (feature) {
        case 0: while (rng_next(r, 7) == 0) num += rng_next2(r, -1, 2); break;
        case 1: while (rng_next(r, 4) == 0) num -= 1.0; while (rng_next(r, 10) == 0) num += 1.0; break;
        case 2: while (rng_next(r, 4) == 0) num += 1.0; while (rng_next(r, 10) == 0) num -= 1.0; break;
        case 3: while (rng_next(r, 2) == 0) num -= 1.0; while (rng_next(r, 6) == 0) num += 1.0; break;
        default: while (rng_next(r, 2) == 0) num += 1.0; while (rng_next(r, 5) == 0) num -= 1.0; break;
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

/* ---------------- kernel ---------------- */

struct Args {
    const double *obs;
    const unsigned char *valid;
    const int *shift;
    int obs_n;
    int cols;
    int base;              /* 该 block 使用的横向偏移 */
    int seed_from, seed_to;
    double tol, offer;
    int *out_seed, *out_base;
    float *out_score;
    int *out_count;
    int max_out;
    float *dbg;          /* 调试: 前 dbg_n 个种子的 得分/命中/有效列 */
    int dbg_n;
};

__global__ void sweep_kernel(Args a) {
    extern __shared__ int smem[];
    int *sa = smem + threadIdx.x * 56;
    unsigned *inext = (unsigned *)(smem + blockDim.x * 56) + threadIdx.x;
    for (int i = 0; i < 56; i++) sa[i] = 0;
    *inext = 0;
    RNG rng = { sa, inext };
    int seed = a.seed_from + blockIdx.x * blockDim.x + threadIdx.x;
    int stride = gridDim.x * blockDim.x;
    for (; seed < a.seed_to; seed += stride) {
        if (a.dbg && seed < a.seed_from + a.dbg_n) {
            int k = (seed - a.seed_from) * 6;
            a.dbg[k + 5] = -777.0f;            /* 入口标记 */
        }
        int right;
        int left = setup_beach(&rng, seed, W_MEDIUM, &right);
        int hits = 0, cnt = 0;
        double sc = stream_score(&rng, seed, left, right, a.cols, a.base, a.obs, a.valid, a.shift,
                                 a.obs_n, a.tol, &hits, &cnt);
        if (a.dbg && seed < a.seed_from + a.dbg_n) {
            int k = (seed - a.seed_from) * 6;
            a.dbg[k] = (float)sc; a.dbg[k + 1] = (float)hits; a.dbg[k + 2] = (float)cnt;
            a.dbg[k + 3] = (float)left; a.dbg[k + 4] = (float)right;
        }
        if (sc >= a.offer && cnt >= 200) {
            int slot = atomicAdd(a.out_count, 1);
            if (slot < a.max_out) {
                a.out_seed[slot] = seed;
                a.out_base[slot] = a.base;
                a.out_score[slot] = (float)sc;
            }
        }
    }
}

/* 随机数转储内核: 每个线程把自己的前 N 个 InternalSample 与若干 Next 结果写出来 */
__global__ void rng_dump_kernel(int seed0, int n, int per_seed, int *out) {
    int t = blockIdx.x * blockDim.x + threadIdx.x;
    if (t >= n) return;
    int sa[56]; unsigned inext = 0;
    RNG r = { sa, &inext };
    rng_seed(&r, seed0 + t);
    int *o = out + t * per_seed;
    for (int k = 0; k < 12; k++) o[k] = rng_sample(&r);
    o[12] = rng_next(&r, 14);
    o[13] = rng_next2(&r, 90, 110);
    o[14] = rng_next2(&r, 100, 200);
    o[15] = rng_next2(&r, -1, 2);
    o[16] = rng_next(&r, 7);
    o[17] = rng_next2(&r, 20, 40);
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
    if (argc < 2) { fprintf(stderr, "用法: sweep.exe <观测文件> [选项]\n"); return 1; }
    double h_obs[MAX_OBS]; unsigned char h_valid[MAX_OBS]; int obs_n = 0;
    if (load_obs(argv[1], h_obs, h_valid, &obs_n) < 0) return 1;

    double scale = 1.0, tol = 1.5, offer = 0.55;
    int cols = 3550, spawn_lo = 3160, spawn_hi = 3240, marker = 471, check = -1, debug = 0;
    long long from = 0, to = 2147483647LL;
    for (int i = 2; i < argc; i++) {
        if (!strcmp(argv[i], "--scale") && i + 1 < argc) scale = atof(argv[++i]);
        else if (!strcmp(argv[i], "--tol") && i + 1 < argc) tol = atof(argv[++i]);
        else if (!strcmp(argv[i], "--offer") && i + 1 < argc) offer = atof(argv[++i]);
        else if (!strcmp(argv[i], "--cols") && i + 1 < argc) cols = atoi(argv[++i]);
        else if (!strcmp(argv[i], "--spawn-lo") && i + 1 < argc) spawn_lo = atoi(argv[++i]);
        else if (!strcmp(argv[i], "--spawn-hi") && i + 1 < argc) spawn_hi = atoi(argv[++i]);
        else if (!strcmp(argv[i], "--marker") && i + 1 < argc) marker = atoi(argv[++i]);
        else if (!strcmp(argv[i], "--range") && i + 2 < argc) { from = atoll(argv[++i]); to = atoll(argv[++i]); }
        else if (!strcmp(argv[i], "--check") && i + 1 < argc) check = atoi(argv[++i]);
        else if (!strcmp(argv[i], "--debug") && i + 1 < argc) debug = atoi(argv[++i]);
    }

    int shift[MAX_OBS];
    for (int j = 0; j < obs_n; j++) shift[j] = (int)((double)j / scale + 0.5);

    if (debug == -1) {   /* --rngdump: 借用 --debug -1 触发 */
        int per = 18, n = 2;
        int *d_out; cudaMalloc(&d_out, sizeof(int) * n * per);
        rng_dump_kernel<<<1, n>>>(123456, n, per, d_out);
        cudaError_t e = cudaGetLastError();
        if (e != cudaSuccess) { printf("rngdump 启动失败: %s\n", cudaGetErrorString(e)); return 1; }
        cudaDeviceSynchronize();
        int *h_out = (int *)malloc(sizeof(int) * n * per);
        cudaMemcpy(h_out, d_out, sizeof(int) * n * per, cudaMemcpyDeviceToHost);
        printf("设备端前 %d 个 InternalSample:\n", per);
        for (int i = 0; i < n; i++) {
            printf("  seed=%d:", 123456 + i);
            for (int k = 0; k < per; k++) printf(" %d", h_out[i * per + k]);
            printf("\n");
        }
        return 0;
    }
    if (check >= 0) {
        int hsa[56]; unsigned hinext = 0; RNG hrng = { hsa, &hinext }; rng_seed(&hrng, check);
        int right; int left = setup_beach(&hrng, check, W_MEDIUM, &right);
        printf("seed %d leftBeachEnd %d rightBeachStart %d\n", check, left, right);
        /* 逐点对照: 直接打印 base=marker 参考下的前若干列 */
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
    printf("扫描 %lld..%lld, 尺度 %.3f, 观测列 %d, spawn 范围 %d..%d, 候选 %d 个偏移, 阈值 %.3f\n",
           from, to, scale, obs_n, spawn_lo, spawn_hi, nbase, offer);
    fflush(stdout);

    double *d_obs; unsigned char *d_valid; int *d_shift;
    cudaMalloc(&d_obs, sizeof(double) * obs_n);
    cudaMalloc(&d_valid, obs_n);
    cudaMalloc(&d_shift, sizeof(int) * obs_n);
    cudaMemcpy(d_obs, h_obs, sizeof(double) * obs_n, cudaMemcpyHostToDevice);
    cudaMemcpy(d_valid, h_valid, obs_n, cudaMemcpyHostToDevice);
    cudaMemcpy(d_shift, shift, sizeof(int) * obs_n, cudaMemcpyHostToDevice);

    const int MAX_OUT = 4096;
    int *d_seed, *d_base, *d_count; float *d_score;
    cudaMalloc(&d_seed, sizeof(int) * MAX_OUT);
    cudaMalloc(&d_base, sizeof(int) * MAX_OUT);
    cudaMalloc(&d_score, sizeof(float) * MAX_OUT);
    cudaMalloc(&d_count, sizeof(int));
    cudaMemset(d_count, 0, sizeof(int));

    cudaDeviceProp prop; cudaGetDeviceProperties(&prop, 0);
    printf("GPU: %s, SM %d, 显存 %.1f GB\n", prop.name, prop.multiProcessorCount, prop.totalGlobalMem / 1073741824.0);
    fflush(stdout);

    float *d_dbg = NULL; float *h_dbg = NULL;
    if (debug > 0) {
        cudaMalloc(&d_dbg, sizeof(float) * 6 * debug);
        cudaMemset(d_dbg, 0, sizeof(float) * 6 * debug);
        h_dbg = (float *)malloc(sizeof(float) * 6 * debug);
    }

    /* 每个 base 一个 grid, 串行启动, 每个 grid 内用满 GPU */
    for (int b = 0; b < nbase; b++) {
        Args a;
        a.obs = d_obs; a.valid = d_valid; a.shift = d_shift; a.obs_n = obs_n; a.cols = cols;
        a.base = (spawn_lo + b) - marker;
        a.seed_from = 0; a.seed_to = (int)to;
        a.tol = tol; a.offer = offer;
        a.out_seed = d_seed; a.out_base = d_base; a.out_score = d_score; a.out_count = d_count;
        a.max_out = MAX_OUT;
        a.dbg = d_dbg; a.dbg_n = debug;
        int threads = 128;                     /* 128 * 228B = 29KB, 在默认 48KB 之内 */
        int blocks = prop.multiProcessorCount * 12;
        size_t shmem = (size_t)threads * (56 * sizeof(int) + sizeof(unsigned));
        sweep_kernel<<<blocks, threads, shmem>>>(a);
        cudaError_t err = cudaGetLastError();  /* 启动错误必须单独查 */
        if (err == cudaSuccess) err = cudaDeviceSynchronize();
        if (err != cudaSuccess) { printf("内核错误: %s\n", cudaGetErrorString(err)); return 1; }
        if (b % 10 == 0) { printf("  已完成偏移 %d/%d\n", b + 1, nbase); fflush(stdout); }
    }

    if (debug > 0 && h_dbg) {
        cudaMemcpy(h_dbg, d_dbg, sizeof(float) * 6 * debug, cudaMemcpyDeviceToHost);
        printf("调试: 前 %d 个种子 (sc, hits, cnt, left, right, 入口标记):\n", debug);
        for (int i = 0; i < debug; i++)
            printf("  seed=%lld  sc=%.4f hits=%.0f cnt=%.0f left=%.0f right=%.0f mark=%.0f\n",
                   from + i, h_dbg[i * 6], h_dbg[i * 6 + 1], h_dbg[i * 6 + 2],
                   h_dbg[i * 6 + 3], h_dbg[i * 6 + 4], h_dbg[i * 6 + 5]);
    }
    int count = 0;
    cudaMemcpy(&count, d_count, sizeof(int), cudaMemcpyDeviceToHost);
    if (count > MAX_OUT) count = MAX_OUT;
    std::vector<int> seeds(count), bases(count);
    std::vector<float> scores(count);
    cudaMemcpy(seeds.data(), d_seed, sizeof(int) * count, cudaMemcpyDeviceToHost);
    cudaMemcpy(bases.data(), d_base, sizeof(int) * count, cudaMemcpyDeviceToHost);
    cudaMemcpy(scores.data(), d_score, sizeof(float) * count, cudaMemcpyDeviceToHost);
    std::vector<int> order(count);
    for (int i = 0; i < count; i++) order[i] = i;
    std::sort(order.begin(), order.end(), [&](int x, int y) { return scores[x] > scores[y]; });
    printf("候选 %d 个, 前 40:\n", count);
    for (int i = 0; i < count && i < 40; i++) {
        int k = order[i];
        printf("  seed=%d spawn_x=%d score=%.4f\n", seeds[k], bases[k] + marker, scores[k]);
    }
    FILE *f = fopen("candidates_gpu.txt", "w");
    if (f) {
        for (int i = 0; i < count; i++) {
            int k = order[i];
            fprintf(f, "seed=%d spawn_x=%d score=%.4f\n", seeds[k], bases[k] + marker, scores[k]);
        }
        fclose(f);
    }
    return 0;
}

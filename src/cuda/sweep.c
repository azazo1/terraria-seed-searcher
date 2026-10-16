/* 泰拉瑞亚世界种子反查扫描器.
 *
 * 流程: 种子 -> 初始化段模拟 (得到 leftBeachEnd / rightBeachStart)
 *            -> TerrainPass 地表剖面模拟
 *            -> 与截图提取出的观测剖面对齐打分
 *
 * 所有算法都与 tools/rng_probe.py, tools/setup_beach.py, tools/terrainsim.py 对齐,
 * 那三个 Python 实现已经用 dev1.wld 逐字段和逐格验证过.
 *
 * 编译: cc -O3 -march=native -pthread -o sweep sweep.c -lm
 * 用法: ./sweep --check <seed>      打印某个种子的剖面 (用于和 Python 对拍)
 *       ./sweep --top <n> --threads <t> [--range a b]   扫描并输出最高分的候选
 */
#include <math.h>
#include <pthread.h>
#include <unistd.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* 世界尺寸. 默认中世界 (6400x1800); 用 -DWORLD_LARGE / -DWORLD_SMALL 编译出对应尺寸的版本.
 * 尺寸是编译期常量而不是运行时变量, 目的是让内层循环的代码生成完全不受影响 —— 逐位一致性比灵活性重要. */
#if defined(WORLD_LARGE)
#define WORLD_W 8400
#define WORLD_H 2400
#elif defined(WORLD_SMALL)
#define WORLD_W 4200
#define WORLD_H 1200
#else
#define WORLD_W 6400
#define WORLD_H 1800
#endif
#define INT_MAX_ 2147483647
#define MAX_COLS 3600
#define MAX_OBS 700

/* ---------------- 随机数: UnifiedRandom 的逐行移植 ---------------- */

typedef struct {
    int sa[56];
    unsigned inext;
} RNG;

static inline int i32(int64_t x) {
    return (int)(uint32_t)(x & 0xFFFFFFFFu);
}

static void rng_seed(RNG *r, int seed) {
    memset(r->sa, 0, sizeof(r->sa));
    int num = (seed == (int)0x80000000) ? INT_MAX_ : abs(seed);
    int num2 = i32(161803398 - (int64_t)num);
    r->sa[55] = num2;
    int num3 = 1;
    for (int j = 1; j < 55; j++) {
        int num4 = 21 * j % 55;
        r->sa[num4] = num3;
        num3 = i32((int64_t)num2 - num3);
        if (num3 < 0) num3 = i32((int64_t)num3 + INT_MAX_);
        num2 = r->sa[num4];
    }
    for (int k = 1; k < 5; k++) {
        for (int l = 1; l < 56; l++) {
            r->sa[l] = i32((int64_t)r->sa[l] - r->sa[1 + (l + 30) % 55]);
            if (r->sa[l] < 0) r->sa[l] = i32((int64_t)r->sa[l] + INT_MAX_);
        }
    }
    r->inext = 0;
}

static inline int rng_sample(RNG *r) {
    unsigned num = r->inext + 1u;
    if (num > 55u) num = 1u;
    unsigned num2 = num + 21u;
    if (num2 > 55u) num2 -= 55u;
    int num3 = i32((int64_t)r->sa[num] - r->sa[num2]);
    if (num3 == INT_MAX_) num3--;
    num3 = i32((int64_t)num3 + ((num3 >> 31) & INT_MAX_));
    r->sa[num] = num3;
    r->inext = num;
    return num3;
}

/* Sample(): InternalSample * 4.656612875245797E-10 */
static inline double rng_sample_d(RNG *r) {
    return (double)rng_sample(r) * 4.656612875245797E-10;
}

/* Next(maxValue) = (int)(Sample() * maxValue) */
static inline int rng_next(RNG *r, int maxValue) {
    return (int)(rng_sample_d(r) * (double)maxValue);
}

/* Next(minValue, maxValue) = (int)(Sample() * (max-min)) + min */
static inline int rng_next2(RNG *r, int minValue, int maxValue) {
    return (int)(rng_sample_d(r) * (double)((int64_t)maxValue - minValue)) + minValue;
}

/* ---------------- 初始化段 (WorldGen.Reset 7192~7482) ---------------- */

static int roll_random_forest_bg(RNG *r) {
    int num2 = rng_next(r, 14);
    if ((num2 == 1 || num2 == 2) && rng_next(r, 2) == 0) num2 = rng_next(r, 14);
    if (num2 == 0) num2 = rng_next(r, 14);
    if (num2 == 3 && rng_next(r, 3) == 0) num2 = 31;
    if (num2 == 5 && rng_next(r, 2) == 0) num2 = 51;
    if (num2 == 7 && rng_next(r, 4) == 0) num2 = rng_next2(r, 71, 74);
    return num2;
}

static void randomize_weather(RNG *r) {
    rng_next2(r, 10, 200);
    for (int guard = 0; guard < 100; guard++) {
        double f = rng_sample_d(r);
        double v = f * 0.35 * (double)(rng_next(r, 2) * 2 - 1);
        if (v != 0.0) return;
    }
}

static void randomize_tree_style(RNG *r, int w) {
    rng_next2(r, (int)((double)w * 0.334 - (double)w * 0.2), (int)((double)w * 0.334 + (double)w * 0.2));
    rng_next2(r, (int)((double)w * 0.667 - (double)w * 0.2), (int)((double)w * 0.667 + (double)w * 0.2));
    int ts[3];
    for (int i = 0; i < 3; i++) ts[i] = rng_next(r, 6);
    while (ts[1] == ts[0]) ts[1] = rng_next(r, 6);
    while (ts[2] == ts[0] || ts[2] == ts[1]) ts[2] = rng_next(r, 6);
    for (int j = 0; j < 3; j++) {
        if (ts[j] == 0 && rng_next(r, 3) != 0) ts[j] = 4;
    }
}

static void randomize_cave_backgrounds(RNG *r, int w) {
    rng_next2(r, (int)((double)w * 0.334 - (double)w * 0.2), (int)((double)w * 0.334 + (double)w * 0.2));
    rng_next2(r, (int)((double)w * 0.667 - (double)w * 0.2), (int)((double)w * 0.667 + (double)w * 0.2));
    int st[3];
    for (int i = 0; i < 3; i++) st[i] = rng_next(r, 8);
    while (st[1] == st[0]) st[1] = rng_next(r, 8);
    while (st[2] == st[0] || st[2] == st[1]) st[2] = rng_next(r, 8);
    /* 分支之后的公共收尾取数, 这三次最容易漏 */
    rng_next(r, 4);
    rng_next(r, 3);
    rng_next(r, 2);
}

static void randomize_backgrounds(RNG *r) {
    int tb[4];
    tb[0] = roll_random_forest_bg(r);
    for (int k = 1; k < 4; k++) {
        int v = roll_random_forest_bg(r);
        while (v == tb[0] || (k > 1 && v == tb[1]) || (k > 2 && v == tb[2])) v = roll_random_forest_bg(r);
        tb[k] = v;
    }
    int corrupt = rng_next(r, 6);
    if (corrupt == 5) corrupt = (rng_next(r, 2) == 0) ? 51 : 52;
    (void)corrupt;
    rng_next(r, 7);
    int snow = rng_next(r, 9);
    for (int base = 2; base <= 4; base++) {
        if (snow == base && rng_next(r, 2) == 0) {
            snow = (rng_next(r, 2) == 0) ? base * 10 + 1 : base * 10 + 2;
        }
    }
    rng_next(r, 6);
    rng_next(r, 7);
    int desert = rng_next(r, 6);
    if (desert == 5) rng_next(r, 5);
    rng_next(r, 8);
    rng_next(r, 5);
    rng_next(r, 3);
}

/* 返回 leftBeachEnd, 同时给出 rightBeachStart */
static int setup_beach(int seed, int w, int *out_right) {
    RNG r;
    rng_seed(&r, seed);
    rng_next(&r, 5);                     /* jungleHut */
    rng_next(&r, 2);                     /* crimsonLeft */
    randomize_weather(&r);               /* 7277 */
    for (int c = 5; c >= 1; c--) rng_next(&r, c);   /* 地狱箱洗牌 */
    rng_next2(&r, 86400 * 2, 86400 * 3);            /* slimeRainTime */
    rng_next2(&r, 8640, 86400);                     /* cloudBGActive */
    for (int i = 0; i < 4; i++) rng_next(&r, 2);    /* 四种矿变体 */
    rng_next(&r, 2);                                /* 猩红 / 腐化 */
    rng_next(&r, INT_MAX_);                         /* WorldId */
    randomize_tree_style(&r, w);
    randomize_cave_backgrounds(&r, w);
    randomize_backgrounds(&r);
    rng_next(&r, 9);                                /* moon */
    int dungeon_side = (rng_next(&r, 2) == 0) ? 0 : 1;
    rng_next2(&r, 15, 30);                          /* jungleOriginX */
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
    return left;
}

/* ---------------- TerrainPass 地表剖面 ---------------- */

#define PLATEAU 0
#define HILL 1
#define DALE 2
#define MOUNTAIN 3
#define VALLEY 4

static double surface_offset(RNG *r, int feature) {
    double num = 0.0;
    switch (feature) {
        case PLATEAU:
            while (rng_next(r, 7) == 0) num += rng_next2(r, -1, 2);
            break;
        case HILL:
            while (rng_next(r, 4) == 0) num -= 1.0;
            while (rng_next(r, 10) == 0) num += 1.0;
            break;
        case DALE:
            while (rng_next(r, 4) == 0) num += 1.0;
            while (rng_next(r, 10) == 0) num -= 1.0;
            break;
        case MOUNTAIN:
            while (rng_next(r, 2) == 0) num -= 1.0;
            while (rng_next(r, 6) == 0) num += 1.0;
            break;
        case VALLEY:
            while (rng_next(r, 2) == 0) num += 1.0;
            while (rng_next(r, 5) == 0) num -= 1.0;
            break;
        default: break;
    }
    return num;
}

/* out[x] = 该列地表的整数行号 (等价于 (int)num2) */
static void terrain_profile(int seed, int left_beach, int right_beach, int cols, int *out) {
    RNG r;
    rng_seed(&r, seed);
    int w = WORLD_W, h = WORLD_H;
    double num2 = (double)h * 0.3;
    num2 *= (double)rng_next2(&r, 90, 110) * 0.005;
    double num3 = num2 + (double)h * 0.2;
    num3 *= (double)rng_next2(&r, 90, 110) * 0.01;
    double num8 = (double)h * 0.23;
    int num9 = left_beach + 5;
    int feature = PLATEAU;
    for (int i = 0; i < cols; i++) {
        if (num9 <= 0) {
            feature = rng_next2(&r, 0, 5);
            num9 = rng_next2(&r, 5, 40);
            if (feature == PLATEAU) num9 *= (int)((double)rng_next2(&r, 5, 30) * 0.2);
        }
        num9--;
        if ((double)i > (double)w * 0.45 && (double)i < (double)w * 0.55 &&
            (feature == MOUNTAIN || feature == VALLEY)) {
            feature = rng_next(&r, 3);
        }
        if ((double)i > (double)w * 0.48 && (double)i < (double)w * 0.52) feature = PLATEAU;
        num2 += surface_offset(&r, feature);
        double num10 = 0.17, num11 = 0.26;
        if (i < left_beach + 5 || i > right_beach - 5) {
            if (num2 < (double)h * num10) num2 = (double)h * num10;
            else if (num2 > num8) num2 = num8;
        } else if (num2 < (double)h * num10) {
            num2 = (double)h * num10;
            num9 = 0;
        } else if (num2 > (double)h * num11) {
            num2 = (double)h * num11;
            num9 = 0;
        }
        while (rng_next(&r, 3) == 0) num3 += (double)rng_next2(&r, -2, 3);
        if (num3 < num2 + (double)h * 0.06) num3 += 1.0;
        if (num3 > num2 + (double)h * 0.35) num3 -= 1.0;
        out[i] = (int)num2;
    }
}

/* ---------------- 观测剖面 ---------------- */

static double obs[MAX_OBS];
static int obs_n = 0;
static int obs_valid[MAX_OBS];
static int spawn_marker_x = 471;      /* scaled.png 里出生点图标的列 */

/* 多尺度: 图片上第 j 列对应相对格偏移 round(j / scale) */
static const double g_scales[5] = {1.00, 0.97, 1.03, 0.94, 1.06};
#define NSCALE 5
static int g_nscale = 1;
static int scale_shift[NSCALE][MAX_OBS];

static void build_scales(void) {
    for (int s = 0; s < NSCALE; s++)
        for (int j = 0; j < obs_n; j++)
            scale_shift[s][j] = (int)((double)j / g_scales[s] + 0.5);
}

static int load_obs(const char *path) {
    FILE *f = fopen(path, "r");
    if (!f) { perror("obs"); return -1; }
    double v;
    int n = 0;
    while (n < MAX_OBS && fscanf(f, "%lf", &v) == 1) {
        if (v < -900.0) { obs[n] = 0; obs_valid[n] = 0; }
        else { obs[n] = v; obs_valid[n] = 1; }
        n++;
    }
    fclose(f);
    obs_n = n;
    return n;
}

/* 打分: 用少量锚点估计纵向偏移, 再统计容差内的列占比 */
static double score_alignment(const int *sim, int sim_len, int sim_base, double tol, int sc) {
    int idxs[MAX_OBS];
    int n = 0;
    for (int j = 0; j < obs_n; j++) {
        int k = sim_base + scale_shift[sc][j];
        if (obs_valid[j] && k >= 0 && k < sim_len) idxs[n++] = j;
    }
    if (n < 200) return -1.0;
    /* 5 个锚点取中位, 估计纵向偏移 */
    double offs[5];
    for (int t = 0; t < 5; t++) {
        int j = idxs[(int)((long long)t * n / 5)];
        offs[t] = (double)sim[sim_base + scale_shift[sc][j]] - obs[j];
    }
    for (int a = 0; a < 5; a++)
        for (int b = a + 1; b < 5; b++)
            if (offs[b] < offs[a]) { double tmp = offs[a]; offs[a] = offs[b]; offs[b] = tmp; }
    double off = offs[2];
    int hit = 0;
    for (int k = 0; k < n; k++) {
        int j = idxs[k];
        double d = ((double)sim[sim_base + scale_shift[sc][j]] - obs[j]) - off;
        if (d <= tol && d >= -tol) hit++;
    }
    return (double)hit / (double)n;
}

/* 快速预筛: 只用少量列 */
static double quick_score(const int *sim, int sim_len, int sim_base, double tol, int sc) {
    int hit = 0, cnt = 0;
    double offs[5];
    int got = 0;
    for (int t = 0; t < 5; t++) {
        int j = (int)((long long)t * obs_n / 5);
        int k = sim_base + scale_shift[sc][j];
        if (obs_valid[j] && k >= 0 && k < sim_len) offs[got++] = (double)sim[k] - obs[j];
    }
    if (got < 3) return -1.0;
    for (int a = 0; a < got; a++)
        for (int b = a + 1; b < got; b++)
            if (offs[b] < offs[a]) { double tmp = offs[a]; offs[a] = offs[b]; offs[b] = tmp; }
    double off = offs[got / 2];
    for (int j = 0; j < obs_n; j += 13) {
        int k = sim_base + scale_shift[sc][j];
        if (!obs_valid[j] || k < 0 || k >= sim_len) continue;
        cnt++;
        double d = ((double)sim[k] - obs[j]) - off;
        if (d <= tol && d >= -tol) hit++;
    }
    if (cnt < 10) return -1.0;
    return (double)hit / (double)cnt;
}

/* ---------------- 结果收集 ---------------- */

#define TOPK 65536
static int top_seed[TOPK];
static int top_spawn[TOPK];
static float top_score[TOPK];
static int top_count = 0;
static pthread_mutex_t top_lock = PTHREAD_MUTEX_INITIALIZER;

static double g_best_logged = 0.0;

static int cmp_top(const void *a, const void *b);

/* 把候选榜前 n 名落盘, 便于长跑期间随时查看进展 */
static void dump_top_locked(const char *path, int n) {
    static int idx[TOPK];
    int n2 = top_count;
    for (int i = 0; i < n2; i++) idx[i] = i;
    qsort(idx, n2, sizeof(int), cmp_top);
    FILE *f = fopen(path, "w");
    if (!f) return;
    fprintf(f, "# 候选种子 (得分降序, 当前共 %d 个, 落盘上限 %d)\n", top_count, n);
    for (int i = 0; i < top_count && i < n; i++) {
        int k = idx[i];
        fprintf(f, "seed=%d spawn_x=%d score=%.4f\n", top_seed[k], top_spawn[k], top_score[k]);
    }
    fclose(f);
}

static void offer(int seed, int spawn, double score) {
    pthread_mutex_lock(&top_lock);
    if (top_count < TOPK) {
        int i = top_count++;
        top_seed[i] = seed; top_spawn[i] = spawn; top_score[i] = (float)score;
    } else {
        int worst = 0;
        for (int i = 1; i < TOPK; i++) if (top_score[i] < top_score[worst]) worst = i;
        if (score > top_score[worst]) {
            top_seed[worst] = seed; top_spawn[worst] = spawn; top_score[worst] = (float)score;
        }
    }
    if (score > g_best_logged + 1e-9) {
        g_best_logged = score;
        printf("NEW BEST seed=%d spawn_x=%d score=%.4f\n", seed, spawn, score);
        fflush(stdout);
        dump_top_locked("data/candidates_top.txt", TOPK);
    }
    pthread_mutex_unlock(&top_lock);
}

/* ---------------- 扫描 ---------------- */

static int g_scan_cols = 3550;
static int g_spawn_lo = 3160, g_spawn_hi = 3240;
static double g_tol = 1.5;
static int g_quick_floor = 45;        /* 快速预筛的最低命中率 (百分比) */
static double g_offer = 0.70;         /* 进入候选榜的最低分 */

static long long g_counter = 0;
static long long g_total = 0;
static pthread_mutex_t cnt_lock = PTHREAD_MUTEX_INITIALIZER;

typedef struct { int from, to, id; } Job;

/* ---------------- 交错推进: 一个线程同时跑 N 条独立随机数链 ----------------
 * 随机数是串行依赖链, 单线程每次取数都要等上一步, 实测流水线没喂饱.
 * 同时推进 N 个互不相关的种子, 让 CPU 的乱序执行把延迟盖住. */
#define NMAX 8

typedef struct {
    RNG rng;
    double num2, num3, num8;
    int num9, feature, left, right;
} SimState;

static void sim_init(SimState *s, int seed, int left, int right) {
    rng_seed(&s->rng, seed);
    s->left = left;
    s->right = right;
    s->num2 = (double)WORLD_H * 0.3;
    s->num2 *= (double)rng_next2(&s->rng, 90, 110) * 0.005;
    s->num3 = s->num2 + (double)WORLD_H * 0.2;
    s->num3 *= (double)rng_next2(&s->rng, 90, 110) * 0.01;
    s->num8 = (double)WORLD_H * 0.23;
    s->num9 = left + 5;
    s->feature = PLATEAU;
}

static inline int sim_step(SimState *s, int i) {
    RNG *r = &s->rng;
    if (s->num9 <= 0) {
        s->feature = rng_next2(r, 0, 5);
        s->num9 = rng_next2(r, 5, 40);
        if (s->feature == PLATEAU) s->num9 *= (int)((double)rng_next2(r, 5, 30) * 0.2);
    }
    s->num9--;
    if ((double)i > (double)WORLD_W * 0.45 && (double)i < (double)WORLD_W * 0.55 &&
        (s->feature == MOUNTAIN || s->feature == VALLEY)) {
        s->feature = rng_next(r, 3);
    }
    if ((double)i > (double)WORLD_W * 0.48 && (double)i < (double)WORLD_W * 0.52) s->feature = PLATEAU;
    s->num2 += surface_offset(r, s->feature);
    double num10 = 0.17, num11 = 0.26;
    if (i < s->left + 5 || i > s->right - 5) {
        if (s->num2 < (double)WORLD_H * num10) s->num2 = (double)WORLD_H * num10;
        else if (s->num2 > s->num8) s->num2 = s->num8;
    } else if (s->num2 < (double)WORLD_H * num10) {
        s->num2 = (double)WORLD_H * num10; s->num9 = 0;
    } else if (s->num2 > (double)WORLD_H * num11) {
        s->num2 = (double)WORLD_H * num11; s->num9 = 0;
    }
    while (rng_next(r, 3) == 0) s->num3 += (double)rng_next2(r, -2, 3);
    if (s->num3 < s->num2 + (double)WORLD_H * 0.06) s->num3 += 1.0;
    if (s->num3 > s->num2 + (double)WORLD_H * 0.35) s->num3 -= 1.0;
    return (int)s->num2;
}

static int g_interleave = 1;
static const char *g_obs_path = "data/observed_profile.txt";
static int g_resume = 0;
static long long g_skip_block = 0;   /* 区块大小; 0 表示不跳过 */
static long long g_skip_len = 0;     /* 每个区块开头跳过的长度 */

/* 若 seed0 落在 [k*block, k*block+len) 内, 返回该跳过段的结束位置; 否则返回 seed0 本身 */
static long long skip_covered(long long seed0) {
    if (g_skip_block <= 0 || g_skip_len <= 0) return seed0;
    long long k = seed0 / g_skip_block;
    long long start = k * g_skip_block;
    if (seed0 < start + g_skip_len) return start + g_skip_len;
    return seed0;
}

/* 断点: 每个线程把自己的下一个待处理种子写进文件, 供 --resume 接着跑 */
static void ckpt_path(int id, char *buf, size_t n) {
    snprintf(buf, n, "data/progress_%d.txt", id);
}

static void write_ckpt(int id, int next_seed) {
    char path[128], tmp[160];
    ckpt_path(id, path, sizeof(path));
    snprintf(tmp, sizeof(tmp), "%s.tmp", path);
    FILE *f = fopen(tmp, "w");
    if (!f) return;
    fprintf(f, "%d\n", next_seed);
    fclose(f);
    rename(tmp, path);
}

static int read_ckpt(int id) {
    char path[128];
    ckpt_path(id, path, sizeof(path));
    FILE *f = fopen(path, "r");
    if (!f) return -1;
    int v = -1;
    if (fscanf(f, "%d", &v) != 1) v = -1;
    fclose(f);
    return v;
}

/* 定时落盘: 只靠"刷新最好成绩"落盘会漏掉排名中段的新候选 (例如上面压着一个更高分的假候选),
 * 所以每 60 秒无条件写一次. */
static void *dumper(void *arg) {
    (void)arg;
    for (;;) {
        sleep(60);
        pthread_mutex_lock(&top_lock);
        dump_top_locked("data/candidates_top.txt", TOPK);
        pthread_mutex_unlock(&top_lock);
    }
    return NULL;
}

static void *worker(void *arg) {
    Job *job = (Job *)arg;
    int N = g_interleave < 1 ? 1 : (g_interleave > NMAX ? NMAX : g_interleave);
    int (*sim)[MAX_COLS] = malloc(sizeof(int) * (size_t)MAX_COLS * (size_t)N);
    SimState st[NMAX];
    long long done = 0;
    long long ckpt_next = (long long)job->from + 500000;
    for (int seed0 = job->from; seed0 < job->to; seed0 += N) {
      if ((long long)seed0 >= ckpt_next) {
        write_ckpt(job->id, seed0);
        ckpt_next = (long long)seed0 + 500000;
      }
      int n = 0;
      if (g_skip_block > 0) {
          long long nxt = skip_covered((long long)seed0);
          if (nxt > seed0) { seed0 = (int)nxt; if (seed0 >= job->to) break; }
      }
      for (int k = 0; k < N && seed0 + k < job->to; k++) {
        int right;
        int left = setup_beach(seed0 + k, WORLD_W, &right);
        sim_init(&st[k], seed0 + k, left, right);
        n++;
      }
      for (int i = 0; i < g_scan_cols; i++)
        for (int k = 0; k < n; k++)
          sim[k][i] = sim_step(&st[k], i);
      for (int k = 0; k < n; k++) {
        int seed = seed0 + k;
        double best = -1.0;
        int best_spawn = 0;
        for (int sc = 0; sc < g_nscale; sc++) {
            for (int sx = g_spawn_lo; sx <= g_spawn_hi; sx++) {
                int base = sx - spawn_marker_x;
                double q = quick_score(sim[k], g_scan_cols, base, (double)g_tol + 0.5, sc);
                if (q * 100.0 < (double)g_quick_floor) continue;
                double s = score_alignment(sim[k], g_scan_cols, base, g_tol, sc);
                if (s > best) { best = s; best_spawn = sx; }
            }
        }
        if (best >= g_offer) offer(seed, best_spawn, best);
        done++;
        if ((done & 0xFFFFF) == 0) {
            pthread_mutex_lock(&cnt_lock);
            g_counter += done;
            double pct = 100.0 * (double)g_counter / (double)g_total;
            fprintf(stderr, "  进度 %.3f%%  (已扫 %lld)\n", pct, g_counter);
            done = 0;
            pthread_mutex_unlock(&cnt_lock);
        }
      }
    }
    free(sim);
    pthread_mutex_lock(&cnt_lock);
    g_counter += done;
    pthread_mutex_unlock(&cnt_lock);
    return NULL;
}

static int cmp_top(const void *a, const void *b) {
    int ia = *(const int *)a, ib = *(const int *)b;
    if (top_score[ia] > top_score[ib]) return -1;   /* 分数降序 */
    if (top_score[ia] < top_score[ib]) return 1;
    return 0;
}

int main(int argc, char **argv) {
    /* 先扫一遍参数: 观测文件与对拍种子必须在读取观测之前确定 */
    int check_seed = 0, do_check = 0;
    for (int i = 1; i + 1 < argc; i++) {
        if (strcmp(argv[i], "--obs") == 0) g_obs_path = argv[i + 1];
        else if (strcmp(argv[i], "--check") == 0) { check_seed = atoi(argv[i + 1]); do_check = 1; }
    }
    if (load_obs(g_obs_path) < 0) return 1;

    build_scales();
    if (do_check) {
        int seed = check_seed;
        int right;
        int left = setup_beach(seed, WORLD_W, &right);
        static int sim[MAX_COLS];
        terrain_profile(seed, left, right, g_scan_cols, sim);
        printf("seed %d leftBeachEnd %d rightBeachStart %d\n", seed, left, right);
        for (int x = 2700; x < 2760; x++) printf("%d ", sim[x]);
        printf("\n");
        double best = -1; int bs = 0;
        for (int sc = 0; sc < NSCALE; sc++) {
            for (int sx = g_spawn_lo; sx <= g_spawn_hi; sx++) {
                double s = score_alignment(sim, g_scan_cols, sx - spawn_marker_x, g_tol, sc);
                if (s > best) { best = s; bs = sx; }
            }
        }
        printf("最佳对齐 spawn_x=%d 得分 %.3f\n", bs, best);
        return 0;
    }

    int threads = 8, from = 0, to = INT_MAX_;
    for (int i = 1; i < argc; i++) {
        if (strcmp(argv[i], "--threads") == 0 && i + 1 < argc) threads = atoi(argv[++i]);
        else if (strcmp(argv[i], "--range") == 0 && i + 2 < argc) { from = atoi(argv[++i]); to = atoi(argv[++i]); }
        else if (strcmp(argv[i], "--cols") == 0 && i + 1 < argc) g_scan_cols = atoi(argv[++i]);
        else if (strcmp(argv[i], "--tol") == 0 && i + 1 < argc) g_tol = atof(argv[++i]);
        else if (strcmp(argv[i], "--quick") == 0 && i + 1 < argc) g_quick_floor = atoi(argv[++i]);
        else if (strcmp(argv[i], "--offer") == 0 && i + 1 < argc) g_offer = atof(argv[++i]);
        else if (strcmp(argv[i], "--nscale") == 0 && i + 1 < argc) g_nscale = atoi(argv[++i]);
        else if (strcmp(argv[i], "--interleave") == 0 && i + 1 < argc) g_interleave = atoi(argv[++i]);
        else if (strcmp(argv[i], "--obs") == 0 && i + 1 < argc) g_obs_path = argv[++i];
        else if (strcmp(argv[i], "--spawn") == 0 && i + 2 < argc) { g_spawn_lo = atoi(argv[++i]); g_spawn_hi = atoi(argv[++i]); }
        else if (strcmp(argv[i], "--resume") == 0) g_resume = 1;
        else if (strcmp(argv[i], "--skip-blocks") == 0 && i + 2 < argc) {
            g_skip_block = atoll(argv[++i]); g_skip_len = atoll(argv[++i]);
        }
    }
    if (to > INT_MAX_) to = INT_MAX_;
    g_total = (long long)to - from;
    fprintf(stderr, "扫描 %d..%d, 线程 %d, 列数 %d, 观测列 %d, spawn 范围 %d..%d, 容差 %.1f\n",
            from, to, threads, g_scan_cols, obs_n, g_spawn_lo, g_spawn_hi, g_tol);

    pthread_t *th = calloc(threads, sizeof(pthread_t));
    Job *jobs = calloc(threads, sizeof(Job));
    long long span = (long long)to - from;
    for (int i = 0; i < threads; i++) {
        jobs[i].from = (int)(from + span * i / threads);
        jobs[i].to = (int)(from + span * (i + 1) / threads);
        if (g_resume) {
            int ck = read_ckpt(i);
            if (ck > jobs[i].from && ck <= jobs[i].to) {
                fprintf(stderr, "  线程 %d 从断点续跑: %d\n", i, ck);
                jobs[i].from = ck;
            }
        }
        jobs[i].id = i;
        pthread_create(&th[i], NULL, worker, &jobs[i]);
    }
    pthread_t dump_th;
    pthread_create(&dump_th, NULL, dumper, NULL);
    for (int i = 0; i < threads; i++) pthread_join(th[i], NULL);
    pthread_mutex_lock(&top_lock);
    dump_top_locked("data/candidates_top.txt", TOPK);
    pthread_mutex_unlock(&top_lock);
    fprintf(stderr, "扫描完成, 候选 %d 个已落盘\n", top_count);

    int *order = malloc(sizeof(int) * top_count);
    for (int i = 0; i < top_count; i++) order[i] = i;
    qsort(order, top_count, sizeof(int), cmp_top);
    printf("候选 %d 个 (按得分排序, 前 40):\n", top_count);
    for (int i = 0; i < top_count && i < 40; i++) {
        int k = order[i];
        printf("  seed=%d spawn_x=%d score=%.4f\n", top_seed[k], top_spawn[k], top_score[k]);
    }
    return 0;
}

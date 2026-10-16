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
        int right;
        int left = setup_beach(&rng, seed, W_MEDIUM, &right);

        /* 下面是 TerrainPass 的逐列模拟, 与 stream_score 中完全一致 */
        rng_seed(&rng, seed);
        double num2 = (double)H_MEDIUM * 0.3;
        num2 *= (double)rng_next2(&rng, 90, 110) * 0.005;
        double num3 = num2 + (double)H_MEDIUM * 0.2;
        num3 *= (double)rng_next2(&rng, 90, 110) * 0.01;
        double num8 = (double)H_MEDIUM * 0.23;
        int num9 = left + 5;
        int feature = 0;
        int *dst = a.prof + (long long)idx * W;
        for (int i = 0; i < a.cols; i++) {
            if (num9 <= 0) {
                feature = rng_next2(&rng, 0, 5);
                num9 = rng_next2(&rng, 5, 40);
                if (feature == 0) num9 *= (int)((double)rng_next2(&rng, 5, 30) * 0.2);
            }
            num9--;
            if ((double)i > (double)W_MEDIUM * 0.45 && (double)i < (double)W_MEDIUM * 0.55 && (feature == 3 || feature == 4))
                feature = rng_next(&rng, 3);
            if ((double)i > (double)W_MEDIUM * 0.48 && (double)i < (double)W_MEDIUM * 0.52) feature = 0;
            num2 += surface_offset(&rng, feature);
            double num10 = 0.17, num11 = 0.26;
            if (i < left + 5 || i > right - 5) {
                if (num2 < (double)H_MEDIUM * num10) num2 = (double)H_MEDIUM * num10;
                else if (num2 > num8) num2 = num8;
            } else if (num2 < (double)H_MEDIUM * num10) {
                num2 = (double)H_MEDIUM * num10; num9 = 0;
            } else if (num2 > (double)H_MEDIUM * num11) {
                num2 = (double)H_MEDIUM * num11; num9 = 0;
            }
            while (rng_next(&rng, 3) == 0) num3 += (double)rng_next2(&rng, -2, 3);
            if (num3 < num2 + (double)H_MEDIUM * 0.06) num3 += 1.0;
            if (num3 > num2 + (double)H_MEDIUM * 0.35) num3 -= 1.0;
            if (i >= a.w0 && i < a.w1) dst[i - a.w0] = (int)(num2 * 8.0);
        }
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
        /* 命中 = 中位偏移 +-0.5 格 (本内核的箱宽是 1/8 格, 即 +-4 箱), 与 --tol 0.5 同义 */
        int hit = 0;
        for (int k = med - 4; k <= med + 4; k++) if (k >= 0 && k < 33) hit += hist[k];
        float sc = (float)hit / (float)cnt;
        unsigned qq = (unsigned)(sc * 10000000.0f);
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

    unsigned long long *h_best = (unsigned long long *)malloc(sizeof(unsigned long long) * batch);
    int threads = 128;
    size_t shmem_a = (size_t)threads * (56 * sizeof(int) + sizeof(unsigned));
    size_t shmem_b = (size_t)W * sizeof(int);
    if (shmem_b > 48 * 1024) {                       /* 需要时显式提高上限 */
        cudaFuncSetAttribute(score_kernel, cudaFuncAttributeMaxDynamicSharedMemorySize, (int)shmem_b);
    }
    printf("kernel A 共享内存 %zu B, kernel B 共享内存 %zu B\n", shmem_a, shmem_b);
    fflush(stdout);

    int total_checked = 0;
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
                h_seed.push_back(a.seed_from + i);
                h_base.push_back(base_lo + q / nscale);
                h_scale.push_back(q % nscale);
                h_score.push_back((float)((double)(h_best[i] >> 32) / 10000000.0));
            }
        }
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
    FILE *f = fopen("candidates_gpu2.txt", "w");
    if (f) {
        for (int i = 0; i < count; i++) {
            int k = order[i];
            fprintf(f, "seed=%d spawn_x=%d scale=%.2f score=%.4f\n",
                    h_seed[k], h_base[k] + marker, scales[h_scale[k]], h_score[k]);
        }
        fclose(f);
    }
    return 0;
}

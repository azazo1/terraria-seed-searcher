/* CUDA 搜索器的主机入口.
 *
 * 设备代码在 sweep.cu, 这里只做参数解析, 多卡线程和候选合并.
 * <thread> / <atomic> 只出现在本文件, 避免 nvcc 的 cudafe++ 处理这些头文件.
 */
#include "sweep.h"
#include <atomic>
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <string>
#include <thread>
#include <vector>
#include <algorithm>

struct Options {
    double tol, offer;
    int cols, spawn_lo, spawn_hi, marker, check, batch, device;
    long long from, to;
    double scales[8];
    int nscale;
};

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

/* 合并各卡的候选快照, 按分数取前 limit 条. 返回写入的条数. */
static size_t merge_candidates(const std::vector<std::string> &paths, const char *out_path, size_t limit) {
    struct Row { int seed; int spawn; double scale; double score; };
    std::vector<Row> rows;
    for (const auto &path : paths) {
        std::ifstream input(path);
        std::string line;
        while (std::getline(input, line)) {
            Row row;
            if (sscanf(line.c_str(), "seed=%d spawn_x=%d scale=%lf score=%lf", &row.seed, &row.spawn, &row.scale, &row.score) == 4)
                rows.push_back(row);
        }
    }
    std::sort(rows.begin(), rows.end(), [](const Row &a, const Row &b) {
        return a.score > b.score || (a.score == b.score && a.seed < b.seed);
    });
    if (rows.size() > limit) rows.resize(limit);
    if (!save_candidate_file(out_path, [&](std::ostream &output) {
        for (const auto &row : rows)
            output << "seed=" << row.seed << " spawn_x=" << row.spawn << " scale=" << row.scale << " score=" << row.score << '\n';
    })) return 0;
    return rows.size();
}

int main(int argc, char **argv) {
    if (argc < 2) { fprintf(stderr, "用法: sweep.exe <观测文件> [选项]\n"); return 1; }
    double h_obs[MAX_OBS]; unsigned char h_valid[MAX_OBS]; int obs_n = 0;
    if (load_obs(argv[1], h_obs, h_valid, &obs_n) < 0) return 1;
    if (obs_n <= 0) { fprintf(stderr, "观测文件没有有效数值\n"); return 1; }

    Options opt;
    opt.tol = 0.5; opt.offer = 0.20; opt.cols = 3550; opt.spawn_lo = 3160; opt.spawn_hi = 3240;
    opt.marker = 471; opt.check = -1; opt.from = 0; opt.to = 2147483647LL; opt.batch = 400000; opt.device = 0;
    opt.scales[0] = 1.00; opt.scales[1] = 0.97; opt.scales[2] = 1.03; opt.nscale = 3;
    for (int i = 2; i < argc; i++) {
        if (!strcmp(argv[i], "--tol") && i + 1 < argc) opt.tol = atof(argv[++i]);
        else if (!strcmp(argv[i], "--offer") && i + 1 < argc) opt.offer = atof(argv[++i]);
        else if (!strcmp(argv[i], "--cols") && i + 1 < argc) opt.cols = atoi(argv[++i]);
        else if (!strcmp(argv[i], "--spawn-lo") && i + 1 < argc) opt.spawn_lo = atoi(argv[++i]);
        else if (!strcmp(argv[i], "--spawn-hi") && i + 1 < argc) opt.spawn_hi = atoi(argv[++i]);
        else if (!strcmp(argv[i], "--marker") && i + 1 < argc) opt.marker = atoi(argv[++i]);
        else if (!strcmp(argv[i], "--range") && i + 2 < argc) { opt.from = atoll(argv[++i]); opt.to = atoll(argv[++i]); }
        else if (!strcmp(argv[i], "--batch") && i + 1 < argc) opt.batch = atoi(argv[++i]);
        else if (!strcmp(argv[i], "--device") && i + 1 < argc) {
            const char *value = argv[++i];
            opt.device = (!strcmp(value, "all")) ? -1 : atoi(value);
        }
        else if (!strcmp(argv[i], "--check") && i + 1 < argc) opt.check = atoi(argv[++i]);
        else if (!strcmp(argv[i], "--scale") && i + 1 < argc) { opt.scales[0] = atof(argv[++i]); opt.nscale = 1; }
        else if (!strcmp(argv[i], "--scales") && i + 1 < argc) {
            opt.nscale = 0;
            for (char *tok = strtok(argv[++i], ","); tok && opt.nscale < 8; tok = strtok(NULL, ","))
                opt.scales[opt.nscale++] = atof(tok);
        }
    }
    if (opt.batch < 1) opt.batch = 1;
    if (opt.device < 0) opt.device = -1;

    int shift3[8 * MAX_OBS];
    for (int s = 0; s < opt.nscale; s++)
        for (int j = 0; j < obs_n; j++)
            shift3[s * obs_n + j] = (int)((double)j * opt.scales[s] + 0.5);

    int nbase = opt.spawn_hi - opt.spawn_lo + 1;
    int base_lo = opt.spawn_lo - opt.marker;
    int shift_max = 0;
    for (int s = 0; s < opt.nscale; s++) {
        int v = shift3[s * obs_n + obs_n - 1];
        if (v > shift_max) shift_max = v;
    }
    int w0 = base_lo;
    int w1 = base_lo + (nbase - 1) + shift_max + 1;
    if (w0 < 0) w0 = 0;
    if (w1 > opt.cols) w1 = opt.cols;
    int W = w1 - w0;
    printf("剖面窗口 [%d, %d) 共 %d 列; 偏移 %d 个, 尺度 %d 个\n", w0, w1, W, nbase, opt.nscale);

    SweepContext ctx;
    ctx.obs_n = obs_n;
    for (int i = 0; i < obs_n; i++) {
        ctx.obs[i] = h_obs[i];
        ctx.valid[i] = h_valid[i];
        ctx.obs8[i] = h_valid[i] ? (int)(h_obs[i] * 8.0 + (h_obs[i] >= 0 ? 0.5 : -0.5)) : 0;
    }
    for (int i = 0; i < 8 * obs_n; i++) ctx.shift3[i] = shift3[i];
    for (int i = 0; i < opt.nscale; i++) ctx.scales[i] = opt.scales[i];
    ctx.nscale = opt.nscale;
    ctx.cols = opt.cols; ctx.w0 = w0; ctx.w1 = w1; ctx.W = W;
    ctx.base_lo = base_lo; ctx.nbase = nbase;
    ctx.tol = opt.tol; ctx.offer = opt.offer; ctx.batch = opt.batch; ctx.marker = opt.marker;

    if (opt.check >= 0) {
        return sweep_check(opt.check, ctx, opt.spawn_lo, opt.spawn_hi, opt.cols, opt.marker);
    }

    if (opt.device == -1) {
        int count = sweep_device_count();
        if (count <= 0) {
            fprintf(stderr, "没有可用的 NVIDIA GPU\n");
            return 1;
        }
        printf("扫描 %lld..%lld, 容差 %.2f, 阈值 %.3f, 批大小 %d, 使用 %d 块 GPU\n",
               opt.from, opt.to, opt.tol, opt.offer, opt.batch, count);
        fflush(stdout);
        if (!sweep_save_empty("candidates_gpu2.txt")) { fprintf(stderr, "cannot initialize candidates_gpu2.txt\n"); return 1; }
        std::vector<std::string> paths(count);
        for (int i = 0; i < count; i++) {
            paths[i] = "candidates_gpu2.dev" + std::to_string(i) + ".txt";
            if (!sweep_save_empty(paths[i].c_str())) { fprintf(stderr, "cannot initialize %s\n", paths[i].c_str()); return 1; }
        }
        std::atomic<int> remaining(count);
        std::atomic<bool> failed(false);
        std::vector<std::thread> threads;
        for (int i = 0; i < count; i++) {
            long long a = opt.from + (opt.to - opt.from) * i / count;
            long long b = opt.from + (opt.to - opt.from) * (i + 1) / count;
            threads.emplace_back([&, i, a, b]() {
                SweepOutput output;
                if (!sweep_run_device(ctx, i, a, b, paths[i].c_str(), true, output)) failed = true;
                remaining--;
            });
        }
        size_t merged = 0;
        while (remaining > 0) {
            std::this_thread::sleep_for(std::chrono::milliseconds(500));
            size_t current = merge_candidates(paths, "candidates_gpu2.txt", 500000);
            if (current) merged = current;
        }
        for (auto &thread : threads) thread.join();
        size_t final_count = merge_candidates(paths, "candidates_gpu2.txt", 500000);
        if (final_count) merged = final_count;
        printf("批 %lld..%lld 完成, 本批达标 %zu 条, 累计候选 %zu, 进度 100.000%%\n",
               opt.from, opt.to, merged, merged);
        fflush(stdout);
        for (auto &path : paths) std::remove(path.c_str());
        return failed ? 1 : 0;
    }

    printf("扫描 %lld..%lld, 容差 %.2f, 阈值 %.3f, 批大小 %d, GPU %d\n",
           opt.from, opt.to, opt.tol, opt.offer, opt.batch, opt.device);
    fflush(stdout);
    SweepOutput out;
    if (!sweep_run_device(ctx, opt.device, opt.from, opt.to, "candidates_gpu2.txt", false, out)) return 1;
    return 0;
}

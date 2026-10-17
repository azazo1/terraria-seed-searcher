/* 原生 MLX 粗筛: 在 Apple GPU 上跑与 CPU / CUDA 完全相同的逐列地形生成和评分.
 *
 * 内核源码在 terrain-metal.h, 由 MLX 的 metal_kernel 在首次运行时编译成 Metal 内核.
 * 主机侧只负责分批、进度输出和候选维护, 语义与 CPU 版一致:
 * 保留最高分的 2000 条候选, 每批发布一次快照.
 *
 * 用法: sweep-mlx <观测文件> [--range lo hi] [--tol 0.5] [--offer 0.55] [--batch 200000]
 *                       [--marker 471] [--spawn-lo 3160] [--spawn-hi 3240] [--cols 3550]
 *                       [--scales 1.00] [--world small|medium|large] [--profile <seed> <cols>]
 */
#include "../search/candidate-file.h"
#include "../world-geometry.h"
#include "terrain-metal.h"
#include <mlx/c/fast.h>
#include <mlx/c/mlx.h>
#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <fstream>
#include <iostream>
#include <memory>
#include <sstream>
#include <stdexcept>
#include <string>
#include <vector>

namespace {

std::string g_mlx_error;

void on_mlx_error(const char* message, void*) { g_mlx_error = message ? message : "未知错误"; }

void check(int status, const char* what) {
    if (status == 0) return;
    throw std::runtime_error(std::string(what) + (g_mlx_error.empty() ? "" : ": " + g_mlx_error));
}

struct Candidate {
    int seed;
    int spawn;
    double scale;
    unsigned score;
};

bool better_candidate(const Candidate& a, const Candidate& b) { return a.score != b.score ? a.score > b.score : a.seed < b.seed; }

/* MLX 句柄都是 C 结构体, 用它们自己的释放函数收尾. 释放函数的返回类型有
 * int 和 void 两种, 因此用独立的释放器包装, 而不是直接传函数指针. */
template <typename Handle, typename Release>
struct MlxHandle {
    Handle handle{};
    explicit MlxHandle(Handle value) : handle(value) {}
    MlxHandle(const MlxHandle&) = delete;
    MlxHandle& operator=(const MlxHandle&) = delete;
    ~MlxHandle() { Release{}(handle); }
};

struct ArrayRelease { void operator()(mlx_array value) const { mlx_array_free(value); } };
struct VectorRelease { void operator()(mlx_vector_array value) const { mlx_vector_array_free(value); } };
struct ConfigRelease { void operator()(mlx_fast_metal_kernel_config value) const { mlx_fast_metal_kernel_config_free(value); } };
struct KernelRelease { void operator()(mlx_fast_metal_kernel value) const { mlx_fast_metal_kernel_free(value); } };
struct NameRelease { void operator()(mlx_vector_string value) const { mlx_vector_string_free(value); } };

using Array = MlxHandle<mlx_array, ArrayRelease>;
using ArrayVector = MlxHandle<mlx_vector_array, VectorRelease>;
using KernelConfig = MlxHandle<mlx_fast_metal_kernel_config, ConfigRelease>;
using Kernel = MlxHandle<mlx_fast_metal_kernel, KernelRelease>;
using StringVector = MlxHandle<mlx_vector_string, NameRelease>;

struct Settings {
    long long from = 0;
    long long to = 2147483647;
    int cols = 3400;
    int marker = 141;
    int spawn_lo = 3180;
    int spawn_hi = 3220;
    double tol = .5;
    double offer = .55;
    int batch = 200000;
    std::string scales = "1.00";
    std::string world = "medium";
    bool spawn_given = false;
    int profile_seed = -1;
    int profile_cols = 0;
};

std::string argument(int argc, char** argv, int& index, const std::string& flag) {
    if (index + 1 >= argc) throw std::runtime_error("缺少参数: " + flag);
    return argv[++index];
}

int run_profile(Kernel& kernel, mlx_stream stream, const Settings& settings);

/* 把世界几何写进内核参数数组, 分段边界与 CPU/CUDA 共用一张表. */
void fill_world_params(int32_t *params, const WorldGeom& geom) {
    params[P_WORLD_W] = geom.w;
    params[P_ROLL_LO] = geom.roll_lo;
    params[P_ROLL_HI] = geom.roll_hi;
    params[P_PLATEAU_LO] = geom.plateau_lo;
    params[P_PLATEAU_HI] = geom.plateau_hi;
    params[P_SURF_MIN] = geom.surf_min;
    params[P_SURF_MIN_EPS] = geom.surf_min_eps;
    params[P_SURF_BEACH] = geom.surf_beach;
    params[P_SURF_MAX] = geom.surf_max;
    params[P_DUNGEON_LO0] = (int32_t)((double)geom.w * 0.25);
    params[P_DUNGEON_HI0] = (int32_t)((double)geom.w * 0.40);
    params[P_DUNGEON_LO1] = (int32_t)((double)geom.w * 0.60);
    params[P_DUNGEON_HI1] = (int32_t)((double)geom.w * 0.75);
}

/* 内核调用的公共包装: 准备输出形状, 网格和线程组. */
Array launch(Kernel& kernel, mlx_stream stream, const mlx_array* inputs, size_t input_count, int out_elements,
             int grid, int group) {
    KernelConfig config(mlx_fast_metal_kernel_config_new());
    int shape[1] = {out_elements};
    check(mlx_fast_metal_kernel_config_add_output_arg(config.handle, shape, 1, MLX_INT32), "配置输出");
    check(mlx_fast_metal_kernel_config_set_grid(config.handle, grid, 1, 1), "配置网格");
    check(mlx_fast_metal_kernel_config_set_thread_group(config.handle, group, 1, 1), "配置线程组");
    ArrayVector arguments(mlx_vector_array_new_data(inputs, input_count));
    ArrayVector outputs(mlx_vector_array_new());
    check(mlx_fast_metal_kernel_apply(&outputs.handle, kernel.handle, arguments.handle, config.handle, stream), "启动内核");
    check(mlx_eval(outputs.handle), "等待内核完成");
    mlx_array result{};
    check(mlx_vector_array_get(&result, outputs.handle, 0), "取内核输出");
    return Array(result);
}

}  // namespace

int main(int argc, char** argv) {
    try {
        mlx_set_error_handler(on_mlx_error, nullptr, nullptr);
        if (argc < 2) throw std::runtime_error("用法: sweep-mlx <观测文件> [选项] 或 sweep-mlx --profile <种子> <列数>");
        Settings settings;
        std::string observation_path;
        int first = 1;
        if (std::string(argv[1]) != "--profile") {
            observation_path = argv[1];
            first = 2;
        }
        for (int i = first; i < argc; i++) {
            std::string flag = argv[i];
            if (flag == "--range") {
                settings.from = std::stoll(argument(argc, argv, i, flag));
                settings.to = std::stoll(argument(argc, argv, i, flag));
            } else if (flag == "--tol") {
                settings.tol = std::stod(argument(argc, argv, i, flag));
            } else if (flag == "--offer") {
                settings.offer = std::stod(argument(argc, argv, i, flag));
            } else if (flag == "--cols") {
                settings.cols = std::stoi(argument(argc, argv, i, flag));
            } else if (flag == "--marker") {
                settings.marker = std::stoi(argument(argc, argv, i, flag));
            } else if (flag == "--spawn-lo") {
                settings.spawn_lo = std::stoi(argument(argc, argv, i, flag));
                settings.spawn_given = true;
            } else if (flag == "--spawn-hi") {
                settings.spawn_hi = std::stoi(argument(argc, argv, i, flag));
                settings.spawn_given = true;
            } else if (flag == "--batch") {
                settings.batch = std::stoi(argument(argc, argv, i, flag));
            } else if (flag == "--scales") {
                settings.scales = argument(argc, argv, i, flag);
            } else if (flag == "--world") {
                settings.world = argument(argc, argv, i, flag);
            } else if (flag == "--profile") {
                settings.profile_seed = std::stoi(argument(argc, argv, i, flag));
                settings.profile_cols = std::stoi(argument(argc, argv, i, flag));
            } else if (flag == "--device") {
                ++i;
            } else {
                throw std::runtime_error("未知参数: " + flag);
            }
        }
        WorldGeom geom;
        if (!world_geom_lookup(settings.world.c_str(), &geom)) throw std::runtime_error("未知世界尺寸: " + settings.world);
        if (settings.cols < 1 || settings.cols > geom.w) throw std::runtime_error("列数超出范围");
        if (!settings.spawn_given) {
            settings.spawn_lo = std::max(0, geom.w / 2 - 69);
            settings.spawn_hi = std::min(geom.w - 1, geom.w / 2 + 69);
        }
        if (settings.profile_seed >= 0 && (settings.profile_cols < 1 || settings.profile_cols > geom.w))
            throw std::runtime_error("剖面列数超出范围");
        if (settings.batch < 1) throw std::runtime_error("批大小无效");
        if (settings.from < 0 || settings.to > 2147483647 || settings.from >= settings.to)
            throw std::runtime_error("种子区间无效");
        if (settings.spawn_lo < 0 || settings.spawn_hi < settings.spawn_lo || settings.spawn_hi >= geom.w ||
            settings.spawn_hi >= settings.cols)
            throw std::runtime_error("出生点范围无效");
        if (settings.marker < 0 || settings.marker > 100000) throw std::runtime_error("观测列号无效");
        if (!std::isfinite(settings.tol) || settings.tol < .01 || settings.tol > 10) throw std::runtime_error("容差无效");
        if (!std::isfinite(settings.offer) || settings.offer < 0 || settings.offer > 1) throw std::runtime_error("阈值无效");

        mlx_stream stream = mlx_default_gpu_stream_new();
        const char* profile_input_names[] = {"params"};
        const char* profile_output_names[] = {"profiles"};
        const char* score_input_names[] = {"profiles", "params", "observed", "shifts"};
        const char* score_output_names[] = {"best_out"};
        StringVector profile_inputs(mlx_vector_string_new_data(profile_input_names, 1));
        StringVector score_results(mlx_vector_string_new_data(score_output_names, 1));
        StringVector profile_outputs(mlx_vector_string_new_data(profile_output_names, 1));
        Kernel profile_kernel(mlx_fast_metal_kernel_new("terrain", profile_inputs.handle, profile_outputs.handle,
                                                       kProfileSource, kMetalHeader, true, false));
        StringVector score_inputs(mlx_vector_string_new_data(score_input_names, 4));
        Kernel score_kernel(mlx_fast_metal_kernel_new("score", score_inputs.handle, score_results.handle,
                                                     kScoreSource, "", true, false));

        if (settings.profile_seed >= 0) return run_profile(profile_kernel, stream, settings);

        /* 观测: 与 CPU 版相同的 1/8 格整数化和无效值哨兵. */
        std::ifstream input(observation_path);
        if (!input) throw std::runtime_error("无法读取观测文件");
        std::vector<int32_t> observed;
        double v;
        int valid = 0;
        while (input >> v) {
            if (!std::isfinite(v) || (v != -999 && (v < 0 || v > 1000000))) throw std::runtime_error("观测高度无效");
            observed.push_back(v == -999 ? INT32_MIN : (int32_t)(v * 8 + .5));
            valid += v != -999;
        }
        if (!input.eof() || observed.empty() || observed.size() > 700 || valid < 20)
            throw std::runtime_error("需要至少 20 列有效观测, 且总列数不超过 700");

        std::vector<double> scales;
        std::stringstream scale_stream(settings.scales);
        std::string item;
        while (std::getline(scale_stream, item, ',')) {
            double scale = std::stod(item);
            if (!std::isfinite(scale) || scale < .1 || scale > 10) throw std::runtime_error("尺度无效");
            scales.push_back(scale);
        }
        if (scales.empty() || scales.size() > 8) throw std::runtime_error("尺度数量无效");

        const int obs_n = (int)observed.size();
        const int nscale = (int)scales.size();
        const int nbase = settings.spawn_hi - settings.spawn_lo + 1;
        const int base_lo = settings.spawn_lo - settings.marker;
        std::vector<int32_t> shifts(scales.size() * observed.size());
        int max_shift = 0;
        for (int s = 0; s < nscale; s++) {
            for (int j = 0; j < obs_n; j++) {
                shifts[s * obs_n + j] = (int)(j * scales[s] + .5);
                max_shift = std::max(max_shift, shifts[s * obs_n + j]);
            }
        }
        int w0 = std::max(0, base_lo);
        int w1 = std::min(settings.cols, settings.spawn_hi - settings.marker + max_shift + 1);
        if (w0 >= w1) throw std::runtime_error("观测没有落在模拟列范围内");
        const int width = w1 - w0;
        const int radius = (int)(settings.tol * 8 + 1e-6);

        int obs_shape[1] = {obs_n};
        Array observed_array(mlx_array_new_data(observed.data(), obs_shape, 1, MLX_INT32));
        int shift_shape[1] = {nscale * obs_n};
        Array shift_array(mlx_array_new_data(shifts.data(), shift_shape, 1, MLX_INT32));

        const long long total = settings.to - settings.from;
        if (total <= 0) throw std::runtime_error("种子区间为空");
        /* 剖面缓冲按种子数 x 窗口宽度增长, 用上限约束批大小, 避免在长观测下耗尽统一内存. */
        const size_t buffer_limit = (size_t)768 << 20;
        int batch = (int)std::min<long long>(settings.batch, std::max<long long>(1024, (long long)(buffer_limit / (sizeof(int32_t) * (size_t)width))));
        batch = (int)std::min<long long>(batch, 400000);

        std::cout << "剖面窗口 [" << w0 << ", " << w1 << ") 共 " << width << " 列; 偏移 " << nbase
                  << " 个, 尺度 " << nscale << " 个" << std::endl;
        std::cout << "扫描 " << settings.from << ".." << settings.to << ", 容差 " << settings.tol
                  << ", 阈值 " << settings.offer << ", 批大小 " << batch << ", MLX Metal" << std::endl;
        std::cout << "首个批次包含 Metal 内核编译, 可能需要几秒" << std::endl;

        std::vector<Candidate> candidates;
        candidates.reserve(2000);
        auto save_candidates = [&]() {
            std::vector<Candidate> rows = candidates;
            std::sort(rows.begin(), rows.end(), better_candidate);
            return save_candidate_file("candidates_mlx.txt", [&](std::ostream& output) {
                for (const auto& c : rows)
                    output << "seed=" << c.seed << " spawn_x=" << c.spawn << " scale=" << c.scale
                           << " score=" << (double)c.score / 10000000 << '\n';
            });
        };
        if (!save_candidates()) throw std::runtime_error("无法写入 candidates_mlx.txt");

        long long matched = 0;
        long long done = 0;
        auto started = std::chrono::steady_clock::now();
        for (long long start = settings.from; start < settings.to; start += batch) {
            int nthis = (int)std::min<long long>(batch, settings.to - start);
            int32_t params[P_SIZE] = {};
            params[P_SEED_START] = (int32_t)start;
            params[P_COUNT] = nthis;
            params[P_COLS] = settings.cols;
            params[P_W0] = w0;
            params[P_W1] = w1;
            params[P_OBS_N] = obs_n;
            params[P_NSCALE] = nscale;
            params[P_NBASE] = nbase;
            params[P_RADIUS] = radius;
            params[P_BASE_LO] = base_lo;
            fill_world_params(params, geom);
            int param_shape[1] = {P_SIZE};
            Array params_array(mlx_array_new_data(params, param_shape, 1, MLX_INT32));

            mlx_array profile_input_list[1] = {params_array.handle};
            Array profiles = launch(profile_kernel, stream, profile_input_list, 1, nthis * width, nthis, 128);
            mlx_array score_input_list[4] = {profiles.handle, params_array.handle, observed_array.handle, shift_array.handle};
            Array best = launch(score_kernel, stream, score_input_list, 4, nthis * 2, nthis * 64, 64);

            if (mlx_array_dtype(best.handle) != MLX_INT32) throw std::runtime_error("评分结果类型异常");
            const int32_t* scores = mlx_array_data_int32(best.handle);
            if (!scores) throw std::runtime_error("无法读取评分结果");

            int found = 0;
            for (int i = 0; i < nthis; i++) {
                unsigned score = (unsigned)scores[i * 2];
                int q = scores[i * 2 + 1];
                if (!score) continue;
                if ((double)score / 10000000 < settings.offer) continue;
                found++;
                Candidate candidate{(int)start + i, settings.spawn_lo + q / nscale, scales[q % nscale], score};
                if (candidates.size() < 2000) {
                    candidates.push_back(candidate);
                    std::push_heap(candidates.begin(), candidates.end(), better_candidate);
                } else if (better_candidate(candidate, candidates.front())) {
                    std::pop_heap(candidates.begin(), candidates.end(), better_candidate);
                    candidates.back() = candidate;
                    std::push_heap(candidates.begin(), candidates.end(), better_candidate);
                }
            }
            matched += found;
            done += nthis;
            if (!save_candidates()) throw std::runtime_error("无法写入 candidates_mlx.txt");
            printf("  批 %lld..%lld 完成, 本批达标 %d 条, 累计候选 %lld, 进度 %.3f%%\n",
                   start, start + nthis, found, matched, 100.0 * done / (double)total);
            fflush(stdout);
        }

        std::vector<Candidate> rows = candidates;
        std::sort(rows.begin(), rows.end(), better_candidate);
        double seconds = std::chrono::duration<double>(std::chrono::steady_clock::now() - started).count();
        std::cout << "候选 " << rows.size() << " 个, 前 40:" << std::endl;
        for (size_t i = 0; i < rows.size() && i < 40; i++)
            printf("  seed=%d spawn_x=%d scale=%.2f score=%.4f\n", rows[i].seed, rows[i].spawn, rows[i].scale,
                   (double)rows[i].score / 10000000);
        if (!save_candidates()) throw std::runtime_error("无法写入 candidates_mlx.txt");
        std::cout << "Complete: scanned=" << done << " candidates=" << rows.size() << " matched=" << matched
                  << ", " << (long long)(done / std::max(.001, seconds)) << " seeds/s" << std::endl;
        return 0;
    } catch (const std::exception& error) {
        std::cerr << "MLX 搜索错误: " << error.what() << std::endl;
        return 1;
    }
}

namespace {

/* 输出单个种子的整条剖面, 供测试与 CPU 版逐列对拍. */
int run_profile(Kernel& kernel, mlx_stream stream, const Settings& settings) {
    if (settings.profile_seed < 0) throw std::runtime_error("种子必须非负");
    int32_t params[P_SIZE] = {};
    params[P_SEED_START] = settings.profile_seed;
    params[P_COUNT] = 1;
    params[P_COLS] = settings.profile_cols;
    params[P_W0] = 0;
    params[P_W1] = settings.profile_cols;
    WorldGeom geom;
    world_geom_lookup(settings.world.c_str(), &geom);
    fill_world_params(params, geom);
    int param_shape[1] = {P_SIZE};
    Array params_array(mlx_array_new_data(params, param_shape, 1, MLX_INT32));
    mlx_array input_list[1] = {params_array.handle};
    Array profiles = launch(kernel, stream, input_list, 1, settings.profile_cols, 1, 128);
    const int32_t* values = mlx_array_data_int32(profiles.handle);
    if (!values) throw std::runtime_error("无法读取剖面结果");
    for (int x = 0; x < settings.profile_cols; x++) std::cout << values[x] << ' ';
    std::cout << '\n';
    return 0;
}

}  // namespace

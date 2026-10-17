#pragma once
#include <vector>
#include "../search/candidate-file.h"

#define MAX_OBS 700

// 世界几何与查找函数在共享头里, CUDA/CPU/MLX 用同一份表.
#include "../world-geometry.h"

// 设备无关的搜索输入. 由主机侧填充, 传给 CUDA 编译单元.
struct SweepContext {
    int obs_n;
    double obs[MAX_OBS];
    int obs8[MAX_OBS];
    unsigned char valid[MAX_OBS];
    int shift3[8 * MAX_OBS];
    double scales[8];
    int nscale;
    int cols, w0, w1, W;
    int base_lo, nbase;
    double tol, offer;
    int batch, marker;
    WorldGeom geom;
};

// 一块设备的候选. 主机侧合并各设备的输出.
struct SweepOutput {
    std::vector<int> seed, base, scale;
    std::vector<float> score;
    std::vector<int> live_order;
};

bool sweep_run_device(const SweepContext &ctx, int device, long long from, long long to,
                      const char *candidates_path, bool prefixed, SweepOutput &out);
bool sweep_save_output(const SweepContext &ctx, const SweepOutput &out, const char *path,
                       const std::vector<int> &order);
bool sweep_save_empty(const char *path);
int sweep_device_count();
int sweep_check(int seed, const SweepContext &ctx, int spawn_lo, int spawn_hi, int cols, int marker);

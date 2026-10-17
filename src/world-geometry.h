#pragma once
#include <cstring>

// 世界尺寸与地形分段边界. 与 internal/task/model.go 的 WorldGeometry 以及
// web/gpu/terrain-reference.js 的世界表一一对应, 改动任何一侧都要同步,
// 并用 tests/test_search_backends.py 对拍.
//
// 分段窗口由 WorldGen 的双精度比较导出: [roll_lo, roll_hi] 等价于
// x > W*0.45 && x < W*0.55, [plateau_lo, plateau_hi] 等价于 x > W*0.48 && x < W*0.52.
// 地表限制是 H*0.17 / H*0.23 / H*0.26 的截断. H*0.23 与 H*0.26 在三个尺寸上都是精确整数,
// H*0.17 在小世界和大世界不是 (204.00000000000003 / 408.00000000000006), 用 surf_min_eps 标记,
// 钳制比较因此要含端点, 否则地表停在整数处时会少一次钳制, 随机数消耗随之分叉.
struct WorldGeom {
    int w, h;
    int roll_lo, roll_hi;       // 特征重抽窗口, 含两端
    int plateau_lo, plateau_hi; // 强制平台窗口, 含两端
    int surf_min, surf_min_eps, surf_beach, surf_max;  // surf_min_eps: 下限比整数大一点点, 比较要含端点
};

// 顺序: small, medium, large. 中世界一行必须与既有实现逐位一致.
inline constexpr WorldGeom kWorldGeometries[3] = {
    {4200, 1200, 1891, 2309, 2017, 2183, 204, 1, 276, 312},
    {6400, 1800, 2881, 3520, 3073, 3327, 306, 0, 414, 468},
    {8400, 2400, 3781, 4619, 4033, 4367, 408, 1, 552, 624},
};

// world_geom_lookup 按名字取几何; 空名字或未知名按中世界处理.
inline bool world_geom_lookup(const char *name, WorldGeom *out) {
    *out = kWorldGeometries[1];
    if (!name || !*name) return true;
    if (std::strcmp(name, "small") == 0) { *out = kWorldGeometries[0]; return true; }
    if (std::strcmp(name, "large") == 0) { *out = kWorldGeometries[2]; return true; }
    return std::strcmp(name, "medium") == 0;
}

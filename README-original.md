# Terraria 世界种子反推

从主播直播画面里提取的世界地表剖面, 反推这个泰拉瑞亚世界的生成种子.

## 现状

中世界 (6400x1800, 猩红, 专家) 的全种子空间正在扫描, 剩余时间以扫描器日志为准. 结果会落在 `data/candidates_top.txt` (按当前排序指标降序), 复核排名由守望作业输出.

## 思路

泰拉瑞亚的世界生成是**每步都用同一个种子重新播种**的伪随机序列, 因此只要复刻生成算法的前几个阶段, 就能对任意种子算出它出生点附近的地表剖面:

1. 初始化段 (`WorldGen.Reset` 起 60 次取数) —— 决定海滩位置, 地下层, 世界 ID 等
2. 地形段 (`TerrainPass`) —— 决定出生点附近逐列的地表高度

把截图里的地表剖面提取出来当作观测, 然后用暴力搜索找出与之吻合的种子.

关键性质: 负种子与其绝对值生成完全相同的世界 (随机数初始化对负数取绝对值), 所以只需扫描 [0, 2^31).

## 实现

| 文件 | 作用 |
| --- | --- |
| `tools/sweep.c` | C 扫描器. 每线程独立区间, 支持断点续跑, 定时落盘, 跳过指定区块前缀, 编译期切换世界尺寸 |
| `tools/terrainsim.py` | 地形段的 Python 实现 (与 C 端逐格一致) |
| `tools/setup_beach.py` | 初始化段的 Python 实现 |
| `tools/verify_top.py` | 复核工具: 对候选批量搜索尺度与偏移, 按逐格命中率排序 |
| `tools/final_check.py` | 最终核对: 初始化段字段 + 双观测指标 + 逐条判定 + 对照图 |
| `ref/terraria-decompiled/` | 反编译得到的游戏源码 (仅本地研究用) |

## 关键参数

观测有三种抽取版本 (`data/observed_profile.txt` 与 `observed_profile_v2.txt`), 出生点图标所在列 (452~548) 一律屏蔽.

搜索用 5 个尺度 (1.00 / 0.97 / 1.03 / 0.94 / 1.06) 与出生点 ±40 的偏移范围. 当前排序指标为**逐格命中率** (残差 <= 0.5 格), 它比逐格 1.5 容差的命中率分辨力强得多.

## 判据

真种子在同一观测下应当明显领先:

| 指标 | 假候选实测 | 真种子预期 |
| --- | --- | --- |
| 逐格命中率 (残差 <= 0.5) | 0.22 ~ 0.29 | 0.40 ~ 0.55 |
| 截尾命中率 | 无分辨力, 仅展示 | — |
| spawn_x | 分布较散 | 3200 ± 5 |

判定以**相对间隔**为主: 榜首与后续之间是否存在明显断档, 而不是是否越过某个固定阈值. `tools/final_check.py` 另外核对初始化段字段与交叉观测一致性.

## 复现

```shell
cc -O3 -march=native -pthread -o tools/sweep tools/sweep.c -lm
cc -O3 -march=native -pthread -DWORLD_LARGE -o tools/sweep_large tools/sweep.c -lm
cc -O3 -march=native -pthread -DWORLD_SMALL -o tools/sweep_small tools/sweep.c -lm

./tools/sweep --range 0 2147483647 --threads 8 --nscale 3 \
    --tol 0.5 --offer 0.20 --quick 30 --cols 3550 --resume

python3 tools/verify_top.py data/candidates_top.txt --obs data/observed_profile.txt --top 100
```

## 兜底

若中世界这个前提不成立, 换尺寸重跑时必须显式指定出生点范围与模拟窗口宽度 (默认值是按中世界写死的):

```shell
# 大世界 (8400x1800, 出生点约 4200, 窗口需 >= 4387)
./tools/sweep_large --range 0 2147483647 --threads 16 --nscale 3 \
    --tol 0.5 --offer 0.20 --quick 30 --cols 4500 --spawn 4195 4205 --resume

# 小世界 (4200x1200, 出生点约 2100, 窗口 3550 足够)
./tools/sweep_small --range 0 2147483647 --threads 16 --nscale 3 \
    --tol 0.5 --offer 0.20 --quick 30 --cols 3550 --spawn 2095 2105 --resume
```

## 游戏内核对

世界创建界面填种子前必须对齐三个参数: 大小选**中**, 邪恶选**猩红**, 难度选专家. 三者任一不符都会生成不同的世界.

进入后依次核对: 出生点左右两侧开口朝向出生点的山丘与矿洞入口; 主画面里出生点附近的地表起伏是否与截图一致 (这是搜索所用的那份观测); 右手边近处空岛箱子里的星怒词缀; 金字塔下方紧邻的蘑菇地与其中的龙蛋.

注意: 地图截图是玩家后期改过地形的, 不能作为核对依据; 判据统一以主画面观测为准.

## 记录

技术细节, 验证过程与全部负面结果在 `data/derived.md`.

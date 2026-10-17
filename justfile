[private]
default:
    @just --list

# just serve
# 启动工作台并自动打开浏览器
serve:
    go run . --root . --open

# just web
# 只启服务, 不打开浏览器 (用于远程或调试)
web:
    go run . --root .

# just build
# 编译 CUDA 搜索器, 需要在带 nvcc 的机器上执行.
# 设备代码由 nvcc 编译, 主机入口由普通 C++ 编译器编译, 输出 sweep / sweep.exe.
build:
    uv run --no-project python scripts/build_cuda.py

# 编译主机多线程 CPU 搜索器, 无需 CUDA
build-cpu:
    c++ -O3 -std=c++17 -pthread -ffp-contract=off -o sweep-cpu src/cpu/search.cpp

# just build-mlx
# 编译 macOS 原生 MLX 搜索器 (Apple GPU). 需要先执行: brew install mlx mlx-c
build-mlx:
    c++ -O3 -std=c++17 -I"$(brew --prefix mlx-c)/include" -L"$(brew --prefix mlx)/lib" -L"$(brew --prefix mlx-c)/lib" -Wl,-rpath,"$(brew --prefix mlx)/lib" -Wl,-rpath,"$(brew --prefix mlx-c)/lib" -o sweep-mlx src/mlx/sweep_mlx.cpp -lmlx -lmlxc

# just check
# 快速自检: Go 服务能否编译, 单元测试是否通过 (不需要 GPU)
check:
    go build ./...
    go test ./...

# 根据当前平台生成发布产物 (Go 工作台 + CPU 搜索器 + 可选 CUDA 搜索器)
# 需要本机有 go; CUDA 搜索器只在安装 nvcc 的 Windows/Linux x86_64 上构建.
dist:
    uv run --no-project python scripts/dist.py

# 验证编辑交互, Go 任务调度与后端对拍, 不需要 GPU
test:
    bun test tests/editor.test.mjs tests/editor-ui.test.mjs
    go test ./...
    python3 -B -m unittest discover -s tests -p 'test_*.py' -v

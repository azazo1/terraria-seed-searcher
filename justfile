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
# Windows 使用 -utf-8, 避免 Git Bash 将 /utf-8 转换成文件路径.
# 编译 CUDA 搜索器. 需要在带 nvcc 的机器上执行 (本机 macOS 无 CUDA, 会失败).
# 多卡直接给搜索器传 --device all, 工作台的 GPU 编号填 -1.
build:
    nvcc -O3 -arch=sm_89 {{if os() == "windows" { "-Xcompiler=-utf-8 -Xcompiler=-EHsc" } else { "" }}} -o {{if os() == "windows" { "sweep.exe" } else { "sweep" }}} src/cuda/sweep.cu

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

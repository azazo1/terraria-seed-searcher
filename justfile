[private]
default:
    @just --list

# just serve
# 启动控制台并自动打开浏览器
serve:
    python3 serve.py --open

# just web
# 只启服务, 不打开浏览器 (用于远程或调试)
web:
    python3 serve.py

# just build
# 编译 CUDA 搜索器. 需要在带 nvcc 的机器上执行 (本机 macOS 无 CUDA, 会失败).
build:
    nvcc -O3 -arch=sm_89 -o {{if os() == "windows" { "sweep2.exe" } else { "sweep2" }}} src/cuda/sweep2.cu

# 编译主机多线程 CPU 搜索器, 无需 CUDA
build-cpu:
    c++ -O3 -std=c++17 -pthread -ffp-contract=off -o sweep-cpu src/cpu/search.cpp

# just check
# 快速自检: 控制台能否正常读状态 (不需要 GPU)
check:
    python3 -c "import serve; serve.ensure_dirs(); print('目录就绪:', serve.FRAMES, serve.DATA, serve.WORK)"

# 验证编辑交互, 自动保存与隔离接口, 不需要 GPU
test:
    bun test tests/editor.test.mjs tests/editor-ui.test.mjs
    python3 -B -m unittest discover -s tests -p 'test_*.py' -v

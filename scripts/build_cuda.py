#!/usr/bin/env python3

# 编译 CUDA 搜索器. 设备代码用 nvcc 编译, 主机入口用普通 C++ 编译器编译,
# 这样 <thread> / <atomic> 不会进入 nvcc 的 cudafe++.
#
# 直接运行: uv run --no-project python scripts/build_cuda.py
# 产物写到当前目录的 sweep (Windows 为 sweep.exe).

import os
import re
import shutil
import sys
from pathlib import Path

import release_common as rc

CUDA_ARCHS_12 = ["50", "52", "60", "61", "70", "75", "80", "86", "89", "90", "120"]
CUDA_ARCHS_12_OLD = ["50", "52", "60", "61", "70", "75", "80", "86", "89", "90"]
CUDA_ARCHS_13 = ["75", "80", "86", "89", "90", "120"]


def architectures(nvcc):
    text = rc.run([nvcc, "--version"])
    match = re.search(r"release (\d+)\.(\d+)", text)
    if not match:
        return CUDA_ARCHS_12
    major, minor = int(match.group(1)), int(match.group(2))
    if major >= 13:
        return CUDA_ARCHS_13
    if (major, minor) >= (12, 8):
        return CUDA_ARCHS_12
    return CUDA_ARCHS_12_OLD


def compile_cuda(output, platform_name, staging, nvcc):
    """编译 sweep.cu 与 sweep_main.cpp 并链接成 output."""
    staging = Path(staging)
    staging.mkdir(parents=True, exist_ok=True)
    suffix = ".obj" if platform_name == "windows" else ".o"
    device_obj = staging / ("sweep" + suffix)
    main_obj = staging / ("sweep_main" + suffix)
    output = Path(output)

    device_args = [nvcc, "-O3", "-std=c++17", "-fmad=false", "-c", "src/cuda/sweep.cu", "-o", str(device_obj)]
    for arch in architectures(nvcc):
        device_args += ["-gencode", f"arch=compute_{arch},code=sm_{arch}"]
    device_args += ["-gencode", "arch=compute_90,code=compute_90"]
    if platform_name == "windows":
        device_args += ["-Xcompiler=-utf-8", "-Xcompiler=-EHsc", "-allow-unsupported-compiler"]
    else:
        device_args += ["-Xcompiler=-pthread"]
    rc.run(device_args, capture=False)

    if platform_name == "windows":
        rc.run(
            [
                "cl", "/nologo", "/O2", "/std:c++17", "/EHsc", "/MD", "/utf-8",
                "/c", "src/cuda/sweep_main.cpp", f"/Fo:{main_obj}",
            ],
            capture=False,
        )
        link_args = [nvcc, str(main_obj), str(device_obj), "-o", str(output), "-cudart", "static"]
    else:
        rc.run(
            ["c++", "-O3", "-std=c++17", "-pthread", "-c", "src/cuda/sweep_main.cpp", "-o", str(main_obj)],
            capture=False,
        )
        link_args = [nvcc, str(main_obj), str(device_obj), "-o", str(output), "-cudart", "static", "-Xcompiler=-pthread"]
    rc.run(link_args, capture=False)

    for leftover in (device_obj, main_obj):
        leftover.unlink(missing_ok=True)
    return output


def main():
    rc.configure_output_encoding()
    rc.repo_root()
    platform_name = rc.detect_platform()
    nvcc = shutil.which("nvcc")
    if not nvcc:
        rc.die("未找到 nvcc, 请在带 CUDA Toolkit 的开发者终端中运行.")
    output = Path("sweep.exe" if platform_name == "windows" else "sweep")
    compile_cuda(output, platform_name, Path(".tmp/cuda-build"), nvcc)
    print(f"已生成 {output}")


if __name__ == "__main__":
    main()

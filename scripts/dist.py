#!/usr/bin/env python3

# 构建 terraria-seed-searcher 的发布产物, 复制到项目 scripts/dist.py.
# 由 just dist 调用, 也可直接运行:
#   uv run --no-project python scripts/dist.py
#
# 产物: Go 工作台 (页面已嵌入) + 主机 CPU 搜索器 + 可选 CUDA 搜索器.
# CUDA 搜索器只在 windows/linux x86_64 且本机存在 nvcc 时构建, 使用静态 cudart,
# 用户只需要 NVIDIA 驱动, 不需要安装 CUDA Toolkit.

import os
import re
import shutil
import sys
from pathlib import Path

import release_common as rc

PROJECT_NAME = "terraria-seed-searcher"
# 仓库还没有版本 tag 时的基础版本号; 首个 tag 之后由 git 提供.
PACKAGE_VERSION = "0.0.0"

# CUDA 12.8 覆盖 Maxwell 到 Blackwell; CUDA 13 只保留 Turing 及以后.
CUDA_ARCHS_12 = ["50", "52", "60", "61", "70", "75", "80", "86", "89", "90", "120"]
CUDA_ARCHS_12_OLD = ["50", "52", "60", "61", "70", "75", "80", "86", "89", "90"]
CUDA_ARCHS_13 = ["75", "80", "86", "89", "90", "120"]


def executable_name(name, platform_name):
    return name + ".exe" if platform_name == "windows" else name


def build_go(display_version, staging, platform_name):
    output = staging / executable_name(PROJECT_NAME, platform_name)
    environment = os.environ.copy()
    environment["CGO_ENABLED"] = "0"
    rc.run(
        [
            "go", "build", "-trimpath",
            "-ldflags", f"-s -w -X main.buildVersion={display_version}",
            "-o", str(output), ".",
        ],
        env=environment,
        capture=False,
    )
    return output


def build_cpu(staging, platform_name):
    output = staging / executable_name("sweep-cpu", platform_name)
    if platform_name == "windows":
        rc.run(
            [
                "cl", "/nologo", "/O2", "/std:c++17", "/EHsc", "/MT", "/utf-8",
                f"/Fo:{staging / 'search.obj'}", f"/Fe:{output}", "src/cpu/search.cpp",
            ],
            capture=False,
        )
        return output
    rc.run(
        [
            "c++", "-O3", "-std=c++17", "-pthread", "-ffp-contract=off",
            "-o", str(output), "src/cpu/search.cpp",
        ],
        capture=False,
    )
    return output


def cuda_architectures(nvcc):
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


def build_cuda(staging, platform_name):
    nvcc = shutil.which("nvcc")
    if not nvcc:
        print("未找到 nvcc, 跳过 CUDA 搜索器.")
        return None
    output = staging / executable_name("sweep", platform_name)
    arguments = [nvcc, "-O3", "-std=c++17", "-fmad=false", "-cudart", "static"]
    for arch in cuda_architectures(nvcc):
        arguments += ["-gencode", f"arch=compute_{arch},code=sm_{arch}"]
    # 留一份较新的 PTX, 让比本次编译更新的显卡也能 JIT.
    arguments += ["-gencode", "arch=compute_90,code=compute_90"]
    if platform_name == "windows":
        arguments += ["-Xcompiler=-utf-8", "-Xcompiler=-EHsc", "-allow-unsupported-compiler"]
    else:
        arguments += ["-Xcompiler=-pthread"]
    arguments += ["-o", str(output), "src/cuda/sweep.cu"]
    rc.run(arguments, capture=False)
    return output


def main():
    rc.configure_output_encoding()
    rc.repo_root()
    display_version, archive_version = rc.resolve_versions(rc.script_path("build-version.py"), PACKAGE_VERSION)
    platform_name = rc.target_platform()
    arch = rc.target_arch()
    print(f"构建版本 {display_version}, 产物版本 {archive_version}, 目标 {platform_name}-{arch}")

    staging = Path(rc.stage_dir())
    workbench = build_go(display_version, staging, platform_name)
    cpu = build_cpu(staging, platform_name)
    for leftover in ("search.obj", "search.pdb", "search.ilk"):
        (staging / leftover).unlink(missing_ok=True)
    cuda = None
    if platform_name in ("windows", "linux") and arch == "x86_64":
        cuda = build_cuda(staging, platform_name)

    rc.smoke_check([str(workbench)], ["--version"], display_version)
    rc.check_binary_format(str(cpu), platform_name)
    if cuda:
        rc.check_binary_format(str(cuda), platform_name)

    rc.archive(str(staging), [], PROJECT_NAME, archive_version, target=(platform_name, arch))


if __name__ == "__main__":
    main()

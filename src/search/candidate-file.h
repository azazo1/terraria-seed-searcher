// 主机搜索候选快照的跨平台原子替换.
#pragma once
#include <cstdio>
#include <fstream>
#include <iomanip>
#include <string>
#ifdef _WIN32
#ifndef NOMINMAX
#define NOMINMAX
#endif
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <windows.h>
#endif

template <typename Write>
bool save_candidate_file(const char* path, Write write) {
    const std::string temporary = std::string(path) + ".tmp";
    std::ofstream output(temporary, std::ios::trunc);
    if (!output) return false;
    output << std::setprecision(9);
    write(output);
    output.close();
    if (!output) return false;
#ifdef _WIN32
    // Windows 读者短暂打开旧快照时可能禁止替换, 等待其读完后重试.
    for (int attempt = 0; attempt < 50; attempt++) {
        if (MoveFileExA(temporary.c_str(), path, MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH)) return true;
        DWORD error = GetLastError();
        if (error != ERROR_SHARING_VIOLATION && error != ERROR_ACCESS_DENIED) return false;
        Sleep(10);
    }
    return false;
#else
    return std::rename(temporary.c_str(), path) == 0;
#endif
}

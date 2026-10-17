/* 主机多线程 CPU 粗筛, 与 CUDA 共用 RNG 和 TerrainPass. */
#define TERRARIA_HOST_ONLY
#include "../cuda/sweep.cu"
#include <atomic>
#include <chrono>
#include <csignal>
#include <fstream>
#include <iostream>
#include <iomanip>
#include <mutex>
#include <thread>
#include <sstream>
#include <stdexcept>

static_assert(std::atomic<bool>::is_always_lock_free, "stop flag must be signal-safe");
static std::atomic<bool> interrupted(false);
static void stop_search(int) { interrupted.store(true, std::memory_order_relaxed); }
struct Candidate { int seed, spawn; double scale; unsigned score; };
static bool better_candidate(const Candidate& a, const Candidate& b) { return a.score != b.score ? a.score > b.score : a.seed < b.seed; }
static unsigned score_profile(const std::vector<int>& profile, const std::vector<int>& obs, const std::vector<int>& shifts, int base, int lo, int hi, int radius) {
    int hist[33] = {}, count = 0, first = 0; bool have = false;
    for (size_t j = 0; j < obs.size(); j++) {
        if (obs[j] == -2147483647 - 1) continue;
        int x = base + shifts[j]; if (x < lo || x >= hi) continue;
        int d = profile[x - lo] - obs[j]; if (!have) { first = d; have = true; }
        d -= first; if (d >= -16 && d <= 16) hist[d + 16]++; count++;
    }
    if (count < 20) return 0;
    int accumulated = 0, median = 16;
    for (int k = 0; k < 33; k++) { accumulated += hist[k]; if (accumulated >= count / 2) { median = k; break; } }
    int hits = 0; for (int k = std::max(0, median - radius); k <= std::min(32, median + radius); k++) hits += hist[k];
    return (unsigned)((unsigned long long)hits * 10000000ull / (unsigned)count);
}
int main(int argc, char** argv) {
    try {
        if ((argc == 4 || argc == 6) && std::string(argv[1]) == "--profile") {
            int seed = std::stoi(argv[2]), cols = std::stoi(argv[3]);
            std::string world = "medium";
            if (argc == 6) { if (std::string(argv[4]) != "--world") throw std::runtime_error("unknown profile argument: " + std::string(argv[4])); world = argv[5]; }
            WorldGeom geom; if (!world_geom_lookup(world.c_str(), &geom)) throw std::runtime_error("unknown world: " + world);
            if (seed < 0 || cols < 1 || cols > geom.w) throw std::runtime_error("invalid profile arguments");
            int state[56]; unsigned index = 0; RNG r = {state, &index}; std::vector<int> out(cols); generate_profile(&r, seed, cols, 0, cols, out.data(), geom);
            for (int v : out) std::cout << v << ' '; std::cout << '\n'; return 0;
        }
        if (argc < 2) throw std::runtime_error("missing observation path");
        bool spawn_given = false;
        long long from = 0, to = 2147483647; int cols = 3400, marker = 141, low = 3180, high = 3220, threads = (int)std::min(64u, std::max(1u, std::thread::hardware_concurrency())); double tolerance = .5, offer = .55; std::string scale_text = "1.00", world = "medium";
        for (int i = 2; i < argc; i++) {
            std::string flag = argv[i]; if (i + 1 >= argc) throw std::runtime_error("missing argument: " + flag);
            if (flag == "--range") { from = std::stoll(argv[++i]); if (i + 1 >= argc) throw std::runtime_error("missing range end"); to = std::stoll(argv[++i]); }
            else if (flag == "--cols") cols = std::stoi(argv[++i]); else if (flag == "--marker") marker = std::stoi(argv[++i]);
            else if (flag == "--spawn-lo") { low = std::stoi(argv[++i]); spawn_given = true; } else if (flag == "--spawn-hi") { high = std::stoi(argv[++i]); spawn_given = true; }
            else if (flag == "--tol") tolerance = std::stod(argv[++i]); else if (flag == "--offer") offer = std::stod(argv[++i]);
            else if (flag == "--scales") scale_text = argv[++i]; else if (flag == "--threads") threads = std::stoi(argv[++i]);
            else if (flag == "--world") world = argv[++i];
            else if (flag == "--batch" || flag == "--device") ++i; else throw std::runtime_error("unknown argument: " + flag);
        }
        WorldGeom geom; if (!world_geom_lookup(world.c_str(), &geom)) throw std::runtime_error("unknown world: " + world);
        if (!spawn_given) { low = std::max(0, geom.w / 2 - 69); high = std::min(geom.w - 1, geom.w / 2 + 69); }
        if (high >= cols) throw std::runtime_error("cols 太小, 这个世界的出生点需要更大的模拟列数");
        if (from < 0 || to > 2147483647 || from >= to || cols < 1 || cols > geom.w || low < 0 || high < low || high >= geom.w || high >= cols || marker < 0 || marker > 100000 || threads < 1 || threads > 256 || !std::isfinite(tolerance) || tolerance < .01 || tolerance > 10 || !std::isfinite(offer) || offer < 0 || offer > 1) throw std::runtime_error("invalid search parameters");
        std::ifstream input(argv[1]); if (!input) throw std::runtime_error("cannot read observation"); std::vector<int> obs; double v; int valid = 0;
        while (input >> v) { if (!std::isfinite(v) || (v != -999 && (v < 0 || v > 1000000))) throw std::runtime_error("invalid observation height"); obs.push_back(v == -999 ? -2147483647 - 1 : (int)(v * 8 + .5)); valid += v != -999; }
        if (!input.eof() || obs.empty() || obs.size() > 700 || valid < 20) throw std::runtime_error("need 20 valid columns and at most 700 total columns");
        std::vector<double> scales; std::stringstream scale_stream(scale_text); std::string item;
        while (std::getline(scale_stream, item, ',')) { double scale = std::stod(item); if (!std::isfinite(scale) || scale < .1 || scale > 10) throw std::runtime_error("invalid scale"); scales.push_back(scale); }
        if (scales.empty() || scales.size() > 8) throw std::runtime_error("invalid scales");
        std::vector<std::vector<int>> shifts(scales.size(), std::vector<int>(obs.size())); int max_shift = 0;
        for (size_t s = 0; s < scales.size(); s++) for (size_t j = 0; j < obs.size(); j++) { shifts[s][j] = (int)(j * scales[s] + .5); max_shift = std::max(max_shift, shifts[s][j]); }
        int base = low - marker, lo = std::max(0, base), hi = std::min(cols, high - marker + max_shift + 1); if (lo >= hi) throw std::runtime_error("observation does not overlap simulated columns");
        std::signal(SIGTERM, stop_search); std::signal(SIGINT, stop_search);
        std::atomic<long long> next(from), done(0), matched(0); std::atomic<int> alive(threads); std::mutex mutex; std::vector<Candidate> candidates;
        const auto started = std::chrono::steady_clock::now(); std::vector<std::thread> workers;
        std::cout << "Host CPU: " << threads << " threads, seeds [" << from << ", " << to << "), columns " << cols
                  << ", world " << geom.w << " x " << geom.h << std::endl;
        auto save_candidates = [&]() {
            std::vector<Candidate> rows;
            { std::lock_guard<std::mutex> guard(mutex); rows = candidates; }
            std::sort(rows.begin(), rows.end(), better_candidate);
            return save_candidate_file("candidates_cpu.txt", [&](std::ostream& output) {
                for (const auto& c : rows) output << "seed=" << c.seed << " spawn_x=" << c.spawn << " scale=" << c.scale << " score=" << (double)c.score / 10000000 << '\n';
            });
        };
        if (!save_candidates()) throw std::runtime_error("cannot initialize candidates_cpu.txt");
        for (int worker = 0; worker < threads; worker++) workers.emplace_back([&]() {
            int state[56]; unsigned index = 0; RNG r = {state, &index}; std::vector<int> profile(hi - lo);
            while (!interrupted) {
                long long seed = next.fetch_add(1); if (seed >= to) break; generate_profile(&r, (int)seed, cols, lo, hi, profile.data(), geom);
                unsigned best = 0; int best_q = 0;
                for (int b = low; b <= high; b++) for (size_t s = 0; s < scales.size(); s++) {
                    unsigned score = score_profile(profile, obs, shifts[s], b - marker, lo, hi, (int)(tolerance * 8 + 1e-6)); int q = (b - low) * (int)scales.size() + (int)s;
                    if (score > best || (score == best && q > best_q)) { best = score; best_q = q; }
                }
                if (best && (double)best / 10000000 >= offer) {
                    matched++; std::lock_guard<std::mutex> guard(mutex);
                    Candidate candidate = {(int)seed, low + best_q / (int)scales.size(), scales[best_q % scales.size()], best};
                    // 只保留最高分的 2000 条, 防止低阈值的大范围搜索耗尽主机内存.
                    if (candidates.size() < 2000) { candidates.push_back(candidate); std::push_heap(candidates.begin(), candidates.end(), better_candidate); }
                    else if (better_candidate(candidate, candidates.front())) { std::pop_heap(candidates.begin(), candidates.end(), better_candidate); candidates.back() = candidate; std::push_heap(candidates.begin(), candidates.end(), better_candidate); }
                }
                done++;
            }
            alive--;
        });
        int tick = 0;
        bool saved = true;
        while (alive > 0) {
            std::this_thread::sleep_for(std::chrono::milliseconds(250));
            if (++tick % 4 == 0) {
                saved = save_candidates();
                if (!saved) { interrupted = true; break; }
                double seconds = std::chrono::duration<double>(std::chrono::steady_clock::now() - started).count();
                std::lock_guard<std::mutex> guard(mutex);
                std::cout << "Progress " << done << '/' << to - from << ", " << (long long)(done / std::max(.001, seconds)) << " seeds/s, matched " << matched << ", retained " << candidates.size() << std::endl;
            }
        }
        for (auto& worker : workers) worker.join();
        if (!saved || !save_candidates()) throw std::runtime_error("cannot save candidates_cpu.txt");
        std::cout << (interrupted ? "Stopped" : "Complete") << ": scanned=" << done << " candidates=" << candidates.size() << " matched=" << matched << std::endl; return 0;
    } catch (const std::exception& error) { std::cerr << "CPU search error: " << error.what() << std::endl; return 1; }
}

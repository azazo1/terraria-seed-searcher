"""原生共享地形与浏览器参考实现对拍, 仅使用合成观测."""
import json
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
import threading
import time
from unittest.mock import patch
import search_tasks

ROOT = Path(__file__).resolve().parents[1]


@unittest.skipUnless(shutil.which("c++") and shutil.which("bun"), "需要 c++ 和 bun 对拍原生内核")
class SearchBackendsTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        (ROOT / ".tmp").mkdir(exist_ok=True)
        cls.temp = tempfile.TemporaryDirectory(prefix="search-test-", dir=ROOT / ".tmp")
        cls.scratch = Path(cls.temp.name)
        cls.binary = cls.scratch / "search-cpu"
        subprocess.run(["c++", "-O2", "-std=c++17", "-pthread", "-ffp-contract=off", str(ROOT / "src/cpu/search.cpp"), "-o", str(cls.binary)], check=True, capture_output=True)

    @classmethod
    def tearDownClass(cls):
        cls.temp.cleanup()

    def js(self, expression):
        return json.loads(subprocess.check_output(["bun", "-e", "import {terrainProfile,scoreProfile} from './web/gpu/terrain-reference.js'; console.log(JSON.stringify(" + expression + "))"], cwd=ROOT, text=True))

    def test_full_profiles_match_native_shared_cuda_code(self):
        seeds = [0, 1, 42, 161803397, 161803398, 161803399, 1073741823, 2147483646]
        seed = 1234567
        for _ in range(16):
            seed = (seed * 48271) % 2147483647
            seeds.append(seed)
        hashes = self.js("(" + json.dumps(seeds) + ").map(seed=>{let hash=2166136261;for(const v of terrainProfile(seed,6400))hash=Math.imul(hash^v,16777619)>>>0;return hash})")
        for seed, expected in zip(seeds, hashes):
            output = subprocess.check_output([str(self.binary), "--profile", str(seed), "6400"], text=True)
            values = [int(v) for v in output.split()]
            self.assertEqual(len(values), 6400)
            actual = 2166136261
            for value in values:
                actual = ((actual ^ value) * 16777619) & 0xFFFFFFFF
            self.assertEqual(actual, expected, f"seed={seed}")

    def test_cpu_process_stops_and_saves_partial_results(self):
        path = self.scratch / "stop-fixture.txt"
        path.write_text(" ".join(["0"] * 30))
        proc = subprocess.Popen([str(self.binary), str(path), "--range", "0", "2147483647", "--threads", "2", "--offer", ".01"], cwd=self.scratch, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        try:
            # 首行在信号处理器注册之后输出, 再发送终止请求不会丢掉收尾逻辑.
            self.assertTrue(proc.stdout.readline())
            self.assertTrue(proc.stdout.readline().startswith("Progress "))
            self.assertIsNone(proc.poll())
            live_rows = (self.scratch / "candidates_cpu.txt").read_text().splitlines()
            self.assertGreater(len(live_rows), 0)
            scores = [float(dict(field.split("=", 1) for field in row.split())["score"]) for row in live_rows]
            self.assertEqual(scores, sorted(scores, reverse=True))
            proc.terminate()
            proc.communicate(timeout=5)
            self.assertEqual(proc.returncode, 0)
            self.assertTrue((self.scratch / "candidates_cpu.txt").is_file())
        finally:
            if proc.poll() is None:
                proc.kill()
                proc.communicate()

    def test_real_cpu_pause_restart_and_resume_matches_uninterrupted_search(self):
        observation = {"format": "terraria-seed-searcher/observation", "version": 1, "heights": [0] * 30, "marker": 10}
        settings = {"range": [40, 136], "offer": .01}
        directory = self.scratch / "resume-fixture"
        manager = search_tasks.TaskManager(directory, {"cpu": self.binary}, "fixture")
        original = search_tasks.TaskStore.commit
        def commit(store, *args, **kwargs):
            meta = original(store, *args, **kwargs)
            manager.stop(meta["id"])
            return meta
        def wait(current, task_id, status):
            deadline = time.monotonic() + 10
            while time.monotonic() < deadline:
                if current.summary(task_id)["status"] == status and task_id not in current.runtime: return
                threading.Event().wait(.01)
            self.fail(f"native task did not reach {status}")
        with patch.object(search_tasks, "CPU_BLOCK", 32):
            with patch.object(search_tasks.TaskStore, "commit", commit):
                payload = manager.create("cpu", settings, observation); task_id = payload["task"]["id"]
                wait(manager, task_id, "paused")
            self.assertEqual(manager.store(task_id).read()["next"], 72)
            restarted = search_tasks.TaskManager(directory, {"cpu": self.binary}, "fixture")
            restarted.resume(task_id); wait(restarted, task_id, "completed")
        baseline = manager.store(task_id).directory / "baseline"
        baseline.mkdir()
        command = [str(self.binary), str(manager.store(task_id).directory / "observed.txt"), "--range", "40", "136", "--marker", "10", "--offer", ".01"]
        subprocess.run(command, cwd=baseline, check=True, capture_output=True)
        rows = search_tasks.candidate_rows(baseline / "candidates_cpu.txt")
        self.assertEqual(sorted(restarted.store(task_id).rows(), key=lambda row: row["seed"]), sorted(rows, key=lambda row: row["seed"]))
        self.assertEqual(restarted.summary(task_id)["progress"]["scanned"], 96)
        worker_code = '''import sys, threading
from pathlib import Path
import search_tasks
search_tasks.CPU_BLOCK = 32
manager = search_tasks.TaskManager(Path(sys.argv[1]), {"cpu": Path(sys.argv[2])}, "fixture")
payload = manager.create("cpu", {"range": [40, 136], "offer": .01}, {"format": "terraria-seed-searcher/observation", "version": 1, "heights": [0] * 30, "marker": 10})
print(payload["task"]["id"], flush=True)
threading.Event().wait(30)
'''
        crash_directory = self.scratch / "crash-fixture"
        service = subprocess.Popen([sys.executable, "-B", "-c", worker_code, str(crash_directory), str(self.binary)], cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        try:
            crash_id = service.stdout.readline().strip()
            self.assertEqual(len(crash_id), 32)
        finally:
            service.kill(); service.communicate(timeout=5)
        recovered = search_tasks.TaskManager(crash_directory, {"cpu": self.binary}, "fixture")
        self.assertEqual(recovered.summary(crash_id)["status"], "interrupted")
        with patch.object(search_tasks, "CPU_BLOCK", 32):
            recovered.resume(crash_id); wait(recovered, crash_id, "completed")
        self.assertEqual(sorted(recovered.store(crash_id).rows(), key=lambda row: row["seed"]), sorted(rows, key=lambda row: row["seed"]))

    def test_native_cpu_candidates_match_browser_scoring(self):
        profile = self.js("Array.from(terrainProfile(42,3400))")
        heights = [-999 if j % 7 == 0 else (profile[3100 + j] - profile[3100]) / 8 + 30 for j in range(96)]
        observation = {"heights": heights, "marker": 100}
        settings = {"range": [40, 45], "cols": 3400, "spawn_lo": 3198, "spawn_hi": 3202, "scales": ".97,1.00,1.03", "tol": .5, "offer": .1}
        expected = self.js(f"[40,41,42,43,44].map(seed=>({{seed,...scoreProfile(terrainProfile(seed,3400),{json.dumps(observation)},{json.dumps(settings)})}})).filter(row=>row.quantized/10000000>=.1)")
        path = self.scratch / "observed-fixture.txt"
        path.write_text(" ".join(map(str, heights)))
        command = [str(self.binary), str(path), "--range", "40", "45", "--cols", "3400", "--marker", "100", "--spawn-lo", "3198", "--spawn-hi", "3202", "--scales", ".97,1.00,1.03", "--tol", ".5", "--offer", ".1", "--threads", "2"]
        result = subprocess.run(command, cwd=self.scratch, check=True, capture_output=True, text=True)
        self.assertIn("scanned=5", result.stdout)
        rows = [dict(field.split("=", 1) for field in line.split()) for line in (self.scratch / "candidates_cpu.txt").read_text().splitlines()]
        self.assertEqual({int(row["seed"]) for row in rows}, {row["seed"] for row in expected})
        for row in rows:
            match = next(v for v in expected if v["seed"] == int(row["seed"]))
            self.assertEqual(int(row["spawn_x"]), match["spawn"])
            self.assertEqual(float(row["scale"]), match["scale"])
            self.assertAlmostEqual(float(row["score"]), match["quantized"] / 10000000, places=7)


def homebrew_prefix(name):
    try:
        return Path(subprocess.check_output(["brew", "--prefix", name], text=True, stderr=subprocess.DEVNULL).strip())
    except (OSError, subprocess.CalledProcessError):
        return None


@unittest.skipUnless(sys.platform == "darwin", "MLX 后端只在 macOS 上有意义")
class MlxBackendTest(unittest.TestCase):
    """MLX 后端与 CPU 后端对拍, 只使用合成观测."""

    @classmethod
    def setUpClass(cls):
        mlx, mlxc = homebrew_prefix("mlx"), homebrew_prefix("mlx-c")
        if not (mlx and mlxc and shutil.which("c++")):
            raise unittest.SkipTest("需要 homebrew 的 mlx 和 mlx-c")
        (ROOT / ".tmp").mkdir(exist_ok=True)
        cls.temp = tempfile.TemporaryDirectory(prefix="mlx-test-", dir=ROOT / ".tmp")
        cls.scratch = Path(cls.temp.name)
        cls.cpu = cls.scratch / "search-cpu"
        cls.mlx = cls.scratch / "sweep-mlx"
        subprocess.run(["c++", "-O2", "-std=c++17", "-pthread", "-ffp-contract=off", str(ROOT / "src/cpu/search.cpp"), "-o", str(cls.cpu)], check=True, capture_output=True)
        subprocess.run([
            "c++", "-O2", "-std=c++17", f"-I{mlxc / 'include'}", f"-L{mlx / 'lib'}", f"-L{mlxc / 'lib'}",
            f"-Wl,-rpath,{mlx / 'lib'}", f"-Wl,-rpath,{mlxc / 'lib'}",
            str(ROOT / "src/mlx/sweep_mlx.cpp"), "-o", str(cls.mlx), "-lmlx", "-lmlxc",
        ], check=True, capture_output=True)

    @classmethod
    def tearDownClass(cls):
        cls.temp.cleanup()

    def profile(self, binary, seed, extra=()):
        return subprocess.check_output([str(binary), "--profile", str(seed), "3400", *extra], text=True).split()

    def test_gpu_profile_matches_cpu_column_by_column(self):
        for seed in (0, 42):
            self.assertEqual(self.profile(self.mlx, seed), self.profile(self.cpu, seed), f"seed={seed}")

    def test_gpu_search_matches_cpu_candidates(self):
        profile = [int(value) for value in self.profile(self.cpu, 1234567)]
        heights = [profile[3050 + j] / 8.0 for j in range(85)]
        path = self.scratch / "observed-mlx.txt"
        path.write_text(" ".join(f"{value:.6f}" for value in heights))
        arguments = ["--range", "1234500", "1234600", "--cols", "3400", "--marker", "141", "--spawn-lo", "3180",
                     "--spawn-hi", "3220", "--tol", ".5", "--offer", ".5"]
        cpu_dir, mlx_dir = self.scratch / "cpu", self.scratch / "mlx"
        cpu_dir.mkdir()
        mlx_dir.mkdir()
        cpu = subprocess.run([str(self.cpu), str(path), *arguments, "--threads", "2"], cwd=cpu_dir, check=True, capture_output=True, text=True)
        gpu = subprocess.run([str(self.mlx), str(path), *arguments], cwd=mlx_dir, check=True, capture_output=True, text=True)
        self.assertIn("scanned=100", cpu.stdout)
        self.assertIn("scanned=100", gpu.stdout)
        self.assertEqual(re.search(r"matched=(\d+)", gpu.stdout)[1], re.search(r"matched=(\d+)", cpu.stdout)[1])
        expected = (cpu_dir / "candidates_cpu.txt").read_text().splitlines()
        actual = (mlx_dir / "candidates_mlx.txt").read_text().splitlines()
        self.assertTrue(expected)
        self.assertEqual(actual, expected)

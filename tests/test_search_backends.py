"""原生共享地形与浏览器参考实现对拍, 仅使用合成观测."""
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

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
        proc = subprocess.Popen([str(self.binary), str(path), "--range", "0", "2147483647", "--threads", "2"], cwd=self.scratch, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        try:
            # 首行在信号处理器注册之后输出, 再发送终止请求不会丢掉收尾逻辑.
            self.assertTrue(proc.stdout.readline())
            proc.terminate()
            proc.communicate(timeout=5)
            self.assertEqual(proc.returncode, 0)
            self.assertTrue((self.scratch / "candidates_cpu.txt").is_file())
        finally:
            if proc.poll() is None:
                proc.kill()
                proc.communicate()

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

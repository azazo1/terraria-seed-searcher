"""主机搜索进度的边界和结束状态, 全部使用合成输出."""
from pathlib import Path
import tempfile
import unittest
import threading
from unittest.mock import Mock, patch

import search_progress


class SearchProgressTest(unittest.TestCase):
    def test_nonzero_cuda_range_and_cpu_final_counts(self):
        text = "  批 100..140 完成, 本批达标 3 条, 累计候选 3, 进度 40.000%\n"
        progress = search_progress.parse_progress(text, "cuda", [100, 200])
        self.assertEqual(progress, {"scanned": 40, "total": 100, "next": 140, "candidates": 3})
        progress = search_progress.parse_progress("Progress 40/100, 10 seeds/s, matched 3000, retained 2000\nComplete: scanned=100 candidates=2000\n", "cpu", [100, 200])
        self.assertEqual(progress["scanned"], 100)
        self.assertEqual(progress["candidates"], 3000)

    def test_live_eta_freezes_at_exit_and_stop_is_not_completion(self):
        scratch = Path(__file__).resolve().parents[1] / ".tmp"
        scratch.mkdir(exist_ok=True)
        with tempfile.TemporaryDirectory(dir=scratch) as directory:
            path = Path(directory) / "synthetic-output.txt"
            path.write_text("Progress 40/100, 10 seeds/s, matched 7, retained 7\n", encoding="utf-8")
            proc = Mock(); proc.poll.return_value = None
            sweep = {"proc": proc, "range": [100, 200], "backend": "cpu", "started": 100, "log": path}
            progress = search_progress.snapshot(sweep, 104)
            self.assertEqual((progress["status"], progress["rate"], progress["eta"]), ("running", 10, 6))
            proc.poll.return_value = 0
            sweep["stopping"] = True
            progress = search_progress.snapshot(sweep, 105)
            self.assertEqual((progress["status"], progress["scanned"], progress["eta"]), ("stopped", 40, None))
            self.assertEqual(search_progress.snapshot(sweep, 1000)["elapsed"], 5)
            sweep["stopping"] = False
            self.assertEqual(search_progress.snapshot(sweep, 1000)["status"], "failed")
            path.write_text("Complete: scanned=100 candidates=8\n", encoding="utf-8")
            self.assertEqual(search_progress.snapshot(sweep, 1000)["status"], "completed")
            proc.poll.return_value = 1
            self.assertEqual(search_progress.snapshot(sweep, 1000)["status"], "failed")

    def test_exit_time_is_recorded_without_polling_and_old_watcher_cannot_change_new_run(self):
        proc = Mock(); proc.poll.return_value = 0
        sweep = {"proc": proc, "finished": None}
        with patch.object(search_progress.time, "time", return_value=104):
            search_progress.watch_exit(sweep, proc, threading.Lock())
        self.assertEqual(sweep["finished"], 104)
        sweep["proc"] = Mock(); sweep["finished"] = None
        search_progress.watch_exit(sweep, proc, threading.Lock())
        self.assertIsNone(sweep["finished"])

    def test_bounded_tail_ignores_partial_progress(self):
        scratch = Path(__file__).resolve().parents[1] / ".tmp"
        scratch.mkdir(exist_ok=True)
        with tempfile.TemporaryDirectory(dir=scratch) as directory:
            path = Path(directory) / "synthetic-output.txt"
            complete = "Progress 12/100, 1 seeds/s, matched 3, retained 3\n"
            path.write_text("x" * search_progress.TAIL_BYTES + "\n" + complete + "Progress 99/100", encoding="utf-8")
            tail = search_progress.read_tail(path)
            self.assertEqual(tail, complete)
            self.assertEqual(search_progress.parse_progress(tail, "cpu", [0, 100])["scanned"], 12)

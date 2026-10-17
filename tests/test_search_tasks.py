"""持久化任务, 断点事务和恢复调度的合成测试."""
import sqlite3
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch

import search_tasks

OBSERVATION = {"format": "terraria-seed-searcher/observation", "version": 1, "heights": [0] * 30, "marker": 10}


class SearchTasksTest(unittest.TestCase):
    def setUp(self):
        scratch = Path(__file__).resolve().parents[1] / ".tmp"
        scratch.mkdir(exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(dir=scratch)
        self.root = Path(self.temp.name)
        self.binary = self.root / "executable-fixture"
        self.binary.write_bytes(b"synthetic executable")
        self.manager = self.new_manager()

    def tearDown(self):
        for runtime in list(self.manager.runtime.values()):
            runtime["stop"].set()
            runtime["lock"].close()
        self.manager.runtime.clear()
        self.temp.cleanup()

    def new_manager(self):
        return search_tasks.TaskManager(self.root / "tasks", {"cpu": self.binary, "cuda": self.binary}, "synthetic-webgpu-key")

    def browser(self, bounds=None):
        return self.manager.create("webgpu", {"range": bounds or [100, 110]}, OBSERVATION)

    def wait_status(self, manager, task_id, target):
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            summary = manager.summary(task_id)
            if summary["status"] == target and task_id not in manager.runtime:
                return summary
            threading.Event().wait(.01)
        self.fail(f"task did not reach {target}")

    def test_browser_resume_restores_inputs_candidates_and_elapsed(self):
        payload = self.browser(); task_id = payload["task"]["id"]
        self.manager.browser_commit(task_id, {"owner": payload["owner"], "from": 100, "next": 104, "candidates": [{"seed": 102, "spawn": 3200, "scale": 1, "score": .8}]})
        self.manager.browser_finish(task_id, payload["owner"])
        manager = self.new_manager()
        resumed = manager.resume(task_id)
        try:
            self.assertEqual(resumed["task"]["next"], 104)
            self.assertEqual(resumed["observation"], OBSERVATION)
            self.assertEqual(resumed["parameters"]["range"], [100, 110])
            self.assertEqual(resumed["rows"][0]["seed"], 102)
            self.assertGreaterEqual(resumed["elapsed"], 0)
            manager.browser_commit(task_id, {"owner": resumed["owner"], "from": 104, "next": 110, "candidates": [{"seed": 109, "spawn": 3200, "scale": 1, "score": 1}]})
            manager.browser_finish(task_id, resumed["owner"])
            self.assertEqual(manager.summary(task_id)["status"], "completed")
            self.assertEqual([row["seed"] for row in manager.store(task_id).rows()], [109, 102])
            self.assertEqual(manager.summary(task_id)["progress"]["scanned"], 10)
        finally:
            for runtime in manager.runtime.values(): runtime["lock"].close()

    def test_transaction_rollback_and_duplicate_commit_do_not_advance_cursor(self):
        payload = self.browser(); task_id = payload["task"]["id"]; store = self.manager.store(task_id)
        with self.assertRaises(sqlite3.IntegrityError):
            store.commit(100, 104, [{"seed": 102, "spawn": 3200, "scale": 1, "score": None}], 1, 1, "running")
        self.assertEqual(store.read()["next"], 100); self.assertEqual(store.rows(), [])
        request = {"owner": payload["owner"], "from": 100, "next": 104, "candidates": []}
        self.manager.browser_commit(task_id, request)
        with self.assertRaises(ValueError): self.manager.browser_commit(task_id, request)
        self.assertEqual(store.read()["next"], 104)

    def test_browser_lease_expires_and_stale_owner_cannot_commit(self):
        payload = self.browser(); task_id = payload["task"]["id"]
        self.manager.runtime[task_id]["lease_until"] = 0
        self.assertEqual(self.manager.summaries()[0]["status"], "paused")
        resumed = self.manager.resume(task_id)
        with self.assertRaises(ValueError):
            self.manager.browser_commit(task_id, {"owner": payload["owner"], "from": 100, "next": 101, "candidates": []})
        self.assertNotEqual(payload["owner"], resumed["owner"])
        self.assertEqual(self.manager.store(task_id).read()["next"], 100)
        with self.assertRaises(ValueError): self.new_manager().resume(task_id)

    def test_changed_engine_keeps_results_but_disables_resume(self):
        payload = self.browser(); task_id = payload["task"]["id"]
        self.manager.browser_finish(task_id, payload["owner"])
        manager = self.new_manager(); manager.webgpu_key = "changed"
        self.assertFalse(manager.summary(task_id)["can_resume"])
        with self.assertRaises(ValueError): manager.resume(task_id)
        other = self.browser()
        self.assertNotEqual(task_id, other["task"]["id"])
        self.assertEqual(len(self.manager.summaries()), 2)

    def test_native_stop_finishes_block_and_resume_has_no_gaps(self):
        entered = threading.Event(); release = threading.Event(); calls = []
        class Process:
            def __init__(process, command, **kwargs):
                process.command = command; process.directory = Path(kwargs["cwd"]); process.output = kwargs["stdout"]
                process.start = int(command[command.index("--range") + 1]); process.end = int(command[command.index("--range") + 2]); calls.append((process.start, process.end))
            def wait(process):
                entered.set()
                if not release.wait(5): return 1
                (process.directory / "candidates_gpu2.txt").write_text(f"seed={process.start} spawn_x=3200 scale=1 score=1\n")
                process.output.write(f"  批 {process.start}..{process.end} 完成, 本批达标 1 条, 累计候选 1, 进度 100.000%\n".encode()); process.output.flush()
                return 0
        with patch.object(search_tasks.subprocess, "Popen", Process):
            payload = self.manager.create("cuda", {"range": [100, 130], "batch": 10}, OBSERVATION); task_id = payload["task"]["id"]
            self.assertTrue(entered.wait(3))
            self.manager.stop(task_id); release.set()
            self.wait_status(self.manager, task_id, "paused")
            self.assertEqual(self.manager.store(task_id).read()["next"], 110)
            self.assertEqual(calls, [(100, 110)])
            manager = self.new_manager(); manager.resume(task_id)
            self.wait_status(manager, task_id, "completed")
            self.assertEqual(calls, [(100, 110), (110, 120), (120, 130)])
            self.assertEqual({row["seed"] for row in manager.store(task_id).rows()}, {100, 110, 120})
            self.assertEqual(len(list(manager.store(task_id).directory.glob('block-*'))), 1)

    def test_failed_native_block_leaves_checkpoint_unchanged(self):
        class Process:
            def __init__(process, *args, **kwargs): pass
            def wait(process): return 1
        with patch.object(search_tasks.subprocess, "Popen", Process):
            payload = self.manager.create("cpu", {"range": [100, 130]}, OBSERVATION); task_id = payload["task"]["id"]
            self.wait_status(self.manager, task_id, "failed")
        self.assertEqual(self.manager.store(task_id).read()["next"], 100)
        self.assertEqual(self.manager.store(task_id).rows(), [])
        self.assertTrue(self.new_manager().summary(task_id)["can_resume"])

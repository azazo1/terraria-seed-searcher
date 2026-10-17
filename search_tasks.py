"""持久化搜索任务, 事务断点和跨平台工作块调度."""
import hashlib
import heapq
import json
import logging
import math
import re
import shutil
import sqlite3
import subprocess
import threading
import time
import uuid
import os
from contextlib import contextmanager
from pathlib import Path

import observation_archive
import search_progress

SCHEMA_VERSION = 1
ALGORITHM = "terraria-1.4.5.8-medium-v1"
CPU_BLOCK = 65536
CUDA_BLOCK = 400000
# MLX 每次启动都要把 Metal 内核从源码编译一次, 工作块需要足够大才能摊薄这部分固定开销.
MLX_BLOCK = 4000000
CANDIDATE_FILES = {"cpu": "candidates_cpu.txt", "cuda": "candidates_gpu2.txt", "mlx": "candidates_mlx.txt"}
HOST_BACKENDS = tuple(CANDIDATE_FILES)
LOG = logging.getLogger(__name__)
DEFAULTS = {"tol": .5, "offer": .55, "range": [0, 2147483647], "spawn_lo": 3180, "spawn_hi": 3220, "cols": 3400, "scales": "1.00", "batch": 400000, "device": 0}


def fingerprint(backend, key, settings, observation):
    return hashlib.sha256(json.dumps([ALGORITHM, backend, key, settings, observation], sort_keys=True).encode()).hexdigest()


def parameters(raw):
    if not isinstance(raw, dict):
        raise ValueError("搜索参数必须是对象.")
    result = {**DEFAULTS, **raw}
    if set(result) != set(DEFAULTS):
        raise ValueError("搜索参数包含未知字段.")
    for key, lower, upper, integer in (("tol", .01, 10, False), ("offer", 0, 1, False), ("spawn_lo", 0, 6399, True), ("spawn_hi", 0, 6399, True), ("cols", 1, 6400, True), ("batch", 1, 2147483647, True), ("device", 0, 1024, True)):
        value = result[key]
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or not lower <= value <= upper or (integer and int(value) != value):
            raise ValueError(f"搜索参数 {key} 无效.")
    bounds = result["range"]
    if not isinstance(bounds, list) or len(bounds) != 2 or any(type(v) is not int for v in bounds) or not 0 <= bounds[0] < bounds[1] <= 2147483647:
        raise ValueError("种子范围无效.")
    if not result["spawn_lo"] <= result["spawn_hi"] < result["cols"]:
        raise ValueError("出生点范围超出模拟范围.")
    if not isinstance(result["scales"], str):
        raise ValueError("搜索尺度无效.")
    scales = result["scales"].split(',')
    if not 1 <= len(scales) <= 8 or any(not re.fullmatch(r"(?:\d+(?:\.\d*)?|\.\d+)", v.strip()) or not .1 <= float(v) <= 10 for v in scales):
        raise ValueError("搜索尺度无效.")
    return result


class TaskLock:
    """操作系统锁随服务退出自动释放, 不继承给工作进程."""
    def __init__(self, path):
        self.stream = open(path, "a+b")
        try:
            if os.name == "nt":
                import msvcrt
                self.stream.seek(0, 2)
                if not self.stream.tell():
                    self.stream.write(b"0"); self.stream.flush()
                self.stream.seek(0)
                msvcrt.locking(self.stream.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(self.stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            self.stream.close()
            raise ValueError("这个任务正在另一个服务中运行, 请先停止它.") from None

    def close(self):
        self.stream.close()


class TaskStore:
    def __init__(self, directory):
        self.directory = Path(directory)
        self.database = self.directory / "task.sqlite"

    @contextmanager
    def connect(self):
        if not self.database.is_file():
            raise ValueError("搜索任务不存在.")
        connection = sqlite3.connect(self.database, timeout=10)
        connection.row_factory = sqlite3.Row
        try:
            with connection:
                yield connection
        finally:
            connection.close()

    def create(self, meta):
        self.directory.mkdir(parents=True)
        with sqlite3.connect(self.database) as connection:
            connection.execute("CREATE TABLE task (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL)")
            connection.execute("CREATE TABLE candidates (seed INTEGER PRIMARY KEY, spawn INTEGER NOT NULL, scale REAL NOT NULL, score INTEGER NOT NULL)")
            connection.execute("CREATE INDEX ranking ON candidates(score DESC, seed ASC)")
            connection.execute("INSERT INTO task VALUES(1, ?)", (json.dumps(meta),))
        connection.close()
        (self.directory / "observed.txt").write_text(observation_archive.to_text(meta["observation"]), encoding="utf-8")

    def read(self):
        with self.connect() as connection:
            value = json.loads(connection.execute("SELECT value FROM task WHERE id=1").fetchone()[0])
        if value.get("version") != SCHEMA_VERSION:
            raise ValueError("搜索任务版本不兼容.")
        return value

    def rows(self, limit=2000):
        with self.connect() as connection:
            return [dict(row) for row in connection.execute("SELECT seed,spawn,scale,score FROM candidates ORDER BY score DESC,seed ASC LIMIT ?", (limit,))]

    def update(self, **changes):
        with self.connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            meta = json.loads(connection.execute("SELECT value FROM task WHERE id=1").fetchone()[0])
            meta.update(changes, updated=time.time())
            connection.execute("UPDATE task SET value=? WHERE id=1", (json.dumps(meta),))
        return meta

    def commit(self, expected, next_seed, rows, elapsed, matched, status, last_block=None):
        with self.connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            meta = json.loads(connection.execute("SELECT value FROM task WHERE id=1").fetchone()[0])
            if meta["next"] != expected or not expected < next_seed <= meta["parameters"]["range"][1]:
                raise ValueError("断点位置已经变化, 请重新加载任务.")
            connection.executemany("INSERT INTO candidates VALUES(:seed,:spawn,:scale,:score) ON CONFLICT(seed) DO UPDATE SET spawn=excluded.spawn,scale=excluded.scale,score=excluded.score", rows)
            maximum = 500000 if meta["backend"] == "cuda" else 2000
            connection.execute("DELETE FROM candidates WHERE seed IN (SELECT seed FROM candidates ORDER BY score DESC,seed ASC LIMIT -1 OFFSET ?)", (maximum,))
            if last_block:
                meta["last_block"] = last_block
            meta.update(next=next_seed, elapsed=elapsed, matched=meta["matched"] + matched, status=status, updated=time.time(), error=None)
            connection.execute("UPDATE task SET value=? WHERE id=1", (json.dumps(meta),))
        return meta


def candidate_rows(path, limit=500000):
    rows = []
    try:
        with open(path, encoding="utf-8") as stream:
            for line in stream:
                fields = dict(item.split('=', 1) for item in line.split())
                rows.append({"seed": int(fields["seed"]), "spawn": int(fields["spawn_x"]), "scale": float(fields["scale"]), "score": round(float(fields["score"]) * 10000000)})
                if len(rows) >= limit:
                    break
    except FileNotFoundError:
        pass
    return rows


def candidate_lines(rows):
    return [f"seed={row['seed']} spawn_x={row['spawn']} scale={row['scale']:.9g} score={row['score'] / 10000000:.7f}" for row in rows]


STUCK_TRASH = set()


def discard_tree(path):
    """清理已经改名的任务目录, 失败时只报告一次, 不拖累任务列表."""
    if path in STUCK_TRASH:
        return
    try:
        shutil.rmtree(path)
    except OSError as error:
        STUCK_TRASH.add(path)
        LOG.warning("任务残留目录暂时无法删除: %s (%s)", path.name, error)


class TaskManager:
    def __init__(self, root, binaries, webgpu_key):
        self.root = Path(root)
        self.binaries = binaries
        self.webgpu_key = webgpu_key
        self.lock = threading.RLock()
        self.runtime = {}
        self.engine_cache = {}

    def store(self, task_id):
        if not isinstance(task_id, str) or not re.fullmatch(r"[a-f0-9]{32}", task_id):
            raise ValueError("任务编号无效.")
        return TaskStore(self.root / task_id)

    def engine_key(self, backend):
        if backend == "webgpu":
            return self.webgpu_key() if callable(self.webgpu_key) else self.webgpu_key
        path = self.binaries.get(backend)
        if not path or not path.is_file():
            raise ValueError("搜索器不存在, 请先编译对应后端.")
        info = path.stat(); signature = (info.st_mtime_ns, info.st_ctime_ns, info.st_size)
        cached = self.engine_cache.get(backend)
        if not cached or cached[0] != signature:
            cached = (signature, hashlib.sha256(path.read_bytes()).hexdigest())
            self.engine_cache[backend] = cached
        return cached[1]

    def _expire(self):
        for task_id, runtime in list(self.runtime.items()):
            if runtime.get("lease_until", float('inf')) < time.monotonic():
                try:
                    self.store(task_id).update(status="paused", error="浏览器连接已中断, 可以从最近断点继续.")
                except (ValueError, sqlite3.DatabaseError):
                    LOG.warning("中断的浏览器任务无法写回状态: %s", task_id)
                runtime["lock"].close()
                del self.runtime[task_id]

    def summaries(self):
        with self.lock:
            self._expire()
            result = []
            if not self.root.exists():
                return result
            for directory in self.root.iterdir():
                if directory.name.startswith("trash-"):
                    discard_tree(directory)
                elif re.fullmatch(r"[a-f0-9]{32}", directory.name) and (directory / "task.sqlite").is_file():
                    try:
                        result.append(self.summary(directory.name))
                    except (ValueError, sqlite3.DatabaseError):
                        LOG.exception("无法读取搜索任务 %s", directory.name)
            return sorted(result, key=lambda task: task["updated"], reverse=True)

    def delete(self, task_id):
        """删除任务目录. 运行中的任务必须先停止, 损坏的任务也允许清理.

        改名是删除的原子分界: 之后任务列表立即看不到它, 清理失败只留下
        trash- 前缀的目录, 不影响服务.
        """
        with self.lock:
            store = self.store(task_id)
            if not store.directory.is_dir():
                raise ValueError("搜索任务不存在.")
            try:
                live = self.summary(task_id)["status"] in ("running", "stopping")
            except (ValueError, sqlite3.DatabaseError):
                live = False
            if live:
                raise ValueError("任务正在运行, 请先停止再删除.")
            # 探测锁证明没有其他服务正在运行这个任务, 随后立即释放.
            # Windows 上打开着的 run.lock 无法改名, 所以必须先 close.
            guard = TaskLock(store.directory / "run.lock")
            guard.close()
            trash = store.directory.with_name("trash-" + task_id + "-" + uuid.uuid4().hex)
            store.directory.rename(trash)
            self.runtime.pop(task_id, None)
            LOG.info("删除任务 %s, 残留目录等待清理", task_id)
        discard_tree(trash)

    def summary(self, task_id):
        store = self.store(task_id)
        with self.lock:
            meta = store.read()
            runtime = self.runtime.get(task_id)
            live = None
            if runtime and runtime.get("block"):
                block = runtime["block"]
                live = search_progress.parse_progress(search_progress.read_tail(block["log"]), meta["backend"], [block["from"], block["to"]])
            status = meta["status"]
            if not runtime and status in ("running", "stopping"):
                try:
                    probe = TaskLock(store.directory / "run.lock"); probe.close()
                    status = "interrupted"
                except ValueError:
                    status = "stopping" if status == "stopping" else "running"
            elapsed = meta["elapsed"]
            if runtime:
                elapsed = runtime["base_elapsed"] + time.monotonic() - runtime["started"]
            scanned = meta["next"] - meta["parameters"]["range"][0] + (live["scanned"] if live else 0)
            total = meta["parameters"]["range"][1] - meta["parameters"]["range"][0]
            rate = scanned / elapsed if scanned and elapsed > 0 else None
            try:
                compatible = meta["algorithm"] == ALGORITHM and meta["engine_key"] == self.engine_key(meta["backend"])
            except (ValueError, OSError):
                compatible = False
            return {"id": task_id, "backend": meta["backend"], "updated": meta["updated"], "parameters": meta["parameters"], "next": meta["next"], "status": status, "error": meta.get("error"), "can_resume": compatible and status in ("paused", "interrupted", "failed") and meta["next"] < meta["parameters"]["range"][1], "compatible": compatible, "progress": {"status": "stopped" if status in ("paused", "interrupted") else status, "scanned": scanned, "total": total, "elapsed": elapsed, "rate": rate, "eta": (total - scanned) / rate if rate and status == "running" else None, "candidates": meta["matched"] + (live["candidates"] if live else 0)}, "version": f"{meta['next']}:{meta['updated']}:{live['scanned'] if live else 0}"}

    def busy(self):
        return any(task["status"] in ("running", "stopping") for task in self.summaries())

    def create(self, backend, raw_parameters, observation):
        if backend not in (*HOST_BACKENDS, "webgpu"):
            raise ValueError("未知搜索后端.")
        settings = parameters(raw_parameters)
        observation = observation_archive.validate_observation(observation)
        valid = sum(value != -999 for value in observation["heights"])
        if valid < 20 or len(observation["heights"]) > 700:
            raise ValueError("搜索需要至少 20 个有效列和最多 700 个观测列.")
        base = settings["spawn_lo"] - observation["marker"]
        width = settings["spawn_hi"] - settings["spawn_lo"] + 1
        maximum_shift = math.floor((len(observation["heights"]) - 1) * max(float(value) for value in settings["scales"].split(',')) + .5)
        if min(settings["cols"], base + width + maximum_shift) <= max(0, base):
            raise ValueError("出生点范围和观测列号没有覆盖模拟区域.")
        with self.lock:
            if self.busy():
                raise ValueError("已有搜索正在运行.")
            key = self.engine_key(backend)
            task_id = uuid.uuid4().hex
            task_fingerprint = fingerprint(backend, key, settings, observation)
            self.store(task_id).create({"version": SCHEMA_VERSION, "id": task_id, "algorithm": ALGORITHM, "fingerprint": task_fingerprint, "engine_key": key, "backend": backend, "parameters": settings, "observation": observation, "next": settings["range"][0], "elapsed": 0, "matched": 0, "status": "paused", "updated": time.time()})
            return self.resume(task_id)

    def resume(self, task_id):
        with self.lock:
            if self.busy():
                raise ValueError("已有搜索正在运行, 请先等待或停止它.")
            store = self.store(task_id); meta = store.read()
            if meta["fingerprint"] != fingerprint(meta["backend"], meta["engine_key"], meta["parameters"], meta["observation"]):
                raise ValueError("任务保存的输入不完整或已被修改, 请创建新任务.")
            if not self.summary(task_id)["can_resume"]:
                raise ValueError("任务已完成或搜索器版本发生变化, 无法继续这个任务.")
            guard = TaskLock(store.directory / "run.lock")
            try:
                (store.directory / "observed.txt").write_text(observation_archive.to_text(meta["observation"]), encoding="utf-8")
            except OSError:
                guard.close()
                raise
            LOG.info("继续任务 %s, 后端 %s, 安全续跑位置 %s", task_id, meta["backend"], meta["next"])
            runtime = {"lock": guard, "owner": uuid.uuid4().hex, "stop": threading.Event(), "started": time.monotonic(), "base_elapsed": meta["elapsed"], "block": None}
            if meta["backend"] == "webgpu":
                runtime["lease_until"] = time.monotonic() + 30
            self.runtime[task_id] = runtime
            store.update(status="running", error=None)
            payload = {"task": self.summary(task_id), "observation": meta["observation"], "parameters": meta["parameters"], "rows": store.rows(), "matched": meta["matched"], "elapsed": meta["elapsed"], "owner": runtime["owner"]}
            if meta["backend"] != "webgpu":
                threading.Thread(target=self._run_native, args=(task_id, runtime), daemon=True).start()
            return payload

    def _run_native(self, task_id, runtime):
        store = self.store(task_id)
        try:
            while True:
                meta = store.read(); settings = meta["parameters"]; start = meta["next"]; end = settings["range"][1]
                if meta["engine_key"] != self.engine_key(meta["backend"]):
                    raise RuntimeError("搜索器版本已变化, 已保留断点和候选, 请创建新任务.")
                if runtime["stop"].is_set() or meta["status"] == "stopping":
                    store.update(status="paused"); break
                if start >= end:
                    store.update(status="completed"); break
                if meta["backend"] == "cuda":
                    count = min(settings["batch"], CUDA_BLOCK)
                elif meta["backend"] == "mlx":
                    count = MLX_BLOCK
                else:
                    count = runtime.get("block_size", min(128, CPU_BLOCK))
                block_started = time.monotonic()
                end = min(end, start + count)
                attempt = store.directory / ("block-" + uuid.uuid4().hex)
                attempt.mkdir()
                log = attempt / "output.txt"
                command = [str(self.binaries[meta["backend"]]), str(store.directory / "observed.txt"), "--range", str(start), str(end), "--marker", str(meta["observation"]["marker"])]
                for flag, key in (("--tol", "tol"), ("--offer", "offer"), ("--batch", "batch"), ("--device", "device"), ("--spawn-lo", "spawn_lo"), ("--spawn-hi", "spawn_hi"), ("--cols", "cols"), ("--scales", "scales")):
                    command.extend((flag, str(min(settings[key], end - start) if key == "batch" else settings[key])))
                with self.lock:
                    runtime["block"] = {"from": start, "to": end, "log": log, "directory": attempt}
                with log.open("wb") as stream:
                    process = subprocess.Popen(command, cwd=attempt, stdout=stream, stderr=subprocess.STDOUT, close_fds=True)
                    code = process.wait()
                if code:
                    raise RuntimeError(f"搜索进程退出码 {code}. 请查看运行输出, 可以从最近断点重试.")
                name = CANDIDATE_FILES[meta["backend"]]
                if not (attempt / name).is_file():
                    raise RuntimeError("搜索器未生成候选文件, 当前工作块未提交.")
                rows = candidate_rows(attempt / name)
                report = search_progress.parse_progress(search_progress.read_tail(log), meta["backend"], [start, end])
                if report["scanned"] != end - start:
                    raise RuntimeError("搜索器没有确认完整工作块, 当前断点保持不变.")
                with self.lock:
                    stopping = runtime["stop"].is_set() or store.read()["status"] == "stopping"
                    status = "completed" if end == settings["range"][1] else "paused" if stopping else "running"
                    store.commit(start, end, rows, runtime["base_elapsed"] + time.monotonic() - runtime["started"], report["candidates"], status, last_block=attempt.name)
                    runtime["block"] = None
                    if meta["backend"] == "cpu":
                        runtime["block_size"] = max(1, min(CPU_BLOCK, int((end - start) / max(.001, time.monotonic() - block_started))))
                previous = meta.get("last_block")
                if previous and re.fullmatch(r"block-[a-f0-9]{32}", previous):
                    directory = store.directory / previous
                    if directory.resolve().parent == store.directory.resolve():
                        # 断点已事务提交, 只清理已知的旧工作块输出, 保留任务及最新输出.
                        for name in tuple(f"{path}{suffix}" for path in CANDIDATE_FILES.values() for suffix in ("", ".tmp")) + ("output.txt",):
                            target = directory / name
                            if target.resolve().parent == directory.resolve():
                                try:
                                    target.unlink(missing_ok=True)
                                except OSError:
                                    LOG.warning("旧工作块输出暂时无法清理: %s", target.name)
                        try:
                            directory.rmdir()
                        except OSError:
                            pass
                if status != "running":
                    break
        except Exception as error:
            LOG.exception("搜索任务 %s 已中断", task_id)
            changes = {"status": "failed", "error": str(error)}
            if runtime.get("block"):
                changes["last_block"] = runtime["block"]["directory"].name
            store.update(**changes)
        finally:
            with self.lock:
                runtime["lock"].close()
                if self.runtime.get(task_id) is runtime:
                    del self.runtime[task_id]

    def stop(self, task_id):
        with self.lock:
            if self.summary(task_id)["status"] not in ("running", "stopping"):
                return
            self.store(task_id).update(status="stopping")
            LOG.info("请求停止任务 %s, 等待当前工作块提交", task_id)
            runtime = self.runtime.get(task_id)
            if runtime:
                runtime["stop"].set()
            elif not self.busy():
                self.store(task_id).update(status="paused")

    def _browser_owner(self, task_id, owner):
        self._expire()
        runtime = self.runtime.get(task_id)
        if not runtime or "lease_until" not in runtime or runtime["owner"] != owner:
            raise ValueError("浏览器任务所有权已失效, 请从保存的断点继续.")
        runtime["lease_until"] = time.monotonic() + 30
        return runtime

    def heartbeat(self, task_id, owner):
        with self.lock:
            runtime = self._browser_owner(task_id, owner)
            return {"stopping": runtime["stop"].is_set()}

    def browser_commit(self, task_id, raw):
        with self.lock:
            runtime = self._browser_owner(task_id, raw.get("owner"))
            store = self.store(task_id); meta = store.read(); start = raw.get("from"); end = raw.get("next")
            if type(start) is not int or type(end) is not int or start != meta["next"] or not start < end <= min(start + 512, meta["parameters"]["range"][1]):
                raise ValueError("浏览器工作块与保存的断点不一致.")
            rows = raw.get("candidates")
            if not isinstance(rows, list) or len(rows) > end - start:
                raise ValueError("候选工作块无效.")
            scales = [float(value) for value in meta["parameters"]["scales"].split(',')]
            saved = []
            for row in rows:
                if not isinstance(row, dict) or type(row.get("seed")) is not int or not start <= row["seed"] < end or type(row.get("spawn")) is not int or not meta["parameters"]["spawn_lo"] <= row["spawn"] <= meta["parameters"]["spawn_hi"]:
                    raise ValueError("候选种子或出生点无效.")
                score, scale = row.get("score"), row.get("scale")
                if not isinstance(score, (int, float)) or not math.isfinite(score) or not 0 < score <= 1 or scale not in scales:
                    raise ValueError("候选评分或尺度无效.")
                saved.append({"seed": row["seed"], "spawn": row["spawn"], "scale": scale, "score": round(score * 10000000)})
            if len({row["seed"] for row in saved}) != len(saved):
                raise ValueError("工作块包含重复候选.")
            status = "completed" if end == meta["parameters"]["range"][1] else "stopping" if runtime["stop"].is_set() else "running"
            store.commit(start, end, saved, runtime["base_elapsed"] + time.monotonic() - runtime["started"], len(saved), status)
            return {"ok": True, "stopping": runtime["stop"].is_set()}

    def browser_finish(self, task_id, owner, failed=False):
        with self.lock:
            runtime = self._browser_owner(task_id, owner)
            store = self.store(task_id); meta = store.read()
            store.update(status="completed" if meta["next"] == meta["parameters"]["range"][1] else "failed" if failed else "paused", elapsed=runtime["base_elapsed"] + time.monotonic() - runtime["started"])
            runtime["lock"].close(); del self.runtime[task_id]

    def lines(self, task_id, limit=200):
        store = self.store(task_id); saved = store.rows(limit)
        with self.lock:
            runtime = self.runtime.get(task_id)
            if runtime and runtime.get("block"):
                name = CANDIDATE_FILES[store.read()["backend"]]
                live = candidate_rows(runtime["block"]["directory"] / name, 2000)
                by_seed = {row["seed"]: row for row in saved + live}
                saved = heapq.nsmallest(limit, by_seed.values(), key=lambda row: (-row["score"], row["seed"]))
        return candidate_lines(saved)

    def log(self, task_id):
        with self.lock:
            runtime = self.runtime.get(task_id)
            if runtime and runtime.get("block"):
                return search_progress.read_tail(runtime["block"]["log"])
        store = self.store(task_id)
        previous = store.read().get("last_block")
        if previous and re.fullmatch(r"block-[a-f0-9]{32}", previous):
            return search_progress.read_tail(store.directory / previous / "output.txt")
        return ""

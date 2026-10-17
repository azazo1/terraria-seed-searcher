#!/usr/bin/env python3
"""terraria-seed-searcher 流水线控制器.

一个零依赖的本地服务, 把"导入截图 -> 校准拼接 -> 人工标注 -> 粗筛 -> 精算 -> 看图"
串成一条链路, 各环节共享同一份状态文件, 不再需要手工搬运中间产物.

用法:
    python3 serve.py                 # 默认 http://127.0.0.1:8791
    python3 serve.py --port 8791 --open

目录约定:
    frames/        放主播的原始截图 (直接往里丢文件即可, 页面会自动列出)
    data/param.json    校准结果 (页面导出, 服务自动落盘)
    data/marks.json    标注结果 (页面导出, 服务自动落盘)
    data/observed.txt  由标注生成的观测剖面, 供搜索使用
    data/candidates.txt 搜索产出的候选榜
    workdir        搜索进程的工作目录 (CUDA 产物与其日志)
"""
import argparse
import json
import os
import shutil
import subprocess
import tempfile
import observation_archive
import search_progress
import sys
import threading
import time
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse, parse_qs, unquote

ROOT = Path(__file__).resolve().parent
FRAMES = ROOT / "frames"
DATA = ROOT / "data"
WORK = ROOT / "workdir"
SEARCHER = ROOT / ("sweep2.exe" if os.name == "nt" else "sweep2")
CPU_SEARCHER = ROOT / ("sweep-cpu.exe" if os.name == "nt" else "sweep-cpu")
DEFAULT_SEED_RANGE = (0, 2147483647)

STATE_LOCK = threading.Lock()
FILE_LOCK = threading.RLock()
SWEEP = {"proc": None, "started": 0.0, "log": None}


def ensure_dirs():
    for d in (FRAMES, DATA, WORK):
        d.mkdir(exist_ok=True)


def read_json(path, default):
    try:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    except Exception:
        return default


def write_json(path, obj):
    # 自动保存期间状态查询仍会继续, 原子替换避免读到半份 JSON.
    target = Path(path)
    temporary = target.with_suffix(target.suffix + ".tmp")
    with FILE_LOCK:
        temporary.write_text(json.dumps(obj, ensure_ascii=False, indent=1), encoding="utf-8")
        temporary.replace(target)


def candidates_path(backend=None):
    backend = backend or SWEEP.get("backend", "cuda")
    generated = WORK / ("candidates_cpu.txt" if backend == "cpu" else "candidates_gpu2.txt")
    return generated if backend == "cpu" or generated.is_file() else DATA / "candidates.txt"


def load_marks():
    return read_json(DATA / "marks.json", {"tile": 20.86, "x0": 0, "y0": 0, "cols": [], "trees": []})


def observation_marker():
    meta = read_json(DATA / "observed_meta.json", {})
    return int(meta["marker"] if "marker" in meta else load_marks().get("marker", 141))


def export_observation():
    with FILE_LOCK:
        return observation_archive.from_text((DATA / "observed.txt").read_text(encoding="utf-8"), observation_marker())


def import_observation(raw):
    observation = observation_archive.validate_observation(raw)
    meta = {**observation_archive.summary(observation), "path": str(DATA / "observed.txt"), "source": "import"}
    scratch = ROOT / ".tmp"
    scratch.mkdir(exist_ok=True)
    # 只替换搜索输入, 不触碰截图, 标定或画布标记. 失败时恢复旧搜索输入.
    with FILE_LOCK, tempfile.TemporaryDirectory(prefix="observation-import-", dir=scratch) as temporary:
        stage = Path(temporary)
        names = ("observed.txt", "observed_meta.json", "shapes.json")
        previous = {name: (DATA / name).read_bytes() if (DATA / name).exists() else None for name in names}
        backup = stage / "previous"
        backup.mkdir()
        for name, content in previous.items():
            if content is not None:
                (backup / name).write_bytes(content)
        (stage / "observed.txt").write_text(observation_archive.to_text(observation), encoding="utf-8")
        write_json(stage / "observed_meta.json", meta)
        try:
            for name in names[:2]:
                (stage / name).replace(DATA / name)
            (DATA / "shapes.json").unlink(missing_ok=True)
        except OSError:
            for name, content in previous.items():
                if content is None:
                    (DATA / name).unlink(missing_ok=True)
                else:
                    (backup / name).replace(DATA / name)
            raise
    return meta


def build_observed(mark):
    """把逐列标注转成搜索用的剖面文件.

    用列号当索引, 未标注的列写 -999 (搜索侧会跳过). 高度换算成"格",
    以最小 y 为零点; 形态信息另存, 供精算阶段使用.
    """
    cols = [c for c in mark.get("cols", []) if c.get("t") != "tree"]
    if not cols:
        # 清空或全部作废时同步移除旧观测, 防止继续搜索过期数据.
        for name in ("observed.txt", "observed_meta.json", "shapes.json"):
            path = DATA / name
            if path.resolve().parent == DATA.resolve():
                path.unlink(missing_ok=True)
        return None, None
    tile = float(mark.get("tile", 20.86))
    n = max(int(c["c"]) for c in cols) + 1
    ys = {int(c["c"]): float(c["y"]) for c in cols}
    base = min(ys.values())
    vals = ["-999"] * n
    for c, y in ys.items():
        if 0 <= c < n:
            vals[c] = f"{(y - base) / tile:.3f}"
    out = DATA / "observed.txt"
    out.write_text(" ".join(vals) + "\n", encoding="utf-8")

    # 形态表用于检查标注类型. 当前粗筛只读取高度, 不读取斜坡方向.
    shapes = {str(int(c["c"])): c.get("t", "block") for c in mark.get("cols", [])}
    write_json(DATA / "shapes.json", {"tile": tile, "base": base, "shapes": shapes})

    s = " ".join(vals).split()
    valid = sum(1 for v in s if v != "-999")
    stepped = sum(1 for a, b in zip(s, s[1:])
                  if a != "-999" and b != "-999" and abs(float(a) - float(b)) >= 1.0)
    return {
        "path": str(out),
        "source": "manual",
        "columns": n,
        "valid": valid,
        "marker": int(mark.get("marker", 141)),
        "step_rate": round(100.0 * stepped / max(1, valid - 1), 1),
    }, None


def sweep_command(params):
    """使用最终观测中的出生点列号生成搜索命令."""
    marker = observation_marker()
    spawn_lo = int(params.get("spawn_lo", 3180))
    spawn_hi = int(params.get("spawn_hi", 3220))
    lo, hi = params.get("range", list(DEFAULT_SEED_RANGE))
    return [
        str(CPU_SEARCHER if params.get("backend") == "cpu" else SEARCHER), str(DATA / "observed.txt"),
        "--range", str(lo), str(hi),
        "--tol", str(params.get("tol", 0.5)),
        "--offer", str(params.get("offer", 0.55)),
        "--batch", str(params.get("batch", 400000)),
        "--device", str(params.get("device", 0)),
        "--marker", str(marker),
        "--spawn-lo", str(spawn_lo),
        "--spawn-hi", str(spawn_hi),
        "--cols", str(params.get("cols", 3400)),
        "--scales", params.get("scales", "1.00"),
    ]


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *a):
        pass

    def _send(self, code, body, ctype="application/json; charset=utf-8"):
        if isinstance(body, (dict, list)):
            body = json.dumps(body, ensure_ascii=False).encode()
        elif isinstance(body, str):
            body = body.encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass   # 客户端提前断开 (刷新页面, 关闭标签页) 属正常情况


    def _file(self, path, ctype):
        if not path.is_file():
            return self._send(404, {"error": f"not found: {path.name}"})
        self._send(200, path.read_bytes(), ctype)

    def _json_body(self):
        n = int(self.headers.get("Content-Length") or 0)
        if not n:
            return {}
        try:
            return json.loads(self.rfile.read(n) or b"{}")
        except Exception:
            return {}

    def do_GET(self):
        u = urlparse(self.path)
        p = unquote(u.path)
        if p in ("/", "/index.html"):
            return self._file(ROOT / "web" / "index.html", "text/html; charset=utf-8")
        editor_tabs = {"/web/grid.html": "grid", "/web/calib.html": "calib", "/web/mark.html": "mark"}
        if p in editor_tabs and (parse_qs(u.query).get("embedded") or [""])[0] != "1":
            self.send_response(302)
            self.send_header("Location", "/#" + editor_tabs[p])
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        if p.startswith("/web/"):
            f = (ROOT / "web" / p[5:]).resolve()
            if not f.is_relative_to((ROOT / "web").resolve()):
                return self._send(403, {"error": "path outside web/"})
            ext = f.suffix.lower()
            ct = {".html": "text/html; charset=utf-8", ".js": "text/javascript",
                  ".css": "text/css", ".png": "image/png", ".jpg": "image/jpeg"}.get(ext, "application/octet-stream")
            return self._file(f, ct)
        if p.startswith("/data/"):
            f = (DATA / p[6:]).resolve()
            if not f.is_relative_to(DATA.resolve()):
                return self._send(403, {"error": "path outside data/"})
            return self._file(f, "application/json; charset=utf-8")
        if p == "/frames" or p.startswith("/frames/"):
            name = p[len("/frames/"):] if p.startswith("/frames/") else ""
            if not name:
                return self._send(200, [f.name for f in sorted(FRAMES.glob("*")) if f.is_file()])
            frame = (FRAMES / name).resolve()
            if frame.parent != FRAMES.resolve():
                return self._send(403, {"error": "path outside frames/"})
            ctype = {".png": "image/png", ".webp": "image/webp", ".gif": "image/gif", ".bmp": "image/bmp"}.get(frame.suffix.lower(), "image/jpeg")
            return self._file(frame, ctype)
        if p == "/api/observation":
            try:
                return self._send(200, export_observation())
            except FileNotFoundError:
                return self._send(404, {"error": "尚无最终观测数据, 请先完成标注或导入观测."})
            except (ValueError, OSError) as error:
                return self._send(400, {"error": str(error)})
        if p == "/api/state":
            with FILE_LOCK:
                mark = load_marks()
                param = read_json(DATA / "param.json", None)
                observed = read_json(DATA / "observed_meta.json", None)
            with STATE_LOCK:
                running = SWEEP["proc"] is not None and SWEEP["proc"].poll() is None
                progress = search_progress.snapshot(SWEEP, time.time())
                elapsed = progress["elapsed"] if progress else 0
            cands = candidates_path()
            candidate_stats = {backend: path.stat() if path.is_file() else None for backend in ("cpu", "cuda") for path in (candidates_path(backend),)}
            candidate_bytes = {backend: info.st_size if info else 0 for backend, info in candidate_stats.items()}
            candidate_versions = {backend: f"{info.st_mtime_ns}:{info.st_size}" if info else "" for backend, info in candidate_stats.items()}
            return self._send(200, {
                "frames": [f.name for f in sorted(FRAMES.glob("*")) if f.is_file()],
                "param": param,
                "marks": {"columns": len(mark.get("cols", [])), "trees": len(mark.get("trees", []))},
                "observed": observed,
                "searcher_built": SEARCHER.is_file(),
                "cpu_searcher_built": CPU_SEARCHER.is_file(),
                "searcher_paths": {"cuda": str(SEARCHER), "cpu": str(CPU_SEARCHER)},
                "sweep": {"running": running, "backend": SWEEP.get("backend", "cuda"), "candidate_bytes": candidate_bytes, "candidate_versions": candidate_versions, "progress": progress, "elapsed": round(elapsed, 1),
                          "candidates": cands.stat().st_size if cands.is_file() else 0},
            })
        if p in ("/api/sweep/log", "/api/candidates"):
            backend = (parse_qs(u.query).get("backend") or [SWEEP.get("backend", "cuda")])[0]
            if backend not in ("cpu", "cuda"):
                return self._send(400, {"error": "未知主机搜索后端."})
        if p == "/api/sweep/log":
            with STATE_LOCK:
                log = SWEEP["log"] if backend == SWEEP.get("backend", "cuda") else None
                log = log or (WORK / f"sweep-{backend}.log")
            txt = search_progress.read_tail(log)
            return self._send(200, {"log": "\n".join(txt.splitlines()[-60:])})
        if p == "/api/candidates":
            f = candidates_path(backend)
            if not f.is_file():
                return self._send(200, {"rows": []})
            rows = []
            # 只读取展示所需的前 200 条; 大范围搜索的完整结果可能很大.
            with f.open(encoding="utf-8", errors="replace") as stream:
                for line in stream:
                    if "seed=" in line:
                        rows.append(line.strip())
                    if len(rows) == 200:
                        break
            return self._send(200, {"rows": rows})
        return self._send(404, {"error": "no route"})

    def do_POST(self):
        u = urlparse(self.path)
        # 上传走原始字节, 必须在读取 JSON 体之前处理 (否则字节流会被消费掉)
        if u.path == "/api/upload":
            name = (parse_qs(u.query).get("name") or [""])[0]
            if not name:
                return self._send(400, {"ok": False, "error": "缺少文件名"})
            safe = Path(name).name            # 只取末段文件名, 防路径穿越
            if Path(safe).suffix.lower() not in (".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"):
                return self._send(400, {"ok": False, "error": "不是图片: " + safe})
            n = int(self.headers.get("Content-Length") or 0)
            if not n:
                return self._send(400, {"ok": False, "error": "空文件"})
            (FRAMES / safe).write_bytes(self.rfile.read(n))
            return self._send(200, {"ok": True, "name": safe, "bytes": n})
        # 删除图片同样不需要请求体
        if u.path == "/api/delete":
            name = (parse_qs(u.query).get("name") or [""])[0]
            if not name:
                return self._send(400, {"ok": False, "error": "缺少文件名"})
            safe = Path(name).name            # 只取末段文件名, 防路径穿越
            f = FRAMES / safe
            if not f.is_file():
                return self._send(404, {"ok": False, "error": "没有这个文件: " + safe})
            f.unlink()
            return self._send(200, {"ok": True, "deleted": safe})
        if u.path == "/api/observation" and int(self.headers.get("Content-Length") or 0) > observation_archive.MAX_BYTES:
            self.close_connection = True
            return self._send(413, {"ok": False, "error": "观测文件不能超过 8 MiB."})
        body = self._json_body()
        if u.path == "/api/observation":
            with STATE_LOCK:
                if SWEEP["proc"] is not None and SWEEP["proc"].poll() is None:
                    return self._send(409, {"ok": False, "error": "请先停止搜索, 再导入观测数据."})
                try:
                    meta = import_observation(body)
                except ValueError as error:
                    return self._send(400, {"ok": False, "error": str(error)})
                except OSError as error:
                    return self._send(500, {"ok": False, "error": "导入失败: " + str(error)})
            return self._send(200, {"ok": True, "observed": meta})
        if u.path == "/api/frames":
            write_json(DATA / "param.json", body)
            return self._send(200, {"ok": True, "saved": str(DATA / "param.json")})
        if u.path == "/api/marks":
            with FILE_LOCK:
                write_json(DATA / "marks.json", body)
                meta, err = build_observed(body)
                if err:
                    return self._send(400, {"ok": False, "error": err})
                if meta is not None:
                    write_json(DATA / "observed_meta.json", meta)
            return self._send(200, {"ok": True, "observed": meta})
        if u.path == "/api/sweep":
            with STATE_LOCK:
                if SWEEP["proc"] is not None and SWEEP["proc"].poll() is None:
                    return self._send(409, {"ok": False, "error": "已有搜索在跑"})
                if not (DATA / "observed.txt").is_file():
                    return self._send(400, {"ok": False, "error": "还没有标注, 先完成标注"})
                backend = body.get("backend", "cuda")
                if backend not in ("cpu", "cuda"):
                    return self._send(400, {"ok": False, "error": "主机搜索仅支持 cpu 或 cuda 后端."})
                searcher = CPU_SEARCHER if backend == "cpu" else SEARCHER
                if not searcher.is_file():
                    return self._send(400, {"ok": False, "error": f"搜索器未编译: {searcher}"})
                cmd = sweep_command(body)
                log = WORK / f"sweep-{backend}.log"
                with open(log, "wb") as fh:
                    SWEEP["proc"] = subprocess.Popen(cmd, cwd=str(WORK), stdout=fh, stderr=subprocess.STDOUT)
                SWEEP["backend"] = backend
                SWEEP["started"] = time.time()
                SWEEP["range"] = [int(cmd[3]), int(cmd[4])]
                SWEEP["finished"] = None
                SWEEP["stopping"] = False
                SWEEP["log"] = log
                threading.Thread(target=search_progress.watch_exit, args=(SWEEP, SWEEP["proc"], STATE_LOCK), daemon=True).start()
            return self._send(200, {"ok": True, "cmd": " ".join(cmd), "log": str(log)})
        if u.path == "/api/sweep/stop":
            with STATE_LOCK:
                if SWEEP["proc"] and SWEEP["proc"].poll() is None:
                    SWEEP["stopping"] = True
                    SWEEP["proc"].terminate()
            return self._send(200, {"ok": True})
        return self._send(404, {"error": "no route"})


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8791)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--open", action="store_true")
    a = ap.parse_args()
    ensure_dirs()
    srv = ThreadingHTTPServer((a.host, a.port), Handler)
    url = f"http://{a.host}:{a.port}/"
    print(f"控制台: {url}")
    print(f"截图目录: {FRAMES}   (把截图丢进去, 刷新页面即可看到)")
    if a.open:
        threading.Timer(0.4, lambda: webbrowser.open(url)).start()
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止")


if __name__ == "__main__":
    sys.exit(main())

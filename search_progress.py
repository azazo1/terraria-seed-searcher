"""从主机搜索输出提取进度, 每次仅读取日志尾部."""
import re
import time

TAIL_BYTES = 65536


def read_tail(path):
    if not path:
        return ""
    try:
        with open(path, "rb") as stream:
            stream.seek(0, 2)
            size = stream.tell()
            stream.seek(max(0, size - TAIL_BYTES))
            data = stream.read(TAIL_BYTES)
        if size > TAIL_BYTES:
            data = data.partition(b"\n")[2]
        # 写入中的半行留到下一次刷新, 防止将半个数字当成完整进度.
        return data[:data.rfind(b"\n") + 1].decode("utf-8", errors="replace")
    except OSError:
        return ""


def parse_progress(text, backend, seed_range):
    start, end = seed_range
    total = end - start
    scanned = 0
    candidates = 0
    for line in text.splitlines():
        if backend == "cpu":
            match = re.search(r"Progress (\d+)/(\d+), .*?matched (\d+), retained (\d+)", line)
            final = re.search(r"(?:Complete|Stopped): scanned=(\d+) candidates=(\d+)(?: matched=(\d+))?", line)
            if match and int(match[2]) == total:
                scanned = max(scanned, int(match[1]))
                candidates = int(match[3])
            elif final:
                scanned = max(scanned, int(final[1]))
                # 最终输出统计的是保存下来的候选; 保留之前报告的累计命中数.
                candidates = max(candidates, int(final[3] or final[2]))
        else:
            match = re.search(r"批\s+(\d+)\.\.(\d+)\s+完成,.*?累计候选\s+(\d+)", line)
            if match and start <= int(match[1]) < int(match[2]) <= end:
                scanned = max(scanned, int(match[2]) - start)
                candidates = int(match[3])
    return {"scanned": min(total, scanned), "total": total, "next": start + min(total, scanned), "candidates": candidates}


def watch_exit(sweep, process, lock):
    """独立等待进程退出, 页面暂停轮询时仍能记录准确的结束时间."""
    process.wait()
    if process.poll() is None:
        return
    finished = time.time()
    with lock:
        if sweep.get("proc") is process and sweep.get("finished") is None:
            sweep["finished"] = finished


def snapshot(sweep, now):
    """调用方持有状态锁, 完成后冻结耗时并保留实际完成的计数."""
    process = sweep.get("proc")
    seed_range = sweep.get("range")
    if process is None or not seed_range:
        return None
    code = process.poll()
    if code is not None and sweep.get("finished") is None:
        sweep["finished"] = now
    elapsed = max(0, (sweep.get("finished") or now) - sweep["started"])
    progress = parse_progress(read_tail(sweep.get("log")), sweep.get("backend", "cuda"), seed_range)
    if code is None:
        status = "stopping" if sweep.get("stopping") else "running"
    elif sweep.get("stopping"):
        status = "stopped"
    elif code != 0 or progress["scanned"] != progress["total"]:
        status = "failed"
    else:
        status = "completed"
    rate = progress["scanned"] / elapsed if elapsed > 0 and progress["scanned"] else None
    eta = (progress["total"] - progress["scanned"]) / rate if rate and status == "running" else None
    return {**progress, "status": status, "elapsed": round(elapsed, 3), "rate": rate, "eta": eta, "exit_code": code}

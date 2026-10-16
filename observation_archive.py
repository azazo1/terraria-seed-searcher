"""最终搜索观测的文件格式与输入校验, 不包含截图或标注画布."""
import math

FORMAT = "terraria-seed-searcher/observation"
VERSION = 1
MAX_BYTES = 8 * 1024 * 1024
MAX_COLUMNS = 100000
MISSING = -999


def validate_observation(raw):
    if not isinstance(raw, dict) or raw.get("format") != FORMAT or type(raw.get("version")) is not int or raw["version"] != VERSION:
        raise ValueError("不是受支持的最终观测文件或文件版本不受支持.")
    if set(raw) != {"format", "version", "heights", "marker"}:
        raise ValueError("观测文件只能包含格式版本, 逐列高度和出生点观测列号.")
    heights, marker = raw["heights"], raw["marker"]
    if not isinstance(heights, list) or not 1 <= len(heights) <= MAX_COLUMNS:
        raise ValueError(f"观测列数必须在 1-{MAX_COLUMNS} 范围内.")
    if type(marker) is not int or not 0 <= marker < MAX_COLUMNS:
        raise ValueError("出生点观测列号必须是有效的非负整数.")
    if any(type(y) not in (int, float) or (y != MISSING and not 0 <= y <= 1000000) or not math.isfinite(y) for y in heights):
        raise ValueError("高度必须是有限的非负数值, 缺失或作废列使用 -999.")
    if all(y == MISSING for y in heights):
        raise ValueError("观测必须至少包含一个有效高度.")
    return {"format": FORMAT, "version": VERSION, "heights": list(heights), "marker": marker}


def from_text(text, marker):
    return validate_observation({"format": FORMAT, "version": VERSION, "heights": [float(y) for y in text.split()], "marker": marker})


def to_text(observation):
    return " ".join(format(y, ".17g") for y in observation["heights"]) + "\n"


def summary(observation):
    heights = observation["heights"]
    valid = sum(y != MISSING for y in heights)
    stepped = sum(a != MISSING and b != MISSING and abs(a - b) >= 1 for a, b in zip(heights, heights[1:]))
    return {"columns": len(heights), "valid": valid, "marker": observation["marker"], "step_rate": round(100.0 * stepped / max(1, valid - 1), 1)}

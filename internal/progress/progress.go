// Package progress 从搜索器日志尾部提取进度, 不读取整份日志.
package progress

import (
	"os"
	"regexp"
	"strconv"
	"strings"
)

const TailBytes = 65536

// Progress 是一次搜索进度快照.
type Progress struct {
	Scanned    int64 `json:"scanned"`
	Total      int64 `json:"total"`
	Next       int64 `json:"next"`
	Candidates int64 `json:"candidates"`
}

var (
	cpuLine    = regexp.MustCompile(`Progress (\d+)/(\d+),.*?matched (\d+), retained (\d+)`)
	cpuFinal   = regexp.MustCompile(`(?:Complete|Stopped): scanned=(\d+) candidates=(\d+)(?: matched=(\d+))?`)
	deviceLine = regexp.MustCompile(`批\s+(\d+)\.\.(\d+)\s+完成,.*?累计候选\s+(\d+)`)
)

// ReadTail 读取日志最后一段, 并丢弃写入中的半行.
func ReadTail(path string) string {
	if path == "" {
		return ""
	}
	file, err := os.Open(path)
	if err != nil {
		return ""
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return ""
	}
	offset := info.Size() - TailBytes
	if offset < 0 {
		offset = 0
	}
	buffer := make([]byte, info.Size()-offset)
	if _, err := file.ReadAt(buffer, offset); err != nil {
		return ""
	}
	if info.Size() > TailBytes {
		if index := strings.IndexByte(string(buffer), '\n'); index >= 0 {
			buffer = buffer[index+1:]
		} else {
			return ""
		}
	}
	if index := strings.LastIndexByte(string(buffer), '\n'); index >= 0 {
		buffer = buffer[:index+1]
	} else {
		return ""
	}
	return string(buffer)
}

// Parse 按后端提取已扫描数与累计候选.
func Parse(text, backend string, seedRange [2]int64) Progress {
	start, end := seedRange[0], seedRange[1]
	total := end - start
	var scanned, candidates int64
	for _, line := range strings.Split(text, "\n") {
		if backend == "cpu" {
			if match := cpuLine.FindStringSubmatch(line); match != nil {
				denominator, _ := strconv.ParseInt(match[2], 10, 64)
				if denominator == total {
					value, _ := strconv.ParseInt(match[1], 10, 64)
					if value > scanned {
						scanned = value
					}
					candidates, _ = strconv.ParseInt(match[3], 10, 64)
				}
				continue
			}
			if match := cpuFinal.FindStringSubmatch(line); match != nil {
				value, _ := strconv.ParseInt(match[1], 10, 64)
				if value > scanned {
					scanned = value
				}
				matched := match[2]
				if match[3] != "" {
					matched = match[3]
				}
				value, _ = strconv.ParseInt(matched, 10, 64)
				if value > candidates {
					candidates = value
				}
			}
			continue
		}
		if match := deviceLine.FindStringSubmatch(line); match != nil {
			from, _ := strconv.ParseInt(match[1], 10, 64)
			to, _ := strconv.ParseInt(match[2], 10, 64)
			if start <= from && from < to && to <= end {
				value := to - start
				if value > scanned {
					scanned = value
				}
				candidates, _ = strconv.ParseInt(match[3], 10, 64)
			}
		}
	}
	if scanned > total {
		scanned = total
	}
	return Progress{Scanned: scanned, Total: total, Next: start + scanned, Candidates: candidates}
}

// Package candidate 解析搜索器写出的候选文件.
package candidate

import (
	"bufio"
	"os"
	"strconv"
	"strings"
)

// Candidate 是一条候选记录, Score 使用千万分比整数保存.
type Candidate struct {
	Seed  int64   `json:"seed"`
	Spawn int64   `json:"spawn"`
	Scale float64 `json:"scale"`
	Score int64   `json:"score"`
}

// ReadFile 读取候选文件的前 limit 条, 文件不存在时返回空.
func ReadFile(path string, limit int) []Candidate {
	file, err := os.Open(path)
	if err != nil {
		return nil
	}
	defer file.Close()
	scanner := bufio.NewScanner(file)
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	rows := make([]Candidate, 0, limit)
	for scanner.Scan() {
		row, ok := parseLine(scanner.Text())
		if !ok {
			continue
		}
		rows = append(rows, row)
		if limit > 0 && len(rows) >= limit {
			break
		}
	}
	return rows
}

func parseLine(line string) (Candidate, bool) {
	fields := make(map[string]string, 4)
	for _, item := range strings.Fields(line) {
		key, value, found := strings.Cut(item, "=")
		if !found {
			continue
		}
		fields[key] = value
	}
	seed, err := strconv.ParseInt(fields["seed"], 10, 64)
	if err != nil {
		return Candidate{}, false
	}
	spawn, err := strconv.ParseInt(fields["spawn_x"], 10, 64)
	if err != nil {
		return Candidate{}, false
	}
	scale, err := strconv.ParseFloat(fields["scale"], 64)
	if err != nil {
		return Candidate{}, false
	}
	score, err := strconv.ParseFloat(fields["score"], 64)
	if err != nil {
		return Candidate{}, false
	}
	return Candidate{Seed: seed, Spawn: spawn, Scale: scale, Score: int64(score*10000000 + 0.5)}, true
}

// Lines 把候选转成页面展示用的文本行.
func Lines(rows []Candidate) []string {
	result := make([]string, len(rows))
	for index, row := range rows {
		result[index] = "seed=" + strconv.FormatInt(row.Seed, 10) +
			" spawn_x=" + strconv.FormatInt(row.Spawn, 10) +
			" scale=" + strconv.FormatFloat(row.Scale, 'g', 9, 64) +
			" score=" + strconv.FormatFloat(float64(row.Score)/10000000, 'f', 7, 64)
	}
	return result
}

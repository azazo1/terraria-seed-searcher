// Package observation 处理最终搜索观测的文件格式与输入校验.
// 观测只包含以格为单位的逐列高度和出生点列号, 不包含截图或画布标记.
package observation

import (
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"strconv"
	"strings"
)

const (
	Format     = "terraria-seed-searcher/observation"
	Version    = 1
	MaxBytes   = 8 * 1024 * 1024
	MaxColumns = 100000
	Missing    = -999
)

// Observation 是观测的规范形式.
type Observation struct {
	Format  string    `json:"format"`
	Version int       `json:"version"`
	Heights []float64 `json:"heights"`
	Marker  int       `json:"marker"`
}

// Summary 是页面展示用的统计.
type Summary struct {
	Columns  int     `json:"columns"`
	Valid    int     `json:"valid"`
	Marker   int     `json:"marker"`
	StepRate float64 `json:"step_rate"`
}

var (
	ErrFormat   = errors.New("不是受支持的最终观测文件或文件版本不受支持.")
	ErrFields   = errors.New("观测文件只能包含格式版本, 逐列高度和出生点观测列号.")
	ErrColumns  = errors.New(fmt.Sprintf("观测列数必须在 1-%d 范围内.", MaxColumns))
	ErrMarker   = errors.New("出生点观测列号必须是有效的非负整数.")
	ErrHeights  = errors.New("高度必须是有限的非负数值, 缺失或作废列使用 -999.")
	ErrNoHeight = errors.New("观测必须至少包含一个有效高度.")
)

// Validate 校验一个已经解码成通用 JSON 值的观测对象.
func Validate(raw any) (Observation, error) {
	object, ok := raw.(map[string]any)
	if !ok {
		return Observation{}, ErrFormat
	}
	if format, _ := object["format"].(string); format != Format {
		return Observation{}, ErrFormat
	}
	version, ok := integerValue(object["version"])
	if !ok || version != Version {
		return Observation{}, ErrFormat
	}
	if len(object) != 4 || object["heights"] == nil || object["marker"] == nil {
		return Observation{}, ErrFields
	}
	for key := range object {
		if key != "format" && key != "version" && key != "heights" && key != "marker" {
			return Observation{}, ErrFields
		}
	}
	heightsRaw, ok := object["heights"].([]any)
	if !ok || len(heightsRaw) < 1 || len(heightsRaw) > MaxColumns {
		return Observation{}, ErrColumns
	}
	marker, ok := integerValue(object["marker"])
	if !ok || marker < 0 || marker >= MaxColumns {
		return Observation{}, ErrMarker
	}
	heights := make([]float64, len(heightsRaw))
	valid := false
	for index, item := range heightsRaw {
		value, ok := numberValue(item)
		if !ok || math.IsNaN(value) || math.IsInf(value, 0) || (value != Missing && (value < 0 || value > 1000000)) {
			return Observation{}, ErrHeights
		}
		if value != Missing {
			valid = true
		}
		heights[index] = value
	}
	if !valid {
		return Observation{}, ErrNoHeight
	}
	return Observation{Format: Format, Version: Version, Heights: heights, Marker: marker}, nil
}

// FromText 把搜索器读取的空白分隔高度文本转成观测.
func FromText(text string, marker int) (Observation, error) {
	fields := strings.Fields(text)
	heights := make([]float64, len(fields))
	for index, field := range fields {
		value, err := strconv.ParseFloat(field, 64)
		if err != nil {
			return Observation{}, ErrHeights
		}
		heights[index] = value
	}
	return Validate(map[string]any{
		"format":  Format,
		"version": Version,
		"heights": floatsToAny(heights),
		"marker":  marker,
	})
}

// ToText 按搜索器接受的格式输出, 保留浮点精度.
func ToText(observation Observation) string {
	parts := make([]string, len(observation.Heights))
	for index, value := range observation.Heights {
		parts[index] = strconv.FormatFloat(value, 'g', 17, 64)
	}
	return strings.Join(parts, " ") + "\n"
}

// Summarize 统计有效列和逐列高度跳变比例.
func Summarize(observation Observation) Summary {
	valid := 0
	stepped := 0
	for index, value := range observation.Heights {
		if value != Missing {
			valid++
		}
		if index > 0 && value != Missing && observation.Heights[index-1] != Missing {
			if math.Abs(value-observation.Heights[index-1]) >= 1 {
				stepped++
			}
		}
	}
	denominator := valid - 1
	if denominator < 1 {
		denominator = 1
	}
	rate := 100.0 * float64(stepped) / float64(denominator)
	return Summary{Columns: len(observation.Heights), Valid: valid, Marker: observation.Marker, StepRate: round1(rate)}
}

// DecodeRaw 用 UseNumber 解析请求体, 保留整数与浮点的区别.
func DecodeRaw(data []byte) (any, error) {
	decoder := json.NewDecoder(strings.NewReader(string(data)))
	decoder.UseNumber()
	var value any
	if err := decoder.Decode(&value); err != nil {
		return nil, err
	}
	return value, nil
}

func integerValue(value any) (int, bool) {
	switch typed := value.(type) {
	case json.Number:
		text := typed.String()
		if strings.ContainsRune(text, '.') || strings.ContainsRune(text, 'e') || strings.ContainsRune(text, 'E') {
			return 0, false
		}
		parsed, err := strconv.ParseInt(text, 10, 64)
		if err != nil {
			return 0, false
		}
		return int(parsed), true
	case float64:
		if typed != math.Trunc(typed) {
			return 0, false
		}
		return int(typed), true
	case int:
		return typed, true
	case int64:
		return int(typed), true
	}
	return 0, false
}

func numberValue(value any) (float64, bool) {
	switch typed := value.(type) {
	case json.Number:
		parsed, err := typed.Float64()
		return parsed, err == nil
	case float64:
		return typed, true
	case int:
		return float64(typed), true
	case int64:
		return float64(typed), true
	}
	return 0, false
}

func floatsToAny(values []float64) []any {
	result := make([]any, len(values))
	for index, value := range values {
		result[index] = value
	}
	return result
}

func round1(value float64) float64 {
	return math.Round(value*10) / 10
}

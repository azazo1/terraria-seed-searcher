// Package task 负责持久化搜索任务, 事务断点和跨平台工作块调度.
package task

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io/fs"
	"math"
	"os"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/azazo1/terraria-seed-searcher/internal/observation"
)

const (
	SchemaVersion = 1
	// Algorithm 只标识生成算法版本, 名字里的 medium 是历史叫法; 世界尺寸在 Parameters.World 里.
	Algorithm = "terraria-1.4.5.8-medium-v1"
	CPUBlock  = 65536
	// CUDA 工作块按百万种子一级: 块太小时每块的提交与批边界开销会盖过 GPU 时间, 也拖粗断点.
	CUDABlock = 1000000
	// MLX 每次启动都要编译 Metal 内核, 工作块需要足够大才能摊薄固定开销.
	MLXBlock = 4000000
	// 出生点由 WorldGen 的 SpawnPoint pass 定在 maxTilesX/2 + genRand.Next(-5, 5),
	// 世界中心 0.48W 到 0.52W 被强制成平台, 两个扩大范围的条件都不会触发,
	// 所以出生点只在世界中心加减 5 这几格上.
	spawnJitter = 5
	// 容差吸收标注列与真实出生点之间的偏差. 实测一次标偏 38 列的观测, 取 64 仍有余量.
	spawnTolerance = 64
)

// WorldGeometry 是地形生成用到的世界尺寸与分段边界.
// 分段窗口由 WorldGen 的双精度比较导出: [roll_lo, roll_hi] 等价于 x > W*0.45 && x < W*0.55,
// 地表限制取 H*0.17 / H*0.23 / H*0.26 的截断. 这些值在三个世界尺寸上都是精确整数.
type WorldGeometry struct {
	Name       string
	Width      int
	Height     int
	RollLo     int  // 特征重抽窗口起点 (含)
	RollHi     int  // 特征重抽窗口终点 (含)
	PlateauLo  int  // 强制平台窗口起点 (含)
	PlateauHi  int  // 强制平台窗口终点 (含)
	SurfMin    int  // 地表下限
	SurfMinEps bool // 下限比整数大一点点 (H*0.17 不是精确整数), 钳制比较要含端点
	SurfBeach  int  // 海滩段上限
	SurfMax    int  // 内陆段上限
}

// 三个世界尺寸. 中世界一行必须与既有搜索器逐位一致, 改这里要先对拍三个后端.
var worldGeometries = map[string]WorldGeometry{
	"small":  {Name: "small", Width: 4200, Height: 1200, RollLo: 1891, RollHi: 2309, PlateauLo: 2017, PlateauHi: 2183, SurfMin: 204, SurfMinEps: true, SurfBeach: 276, SurfMax: 312},
	"medium": {Name: "medium", Width: 6400, Height: 1800, RollLo: 2881, RollHi: 3520, PlateauLo: 3073, PlateauHi: 3327, SurfMin: 306, SurfMinEps: false, SurfBeach: 414, SurfMax: 468},
	"large":  {Name: "large", Width: 8400, Height: 2400, RollLo: 3781, RollHi: 4619, PlateauLo: 4033, PlateauHi: 4367, SurfMin: 408, SurfMinEps: true, SurfBeach: 552, SurfMax: 624},
}

// WorldNames 是支持的世界尺寸, 顺序供界面展示.
var WorldNames = []string{"small", "medium", "large"}

// LookupWorld 返回世界几何. 空名字按中世界处理, 兼容旧任务存档.
func LookupWorld(name string) WorldGeometry {
	if geometry, ok := worldGeometries[name]; ok {
		return geometry
	}
	return worldGeometries["medium"]
}

// SpawnWindow 给出工作台自动使用的出生点世界列范围.
func SpawnWindow(world string, cols int) (int, int) {
	center := LookupWorld(world).Width / 2
	lo := center - spawnJitter - spawnTolerance
	hi := center + spawnJitter + spawnTolerance
	if lo < 0 {
		lo = 0
	}
	if hi > cols-1 {
		hi = cols - 1
	}
	return lo, hi
}

// CandidateFiles 是各后端的工作目录候选文件名.
var CandidateFiles = map[string]string{
	"cpu":  "candidates_cpu.txt",
	"cuda": "candidates_gpu2.txt",
	"mlx":  "candidates_mlx.txt",
}

// HostBackends 是主机原生后端.
var HostBackends = []string{"cpu", "cuda", "mlx"}

var scalesPattern = regexp.MustCompile(`^(?:\d+(?:\.\d*)?|\.\d+)$`)

// Parameters 是搜索参数.
type Parameters struct {
	Tol     float64  `json:"tol"`
	Offer   float64  `json:"offer"`
	Range   [2]int64 `json:"range"`
	SpawnLo int      `json:"spawn_lo"`
	SpawnHi int      `json:"spawn_hi"`
	Cols    int      `json:"cols"`
	Scales  string   `json:"scales"`
	Batch   int64    `json:"batch"`
	Device  int      `json:"device"`
	// World 是世界尺寸. 空值表示中世界, 这样旧任务存档可以原样恢复.
	World string `json:"world,omitempty"`
}

// WorldName 返回规范化的世界尺寸名.
func (p Parameters) WorldName() string {
	return LookupWorld(p.World).Name
}

// Defaults 与旧版工作台保持一致. 出生点范围按世界规则推导, 不写死.
func Defaults() Parameters {
	lo, hi := SpawnWindow("medium", 3400)
	return Parameters{Tol: .5, Offer: .55, Range: [2]int64{0, 2147483647}, SpawnLo: lo, SpawnHi: hi, Cols: 3400, Scales: "1.00", Batch: 1000000, Device: 0, World: "medium"}
}

// Meta 是任务元数据.
type Meta struct {
	Version     int                     `json:"version"`
	ID          string                  `json:"id"`
	Algorithm   string                  `json:"algorithm"`
	Fingerprint string                  `json:"fingerprint"`
	EngineKey   string                  `json:"engine_key"`
	Backend     string                  `json:"backend"`
	Parameters  Parameters              `json:"parameters"`
	Observation observation.Observation `json:"observation"`
	Next        int64                   `json:"next"`
	Elapsed     float64                 `json:"elapsed"`
	Matched     int64                   `json:"matched"`
	Status      string                  `json:"status"`
	Updated     float64                 `json:"updated"`
	Error       string                  `json:"error,omitempty"`
	LastBlock   string                  `json:"last_block,omitempty"`
}

// Progress 是任务列表里展示的进度.
type Progress struct {
	Status     string   `json:"status"`
	Scanned    int64    `json:"scanned"`
	Total      int64    `json:"total"`
	Elapsed    float64  `json:"elapsed"`
	Rate       *float64 `json:"rate"`
	ETA        *float64 `json:"eta"`
	Candidates int64    `json:"candidates"`
}

// Summary 是任务列表项.
type Summary struct {
	ID         string     `json:"id"`
	Backend    string     `json:"backend"`
	Updated    float64    `json:"updated"`
	Parameters Parameters `json:"parameters"`
	Next       int64      `json:"next"`
	Status     string     `json:"status"`
	Error      *string    `json:"error"`
	CanResume  bool       `json:"can_resume"`
	Compatible bool       `json:"compatible"`
	Progress   Progress   `json:"progress"`
	Version    string     `json:"version"`
}

func now() float64 {
	return float64(time.Now().UnixNano()) / 1e9
}

func fingerprint(backend, key string, settings Parameters, obs observation.Observation) string {
	payload, _ := json.Marshal([]any{Algorithm, backend, key, settings, obs})
	sum := sha256.Sum256(payload)
	return hex.EncodeToString(sum[:])
}

// ParseParameters 校验并规范化前端提交的参数.
func ParseParameters(raw any) (Parameters, error) {
	object, ok := raw.(map[string]any)
	if !ok {
		return Parameters{}, fmt.Errorf("搜索参数必须是对象.")
	}
	merged := Defaults()
	result := Parameters{}
	fields := map[string]func(any) error{
		"tol":      func(v any) error { return assignFloat(v, &result.Tol) },
		"offer":    func(v any) error { return assignFloat(v, &result.Offer) },
		"spawn_lo": func(v any) error { return assignInt(v, &result.SpawnLo) },
		"spawn_hi": func(v any) error { return assignInt(v, &result.SpawnHi) },
		"cols":     func(v any) error { return assignInt(v, &result.Cols) },
		"batch":    func(v any) error { return assignInt64(v, &result.Batch) },
		"device":   func(v any) error { return assignInt(v, &result.Device) },
		"scales": func(v any) error {
			text, ok := v.(string)
			if !ok {
				return fmt.Errorf("搜索尺度无效.")
			}
			result.Scales = text
			return nil
		},
		"world": func(v any) error {
			name, ok := v.(string)
			if !ok {
				return fmt.Errorf("世界尺寸无效.")
			}
			if _, ok := worldGeometries[name]; !ok {
				return fmt.Errorf("世界尺寸必须是 small, medium 或 large.")
			}
			result.World = name
			return nil
		},
		"range": func(v any) error {
			items, ok := v.([]any)
			if !ok || len(items) != 2 {
				return fmt.Errorf("种子范围无效.")
			}
			for index, item := range items {
				value, err := toInteger(item)
				if err != nil {
					return fmt.Errorf("种子范围无效.")
				}
				result.Range[index] = value
			}
			return nil
		},
	}
	result = merged
	for key := range object {
		if _, known := fields[key]; !known {
			return Parameters{}, fmt.Errorf("搜索参数包含未知字段.")
		}
	}
	for key, assign := range fields {
		value, present := object[key]
		if !present {
			continue
		}
		if err := assign(value); err != nil {
			return Parameters{}, err
		}
	}
	if result.Tol < .01 || result.Tol > 10 {
		return Parameters{}, fmt.Errorf("搜索参数 tol 无效.")
	}
	if result.Offer < 0 || result.Offer > 1 {
		return Parameters{}, fmt.Errorf("搜索参数 offer 无效.")
	}
	geometry := LookupWorld(result.World)
	if result.SpawnLo < 0 || result.SpawnLo >= geometry.Width || result.SpawnHi < 0 || result.SpawnHi >= geometry.Width {
		return Parameters{}, fmt.Errorf("搜索参数 spawn_lo 或 spawn_hi 无效.")
	}
	if result.Cols < 1 || result.Cols > geometry.Width {
		return Parameters{}, fmt.Errorf("搜索参数 cols 无效.")
	}
	if result.Batch < 1 || result.Batch > 2147483647 {
		return Parameters{}, fmt.Errorf("搜索参数 batch 无效.")
	}
	if result.Device < -1 || result.Device > 1024 {
		return Parameters{}, fmt.Errorf("搜索参数 device 无效.")
	}
	if result.Range[0] < 0 || result.Range[0] >= result.Range[1] || result.Range[1] > 2147483647 {
		return Parameters{}, fmt.Errorf("种子范围无效.")
	}
	if !(result.SpawnLo <= result.SpawnHi && result.SpawnHi < result.Cols) {
		return Parameters{}, fmt.Errorf("出生点范围超出模拟范围.")
	}
	scales := strings.Split(result.Scales, ",")
	if len(scales) < 1 || len(scales) > 8 {
		return Parameters{}, fmt.Errorf("搜索尺度无效.")
	}
	for _, item := range scales {
		item = strings.TrimSpace(item)
		if !scalesPattern.MatchString(item) {
			return Parameters{}, fmt.Errorf("搜索尺度无效.")
		}
		value, err := strconv.ParseFloat(item, 64)
		if err != nil || value < .1 || value > 10 {
			return Parameters{}, fmt.Errorf("搜索尺度无效.")
		}
	}
	return result, nil
}

func assignFloat(value any, target *float64) error {
	parsed, ok := toFloat(value)
	if !ok || math.IsNaN(parsed) || math.IsInf(parsed, 0) {
		return fmt.Errorf("搜索参数无效.")
	}
	*target = parsed
	return nil
}

func assignInt(value any, target *int) error {
	parsed, err := toInteger(value)
	if err != nil || int64(int(parsed)) != parsed {
		return fmt.Errorf("搜索参数无效.")
	}
	*target = int(parsed)
	return nil
}

func assignInt64(value any, target *int64) error {
	parsed, err := toInteger(value)
	if err != nil {
		return fmt.Errorf("搜索参数无效.")
	}
	*target = parsed
	return nil
}

func toInteger(value any) (int64, error) {
	switch typed := value.(type) {
	case json.Number:
		return strconv.ParseInt(typed.String(), 10, 64)
	case float64:
		if typed != math.Trunc(typed) {
			return 0, fmt.Errorf("不是整数")
		}
		return int64(typed), nil
	case int:
		return int64(typed), nil
	case int64:
		return typed, nil
	}
	return 0, fmt.Errorf("不是数字")
}

func toFloat(value any) (float64, bool) {
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

// EngineKey 计算可执行文件的哈希, 用于判断搜索器版本是否变化.
func EngineKey(path string) (string, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:]), nil
}

// WebGPUKey 由三个前端搜索文件的内容决定. fsys 的根是 web/ 目录.
func WebGPUKey(fsys fs.FS) string {
	hash := sha256.New()
	for _, name := range []string{"gpu/search.wgsl", "gpu/terrain-reference.js", "gpu/search-engine.js"} {
		data, err := fs.ReadFile(fsys, name)
		if err != nil {
			return ""
		}
		hash.Write(data)
	}
	return hex.EncodeToString(hash.Sum(nil))
}

// ValidateCreate 校验观测和参数是否覆盖模拟区域.
func ValidateCreate(settings Parameters, obs observation.Observation) error {
	valid := 0
	for _, value := range obs.Heights {
		if value != observation.Missing {
			valid++
		}
	}
	if valid < 20 || len(obs.Heights) > 700 {
		return fmt.Errorf("搜索需要至少 20 个有效列和最多 700 个观测列.")
	}
	base := int64(settings.SpawnLo - obs.Marker)
	width := int64(settings.SpawnHi - settings.SpawnLo + 1)
	maximumScale := 0.0
	for _, item := range strings.Split(settings.Scales, ",") {
		value, _ := strconv.ParseFloat(strings.TrimSpace(item), 64)
		if value > maximumScale {
			maximumScale = value
		}
	}
	maximumShift := int64(math.Floor(float64(len(obs.Heights)-1)*maximumScale + .5))
	simulated := int64(settings.Cols)
	if base+width+maximumShift < simulated {
		simulated = base + width + maximumShift
	}
	if simulated <= maxInt64(0, base) {
		return fmt.Errorf("出生点范围和观测列号没有覆盖模拟区域.")
	}
	return nil
}

func maxInt64(a, b int64) int64 {
	if a > b {
		return a
	}
	return b
}

// SortSummaries 按更新时间倒序排列.
func SortSummaries(items []Summary) {
	sort.Slice(items, func(i, j int) bool { return items[i].Updated > items[j].Updated })
}

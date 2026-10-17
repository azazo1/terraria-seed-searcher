package progress

import "testing"

func TestParseCPULine(t *testing.T) {
	text := "Host CPU: 8 threads\nProgress 120/1000, 1.2M seeds/s, matched 3, retained 2\n"
	result := Parse(text, "cpu", [2]int64{0, 1000})
	if result.Scanned != 120 || result.Total != 1000 || result.Next != 120 || result.Candidates != 3 {
		t.Fatalf("unexpected progress: %+v", result)
	}
}

func TestParseCPUFinal(t *testing.T) {
	text := "Complete: scanned=1000 candidates=7\n"
	result := Parse(text, "cpu", [2]int64{0, 1000})
	if result.Scanned != 1000 || result.Candidates != 7 {
		t.Fatalf("unexpected progress: %+v", result)
	}
}

func TestParseCUDA(t *testing.T) {
	text := "  批 400000..800000 完成, 本批达标 2 条, 累计候选 9, 进度 20.000%\n"
	result := Parse(text, "cuda", [2]int64{0, 2000000})
	if result.Scanned != 800000 || result.Next != 800000 || result.Candidates != 9 {
		t.Fatalf("unexpected progress: %+v", result)
	}
}

func TestParseCUDAIgnoresOutOfRange(t *testing.T) {
	text := "  批 900..1000 完成, 本批达标 0 条, 累计候选 0, 进度 10.000%\n"
	result := Parse(text, "cuda", [2]int64{1000, 2000})
	if result.Scanned != 0 {
		t.Fatalf("out of range batch must be ignored: %+v", result)
	}
}

// 常驻模式下同一个日志里有多块的进度行和确认行, 当前块只能认自己那块.
func TestParseCUDAWorkerLog(t *testing.T) {
	text := "  批 0..1000000 完成, 本批达标 2 条, 累计候选 9, 进度 0.047%, GPU 0.113 s\n" +
		"块 0..1000000 完成\n" +
		"  批 1000000..1002000 完成, 本批达标 0 条, 累计候选 9, 进度 0.047%, GPU 0.002 s\n"
	result := Parse(text, "cuda", [2]int64{1000000, 1002000})
	if result.Scanned != 2000 || result.Next != 1002000 || result.Candidates != 9 {
		t.Fatalf("unexpected progress: %+v", result)
	}
}

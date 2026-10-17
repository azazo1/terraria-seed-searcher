package task

import (
	"bufio"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// cudaWorker 是一个常驻的 CUDA 搜索器进程.
//
// 每块重起一次进程要重做 CUDA 上下文初始化, 模块加载和剖面缓冲分配. 在快卡上这一块种子
// 只算零点几秒, 剩下的墙钟全是这段开锁开销, 所以一个任务只启动一次进程, 之后通过 stdin
// 逐块派发种子区间. 进程崩溃时工作台仍然活着, 断点停在上一块.
type cudaWorker struct {
	cmd     *exec.Cmd
	stdin   io.WriteCloser
	log     *os.File
	logPath string
	dir     string
	lines   chan string
	done    chan struct{}
	closed  bool
}

// cudaWorkerDone 是搜索器确认一块跑完时打印的行. 与进度行 "批 a..b 完成" 区分开,
// 免得被进度解析当成已完成区间.
func cudaWorkerDone(from, to int64) string {
	return fmt.Sprintf("块 %d..%d 完成", from, to)
}

// startCudaWorker 启动常驻搜索器. taskDir 是任务目录, 搜索器在其中的 worker 子目录里写候选文件.
func startCudaWorker(binary, taskDir, observedPath string, meta Meta) (*cudaWorker, error) {
	if binary == "" {
		return nil, fmt.Errorf("搜索器不存在, 请先编译对应后端.")
	}
	dir := filepath.Join(taskDir, "worker")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, err
	}
	logPath := filepath.Join(taskDir, "sweep-cuda.log")
	log, err := os.OpenFile(logPath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		return nil, err
	}
	settings := meta.Parameters
	args := []string{
		observedPath,
		"--worker",
		"--marker", strconv.Itoa(meta.Observation.Marker),
		"--tol", strconv.FormatFloat(settings.Tol, 'g', -1, 64),
		"--offer", strconv.FormatFloat(settings.Offer, 'g', -1, 64),
		"--batch", strconv.FormatInt(minInt64(settings.Batch, CUDABlock), 10),
		"--device", strconv.Itoa(settings.Device),
		"--spawn-lo", strconv.Itoa(settings.SpawnLo),
		"--spawn-hi", strconv.Itoa(settings.SpawnHi),
		"--cols", strconv.Itoa(settings.Cols),
		"--scales", settings.Scales,
		"--world", settings.WorldName(),
	}
	cmd := exec.Command(binary, args...)
	cmd.Dir = dir
	stdin, err := cmd.StdinPipe()
	if err != nil {
		log.Close()
		return nil, err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		log.Close()
		return nil, err
	}
	cmd.Stderr = log
	if err := cmd.Start(); err != nil {
		log.Close()
		return nil, err
	}
	worker := &cudaWorker{
		cmd: cmd, stdin: stdin, log: log, logPath: logPath, dir: dir,
		lines: make(chan string, 1024), done: make(chan struct{}),
	}
	go worker.pump(stdout)
	return worker, nil
}

// pump 把搜索器的输出同时写进日志和行通道, 供 Run 等待确认行.
func (w *cudaWorker) pump(stdout io.ReadCloser) {
	defer close(w.done)
	defer close(w.lines)
	scanner := bufio.NewScanner(stdout)
	scanner.Buffer(make([]byte, 64*1024), 1024*1024)
	for scanner.Scan() {
		line := scanner.Text()
		_, _ = fmt.Fprintln(w.log, line)
		// 通道满了就丢弃: 派发块之间没人读, 而每块最多几十行输出, 确认行不会掉.
		select {
		case w.lines <- line:
		default:
		}
	}
}

// Run 派发一个工作块, 等搜索器确认整块跑完.
func (w *cudaWorker) Run(from, to int64) error {
	if _, err := fmt.Fprintf(w.stdin, "%d %d\n", from, to); err != nil {
		return fmt.Errorf("搜索器已经退出, 当前工作块未完成.")
	}
	want := cudaWorkerDone(from, to)
	for line := range w.lines {
		if strings.TrimSpace(line) == want {
			return nil
		}
	}
	return fmt.Errorf("搜索进程意外退出, 当前工作块未提交. 请查看运行输出.")
}

// LogPath 是该任务共享的搜索器日志.
func (w *cudaWorker) LogPath() string {
	return w.logPath
}

// Dir 是候选文件所在目录.
func (w *cudaWorker) Dir() string {
	return w.dir
}

// Close 关掉 stdin 让搜索器跑完当前块后退出, 超时则强杀. 只调用一次.
func (w *cudaWorker) Close() {
	if w.closed {
		return
	}
	w.closed = true
	_ = w.stdin.Close()
	select {
	case <-w.done:
	case <-time.After(5 * time.Second):
		if w.cmd.Process != nil {
			_ = w.cmd.Process.Kill()
		}
		<-w.done
	}
	_ = w.cmd.Wait()
	_ = w.log.Close()
}

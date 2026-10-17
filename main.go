// terraria-seed-searcher 本地工作台.
//
// 服务端由 Go 实现, 搜索器 (sweep / sweep-cpu / sweep-mlx) 是独立二进制.
// 页面资源通过 embed 打进可执行文件, 数据目录与搜索器放在可执行文件同目录.
package main

import (
	"embed"
	"flag"
	"fmt"
	"io/fs"
	"log/slog"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"time"

	"github.com/azazo1/terraria-seed-searcher/internal/server"
)

//go:embed web
var webFiles embed.FS

// buildVersion 由发布构建通过 -ldflags 注入, 日常构建保持 dev-build.
var buildVersion = "dev-build"

func main() {
	port := flag.Int("port", 8791, "监听端口")
	host := flag.String("host", "127.0.0.1", "监听地址")
	open := flag.Bool("open", false, "启动后打开浏览器")
	root := flag.String("root", "", "数据目录, 默认为可执行文件所在目录")
	version := flag.Bool("version", false, "显示版本")
	flag.Parse()

	if *version {
		fmt.Printf("terraria-seed-searcher %s\n", buildVersion)
		return
	}

	base := *root
	if base == "" {
		executable, err := os.Executable()
		if err != nil {
			slog.Error("无法定位可执行文件", "error", err)
			os.Exit(1)
		}
		base = filepath.Dir(executable)
	}
	absolute, err := filepath.Abs(base)
	if err != nil {
		slog.Error("无法解析数据目录", "error", err, "path", base)
		os.Exit(1)
	}

	web, err := fs.Sub(webFiles, "web")
	if err != nil {
		slog.Error("页面资源不可用", "error", err)
		os.Exit(1)
	}

	suffix := ""
	if runtime.GOOS == "windows" {
		suffix = ".exe"
	}
	workbench := server.New(server.Config{
		Root:        absolute,
		Web:         web,
		Searcher:    filepath.Join(absolute, "sweep"+suffix),
		CPUSearcher: filepath.Join(absolute, "sweep-cpu"+suffix),
		MLXSearcher: filepath.Join(absolute, "sweep-mlx"),
		Version:     buildVersion,
	})

	url := fmt.Sprintf("http://%s:%d/", *host, *port)
	slog.Info("工作台已启动", "url", url, "root", absolute, "version", buildVersion)
	fmt.Printf("控制台: %s\n", url)
	fmt.Printf("截图目录: %s\n", filepath.Join(absolute, "frames"))
	if *open {
		time.AfterFunc(400*time.Millisecond, func() { openBrowser(url) })
	}
	if err := http.ListenAndServe(fmt.Sprintf("%s:%d", *host, *port), workbench.Handler()); err != nil {
		slog.Error("服务退出", "error", err)
		os.Exit(1)
	}
}

func openBrowser(url string) {
	var command *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		command = exec.Command("open", url)
	case "windows":
		command = exec.Command("rundll32", "url.dll,FileProtocolHandler", url)
	default:
		command = exec.Command("xdg-open", url)
	}
	if err := command.Start(); err != nil {
		slog.Warn("无法打开浏览器", "error", err)
	}
}

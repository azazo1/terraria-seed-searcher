//go:build windows

package task

import (
	"os"

	"golang.org/x/sys/windows"
)

// lockFile 对任务锁文件加非阻塞独占锁, 进程退出时由系统释放.
func lockFile(file *os.File) error {
	var overlapped windows.Overlapped
	return windows.LockFileEx(
		windows.Handle(file.Fd()),
		windows.LOCKFILE_EXCLUSIVE_LOCK|windows.LOCKFILE_FAIL_IMMEDIATELY,
		0, 1, 0, &overlapped,
	)
}

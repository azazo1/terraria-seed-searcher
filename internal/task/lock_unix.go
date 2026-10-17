//go:build !windows

package task

import (
	"os"
	"syscall"
)

// lockFile 对任务锁文件加非阻塞独占锁.
func lockFile(file *os.File) error {
	return syscall.Flock(int(file.Fd()), syscall.LOCK_EX|syscall.LOCK_NB)
}

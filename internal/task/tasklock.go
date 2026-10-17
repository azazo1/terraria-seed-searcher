package task

import (
	"fmt"
	"os"
)

// TaskLock 是任务目录里的操作系统级独占锁, 服务退出时自动释放.
type TaskLock struct {
	file *os.File
}

// Acquire 打开并锁住任务锁文件, 被其他服务占用时返回错误.
func Acquire(path string) (*TaskLock, error) {
	file, err := os.OpenFile(path, os.O_RDWR|os.O_CREATE, 0o644)
	if err != nil {
		return nil, err
	}
	info, err := file.Stat()
	if err != nil {
		_ = file.Close()
		return nil, err
	}
	if info.Size() == 0 {
		if _, err := file.Write([]byte("0")); err != nil {
			_ = file.Close()
			return nil, err
		}
		if err := file.Sync(); err != nil {
			_ = file.Close()
			return nil, err
		}
	}
	if _, err := file.Seek(0, 0); err != nil {
		_ = file.Close()
		return nil, err
	}
	if err := lockFile(file); err != nil {
		_ = file.Close()
		return nil, fmt.Errorf("这个任务正在另一个服务中运行, 请先停止它.")
	}
	return &TaskLock{file: file}, nil
}

// Close 释放锁.
func (l *TaskLock) Close() error {
	if l == nil || l.file == nil {
		return nil
	}
	return l.file.Close()
}

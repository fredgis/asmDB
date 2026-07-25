//go:build !windows

package main

import (
	"os"
	"syscall"
)

func fileAllocatedBytes(path string) (uint64, error) {
	info, err := os.Stat(path)
	if err != nil {
		return 0, err
	}
	if st, ok := info.Sys().(*syscall.Stat_t); ok {
		return uint64(st.Blocks) * 512, nil
	}
	return uint64(info.Size()), nil
}

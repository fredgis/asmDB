//go:build unix

package main

import (
	"fmt"
	"syscall"
)

const statfsReadOnly = 1

func assertShareReadOnly(path string) error {
	var st syscall.Statfs_t
	if err := syscall.Statfs(path, &st); err != nil {
		return fmt.Errorf("cannot inspect share mount: %w", err)
	}
	if st.Flags&statfsReadOnly == 0 {
		return fmt.Errorf("ASMDB_SHARE_ROOT must be mounted read-only")
	}
	return nil
}

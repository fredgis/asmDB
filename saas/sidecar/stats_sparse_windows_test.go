//go:build windows

package main

import (
	"os"
	"syscall"
	"unsafe"
)

const fsctlSetSparse = 0x000900c4

func makeSparseFile(f *os.File) error {
	var returned uint32
	return syscall.DeviceIoControl(
		syscall.Handle(f.Fd()),
		fsctlSetSparse,
		nil,
		0,
		nil,
		0,
		&returned,
		(*syscall.Overlapped)(unsafe.Pointer(nil)),
	)
}

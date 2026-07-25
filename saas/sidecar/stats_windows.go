//go:build windows

package main

import (
	"os"
	"syscall"
	"unsafe"
)

var getCompressedFileSizeW = syscall.NewLazyDLL("kernel32.dll").NewProc("GetCompressedFileSizeW")

func fileAllocatedBytes(path string) (uint64, error) {
	info, err := os.Stat(path)
	if err != nil {
		return 0, err
	}
	p, err := syscall.UTF16PtrFromString(path)
	if err != nil {
		return 0, err
	}
	var high uint32
	low, _, callErr := getCompressedFileSizeW.Call(uintptr(unsafe.Pointer(p)), uintptr(unsafe.Pointer(&high)))
	if low == ^uintptr(0) {
		if errno, ok := callErr.(syscall.Errno); ok && errno != 0 {
			return 0, errno
		}
	}
	n := (uint64(high) << 32) | uint64(uint32(low))
	if n == 0 && info.Size() == 0 {
		return 0, nil
	}
	return n, nil
}

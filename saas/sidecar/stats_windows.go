//go:build windows

package main

import (
	"os"
	"syscall"
	"unsafe"
)

var getCompressedFileSizeW = syscall.NewLazyDLL("kernel32.dll").NewProc("GetCompressedFileSizeW")

func statFileUsage(path string) (fileUsage, error) {
	info, err := os.Stat(path)
	if err != nil {
		return fileUsage{}, err
	}
	usage := fileUsage{apparent: uint64(info.Size())}
	p, err := syscall.UTF16PtrFromString(path)
	if err != nil {
		return usage, nil
	}
	var high uint32
	low, _, callErr := getCompressedFileSizeW.Call(uintptr(unsafe.Pointer(p)), uintptr(unsafe.Pointer(&high)))
	if low == ^uintptr(0) {
		if errno, ok := callErr.(syscall.Errno); ok && errno != 0 {
			return usage, nil
		}
	}
	n := (uint64(high) << 32) | uint64(uint32(low))
	usage.allocated = &n
	return usage, nil
}

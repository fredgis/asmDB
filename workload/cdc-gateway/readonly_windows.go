//go:build windows

package main

import (
	"fmt"
	"syscall"
	"unsafe"
)

const fileReadOnlyVolume = 0x00080000

var (
	kernel32                 = syscall.NewLazyDLL("kernel32.dll")
	procGetVolumePathName    = kernel32.NewProc("GetVolumePathNameW")
	procGetVolumeInformation = kernel32.NewProc("GetVolumeInformationW")
)

func assertShareReadOnly(path string) error {
	pathPtr, err := syscall.UTF16PtrFromString(path)
	if err != nil {
		return err
	}
	volume := make([]uint16, syscall.MAX_PATH)
	r1, _, callErr := procGetVolumePathName.Call(
		uintptr(unsafe.Pointer(pathPtr)),
		uintptr(unsafe.Pointer(&volume[0])),
		uintptr(len(volume)),
	)
	if r1 == 0 {
		return fmt.Errorf("cannot inspect share mount: %w", callErr)
	}
	var flags uint32
	r1, _, callErr = procGetVolumeInformation.Call(
		uintptr(unsafe.Pointer(&volume[0])),
		0, 0, 0, 0,
		uintptr(unsafe.Pointer(&flags)),
		0, 0,
	)
	if r1 == 0 {
		return fmt.Errorf("cannot inspect share mount: %w", callErr)
	}
	if flags&fileReadOnlyVolume == 0 {
		return fmt.Errorf("ASMDB_SHARE_ROOT must be mounted read-only")
	}
	return nil
}

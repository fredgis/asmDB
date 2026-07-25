//go:build !windows

package main

import "os"

func makeSparseFile(f *os.File) error {
	return nil
}

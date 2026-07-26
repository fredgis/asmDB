package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

const incompatibleFormatPrefix = "incompatible database format - refusing to open"

func isIncompatibleFormatError(err error) bool {
	return err != nil && strings.HasPrefix(err.Error(), incompatibleFormatPrefix)
}

func (e *Engine) recoverUpgradeSwapLocked(db string) error {
	dat := db + ".dat"
	old := db + ".dat.old"
	upgraded := db + ".upgraded.dat"
	datOK := fileExists(dat)
	oldOK := fileExists(old)
	upgradedOK := fileExists(upgraded)
	if datOK {
		return nil
	}
	if oldOK && upgradedOK {
		logJSON("warn", "upgrade_swap_recovering", map[string]any{"database": db})
		if err := os.Rename(upgraded, dat); err != nil {
			return fmt.Errorf("complete interrupted upgrade swap: %w", err)
		}
		if err := fsyncDir(filepath.Dir(db)); err != nil {
			return fmt.Errorf("fsync upgrade recovery: %w", err)
		}
		logJSON("info", "upgrade_swap_recovered", map[string]any{"database": db})
		return nil
	}
	if oldOK || upgradedOK {
		return fmt.Errorf("incomplete upgrade swap state for %s: dat=%t old=%t upgraded=%t", db, datOK, oldOK, upgradedOK)
	}
	return nil
}

func (e *Engine) runUpgradeLocked(db string) error {
	upgraded := db + ".upgraded.dat"
	if fileExists(upgraded) {
		return fmt.Errorf("refusing upgrade with existing %s", upgraded)
	}
	logJSON("warn", "upgrade_started", map[string]any{"database": db})
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()
	cmd := exec.CommandContext(ctx, e.bin, db, "--upgrade")
	out, err := cmd.CombinedOutput()
	fields := map[string]any{"database": db}
	if len(out) > 0 {
		fields["output"] = strings.TrimSpace(string(out))
	}
	if ctx.Err() != nil {
		fields["error"] = ctx.Err().Error()
		logJSON("error", "upgrade_failed", fields)
		return ctx.Err()
	}
	if err != nil {
		fields["error"] = err.Error()
		logJSON("error", "upgrade_failed", fields)
		return err
	}
	if !fileExists(upgraded) {
		err := errors.New("upgrade succeeded but upgraded file was not created")
		fields["error"] = err.Error()
		logJSON("error", "upgrade_failed", fields)
		return err
	}
	logJSON("info", "upgrade_completed", fields)
	return nil
}

func (e *Engine) swapUpgradeLocked(db string) error {
	dat := db + ".dat"
	old := db + ".dat.old"
	upgraded := db + ".upgraded.dat"
	if !fileExists(dat) {
		return fmt.Errorf("refusing upgrade swap without original %s", dat)
	}
	if !fileExists(upgraded) {
		return fmt.Errorf("refusing upgrade swap without upgraded %s", upgraded)
	}
	if fileExists(old) {
		archived := fmt.Sprintf("%s.%d", old, time.Now().UTC().UnixNano())
		logJSON("warn", "upgrade_old_backup_archiving", map[string]any{"from": old, "to": archived})
		if err := os.Rename(old, archived); err != nil {
			return fmt.Errorf("archive previous old database: %w", err)
		}
		if err := fsyncDir(filepath.Dir(db)); err != nil {
			return fmt.Errorf("fsync previous old archive: %w", err)
		}
	}
	logJSON("warn", "upgrade_swap_renaming_original", map[string]any{"from": dat, "to": old})
	if err := os.Rename(dat, old); err != nil {
		return fmt.Errorf("rename original database aside: %w", err)
	}
	if err := fsyncDir(filepath.Dir(db)); err != nil {
		return fmt.Errorf("fsync original rename: %w", err)
	}
	logJSON("warn", "upgrade_swap_installing_upgraded", map[string]any{"from": upgraded, "to": dat})
	if err := os.Rename(upgraded, dat); err != nil {
		return fmt.Errorf("install upgraded database: %w", err)
	}
	if err := fsyncDir(filepath.Dir(db)); err != nil {
		return fmt.Errorf("fsync upgraded install: %w", err)
	}
	logJSON("info", "upgrade_swap_completed", map[string]any{"database": db})
	return nil
}

func fileExists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

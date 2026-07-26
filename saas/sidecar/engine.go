package main

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

type waitMode int

const (
	waitStatus waitMode = iota
	waitRowsStatus
	waitSingleRow
)

type Engine struct {
	bin  string
	data string
	name string

	cmdMu   sync.Mutex
	stateMu sync.Mutex
	cmd     *exec.Cmd
	stdin   io.WriteCloser
	lines   chan string
	done    chan struct{}
	gen     uint64
	closed  bool
}

func NewEngine(bin, data, name string) (*Engine, error) {
	e := &Engine{bin: bin, data: data, name: name}
	e.cmdMu.Lock()
	defer e.cmdMu.Unlock()
	if err := e.startLocked(); err != nil {
		return nil, err
	}
	return e, nil
}

func (e *Engine) Command(ctx context.Context, line string, mode waitMode) ([]string, error) {
	before := e.generation()
	e.cmdMu.Lock()
	defer e.cmdMu.Unlock()
	if e.closed {
		return nil, errors.New("engine is closed")
	}
	if before != e.generation() {
		return nil, errors.New("engine restarted while request was queued")
	}
	if err := e.ensureStartedLocked(); err != nil {
		return nil, err
	}
	return e.runLocked(ctx, line, mode)
}

func (e *Engine) PagedCommand(ctx context.Context, limit, offset int, line string) ([]string, error) {
	before := e.generation()
	e.cmdMu.Lock()
	defer e.cmdMu.Unlock()
	if e.closed {
		return nil, errors.New("engine is closed")
	}
	if before != e.generation() {
		return nil, errors.New("engine restarted while request was queued")
	}
	if err := e.ensureStartedLocked(); err != nil {
		return nil, err
	}
	if _, err := e.runLocked(ctx, fmt.Sprintf("PAGE %d %d", limit, offset), waitStatus); err != nil {
		return nil, err
	}
	return e.runLocked(ctx, line, waitRowsStatus)
}

func (e *Engine) Exec(ctx context.Context, line string) ([]string, bool, error) {
	if err := validateExecCommand(line); err != nil {
		return nil, false, err
	}
	before := e.generation()
	e.cmdMu.Lock()
	defer e.cmdMu.Unlock()
	if e.closed {
		return nil, false, errors.New("engine is closed")
	}
	if before != e.generation() {
		return nil, false, errors.New("engine restarted while request was queued")
	}
	if err := e.ensureStartedLocked(); err != nil {
		return nil, false, err
	}
	if _, err := e.runLocked(ctx, "FORMAT TABLE", waitStatus); err != nil {
		return nil, false, err
	}
	lines, cmdErr := e.runLocked(ctx, line, waitStatus)
	if _, err := e.runLocked(context.Background(), "FORMAT TSV", waitStatus); err != nil {
		e.restartLocked("FORMAT TSV restore failed after exec")
		return nil, false, fmt.Errorf("FORMAT TSV restore failed: %w", err)
	}
	if cmdErr != nil {
		var ee EngineError
		if errors.As(cmdErr, &ee) {
			return lines, false, nil
		}
		return lines, false, cmdErr
	}
	return lines, true, nil
}

func (e *Engine) Close(ctx context.Context) {
	e.cmdMu.Lock()
	defer e.cmdMu.Unlock()
	e.closed = true
	e.stateMu.Lock()
	cmd, stdin, done := e.cmd, e.stdin, e.done
	e.stateMu.Unlock()
	if cmd == nil || stdin == nil || cmd.Process == nil {
		return
	}
	_ = writeFull(stdin, []byte("EXIT\n"))
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		_ = cmd.Process.Kill()
	case <-ctx.Done():
		_ = cmd.Process.Kill()
	}
}

func (e *Engine) generation() uint64 {
	e.stateMu.Lock()
	defer e.stateMu.Unlock()
	return e.gen
}

func (e *Engine) ensureStartedLocked() error {
	e.stateMu.Lock()
	ready := e.cmd != nil && e.stdin != nil && e.lines != nil && e.done != nil
	e.stateMu.Unlock()
	if ready {
		return nil
	}
	return e.startLocked()
}

func (e *Engine) startLocked() error {
	if err := os.MkdirAll(e.data, 0o700); err != nil {
		return err
	}
	db := filepath.Join(e.data, e.name)
	if err := e.recoverUpgradeSwapLocked(db); err != nil {
		return err
	}
	err := e.startEngineLocked(db)
	if !isIncompatibleFormatError(err) {
		return err
	}
	logJSON("warn", "upgrade_required", map[string]any{"database": db, "error": err.Error()})
	if err := e.runUpgradeLocked(db); err != nil {
		return fmt.Errorf("database upgrade failed: %w", err)
	}
	if err := e.swapUpgradeLocked(db); err != nil {
		return fmt.Errorf("database upgrade swap failed: %w", err)
	}
	return e.startEngineLocked(db)
}

func (e *Engine) startEngineLocked(db string) error {
	cmd := exec.Command(e.bin, db)
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return err
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return err
	}
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return err
	}
	if err := cmd.Start(); err != nil {
		return err
	}

	lines := make(chan string, 256)
	go readEngineLines(stdout, lines)
	go logEngineStderr(stderr)

	done := make(chan struct{})
	e.stateMu.Lock()
	e.cmd, e.stdin, e.lines, e.done = cmd, stdin, lines, done
	e.gen++
	e.stateMu.Unlock()

	go e.watch(cmd, done)

	deadline := time.After(5 * time.Second)
	for {
		select {
		case line, ok := <-lines:
			if !ok {
				e.clearFailedStartLocked(cmd)
				return errors.New("engine exited during startup")
			}
			if strings.Contains(line, "type HELP") {
				goto format
			}
			if isERR(line) {
				e.clearFailedStartLocked(cmd)
				return errors.New(statusDetail(line))
			}
		case <-deadline:
			e.clearFailedStartLocked(cmd)
			_ = cmd.Process.Kill()
			return errors.New("engine startup timed out")
		}
	}

format:
	if _, err := e.runLocked(context.Background(), "FORMAT TSV", waitStatus); err != nil {
		return fmt.Errorf("FORMAT TSV failed: %w", err)
	}
	logJSON("info", "engine_started", map[string]any{"database": db})
	return nil
}

func (e *Engine) clearFailedStartLocked(cmd *exec.Cmd) {
	e.stateMu.Lock()
	if e.cmd == cmd {
		e.cmd, e.stdin, e.lines, e.done = nil, nil, nil, nil
		e.gen++
	}
	e.stateMu.Unlock()
	if cmd != nil && cmd.Process != nil {
		_ = cmd.Process.Kill()
	}
}

func (e *Engine) restartLocked(reason string) {
	logJSON("warn", "engine_restarting", map[string]any{"reason": reason})
	e.stateMu.Lock()
	cmd := e.cmd
	e.cmd, e.stdin, e.lines, e.done = nil, nil, nil, nil
	e.gen++
	e.stateMu.Unlock()
	if cmd != nil && cmd.Process != nil {
		_ = cmd.Process.Kill()
	}
	if err := e.startLocked(); err != nil {
		logJSON("error", "engine_restart_failed", map[string]any{"error": err.Error()})
	}
}

func (e *Engine) runLocked(ctx context.Context, line string, mode waitMode) ([]string, error) {
	if err := validateLineLength(line); err != nil {
		return nil, err
	}
	e.stateMu.Lock()
	stdin, lines := e.stdin, e.lines
	e.stateMu.Unlock()
	if stdin == nil || lines == nil {
		return nil, errors.New("engine is not running")
	}
	if err := writeFull(stdin, []byte(line+"\n")); err != nil {
		e.restartLocked("stdin write failed")
		return nil, err
	}

	timer := time.NewTimer(30 * time.Second)
	defer timer.Stop()
	out := []string{}
	for {
		select {
		case raw, ok := <-lines:
			if !ok {
				e.restartLocked("stdout closed")
				return nil, errors.New("engine exited")
			}
			line := normalizeEngineLine(raw)
			if line == "" {
				continue
			}
			out = append(out, line)
			if isERR(line) {
				return out, EngineError{Detail: statusDetail(line)}
			}
			if isOK(line) {
				return out, nil
			}
			if mode == waitSingleRow && strings.HasPrefix(line, "R\t") {
				return out, nil
			}
		case <-timer.C:
			e.restartLocked("command timeout")
			return out, EngineError{Detail: "engine command timed out after 30s"}
		case <-ctx.Done():
			return out, ctx.Err()
		}
	}
}

func (e *Engine) watch(cmd *exec.Cmd, done chan struct{}) {
	err := cmd.Wait()
	e.stateMu.Lock()
	shouldRestart := !e.closed
	if e.cmd == cmd {
		e.cmd, e.stdin, e.lines, e.done = nil, nil, nil, nil
		e.gen++
	}
	e.stateMu.Unlock()
	close(done)
	if err != nil {
		logJSON("error", "engine_exited", map[string]any{"error": err.Error()})
	} else {
		logJSON("info", "engine_exited", nil)
	}
	if shouldRestart {
		time.Sleep(time.Second)
		e.cmdMu.Lock()
		defer e.cmdMu.Unlock()
		e.stateMu.Lock()
		needsStart := !e.closed && e.cmd == nil
		e.stateMu.Unlock()
		if needsStart {
			if err := e.startLocked(); err != nil {
				logJSON("error", "engine_restart_failed", map[string]any{"error": err.Error()})
			}
		}
	}
}

func readEngineLines(r io.Reader, out chan<- string) {
	defer close(out)
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 1024), 1024*1024)
	for sc.Scan() {
		out <- sc.Text()
	}
}

func logEngineStderr(r io.Reader) {
	sc := bufio.NewScanner(r)
	for sc.Scan() {
		text := strings.TrimSpace(sc.Text())
		if text != "" {
			logJSON("warn", "engine_stderr", map[string]any{"text": text})
		}
	}
}

func normalizeEngineLine(line string) string {
	line = strings.TrimRight(line, "\r\n")
	for strings.HasPrefix(line, "asmdb> ") {
		line = strings.TrimPrefix(line, "asmdb> ")
	}
	return line
}

func writeFull(w io.Writer, p []byte) error {
	for len(p) > 0 {
		n, err := w.Write(p)
		if err != nil {
			return err
		}
		p = p[n:]
		if n == 0 {
			return io.ErrShortWrite
		}
	}
	return nil
}

type EngineError struct {
	Detail string
}

func (e EngineError) Error() string {
	if e.Detail == "" {
		return "engine error"
	}
	return e.Detail
}

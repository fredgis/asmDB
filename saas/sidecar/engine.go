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
	"regexp"
	"strings"
	"sync"
	"time"
)

var (
	shortCommandTimeout     = 30 * time.Second
	longCommandTimeout      = 30 * time.Minute
	engineUnresponsiveGrace = 30 * time.Second
	promptDrainTimeout      = 500 * time.Millisecond
	restartInitialBackoff   = 200 * time.Millisecond
	restartMaxBackoff       = 5 * time.Second
	restartMaxAttempts      = 6
	restartSleep            = time.Sleep
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

	lastStartErr string
	failedStarts int
	info         engineInfo
}

type engineInfo struct {
	Version       string
	StorageFormat string
}

var unknownEngineInfo = engineInfo{Version: "unknown", StorageFormat: "unknown"}

var (
	versionLineRE = regexp.MustCompile(`(?i)\basmdb\s+([0-9]+(?:\.[0-9]+){1,3})\b`)
	storageLineRE = regexp.MustCompile(`(?i)storage\s+format\s*:\s*([0-9]+)`)
)

func NewEngine(bin, data, name string) (*Engine, error) {
	e := &Engine{bin: bin, data: data, name: name, info: unknownEngineInfo}
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
	return e.startWithBackoffLocked("engine not running")
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

func (e *Engine) startWithBackoffLocked(reason string) error {
	backoff := restartInitialBackoff
	var last error
	for attempt := 1; attempt <= restartMaxAttempts; attempt++ {
		if err := e.startLocked(); err != nil {
			last = err
			e.setStartUnhealthyLocked(err)
			logJSON("error", "engine_start_failed", map[string]any{
				"attempt": attempt,
				"max":     restartMaxAttempts,
				"reason":  reason,
				"error":   err.Error(),
			})
			if attempt == restartMaxAttempts {
				break
			}
			restartSleep(backoff)
			backoff *= 2
			if backoff > restartMaxBackoff {
				backoff = restartMaxBackoff
			}
			continue
		}
		e.setStartHealthyLocked()
		return nil
	}
	if last == nil {
		last = errors.New("engine failed to start")
	}
	return last
}

func (e *Engine) setStartHealthyLocked() {
	e.stateMu.Lock()
	e.lastStartErr = ""
	e.failedStarts = 0
	e.stateMu.Unlock()
}

func (e *Engine) setStartUnhealthyLocked(err error) {
	e.stateMu.Lock()
	e.failedStarts++
	if err != nil {
		e.lastStartErr = err.Error()
	}
	e.stateMu.Unlock()
}

func (e *Engine) healthError() string {
	e.stateMu.Lock()
	defer e.stateMu.Unlock()
	return e.lastStartErr
}

func (e *Engine) engineInfo() engineInfo {
	e.stateMu.Lock()
	defer e.stateMu.Unlock()
	if e.info.Version == "" {
		return unknownEngineInfo
	}
	return e.info
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
	bannerSeen := false
	for {
		select {
		case line, ok := <-lines:
			if !ok {
				e.clearFailedStartLocked(cmd)
				return errors.New("engine exited during startup")
			}
			if strings.Contains(line, "type HELP") {
				bannerSeen = true
			}
			if bannerSeen && hasEnginePrompt(line) {
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
	info := unknownEngineInfo
	if lines, err := e.runLocked(context.Background(), "VERSION", waitStatus); err != nil {
		logJSON("warn", "engine_version_unknown", map[string]any{"database": db, "error": err.Error()})
	} else {
		info = parseEngineInfo(lines)
		if info.Version == "unknown" || info.StorageFormat == "unknown" {
			logJSON("warn", "engine_version_unparsed", map[string]any{"database": db, "output": strings.Join(lines, "\n")})
		}
	}
	e.stateMu.Lock()
	e.info = info
	e.stateMu.Unlock()
	if _, err := e.runLocked(context.Background(), "FORMAT TSV", waitStatus); err != nil {
		return fmt.Errorf("FORMAT TSV failed: %w", err)
	}
	logJSON("info", "engine_started", map[string]any{"database": db})
	return nil
}

func parseEngineInfo(lines []string) engineInfo {
	version := ""
	storageFormat := ""
	for _, line := range lines {
		if m := versionLineRE.FindStringSubmatch(line); len(m) == 2 {
			version = m[1]
		}
		if m := storageLineRE.FindStringSubmatch(line); len(m) == 2 {
			storageFormat = m[1]
		}
	}
	if version == "" || storageFormat == "" {
		return unknownEngineInfo
	}
	return engineInfo{Version: version, StorageFormat: storageFormat}
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
	cmd, done := e.cmd, e.done
	e.cmd, e.stdin, e.lines, e.done = nil, nil, nil, nil
	e.gen++
	e.stateMu.Unlock()
	if cmd != nil && cmd.Process != nil {
		_ = cmd.Process.Kill()
		if done != nil {
			select {
			case <-done:
			case <-time.After(10 * time.Second):
				logJSON("error", "engine_exit_wait_timeout", map[string]any{"reason": reason})
			}
		}
	}
	if err := e.startWithBackoffLocked(reason); err != nil {
		logJSON("error", "engine_restart_failed", map[string]any{"error": err.Error()})
	}
}

func (e *Engine) runLocked(ctx context.Context, line string, mode waitMode) ([]string, error) {
	_ = mode
	if err := validateLineLength(line); err != nil {
		return nil, err
	}
	commandLine := line
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

	timer := time.NewTimer(commandTimeout(line))
	defer timer.Stop()
	budgetExpired := false
	out := []string{}
	for {
		select {
		case raw, ok := <-lines:
			if !ok {
				e.restartLocked("stdout closed")
				return nil, errors.New("engine exited")
			}
			promptSeen := hasEnginePrompt(raw)
			line := normalizeEngineLine(raw)
			if line != "" {
				out = append(out, line)
				if isERR(line) {
					if !promptSeen {
						e.drainPromptAfterStatus(lines, line)
					}
					return out, EngineError{Detail: statusDetail(line)}
				}
				if isOK(line) {
					if !promptSeen {
						e.drainPromptAfterStatus(lines, line)
					}
					return out, nil
				}
			}
			if promptSeen {
				// A prompt is a frame boundary: the engine is ready for the next command.
				// If it arrives before a status line, this response is still complete, but
				// the engine violated the status protocol. Returning here preserves the
				// invariant that later requests cannot consume this command's leftover output.
				logJSON("warn", "engine_response_without_status", map[string]any{"command": commandLine})
				return out, nil
			}
		case <-timer.C:
			if !budgetExpired {
				budgetExpired = true
				logJSON("warn", "engine_command_over_budget", map[string]any{
					"command": firstCommandToken(line),
					"budget":  commandTimeout(line).String(),
				})
				timer.Reset(engineUnresponsiveGrace)
				continue
			}
			// No status or prompt arrived. The stream position is unknown, so
			// restart before returning; otherwise the next request could consume
			// this command's late output and receive a mismatched response.
			e.restartLocked("engine unresponsive after command timeout")
			return out, EngineError{Detail: "engine command exceeded its timeout and then stopped responding"}
		case <-ctx.Done():
			return out, ctx.Err()
		}
	}
}

func (e *Engine) drainPromptAfterStatus(lines <-chan string, statusLine string) {
	timer := time.NewTimer(promptDrainTimeout)
	defer timer.Stop()
	for {
		select {
		case raw, ok := <-lines:
			if !ok {
				return
			}
			if hasEnginePrompt(raw) {
				return
			}
		case <-timer.C:
			logJSON("warn", "engine_prompt_missing_after_status", map[string]any{"status": statusLine})
			return
		}
	}
}

func commandTimeout(line string) time.Duration {
	switch firstCommandToken(line) {
	case "BENCH", "BACKUP", "RESTORE", "VERIFY", "TRUNCATE":
		return longCommandTimeout
	default:
		return shortCommandTimeout
	}
}

func firstCommandToken(line string) string {
	fields := strings.Fields(line)
	if len(fields) == 0 {
		return ""
	}
	return strings.ToUpper(fields[0])
}

func (e *Engine) watch(cmd *exec.Cmd, done chan struct{}) {
	err := cmd.Wait()
	e.stateMu.Lock()
	shouldRestart := !e.closed && e.cmd == cmd
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
		e.cmdMu.Lock()
		defer e.cmdMu.Unlock()
		e.stateMu.Lock()
		needsStart := !e.closed && e.cmd == nil
		e.stateMu.Unlock()
		if needsStart {
			if err := e.startWithBackoffLocked("engine exited"); err != nil {
				logJSON("error", "engine_restart_failed", map[string]any{"error": err.Error()})
			}
		}
	}
}

func readEngineLines(r io.Reader, out chan<- string) {
	defer close(out)
	br := bufio.NewReader(r)
	buf := make([]byte, 0, 256)
	for {
		b, err := br.ReadByte()
		if err != nil {
			if len(buf) > 0 {
				out <- string(buf)
			}
			return
		}
		buf = append(buf, b)
		if b == '\n' || strings.HasSuffix(string(buf), "asmdb> ") {
			out <- string(buf)
			buf = buf[:0]
		}
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
	line = strings.ReplaceAll(line, "asmdb> ", "")
	return line
}

func hasEnginePrompt(line string) bool {
	return strings.Contains(line, "asmdb> ")
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

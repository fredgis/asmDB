package main

import (
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

var countRE = regexp.MustCompile(`\[\s*OK\s*\]\s*(\d+)`)

type api struct {
	engine        *Engine
	token         string
	platformToken string
	started       time.Time
	statsMu       sync.Mutex
	statsCached   *statsResponse
	statsAt       time.Time
}

type rowInput struct {
	ID      string `json:"id"`
	Value   string `json:"value"`
	Tag     string `json:"tag"`
	Content string `json:"content"`
}

type rowPatch struct {
	Value   string `json:"value"`
	Tag     string `json:"tag"`
	Content string `json:"content"`
}

type execInput struct {
	Command string `json:"command"`
}

const maxExecRequestBodyBytes = 4096

type prepareUpgradeResponse struct {
	OK     bool               `json:"ok"`
	Backup *prepareBackupInfo `json:"backup,omitempty"`
	Error  string             `json:"error,omitempty"`
	Detail string             `json:"detail,omitempty"`
	Output []string           `json:"output,omitempty"`
}

type prepareBackupInfo struct {
	Path           string `json:"path"`
	ApparentBytes  string `json:"apparentBytes"`
	AllocatedBytes string `json:"allocatedBytes,omitempty"`
}

type page struct {
	limit  int
	offset int
}

type apiError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
	Detail  string `json:"detail,omitempty"`
}

func (a *api) routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", a.handleHealth)
	mux.Handle("GET /v1/stats", a.introspectionAuth(http.HandlerFunc(a.handleStats)))
	mux.Handle("GET /v1/rows", a.auth(http.HandlerFunc(a.handleList)))
	mux.Handle("GET /v1/rows/{id}", a.auth(http.HandlerFunc(a.handleGet)))
	mux.Handle("POST /v1/rows", a.auth(http.HandlerFunc(a.handleInsert)))
	mux.Handle("PUT /v1/rows/{id}", a.auth(http.HandlerFunc(a.handleUpdate)))
	mux.Handle("DELETE /v1/rows/{id}", a.auth(http.HandlerFunc(a.handleDelete)))
	mux.Handle("GET /v1/count", a.auth(http.HandlerFunc(a.handleCount)))
	mux.Handle("GET /v1/find", a.auth(http.HandlerFunc(a.handleFind)))
	mux.Handle("GET /v1/range", a.auth(http.HandlerFunc(a.handleRange)))
	mux.Handle("POST /v1/verify", a.auth(http.HandlerFunc(a.handleVerify)))
	mux.Handle("POST /v1/exec", a.auth(http.HandlerFunc(a.handleExec)))
	mux.Handle("POST /v1/prepare-upgrade", a.prepareUpgradeAuth(http.HandlerFunc(a.handlePrepareUpgrade)))
	mux.Handle("POST /mcp", a.auth(http.HandlerFunc(a.handleMCP)))
	return loggingMiddleware(mux)
}

func (a *api) auth(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !tokenEqual(bearerToken(r), a.token) {
			writeError(w, http.StatusUnauthorized, "unauthorized", "missing or invalid bearer token", "")
			return
		}
		next.ServeHTTP(w, r)
	})
}

func (a *api) introspectionAuth(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got := bearerToken(r)
		if !tokenEqual(got, a.token) && !tokenEqual(got, a.platformToken) {
			writeError(w, http.StatusUnauthorized, "unauthorized", "missing or invalid bearer token", "")
			return
		}
		next.ServeHTTP(w, r)
	})
}

func (a *api) prepareUpgradeAuth(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got := bearerToken(r)
		if !tokenEqual(got, a.token) && !tokenEqual(got, a.platformToken) {
			writeError(w, http.StatusUnauthorized, "unauthorized", "missing or invalid bearer token", "")
			return
		}
		next.ServeHTTP(w, r)
	})
}

func bearerToken(r *http.Request) string {
	const prefix = "Bearer "
	auth := r.Header.Get("Authorization")
	if strings.HasPrefix(auth, prefix) {
		return strings.TrimPrefix(auth, prefix)
	}
	return ""
}

func tokenEqual(got, want string) bool {
	return want != "" && subtle.ConstantTimeCompare([]byte(got), []byte(want)) == 1
}

func (a *api) handleHealth(w http.ResponseWriter, r *http.Request) {
	count, err := a.count(r)
	if err != nil {
		detail := err.Error()
		if a.engine != nil {
			if healthErr := a.engine.healthError(); healthErr != "" {
				detail = healthErr
			}
		}
		writeError(w, http.StatusServiceUnavailable, "engine_unhealthy", "engine is not healthy", detail)
		return
	}
	info := a.engine.engineInfo()
	writeJSON(w, http.StatusOK, map[string]any{"status": "ok", "engine": info.Version, "storageFormat": info.StorageFormat, "rows": count})
}

func (a *api) handleStats(w http.ResponseWriter, r *http.Request) {
	stats, err := a.stats(r)
	if err != nil {
		writeMappedError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, stats)
}

func (a *api) handleList(w http.ResponseWriter, r *http.Request) {
	p, ok := parsePage(w, r)
	if !ok {
		return
	}
	lines, err := a.engine.PagedCommand(r.Context(), p.limit, p.offset, "SELECT *")
	a.writeRowsPage(w, lines, err, p)
}

func (a *api) handleFind(w http.ResponseWriter, r *http.Request) {
	p, ok := parsePage(w, r)
	if !ok {
		return
	}
	q := r.URL.Query().Get("q")
	if strings.ContainsAny(q, "\r\n\x00") || q == "" {
		writeError(w, http.StatusBadRequest, "invalid_request", "q must be a non-empty single-line string", "")
		return
	}
	line := "FIND " + q
	if err := validateLineLength(line); err != nil {
		writeMappedError(w, err)
		return
	}
	lines, err := a.engine.PagedCommand(r.Context(), p.limit, p.offset, line)
	a.writeRowsPage(w, lines, err, p)
}

func (a *api) handleRange(w http.ResponseWriter, r *http.Request) {
	p, ok := parsePage(w, r)
	if !ok {
		return
	}
	lo, err := validateValue(r.URL.Query().Get("lo"))
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request", "lo must be an i64 decimal string", "")
		return
	}
	hi, err := validateValue(r.URL.Query().Get("hi"))
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request", "hi must be an i64 decimal string", "")
		return
	}
	lines, err := a.engine.PagedCommand(r.Context(), p.limit, p.offset, "RANGE "+lo+" "+hi)
	a.writeRowsPage(w, lines, err, p)
}

func (a *api) handleGet(w http.ResponseWriter, r *http.Request) {
	row, found, err := a.getRawRow(r, r.PathValue("id"))
	if err != nil {
		writeMappedError(w, err)
		return
	}
	if !found {
		writeError(w, http.StatusNotFound, "not_found", "row not found", "")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"row": row})
}

func (a *api) handleInsert(w http.ResponseWriter, r *http.Request) {
	var in rowInput
	if !decodeJSON(w, r, &in) {
		return
	}
	id, value, tag, content, ok := validateRowInput(w, in.ID, in.Value, in.Tag, in.Content)
	if !ok {
		return
	}
	line := fmt.Sprintf("INSERT %s %s %s %s", id, value, tag, content)
	if err := validateLineLength(line); err != nil {
		writeMappedError(w, err)
		return
	}
	if _, err := a.engine.Command(r.Context(), line, waitStatus); err != nil {
		writeMappedError(w, err)
		return
	}
	row, found, err := a.getRawRow(r, id)
	if err != nil {
		writeMappedError(w, err)
		return
	}
	if !found {
		writeError(w, http.StatusBadGateway, "engine_error", "inserted row could not be read back", "")
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"row": row})
}

func (a *api) handleUpdate(w http.ResponseWriter, r *http.Request) {
	var in rowPatch
	if !decodeJSON(w, r, &in) {
		return
	}
	id, err := validateID(r.PathValue("id"))
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request", err.Error(), "")
		return
	}
	_, value, tag, content, ok := validateRowInput(w, id, in.Value, in.Tag, in.Content)
	if !ok {
		return
	}
	line := fmt.Sprintf("UPDATE %s %s %s %s", id, value, tag, content)
	if err := validateLineLength(line); err != nil {
		writeMappedError(w, err)
		return
	}
	if _, err := a.engine.Command(r.Context(), line, waitStatus); err != nil {
		writeMappedError(w, err)
		return
	}
	row, found, err := a.getRawRow(r, id)
	if err != nil {
		writeMappedError(w, err)
		return
	}
	if !found {
		writeError(w, http.StatusBadGateway, "engine_error", "updated row could not be read back", "")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"row": row})
}

func (a *api) handleDelete(w http.ResponseWriter, r *http.Request) {
	id, err := validateID(r.PathValue("id"))
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request", err.Error(), "")
		return
	}
	if _, err := a.engine.Command(r.Context(), "DELETE "+id, waitStatus); err != nil {
		writeMappedError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (a *api) handleCount(w http.ResponseWriter, r *http.Request) {
	count, err := a.count(r)
	if err != nil {
		writeMappedError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"count": count})
}

func (a *api) handleVerify(w http.ResponseWriter, r *http.Request) {
	lines, err := a.engine.Command(r.Context(), "VERIFY", waitStatus)
	detail := strings.Join(lines, "\n")
	if err != nil {
		var ee EngineError
		if errors.As(err, &ee) {
			writeJSON(w, http.StatusOK, map[string]any{"ok": false, "detail": detail})
			return
		}
		writeMappedError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "detail": detail})
}

func (a *api) handleExec(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, maxExecRequestBodyBytes)
	var in execInput
	if !decodeJSON(w, r, &in) {
		return
	}
	lines, ok, err := a.engine.Exec(r.Context(), in.Command)
	if err != nil {
		writeMappedError(w, err)
		return
	}
	// PAGE is session state in the engine. Paged REST handlers set PAGE before
	// each listing, so a terminal PAGE command cannot leak into the data API.
	writeJSON(w, http.StatusOK, map[string]any{"output": lines, "ok": ok})
}

func (a *api) handlePrepareUpgrade(w http.ResponseWriter, r *http.Request) {
	defer r.Body.Close()
	dest := a.preUpgradeBackupPath(time.Now().UTC())
	// This route must never become a generic command runner or accept a caller
	// supplied path. It is safe for the platform token only because the caller
	// can express exactly one operation: BACKUP to a sidecar-chosen durable file.
	lines, err := a.engine.Command(r.Context(), "BACKUP "+dest, waitStatus)
	if err != nil {
		var ee EngineError
		if errors.As(err, &ee) {
			writeJSON(w, http.StatusOK, prepareUpgradeResponse{OK: false, Error: "backup_failed", Detail: ee.Detail, Output: lines})
			return
		}
		writeMappedError(w, err)
		return
	}
	info, err := backupInfo(dest)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "backup_missing", "backup completed but output file could not be statted", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, prepareUpgradeResponse{OK: true, Backup: info, Output: lines})
}

func (a *api) preUpgradeBackupPath(now time.Time) string {
	name := fmt.Sprintf("%s.pre-upgrade.%s.bak", a.engine.name, now.Format("20060102T150405.000000000Z"))
	return filepath.Join(a.engine.data, name)
}

func backupInfo(path string) (*prepareBackupInfo, error) {
	if _, err := os.Stat(path); err != nil {
		return nil, err
	}
	usage := collectFileUsage(path)
	return &prepareBackupInfo{
		Path:           path,
		ApparentBytes:  usage.apparentDecimal(),
		AllocatedBytes: usage.allocatedDecimal(),
	}, nil
}

func (a *api) writeRowsPage(w http.ResponseWriter, lines []string, err error, p page) {
	if err != nil {
		writeMappedError(w, err)
		return
	}
	rows, err := parseTSVRows(lines)
	if err != nil {
		writeError(w, http.StatusBadGateway, "engine_error", "failed to parse engine TSV", err.Error())
		return
	}
	hasMore := len(rows) == p.limit
	next := p.offset + len(rows)
	if hasMore {
		next = p.offset + p.limit
	}
	writeJSON(w, http.StatusOK, map[string]any{"rows": rows, "count": len(rows), "hasMore": hasMore, "nextOffset": next})
}

func (a *api) getRawRow(r *http.Request, idText string) (Row, bool, error) {
	id, err := validateID(idText)
	if err != nil {
		return Row{}, false, codedError{code: "invalid_request", msg: err.Error()}
	}
	lines, err := a.engine.Command(r.Context(), "SELECT "+id, waitSingleRow)
	if err != nil {
		var ee EngineError
		if errors.As(err, &ee) && strings.Contains(strings.ToLower(ee.Detail), "not found") {
			return Row{}, false, nil
		}
		return Row{}, false, err
	}
	rows, err := parseTSVRows(lines)
	if err != nil {
		return Row{}, false, err
	}
	if len(rows) == 0 {
		return Row{}, false, nil
	}
	return rows[0], true, nil
}

func (a *api) count(r *http.Request) (uint64, error) {
	lines, err := a.engine.Command(r.Context(), "COUNT", waitStatus)
	if err != nil {
		return 0, err
	}
	return parseCountLines(lines)
}

func parseCountLines(lines []string) (uint64, error) {
	for _, line := range lines {
		m := countRE.FindStringSubmatch(line)
		if len(m) == 2 {
			return strconv.ParseUint(m[1], 10, 64)
		}
	}
	return 0, errors.New("could not parse COUNT response")
}

func validateRowInput(w http.ResponseWriter, idText, valueText, tag, content string) (string, string, string, string, bool) {
	id, err := validateID(idText)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request", err.Error(), "")
		return "", "", "", "", false
	}
	value, err := validateValue(valueText)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request", err.Error(), "")
		return "", "", "", "", false
	}
	if err := validateTag(tag); err != nil {
		writeMappedError(w, err)
		return "", "", "", "", false
	}
	if err := validateContent(content); err != nil {
		writeMappedError(w, err)
		return "", "", "", "", false
	}
	return id, value, tag, content, true
}

func parsePage(w http.ResponseWriter, r *http.Request) (page, bool) {
	limit := 100
	offset := 0
	if raw := r.URL.Query().Get("limit"); raw != "" {
		n, err := strconv.Atoi(raw)
		if err != nil || n < 1 || n > 1000 {
			writeError(w, http.StatusBadRequest, "invalid_request", "limit must be an integer from 1 through 1000", "")
			return page{}, false
		}
		limit = n
	}
	if raw := r.URL.Query().Get("offset"); raw != "" {
		n, err := strconv.Atoi(raw)
		if err != nil || n < 0 {
			writeError(w, http.StatusBadRequest, "invalid_request", "offset must be a non-negative integer", "")
			return page{}, false
		}
		offset = n
	}
	return page{limit: limit, offset: offset}, true
}

func decodeJSON(w http.ResponseWriter, r *http.Request, v any) bool {
	defer r.Body.Close()
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	if err := dec.Decode(v); err != nil {
		var mbe *http.MaxBytesError
		if errors.As(err, &mbe) {
			writeError(w, http.StatusRequestEntityTooLarge, "request_too_large", fmt.Sprintf("request body must not exceed %d bytes", mbe.Limit), "")
			return false
		}
		writeError(w, http.StatusBadRequest, "invalid_request", "invalid JSON body", err.Error())
		return false
	}
	return true
}

func writeMappedError(w http.ResponseWriter, err error) {
	if err == nil {
		return
	}
	var ce codedError
	if errors.As(err, &ce) {
		status := http.StatusBadRequest
		if ce.code == "field_too_long" {
			status = http.StatusBadRequest
		}
		writeError(w, status, ce.code, ce.msg, "")
		return
	}
	var ee EngineError
	if errors.As(err, &ee) {
		msg := ee.Detail
		lower := strings.ToLower(msg)
		switch {
		case strings.Contains(lower, "not found"):
			writeError(w, http.StatusNotFound, "not_found", "row not found", msg)
		case strings.Contains(lower, "already exists"):
			writeError(w, http.StatusConflict, "already_exists", "row already exists", msg)
		case strings.Contains(lower, "too long"):
			writeError(w, http.StatusBadRequest, "field_too_long", "field too long", msg)
		default:
			writeError(w, http.StatusBadGateway, "engine_error", "engine command failed", msg)
		}
		return
	}
	writeError(w, http.StatusInternalServerError, "internal", "internal error", err.Error())
}

func writeError(w http.ResponseWriter, status int, code, message, detail string) {
	writeJSON(w, status, map[string]any{"error": apiError{Code: code, Message: message, Detail: detail}})
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func loggingMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		next.ServeHTTP(w, r)
		logJSON("info", "http_request", map[string]any{"method": r.Method, "path": r.URL.Path})
	})
}

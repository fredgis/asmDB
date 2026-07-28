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
)

const (
	defaultLimit = 100
	maxLimit     = 1000
)

var instanceRE = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`)

type api struct {
	shareRoot string
	token     string
}

type apiError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
	Detail  string `json:"detail,omitempty"`
}

func (a *api) routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", a.handleHealth)
	mux.Handle("GET /cdc/{instanceId}", a.auth(http.HandlerFunc(a.handleCDC)))
	mux.Handle("GET /cdc/{instanceId}/head", a.auth(http.HandlerFunc(a.handleHead)))
	mux.Handle("GET /snapshot/{instanceId}", a.auth(http.HandlerFunc(a.handleSnapshot)))
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

func (a *api) handleHealth(w http.ResponseWriter, r *http.Request) {
	if _, err := os.Stat(a.shareRoot); err != nil {
		writeError(w, http.StatusServiceUnavailable, "share_unreadable", "share root is unreadable", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"status": "ok"})
}

func (a *api) handleHead(w http.ResponseWriter, r *http.Request) {
	instanceDir, cdcPath, err := a.resolveInstance(r.PathValue("instanceId"))
	if err != nil {
		writeResolveError(w, err)
		return
	}
	log, err := readCDC(cdcPath)
	if err != nil {
		writeReadError(w, err)
		return
	}
	rows, err := readRows(instanceDir, strings.TrimSuffix(filepath.Base(cdcPath), ".cdc"))
	if err != nil {
		writeError(w, http.StatusServiceUnavailable, "share_unreadable", "instance data is unreadable", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"baseSeq": strconv.FormatUint(log.BaseSeq, 10),
		"lastSeq": strconv.FormatUint(log.LastSeq, 10),
		"rows":    strconv.FormatUint(rows, 10),
	})
}

func (a *api) handleCDC(w http.ResponseWriter, r *http.Request) {
	from, ok := parseFrom(w, r)
	if !ok {
		return
	}
	limit, ok := parseLimit(w, r)
	if !ok {
		return
	}
	_, cdcPath, err := a.resolveInstance(r.PathValue("instanceId"))
	if err != nil {
		writeResolveError(w, err)
		return
	}
	log, err := readCDC(cdcPath)
	if err != nil {
		writeReadError(w, err)
		return
	}
	if from < log.BaseSeq {
		writeJSON(w, http.StatusConflict, map[string]any{"error": map[string]string{
			"code":          "cdc_gap",
			"message":       "requested sequence is older than the log's base",
			"baseSeq":       strconv.FormatUint(log.BaseSeq, 10),
			"requestedFrom": strconv.FormatUint(from, 10),
		}})
		return
	}

	frames := visibleFrames(log.Frames, from, limit)
	w.Header().Set("Content-Type", "application/x-ndjson")
	w.Header().Set("X-Asmdb-Base-Seq", strconv.FormatUint(log.BaseSeq, 10))
	w.Header().Set("X-Asmdb-Last-Seq", strconv.FormatUint(log.LastSeq, 10))
	w.Header().Set("X-Asmdb-Has-More", strconv.FormatBool(hasMore(log.Frames, from, limit)))
	w.WriteHeader(http.StatusOK)
	enc := json.NewEncoder(w)
	for _, frame := range frames {
		_ = enc.Encode(frame)
	}
}

func (a *api) handleSnapshot(w http.ResponseWriter, r *http.Request) {
	after, ok := parseAfter(w, r)
	if !ok {
		return
	}
	limit, ok := parseLimit(w, r)
	if !ok {
		return
	}
	instanceDir, cdcPath, err := a.resolveInstance(r.PathValue("instanceId"))
	if err != nil {
		writeResolveError(w, err)
		return
	}
	baseName := strings.TrimSuffix(filepath.Base(cdcPath), ".cdc")
	page, err := readSnapshotPage(filepath.Join(instanceDir, baseName+".dat"), after, limit)
	if err != nil {
		writeSnapshotError(w, err)
		return
	}

	w.Header().Set("Content-Type", "application/x-ndjson")
	w.Header().Set("X-Asmdb-Snapshot-Seq", strconv.FormatUint(page.Seq, 10))
	w.Header().Set("X-Asmdb-Live-Rows", strconv.FormatUint(page.LiveRows, 10))
	w.Header().Set("X-Asmdb-Rows", strconv.Itoa(len(page.Rows)))
	w.Header().Set("X-Asmdb-Has-More", strconv.FormatBool(page.HasMore))
	w.Header().Set("X-Asmdb-Next-After", strconv.FormatUint(page.NextAfter, 10))
	w.WriteHeader(http.StatusOK)
	enc := json.NewEncoder(w)
	for _, row := range page.Rows {
		_ = enc.Encode(row)
	}
}

func parseFrom(w http.ResponseWriter, r *http.Request) (uint64, bool) {
	raw := r.URL.Query().Get("from")
	if raw == "" {
		writeError(w, http.StatusBadRequest, "invalid_request", "from is required", "")
		return 0, false
	}
	n, err := strconv.ParseUint(raw, 10, 64)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request", "from must be a non-negative decimal integer", "")
		return 0, false
	}
	return n, true
}

func parseAfter(w http.ResponseWriter, r *http.Request) (uint64, bool) {
	raw := r.URL.Query().Get("after")
	if raw == "" {
		return 0, true
	}
	n, err := strconv.ParseUint(raw, 10, 64)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request", "after must be a non-negative decimal integer", "")
		return 0, false
	}
	return n, true
}

func parseLimit(w http.ResponseWriter, r *http.Request) (int, bool) {
	raw := r.URL.Query().Get("limit")
	if raw == "" {
		return defaultLimit, true
	}
	n, err := strconv.Atoi(raw)
	if err != nil || n < 1 {
		writeError(w, http.StatusBadRequest, "invalid_request", "limit must be a positive integer", "")
		return 0, false
	}
	if n > maxLimit {
		return maxLimit, true
	}
	return n, true
}

func visibleFrames(frames []cdcFrame, from uint64, limit int) []frameJSON {
	out := make([]frameJSON, 0, min(limit, len(frames)))
	for _, frame := range frames {
		if frame.CommitSeq <= from {
			continue
		}
		out = append(out, frame.toJSON())
		if len(out) == limit {
			return out
		}
	}
	return out
}

func hasMore(frames []cdcFrame, from uint64, limit int) bool {
	seen := 0
	for _, frame := range frames {
		if frame.CommitSeq <= from {
			continue
		}
		seen++
		if seen > limit {
			return true
		}
	}
	return false
}

func (a *api) resolveInstance(instanceID string) (string, string, error) {
	if !instanceRE.MatchString(instanceID) || instanceID == "." || instanceID == ".." {
		return "", "", codedError{code: "invalid_request", msg: "invalid instance id"}
	}
	root, err := os.Stat(a.shareRoot)
	if err != nil {
		return "", "", err
	}
	if !root.IsDir() {
		return "", "", fmt.Errorf("share root is not a directory")
	}
	instanceDir := filepath.Join(a.shareRoot, instanceID)
	st, err := os.Stat(instanceDir)
	if err != nil {
		if os.IsNotExist(err) {
			return "", "", codedError{code: "not_found", msg: "unknown instance"}
		}
		return "", "", err
	}
	if !st.IsDir() {
		return "", "", codedError{code: "not_found", msg: "unknown instance"}
	}
	matches, err := filepath.Glob(filepath.Join(instanceDir, "*.cdc"))
	if err != nil {
		return "", "", err
	}
	if len(matches) == 0 {
		return "", "", codedError{code: "not_found", msg: "unknown instance"}
	}
	if len(matches) > 1 {
		return "", "", fmt.Errorf("instance %s has multiple .cdc files", instanceID)
	}
	return instanceDir, matches[0], nil
}

func readRows(instanceDir, baseName string) (uint64, error) {
	data, err := os.ReadFile(filepath.Join(instanceDir, baseName+".dat"))
	if err != nil {
		if os.IsNotExist(err) {
			return 0, nil
		}
		return 0, err
	}
	if len(data) < 32 || string(data[:5]) != "ASMDB" {
		return 0, errors.New("invalid .dat header")
	}
	return le64(data[24:32]), nil
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

type codedError struct {
	code string
	msg  string

	detail       string
	baseSeq      uint64
	lastSeq      uint64
	commitSeq    uint64
	hasBaseSeq   bool
	hasLastSeq   bool
	hasCommitSeq bool
}

func (e codedError) Error() string { return e.msg }

func writeResolveError(w http.ResponseWriter, err error) {
	var ce codedError
	if errors.As(err, &ce) {
		if ce.code == "not_found" {
			writeError(w, http.StatusNotFound, "not_found", "unknown instance", "")
			return
		}
		writeError(w, http.StatusBadRequest, ce.code, ce.msg, "")
		return
	}
	writeError(w, http.StatusServiceUnavailable, "share_unreadable", "share is unreadable", err.Error())
}

func writeReadError(w http.ResponseWriter, err error) {
	var ce codedError
	if errors.As(err, &ce) && ce.code == "cdc_corrupt" {
		body := map[string]string{
			"code":    "cdc_corrupt",
			"message": "CDC log is corrupt; reseed from the current table state",
		}
		if ce.detail != "" {
			body["detail"] = ce.detail
		}
		if ce.hasBaseSeq {
			body["baseSeq"] = strconv.FormatUint(ce.baseSeq, 10)
		}
		if ce.hasLastSeq {
			body["lastSeq"] = strconv.FormatUint(ce.lastSeq, 10)
		}
		if ce.hasCommitSeq {
			body["commitSeq"] = strconv.FormatUint(ce.commitSeq, 10)
		}
		writeJSON(w, http.StatusConflict, map[string]any{"error": body})
		return
	}
	writeError(w, http.StatusServiceUnavailable, "share_unreadable", "CDC log is unreadable", err.Error())
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

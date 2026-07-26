package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net/http"
	"strconv"
	"strings"
)

const (
	keyPrefix = "\\asmdb-key:"
	keyDelim  = ";"
)

type rpcRequest struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      any             `json:"id"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params"`
}

type rpcResponse struct {
	JSONRPC string    `json:"jsonrpc"`
	ID      any       `json:"id,omitempty"`
	Result  any       `json:"result,omitempty"`
	Error   *rpcError `json:"error,omitempty"`
}

type rpcError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

func (a *api) handleMCP(w http.ResponseWriter, r *http.Request) {
	defer r.Body.Close()
	var req rpcRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusOK, rpcResponse{JSONRPC: "2.0", Error: &rpcError{Code: -32700, Message: "parse error"}})
		return
	}
	resp := rpcResponse{JSONRPC: "2.0", ID: req.ID}
	switch req.Method {
	case "initialize":
		info := a.engine.engineInfo()
		resp.Result = map[string]any{
			"protocolVersion": "2024-11-05",
			"capabilities":    map[string]any{"tools": map[string]any{}},
			"serverInfo":      map[string]any{"name": "asmdb", "version": info.Version + "-sidecar", "storageFormat": info.StorageFormat},
		}
	case "tools/list":
		resp.Result = map[string]any{"tools": mcpTools()}
	case "tools/call":
		result, err := a.mcpCallTool(r.Context(), req.Params)
		if err != nil {
			resp.Error = &rpcError{Code: -32602, Message: err.Error()}
		} else {
			resp.Result = result
		}
	default:
		resp.Error = &rpcError{Code: -32601, Message: "method not found"}
	}
	writeJSON(w, http.StatusOK, resp)
}

func mcpTools() []map[string]any {
	idKey := map[string]any{
		"id":  map[string]any{"anyOf": []any{map[string]any{"type": "string"}, map[string]any{"type": "number"}}, "description": "primary key as a u64 decimal string"},
		"key": map[string]any{"type": "string", "description": "string key hashed to the id with FNV-1a and verified on read"},
	}
	page := map[string]any{
		"limit":  map[string]any{"type": "integer", "minimum": 1, "maximum": 1000, "description": "maximum rows to return"},
		"offset": map[string]any{"type": "integer", "minimum": 0, "description": "zero-based row offset"},
	}
	rowProps := map[string]any{
		"content": map[string]any{"type": "string"},
		"tag":     map[string]any{"type": "string"},
		"value":   map[string]any{"anyOf": []any{map[string]any{"type": "string"}, map[string]any{"type": "number"}}},
	}
	for k, v := range idKey {
		rowProps[k] = v
	}
	insertProps := copyMap(rowProps)
	insertProps["upsert"] = map[string]any{"type": "boolean"}
	return []map[string]any{
		{"name": "db_insert", "description": "Insert a row addressed by u64 id or string key.", "inputSchema": schema(insertProps)},
		{"name": "db_get", "description": "Fetch a single row by id or key.", "inputSchema": schema(idKey)},
		{"name": "db_update", "description": "Overwrite an existing row addressed by id or key.", "inputSchema": schema(rowProps)},
		{"name": "db_delete", "description": "Remove a row addressed by id or key.", "inputSchema": schema(idKey)},
		{"name": "db_find", "description": "Case-insensitive substring search over tag and content.", "inputSchema": schema(mergeMaps(map[string]any{"query": map[string]any{"type": "string"}}, page))},
		{"name": "db_list", "description": "Return live rows with pagination.", "inputSchema": schema(page)},
		{"name": "db_count", "description": "Return the number of live rows.", "inputSchema": schema(map[string]any{})},
	}
}

func schema(props map[string]any) map[string]any {
	return map[string]any{"type": "object", "properties": props, "additionalProperties": false}
}

func copyMap(in map[string]any) map[string]any {
	out := make(map[string]any, len(in))
	for k, v := range in {
		out[k] = v
	}
	return out
}

func mergeMaps(a, b map[string]any) map[string]any {
	out := copyMap(a)
	for k, v := range b {
		out[k] = v
	}
	return out
}

func (a *api) mcpCallTool(ctx context.Context, raw json.RawMessage) (any, error) {
	var call struct {
		Name      string          `json:"name"`
		Arguments json.RawMessage `json:"arguments"`
	}
	if err := json.Unmarshal(raw, &call); err != nil {
		return nil, err
	}
	args, err := decodeArgs(call.Arguments)
	if err != nil {
		return nil, err
	}
	switch call.Name {
	case "db_insert":
		return a.mcpInsert(ctx, args)
	case "db_get":
		return a.mcpGet(ctx, args)
	case "db_update":
		return a.mcpUpdate(ctx, args)
	case "db_delete":
		return a.mcpDelete(ctx, args)
	case "db_find":
		return a.mcpFind(ctx, args)
	case "db_list":
		return a.mcpList(ctx, args)
	case "db_count":
		count, err := a.countFromContext(ctx)
		if err != nil {
			return toolFail(mapMCPError(err), err.Error()), nil
		}
		return toolOK(map[string]any{"ok": true, "count": count}), nil
	default:
		return nil, fmt.Errorf("unknown tool %q", call.Name)
	}
}

func (a *api) mcpInsert(ctx context.Context, args map[string]any) (any, error) {
	id, key, err := resolveMCPID(args)
	if err != nil {
		return toolFail("invalidArgument", err.Error()), nil
	}
	tag, content, value, err := mcpRowFields(args, key)
	if err != nil {
		return toolFail(mapMCPError(err), err.Error()), nil
	}
	line := fmt.Sprintf("INSERT %s %s %s %s", id, value, tag, content)
	if err := validateLineLength(line); err != nil {
		return toolFail(mapMCPError(err), err.Error()), nil
	}
	_, err = a.engine.Command(ctx, line, waitStatus)
	if err != nil && getBool(args, "upsert") && strings.Contains(strings.ToLower(err.Error()), "already exists") {
		if key != "" {
			row, found, gerr := a.getRowByID(ctx, id)
			if gerr != nil {
				return toolFail(mapMCPError(gerr), gerr.Error()), nil
			}
			if !found {
				return toolFail("notFound", "key not found"), nil
			}
			if _, ok := verifyKey(row, key); !ok {
				return toolFail("keyCollision", "stored key metadata does not match the requested key"), nil
			}
		}
		if _, err = a.engine.Command(ctx, fmt.Sprintf("UPDATE %s %s %s %s", id, value, tag, content), waitStatus); err == nil {
			return toolOK(map[string]any{"ok": true, "action": "updated", "id": id, "tag": tag, "value": value}), nil
		}
	}
	if err != nil {
		return toolFail(mapMCPError(err), err.Error()), nil
	}
	return toolOK(map[string]any{"ok": true, "action": "inserted", "id": id, "tag": tag, "value": value}), nil
}

func (a *api) mcpGet(ctx context.Context, args map[string]any) (any, error) {
	id, key, err := resolveMCPID(args)
	if err != nil {
		return toolFail("invalidArgument", err.Error()), nil
	}
	row, found, err := a.getRowByID(ctx, id)
	if err != nil {
		if strings.Contains(strings.ToLower(err.Error()), "not found") {
			return toolOK(map[string]any{"ok": true, "found": false, "id": id, "record": nil}), nil
		}
		return toolFail(mapMCPError(err), err.Error()), nil
	}
	if !found {
		return toolOK(map[string]any{"ok": true, "found": false, "id": id, "record": nil}), nil
	}
	presented, ok := verifyKey(row, key)
	if !ok {
		return toolFail("keyCollision", "stored key metadata does not match the requested key"), nil
	}
	out := rowToMap(presented)
	out["ok"] = true
	out["found"] = true
	out["record"] = presented
	return toolOK(out), nil
}

func (a *api) mcpUpdate(ctx context.Context, args map[string]any) (any, error) {
	id, key, err := resolveMCPID(args)
	if err != nil {
		return toolFail("invalidArgument", err.Error()), nil
	}
	tag, content, value, err := mcpRowFields(args, key)
	if err != nil {
		return toolFail(mapMCPError(err), err.Error()), nil
	}
	if key != "" {
		row, found, gerr := a.getRowByID(ctx, id)
		if gerr != nil {
			return toolFail(mapMCPError(gerr), gerr.Error()), nil
		}
		if !found {
			return toolFail("notFound", "key not found"), nil
		}
		if _, ok := verifyKey(row, key); !ok {
			return toolFail("keyCollision", "stored key metadata does not match the requested key"), nil
		}
	}
	line := fmt.Sprintf("UPDATE %s %s %s %s", id, value, tag, content)
	if err := validateLineLength(line); err != nil {
		return toolFail(mapMCPError(err), err.Error()), nil
	}
	if _, err := a.engine.Command(ctx, line, waitStatus); err != nil {
		return toolFail(mapMCPError(err), err.Error()), nil
	}
	return toolOK(map[string]any{"ok": true, "action": "updated", "id": id, "tag": tag, "value": value}), nil
}

func (a *api) mcpDelete(ctx context.Context, args map[string]any) (any, error) {
	id, key, err := resolveMCPID(args)
	if err != nil {
		return toolFail("invalidArgument", err.Error()), nil
	}
	if key != "" {
		row, found, gerr := a.getRowByID(ctx, id)
		if gerr != nil {
			return toolFail(mapMCPError(gerr), gerr.Error()), nil
		}
		if !found {
			return toolOK(map[string]any{"ok": true, "deleted": false, "id": id}), nil
		}
		if _, ok := verifyKey(row, key); !ok {
			return toolFail("keyCollision", "stored key metadata does not match the requested key"), nil
		}
	}
	if _, err := a.engine.Command(ctx, "DELETE "+id, waitStatus); err != nil {
		return toolFail(mapMCPError(err), err.Error()), nil
	}
	return toolOK(map[string]any{"ok": true, "deleted": true, "id": id}), nil
}

func (a *api) mcpFind(ctx context.Context, args map[string]any) (any, error) {
	query, err := argString(args, "query", "")
	if err != nil || query == "" || strings.ContainsAny(query, "\r\n\x00") {
		return toolFail("invalidArgument", "query must be a non-empty single-line string"), nil
	}
	p, err := mcpPage(args)
	if err != nil {
		return toolFail("invalidArgument", err.Error()), nil
	}
	lines, err := a.engine.PagedCommand(ctx, p.limit, p.offset, "FIND "+query)
	if err != nil {
		return toolFail(mapMCPError(err), err.Error()), nil
	}
	rows, err := parseTSVRows(lines)
	if err != nil {
		return toolFail("engineError", err.Error()), nil
	}
	for i := range rows {
		rows[i] = presentRow(rows[i])
	}
	return toolOK(map[string]any{"ok": true, "query": query, "count": len(rows), "matches": rows, "limit": p.limit, "offset": p.offset, "hasMore": len(rows) == p.limit, "nextOffset": nextOffset(p, len(rows))}), nil
}

func (a *api) mcpList(ctx context.Context, args map[string]any) (any, error) {
	p, err := mcpPage(args)
	if err != nil {
		return toolFail("invalidArgument", err.Error()), nil
	}
	lines, err := a.engine.PagedCommand(ctx, p.limit, p.offset, "SELECT *")
	if err != nil {
		return toolFail(mapMCPError(err), err.Error()), nil
	}
	rows, err := parseTSVRows(lines)
	if err != nil {
		return toolFail("engineError", err.Error()), nil
	}
	for i := range rows {
		rows[i] = presentRow(rows[i])
	}
	return toolOK(map[string]any{"ok": true, "count": len(rows), "rows": rows, "limit": p.limit, "offset": p.offset, "hasMore": len(rows) == p.limit, "nextOffset": nextOffset(p, len(rows))}), nil
}

func (a *api) getRowByID(ctx context.Context, id string) (Row, bool, error) {
	lines, err := a.engine.Command(ctx, "SELECT "+id, waitSingleRow)
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

func (a *api) countFromContext(ctx context.Context) (uint64, error) {
	lines, err := a.engine.Command(ctx, "COUNT", waitStatus)
	if err != nil {
		return 0, err
	}
	for _, line := range lines {
		m := countRE.FindStringSubmatch(line)
		if len(m) == 2 {
			return strconv.ParseUint(m[1], 10, 64)
		}
	}
	return 0, errors.New("could not parse COUNT response")
}

func mcpRowFields(args map[string]any, key string) (string, string, string, error) {
	tag, err := argString(args, "tag", "-")
	if err != nil {
		return "", "", "", err
	}
	if err := validateTag(tag); err != nil {
		return "", "", "", err
	}
	content, err := argString(args, "content", "")
	if err != nil {
		return "", "", "", err
	}
	if err := validateContent(content); err != nil {
		return "", "", "", err
	}
	content, err = makeStoredContent(content, key)
	if err != nil {
		return "", "", "", err
	}
	value, err := argString(args, "value", "0")
	if err != nil {
		return "", "", "", err
	}
	value, err = validateValue(value)
	return tag, content, value, err
}

func resolveMCPID(args map[string]any) (string, string, error) {
	if raw, ok := args["id"]; ok && raw != nil && fmt.Sprint(raw) != "" {
		s, err := argString(args, "id", "")
		if err != nil {
			return "", "", err
		}
		id, err := validateID(s)
		return id, "", err
	}
	key, err := argString(args, "key", "")
	if err != nil {
		return "", "", err
	}
	if key == "" {
		return "", "", errors.New("provide either `id` or `key`")
	}
	return keyToID(key), key, nil
}

func decodeArgs(raw json.RawMessage) (map[string]any, error) {
	if len(raw) == 0 || string(raw) == "null" {
		return map[string]any{}, nil
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	var args map[string]any
	if err := dec.Decode(&args); err != nil {
		return nil, err
	}
	return args, nil
}

func argString(args map[string]any, name, fallback string) (string, error) {
	v, ok := args[name]
	if !ok || v == nil {
		return fallback, nil
	}
	switch x := v.(type) {
	case string:
		return x, nil
	case json.Number:
		s := x.String()
		if strings.ContainsAny(s, ".eE") {
			return "", fmt.Errorf("%s must be an integer or decimal string", name)
		}
		return s, nil
	default:
		return "", fmt.Errorf("%s must be a string or integer", name)
	}
}

func getBool(args map[string]any, name string) bool {
	v, _ := args[name].(bool)
	return v
}

func mcpPage(args map[string]any) (page, error) {
	limit, err := argInt(args, "limit", 100)
	if err != nil {
		return page{}, err
	}
	offset, err := argInt(args, "offset", 0)
	if err != nil {
		return page{}, err
	}
	if limit < 1 || limit > 1000 {
		return page{}, errors.New("limit must be an integer from 1 through 1000")
	}
	if offset < 0 {
		return page{}, errors.New("offset must be a non-negative integer")
	}
	return page{limit: limit, offset: offset}, nil
}

func argInt(args map[string]any, name string, fallback int) (int, error) {
	v, ok := args[name]
	if !ok || v == nil {
		return fallback, nil
	}
	switch x := v.(type) {
	case json.Number:
		n, err := strconv.Atoi(x.String())
		return n, err
	case float64:
		if math.Trunc(x) != x {
			return 0, fmt.Errorf("%s must be an integer", name)
		}
		return int(x), nil
	default:
		return 0, fmt.Errorf("%s must be an integer", name)
	}
}

func makeStoredContent(content, key string) (string, error) {
	if key == "" {
		return content, nil
	}
	prefix := keyPrefix + base64.RawURLEncoding.EncodeToString([]byte(key)) + keyDelim
	stored := prefix + content
	if len([]byte(stored)) > maxContentBytes {
		return "", fieldTooLong("content plus key metadata is longer than 175 bytes")
	}
	return stored, nil
}

func presentRow(row Row) Row {
	row.Content = decodeStoredContent(row.Content)
	return row
}

func verifyKey(row Row, key string) (Row, bool) {
	if key == "" {
		return presentRow(row), true
	}
	if !strings.HasPrefix(row.Content, keyPrefix) {
		return Row{}, false
	}
	end := strings.Index(row.Content[len(keyPrefix):], keyDelim)
	if end < 0 {
		return Row{}, false
	}
	end += len(keyPrefix)
	encoded := row.Content[len(keyPrefix):end]
	decoded, err := base64.RawURLEncoding.DecodeString(encoded)
	if err != nil || string(decoded) != key {
		return Row{}, false
	}
	row.Content = row.Content[end+len(keyDelim):]
	return row, true
}

func decodeStoredContent(content string) string {
	if !strings.HasPrefix(content, keyPrefix) {
		return content
	}
	end := strings.Index(content[len(keyPrefix):], keyDelim)
	if end < 0 {
		return content
	}
	return content[len(keyPrefix)+end+len(keyDelim):]
}

func keyToID(key string) string {
	var h uint64 = 1469598103934665603
	const prime uint64 = 1099511628211
	for _, b := range []byte(key) {
		h ^= uint64(b)
		h *= prime
	}
	if h == 0 {
		h = 1
	}
	return strconv.FormatUint(h, 10)
}

func rowToMap(row Row) map[string]any {
	return map[string]any{
		"id": row.ID, "value": row.Value, "tag": row.Tag, "content": row.Content, "created": row.Created, "updated": row.Updated,
	}
}

func toolOK(v map[string]any) map[string]any {
	b, _ := json.MarshalIndent(v, "", "  ")
	return map[string]any{"content": []map[string]string{{"type": "text", "text": string(b)}}}
}

func toolFail(kind, msg string) map[string]any {
	return toolOK(map[string]any{"ok": false, "errorKind": kind, "error": msg})
}

func mapMCPError(err error) string {
	var ce codedError
	if errors.As(err, &ce) {
		if ce.code == "field_too_long" {
			return "fieldTooLong"
		}
		return ce.code
	}
	var ee EngineError
	if errors.As(err, &ee) {
		lower := strings.ToLower(ee.Detail)
		switch {
		case strings.Contains(lower, "not found"):
			return "notFound"
		case strings.Contains(lower, "already exists"):
			return "alreadyExists"
		case strings.Contains(lower, "timed out"):
			return "timeout"
		default:
			return "engineError"
		}
	}
	return "invalidArgument"
}

func nextOffset(p page, n int) any {
	if n == p.limit {
		return p.offset + p.limit
	}
	return nil
}

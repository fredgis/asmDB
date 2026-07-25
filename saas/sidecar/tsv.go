package main

import (
	"errors"
	"fmt"
	"strconv"
	"strings"
	"unicode/utf8"
)

const (
	maxTagBytes     = 39
	maxContentBytes = 175
	maxLineBytes    = 511
)

type Row struct {
	ID      string `json:"id"`
	Value   string `json:"value"`
	Tag     string `json:"tag"`
	Content string `json:"content"`
	Created string `json:"created"`
	Updated string `json:"updated"`
}

func parseTSVRows(lines []string) ([]Row, error) {
	rows := make([]Row, 0, len(lines))
	for _, line := range lines {
		if !strings.HasPrefix(line, "R\t") {
			continue
		}
		cells := strings.Split(line, "\t")
		if len(cells) != 7 {
			return nil, fmt.Errorf("malformed TSV row from engine: %s", line)
		}
		id, err := validateID(cells[1])
		if err != nil {
			return nil, err
		}
		value, err := validateValue(cells[2])
		if err != nil {
			return nil, err
		}
		created, err := validateU64(cells[3], "created")
		if err != nil {
			return nil, err
		}
		updated, err := validateU64(cells[4], "updated")
		if err != nil {
			return nil, err
		}
		rows = append(rows, Row{
			ID:      id,
			Value:   value,
			Created: created,
			Updated: updated,
			Tag:     unescapeTSV(cells[5]),
			Content: unescapeTSV(cells[6]),
		})
	}
	return rows, nil
}

func unescapeTSV(s string) string {
	var b strings.Builder
	b.Grow(len(s))
	for i := 0; i < len(s); i++ {
		if s[i] != '\\' {
			b.WriteByte(s[i])
			continue
		}
		i++
		if i >= len(s) {
			b.WriteByte('\\')
			break
		}
		switch s[i] {
		case '\\':
			b.WriteByte('\\')
		case 't':
			b.WriteByte('\t')
		case 'n':
			b.WriteByte('\n')
		case 'r':
			b.WriteByte('\r')
		default:
			b.WriteByte('\\')
			b.WriteByte(s[i])
		}
	}
	return b.String()
}

func validateID(s string) (string, error) {
	s = strings.TrimSpace(s)
	n, err := strconv.ParseUint(s, 10, 64)
	if err != nil || n == 0 {
		return "", errors.New("id must be a u64 decimal string >= 1")
	}
	return strconv.FormatUint(n, 10), nil
}

func validateU64(s, name string) (string, error) {
	s = strings.TrimSpace(s)
	n, err := strconv.ParseUint(s, 10, 64)
	if err != nil {
		return "", fmt.Errorf("%s must be a u64 decimal string", name)
	}
	return strconv.FormatUint(n, 10), nil
}

func validateValue(s string) (string, error) {
	s = strings.TrimSpace(s)
	n, err := strconv.ParseInt(s, 10, 64)
	if err != nil {
		return "", errors.New("value must be an i64 decimal string")
	}
	return strconv.FormatInt(n, 10), nil
}

func validateTag(s string) error {
	if s == "" {
		return errors.New("tag must not be empty")
	}
	if !utf8.ValidString(s) {
		return errors.New("tag must be valid UTF-8")
	}
	if len([]byte(s)) > maxTagBytes {
		return fieldTooLong("tag is longer than 39 bytes")
	}
	if strings.ContainsAny(s, " \t\r\n\x00") {
		return errors.New("tag must be one token with no spaces, tabs, newlines or NUL")
	}
	return nil
}

func validateContent(s string) error {
	if !utf8.ValidString(s) {
		return errors.New("content must be valid UTF-8")
	}
	if len([]byte(s)) > maxContentBytes {
		return fieldTooLong("content is longer than 175 bytes")
	}
	if strings.ContainsAny(s, "\r\n\x00") {
		return errors.New("content must not contain newline or NUL")
	}
	return nil
}

func validateLineLength(line string) error {
	if len([]byte(line)) > maxLineBytes {
		return fieldTooLong("engine command line would exceed 511 bytes")
	}
	return nil
}

func validateExecCommand(line string) error {
	if strings.ContainsAny(line, "\r\n") {
		return codedError{code: "invalid_request", msg: "command must be a single line"}
	}
	if err := validateLineLength(line); err != nil {
		return err
	}
	cmd := strings.TrimSpace(line)
	if strings.EqualFold(cmd, "EXIT") || strings.EqualFold(cmd, "QUIT") {
		return codedError{code: "invalid_request", msg: "command is not allowed in the browser terminal"}
	}
	return nil
}

type codedError struct {
	code string
	msg  string
}

func (e codedError) Error() string { return e.msg }

func fieldTooLong(msg string) error {
	return codedError{code: "field_too_long", msg: msg}
}

func isOK(line string) bool  { return strings.HasPrefix(line, "[ OK ]") }
func isERR(line string) bool { return strings.HasPrefix(line, "[ERR]") }

func statusDetail(line string) string {
	if strings.HasPrefix(line, "[ OK ]") {
		return strings.TrimSpace(strings.TrimPrefix(line, "[ OK ]"))
	}
	if strings.HasPrefix(line, "[ERR]") {
		return strings.TrimSpace(strings.TrimPrefix(line, "[ERR]"))
	}
	return strings.TrimSpace(line)
}

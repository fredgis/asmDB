package main

import (
	"errors"
	"strings"
	"testing"
)

func TestUnescapeTSVRoundTripSequences(t *testing.T) {
	got := unescapeTSV(`a\\b\tc\nnext\rend\q`)
	want := "a\\b\tc\nnext\rend\\q"
	if got != want {
		t.Fatalf("unescapeTSV() = %q, want %q", got, want)
	}
}

func TestParseTSVPreservesUTF8(t *testing.T) {
	rows, err := parseTSVRows([]string{"R\t2\t7\t1785004851547\t1785004851547\tutf\tcafé"})
	if err != nil {
		t.Fatal(err)
	}
	if rows[0].Content != "café" {
		t.Fatalf("content = %q", rows[0].Content)
	}
}

func TestValidateContentAllows175Bytes(t *testing.T) {
	content := strings.Repeat("x", 175)
	if err := validateContent(content); err != nil {
		t.Fatalf("175-byte content rejected: %v", err)
	}
	if err := validateContent(content + "x"); err == nil {
		t.Fatal("176-byte content was accepted")
	}
}

func TestParseTSVContentWithTabAndNewline(t *testing.T) {
	rows, err := parseTSVRows([]string{`R	3	8	1785004851551	1785004851551	esc	a\tline\nnext`})
	if err != nil {
		t.Fatal(err)
	}
	if rows[0].Content != "a\tline\nnext" {
		t.Fatalf("content = %q", rows[0].Content)
	}
}

func TestERRLineIsDetected(t *testing.T) {
	line := "[ERR] key not found"
	if !isERR(line) {
		t.Fatal("ERR line was not detected")
	}
	if got := statusDetail(line); got != "key not found" {
		t.Fatalf("detail = %q", got)
	}
}

func TestValidateExecCommandAllowlistRejectsUnknown(t *testing.T) {
	err := validateExecCommand("RESTOREPOINT")
	var ce codedError
	if err == nil || !strings.Contains(err.Error(), "RESTOREPOINT") || !strings.Contains(err.Error(), "not allowed") {
		t.Fatalf("unknown command error = %v, want clear allowlist refusal", err)
	}
	if !errors.As(err, &ce) || ce.code != "invalid_request" {
		t.Fatalf("unknown command coded error = %#v", err)
	}
}

func TestValidateExecCommandRejectsBackupRestorePaths(t *testing.T) {
	for _, cmd := range []string{`BACKUP C:\data\out.bak`, `RESTORE C:\data\in.bak`} {
		err := validateExecCommand(cmd)
		if err == nil || !strings.Contains(err.Error(), "caller-supplied filesystem paths are forbidden") {
			t.Fatalf("%s error = %v, want path refusal", cmd, err)
		}
	}
}

func TestValidateExecCommandCapsPageLimit(t *testing.T) {
	if err := validateExecCommand("PAGE 1000 0"); err != nil {
		t.Fatalf("PAGE 1000 0 rejected: %v", err)
	}
	if err := validateExecCommand("PAGE 1001 0"); err == nil || !strings.Contains(err.Error(), "1 through 1000") {
		t.Fatalf("PAGE 1001 0 error = %v, want cap refusal", err)
	}
}

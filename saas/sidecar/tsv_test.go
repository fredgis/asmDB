package main

import (
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

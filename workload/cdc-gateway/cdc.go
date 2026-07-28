package main

import (
	"encoding/binary"
	"fmt"
	"hash/crc32"
	"os"
	"strings"
)

const (
	fileHeaderSize   = 64
	headerCRCOffset  = 40
	frameHeaderSize  = 40
	opSize           = 272
	frameTrailerSize = 16
	minFrameSize     = frameHeaderSize + frameTrailerSize
	maxOpCount       = 8192
	resetFlag        = 1
	knownFlags       = resetFlag
)

var (
	headerMagic   = []byte("ASMCDCH1")
	headerTrailer = []byte("CDCHEND1")
	frameMagic    = []byte("ASMCDC01")
	frameTrailer  = []byte("CDCEND01")
)

type cdcLog struct {
	BaseSeq uint64
	LastSeq uint64
	Frames  []cdcFrame
}

type cdcFrame struct {
	CommitSeq uint64
	Flags     uint64
	Ops       []cdcOp
}

type cdcOp struct {
	Type   string
	ID     uint64
	Record *record
}

type record struct {
	ID      uint64
	Created int64
	Updated int64
	Value   int64
	Tag     string
	Content string
}

type frameJSON struct {
	CommitSeq string    `json:"commitSeq"`
	Flags     flagsJSON `json:"flags"`
	Ops       []opJSON  `json:"ops"`
}

type flagsJSON struct {
	Reset bool `json:"reset"`
}

type opJSON struct {
	Op     string            `json:"op"`
	ID     string            `json:"id"`
	Record map[string]string `json:"record,omitempty"`
}

func readCDC(path string) (cdcLog, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return cdcLog{}, err
	}
	return parseCDC(data)
}

func parseCDC(data []byte) (cdcLog, error) {
	baseSeq, offset, err := parseFileHeader(data)
	if err != nil {
		return cdcLog{}, err
	}
	log := cdcLog{BaseSeq: baseSeq, LastSeq: baseSeq}
	expectedSeq := baseSeq + 1
	if offset == 0 {
		expectedSeq = 1
	}
	for offset < len(data) {
		remaining := len(data) - offset
		if remaining < minFrameSize {
			break
		}
		if string(data[offset:offset+8]) != string(frameMagic) {
			return cdcLog{}, corruptLog(log, 0, "bad magic at offset %d", offset)
		}
		frameSize := le64(data[offset+8 : offset+16])
		commitSeq := le64(data[offset+16 : offset+24])
		opCount := le64(data[offset+24 : offset+32])
		flags := le64(data[offset+32 : offset+40])
		if opCount > maxOpCount {
			return cdcLog{}, corruptLog(log, commitSeq, "op_count %d exceeds maximum %d at offset %d", opCount, maxOpCount, offset)
		}
		if frameSize > uint64(remaining) {
			break
		}
		expectedSize := uint64(frameHeaderSize) + opCount*opSize + frameTrailerSize
		if frameSize != expectedSize {
			return cdcLog{}, corruptLog(log, commitSeq, "inconsistent frame_size at offset %d: got %d, expected %d", offset, frameSize, expectedSize)
		}
		frameEnd := offset + int(frameSize)
		crcOffset := frameEnd - frameTrailerSize
		storedCRC := le64(data[crcOffset : crcOffset+8])
		if string(data[frameEnd-8:frameEnd]) != string(frameTrailer) {
			return cdcLog{}, corruptLog(log, commitSeq, "bad trailer in frame at offset %d", offset)
		}
		calculatedCRC := uint64(crc32.ChecksumIEEE(data[offset:crcOffset]))
		if storedCRC != calculatedCRC {
			return cdcLog{}, corruptLog(log, commitSeq, "crc mismatch in frame at offset %d (seq %d)", offset, commitSeq)
		}
		if commitSeq != expectedSeq {
			return cdcLog{}, corruptLog(log, commitSeq, "bad sequence in frame at offset %d: expected %d, got %d", offset, expectedSeq, commitSeq)
		}
		if flags&^knownFlags != 0 {
			return cdcLog{}, corruptLog(log, commitSeq, "unknown flags 0x%x at offset %d", flags&^knownFlags, offset)
		}
		if flags&resetFlag != 0 && opCount != 0 {
			return cdcLog{}, corruptLog(log, commitSeq, "RESET frame at offset %d has op_count %d, expected 0", offset, opCount)
		}
		ops, err := parseOps(data[offset+frameHeaderSize:crcOffset], int(opCount), offset, log, commitSeq)
		if err != nil {
			return cdcLog{}, err
		}
		log.Frames = append(log.Frames, cdcFrame{CommitSeq: commitSeq, Flags: flags, Ops: ops})
		log.LastSeq = commitSeq
		expectedSeq = commitSeq + 1
		offset = frameEnd
	}
	return log, nil
}

func parseFileHeader(data []byte) (uint64, int, error) {
	if len(data) < fileHeaderSize || string(data[:8]) != string(headerMagic) {
		return 0, 0, nil
	}
	cdcVersion := binary.LittleEndian.Uint32(data[8:12])
	baseSeq := le64(data[32:40])
	storedCRC := le64(data[headerCRCOffset : headerCRCOffset+8])
	calculatedCRC := uint64(crc32.ChecksumIEEE(data[:headerCRCOffset]))
	if string(data[56:64]) != string(headerTrailer) {
		return 0, 0, corrupt("bad CDC header trailer")
	}
	if storedCRC != calculatedCRC {
		return 0, 0, corrupt("CDC header crc mismatch")
	}
	if cdcVersion != 1 {
		return 0, 0, corrupt("unsupported CDC format version %d", cdcVersion)
	}
	return baseSeq, fileHeaderSize, nil
}

func parseOps(data []byte, opCount int, frameOffset int, log cdcLog, commitSeq uint64) ([]cdcOp, error) {
	ops := make([]cdcOp, 0, opCount)
	for i := 0; i < opCount; i++ {
		raw := data[i*opSize : (i+1)*opSize]
		opType := le64(raw[0:8])
		id := le64(raw[8:16])
		image := raw[16:272]
		switch opType {
		case 1:
			rec, err := parseRecord(image)
			if err != nil {
				return nil, corruptLog(log, commitSeq, "%s in frame at offset %d (id %d)", err.Error(), frameOffset, id)
			}
			if rec.ID != id {
				return nil, corruptLog(log, commitSeq, "UPSERT record id %d does not match op id %d in frame at offset %d", rec.ID, id, frameOffset)
			}
			ops = append(ops, cdcOp{Type: "upsert", ID: id, Record: &rec})
		case 2:
			if !allZero(image) {
				return nil, corruptLog(log, commitSeq, "DELETE record image is not zero in frame at offset %d (id %d)", frameOffset, id)
			}
			ops = append(ops, cdcOp{Type: "delete", ID: id})
		default:
			return nil, corruptLog(log, commitSeq, "bad op_type %d in frame at offset %d", opType, frameOffset)
		}
	}
	return ops, nil
}

func parseRecord(raw []byte) (record, error) {
	status := raw[8]
	if status != 1 {
		return record{}, fmt.Errorf("UPSERT record status %d is not OCCUPIED", status)
	}
	return record{
		ID:      le64(raw[0:8]),
		Created: int64(le64(raw[16:24])),
		Updated: int64(le64(raw[24:32])),
		Value:   int64(le64(raw[32:40])),
		Tag:     decodeCString(raw[40:80]),
		Content: decodeCString(raw[80:256]),
	}, nil
}

func (f cdcFrame) toJSON() frameJSON {
	ops := make([]opJSON, 0, len(f.Ops))
	for _, op := range f.Ops {
		out := opJSON{Op: op.Type, ID: formatUint(op.ID)}
		if op.Record != nil {
			out = recordToUpsertJSON(*op.Record)
		}
		ops = append(ops, out)
	}
	return frameJSON{
		CommitSeq: formatUint(f.CommitSeq),
		Flags:     flagsJSON{Reset: f.Flags&resetFlag != 0},
		Ops:       ops,
	}
}

func recordToUpsertJSON(r record) opJSON {
	return opJSON{
		Op: "upsert",
		ID: formatUint(r.ID),
		Record: map[string]string{
			"id":      formatUint(r.ID),
			"value":   strconvInt(r.Value),
			"tag":     r.Tag,
			"content": r.Content,
			"created": strconvInt(r.Created),
			"updated": strconvInt(r.Updated),
		},
	}
}

func decodeCString(raw []byte) string {
	if idx := strings.IndexByte(string(raw), 0); idx >= 0 {
		raw = raw[:idx]
	}
	return string(raw)
}

func allZero(raw []byte) bool {
	for _, b := range raw {
		if b != 0 {
			return false
		}
	}
	return true
}

func le64(raw []byte) uint64 { return binary.LittleEndian.Uint64(raw) }

func formatUint(n uint64) string { return fmt.Sprintf("%d", n) }

func strconvInt(n int64) string { return fmt.Sprintf("%d", n) }

func corrupt(format string, args ...any) error {
	return codedError{code: "cdc_corrupt", msg: fmt.Sprintf(format, args...)}
}

func corruptLog(log cdcLog, commitSeq uint64, format string, args ...any) error {
	return codedError{
		code:         "cdc_corrupt",
		msg:          fmt.Sprintf(format, args...),
		detail:       fmt.Sprintf(format, args...),
		baseSeq:      log.BaseSeq,
		lastSeq:      log.LastSeq,
		commitSeq:    commitSeq,
		hasBaseSeq:   true,
		hasLastSeq:   true,
		hasCommitSeq: commitSeq != 0,
	}
}

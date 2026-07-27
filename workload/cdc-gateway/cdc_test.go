package main

import (
	"encoding/binary"
	"errors"
	"hash/crc32"
	"testing"
)

func TestParseTornTailStopsAtLastCompleteFrame(t *testing.T) {
	data := fixtureLog(0, frameFixture(1, 0, upsertFixture(10)), frameFixture(2, 0, upsertFixture(11)))
	data = append(data, frameFixture(3, 0, upsertFixture(12))[:20]...)
	log, err := parseCDC(data)
	if err != nil {
		t.Fatal(err)
	}
	if log.LastSeq != 2 || len(log.Frames) != 2 {
		t.Fatalf("last=%d frames=%d, want last=2 frames=2", log.LastSeq, len(log.Frames))
	}
}

func TestParseCompleteFrameWithCorruptCRCIsError(t *testing.T) {
	data := fixtureLog(0, frameFixture(1, 0, upsertFixture(10)))
	data[len(data)-16] ^= 0xff
	_, err := parseCDC(data)
	if err == nil {
		t.Fatal("parseCDC succeeded, want corrupt CRC error")
	}
	var ce codedError
	if !errors.As(err, &ce) || ce.code != "cdc_corrupt" {
		t.Fatalf("err = %v, want cdc_corrupt", err)
	}
}

func TestParseResetFrame(t *testing.T) {
	log, err := parseCDC(fixtureLog(4, frameFixture(5, resetFlag)))
	if err != nil {
		t.Fatal(err)
	}
	if !log.Frames[0].toJSON().Flags.Reset {
		t.Fatalf("reset flag not surfaced: %#v", log.Frames[0])
	}
}

func fixtureLog(baseSeq uint64, frames ...[]byte) []byte {
	header := make([]byte, fileHeaderSize)
	copy(header[0:8], headerMagic)
	binary.LittleEndian.PutUint32(header[8:12], 1)
	binary.LittleEndian.PutUint32(header[12:16], 1)
	for i := 16; i < 32; i++ {
		header[i] = byte(i)
	}
	binary.LittleEndian.PutUint64(header[32:40], baseSeq)
	binary.LittleEndian.PutUint64(header[40:48], uint64(crc32.ChecksumIEEE(header[:40])))
	copy(header[56:64], headerTrailer)
	for _, frame := range frames {
		header = append(header, frame...)
	}
	return header
}

func frameFixture(seq, flags uint64, ops ...[]byte) []byte {
	size := frameHeaderSize + len(ops)*opSize + frameTrailerSize
	frame := make([]byte, size)
	copy(frame[0:8], frameMagic)
	binary.LittleEndian.PutUint64(frame[8:16], uint64(size))
	binary.LittleEndian.PutUint64(frame[16:24], seq)
	binary.LittleEndian.PutUint64(frame[24:32], uint64(len(ops)))
	binary.LittleEndian.PutUint64(frame[32:40], flags)
	off := frameHeaderSize
	for _, op := range ops {
		copy(frame[off:off+opSize], op)
		off += opSize
	}
	binary.LittleEndian.PutUint64(frame[off:off+8], uint64(crc32.ChecksumIEEE(frame[:off])))
	copy(frame[off+8:off+16], frameTrailer)
	return frame
}

func upsertFixture(id uint64) []byte {
	op := make([]byte, opSize)
	binary.LittleEndian.PutUint64(op[0:8], 1)
	binary.LittleEndian.PutUint64(op[8:16], id)
	rec := op[16:]
	binary.LittleEndian.PutUint64(rec[0:8], id)
	rec[8] = 1
	binary.LittleEndian.PutUint64(rec[16:24], 1785079512121)
	binary.LittleEndian.PutUint64(rec[24:32], 1785079512999)
	binary.LittleEndian.PutUint64(rec[32:40], 42)
	copy(rec[40:80], []byte("cdc"))
	copy(rec[80:256], []byte("content"))
	return op
}

func deleteFixture(id uint64) []byte {
	op := make([]byte, opSize)
	binary.LittleEndian.PutUint64(op[0:8], 2)
	binary.LittleEndian.PutUint64(op[8:16], id)
	return op
}

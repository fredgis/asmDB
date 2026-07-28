package main

import (
	"encoding/binary"
	"errors"
	"fmt"
	"net/http"
	"os"
	"strconv"
)

const (
	datHeaderSize = 512
	recSize       = 256
	// 8192 slots is 2 MiB of record reads, keeping empty sparse pages cheap over NFS.
	snapshotSlotBudget = 8192

	hdrLiveRows = 24
	hdrSeq      = 88
	hdrResetP   = 96
	hdrBulk     = 128

	recID      = 0
	recStatus  = 8
	recCLen    = 12
	recCreated = 16
	recUpdated = 24
	recValue   = 32
	recTag     = 40
	recContent = 80

	stOccupied = 1
	contentMax = 176
)

var snapshotAfterScanHook func()

type snapshotPage struct {
	Seq       uint64
	LiveRows  uint64
	Rows      []opJSON
	HasMore   bool
	NextAfter uint64
}

type datHeader struct {
	LiveRows uint64
	Seq      uint64
	ResetP   uint64
	Bulk     uint64
}

func readSnapshotPage(path string, after uint64, limit int) (snapshotPage, error) {
	f, err := os.Open(path)
	if err != nil {
		return snapshotPage{}, err
	}
	defer f.Close()

	before, err := readDatHeader(f)
	if err != nil {
		return snapshotPage{}, err
	}
	if op := unstableOperation(before); op != "" {
		return snapshotPage{}, codedError{code: "snapshot_unstable", msg: fmt.Sprintf("snapshot is unstable: %s is in flight", op)}
	}

	st, err := f.Stat()
	if err != nil {
		return snapshotPage{}, err
	}
	totalSlots := uint64(0)
	if st.Size() > datHeaderSize {
		totalSlots = uint64((st.Size() - datHeaderSize) / recSize)
	}
	page := snapshotPage{
		Seq:       before.Seq,
		LiveRows:  before.LiveRows,
		Rows:      make([]opJSON, 0, limit),
		NextAfter: min(after, totalSlots),
	}
	if before.LiveRows != 0 && after < totalSlots {
		page = scanSnapshotRows(f, before, after, totalSlots, limit)
	}

	if snapshotAfterScanHook != nil {
		snapshotAfterScanHook()
	}
	afterHeader, err := readDatHeader(f)
	if err != nil {
		return snapshotPage{}, err
	}
	if afterHeader.Seq != before.Seq {
		return snapshotPage{}, codedError{code: "snapshot_moved", msg: "table changed while snapshot was being read"}
	}
	if op := unstableOperation(afterHeader); op != "" {
		return snapshotPage{}, codedError{code: "snapshot_unstable", msg: fmt.Sprintf("snapshot is unstable: %s is in flight", op)}
	}
	return page, nil
}

func scanSnapshotRows(f *os.File, header datHeader, after, totalSlots uint64, limit int) snapshotPage {
	page := snapshotPage{
		Seq:       header.Seq,
		LiveRows:  header.LiveRows,
		Rows:      make([]opJSON, 0, limit),
		NextAfter: after,
	}
	buf := make([]byte, recSize*64)
	slot := after
	scanEnd := min(totalSlots, after+snapshotSlotBudget)
	for slot < scanEnd && len(page.Rows) < limit && !snapshotFoundAllFromStart(after, uint64(len(page.Rows)), header.LiveRows) {
		nslots := min(uint64(len(buf)/recSize), scanEnd-slot)
		readLen := int(nslots) * recSize
		n, err := f.ReadAt(buf[:readLen], int64(datHeaderSize+slot*recSize))
		if err != nil && n == 0 {
			break
		}
		complete := n / recSize
		for i := 0; i < complete && len(page.Rows) < limit && !snapshotFoundAllFromStart(after, uint64(len(page.Rows)), header.LiveRows); i++ {
			raw := buf[i*recSize : (i+1)*recSize]
			if raw[recStatus] == stOccupied {
				page.Rows = append(page.Rows, recordToUpsertJSON(parseSnapshotRecord(raw)))
			}
			slot++
			page.NextAfter = slot
		}
		if complete == 0 || uint64(complete) < nslots {
			break
		}
	}
	page.HasMore = page.NextAfter < totalSlots
	if after == 0 && uint64(len(page.Rows)) >= header.LiveRows {
		page.HasMore = false
	}
	return page
}

func snapshotFoundAllFromStart(after, found, liveRows uint64) bool {
	return after == 0 && found >= liveRows
}

func parseSnapshotRecord(raw []byte) record {
	clen := binary.LittleEndian.Uint32(raw[recCLen : recCLen+4])
	if clen > contentMax {
		clen = contentMax
	}
	return record{
		ID:      le64(raw[recID : recID+8]),
		Created: int64(le64(raw[recCreated : recCreated+8])),
		Updated: int64(le64(raw[recUpdated : recUpdated+8])),
		Value:   int64(le64(raw[recValue : recValue+8])),
		Tag:     decodeCString(raw[recTag:recContent]),
		Content: string(raw[recContent : recContent+int(clen)]),
	}
}

func readDatHeader(f *os.File) (datHeader, error) {
	header := make([]byte, datHeaderSize)
	n, err := f.ReadAt(header, 0)
	if err != nil && n < datHeaderSize {
		return datHeader{}, err
	}
	if string(header[:5]) != "ASMDB" {
		return datHeader{}, errors.New("invalid .dat header")
	}
	return datHeader{
		LiveRows: le64(header[hdrLiveRows : hdrLiveRows+8]),
		Seq:      le64(header[hdrSeq : hdrSeq+8]),
		ResetP:   le64(header[hdrResetP : hdrResetP+8]),
		Bulk:     le64(header[hdrBulk : hdrBulk+8]),
	}, nil
}

func unstableOperation(h datHeader) string {
	switch h.Bulk {
	case 1:
		return "truncate"
	case 2:
		return "restore"
	case 3:
		return "bench"
	case 0:
		if h.ResetP != 0 {
			return "reset"
		}
		return ""
	default:
		return "bulk operation " + strconv.FormatUint(h.Bulk, 10)
	}
}

func writeSnapshotError(w http.ResponseWriter, err error) {
	var ce codedError
	if errors.As(err, &ce) {
		switch ce.code {
		case "snapshot_unstable":
			writeError(w, http.StatusServiceUnavailable, ce.code, ce.msg, "")
		case "snapshot_moved":
			writeError(w, http.StatusConflict, ce.code, ce.msg, "")
		default:
			writeError(w, http.StatusBadRequest, ce.code, ce.msg, "")
		}
		return
	}
	writeError(w, http.StatusServiceUnavailable, "share_unreadable", "instance data is unreadable", err.Error())
}

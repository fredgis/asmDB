; -----------------------------------------------------------------------------
; src/asmdb.inc - shared constants, record layout, Win32 values.
; -----------------------------------------------------------------------------
%define IMAGEBASE 0x400000
%define ALIGN     0x200
%define RVA(x)    ((x) - IMAGEBASE)

; ---- Record layout (256 bytes, four cache lines) ----
; A general-purpose fixed record: a numeric value/score, creation/update
; timestamps, a short category tag, and a free-text content field, all
; fixed-width. (Agent memory is one example use case, not the only one.)
%define REC_SIZE    256
%define REC_SHIFT   8        ; log2(REC_SIZE) - slot index <-> byte offset
%define REC_ID      0        ; u64  primary key
%define REC_STATUS  8        ; u8   0 empty / 1 live / 2 deleted
%define REC_KIND    9        ; u8   row-kind tag (reserved, default 0)
%define REC_CLEN    12       ; u32  content byte length
%define REC_CREATED 16       ; i64  created  (unix epoch ms)
%define REC_UPDATED 24       ; i64  updated  (unix epoch ms)
%define REC_VALUE   32       ; i64  numeric payload / score
%define REC_TAG     40       ; char[40]  category / namespace, NUL-padded
%define REC_CONTENT 80       ; char[176] free text, NUL-padded
%define TAG_MAX     40
%define CONTENT_MAX 176

%define ST_EMPTY    0
%define ST_OCCUPIED 1
%define ST_DELETED  2

; ---- Row-kind tag (stored in REC_KIND; reserved for future use) ----
%define KIND_GENERIC 0

; ---- Hash table (v1: fixed power-of-two capacity) ----
; CAPACITY = 2^22 slots x 256 B = a 1 GiB record region, sized so the table can
; hold millions of rows below the 0.75 load-factor cap (BENCH tops out at 3.1M).
; The .dat file is created sparse (see db_open), so an empty DB costs ~0 on disk.
%define CAPACITY   4194304
%define CAP_SHIFT  42        ; 64 - log2(CAPACITY) = 64 - 22
%define GOLDEN     0x9E3779B97F4A7C15

; ---- Buffers ----
%define LINE_MAX       512
%define READ_BUF_SIZE  4096
%define WAL_BUF_SIZE   0x200000   ; 2 MiB in-memory WAL staging
%define UNDO_MAX       4096       ; max slots touched per transaction
%define UNDO_ENTRY     (8+REC_SIZE) ; 8-byte slot index + record image
; "R" + 5 numeric columns (20 digits each) + 6 separators + fully escaped tag
; and content (two bytes per source byte) + CRLF, rounded up.
%define TSV_BUF_SIZE   (2 + 5*21 + 2*(TAG_MAX + CONTENT_MAX) + 4)
%define PAGE_LIMIT_MAX 1000000    ; refuse absurd page sizes rather than wrap
%define VERIFY_MAX_REPORT 16      ; per-slot problems printed before summarising

; ---- Dispatch results ----
%define CMD_OK   0
%define CMD_EXIT 1

; ---- SELECT table column widths ----
%define W_ID      8
%define W_TAG     16
%define W_VAL     12
%define W_CONTENT 40

; ---- Win32 constants ----
%define STD_INPUT_HANDLE   -10
%define STD_OUTPUT_HANDLE  -11
%define MEM_COMMIT_RESERVE 0x3000
%define PAGE_READWRITE     0x04
%define GENERIC_READ       0x80000000
%define GENERIC_WRITE      0x40000000
%define OPEN_ALWAYS        4
%define OPEN_EXISTING      3
%define CREATE_ALWAYS      2
%define CREATE_NEW         1
%define MOVEFILE_REPLACE_EXISTING 0x1
%define MOVEFILE_WRITE_THROUGH    0x8
%define FILE_ATTRIBUTE_NORMAL 0x80
%define FILE_BEGIN         0
%define PAGE_WRITECOPY     0x08
%define FILE_MAP_COPY      0x0001
%define FSCTL_SET_SPARSE   0x000900C4
%define ENABLE_VT          0x0004    ; ENABLE_VIRTUAL_TERMINAL_PROCESSING
%define INVALID_HANDLE     -1
%define ERROR_SHARING_VIOLATION 32

; ---- WIN32_FIND_DATAA field offsets ----
%define FIND_SIZELOW  32
%define FIND_NAME     44
%define FIND_STRUCT   592

; ---- Versioning ----
; TWO independent numbers, deliberately kept apart:
;
;   ENGINE_VERSION  the software. Moves often. Pre-1.0 rule: while MAJOR is 0,
;                   MINOR marks a milestone or a behaviour change and PATCH
;                   marks fixes, perf and docs. 1.0 is declared by the project
;                   owner, not reached automatically.
;   DB_VERSION      the on-disk layout. Moves almost never, and ONLY when the
;                   bytes in <db>.dat change meaning. This is the number that
;                   governs whether a file can be opened, and the one an
;                   upgrade path would migrate.
;
; The engine version that last wrote a file is stamped into the header at
; HDR_ENGINE purely for diagnostics: it tells you which build touched a
; database, without ever affecting whether it can be opened.
%define ENGINE_MAJOR 1
%define ENGINE_MINOR 2
%define ENGINE_PATCH 0
%define ENGINE_VERSION ((ENGINE_MAJOR << 16) | (ENGINE_MINOR << 8) | ENGINE_PATCH)

; ---- On-disk ----
%define HDR_SIZE   512
%define DB_VERSION 2          ; v2 adds the CDC metadata below
%define HDR_TABLE  32         ; table-name field offset in the header
%define TABLE_MAX  48         ; max table-name length
%define HDR_ENGINE 80         ; u32: engine version that last wrote this file
%define HDR_SEQ    88         ; u64: last_commit_seq published to the CDC log
%define HDR_RESETP 96         ; u64: 1 = a global RESET is mid-flight
%define HDR_RESETS 104        ; u64: the sequence that RESET will carry
%define HDR_LINEAGE 112       ; 16 bytes: identity shared with the change log

; ---- Change data capture (<db>.cdc) ----
; Append-only log, one frame per committed transaction that changed something.
;   +0    8   magic 'ASMCDC01'
;   +8    8   frame_size (whole frame, magic..trailer)
;   +16   8   commit_seq (strictly increasing, starts at 1)
;   +24   8   op_count
;   +32   8   flags (bit 0 = RESET)
;   +40   op_count * CDC_OP_SIZE
;   +X    8   crc32 of [0, X), zero-extended
;   +X+8  8   trailer 'CDCEND01'
; Operations are fixed-size so a reader never has to guess:
;   +0    8   op_type (1 = UPSERT, 2 = DELETE)
;   +8    8   id
;   +16 256   record image (all zero for DELETE)
%define CDC_HDR_SIZE   40
%define CDC_TAIL_SIZE  16
%define CDC_OP_SIZE    (16 + REC_SIZE)
%define CDC_OP_UPSERT  1
%define CDC_OP_DELETE  2
%define CDC_FLAG_RESET 1
; Worst case: every staged entry emits two operations (a reused slot yields
; DELETE(old) + UPSERT(new)), so the staging buffer must hold 2*UNDO_MAX ops.
%define CDC_MAX_OPS    (UNDO_MAX * 2)
%define CDC_BUF_SIZE   (CDC_HDR_SIZE + CDC_MAX_OPS * CDC_OP_SIZE + CDC_TAIL_SIZE)

; ---- CDC file header (64 bytes, precedes the first frame) ----
; Without it a log is anonymous: pair a fresh <db>.dat with an old <db>.cdc and
; the new database restarts at sequence 1 while the log already holds 100, so
; every one of the next hundred commits looks "already published" and is
; silently dropped. The lineage ties the two files together, and base_seq says
; where this log's numbering starts so a log recreated after an operator removed
; it can still be verified frame by frame.
;   +0   8  magic 'ASMCDCH1'
;   +8   4  cdc_format_version
;   +12  4  record_format_version
;   +16  16 lineage (matches the .dat header at HDR_LINEAGE)
;   +32  8  base_seq - the first frame carries base_seq + 1
;   +40  8  crc32 of [0, 40), zero-extended
;   +48  8  reserved
;   +56  8  trailer 'CDCHEND1'
%define CDCH_SIZE      64
%define CDCH_FMT       8
%define CDCH_RECFMT    12
%define CDCH_LINEAGE   16
%define CDCH_BASESEQ   32
%define CDCH_CRC       40
%define CDCH_TRAILER   56
%define CDC_FORMAT     1

; ---- WAL record tags ----
%define WAL_BEGIN  1
%define WAL_WRITE  2
%define WAL_COMMIT 3

; ---- WAL frame header sizes ----
; v01/v02: magic, N, count.  v03 adds the CDC commit sequence and frame flags,
; so recovery can republish a change frame that a crash lost.
%define WAL_HDR_V2 24
%define WAL_HDR_V3 40

; ---- WAL entry layouts ----
; v01/v02 entries are {slot index, after-image} = UNDO_ENTRY bytes.
; v03 entries also carry what the slot held BEFORE the transaction touched it.
; Without that, a slot whose tombstone gets reused inside one transaction
; (DELETE 5 then INSERT 9 landing on the same slot) would only ever produce
; UPSERT 9 - the DELETE of row 5 would vanish and a consumer would keep it
; forever. The previous id and status are what let commit and recovery both
; emit DELETE(old) followed by UPSERT(new).
;   +0    8   slot index
;   +8    8   prev_id
;   +16   8   prev_status
;   +24 REC_SIZE  after-image
%define WAL_ENT_PREVID  8
%define WAL_ENT_PREVST  16
%define WAL_ENT_IMAGE   24
%define WAL_ENT_V3      (WAL_ENT_IMAGE + REC_SIZE)

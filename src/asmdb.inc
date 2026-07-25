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

; ---- On-disk ----
%define HDR_SIZE   512
%define DB_VERSION 1
%define HDR_TABLE  32         ; table-name field offset in the header
%define TABLE_MAX  48         ; max table-name length

; ---- WAL record tags ----
%define WAL_BEGIN  1
%define WAL_WRITE  2
%define WAL_COMMIT 3

; -----------------------------------------------------------------------------
; src/asmdb.inc - shared constants, record layout, Win32 values.
; -----------------------------------------------------------------------------
%define IMAGEBASE 0x400000
%define ALIGN     0x200
%define RVA(x)    ((x) - IMAGEBASE)

; ---- Record layout (64 bytes, one cache line) ----
%define REC_SIZE   64
%define REC_ID     0        ; u64 primary key
%define REC_STATUS 8        ; u8 status
%define REC_VALUE  16       ; i64 value
%define REC_NAME   24       ; char[40]
%define NAME_MAX   40

%define ST_EMPTY    0
%define ST_OCCUPIED 1
%define ST_DELETED  2

; ---- Hash table (v1: fixed power-of-two capacity) ----
%define CAPACITY   65536
%define CAP_SHIFT  48        ; 64 - log2(CAPACITY) = 64 - 16
%define GOLDEN     0x9E3779B97F4A7C15

; ---- Buffers ----
%define LINE_MAX       512
%define READ_BUF_SIZE  4096
%define WAL_BUF_SIZE   0x100000   ; 1 MiB in-memory WAL staging
%define UNDO_MAX       4096       ; max slots touched per transaction
%define UNDO_ENTRY     72         ; 8-byte slot index + 64-byte record image

; ---- Dispatch results ----
%define CMD_OK   0
%define CMD_EXIT 1

; ---- SELECT table column widths ----
%define W_ID   10
%define W_NAME 22
%define W_VAL  14

; ---- Win32 constants ----
%define STD_INPUT_HANDLE   -10
%define STD_OUTPUT_HANDLE  -11
%define MEM_COMMIT_RESERVE 0x3000
%define PAGE_READWRITE     0x04
%define GENERIC_READ       0x80000000
%define GENERIC_WRITE      0x40000000
%define OPEN_ALWAYS        4
%define FILE_ATTRIBUTE_NORMAL 0x80
%define FILE_BEGIN         0
%define ENABLE_VT          0x0004    ; ENABLE_VIRTUAL_TERMINAL_PROCESSING
%define INVALID_HANDLE     -1

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

; -----------------------------------------------------------------------------
; src/data.inc - globals, strings, on-disk header template, import table.
; All of this lives in the single read/write .text section.
; -----------------------------------------------------------------------------

; ------------------------------- globals ------------------------------------
g_stdout:      dq 0
g_stdin:       dq 0
g_written:     dd 0
g_readlen_dw:  dd 0
g_io_dw:       dd 0
g_readbuf:     dq 0
g_readlen:     dq 0
g_readpos:     dq 0
g_linebuf:     dq 0
g_table:       dq 0
g_count:       dq 0
g_dat_handle:  dq 0
g_wal_handle:  dq 0
g_in_txn:      dq 0
g_undo:        dq 0
g_undo_n:      dq 0
g_count_snap:  dq 0
g_walbuf:      dq 0
g_color:       dq 0
g_qpf:         dq 0
g_qpc0:        dq 0
g_qpc1:        dq 0
g_qpc2:        dq 0
g_conmode:     dd 0
g_have_argtable: dd 0
g_onech:       db 0
               align 8
g_tmp:         times 32 db 0
g_spaces:      times 64 db ' '
g_namebuf:     times 64 db 0
g_base:        times 216 db 0
g_datname:     times 224 db 0
g_walname:     times 224 db 0
g_tablename:   times 64 db 0
g_argtable:    times 64 db 0
g_finddata:    times FIND_STRUCT db 0
g_hdr_read:    times HDR_SIZE db 0

; --------------------------- on-disk header ---------------------------------
                align 8
g_hdr:
    db 'ASMDB', 0, 0, 0              ; +0  magic (8 bytes)
    dd DB_VERSION                    ; +8
    dd REC_SIZE                      ; +12
    dq CAPACITY                      ; +16
    dq 0                             ; +24 live count (rewritten at runtime)
    times HDR_SIZE-32 db 0           ; pad to 512

; ------------------------------- strings ------------------------------------
; ANSI SGR colors (emitted only when stdout is a real console).
c_reset:       db 27, '[0m', 0
c_bold:        db 27, '[1m', 0
c_dim:         db 27, '[38;5;244m', 0
c_grey:        db 27, '[38;5;240m', 0
c_white:       db 27, '[1m', 27, '[38;5;255m', 0
c_cyan:        db 27, '[38;5;45m', 0
c_blue:        db 27, '[38;5;39m', 0
c_indigo:      db 27, '[38;5;99m', 0
c_green:       db 27, '[38;5;41m', 0
c_red:         db 27, '[38;5;203m', 0
c_yellow:      db 27, '[38;5;221m', 0
c_prompt:      db 27, '[1m', 27, '[38;5;45m', 0

s_magic:       db 'ASMDB', 0
s_defbase:     db 'asmdb', 0
s_dotdat:      db '.dat', 0
s_pat_dat:     db '*.dat', 0
s_dotwal:      db '.wal', 0
                align 8
wal_magic:     db 'ASMWAL01'
wal_commit:    db 'COMMIT01'

s_prompt:      db 'asmdb> ', 0
s_unknown:     db '[ERR] unknown command - type HELP', 13, 10, 0
s_ok_ins:      db '[ OK ] 1 row inserted', 13, 10, 0
s_ok_upd:      db '[ OK ] 1 row updated', 13, 10, 0
s_ok_del:      db '[ OK ] 1 row deleted', 13, 10, 0
s_err_dup:     db '[ERR] key already exists', 13, 10, 0
s_err_nf:      db '[ERR] key not found', 13, 10, 0
s_err_full:    db '[ERR] table full', 13, 10, 0
s_err_syntax:  db '[ERR] syntax error - type HELP', 13, 10, 0
s_count_pre:   db '[ OK ] ', 0
s_count_post:  db ' row(s)', 13, 10, 0
s_txn:         db '[ OK ] autocommit mode (each statement is durable)', 13, 10, 0
s_txn_begin:    db '[ OK ] transaction started', 13, 10, 0
s_txn_commit:   db '[ OK ] transaction committed', 13, 10, 0
s_txn_rollback: db '[ OK ] transaction rolled back', 13, 10, 0
s_txn_none:     db '[ERR] no active transaction', 13, 10, 0
s_txn_active:   db '[ERR] transaction already active', 13, 10, 0
s_txn_toobig:   db '[ERR] transaction too large - COMMIT or ROLLBACK', 13, 10, 0

                align 8
bench_name40:   db 'bench_row', 0
                times 40-($-bench_name40) db 0
s_bench_pre:    db '[ OK ] BENCH inserted ', 0
s_bench_rows:   db ' rows', 13, 10, 0
s_bench_ram:    db '  in-RAM insert            : ', 0
s_bench_rs:     db ' rows/sec  (engine only, no I/O)', 13, 10, 0
s_bench_dur:    db '  checkpoint + fsync total : ', 0
s_bench_ms:     db ' ms  (full-table durable write)', 13, 10, 0

s_cell_l:      db '| ', 0
s_cell_m:      db ' | ', 0
s_cell_r:      db ' |', 0
s_lbl_id:      db 'id', 0
s_lbl_name:    db 'name', 0
s_lbl_val:     db 'value', 0

h_title:    db '  asmdb command reference', 0
h_g_data:   db '  Data', 0
h_g_txn:    db '  Transactions', 0
h_g_cat:    db '  Catalog', 0
h_g_sess:   db '  Session', 0

hc_insert:  db 'INSERT <id> <val> <name>', 0
hd_insert:  db 'add a new row', 0
hc_sel1:    db 'SELECT <id>', 0
hd_sel1:    db 'show one row by key', 0
hc_selall:  db 'SELECT *', 0
hd_selall:  db 'list every live row', 0
hc_update:  db 'UPDATE <id> <val> <name>', 0
hd_update:  db 'modify an existing row', 0
hc_delete:  db 'DELETE <id>', 0
hd_delete:  db 'remove a row by key', 0
hc_count:   db 'COUNT', 0
hd_count:   db 'number of live rows', 0

hc_begin:   db 'BEGIN', 0
hd_begin:   db 'start a transaction', 0
hc_commit:  db 'COMMIT', 0
hd_commit:  db 'make pending changes durable', 0
hc_rback:   db 'ROLLBACK', 0
hd_rback:   db 'discard pending changes', 0

hc_tables:  db 'TABLES', 0
hd_tables:  db 'tables in the current database', 0
hc_dbs:     db 'DATABASES', 0
hd_dbs:     db 'list *.dat files in this folder', 0
hc_schema:  db 'SCHEMA', 0
hd_schema:  db 'show the record layout', 0
hc_types:   db 'TYPES', 0
hd_types:   db 'supported column types', 0
hc_bench:   db 'BENCH <n>', 0
hd_bench:   db 'insert n synthetic rows, report rows/sec', 0

hc_help:    db 'HELP', 0
hd_help:    db 'show this reference', 0
hc_exit:    db 'EXIT / QUIT', 0
hd_exit:    db 'leave asmdb', 0

; ---- SCHEMA / TYPES (static) ----
s_schema_title: db '  record layout - fixed 64 bytes per row', 0
s_schema_body:
    db 13, 10
    db '    offset  size  field   type', 13, 10
    db '    ------  ----  ------  --------------------------------', 13, 10
    db '    0       8     id      u64  primary key', 13, 10
    db '    8       1     status  u8   0 empty / 1 live / 2 deleted', 13, 10
    db '    16      8     value   i64  signed', 13, 10
    db '    24      40    name    char[40] ASCII, NUL-padded', 13, 10
    db 13, 10, 0

s_types_title: db '  supported column types', 0
s_types_body:
    db 13, 10
    db '    type         bits  domain                      column', 13, 10
    db '    ----------   ----  --------------------------  -----------', 13, 10
    db '    u64            64  0 .. 1.8e19                 id (key)', 13, 10
    db '    i64            64  -9.2e18 .. 9.2e18           value', 13, 10
    db '    u32 / i32      32  narrowed integer            value', 13, 10
    db '    u16 / i16      16  narrowed integer            value', 13, 10
    db '    u8  / i8        8  narrowed integer            value', 13, 10
    db '    bool            8  0 = false / 1 = true        value', 13, 10
    db '    f64            64  IEEE-754 double             value (bits)', 13, 10
    db '    timestamp      64  Unix epoch milliseconds     value', 13, 10
    db '    char[40]      320  fixed ASCII text, <= 40 B   name', 13, 10
    db 13, 10
    db '    A physical row is u64 id + u8 status + i64 value + char[40] name', 13, 10
    db '    (64 bytes, one cache line). Narrow ints, bool, f64 and timestamps', 13, 10
    db '    all live in the 64-bit value cell - asmdb keeps the raw bits and', 13, 10
    db '    your app picks the interpretation.', 13, 10
    db 13, 10, 0

; ---- TABLES / DATABASES ----
s_tables_title: db '  tables in database ', 0
s_tables_hdr:
    db '    table                        rows', 13, 10
    db '    -------------------------    ----------', 0
s_dbs_title:    db '  databases in this folder', 0
s_dbs_hdr:
    db '    database                     size (bytes)   current', 13, 10
    db '    -------------------------    ------------   -------', 0
s_dbs_empty:    db '    (none found)', 0

; -------------------------------- banner ------------------------------------
; Printed by print_banner (console.inc) with color when stdout is a console.
bnr1:  db '                              ____  ', 0
bnr2:  db '    ____ __________ ___  ____/ / /_ ', 0
bnr3:  db '   / __ `/ ___/ __ `__ \/ __  / __ \', 0
bnr4:  db '  / /_/ (__  ) / / / / / /_/ / /_/ /', 0
bnr5:  db '  \__,_/____/_/ /_/ /_/\__,_/_.___/ ', 0
s_tagline:  db '  a minimalist transactional database engine, in x86-64 assembly', 0
s_meta:     db '  nasm -f bin  .  no linker  .  no CRT  .  WAL durability  .  ~14 KB', 0
s_hint_a:   db '  type ', 0
s_hint_hi1: db 'HELP', 0
s_hint_b:   db ' for commands, or ', 0
s_hint_hi2: db 'QUIT', 0
s_hint_c:   db ' to exit', 0

; ------------------------------- keywords -----------------------------------
kw_insert:     db 'INSERT', 0
kw_select:     db 'SELECT', 0
kw_update:     db 'UPDATE', 0
kw_delete:     db 'DELETE', 0
kw_count:      db 'COUNT', 0
kw_help:       db 'HELP', 0
kw_exit:       db 'EXIT', 0
kw_quit:       db 'QUIT', 0
kw_begin:      db 'BEGIN', 0
kw_commit:     db 'COMMIT', 0
kw_rollback:   db 'ROLLBACK', 0
kw_tables:     db 'TABLES', 0
kw_databases:  db 'DATABASES', 0
kw_schema:     db 'SCHEMA', 0
kw_types:      db 'TYPES', 0
kw_bench:      db 'BENCH', 0

; ----------------------------- import table ---------------------------------
                align 4
import_dir:
    dd 0                             ; OriginalFirstThunk
    dd 0                             ; TimeDateStamp
    dd 0                             ; ForwarderChain
    dd RVA(dll_name)                 ; Name
    dd RVA(iat)                      ; FirstThunk
    times 5 dd 0                     ; null descriptor
import_dir_size equ $ - import_dir

                align 8
iat:
iat_GetStdHandle:      dq RVA(h_GetStdHandle)
iat_WriteFile:         dq RVA(h_WriteFile)
iat_ReadFile:          dq RVA(h_ReadFile)
iat_VirtualAlloc:      dq RVA(h_VirtualAlloc)
iat_CreateFileA:       dq RVA(h_CreateFileA)
iat_SetFilePointerEx:  dq RVA(h_SetFilePointerEx)
iat_FlushFileBuffers:  dq RVA(h_FlushFileBuffers)
iat_SetEndOfFile:      dq RVA(h_SetEndOfFile)
iat_CloseHandle:       dq RVA(h_CloseHandle)
iat_GetCommandLineA:   dq RVA(h_GetCommandLineA)
iat_GetConsoleMode:    dq RVA(h_GetConsoleMode)
iat_SetConsoleMode:    dq RVA(h_SetConsoleMode)
iat_FindFirstFileA:    dq RVA(h_FindFirstFileA)
iat_FindNextFileA:     dq RVA(h_FindNextFileA)
iat_FindClose:         dq RVA(h_FindClose)
iat_ExitProcess:       dq RVA(h_ExitProcess)
iat_QueryPerformanceCounter:   dq RVA(h_QueryPerformanceCounter)
iat_QueryPerformanceFrequency: dq RVA(h_QueryPerformanceFrequency)
                       dq 0

dll_name: db 'kernel32.dll', 0

                align 2
h_GetStdHandle:      dw 0
    db 'GetStdHandle', 0
                align 2
h_WriteFile:         dw 0
    db 'WriteFile', 0
                align 2
h_ReadFile:          dw 0
    db 'ReadFile', 0
                align 2
h_VirtualAlloc:      dw 0
    db 'VirtualAlloc', 0
                align 2
h_CreateFileA:       dw 0
    db 'CreateFileA', 0
                align 2
h_SetFilePointerEx:  dw 0
    db 'SetFilePointerEx', 0
                align 2
h_FlushFileBuffers:  dw 0
    db 'FlushFileBuffers', 0
                align 2
h_SetEndOfFile:      dw 0
    db 'SetEndOfFile', 0
                align 2
h_CloseHandle:       dw 0
    db 'CloseHandle', 0
                align 2
h_GetCommandLineA:   dw 0
    db 'GetCommandLineA', 0
                align 2
h_GetConsoleMode:    dw 0
    db 'GetConsoleMode', 0
                align 2
h_SetConsoleMode:    dw 0
    db 'SetConsoleMode', 0
                align 2
h_FindFirstFileA:    dw 0
    db 'FindFirstFileA', 0
                align 2
h_FindNextFileA:     dw 0
    db 'FindNextFileA', 0
                align 2
h_FindClose:         dw 0
    db 'FindClose', 0
                align 2
h_ExitProcess:       dw 0
    db 'ExitProcess', 0
                align 2
h_QueryPerformanceCounter:   dw 0
    db 'QueryPerformanceCounter', 0
                align 2
h_QueryPerformanceFrequency: dw 0
    db 'QueryPerformanceFrequency', 0

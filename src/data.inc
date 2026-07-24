; -----------------------------------------------------------------------------
; src/data.inc - globals, strings, on-disk header template.
; All of this lives in the single read/write .text section.
; -----------------------------------------------------------------------------

; ------------------------------- globals ------------------------------------
g_stdout:      dq 0
g_stdin:       dq 0
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
g_open_locked: dq 0
g_have_argtable: dd 0
g_onech:       db 0
               align 8
g_tmp:         times 32 db 0
g_spaces:      times 64 db ' '
g_namebuf:     times 64 db 0
g_tagbuf:      times 48 db 0
g_contentbuf:  times 192 db 0
g_base:        times 216 db 0
g_datname:     times 224 db 0
g_walname:     times 224 db 0
g_bakname:     times 224 db 0
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
s_err_open:    db '[ERR] cannot open database file', 13, 10, 0
s_err_lock:    db '[ERR] database is locked by another process (single-writer)', 13, 10, 0
s_err_check:   db '[ERR] constraint: id must be >= 1 (0 is reserved)', 13, 10, 0
s_err_mem:     db '[ERR] out of memory', 13, 10, 0
s_count_pre:   db '[ OK ] ', 0
s_count_post:  db ' row(s)', 13, 10, 0
s_find_none:   db '[ OK ] no matching rows', 13, 10, 0
s_range_none:  db '[ OK ] no rows in range', 13, 10, 0
s_ok_backup:   db '[ OK ] backup written', 13, 10, 0
s_ok_restore:  db '[ OK ] database restored from backup', 13, 10, 0
s_err_bak_open: db '[ERR] cannot open backup file', 13, 10, 0
s_err_bak_magic:db '[ERR] not an asmdb backup (bad magic)', 13, 10, 0
s_err_txn_busy: db '[ERR] finish the transaction first (COMMIT or ROLLBACK)', 13, 10, 0
s_det_id:      db '  id       : ', 0
s_det_value:   db '  value    : ', 0
s_det_tag:     db '  tag      : ', 0
s_det_created: db '  created  : ', 0
s_det_updated: db '  updated  : ', 0
s_det_content: db '  content  : ', 0
s_det_ms:      db ' ms', 0
s_txn_begin:    db '[ OK ] transaction started', 13, 10, 0
s_txn_commit:   db '[ OK ] transaction committed', 13, 10, 0
s_txn_rollback: db '[ OK ] transaction rolled back', 13, 10, 0
s_txn_none:     db '[ERR] no active transaction', 13, 10, 0
s_txn_active:   db '[ERR] transaction already active', 13, 10, 0
s_txn_toobig:   db '[ERR] transaction too large - COMMIT or ROLLBACK', 13, 10, 0

                align 8
bench_tag:      db 'bench'
                times TAG_MAX-($-bench_tag) db 0
bench_content:  db 'synthetic benchmark record for throughput measurement'
bench_clen      equ $-bench_content
                times CONTENT_MAX-bench_clen db 0
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
s_lbl_tag:     db 'tag', 0
s_lbl_val:     db 'value', 0
s_lbl_content: db 'content', 0

h_title:    db '  asmdb command reference', 0
h_g_data:   db '  Data', 0
h_g_txn:    db '  Transactions', 0
h_g_cat:    db '  Catalog', 0
h_g_bak:    db '  Backup', 0
h_g_sess:   db '  Session', 0

hc_insert:  db 'INSERT <id> <val> <tag> <text>', 0
hd_insert:  db 'insert a row (id must be >= 1)', 0
hc_sel1:    db 'SELECT <id>', 0
hd_sel1:    db 'show one row (full detail)', 0
hc_selall:  db 'SELECT *', 0
hd_selall:  db 'list every live row', 0
hc_update:  db 'UPDATE <id> <val> <tag> <text>', 0
hd_update:  db 'overwrite an existing row', 0
hc_find:    db 'FIND <substr>', 0
hd_find:    db 'search tag + text (substring)', 0
hc_range:   db 'RANGE <lo> <hi>', 0
hd_range:   db 'list rows with value in [lo,hi]', 0
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

hc_backup:  db 'BACKUP <file>', 0
hd_backup:  db 'snapshot this database to <file>', 0
hc_restore: db 'RESTORE <file>', 0
hd_restore: db 'reload this database from <file>', 0

hc_help:    db 'HELP', 0
hd_help:    db 'show this reference', 0
hc_exit:    db 'EXIT / QUIT', 0
hd_exit:    db 'leave asmdb', 0

; ---- SCHEMA / TYPES (static) ----
s_schema_title: db '  record layout - fixed 256 bytes per row', 0
s_schema_body:
    db 13, 10
    db '    offset  size  field    type', 13, 10
    db '    ------  ----  -------  -------------------------------------', 13, 10
    db '    0       8     id       u64   primary key', 13, 10
    db '    8       1     status   u8    0 empty / 1 live / 2 deleted', 13, 10
    db '    9       1     kind     u8    row-kind tag (reserved)', 13, 10
    db '    12      4     clen     u32   content byte length', 13, 10
    db '    16      8     created  i64   unix epoch ms (auto)', 13, 10
    db '    24      8     updated  i64   unix epoch ms (auto)', 13, 10
    db '    32      8     value    i64   numeric score / payload', 13, 10
    db '    40      40    tag      char[40]  category, NUL-padded', 13, 10
    db '    80      176   content  char[176] free text, NUL-padded', 13, 10
    db 13, 10, 0

s_types_title: db '  supported column types', 0
s_types_body:
    db 13, 10
    db '    type         bits  domain                      column', 13, 10
    db '    ----------   ----  --------------------------  -----------', 13, 10
    db '    u64            64  0 .. 1.8e19                 id (key)', 13, 10
    db '    i64            64  -9.2e18 .. 9.2e18           value', 13, 10
    db '    u32 / i32      32  narrowed integer            value, clen', 13, 10
    db '    u16 / i16      16  narrowed integer            value', 13, 10
    db '    u8  / i8        8  narrowed integer            kind, value', 13, 10
    db '    bool            8  0 = false / 1 = true        value', 13, 10
    db '    f64            64  IEEE-754 double (raw bits)  value', 13, 10
    db '    timestamp      64  unix epoch ms               created, updated', 13, 10
    db '    char[40]      320  fixed ASCII text, <= 40 B   tag', 13, 10
    db '    char[176]    1408  fixed ASCII text, <=176 B   content', 13, 10
    db 13, 10
    db '    A row carries a numeric value cell plus two auto timestamps, a', 13, 10
    db '    short tag (category / namespace) and a free-text content field.', 13, 10
    db '    Narrow ints, bool, f64 and timestamps all live in the 64-bit', 13, 10
    db '    value cell - asmdb keeps the raw bits and your app (or an agent', 13, 10
    db '    via the MCP server) picks the interpretation.', 13, 10
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
s_meta:     db '  nasm -f bin  .  no linker  .  no CRT  .  WAL durability  .  ~20 KB', 0
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
kw_find:       db 'FIND', 0
kw_range:      db 'RANGE', 0
kw_backup:     db 'BACKUP', 0
kw_restore:    db 'RESTORE', 0

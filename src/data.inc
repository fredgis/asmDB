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
g_bom_seen:    dq 0
g_linebuf:     dq 0
g_table:       dq 0
g_count:       dq 0
g_dat_handle:  dq 0
g_wal_handle:  dq 0
g_in_txn:      dq 0
g_auto_txn:    dq 0                  ; 1 = the open transaction is implicit
g_writer_ver:  dq 0                  ; engine version that last wrote the open db
g_upgrade:     dq 0                  ; 1 = --upgrade was passed on the command line
g_readonly:    dq 0                  ; 1 = --reader: no lock, no writes, snapshot reads
g_capbuf:      dq 0                  ; reader output buffer (replay without echoing twice)
g_cap_on:      dq 0
g_cap_len:     dq 0
g_cap_ovf:     dq 0
; ---- change data capture ----
g_cdc_handle:  dq 0
g_cdcname:     times 224 db 0
g_cdcbuf:      dq 0                  ; staging buffer for one frame
g_cdc_end:     dq 0                  ; append offset = validated length of .cdc
g_cdc_lastseq: dq 0                  ; highest commit_seq present in .cdc
g_seq:         dq 0                  ; last_commit_seq published (header +88)
g_reset_pend:  dq 0                  ; header +96
g_reset_seq:   dq 0                  ; header +104
g_bulk_kind:   dq 0                  ; whole-table operation in flight
g_bulk_src:    times 224 db 0        ; its source file, for RESTORE
g_txn_reset:   dq 0                  ; this transaction replaced the whole table
g_lineage_lo:  dq 0                  ; identity shared by <db>.dat and <db>.cdc
g_lineage_hi:  dq 0
g_cdc_base:    dq 0                  ; this log's frames start at base+1
g_cdc_legacy:  dq 0                  ; 1 = headerless log written before 1.1
                align 8
g_cdch_buf:    times CDCH_SIZE db 0
g_undo:        dq 0
g_undo_n:      dq 0
g_count_snap:  dq 0
g_walbuf:      dq 0
g_color:       dq 0
; ---- machine-readable output (FORMAT / PAGE) ----
g_fmt_tsv:     dq 0                  ; 1 = emit R-prefixed rows instead of a table
g_tsvbuf:      dq 0                  ; one rendered row, written in a single call
g_page_limit:  dq 0                  ; 0 = unlimited
g_page_offset: dq 0
g_list_skip:   dq 0                  ; page cursor, reset per listing command
g_list_n:      dq 0                  ; rows emitted by the current listing
g_vfy_n:       dq 0                  ; problems found by the last VERIFY
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
g_tmpname:     times 240 db 0        ; <backup>.part, renamed into place on success
g_chunkmap:    times 1024 db 0        ; which region chunks held data before a rewrite
g_idbuf:       times 16 db 0
g_idbuf2:      times 16 db 0
g_tablename:   times 64 db 0
g_argtable:    times 64 db 0
g_finddata:    times FIND_STRUCT db 0
g_hdr_read:    times HDR_SIZE db 0
                align 8
g_crctab:      times 256 dd 0        ; reflected CRC-32 (IEEE) table, built at startup
%ifdef FAULT_INJECT
g_fail_after:  dq FAULT_INJECT       ; test-only: fail the Nth write_at (see db.inc)
%endif

; --------------------------- on-disk header ---------------------------------
                align 8
g_hdr:
    db 'ASMDB', 0, 0, 0              ; +0  magic (8 bytes)
    dd DB_VERSION                    ; +8
    dd REC_SIZE                      ; +12
    dq CAPACITY                      ; +16
    dq 0                             ; +24 live count (rewritten at runtime)
    times HDR_ENGINE-32 db 0         ; +32 table name (rewritten at runtime)
    dd ENGINE_VERSION                ; +80 engine that last wrote this file
    dd 0                             ; +84 reserved
    dq 0                             ; +88 last_commit_seq  (CDC watermark)
    dq 0                             ; +96 reset_pending
    dq 0                             ; +104 reset_pending_seq
    times HDR_SIZE-112 db 0          ; pad to 512

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
wal_magic:     db 'ASMWAL01'         ; legacy frame (no checksum) - still replayed
wal_magic2:    db 'ASMWAL02'         ; adds the commit marker checksum
wal_magic4:    db 'ASMWAL04'         ; adds the database lineage
wal_magic3:    db 'ASMWAL03'         ; adds commit_seq + flags for change capture
wal_commit:    db 'COMMIT01'
cdc_magic:     db 'ASMCDC01'
cdc_trailer:   db 'CDCEND01'
cdch_magic:    db 'ASMCDCH1'
cdch_trailer:  db 'CDCHEND1'

s_prompt:      db 'asmdb> ', 0
s_unknown:     db '[ERR] unknown command - type HELP', 13, 10, 0
s_ok_ins:      db '[ OK ] 1 row inserted', 13, 10, 0
s_ok_upd:      db '[ OK ] 1 row updated', 13, 10, 0
s_ok_del:      db '[ OK ] 1 row deleted', 13, 10, 0
s_ok_trunc:    db '[ OK ] table truncated - ', 0
s_trunc_post:  db ' row(s) removed', 13, 10, 0
s_err_dup:     db '[ERR] key already exists', 13, 10, 0
s_err_nf:      db '[ERR] key not found', 13, 10, 0
s_err_field:   db '[ERR] tag exceeds 39 bytes or content exceeds 175 bytes - nothing stored', 13, 10, 0
s_err_full:    db '[ERR] table full', 13, 10, 0
s_err_syntax:  db '[ERR] syntax error - type HELP', 13, 10, 0
s_err_open:    db '[ERR] cannot open database file', 13, 10, 0
s_err_lock:    db '[ERR] database is locked by another process (single-writer)', 13, 10, 0
s_err_check:   db '[ERR] constraint: id must be >= 1 (0 is reserved)', 13, 10, 0
s_err_mem:     db '[ERR] out of memory', 13, 10, 0
s_err_map:     db '[ERR] cannot map the database file into memory', 13, 10, 0
s_count_pre:   db '[ OK ] ', 0
s_count_post:  db ' row(s)', 13, 10, 0
s_find_none:   db '[ OK ] no matching rows', 13, 10, 0
s_range_none:  db '[ OK ] no rows in range', 13, 10, 0
s_rows_pre:    db '[ OK ] ', 0
s_rows_post:   db ' row(s)', 13, 10, 0
s_fmt_table:   db '[ OK ] format table', 13, 10, 0
s_fmt_tsv:     db '[ OK ] format tsv', 13, 10, 0
s_page_set:    db '[ OK ] paging set', 13, 10, 0
s_err_toolong: db '[ERR] line too long - command refused (max 511 bytes)', 13, 10, 0
s_vfy_status:  db '[ERR] verify: invalid status byte at slot ', 0
s_vfy_id:      db '[ERR] verify: live row with reserved id 0 at slot ', 0
s_vfy_clen:    db '[ERR] verify: content length out of range at slot ', 0
s_vfy_term:    db '[ERR] verify: unterminated text column at slot ', 0
s_vfy_reach:   db '[ERR] verify: row unreachable or duplicate key at slot ', 0
s_vfy_count:   db '[ERR] verify: live rows disagree with the header count: ', 0
s_vfy_vs:      db ' live vs ', 0
s_vfy_more:    db '[ERR] verify: further problems not listed', 13, 10, 0
s_vfy_ok:      db '[ OK ] verify: ', 0
s_vfy_ok_post: db ' row(s) checked, no problem found', 13, 10, 0
s_vfy_bad:     db '[ERR] verify: ', 0
s_vfy_bad_post: db ' problem(s) found', 13, 10, 0
s_part_suffix: db '.part', 0
s_err_bak_self: db '[ERR] that path IS one of the live database files - refused', 13, 10, 0
s_err_bak_rename: db '[ERR] backup written but could not be moved into place', 13, 10, 0
s_upg_nospace: db '[ERR] upgrade: no free slot for a source row - migration refused', 13, 10, 0
s_upg_lost:   db '[ERR] upgrade: migrated row count does not match the source: ', 0
s_err_readonly: db '[ERR] read-only session (--reader) - this command would modify the database', 13, 10, 0
s_bulk_resume: db '[ OK ] finishing a whole-table operation interrupted by a crash', 13, 10, 0
s_bulk_done:  db '[ OK ] table operation completed', 13, 10, 0
s_err_bulk_src: db '[ERR] cannot finish the interrupted RESTORE - snapshot unusable: ', 0
s_err_walown: db '[ERR] this write-ahead log belongs to a different database - refusing to open ', 0
s_walown_hint: db '      Move or delete the log if it is stale; restore the matching database if it is not.', 13, 10, 0
s_err_ro_open: db '[ERR] cannot open the database for reading', 13, 10, 0
s_err_ro_nofile: db '[ERR] no such database - a reader never creates one', 13, 10, 0
s_snap_moved: db '[ERR] the database changed while this result was being written - it mixes two states, run it again', 13, 10, 0
s_snap_busy:  db '[ERR] the database is changing too fast to read consistently - try again', 13, 10, 0
s_ok_backup:   db '[ OK ] backup written', 13, 10, 0
s_ok_restore:  db '[ OK ] database restored from backup', 13, 10, 0
s_err_bak_open: db '[ERR] cannot open backup file', 13, 10, 0
s_err_bak_magic:db '[ERR] not an asmdb backup (bad magic)', 13, 10, 0
s_err_bak_trunc:db '[ERR] backup is truncated or incompatible - nothing restored', 13, 10, 0
s_err_bak_write:db '[ERR] backup failed - write error, file is incomplete', 13, 10, 0
s_err_txn_busy: db '[ERR] finish the transaction first (COMMIT or ROLLBACK)', 13, 10, 0
s_err_io:       db '[ERR] I/O failure on a durable write - aborting to avoid an inconsistent database', 13, 10, 0
s_err_ioread:   db '[ERR] I/O failure while reading - aborting rather than serving partial data', 13, 10, 0
s_err_corrupt:  db '[ERR] database file is incomplete or corrupt - refusing to open ', 0
s_corrupt_hint: db '      The file was NOT modified. Move or remove it, or open another', 13, 10
                db '      database name: asmdb <name>', 13, 10, 0
s_err_format:   db '[ERR] incompatible database format - refusing to open ', 0
s_fmt_build:    db '      this build : version ', 0
s_fmt_file:     db '      that file  : version ', 0
s_fmt_rec:      db ', record ', 0
s_fmt_cap:      db ' B, capacity ', 0
s_fmt_slots:    db ' slots', 13, 10, 0
s_fmt_hint:     db '      Written by a different build of asmdb. Open another database name', 13, 10
                db '      (asmdb <name>), or move/remove the file if you no longer need it.', 13, 10, 0
s_nl:           db 13, 10, 0
s_ver_pre:      db '  asmdb ', 0
s_ver_pre10:    db '   (stable: the on-disk format is versioned and migratable)', 13, 10, 0
s_ver_fmt:      db '  storage format : ', 0
s_ver_rec:      db '  record size    : ', 0
s_ver_recb:     db ' bytes', 13, 10, 0
s_ver_cap:      db '  capacity       : ', 0
s_ver_slots:    db ' slots', 13, 10, 0
s_ver_plat:     db '  platform       : ', 0
%ifdef LINUX
s_ver_platname: db 'Linux ELF64 (raw syscalls)', 13, 10, 0
%else
s_ver_platname: db 'Windows PE64 (kernel32)', 13, 10, 0
%endif
s_ver_writer:   db '  written by     : engine ', 0
s_ver_older:    db '  written by     : an engine older than 0.9 (no stamp)', 13, 10, 0
s_verdot:       db '.', 0
s_bnr_ver:      db '  .  v', 0
s_flag_upgrade: db '--upgrade', 0
s_flag_reader: db '--reader', 0
s_upg_suffix:   db '.upgraded.dat', 0
s_upg_head:     db '  asmdb upgrade', 13, 10, 0
s_upg_src:      db '  source   : ', 0
s_upg_srcfmt:   db '  found    : format ', 0
s_upg_curfmt:   db '  this build expects format ', 0
s_upg_recs:     db ', record ', 0
s_upg_caps:     db ' B, capacity ', 0
s_upg_slots:    db ' slots', 13, 10, 0
s_upg_already:  db '[ OK ] already in the current format - nothing to do', 13, 10, 0
s_upg_cant:     db '[ERR] no automatic migration from that format in this build', 13, 10, 0
s_upg_nosrc:    db '[ERR] no database file to upgrade', 13, 10, 0
s_upg_short:    db '[ERR] source ends before the region its header describes - refusing to', 13, 10
                db '      migrate a partial database. The original was NOT modified.', 13, 10, 0
s_upg_dest:     db '  writing   : ', 0
s_upg_ok:       db '[ OK ] migrated ', 0
s_upg_rows:     db ' row(s)', 13, 10, 0
s_upg_swap:     db '  The original was NOT modified. Check the new file, then swap them:', 13, 10
                db '    rename <db>.dat to <db>.dat.old, then <db>.upgraded.dat to <db>.dat', 13, 10, 0
s_err_walcrc:   db '[ERR] write-ahead log is corrupt (checksum mismatch) - refusing to open ', 0
s_err_walbad:   db '[ERR] write-ahead log holds a committed transaction this build cannot apply - refusing to open ', 0
s_err_cdc_open: db '[ERR] cannot open the change log (.cdc)', 13, 10, 0
s_err_cdc_crc:  db '[ERR] change log frame fails its checksum - refusing to open ', 0
s_err_cdc_seq:  db '[ERR] change log sequence is not strictly increasing - refusing to open ', 0
s_err_cdc_frame:db '[ERR] change log holds an unreadable frame - refusing to open ', 0
s_err_cdc_tail: db '[ERR] change log frame is complete but its trailer is damaged - refusing to open ', 0
s_err_cdc_gap:  db '[ERR] change log sequence would skip or rewind - refusing to open ', 0
s_err_cdc_align:db '[ERR] change log and database disagree on the last committed sequence - refusing to open ', 0
s_err_cdc_hdr:  db '[ERR] change log header is damaged or from another format - refusing to open ', 0
s_err_cdc_lineage: db '[ERR] change log belongs to a different database - refusing to open ', 0
s_cdc_hint:     db '      The log was NOT modified. Inspect it with tests/cdc_dump.py, or move it', 13, 10
                db '      aside and re-snapshot the consumer from a fresh BACKUP.', 13, 10, 0
                align 8
g_cdc_hdrbuf:   times CDC_HDR_SIZE db 0
s_dotcdc:       db '.cdc', 0
s_walcrc_hint:  db '      A committed transaction cannot be replayed safely from a damaged log.', 13, 10
                db '      Restore from a backup, or delete the .wal file to discard that', 13, 10
                db '      transaction and open the database as it was at the last checkpoint.', 13, 10, 0
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
hc_trunc:   db 'TRUNCATE', 0
hd_trunc:   db 'remove every row (respects transactions)', 0
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
hc_version: db 'VERSION', 0
hd_version: db 'engine build, storage format, writer stamp', 0
hc_bench:   db 'BENCH <n>', 0
hd_bench:   db 'insert n synthetic rows, report rows/sec', 0

hc_backup:  db 'BACKUP <file>', 0
hd_backup:  db 'snapshot this database to <file>', 0
hc_restore: db 'RESTORE <file>', 0
hd_restore: db 'reload this database from <file>', 0
hc_verify:  db 'VERIFY', 0
hd_verify:  db 'full logical integrity scan of the store', 0

hc_format:  db 'FORMAT TABLE|TSV', 0
hd_format:  db 'human table, or machine-readable rows', 0
hc_page:    db 'PAGE <limit> <offset>', 0
hd_page:    db 'bound SELECT * / FIND / RANGE', 0
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
s_meta:     db '  nasm -f bin  .  no linker  .  no CRT  .  WAL-durable  .  Windows + Linux', 0
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
kw_truncate:   db 'TRUNCATE', 0
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
kw_version:    db 'VERSION', 0
kw_types:      db 'TYPES', 0
kw_bench:      db 'BENCH', 0
kw_find:       db 'FIND', 0
kw_range:      db 'RANGE', 0
kw_backup:     db 'BACKUP', 0
kw_restore:    db 'RESTORE', 0
kw_format:     db 'FORMAT', 0
kw_page:       db 'PAGE', 0
kw_tsv:        db 'TSV', 0
kw_table:      db 'TABLE', 0
kw_verify:     db 'VERIFY', 0

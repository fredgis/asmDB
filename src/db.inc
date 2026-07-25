; -----------------------------------------------------------------------------
; src/db.inc - on-disk persistence for asmdb.dat (header + slot region).
; Autocommit durability: every mutation writes the slot + header and flushes.
; -----------------------------------------------------------------------------

; strcpy_z(rdi = dest, rsi = src) -> rdi points at the terminating NUL written
strcpy_z:
    mov  al, [rsi]
    mov  [rdi], al
    test al, al
    je   .done
    inc  rsi
    inc  rdi
    jmp  strcpy_z
.done:
    ret

; strcpy_n(rdi = dest, rsi = src, rcx = count) - copy src until NUL, zero-pad to
; exactly count bytes. Clobbers rax, r8, r10.
strcpy_n:
    xor  r8, r8
    xor  r10b, r10b
.l:
    cmp  r8, rcx
    jae  .d
    test r10b, r10b
    jnz  .pad
    mov  al, [rsi+r8]
    test al, al
    jz   .startpad
    mov  [rdi+r8], al
    inc  r8
    jmp  .l
.startpad:
    mov  r10b, 1
.pad:
    mov  byte [rdi+r8], 0
    inc  r8
    jmp  .l
.d:
    ret

; read_at(rcx = offset, rdx = buf, r8 = len) -> rax = total bytes read, or -1
;   Loops over os_pread until the whole range is read or EOF stops it. A single
;   ReadFile/pread is NOT guaranteed to transfer a large request in one call
;   (the 1 GiB slot region routinely comes back short), so relying on one call
;   silently dropped records whose hash slot lived past the prefix.
;   A hard I/O error returns -1 so callers can tell it apart from a short read
;   caused by a genuinely truncated file.
read_at:
    push rbp
    mov  rbp, rsp
    sub  rsp, 0x40
    mov  [rbp-8], rbx                ; total transferred
    mov  [rbp-16], rsi               ; current file offset
    mov  [rbp-24], rdi               ; current buffer pointer
    mov  [rbp-32], r12               ; bytes remaining
    xor  rbx, rbx
    mov  rsi, rcx                    ; offset
    mov  rdi, rdx                    ; buf
    mov  r12, r8                     ; remaining
.loop:
    test r12, r12
    jz   .done
    mov  rcx, [rel g_dat_handle]
    mov  rdx, rsi                    ; offset
    mov  r8, rdi                     ; buf
    mov  r9, r12                     ; len
    call os_pread
    test rax, rax
    js   .fail                       ; hard I/O error
    jz   .done                       ; EOF - report the short count
    add  rbx, rax
    add  rsi, rax
    add  rdi, rax
    sub  r12, rax
    jmp  .loop
.fail:
    mov  rbx, -1
.done:
    mov  rax, rbx
    mov  r12, [rbp-32]
    mov  rdi, [rbp-24]
    mov  rsi, [rbp-16]
    mov  rbx, [rbp-8]
    mov  rsp, rbp
    pop  rbp
    ret

; write_at(rcx = offset, rdx = buf, r8 = len) -> rax = total bytes written, or -1
;   Loops over os_pwrite for the same short-transfer reason as read_at. An error
;   OR a zero-byte write (no forward progress, e.g. a full disk) returns -1: a
;   partial write must never be reported as success.
write_at:
    push rbp
    mov  rbp, rsp
    sub  rsp, 0x40
    mov  [rbp-8], rbx                ; total transferred
    mov  [rbp-16], rsi               ; current file offset
    mov  [rbp-24], rdi               ; current buffer pointer
    mov  [rbp-32], r12               ; bytes remaining
%ifdef FAULT_INJECT
    ; Test-only: fail the FAULT_INJECT'th call, simulating ENOSPC / a dying
    ; disk so the io_fatal path can actually be exercised. Assembled ONLY with
    ; -dFAULT_INJECT=<n>; the shipping binary contains none of this.
    cmp  qword [rel g_fail_after], 0
    jle  .inject_skip
    dec  qword [rel g_fail_after]
    jnz  .inject_skip
    mov  rbx, -1
    jmp  .done
.inject_skip:
%endif
    xor  rbx, rbx
    mov  rsi, rcx                    ; offset
    mov  rdi, rdx                    ; buf
    mov  r12, r8                     ; remaining
.loop:
    test r12, r12
    jz   .done
    mov  rcx, [rel g_dat_handle]
    mov  rdx, rsi                    ; offset
    mov  r8, rdi                     ; buf
    mov  r9, r12                     ; len
    call os_pwrite
    cmp  rax, 0
    jle  .fail                       ; error, or no progress -> short write
    add  rbx, rax
    add  rsi, rax
    add  rdi, rax
    sub  r12, rax
    jmp  .loop
.fail:
    mov  rbx, -1
.done:
    mov  rax, rbx
    mov  r12, [rbp-32]
    mov  rdi, [rbp-24]
    mov  rsi, [rbp-16]
    mov  rbx, [rbp-8]
    mov  rsp, rbp
    pop  rbp
    ret

; io_fatal() - a durable write failed. Memory and disk may now disagree, so the
;   only safe action is to report it loudly and stop, rather than keep printing
;   [ OK ] over a database we can no longer guarantee. Never returns.
;
;   Reached by `jcc`/`jmp`, never by `call`, so the incoming rsp is NOT at the
;   usual post-call alignment. Normalize it explicitly before calling anything:
;   `and rsp,-16` then a 32-byte shadow area leaves rsp 16-byte aligned at the
;   call, as the Win64 ABI requires. (Nothing needs the old stack: we exit.)
io_fatal:
    and  rsp, -16
    sub  rsp, 0x20
    lea  rcx, [rel s_err_io]
    call puts
    mov  ecx, 1
    call os_exit

; io_fatal_read() - same, for a failed READ. Nothing durable is at risk here,
;   but the in-memory image would be incomplete, so we stop instead of serving
;   rows we only partially loaded. Never returns.
io_fatal_read:
    and  rsp, -16
    sub  rsp, 0x20
    lea  rcx, [rel s_err_ioread]
    call puts
    mov  ecx, 1
    call os_exit

; db_flush() - fsync the data file; aborts if the flush fails
db_flush:
    push rbp
    mov  rbp, rsp
    sub  rsp, 0x30
    mov  rcx, [rel g_dat_handle]
    call os_fsync
    test rax, rax
    jnz  io_fatal
    mov  rsp, rbp
    pop  rbp
    ret

; db_write_header() - refresh count field then persist the 512-byte header
db_write_header:
    push rbp
    mov  rbp, rsp
    sub  rsp, 0x30
    mov  [rbp-8], rsi
    mov  [rbp-16], rdi
    mov  rax, [rel g_count]
    mov  [rel g_hdr+24], rax
    mov  rax, [rel g_seq]
    mov  [rel g_hdr+HDR_SEQ], rax    ; CDC watermark
    mov  rax, [rel g_reset_pend]
    mov  [rel g_hdr+HDR_RESETP], rax
    mov  rax, [rel g_reset_seq]
    mov  [rel g_hdr+HDR_RESETS], rax
    mov  rax, [rel g_lineage_lo]
    mov  [rel g_hdr+HDR_LINEAGE], rax
    mov  rax, [rel g_lineage_hi]
    mov  [rel g_hdr+HDR_LINEAGE+8], rax
    lea  rdi, [rel g_hdr+HDR_TABLE]
    lea  rsi, [rel g_tablename]
    mov  rcx, TABLE_MAX
    call strcpy_n
    xor  rcx, rcx
    lea  rdx, [rel g_hdr]
    mov  r8, HDR_SIZE
    call write_at
    cmp  rax, HDR_SIZE
    jne  io_fatal
    mov  rdi, [rbp-16]
    mov  rsi, [rbp-8]
    mov  rsp, rbp
    pop  rbp
    ret

; db_write_slot(rcx = slot ptr) - write one 256-byte record to disk
db_write_slot:
    push rbp
    mov  rbp, rsp
    sub  rsp, 0x30
    mov  [rbp-8], rcx
    call store_slot_index            ; rax = index (rcx = slot ptr)
    shl  rax, REC_SHIFT
    add  rax, HDR_SIZE
    mov  rcx, rax
    mov  rdx, [rbp-8]
    mov  r8, REC_SIZE
    call write_at
    cmp  rax, REC_SIZE
    jne  io_fatal
    mov  rsp, rbp
    pop  rbp
    ret

; NOTE: there is deliberately no "write the slot, then the header, then fsync"
; helper any more. That sequence was the old autocommit path and it was not
; crash-atomic: a crash between the two writes left the record on disk with a
; stale count (a row present but uncounted, or deleted but still counted), and
; nothing ordered the two writes anyway. Single-statement mutations now go
; through the same WAL commit as explicit transactions - see auto_begin /
; auto_commit / txn_flush in wal.inc.

; scan_upgrade(rsi = command line) - set g_upgrade if "--upgrade" appears
scan_upgrade:
    push rbp
    mov  rbp, rsp
    sub  rsp, 0x30
    mov  [rbp-8], rbx
    mov  [rbp-16], rsi
    mov  rbx, rsi
.outer:
    cmp  byte [rbx], 0
    je   .done
    lea  rsi, [rel s_flag_upgrade]
    mov  rcx, rbx
.inner:
    mov  dl, [rsi]
    test dl, dl
    jz   .found
    mov  al, [rcx]
    cmp  al, dl
    jne  .next
    inc  rsi
    inc  rcx
    jmp  .inner
.next:
    inc  rbx
    jmp  .outer
.found:
    mov  qword [rel g_upgrade], 1
.done:
    mov  rsi, [rbp-16]
    mov  rbx, [rbp-8]
    mov  rsp, rbp
    pop  rbp
    ret

; db_init_names() - derive g_datname / g_walname from the command-line arg
db_init_names:
    push rbp
    mov  rbp, rsp
    sub  rsp, 0x40
    mov  [rbp-16], rsi
    mov  [rbp-24], rdi
    call os_cmdline
    mov  rsi, rax
    call scan_upgrade                ; sets g_upgrade if --upgrade is present
    ; skip program name (handle quoted path)
    mov  al, [rsi]
    cmp  al, '"'
    jne  .noq
    inc  rsi
.q:
    mov  al, [rsi]
    test al, al
    je   .default
    inc  rsi
    cmp  al, '"'
    jne  .q
    jmp  .afterprog
.noq:
    mov  al, [rsi]
    test al, al
    je   .default
    cmp  al, ' '
    je   .afterprog
    inc  rsi
    jmp  .noq
.afterprog:
    call skip_spaces_rsi
    mov  al, [rsi]
    test al, al
    je   .default
    cmp  al, '"'
    jne  .copy
    inc  rsi
.copy:
    lea  rdi, [rel g_base]
    xor  rcx, rcx
.cl:
    mov  al, [rsi]
    test al, al
    je   .cend
    cmp  al, ' '
    je   .cend
    cmp  al, '"'
    je   .cend
    cmp  rcx, 200
    jae  .cend
    mov  [rdi+rcx], al
    inc  rsi
    inc  rcx
    jmp  .cl
.cend:
    mov  byte [rdi+rcx], 0
    test rcx, rcx
    jz   .default
    cmp  byte [rdi], '-'             ; a flag, not a database name
    je   .default
    ; optional 2nd arg = table name
    mov  al, [rsi]
    cmp  al, '"'
    jne  .tsp
    inc  rsi
.tsp:
    call skip_spaces_rsi
    mov  al, [rsi]
    test al, al
    je   .build
    cmp  al, '"'
    jne  .tcopy
    inc  rsi
.tcopy:
    lea  rdi, [rel g_argtable]
    xor  rcx, rcx
.tl:
    mov  al, [rsi]
    test al, al
    je   .tend
    cmp  al, ' '
    je   .tend
    cmp  al, '"'
    je   .tend
    cmp  rcx, TABLE_MAX-1
    jae  .tend
    mov  [rdi+rcx], al
    inc  rsi
    inc  rcx
    jmp  .tl
.tend:
    mov  byte [rdi+rcx], 0
    test rcx, rcx
    jz   .build
    cmp  byte [rdi], '-'             ; a flag, not a table name
    je   .build
    mov  dword [rel g_have_argtable], 1
    jmp  .build
.default:
    lea  rdi, [rel g_base]
    lea  rsi, [rel s_defbase]
    call strcpy_z
.build:
    lea  rdi, [rel g_datname]
    lea  rsi, [rel g_base]
    call strcpy_z
    lea  rsi, [rel s_dotdat]
    call strcpy_z
    lea  rdi, [rel g_walname]
    lea  rsi, [rel g_base]
    call strcpy_z
    lea  rsi, [rel s_dotwal]
    call strcpy_z
    lea  rdi, [rel g_cdcname]
    lea  rsi, [rel g_base]
    call strcpy_z
    lea  rsi, [rel s_dotcdc]
    call strcpy_z
    mov  rdi, [rbp-24]
    mov  rsi, [rbp-16]
    mov  rsp, rbp
    pop  rbp
    ret

; db_open() - open g_datname and load it, or initialize a genuinely new file.
;
; Classification is strict, because silently "recreating" a database whose
; header we failed to understand destroys real data:
;   0 bytes                      -> brand-new database (create)
;   1 .. HDR_SIZE-1 bytes        -> partially written header  -> refuse
;   bad magic                    -> not an asmdb file         -> refuse
;   version/REC_SIZE/CAPACITY    -> incompatible build        -> refuse
;   count > CAPACITY             -> corrupt header            -> refuse
;   slot region shorter than     -> truncated data region     -> refuse
;   CAPACITY*REC_SIZE
; The WAL is only opened and replayed once the header is known good, so a
; corrupt .dat is never written to.
db_open:
    push rbp
    mov  rbp, rsp
    sub  rsp, 0x50
    lea  rcx, [rel g_datname]
    call os_open
    mov  [rel g_dat_handle], rax
    cmp  rax, INVALID_HANDLE
    je   .openfail
    ; ---- read and classify the header ----
    xor  rcx, rcx
    lea  rdx, [rel g_hdr_read]
    mov  r8, HDR_SIZE
    call read_at
    test rax, rax
    js   io_fatal_read               ; hard I/O error
    jz   .newfile                    ; empty file -> a genuinely new database
    cmp  rax, HDR_SIZE
    jb   .corrupt                    ; non-empty but incomplete header
    ; magic: compare all 8 bytes against the in-memory header template
    mov  rax, [rel g_hdr]
    cmp  rax, [rel g_hdr_read]
    jne  .corrupt
    ; on-disk layout must match this build exactly
    cmp  dword [rel g_hdr_read+8], DB_VERSION
    jne  .format
    cmp  dword [rel g_hdr_read+12], REC_SIZE
    jne  .format
    mov  rax, CAPACITY
    cmp  [rel g_hdr_read+16], rax
    jne  .format
    ; live count must be inside the table
    mov  rax, [rel g_hdr_read+24]
    mov  rdx, CAPACITY
    cmp  rax, rdx
    ja   .corrupt
    mov  [rel g_count], rax
    ; CDC metadata (zero on a v1 file that --upgrade has not touched yet)
    mov  rax, [rel g_hdr_read+HDR_SEQ]
    mov  [rel g_seq], rax
    mov  rax, [rel g_hdr_read+HDR_RESETP]
    mov  [rel g_reset_pend], rax
    mov  rax, [rel g_hdr_read+HDR_RESETS]
    mov  [rel g_reset_seq], rax
    ; reset state must be self-consistent: a pending reset is the sequence that
    ; comes immediately next, and no pending reset means no pending sequence
    mov  rax, [rel g_reset_pend]
    cmp  rax, 1
    ja   .corrupt
    test rax, rax
    jnz  .pending
    cmp  qword [rel g_reset_seq], 0
    jne  .corrupt
    jmp  .resetok
.pending:
    mov  rax, [rel g_seq]
    inc  rax
    cmp  rax, [rel g_reset_seq]
    jne  .corrupt
.resetok:
    ; lineage ties this file to its change log; older files have none yet
    mov  rax, [rel g_hdr_read+HDR_LINEAGE]
    mov  [rel g_lineage_lo], rax
    mov  rax, [rel g_hdr_read+HDR_LINEAGE+8]
    mov  [rel g_lineage_hi], rax
    mov  rax, [rel g_lineage_lo]
    or   rax, [rel g_lineage_hi]
    jnz  .havelin
    call cdc_lineage_make            ; adopt one for a pre-1.1 database
.havelin:
    ; remember which engine last wrote this file (0 = predates the stamp)
    mov  eax, [rel g_hdr_read+HDR_ENGINE]
    mov  [rel g_writer_ver], rax
    ; resolve table name: CLI arg overrides, else header, else base
    cmp  dword [rel g_have_argtable], 0
    jne  .name_arg
    lea  rsi, [rel g_hdr_read+HDR_TABLE]
    mov  al, [rsi]
    test al, al
    jnz  .name_copy
    lea  rsi, [rel g_base]
.name_copy:
    lea  rdi, [rel g_tablename]
    mov  rcx, TABLE_MAX
    call strcpy_n
    jmp  .name_done
.name_arg:
    lea  rsi, [rel g_argtable]
    lea  rdi, [rel g_tablename]
    mov  rcx, TABLE_MAX
    call strcpy_n
    call db_write_header
    call db_flush
.name_done:
    ; header is trustworthy: open the change log, then replay a committed WAL
    ; (which may still owe the log a frame), then load the slots
    call cdc_open
    call wal_open
    call wal_recover
    call cdc_recover_reset           ; finish a RESET a crash cut short
    call cdc_check_aligned           ; log and header must now agree
    jmp  .load
.newfile:
    ; brand-new file: mark it sparse so unwritten slots cost no disk, then set
    ; the logical size to the full region without allocating/zeroing 1 GiB.
    mov  rcx, [rel g_dat_handle]
    call os_set_sparse
    mov  qword [rel g_count], 0
    mov  qword [rel g_writer_ver], ENGINE_VERSION   ; we are creating it
    call cdc_lineage_make            ; a brand-new database, a brand-new lineage
    cmp  dword [rel g_have_argtable], 0
    jne  .nf_arg
    lea  rsi, [rel g_base]
    jmp  .nf_copy
.nf_arg:
    lea  rsi, [rel g_argtable]
.nf_copy:
    lea  rdi, [rel g_tablename]
    mov  rcx, TABLE_MAX
    call strcpy_n
    call db_write_header
    ; extend the (sparse) file to header + full slot region; holes read as zero
    mov  rcx, [rel g_dat_handle]
    mov  rdx, HDR_SIZE + CAPACITY*REC_SIZE
    call os_truncate
    test rax, rax
    jnz  io_fatal
    call db_flush
    call cdc_open
    call wal_open
    call wal_recover                 ; a committed WAL may predate this file
    call cdc_recover_reset
    call cdc_check_aligned
.load:
    ; Map the slot region COPY-ON-WRITE instead of committing 1 GiB and reading
    ; it. Reads fault in on demand (a sparse file's holes cost nothing), writes
    ; go to private pages that never reach the file - so the durability model is
    ; untouched: the .dat still changes only through write_at/fsync. This is
    ; also why the mapping is created AFTER wal_recover: recovery writes to the
    ; file directly, and a private mapping is not guaranteed to observe writes
    ; made to the file after it was created.
    ;
    ; The file must physically contain the whole region first. Checking the size
    ; explicitly also replaces the old "read 1 GiB and see if it came up short"
    ; truncation test - and CreateFileMapping would otherwise silently grow a
    ; truncated file to fit.
    mov  rcx, [rel g_dat_handle]
    call os_filesize
    test rax, rax
    js   io_fatal_read
    mov  rdx, HDR_SIZE + CAPACITY*REC_SIZE
    cmp  rax, rdx
    jb   .corrupt                    ; data region truncated
    mov  rcx, [rel g_dat_handle]
    mov  rdx, HDR_SIZE + CAPACITY*REC_SIZE
    call os_map_cow
    test rax, rax
    jz   .mapfail
    add  rax, HDR_SIZE               ; slot region starts after the header
    mov  [rel g_table], rax
.done:
    mov  rsp, rbp
    pop  rbp
    ret
.mapfail:
    lea  rcx, [rel s_err_map]
    call puts
    mov  ecx, 1
    call os_exit
.corrupt:
    lea  rcx, [rel s_err_corrupt]
    call puts
    lea  rcx, [rel g_datname]
    call puts
    lea  rcx, [rel s_nl]
    call puts
    lea  rcx, [rel s_corrupt_hint]
    call puts
    mov  ecx, 1
    call os_exit
.format:
    ; Say exactly what mismatched: a bare "incompatible format" leaves the user
    ; with no way to tell which build wrote the file, or what to do about it.
    lea  rcx, [rel s_err_format]
    call puts
    lea  rcx, [rel g_datname]
    call puts
    lea  rcx, [rel s_nl]
    call puts
    lea  rcx, [rel s_fmt_build]
    call puts
    mov  ecx, DB_VERSION
    call put_u64
    lea  rcx, [rel s_fmt_rec]
    call puts
    mov  ecx, REC_SIZE
    call put_u64
    lea  rcx, [rel s_fmt_cap]
    call puts
    mov  ecx, CAPACITY
    call put_u64
    lea  rcx, [rel s_fmt_slots]
    call puts
    lea  rcx, [rel s_fmt_file]
    call puts
    mov  ecx, [rel g_hdr_read+8]     ; version   (u32, zero-extended)
    call put_u64
    lea  rcx, [rel s_fmt_rec]
    call puts
    mov  ecx, [rel g_hdr_read+12]    ; rec_size  (u32)
    call put_u64
    lea  rcx, [rel s_fmt_cap]
    call puts
    mov  rcx, [rel g_hdr_read+16]    ; capacity  (u64)
    call put_u64
    lea  rcx, [rel s_fmt_slots]
    call puts
    lea  rcx, [rel s_fmt_hint]
    call puts
    mov  ecx, 1
    call os_exit
.openfail:
    cmp  qword [rel g_open_locked], 0
    je   .openfail_generic
    lea  rcx, [rel s_err_lock]
    call puts
    mov  ecx, 1
    call os_exit
.openfail_generic:
    lea  rcx, [rel s_err_open]
    call puts
    mov  ecx, 1
    call os_exit

; db_upgrade() - migrate <db>.dat into <db>.upgraded.dat under the format this
;   build expects, then report. The source file is opened READ-ONLY and is never
;   modified: the operator inspects the result and swaps the files. That is the
;   whole safety story - an upgrade that goes wrong costs nothing.
;
;   Today the only migratable difference is a changed CAPACITY (the records
;   themselves are unchanged, but they hash to different slots, so every live
;   row is re-inserted). A different DB_VERSION or REC_SIZE has no migration
;   path in this build and is refused rather than guessed at.
db_upgrade:
    push rbp
    mov  rbp, rsp
    sub  rsp, 0x90
    mov  [rbp-8], rbx
    mov  [rbp-16], rsi
    mov  [rbp-24], rdi
    mov  [rbp-32], r12
    mov  [rbp-40], r13
    mov  [rbp-48], r14
    lea  rcx, [rel s_upg_head]
    call puts
    lea  rcx, [rel s_upg_src]
    call puts
    lea  rcx, [rel g_datname]
    call puts
    lea  rcx, [rel s_nl]
    call puts
    ; ---- open the source read-only ----
    lea  rcx, [rel g_datname]
    call os_open_read
    cmp  rax, INVALID_HANDLE
    je   .nosrc
    mov  r14, rax
    mov  rcx, r14
    xor  rdx, rdx
    lea  r8, [rel g_hdr_read]
    mov  r9, HDR_SIZE
    call os_pread
    cmp  rax, HDR_SIZE
    jne  .badsrc
    mov  rax, [rel g_hdr]
    cmp  rax, [rel g_hdr_read]       ; 8-byte magic
    jne  .badsrc
    ; ---- report what we found ----
    lea  rcx, [rel s_upg_srcfmt]
    call puts
    mov  ecx, [rel g_hdr_read+8]
    call put_u64
    lea  rcx, [rel s_upg_recs]
    call puts
    mov  ecx, [rel g_hdr_read+12]
    call put_u64
    lea  rcx, [rel s_upg_caps]
    call puts
    mov  rcx, [rel g_hdr_read+16]
    call put_u64
    lea  rcx, [rel s_upg_slots]
    call puts
    lea  rcx, [rel s_upg_curfmt]
    call puts
    mov  ecx, DB_VERSION
    call put_u64
    lea  rcx, [rel s_upg_recs]
    call puts
    mov  ecx, REC_SIZE
    call put_u64
    lea  rcx, [rel s_upg_caps]
    call puts
    mov  ecx, CAPACITY
    call put_u64
    lea  rcx, [rel s_upg_slots]
    call puts
    ; ---- classify ----
    cmp  dword [rel g_hdr_read+8], DB_VERSION
    ja   .cant                       ; written by a NEWER build - never guess
    cmp  dword [rel g_hdr_read+12], REC_SIZE
    jne  .cant                       ; a different record layout has no path
    mov  rax, CAPACITY
    cmp  [rel g_hdr_read+16], rax
    jne  .migrate
    cmp  dword [rel g_hdr_read+8], DB_VERSION
    je   .already                    ; same format and same capacity
.migrate:
    ; The CDC metadata is deliberately reset to zero: the migrated file is a new
    ; lineage, and any consumer of the old change log has to re-snapshot from it
    ; anyway.
    mov  qword [rel g_seq], 0
    mov  qword [rel g_reset_pend], 0
    mov  qword [rel g_reset_seq], 0
    mov  r13, [rel g_hdr_read+16]    ; old capacity
    mov  rax, [rel g_hdr_read+24]    ; live rows the source claims to hold
    mov  [rbp-88], rax
    ; ---- create the destination ----
    lea  rdi, [rel g_bakname]
    lea  rsi, [rel g_base]
    call strcpy_z
    lea  rsi, [rel s_upg_suffix]
    call strcpy_z
    lea  rcx, [rel s_upg_dest]
    call puts
    lea  rcx, [rel g_bakname]
    call puts
    lea  rcx, [rel s_nl]
    call puts
    lea  rcx, [rel g_bakname]
    call os_create_new               ; refuse to clobber an existing destination
    cmp  rax, INVALID_HANDLE
    je   .nodest
    mov  [rel g_dat_handle], rax
    mov  rcx, rax
    call os_set_sparse
    mov  rcx, [rel g_dat_handle]
    mov  rdx, HDR_SIZE + CAPACITY*REC_SIZE
    call os_truncate
    test rax, rax
    jnz  io_fatal
    ; keep the source's logical table name
    lea  rdi, [rel g_tablename]
    lea  rsi, [rel g_hdr_read+HDR_TABLE]
    mov  rcx, TABLE_MAX
    call strcpy_n
    mov  qword [rel g_count], 0
    call db_write_header
    ; map the destination as the live store and rehash into it
    mov  rcx, [rel g_dat_handle]
    mov  rdx, HDR_SIZE + CAPACITY*REC_SIZE
    call os_map_cow
    test rax, rax
    jz   .nodest
    add  rax, HDR_SIZE
    mov  [rel g_table], rax
    ; ---- stream the source region in WAL_BUF_SIZE chunks ----
    mov  rax, r13
    shl  rax, REC_SHIFT
    mov  [rbp-56], rax               ; source region length
    xor  r12, r12                    ; offset within it
.chunk:
    mov  rax, [rbp-56]
    cmp  r12, rax
    jae  .streamed
    mov  rbx, rax
    sub  rbx, r12
    mov  rax, WAL_BUF_SIZE
    cmp  rbx, rax
    jbe  .haveln
    mov  rbx, rax
.haveln:
    ; Fill the chunk completely before parsing it. A single pread is allowed to
    ; return fewer bytes than asked for; the previous code advanced by that raw
    ; count, so a short read both dropped the trailing partial record AND
    ; restarted the next chunk off a record boundary - every record after it
    ; was then reinterpreted from the wrong offset.
    mov  qword [rbp-80], 0           ; bytes filled in this chunk
.fill:
    mov  rax, [rbp-80]
    cmp  rax, rbx
    jae  .filled
    mov  rcx, r14
    mov  rdx, r12
    add  rdx, HDR_SIZE
    add  rdx, rax
    mov  r8, [rel g_walbuf]
    add  r8, rax
    mov  r9, rbx
    sub  r9, rax
    call os_pread
    test rax, rax
    js   io_fatal_read               ; a read error must never look like success
    jz   .short_src                  ; EOF inside the region the header declares
    add  [rbp-80], rax
    jmp  .fill
.filled:
    xor  rsi, rsi                    ; offset inside the chunk
.rec:
    mov  rax, rsi
    add  rax, REC_SIZE
    cmp  rax, rbx
    ja   .chunkdone
    mov  rdi, [rel g_walbuf]
    add  rdi, rsi
    cmp  byte [rdi+REC_STATUS], ST_OCCUPIED
    jne  .recnext
    mov  [rbp-64], rdi
    mov  rcx, [rdi+REC_ID]
    call store_locate                ; rdx = insertable slot in the NEW table
    test rdx, rdx
    jz   .nospace                    ; refuse: a dropped row is a lost row
    mov  [rbp-72], rsi
    mov  rsi, [rbp-64]
    mov  rdi, rdx
    mov  rcx, REC_SIZE
    rep  movsb
    mov  rsi, [rbp-72]
    inc  qword [rel g_count]
.recnext:
    add  rsi, REC_SIZE
    jmp  .rec
.chunkdone:
    add  r12, rbx
    jmp  .chunk
.streamed:
    ; Every live row the source advertised must be present in the rebuilt table.
    ; Migrating fewer rows than the source header declares means the source was
    ; inconsistent or a record was lost on the way, and either way the result
    ; must not be presented as a successful migration.
    mov  rax, [rel g_count]
    cmp  rax, [rbp-88]
    jne  .lostrows
    ; ---- persist the rebuilt table ----
    mov  rcx, HDR_SIZE
    mov  rdx, [rel g_table]
    mov  r8, CAPACITY*REC_SIZE
    call write_at
    mov  rdx, CAPACITY*REC_SIZE
    cmp  rax, rdx
    jne  io_fatal
    call db_write_header
    call db_flush
    mov  rcx, r14
    call os_close
    lea  rcx, [rel s_upg_ok]
    call puts
    mov  rcx, [rel g_count]
    call put_u64
    lea  rcx, [rel s_upg_rows]
    call puts
    lea  rcx, [rel s_upg_swap]
    call puts
    xor  eax, eax
    jmp  .ret
.already:
    mov  rcx, r14
    call os_close
    lea  rcx, [rel s_upg_already]
    call puts
    xor  eax, eax
    jmp  .ret
.cant:
    mov  rcx, r14
    call os_close
    lea  rcx, [rel s_upg_cant]
    call puts
    mov  eax, 1
    jmp  .ret
.badsrc:
    mov  rcx, r14
    call os_close
    lea  rcx, [rel s_err_corrupt]
    call puts
    lea  rcx, [rel g_datname]
    call puts
    lea  rcx, [rel s_nl]
    call puts
    mov  eax, 1
    jmp  .ret
.nodest:
    lea  rcx, [rel s_err_bak_open]
    call puts
    mov  eax, 1
    jmp  .ret
.nosrc:
    lea  rcx, [rel s_upg_nosrc]
    call puts
    mov  eax, 1
    jmp  .ret
.short_src:
    ; The source ended before the region its own header describes. Persisting
    ; what we read and calling it a migration would silently produce a partial
    ; database, so refuse - the destination is a separate file and the original
    ; is untouched, so nothing is lost by stopping here.
    mov  rcx, r14
    call os_close
    lea  rcx, [rel s_upg_short]
    call puts
    mov  eax, 1
    jmp  .ret
.nospace:
    mov  rcx, r14
    call os_close
    lea  rcx, [rel s_upg_nospace]
    call puts
    mov  eax, 1
    jmp  .ret
.lostrows:
    mov  rcx, r14
    call os_close
    lea  rcx, [rel s_upg_lost]
    call puts
    mov  rcx, [rel g_count]
    call put_u64
    lea  rcx, [rel s_vfy_vs]
    call puts
    mov  rcx, [rbp-88]
    call put_u64
    lea  rcx, [rel s_nl]
    call puts
    mov  eax, 1
.ret:
    mov  r14, [rbp-48]
    mov  r13, [rbp-40]
    mov  r12, [rbp-32]
    mov  rdi, [rbp-24]
    mov  rsi, [rbp-16]
    mov  rbx, [rbp-8]
    mov  rsp, rbp
    pop  rbp
    ret

; db_close()
db_close:
    push rbp
    mov  rbp, rsp
    sub  rsp, 0x30
    call db_flush
    mov  rcx, [rel g_dat_handle]
    call os_close
    call wal_close
    mov  rsp, rbp
    pop  rbp
    ret

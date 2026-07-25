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

; db_persist_slot(rcx = slot ptr) - slot + header + flush (durable autocommit)
db_persist_slot:
    push rbp
    mov  rbp, rsp
    sub  rsp, 0x30
    call db_write_slot               ; rcx = slot ptr
    call db_write_header
    call db_flush
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
    ; header is trustworthy: now replay a committed WAL, then load the slots
    call wal_open
    call wal_recover
    jmp  .load
.newfile:
    ; brand-new file: mark it sparse so unwritten slots cost no disk, then set
    ; the logical size to the full region without allocating/zeroing 1 GiB.
    mov  rcx, [rel g_dat_handle]
    call os_set_sparse
    mov  qword [rel g_count], 0
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
    call wal_open
    call wal_recover                 ; a committed WAL may predate this file
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

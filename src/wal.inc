; -----------------------------------------------------------------------------
; src/wal.inc - write-ahead log, multi-statement transactions, crash recovery.
;
; Model: during an explicit transaction every mutation is applied in memory only
; and an undo entry (slot index + old record image) is recorded. COMMIT stages
; the after-images into a WAL file, flushes them, writes a commit marker, flushes
; again, then applies the pages to asmdb.dat and truncates the WAL. ROLLBACK
; replays the undo log in reverse. On startup a committed-but-unapplied WAL is
; replayed (idempotent); an incomplete WAL is discarded.
;
; WAL staging layout (in g_walbuf, mirrored to disk):
;   +0   8   magic  'ASMWAL01'
;   +8   8   N      entry count
;   +16  8   count  live-row count to store in the header
;   +24  N * { 8 index ; REC_SIZE image }
;   +..  8   marker 'COMMIT01'   (written and flushed last)
; -----------------------------------------------------------------------------

; wal_open() - open/create g_walname (kept open for the process lifetime)
wal_open:
    push rbp
    mov  rbp, rsp
    sub  rsp, 0x50
    lea  rcx, [rel g_walname]
    call os_open
    mov  [rel g_wal_handle], rax
    cmp  rax, INVALID_HANDLE
    je   .openfail
    mov  rsp, rbp
    pop  rbp
    ret
.openfail:
    lea  rcx, [rel s_err_open]
    call puts
    mov  ecx, 1
    call os_exit

; wal_write(rcx = offset, rdx = buf, r8 = len)
;   Loops over short writes. A WAL we failed to write in full is not a WAL we
;   can commit from, so any failure aborts instead of returning quietly.
wal_write:
    push rbp
    mov  rbp, rsp
    sub  rsp, 0x50
    mov  [rbp-16], rsi
    mov  [rbp-24], rdi
    mov  [rbp-32], r12
    mov  rsi, rcx                    ; offset
    mov  rdi, rdx                    ; buf
    mov  r12, r8                     ; remaining
.loop:
    test r12, r12
    jz   .done
    mov  rcx, [rel g_wal_handle]
    mov  rdx, rsi                    ; offset
    mov  r8, rdi                     ; buf
    mov  r9, r12                     ; len
    call os_pwrite
    cmp  rax, 0
    jle  io_fatal                    ; error or no progress
    add  rsi, rax
    add  rdi, rax
    sub  r12, rax
    jmp  .loop
.done:
    mov  r12, [rbp-32]
    mov  rdi, [rbp-24]
    mov  rsi, [rbp-16]
    mov  rsp, rbp
    pop  rbp
    ret

; wal_read(rcx = offset, rdx = buf, r8 = len) -> rax = total bytes read, or -1
;   Loops like read_at: a single pread is not guaranteed to satisfy a large
;   request, and treating a short transfer as "the frame is incomplete" would
;   hand a committed transaction to the discard path.
wal_read:
    push rbp
    mov  rbp, rsp
    sub  rsp, 0x50
    mov  [rbp-8], rbx                ; total
    mov  [rbp-16], rsi               ; offset
    mov  [rbp-24], rdi               ; buffer
    mov  [rbp-32], r12               ; remaining
    xor  rbx, rbx
    mov  rsi, rcx
    mov  rdi, rdx
    mov  r12, r8
.loop:
    test r12, r12
    jz   .done
    mov  rcx, [rel g_wal_handle]
    mov  rdx, rsi                    ; offset
    mov  r8, rdi                     ; buf
    mov  r9, r12                     ; len
    call os_pread
    test rax, rax
    js   .fail                       ; hard I/O error
    jz   .done                       ; EOF - report what we actually got
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

; wal_flush() - fsync the WAL; aborts on failure
wal_flush:
    push rbp
    mov  rbp, rsp
    sub  rsp, 0x30
    mov  rcx, [rel g_wal_handle]
    call os_fsync
    test rax, rax
    jnz  io_fatal
    mov  rsp, rbp
    pop  rbp
    ret

; wal_truncate() - reset the WAL to empty (removes any commit marker)
;   The flush is NOT redundant, even though replaying an already-applied frame
;   would be idempotent. Without it, a crash can leave the old frame's bytes on
;   disk beyond a shorter frame written later; if that leftover happens to place
;   'COMMIT01' exactly where the new frame's marker belongs - a row containing
;   that literal text is enough - recovery would read a marker whose checksum
;   cannot match and refuse to open a database that was merely mid-commit.
;   Emptying the log durably is what makes "the log is empty" a fact rather than
;   a hope, so it stays.
wal_truncate:
    push rbp
    mov  rbp, rsp
    sub  rsp, 0x40
    mov  rcx, [rel g_wal_handle]
    xor  rdx, rdx
    call os_truncate
    test rax, rax
    jnz  io_fatal
    call wal_flush
    mov  rsp, rbp
    pop  rbp
    ret

; wal_recover() - replay a committed WAL into asmdb.dat, else discard it.
; Called from db_open after both files are open, before the table is read in.
wal_recover:
    push rbp
    mov  rbp, rsp
    sub  rsp, 0x60
    mov  [rbp-8], rbx
    mov  [rbp-16], rsi
    mov  [rbp-24], rdi
    mov  [rbp-32], r12
    xor  rcx, rcx
    mov  rdx, [rel g_walbuf]
    mov  r8, WAL_BUF_SIZE
    call wal_read                    ; rax = bytes read
    test rax, rax
    js   io_fatal_read               ; a READ ERROR is not an absent transaction:
                                     ; discarding here would destroy a WAL that
                                     ; may hold a committed, acknowledged commit
    mov  r12, rax                    ; bytes available
    cmp  r12, 24
    jb   .clear
    mov  rbx, [rel g_walbuf]
    mov  qword [rbp-40], 0           ; 1 -> v02 frame, checksum to verify
    mov  rax, [rel wal_magic2]
    cmp  rax, [rbx]
    je   .v2
    mov  rax, [rel wal_magic]        ; legacy frame written before checksums
    cmp  rax, [rbx]
    jne  .clear
    jmp  .magic_ok
.v2:
    mov  qword [rbp-40], 1
.magic_ok:
    mov  rsi, [rbx+8]                ; N
    cmp  rsi, UNDO_MAX
    ja   .clear
    ; marker offset = 24 + N*72
    mov  rax, rsi
    imul rax, rax, UNDO_ENTRY
    add  rax, 24                     ; rax = marker offset
    mov  rdi, rax                    ; save marker offset
    add  rax, 8
    cmp  r12, rax                    ; need marker fully present
    jb   .clear
    mov  rax, [rel wal_commit]
    mov  rdx, rbx
    add  rdx, rdi
    cmp  rax, [rdx]                  ; verify commit marker
    jne  .clear
    ; verify the checksum flushed alongside the marker
    cmp  qword [rbp-40], 0
    je   .crc_ok                     ; legacy frame - nothing to verify
    mov  rax, rdi
    add  rax, 16
    cmp  r12, rax                    ; marker + checksum must be fully present
    jb   .clear                      ; torn final write -> treat as uncommitted
    mov  rcx, rbx
    mov  rdx, rdi                    ; checksum covers [0, marker offset)
    call crc32
    mov  rdx, rbx
    add  rdx, rdi
    cmp  rax, [rdx+8]
    jne  .crcbad
.crc_ok:
    ; every slot index must address a real slot. A corrupt frame could otherwise
    ; make the redo below write REC_SIZE bytes at an arbitrary file offset,
    ; growing the .dat past its region (and the redo aborts the process on the
    ; failures that produces). Validate the whole frame before touching disk.
    xor  r12, r12
.chk:
    cmp  r12, rsi
    jae  .chk_done
    mov  rax, r12
    imul rax, rax, UNDO_ENTRY
    add  rax, 24
    add  rax, rbx                    ; entry ptr
    mov  rdx, [rax]                  ; slot index
    mov  rcx, CAPACITY
    cmp  rdx, rcx
    jae  .clear                      ; out of range -> discard the whole frame
    inc  r12
    jmp  .chk
.chk_done:
    ; also require the live count to be inside the table
    mov  rax, [rbx+16]
    mov  rcx, CAPACITY
    cmp  rax, rcx
    ja   .clear
    ; committed: apply after-images to asmdb.dat
    xor  r12, r12                    ; i
.apply:
    cmp  r12, rsi
    jae  .apply_done
    mov  rax, r12
    imul rax, rax, UNDO_ENTRY
    add  rax, 24
    add  rax, rbx                    ; entry ptr
    mov  rdi, [rax]                  ; index
    lea  rdx, [rax+8]                ; image ptr
    mov  rcx, rdi
    shl  rcx, REC_SHIFT
    add  rcx, HDR_SIZE               ; file offset
    mov  r8, REC_SIZE
    call write_at
    cmp  rax, REC_SIZE
    jne  io_fatal                    ; recovery must be complete or not at all
    inc  r12
    jmp  .apply
.apply_done:
    mov  rax, [rbx+16]               ; new live count
    mov  [rel g_count], rax
    call db_write_header
    call db_flush
.clear:
    call wal_truncate
    mov  r12, [rbp-32]
    mov  rdi, [rbp-24]
    mov  rsi, [rbp-16]
    mov  rbx, [rbp-8]
    mov  rsp, rbp
    pop  rbp
    ret
.crcbad:
    ; The frame carries a valid commit marker, so the transaction WAS committed
    ; and acknowledged - but its bytes no longer match their checksum. Applying
    ; it would write corrupt records; discarding it would silently lose an
    ; acknowledged transaction. Neither is acceptable, so stop and say so.
    lea  rcx, [rel s_err_walcrc]
    call puts
    lea  rcx, [rel g_walname]
    call puts
    lea  rcx, [rel s_nl]
    call puts
    lea  rcx, [rel s_walcrc_hint]
    call puts
    mov  ecx, 1
    call os_exit

; wal_close()
wal_close:
    push rbp
    mov  rbp, rsp
    sub  rsp, 0x30
    mov  rcx, [rel g_wal_handle]
    call os_close
    mov  rsp, rbp
    pop  rbp
    ret

; txn_capture(rcx = slot ptr) -> rax = 1 ok / 0 overflow
; Records the slot's current image in the undo log (no-op outside a txn).
;
; A slot is captured AT MOST ONCE per transaction. Re-capturing on every write
; meant that updating one row N times burned N undo entries, produced N
; identical after-images at COMMIT, and hit the UNDO_MAX ceiling after 4096
; writes even when only a handful of distinct rows were touched. Keeping the
; FIRST before-image is also what makes ROLLBACK restore the original row
; rather than an intermediate value. A linear scan is enough: the log holds at
; most UNDO_MAX entries and a transaction touching that many distinct rows is
; already at its documented limit.
txn_capture:
    push rbp
    mov  rbp, rsp
    sub  rsp, 0x40
    mov  [rbp-8], rbx
    mov  [rbp-16], rsi
    mov  [rbp-24], rdi
    cmp  qword [rel g_in_txn], 0
    je   .ok
    mov  [rbp-32], rcx               ; slot ptr
    call store_slot_index            ; rax = index (rcx = slot ptr)
    mov  [rbp-40], rax               ; slot index
    ; already captured in this transaction? then keep the existing image
    mov  rbx, [rel g_undo]
    xor  rsi, rsi
.scan:
    cmp  rsi, [rel g_undo_n]
    jae  .append
    cmp  [rbx], rax
    je   .ok                         ; first before-image wins
    add  rbx, UNDO_ENTRY
    inc  rsi
    jmp  .scan
.append:
    ; rbx now points at entry [g_undo_n]
    mov  rax, [rel g_undo_n]
    cmp  rax, UNDO_MAX
    jae  .overflow
    mov  rax, [rbp-40]
    mov  [rbx], rax
    mov  rsi, [rbp-32]
    lea  rdi, [rbx+8]
    mov  rcx, REC_SIZE
.cpy:
    mov  al, [rsi]
    mov  [rdi], al
    inc  rsi
    inc  rdi
    dec  rcx
    jnz  .cpy
    inc  qword [rel g_undo_n]
.ok:
    mov  rax, 1
    jmp  .ret
.overflow:
    xor  rax, rax
.ret:
    mov  rdi, [rbp-24]
    mov  rsi, [rbp-16]
    mov  rbx, [rbp-8]
    mov  rsp, rbp
    pop  rbp
    ret

; cmd_begin() - BEGIN
cmd_begin:
    push rbp
    mov  rbp, rsp
    sub  rsp, 0x30
    cmp  qword [rel g_in_txn], 0
    jne  .active
    mov  qword [rel g_in_txn], 1
    mov  qword [rel g_undo_n], 0
    mov  rax, [rel g_count]
    mov  [rel g_count_snap], rax
    lea  rcx, [rel s_txn_begin]
    call puts
    jmp  .done
.active:
    lea  rcx, [rel s_txn_active]
    call puts
.done:
    mov  rsp, rbp
    pop  rbp
    ret

; txn_flush() - make the open transaction durable and checkpoint it into the
;   .dat: stage after-images into the WAL, flush, write the commit marker plus
;   its checksum, flush again (the transaction is committed at that instant),
;   then apply the images, publish the count and truncate the log.
;   Shared by the explicit COMMIT and by autocommit, so a single-statement
;   mutation gets exactly the same crash guarantees as a multi-statement one.
;   Clears g_in_txn / g_undo_n. Prints nothing.
txn_flush:
    push rbp
    mov  rbp, rsp
    sub  rsp, 0x60
    mov  [rbp-8], rbx
    mov  [rbp-16], rsi
    mov  [rbp-24], rdi
    mov  [rbp-32], r12
    mov  rbx, [rel g_walbuf]
    mov  rax, [rel wal_magic2]
    mov  [rbx], rax                  ; +0 magic
    mov  rax, [rel g_undo_n]
    mov  [rbx+8], rax                ; +8 N
    mov  rax, [rel g_count]
    mov  [rbx+16], rax               ; +16 new count
    ; stage after-images from the live table
    xor  r12, r12                    ; i
    lea  rdi, [rbx+24]               ; dest entry ptr
.stage:
    cmp  r12, [rel g_undo_n]
    jae  .staged
    mov  rax, r12
    imul rax, rax, UNDO_ENTRY
    add  rax, [rel g_undo]           ; undo entry i
    mov  rcx, [rax]                  ; slot index
    mov  [rdi], rcx                  ; dest index
    mov  rsi, rcx
    shl  rsi, REC_SHIFT
    add  rsi, [rel g_table]          ; live slot ptr
    lea  rdx, [rdi+8]                ; dest image
    mov  rcx, REC_SIZE
.sc:
    mov  al, [rsi]
    mov  [rdx], al
    inc  rsi
    inc  rdx
    dec  rcx
    jnz  .sc
    add  rdi, UNDO_ENTRY
    inc  r12
    jmp  .stage
.staged:
    ; rdi points at the marker slot; data length = rdi - g_walbuf
    mov  rsi, rdi                    ; marker offset ptr
    sub  rdi, rbx                    ; data length (also marker offset)
    xor  rcx, rcx
    mov  rdx, rbx
    mov  r8, rdi
    call wal_write                   ; write header + entries
    call wal_flush
    ; Commit record = 'COMMIT01' + CRC32 of everything before it. Both go out in
    ; ONE write+flush, so the checksum is as durable as the commit decision it
    ; describes: a frame can never be "committed but unchecksummed".
    mov  rax, [rel wal_commit]
    mov  [rsi], rax                  ; place marker in buffer
    mov  rcx, rbx                    ; buffer start
    mov  rdx, rdi                    ; length = marker offset
    call crc32
    mov  [rsi+8], rax                ; checksum, zero-extended to 8 bytes
    mov  rcx, rdi                    ; marker offset
    mov  rdx, rsi                    ; &marker
    mov  r8, 16                      ; marker + checksum
    call wal_write
    call wal_flush                   ; marker now durable -> committed
    ; apply after-images to asmdb.dat
    xor  r12, r12
.apply:
    cmp  r12, [rel g_undo_n]
    jae  .applied
    mov  rax, r12
    imul rax, rax, UNDO_ENTRY
    add  rax, [rel g_undo]
    mov  rdi, [rax]                  ; index
    mov  rsi, rdi
    shl  rsi, REC_SHIFT
    add  rsi, [rel g_table]          ; slot ptr (buffer)
    mov  rcx, rdi
    shl  rcx, REC_SHIFT
    add  rcx, HDR_SIZE               ; file offset
    mov  rdx, rsi
    mov  r8, REC_SIZE
    call write_at
    cmp  rax, REC_SIZE
    jne  io_fatal                    ; the WAL is committed; the checkpoint must
                                     ; not silently half-apply
    inc  r12
    jmp  .apply
.applied:
    call db_write_header
    call db_flush
    call wal_truncate                ; checkpoint complete
    mov  qword [rel g_in_txn], 0
    mov  qword [rel g_undo_n], 0
    mov  r12, [rbp-32]
    mov  rdi, [rbp-24]
    mov  rsi, [rbp-16]
    mov  rbx, [rbp-8]
    mov  rsp, rbp
    pop  rbp
    ret

; auto_begin() - open an implicit single-statement transaction when the caller
;   is not already inside an explicit one. Call it only once the statement is
;   certain to mutate, so no error path can leave a transaction dangling.
auto_begin:
    cmp  qword [rel g_in_txn], 0
    jne  .already
    mov  qword [rel g_in_txn], 1
    mov  qword [rel g_auto_txn], 1
    mov  qword [rel g_undo_n], 0
    mov  rax, [rel g_count]
    mov  [rel g_count_snap], rax
.already:
    ret

; auto_commit() - make an implicit transaction durable. A no-op inside an
;   explicit transaction, where COMMIT decides when the changes land.
auto_commit:
    cmp  qword [rel g_auto_txn], 0
    je   .nothing
    push rbp
    mov  rbp, rsp
    sub  rsp, 0x30
    call txn_flush
    mov  qword [rel g_auto_txn], 0
    mov  rsp, rbp
    pop  rbp
.nothing:
    ret

; cmd_commit() - COMMIT
cmd_commit:
    push rbp
    mov  rbp, rsp
    sub  rsp, 0x30
    cmp  qword [rel g_in_txn], 0
    je   .none
    call txn_flush
    mov  qword [rel g_auto_txn], 0
    lea  rcx, [rel s_txn_commit]
    call puts
    jmp  .done
.none:
    lea  rcx, [rel s_txn_none]
    call puts
.done:
    mov  rsp, rbp
    pop  rbp
    ret

; cmd_rollback() - ROLLBACK
cmd_rollback:
    push rbp
    mov  rbp, rsp
    sub  rsp, 0x40
    mov  [rbp-8], rbx
    cmp  qword [rel g_in_txn], 0
    je   .none
    mov  rbx, [rel g_undo_n]
.loop:
    test rbx, rbx
    jz   .done_undo
    dec  rbx
    mov  rax, rbx
    imul rax, rax, UNDO_ENTRY
    add  rax, [rel g_undo]           ; undo entry
    mov  r8, [rax]                   ; index
    lea  r9, [rax+8]                 ; old image
    shl  r8, REC_SHIFT
    add  r8, [rel g_table]           ; dest slot
    mov  rcx, REC_SIZE
.cpy:
    mov  dl, [r9]
    mov  [r8], dl
    inc  r9
    inc  r8
    dec  rcx
    jnz  .cpy
    jmp  .loop
.done_undo:
    mov  rax, [rel g_count_snap]
    mov  [rel g_count], rax
    mov  qword [rel g_in_txn], 0
    mov  qword [rel g_auto_txn], 0
    mov  qword [rel g_undo_n], 0
    call wal_truncate
    lea  rcx, [rel s_txn_rollback]
    call puts
    jmp  .ret
.none:
    lea  rcx, [rel s_txn_none]
    call puts
.ret:
    mov  rbx, [rbp-8]
    mov  rsp, rbp
    pop  rbp
    ret

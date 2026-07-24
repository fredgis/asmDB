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
wal_write:
    push rbp
    mov  rbp, rsp
    sub  rsp, 0x30
    mov  r9, r8                      ; len
    mov  r8, rdx                     ; buf
    mov  rdx, rcx                    ; offset
    mov  rcx, [rel g_wal_handle]     ; handle
    call os_pwrite
    mov  rsp, rbp
    pop  rbp
    ret

; wal_read(rcx = offset, rdx = buf, r8 = len) -> rax = bytes read
wal_read:
    push rbp
    mov  rbp, rsp
    sub  rsp, 0x30
    mov  r9, r8                      ; len
    mov  r8, rdx                     ; buf
    mov  rdx, rcx                    ; offset
    mov  rcx, [rel g_wal_handle]     ; handle
    call os_pread
    mov  rsp, rbp
    pop  rbp
    ret

; wal_flush()
wal_flush:
    push rbp
    mov  rbp, rsp
    sub  rsp, 0x30
    mov  rcx, [rel g_wal_handle]
    call os_fsync
    mov  rsp, rbp
    pop  rbp
    ret

; wal_truncate() - reset the WAL to empty (removes any commit marker)
wal_truncate:
    push rbp
    mov  rbp, rsp
    sub  rsp, 0x40
    mov  rcx, [rel g_wal_handle]
    xor  rdx, rdx
    call os_truncate
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
    mov  r12, rax                    ; bytes available
    cmp  r12, 24
    jb   .clear
    mov  rbx, [rel g_walbuf]
    mov  rax, [rel wal_magic]
    cmp  rax, [rbx]
    jne  .clear
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
txn_capture:
    push rbp
    mov  rbp, rsp
    sub  rsp, 0x40
    mov  [rbp-8], rbx
    mov  [rbp-16], rsi
    mov  [rbp-24], rdi
    cmp  qword [rel g_in_txn], 0
    je   .ok
    mov  rax, [rel g_undo_n]
    cmp  rax, UNDO_MAX
    jae  .overflow
    mov  [rbp-32], rcx               ; slot ptr
    mov  rbx, rax
    imul rbx, rbx, UNDO_ENTRY
    add  rbx, [rel g_undo]           ; entry ptr
    mov  rcx, [rbp-32]
    call store_slot_index            ; rax = index
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

; cmd_commit() - COMMIT
cmd_commit:
    push rbp
    mov  rbp, rsp
    sub  rsp, 0x60
    mov  [rbp-8], rbx
    mov  [rbp-16], rsi
    mov  [rbp-24], rdi
    mov  [rbp-32], r12
    cmp  qword [rel g_in_txn], 0
    je   .none
    mov  rbx, [rel g_walbuf]
    mov  rax, [rel wal_magic]
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
    mov  rax, [rel wal_commit]
    mov  [rsi], rax                  ; place marker in buffer
    mov  rcx, rdi                    ; marker offset
    mov  rdx, rsi                    ; &marker
    mov  r8, 8
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
    inc  r12
    jmp  .apply
.applied:
    call db_write_header
    call db_flush
    call wal_truncate                ; checkpoint complete
    mov  qword [rel g_in_txn], 0
    mov  qword [rel g_undo_n], 0
    lea  rcx, [rel s_txn_commit]
    call puts
    jmp  .done
.none:
    lea  rcx, [rel s_txn_none]
    call puts
.done:
    mov  r12, [rbp-32]
    mov  rdi, [rbp-24]
    mov  rsi, [rbp-16]
    mov  rbx, [rbp-8]
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

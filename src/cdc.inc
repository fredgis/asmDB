; -----------------------------------------------------------------------------
; src/cdc.inc - change data capture: an append-only <db>.cdc log carrying one
; frame per committed transaction that changed something.
;
; The contract the log offers a reader:
;   - total order: commit_seq is strictly increasing, starting at 1;
;   - no loss: a frame is durable BEFORE the change reaches <db>.dat, so an
;     acknowledged commit is always represented;
;   - idempotent recovery: the sequence a committed WAL frame carries is
;     compared against the log, so a crash between the two never duplicates;
;   - one event per row per transaction, carrying the FINAL image.
;
; Frame layout (little-endian) is defined in asmdb.inc and mirrored by
; tests/cdc_dump.py; the two must be kept in step.
;
; Global operations (TRUNCATE, RESTORE, BENCH) emit a single RESET frame rather
; than millions of row events: the reader is told to take a fresh snapshot. A
; RESET is announced in the .dat header (reset_pending) before the table is
; touched and cleared only once the frame is durable, so a crash in the middle
; still produces exactly one RESET on the next open.
; -----------------------------------------------------------------------------

; cdc_open() - open/create <db>.cdc and validate what is already in it.
;   Sets g_cdc_end (append offset) and g_cdc_lastseq.
cdc_open:
    push rbp
    mov  rbp, rsp
    sub  rsp, 0x40
    lea  rcx, [rel g_cdcname]
    call os_open_shared              ; readers may follow the log while we write
    mov  [rel g_cdc_handle], rax
    cmp  rax, INVALID_HANDLE
    je   .openfail
    call cdc_scan
    mov  rsp, rbp
    pop  rbp
    ret
.openfail:
    lea  rcx, [rel s_err_cdc_open]
    call puts
    mov  ecx, 1
    call os_exit

; cdc_read(rcx = offset, rdx = buf, r8 = len) -> rax = bytes read, or -1
cdc_read:
    push rbp
    mov  rbp, rsp
    sub  rsp, 0x50
    mov  [rbp-16], rsi
    mov  [rbp-24], rdi
    mov  [rbp-32], r12
    mov  [rbp-40], rbx
    xor  rbx, rbx
    mov  rsi, rcx
    mov  rdi, rdx
    mov  r12, r8
.loop:
    test r12, r12
    jz   .done
    mov  rcx, [rel g_cdc_handle]
    mov  rdx, rsi
    mov  r8, rdi
    mov  r9, r12
    call os_pread
    test rax, rax
    js   .fail
    jz   .done
    add  rbx, rax
    add  rsi, rax
    add  rdi, rax
    sub  r12, rax
    jmp  .loop
.fail:
    mov  rbx, -1
.done:
    mov  rax, rbx
    mov  rbx, [rbp-40]
    mov  r12, [rbp-32]
    mov  rdi, [rbp-24]
    mov  rsi, [rbp-16]
    mov  rsp, rbp
    pop  rbp
    ret

; cdc_scan() - walk every frame, validate it, and decide where to append next.
;   A torn LAST frame (a crash mid-append) is trimmed - it was never
;   acknowledged. A COMPLETE frame that fails its checksum, or a sequence that
;   does not strictly increase, is real corruption: refuse to open and keep the
;   file so it can be examined.
cdc_scan:
    push rbp
    mov  rbp, rsp
    sub  rsp, 0x70
    mov  [rbp-8], rbx
    mov  [rbp-16], rsi
    mov  [rbp-24], rdi
    mov  [rbp-32], r12
    mov  [rbp-40], r13
    mov  qword [rel g_cdc_end], 0
    mov  qword [rel g_cdc_lastseq], 0
    mov  rcx, [rel g_cdc_handle]
    call os_filesize
    test rax, rax
    js   io_fatal_read
    mov  r13, rax                    ; file length
    xor  rbx, rbx                    ; cursor
.frame:
    mov  rax, r13
    sub  rax, rbx                    ; bytes left
    cmp  rax, CDC_HDR_SIZE + CDC_TAIL_SIZE
    jb   .trim                       ; not even a minimal frame -> torn tail
    ; read the frame header
    mov  rcx, rbx
    lea  rdx, [rel g_cdc_hdrbuf]
    mov  r8, CDC_HDR_SIZE
    call cdc_read
    cmp  rax, CDC_HDR_SIZE
    jne  .trim
    mov  rax, [rel cdc_magic]
    cmp  rax, [rel g_cdc_hdrbuf]
    jne  .badframe                   ; garbage in the middle of the log
    mov  r12, [rel g_cdc_hdrbuf+8]   ; frame_size
    ; frame_size must match op_count exactly
    mov  rax, [rel g_cdc_hdrbuf+24]  ; op_count
    imul rax, rax, CDC_OP_SIZE
    add  rax, CDC_HDR_SIZE + CDC_TAIL_SIZE
    cmp  rax, r12
    jne  .badframe
    ; must fit in the file, else it is a torn tail
    mov  rax, rbx
    add  rax, r12
    cmp  rax, r13
    ja   .trim
    ; sequence must strictly increase
    mov  rax, [rel g_cdc_hdrbuf+16]
    cmp  rax, [rel g_cdc_lastseq]
    jbe  .badseq
    mov  [rbp-48], rax               ; this frame's seq
    ; verify trailer + checksum over the whole frame
    mov  rcx, r12
    call cdc_load_frame              ; rcx = size, reads at rbx into g_cdcbuf
    test rax, rax
    jz   .trim
    mov  rsi, [rel g_cdcbuf]
    mov  rax, r12
    sub  rax, 8
    mov  rdx, [rel cdc_trailer]
    cmp  rdx, [rsi+rax]              ; trailer at frame_size-8
    jne  .trim                       ; only a torn tail can lack its trailer
    mov  rcx, rsi
    mov  rdx, r12
    sub  rdx, CDC_TAIL_SIZE          ; checksum covers everything before it
    mov  [rbp-56], rdx
    call crc32
    mov  rsi, [rel g_cdcbuf]
    mov  rdx, [rbp-56]
    cmp  rax, [rsi+rdx]
    jne  .badcrc                     ; complete frame, wrong checksum
    ; accepted
    mov  rax, [rbp-48]
    mov  [rel g_cdc_lastseq], rax
    add  rbx, r12
    mov  [rel g_cdc_end], rbx
    jmp  .frame
.trim:
    ; everything up to g_cdc_end is good; drop any torn remainder
    mov  rax, [rel g_cdc_end]
    cmp  rax, r13
    je   .done
    mov  rcx, [rel g_cdc_handle]
    mov  rdx, rax
    call os_truncate
    test rax, rax
    jnz  io_fatal
    mov  rcx, [rel g_cdc_handle]
    call os_fsync
    test rax, rax
    jnz  io_fatal
.done:
    mov  r13, [rbp-40]
    mov  r12, [rbp-32]
    mov  rdi, [rbp-24]
    mov  rsi, [rbp-16]
    mov  rbx, [rbp-8]
    mov  rsp, rbp
    pop  rbp
    ret
.badcrc:
    lea  rcx, [rel s_err_cdc_crc]
    jmp  .refuse
.badseq:
    lea  rcx, [rel s_err_cdc_seq]
    jmp  .refuse
.badframe:
    lea  rcx, [rel s_err_cdc_frame]
.refuse:
    call puts
    lea  rcx, [rel g_cdcname]
    call puts
    lea  rcx, [rel s_nl]
    call puts
    lea  rcx, [rel s_cdc_hint]
    call puts
    mov  ecx, 1
    call os_exit

; cdc_load_frame(rcx = size) -> rax = 1 read in full / 0 short
;   Reads the frame at rbx into g_cdcbuf. Only sizes that fit the staging
;   buffer are accepted; a larger one cannot have been written by this build.
cdc_load_frame:
    push rbp
    mov  rbp, rsp
    sub  rsp, 0x30
    mov  [rbp-8], rcx
    mov  rax, WAL_BUF_SIZE
    cmp  rcx, rax
    ja   .no
    mov  rcx, rbx
    mov  rdx, [rel g_cdcbuf]
    mov  r8, [rbp-8]
    call cdc_read
    cmp  rax, [rbp-8]
    jne  .no
    mov  rax, 1
    jmp  .out
.no:
    xor  rax, rax
.out:
    mov  rsp, rbp
    pop  rbp
    ret

; cdc_frame_begin(rcx = commit_seq, rdx = flags) -> rdi = cursor for operations
;   Lays the frame header into g_cdcbuf and returns where operations go.
cdc_frame_begin:
    mov  rdi, [rel g_cdcbuf]
    mov  rax, [rel cdc_magic]
    mov  [rdi], rax
    mov  qword [rdi+8], 0            ; frame_size, filled by cdc_frame_end
    mov  [rdi+16], rcx               ; commit_seq
    mov  qword [rdi+24], 0           ; op_count, filled by cdc_frame_end
    mov  [rdi+32], rdx               ; flags
    add  rdi, CDC_HDR_SIZE
    ret

; cdc_frame_end(rcx = op_count, rdx = cursor) - seal and append the frame,
;   then flush it. Returns only once the frame is durable.
cdc_frame_end:
    push rbp
    mov  rbp, rsp
    sub  rsp, 0x50
    mov  [rbp-8], rbx
    mov  [rbp-16], rsi
    mov  rsi, [rel g_cdcbuf]
    mov  [rsi+24], rcx               ; op_count
    mov  rbx, rdx
    sub  rbx, rsi                    ; bytes used by header + operations
    ; frame_size must be in place BEFORE the checksum, since the checksum covers
    ; the header too
    mov  rax, rbx
    add  rax, CDC_TAIL_SIZE
    mov  [rsi+8], rax                ; frame_size
    ; checksum over [0, rbx)
    mov  rcx, rsi
    mov  rdx, rbx
    call crc32
    mov  rsi, [rel g_cdcbuf]
    mov  qword [rsi+rbx], 0
    mov  [rsi+rbx], rax              ; crc32, zero-extended
    mov  rax, [rel cdc_trailer]
    mov  [rsi+rbx+8], rax
    add  rbx, CDC_TAIL_SIZE          ; total frame size
%ifdef FAULT_CDC
    ; Test-only: die after the WAL commit but before the change frame lands, the
    ; one window where recovery has to publish a frame on the engine's behalf.
    ; Assembled only with -dFAULT_CDC; absent from the shipping binary.
    call io_fatal
%endif
    ; append at the validated end of the log
    mov  rcx, [rel g_cdc_handle]
    mov  rdx, [rel g_cdc_end]
    mov  r8, rsi
    mov  r9, rbx
    call cdc_write_all
    mov  rcx, [rel g_cdc_handle]
    call os_fsync
    test rax, rax
    jnz  io_fatal
    mov  rax, [rel g_cdc_end]
    add  rax, rbx
    mov  [rel g_cdc_end], rax
    mov  rax, [rel g_cdcbuf]
    mov  rax, [rax+16]
    mov  [rel g_cdc_lastseq], rax
    mov  rsi, [rbp-16]
    mov  rbx, [rbp-8]
    mov  rsp, rbp
    pop  rbp
    ret

; cdc_write_all(rcx = handle, rdx = offset, r8 = buf, r9 = len)
cdc_write_all:
    push rbp
    mov  rbp, rsp
    sub  rsp, 0x50
    mov  [rbp-16], rsi
    mov  [rbp-24], rdi
    mov  [rbp-32], r12
    mov  [rbp-40], rcx               ; handle
    mov  rsi, rdx                    ; offset
    mov  rdi, r8                     ; buf
    mov  r12, r9                     ; remaining
.loop:
    test r12, r12
    jz   .done
    mov  rcx, [rbp-40]
    mov  rdx, rsi
    mov  r8, rdi
    mov  r9, r12
    call os_pwrite
    cmp  rax, 0
    jle  io_fatal
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

; cdc_emit_reset(rcx = commit_seq) - append a single RESET frame, unless a frame
;   with that sequence is already there (idempotent recovery).
cdc_emit_reset:
    push rbp
    mov  rbp, rsp
    sub  rsp, 0x40
    mov  [rbp-8], rcx
    cmp  rcx, [rel g_cdc_lastseq]
    jbe  .already                    ; already published
    mov  rdx, CDC_FLAG_RESET
    call cdc_frame_begin             ; rcx = seq
    mov  rdx, rdi
    xor  rcx, rcx                    ; no operations
    call cdc_frame_end
.already:
    mov  rsp, rbp
    pop  rbp
    ret

; cdc_emit_from_wal(rcx = entry base ptr, rdx = N, r8 = seq, r9 = flags)
;   Build a change frame from a WAL frame's after-images. Doing it from the
;   after-images - rather than from the undo log - is what makes the commit path
;   and the recovery path produce byte-identical frames: the status byte in the
;   image already says whether the row ended up present (UPSERT) or gone
;   (DELETE), and unchanged rows were filtered out before they were staged.
cdc_emit_from_wal:
    push rbp
    mov  rbp, rsp
    sub  rsp, 0x60
    mov  [rbp-8], rbx
    mov  [rbp-16], rsi
    mov  [rbp-24], rdi
    mov  [rbp-32], r12
    mov  [rbp-40], r13
    mov  r12, rcx                    ; entries
    mov  r13, rdx                    ; N
    mov  [rbp-48], r9                ; flags
    cmp  r8, [rel g_cdc_lastseq]
    jbe  .already                    ; this commit is already in the log
    mov  rcx, r8
    mov  rdx, [rbp-48]
    call cdc_frame_begin             ; rdi = op cursor
    test qword [rbp-48], CDC_FLAG_RESET
    jnz  .seal                       ; a RESET carries no individual operations
    xor  rbx, rbx                    ; i
    xor  rsi, rsi                    ; ops emitted
.op:
    cmp  rbx, r13
    jae  .seal
    mov  rax, rbx
    imul rax, rax, UNDO_ENTRY
    add  rax, r12                    ; entry i
    lea  rcx, [rax+8]                ; after-image
    cmp  byte [rcx+REC_STATUS], ST_OCCUPIED
    je   .upsert
    ; anything not live is a removal
    mov  qword [rdi], CDC_OP_DELETE
    mov  rax, [rcx+REC_ID]
    mov  [rdi+8], rax
    lea  rdx, [rdi+16]
    mov  r8, REC_SIZE
    call mem_zero
    jmp  .opdone
.upsert:
    mov  qword [rdi], CDC_OP_UPSERT
    mov  rax, [rcx+REC_ID]
    mov  [rdi+8], rax
    mov  [rbp-56], rcx
    lea  rdx, [rdi+16]
    mov  r8, REC_SIZE
    call mem_copy                    ; rcx = src, rdx = dst, r8 = len
.opdone:
    add  rdi, CDC_OP_SIZE
    inc  rsi
    inc  rbx
    jmp  .op
.seal:
    test qword [rbp-48], CDC_FLAG_RESET
    jz   .havecount
    xor  rsi, rsi
.havecount:
    mov  rcx, rsi
    mov  rdx, rdi
    call cdc_frame_end
.already:
    mov  r13, [rbp-40]
    mov  r12, [rbp-32]
    mov  rdi, [rbp-24]
    mov  rsi, [rbp-16]
    mov  rbx, [rbp-8]
    mov  rsp, rbp
    pop  rbp
    ret

; slot_changed(rcx = before-image, rdx = after-image) -> rax = 1 if the row's
;   LOGICAL state differs, else 0.
;   Byte equality is not the right test: a slot that went EMPTY -> DELETED still
;   holds no row, so an INSERT followed by a DELETE inside one transaction is a
;   no-op and must produce neither a change event nor a sequence number, even
;   though the bytes differ.
slot_changed:
    push rbp
    mov  rbp, rsp
    sub  rsp, 0x30
    mov  [rbp-8], rcx
    mov  [rbp-16], rdx
    movzx eax, byte [rcx+REC_STATUS]
    cmp  al, ST_OCCUPIED
    sete al
    movzx r8d, byte [rdx+REC_STATUS]
    cmp  r8b, ST_OCCUPIED
    sete r8b
    cmp  al, r8b
    jne  .changed                    ; appeared or disappeared
    test al, al
    jz   .same                       ; absent before and after
    ; both live: a real comparison decides
    mov  rcx, [rbp-8]
    mov  rdx, [rbp-16]
    mov  r8, REC_SIZE
    call mem_equal
    test rax, rax
    jnz  .same
.changed:
    mov  rax, 1
    jmp  .out
.same:
    xor  rax, rax
.out:
    mov  rsp, rbp
    pop  rbp
    ret

; mem_equal(rcx = a, rdx = b, r8 = len) -> rax = 1 if identical, else 0
;   Preserves rsi/rdi so the staging loop can keep its cursors.
mem_equal:
    push rbp
    mov  rbp, rsp
    sub  rsp, 0x20
    mov  [rbp-8], rsi
    mov  [rbp-16], rdi
    mov  rsi, rcx
    mov  rdi, rdx
    mov  rcx, r8
    xor  eax, eax
.cmp:
    test rcx, rcx
    jz   .same
    mov  dl, [rsi]
    cmp  dl, [rdi]
    jne  .out
    inc  rsi
    inc  rdi
    dec  rcx
    jmp  .cmp
.same:
    mov  rax, 1
.out:
    mov  rdi, [rbp-16]
    mov  rsi, [rbp-8]
    mov  rsp, rbp
    pop  rbp
    ret

; mem_copy(rcx = src, rdx = dst, r8 = len) - byte copy, preserves rsi/rdi
mem_copy:
    push rbp
    mov  rbp, rsp
    sub  rsp, 0x20
    mov  [rbp-8], rsi
    mov  [rbp-16], rdi
    mov  rsi, rcx
    mov  rdi, rdx
    mov  rcx, r8
    rep  movsb
    mov  rdi, [rbp-16]
    mov  rsi, [rbp-8]
    mov  rsp, rbp
    pop  rbp
    ret

; mem_zero(rdx = dst, r8 = len) - preserves rsi/rdi
mem_zero:
    push rbp
    mov  rbp, rsp
    sub  rsp, 0x20
    mov  [rbp-16], rdi
    mov  rdi, rdx
    mov  rcx, r8
    xor  eax, eax
    rep  stosb
    mov  rdi, [rbp-16]
    mov  rsp, rbp
    pop  rbp
    ret

; cdc_mark_reset() -> rax = the sequence the RESET will carry
;   Announce a whole-table replacement durably BEFORE touching the table, so a
;   crash in the middle still yields exactly one RESET on the next open.
cdc_mark_reset:
    push rbp
    mov  rbp, rsp
    sub  rsp, 0x30
    mov  rax, [rel g_seq]
    inc  rax
    mov  [rel g_reset_seq], rax
    mov  qword [rel g_reset_pend], 1
    mov  [rbp-8], rax
    call db_write_header
    call db_flush
    mov  rax, [rbp-8]
    mov  rsp, rbp
    pop  rbp
    ret

; cdc_finish_reset(rcx = seq) - publish the RESET frame, then clear the flag.
cdc_finish_reset:
    push rbp
    mov  rbp, rsp
    sub  rsp, 0x30
    mov  [rbp-8], rcx
    call cdc_emit_reset
    mov  rax, [rbp-8]
    mov  [rel g_seq], rax            ; the reset IS the commit
    mov  qword [rel g_reset_pend], 0
    mov  qword [rel g_reset_seq], 0
    call db_write_header
    call db_flush
    mov  rsp, rbp
    pop  rbp
    ret

; cdc_recover_reset() - called at open: complete a RESET that a crash cut short.
cdc_recover_reset:
    push rbp
    mov  rbp, rsp
    sub  rsp, 0x30
    cmp  qword [rel g_reset_pend], 0
    je   .none
    mov  rcx, [rel g_reset_seq]
    call cdc_finish_reset
.none:
    mov  rsp, rbp
    pop  rbp
    ret

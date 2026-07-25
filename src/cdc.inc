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

; cdc_lineage_make() - derive a 128-bit identity for a new database. This is an
;   identity check, not a security one: it only has to make two unrelated
;   databases collide with vanishing probability, so mixing the wall clock, the
;   high-resolution counter and the golden-ratio hash is enough.
cdc_lineage_make:
    push rbp
    mov  rbp, rsp
    sub  rsp, 0x30
    call os_now_ms
    mov  [rbp-8], rax
    call os_perf_counter
    mov  rdx, [rbp-8]
    mov  rcx, GOLDEN
    imul rax, rcx
    xor  rax, rdx
    mov  [rel g_lineage_lo], rax
    mov  rdx, rax
    call os_perf_counter
    mov  rcx, GOLDEN
    imul rax, rcx
    rol  rdx, 17
    xor  rax, rdx
    mov  [rel g_lineage_hi], rax
    mov  rsp, rbp
    pop  rbp
    ret

; cdc_hdr_write() - lay the file header at offset 0 and flush it.
cdc_hdr_write:
    push rbp
    mov  rbp, rsp
    sub  rsp, 0x40
    lea  rdi, [rel g_cdch_buf]
    mov  rcx, CDCH_SIZE
    mov  rdx, rdi
    mov  r8, rcx
    call mem_zero
    lea  rdi, [rel g_cdch_buf]
    mov  rax, [rel cdch_magic]
    mov  [rdi], rax
    mov  dword [rdi+CDCH_FMT], CDC_FORMAT
    mov  dword [rdi+CDCH_RECFMT], DB_VERSION
    mov  rax, [rel g_lineage_lo]
    mov  [rdi+CDCH_LINEAGE], rax
    mov  rax, [rel g_lineage_hi]
    mov  [rdi+CDCH_LINEAGE+8], rax
    mov  rax, [rel g_cdc_base]
    mov  [rdi+CDCH_BASESEQ], rax
    lea  rcx, [rel g_cdch_buf]
    mov  rdx, CDCH_CRC
    call crc32
    lea  rdi, [rel g_cdch_buf]
    mov  [rdi+CDCH_CRC], rax
    mov  rax, [rel cdch_trailer]
    mov  [rdi+CDCH_TRAILER], rax
    mov  rcx, [rel g_cdc_handle]
    xor  rdx, rdx
    lea  r8, [rel g_cdch_buf]
    mov  r9, CDCH_SIZE
    call cdc_write_all
    mov  rcx, [rel g_cdc_handle]
    call os_fsync
    test rax, rax
    jnz  io_fatal
    mov  rsp, rbp
    pop  rbp
    ret

; cdc_hdr_load() -> rax = 1 header present and valid / 0 legacy headerless log
;   Refuses outright on a damaged or foreign header.
cdc_hdr_load:
    push rbp
    mov  rbp, rsp
    sub  rsp, 0x40
    xor  rcx, rcx
    lea  rdx, [rel g_cdch_buf]
    mov  r8, CDCH_SIZE
    call cdc_read
    test rax, rax
    js   io_fatal_read
    cmp  rax, CDCH_SIZE
    jb   .legacy                     ; too short to hold a header
    lea  rdi, [rel g_cdch_buf]
    mov  rax, [rel cdch_magic]
    cmp  rax, [rdi]
    jne  .legacy                     ; starts with a frame -> pre-1.1 log
    mov  rax, [rel cdch_trailer]
    cmp  rax, [rdi+CDCH_TRAILER]
    jne  .bad
    lea  rcx, [rel g_cdch_buf]
    mov  rdx, CDCH_CRC
    call crc32
    lea  rdi, [rel g_cdch_buf]
    cmp  rax, [rdi+CDCH_CRC]
    jne  .bad
    cmp  dword [rdi+CDCH_FMT], CDC_FORMAT
    jne  .bad
    ; the log must belong to THIS database
    mov  rax, [rdi+CDCH_LINEAGE]
    cmp  rax, [rel g_lineage_lo]
    jne  .foreign
    mov  rax, [rdi+CDCH_LINEAGE+8]
    cmp  rax, [rel g_lineage_hi]
    jne  .foreign
    mov  rax, [rdi+CDCH_BASESEQ]
    mov  [rel g_cdc_base], rax
    mov  [rel g_cdc_lastseq], rax    ; frames start at base + 1
    mov  rax, 1
    jmp  .out
.legacy:
    mov  qword [rel g_cdc_legacy], 1
    mov  qword [rel g_cdc_base], 0
    xor  rax, rax
.out:
    mov  rsp, rbp
    pop  rbp
    ret
.foreign:
    lea  rcx, [rel s_err_cdc_lineage]
    jmp  .refuse
.bad:
    lea  rcx, [rel s_err_cdc_hdr]
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
    ; an empty file gets a fresh header starting at the current watermark, so a
    ; log the operator removed resumes verifiably instead of anonymously
    mov  rcx, rax
    call os_filesize
    test rax, rax
    js   io_fatal_read
    test rax, rax
    jnz  .existing
    mov  rax, [rel g_seq]
    mov  [rel g_cdc_base], rax
    mov  [rel g_cdc_lastseq], rax
    call cdc_hdr_write
    mov  qword [rel g_cdc_end], CDCH_SIZE
    jmp  .done
.existing:
    call cdc_hdr_load
    call cdc_scan
.done:
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
    mov  rcx, [rel g_cdc_handle]
    call os_filesize
    test rax, rax
    js   io_fatal_read
    mov  r13, rax                    ; file length
    xor  rbx, rbx                    ; cursor
    cmp  qword [rel g_cdc_legacy], 0
    jne  .scanning                   ; pre-1.1 log: frames start at byte 0
    mov  rbx, CDCH_SIZE
    mov  [rel g_cdc_end], rbx
.scanning:
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
    test rax, rax
    js   io_fatal_read               ; cannot read the log - never trim on that
    cmp  rax, CDC_HDR_SIZE
    jne  .trim
    mov  rax, [rel cdc_magic]
    cmp  rax, [rel g_cdc_hdrbuf]
    jne  .badframe                   ; garbage in the middle of the log
    mov  r12, [rel g_cdc_hdrbuf+8]   ; frame_size
    ; op_count must be something this build could have written, checked BEFORE
    ; it is multiplied out so a hostile value cannot overflow the arithmetic
    mov  rax, [rel g_cdc_hdrbuf+24]  ; op_count
    mov  rdx, CDC_MAX_OPS
    cmp  rax, rdx
    ja   .badframe
    ; unknown flags mean a newer writer; refuse rather than misread the frame
    mov  rdx, [rel g_cdc_hdrbuf+32]
    mov  rcx, ~CDC_FLAG_RESET
    test rdx, rcx
    jnz  .badframe
    ; a RESET carries no operations, by definition
    test rdx, CDC_FLAG_RESET
    jz   .notreset
    test rax, rax
    jnz  .badframe
.notreset:
    ; frame_size must match op_count exactly
    imul rax, rax, CDC_OP_SIZE
    add  rax, CDC_HDR_SIZE + CDC_TAIL_SIZE
    cmp  rax, r12
    jne  .badframe
    ; must fit in the file, else it is a torn tail
    mov  rax, rbx
    add  rax, r12
    cmp  rax, r13
    ja   .trim
    ; sequences are dense: the engine advances by exactly one per frame, so a
    ; gap means history was lost or altered, not merely reordered
    mov  rax, [rel g_cdc_hdrbuf+16]
    mov  rdx, [rel g_cdc_lastseq]
    inc  rdx
    cmp  rax, rdx
    jne  .badseq
    mov  [rbp-48], rax               ; this frame's seq
    ; verify trailer + checksum over the whole frame
    mov  rcx, r12
    call cdc_load_frame              ; rcx = size, reads at rbx into g_cdcbuf
    test rax, rax
    js   io_fatal_read
    jz   .trim
    mov  rsi, [rel g_cdcbuf]
    mov  rax, r12
    sub  rax, 8
    mov  rdx, [rel cdc_trailer]
    cmp  rdx, [rsi+rax]              ; trailer at frame_size-8
    jne  .badtrailer                 ; the frame FITS, so this is damage
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
.badtrailer:
    lea  rcx, [rel s_err_cdc_tail]
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

; cdc_load_frame(rcx = size) -> rax = 1 read in full, 0 short (torn), -1 error
;   Reads the frame at rbx into g_cdcbuf. Only sizes that fit the staging
;   buffer are accepted; a larger one cannot have been written by this build.
;   A short read and an I/O error are deliberately DIFFERENT answers: the first
;   means a crash cut an append short, the second means we cannot see the file,
;   and only the first may ever lead to trimming it.
cdc_load_frame:
    push rbp
    mov  rbp, rsp
    sub  rsp, 0x30
    mov  [rbp-8], rcx
    mov  rax, CDC_BUF_SIZE
    cmp  rcx, rax
    ja   .short                      ; larger than this build can write
    mov  rcx, rbx
    mov  rdx, [rel g_cdcbuf]
    mov  r8, [rbp-8]
    call cdc_read
    test rax, rax
    js   .error
    cmp  rax, [rbp-8]
    jne  .short
    mov  rax, 1
    jmp  .out
.short:
    xor  rax, rax
    jmp  .out
.error:
    mov  rax, -1
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

; cdc_seq_gate(rcx = seq) -> rax = 1 write it / 0 already published
;   Only two answers are legitimate, and anything else is an inconsistency we
;   must not paper over:
;     seq == lastseq      the crash happened after the append; skip it
;     seq == lastseq + 1  the next frame; write it
;   A lower sequence would rewrite history, and a higher one would leave a hole.
;   In particular a log that is artificially AHEAD would make every future
;   commit look "already published" while the data file kept moving - silent,
;   permanent divergence for a consumer. Refuse instead.
cdc_seq_gate:
    push rbp
    mov  rbp, rsp
    sub  rsp, 0x30
    mov  rax, [rel g_cdc_lastseq]
    cmp  rcx, rax
    je   .skip
    inc  rax
    cmp  rcx, rax
    je   .write
    lea  rcx, [rel s_err_cdc_gap]
    call puts
    lea  rcx, [rel g_cdcname]
    call puts
    lea  rcx, [rel s_nl]
    call puts
    lea  rcx, [rel s_cdc_hint]
    call puts
    mov  ecx, 1
    call os_exit
.write:
    mov  rax, 1
    jmp  .out
.skip:
    xor  rax, rax
.out:
    mov  rsp, rbp
    pop  rbp
    ret

; cdc_check_aligned() - after WAL replay and any pending RESET, the log and the
;   header must agree on where the stream is. They can legitimately disagree
;   *during* recovery (a crash between the append and the header write leaves
;   the log one ahead), which is why this runs last.
;   An empty log with a non-zero watermark is the one benign case: the operator
;   discarded the history, so we adopt the watermark and carry on - the next
;   frame is still strictly greater than anything a consumer ever saw.
cdc_check_aligned:
    push rbp
    mov  rbp, rsp
    sub  rsp, 0x30
    mov  rax, [rel g_cdc_lastseq]
    cmp  rax, [rel g_seq]
    jne  .mismatch
    mov  rsp, rbp
    pop  rbp
    ret
.mismatch:
    lea  rcx, [rel s_err_cdc_align]
    call puts
    lea  rcx, [rel g_cdcname]
    call puts
    lea  rcx, [rel s_nl]
    call puts
    lea  rcx, [rel s_cdc_hint]
    call puts
    mov  ecx, 1
    call os_exit

; cdc_emit_reset(rcx = commit_seq) - append a single RESET frame, unless a frame
;   with that sequence is already there (idempotent recovery).
cdc_emit_reset:
    push rbp
    mov  rbp, rsp
    sub  rsp, 0x40
    mov  [rbp-8], rcx
    call cdc_seq_gate
    test rax, rax
    jz   .already                    ; already published
    mov  rcx, [rbp-8]
    mov  rdx, CDC_FLAG_RESET
    call cdc_frame_begin
    mov  rdx, rdi
    xor  rcx, rcx                    ; no operations
    call cdc_frame_end
.already:
    mov  rsp, rbp
    pop  rbp
    ret

; cdc_emit_from_wal(rcx = entry base ptr, rdx = N, r8 = seq, r9 = flags)
;   Build a change frame from a v03 WAL frame. Doing it from the staged entries
;   - rather than from the undo log - is what makes the commit path and the
;   recovery path produce byte-identical frames.
;
;   Each entry can yield up to TWO operations, and that matters: when a slot's
;   tombstone is reused inside one transaction the row that used to live there
;   is gone, so the entry emits DELETE(prev_id) *and* UPSERT(new id). Emitting
;   only the final image would leave a consumer holding a row the database no
;   longer has.
cdc_emit_from_wal:
    push rbp
    mov  rbp, rsp
    sub  rsp, 0x70
    mov  [rbp-8], rbx
    mov  [rbp-16], rsi
    mov  [rbp-24], rdi
    mov  [rbp-32], r12
    mov  [rbp-40], r13
    mov  r12, rcx                    ; entries
    mov  r13, rdx                    ; N
    mov  [rbp-48], r9                ; flags
    mov  [rbp-56], r8                ; seq
    mov  rcx, r8
    call cdc_seq_gate
    test rax, rax
    jz   .already                    ; this commit is already in the log
    mov  rcx, [rbp-56]
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
    imul rax, rax, WAL_ENT_V3
    add  rax, r12                    ; entry i
    mov  [rbp-64], rax
    lea  rcx, [rax+WAL_ENT_IMAGE]    ; after-image
    mov  [rbp-72], rcx
    ; --- did a row that used to live here disappear? ---
    cmp  qword [rax+WAL_ENT_PREVST], ST_OCCUPIED
    jne  .after                      ; nothing was there before
    mov  rdx, [rax+WAL_ENT_PREVID]
    cmp  byte [rcx+REC_STATUS], ST_OCCUPIED
    jne  .emit_del                   ; still occupied? then compare identities
    cmp  rdx, [rcx+REC_ID]
    je   .after                      ; same row, just updated
.emit_del:
    mov  rax, [rbp-64]
    mov  rdx, [rax+WAL_ENT_PREVID]
    mov  qword [rdi], CDC_OP_DELETE
    mov  [rdi+8], rdx
    lea  rdx, [rdi+16]
    mov  r8, REC_SIZE
    call mem_zero
    add  rdi, CDC_OP_SIZE
    inc  rsi
.after:
    ; --- and is a row present now? ---
    mov  rcx, [rbp-72]
    cmp  byte [rcx+REC_STATUS], ST_OCCUPIED
    jne  .opdone
    mov  qword [rdi], CDC_OP_UPSERT
    mov  rax, [rcx+REC_ID]
    mov  [rdi+8], rax
    lea  rdx, [rdi+16]
    mov  r8, REC_SIZE
    call mem_copy                    ; rcx = src, rdx = dst, r8 = len
    add  rdi, CDC_OP_SIZE
    inc  rsi
.opdone:
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

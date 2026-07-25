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
    mov  qword [rbp-40], 0           ; 1 -> checksum present (v02/v03)
    mov  qword [rbp-48], WAL_HDR_V2  ; entry base
    mov  qword [rbp-56], 0           ; commit_seq (v03 only)
    mov  qword [rbp-64], 0           ; flags (v03 only)
    mov  qword [rbp-72], UNDO_ENTRY  ; entry stride
    mov  qword [rbp-80], 8           ; after-image offset within an entry
    mov  qword [rbp-88], 0           ; 1 -> the frame names its database (v04)
    mov  rax, [rel wal_magic4]
    cmp  rax, [rbx]
    je   .v4
    mov  rax, [rel wal_magic3]
    cmp  rax, [rbx]
    je   .v3
    mov  rax, [rel wal_magic2]
    cmp  rax, [rbx]
    je   .v2
    mov  rax, [rel wal_magic]        ; legacy frame written before checksums
    cmp  rax, [rbx]
    jne  .clear
    jmp  .magic_ok
.v4:
    mov  qword [rbp-88], 1
    mov  qword [rbp-40], 1
    mov  qword [rbp-48], WAL_HDR_V4
    mov  qword [rbp-72], WAL_ENT_V3
    mov  qword [rbp-80], WAL_ENT_IMAGE
    mov  rax, [rbx+24]
    mov  [rbp-56], rax               ; commit_seq
    mov  rax, [rbx+32]
    mov  [rbp-64], rax               ; flags
    jmp  .magic_ok
.v3:
    mov  qword [rbp-40], 1
    mov  qword [rbp-48], WAL_HDR_V3
    mov  qword [rbp-72], WAL_ENT_V3
    mov  qword [rbp-80], WAL_ENT_IMAGE
    mov  rax, [rbx+24]
    mov  [rbp-56], rax               ; commit_seq
    mov  rax, [rbx+32]
    mov  [rbp-64], rax               ; flags
    jmp  .magic_ok
.v2:
    mov  qword [rbp-40], 1
.magic_ok:
    mov  rsi, [rbx+8]                ; N
    cmp  rsi, UNDO_MAX
    ja   .clear
    ; marker offset = entry base + N * entry stride
    mov  rax, rsi
    imul rax, [rbp-72]
    add  rax, [rbp-48]               ; rax = marker offset
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
    ; From here the frame carries a valid marker AND a valid checksum, so the
    ; transaction WAS committed and acknowledged. Anything wrong with its
    ; contents from now on is a refusal to open, never a discard: dropping the
    ; log would silently erase an acknowledged commit.
    ;
    ; First: does this log even belong to this database? A v04 frame names its
    ; database, so a mismatch is refused outright. A log with no name at all
    ; (v01-v03) cannot be checked, so it is only trusted next to a database that
    ; already existed - replaying one into a file this process just created is
    ; how a stray <db>.wal used to import another database's rows, count and all.
    cmp  qword [rbp-88], 0
    je   .unnamed
    mov  rax, [rbx+WAL_LINEAGE]
    cmp  rax, [rel g_lineage_lo]
    jne  .foreign
    mov  rax, [rbx+WAL_LINEAGE+8]
    cmp  rax, [rel g_lineage_hi]
    jne  .foreign
    jmp  .owned
.unnamed:
    ; A committed frame that does not say which database it belongs to (v01-v03,
    ; written before 1.4). There is no way to tell a genuine crash log from one
    ; that wandered in from another database, and that ambiguity is exactly how
    ; a stray <db>.wal imported a foreign row set - live count included.
    ; Refusing loses nothing: the log is kept intact, and the engine build that
    ; wrote it can still replay it.
    jmp  .foreign
.owned:
    ; Every slot index must address a real slot - otherwise the redo below would
    ; write REC_SIZE bytes at an arbitrary file offset, growing the .dat past
    ; its region.
    xor  r12, r12
.chk:
    cmp  r12, rsi
    jae  .chk_done
    mov  rax, r12
    imul rax, [rbp-72]
    add  rax, [rbp-48]
    add  rax, rbx                    ; entry ptr
    mov  rdx, [rax]                  ; slot index
    mov  rcx, CAPACITY
    cmp  rdx, rcx
    jae  .impossible                 ; committed but unusable -> stop, keep log
    inc  r12
    jmp  .chk
.chk_done:
    ; also require the live count to be inside the table
    mov  rax, [rbx+16]
    mov  rcx, CAPACITY
    cmp  rax, rcx
    ja   .impossible
    ; The frame is committed and applicable. Publish it to the change log first
    ; if the crash happened before that step - cdc_emit_from_wal is a no-op when
    ; the sequence is already there, so replaying is safe any number of times.
    cmp  qword [rbp-56], 0
    je   .apply_start                ; pre-v03 frame: nothing to publish
    mov  rcx, rbx
    add  rcx, [rbp-48]               ; entries
    mov  rdx, rsi                    ; N
    mov  r8, [rbp-56]                ; commit_seq
    mov  r9, [rbp-64]                ; flags
    call cdc_emit_from_wal
.apply_start:
    ; committed: apply after-images to asmdb.dat
    xor  r12, r12                    ; i
.apply:
    cmp  r12, rsi
    jae  .apply_done
    mov  rax, r12
    imul rax, [rbp-72]
    add  rax, [rbp-48]
    add  rax, rbx                    ; entry ptr
    mov  rdi, [rax]                  ; index
    add  rax, [rbp-80]
    mov  rdx, rax                    ; image ptr
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
    mov  rax, [rbp-56]
    test rax, rax
    jz   .nowm
    mov  [rel g_seq], rax            ; publish the recovered watermark
.nowm:
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
.impossible:
    ; Committed and intact, but describing something this build cannot apply -
    ; a slot outside the table, or a row count larger than the table. Keep the
    ; log and stop, exactly as for a checksum failure: the one thing we must
    ; never do with an acknowledged commit is throw it away.
    lea  rcx, [rel s_err_walbad]
    call puts
    lea  rcx, [rel g_walname]
    call puts
    lea  rcx, [rel s_nl]
    call puts
    lea  rcx, [rel s_walcrc_hint]
    call puts
    mov  ecx, 1
    call os_exit

.foreign:
    ; A committed log that belongs to a different database, or an unnamed one
    ; sitting next to a database this process just created. Replaying it would
    ; import someone else's rows AND their row count; deleting it would destroy
    ; an acknowledged commit that may still be the only copy. So neither: stop
    ; and let the operator decide which file is the wrong one.
    lea  rcx, [rel s_err_walown]
    call puts
    lea  rcx, [rel g_walname]
    call puts
    lea  rcx, [rel s_nl]
    call puts
    lea  rcx, [rel s_walown_hint]
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
    mov  qword [rel g_txn_reset], 0  ; start from a clean slate
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

; txn_flush() - make the open transaction durable, publish it to the change log,
;   then checkpoint it into the .dat.
;
;   The order is what buys the CDC guarantees:
;     1. stage only the slots that ACTUALLY changed, with their final image;
;     2. write the WAL frame (carrying commit_seq and flags) and flush;
;     3. write the commit marker + checksum and flush - committed at this point;
;     4. append the change frame and flush - so an acknowledged commit is in the
;        log BEFORE it is in the data file, and recovery can only ever have to
;        add a frame, never remove one;
;     5. apply the images to the .dat;
;     6. publish last_commit_seq in the header and flush;
;     7. truncate the WAL.
;
;   Staging only real changes is what makes step 4 exact: the after-image's
;   status says UPSERT or DELETE, so the commit path and the recovery path build
;   byte-identical frames. A transaction that changed nothing produces no frame
;   and consumes no sequence.
;   Shared by explicit COMMIT and by autocommit. Clears the transaction state.
txn_flush:
    push rbp
    mov  rbp, rsp
    sub  rsp, 0x70
    mov  [rbp-8], rbx
    mov  [rbp-16], rsi
    mov  [rbp-24], rdi
    mov  [rbp-32], r12
    mov  [rbp-40], r13
    mov  rbx, [rel g_walbuf]
    ; ---- stage the changed slots ----
    xor  r12, r12                    ; source undo index
    xor  r13, r13                    ; staged count
    lea  rdi, [rbx+WAL_HDR_V4]
.stage:
    cmp  r12, [rel g_undo_n]
    jae  .staged
    mov  rax, r12
    imul rax, rax, UNDO_ENTRY
    add  rax, [rel g_undo]           ; undo entry i
    mov  rcx, [rax]                  ; slot index
    lea  rsi, [rax+8]                ; before-image
    mov  [rbp-48], rcx
    mov  rdx, rcx
    shl  rdx, REC_SHIFT
    add  rdx, [rel g_table]          ; live slot ptr (after-image)
    mov  [rbp-56], rdx
    ; skip rows whose final state matches the state we captured
    mov  rcx, rsi
    call slot_changed                ; rcx = before, rdx = after
    test rax, rax
    jz   .skip
    mov  rax, [rbp-48]
    mov  [rdi], rax                  ; slot index
    mov  rax, [rsi+REC_ID]
    mov  [rdi+WAL_ENT_PREVID], rax   ; what the slot held before
    movzx eax, byte [rsi+REC_STATUS]
    mov  [rdi+WAL_ENT_PREVST], rax
    mov  rcx, [rbp-56]
    lea  rdx, [rdi+WAL_ENT_IMAGE]
    mov  r8, REC_SIZE
    call mem_copy                    ; final image
    add  rdi, WAL_ENT_V3
    inc  r13
.skip:
    inc  r12
    jmp  .stage
.staged:
    ; nothing actually changed -> no frame, no sequence, no log entry
    test r13, r13
    jnz  .havechanges
    cmp  qword [rel g_txn_reset], 0
    jne  .havechanges                ; a RESET is a change even with no rows
    call wal_truncate
    jmp  .finish
.havechanges:
    ; ---- frame header ----
    mov  rax, [rel wal_magic4]
    mov  [rbx], rax                  ; +0  magic
    mov  [rbx+8], r13                ; +8  N (staged, not captured)
    mov  rax, [rel g_count]
    mov  [rbx+16], rax               ; +16 new live count
    mov  rax, [rel g_seq]
    inc  rax
    mov  [rbp-64], rax               ; commit_seq
    mov  [rbx+24], rax               ; +24 commit_seq
    xor  rax, rax
    cmp  qword [rel g_txn_reset], 0
    je   .noreset
    mov  rax, CDC_FLAG_RESET
.noreset:
    mov  [rbx+32], rax               ; +32 flags
    mov  rax, [rel g_lineage_lo]
    mov  [rbx+WAL_LINEAGE], rax      ; +40 which database this log belongs to
    mov  rax, [rel g_lineage_hi]
    mov  [rbx+WAL_LINEAGE+8], rax
    ; ---- write and flush the frame ----
    mov  rsi, rdi                    ; marker slot
    sub  rdi, rbx                    ; marker offset = data length
    xor  rcx, rcx
    mov  rdx, rbx
    mov  r8, rdi
    call wal_write
    call wal_flush
    ; Commit record = 'COMMIT01' + CRC32 of everything before it, in ONE
    ; write+flush, so a frame can never be committed without its checksum.
    mov  rax, [rel wal_commit]
    mov  [rsi], rax
    mov  rcx, rbx
    mov  rdx, rdi
    call crc32
    mov  [rsi+8], rax
    mov  rcx, rdi
    mov  rdx, rsi
    mov  r8, 16
    call wal_write
    call wal_flush                   ; committed
    ; ---- publish to the change log BEFORE touching the data file ----
    lea  rcx, [rbx+WAL_HDR_V4]
    mov  rdx, r13
    mov  r8, [rbp-64]
    xor  r9, r9
    cmp  qword [rel g_txn_reset], 0
    je   .cdcgo
    mov  r9, CDC_FLAG_RESET
.cdcgo:
    call cdc_emit_from_wal
    ; ---- apply the staged images to the .dat ----
    xor  r12, r12
.apply:
    cmp  r12, r13
    jae  .applied
    mov  rax, r12
    imul rax, rax, WAL_ENT_V3
    add  rax, rbx
    add  rax, WAL_HDR_V4             ; staged entry i
    mov  rdi, [rax]                  ; slot index
    lea  rdx, [rax+WAL_ENT_IMAGE]    ; image
    mov  rcx, rdi
    shl  rcx, REC_SHIFT
    add  rcx, HDR_SIZE               ; file offset
    mov  r8, REC_SIZE
    call write_at
    cmp  rax, REC_SIZE
    jne  io_fatal                    ; the WAL is committed; the checkpoint must
                                     ; not silently half-apply
    inc  r12
    jmp  .apply
.applied:
    mov  rax, [rbp-64]
    mov  [rel g_seq], rax            ; publish the watermark
    call db_write_header
    call db_flush
    call wal_truncate                ; checkpoint complete
.finish:
    mov  qword [rel g_in_txn], 0
    mov  qword [rel g_undo_n], 0
    mov  qword [rel g_txn_reset], 0
    mov  r13, [rbp-40]
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
    mov  qword [rel g_txn_reset], 0
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
    mov  qword [rel g_txn_reset], 0  ; a rolled-back TRUNCATE must not leave a
                                     ; reset armed for the NEXT commit to emit
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

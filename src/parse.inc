; -----------------------------------------------------------------------------
; src/parse.inc - tokenizer, integer parsing, command dispatch and handlers.
; RSI is used as the line cursor throughout dispatch/handlers.
; -----------------------------------------------------------------------------

; skip_spaces_rsi() - advance rsi past spaces/tabs
skip_spaces_rsi:
    mov  al, [rsi]
    cmp  al, ' '
    je   .adv
    cmp  al, 9
    je   .adv
    ret
.adv:
    inc  rsi
    jmp  skip_spaces_rsi

; advance_token() - advance rsi to end of current token
advance_token:
    mov  al, [rsi]
    test al, al
    je   .done
    cmp  al, ' '
    je   .done
    cmp  al, 9
    je   .done
    inc  rsi
    jmp  advance_token
.done:
    ret

; token_eq(rsi = text, rdi = UPPERCASE keyword) -> rax = 1/0. Preserves rsi/rdi.
token_eq:
    push rsi
    push rdi
.cmp:
    mov  al, [rdi]
    test al, al
    je   .kwend
    mov  dl, [rsi]
    cmp  dl, 'a'
    jb   .noup
    cmp  dl, 'z'
    ja   .noup
    sub  dl, 32
.noup:
    cmp  al, dl
    jne  .no
    inc  rsi
    inc  rdi
    jmp  .cmp
.kwend:
    mov  dl, [rsi]
    test dl, dl
    je   .yes
    cmp  dl, ' '
    je   .yes
    cmp  dl, 9
    je   .yes
    jmp  .no
.yes:
    pop  rdi
    pop  rsi
    mov  rax, 1
    ret
.no:
    pop  rdi
    pop  rsi
    xor  rax, rax
    ret

; parse_u64() - parse decimal at rsi -> rax = value, rdx = 1 ok / 0 err, rsi advanced
;   Rejects values that do not fit in 64 bits. Wrapping silently would be a
;   correctness hole for a primary key: "18446744073709551617" would otherwise
;   parse as id 1 and collide with a real row.
;
;   The number must also end on a token boundary. Stopping at the first
;   non-digit would make "DELETE 42junk" delete row 42 and "RANGE 1x 5" scan
;   from 1: the operator asked for something the engine cannot express, and
;   guessing at their intent is worse than refusing.
parse_u64:
    xor  rax, rax
    xor  r9, r9
    mov  r10, 0x1999999999999999     ; (2^64 - 1) / 10
.loop:
    movzx ecx, byte [rsi]
    cmp  cl, '0'
    jb   .end
    cmp  cl, '9'
    ja   .end
    cmp  rax, r10
    ja   .err                        ; x10 would already overflow
    imul rax, rax, 10
    sub  cl, '0'
    movzx rcx, cl
    add  rax, rcx
    jc   .err                        ; carry out of 64 bits
    inc  rsi
    inc  r9
    jmp  .loop
.end:
    test r9, r9
    jz   .err                        ; no digits at all
    movzx ecx, byte [rsi]
    test cl, cl
    je   .ok
    cmp  cl, ' '
    je   .ok
    cmp  cl, 9
    je   .ok
    jmp  .err                        ; trailing junk glued to the number
.ok:
    mov  rdx, 1
    ret
.err:
    xor  rdx, rdx
    ret

; parse_i64() - optional leading '-' then decimal -> rax value, rdx ok flag
;   Bounded to [INT64_MIN, INT64_MAX]. The stored column is signed, so a
;   positive literal above INT64_MAX must be a syntax error rather than a
;   negative row value the caller never asked for.
parse_i64:
    mov  al, [rsi]
    cmp  al, '-'
    jne  .pos
    inc  rsi
    call parse_u64
    test rdx, rdx
    jz   .err
    mov  rcx, 0x8000000000000000     ; |INT64_MIN|
    cmp  rax, rcx
    ja   .err                        ; magnitude too large to negate
    neg  rax
    mov  rdx, 1
    ret
.pos:
    call parse_u64
    test rdx, rdx
    jz   .err
    mov  rcx, 0x7FFFFFFFFFFFFFFF
    cmp  rax, rcx
    ja   .err                        ; would land in the negative half
    mov  rdx, 1
    ret
.err:
    xor  rdx, rdx
    ret

; parse_tok(rdi = dest, rdx = max) - copy a space-delimited token from rsi,
; zero-pad to max -> rax = length (<= max). rsi stops at first unconsumed byte.
parse_tok:
    xor  rcx, rcx
.loop:
    cmp  rcx, rdx
    jae  .fill
    movzx eax, byte [rsi]
    test al, al
    je   .fill
    cmp  al, ' '
    je   .fill
    cmp  al, 9
    je   .fill
    mov  [rdi+rcx], al
    inc  rsi
    inc  rcx
    jmp  .loop
.fill:
    mov  r8, rcx                     ; length
.z:
    cmp  rcx, rdx
    jae  .done
    mov  byte [rdi+rcx], 0
    inc  rcx
    jmp  .z
.done:
    mov  rax, r8
    ret

; parse_rest(rdi = dest, rdx = max) - copy rest-of-line from rsi verbatim
; (internal spaces kept), zero-pad to max -> rax = length (<= max).
parse_rest:
    xor  rcx, rcx
.loop:
    cmp  rcx, rdx
    jae  .fill
    movzx eax, byte [rsi]
    test al, al
    je   .fill
    mov  [rdi+rcx], al
    inc  rsi
    inc  rcx
    jmp  .loop
.fill:
    mov  r8, rcx
.z:
    cmp  rcx, rdx
    jae  .done
    mov  byte [rdi+rcx], 0
    inc  rcx
    jmp  .z
.done:
    mov  rax, r8
    ret

; now_ms() -> rax = current time in unix epoch milliseconds
now_ms:
    jmp  os_now_ms

; -------------------------- table rendering ---------------------------------

; put_label(rcx = zptr, rdx = width) - print label then right-pad to width
put_label:
    push rbp
    mov  rbp, rsp
    sub  rsp, 0x40
    mov  [rbp-8], rbx
    mov  [rbp-16], rsi
    mov  rsi, rcx
    mov  rbx, rdx
    xor  rax, rax
.l:
    cmp  byte [rsi+rax], 0
    je   .go
    inc  rax
    jmp  .l
.go:
    mov  [rbp-24], rax
    mov  rcx, rsi
    mov  rdx, rax
    call putn
    mov  rcx, rbx
    sub  rcx, [rbp-24]
    jle  .np
    call put_spaces
.np:
    mov  rsi, [rbp-16]
    mov  rbx, [rbp-8]
    mov  rsp, rbp
    pop  rbp
    ret

; tbl_sep() - print +----+----+----+ separator row
tbl_sep:
    push rbp
    mov  rbp, rsp
    sub  rsp, 0x30
    lea  rcx, [rel c_grey]
    call set_color
    mov  cl, '+'
    call putc
    mov  cl, '-'
    mov  rdx, W_ID+2
    call put_repeat
    mov  cl, '+'
    call putc
    mov  cl, '-'
    mov  rdx, W_TAG+2
    call put_repeat
    mov  cl, '+'
    call putc
    mov  cl, '-'
    mov  rdx, W_VAL+2
    call put_repeat
    mov  cl, '+'
    call putc
    mov  cl, '-'
    mov  rdx, W_CONTENT+2
    call put_repeat
    mov  cl, '+'
    call putc
    call reset_color
    call crlf
    mov  rsp, rbp
    pop  rbp
    ret

; tbl_head() - print the column header row
tbl_head:
    push rbp
    mov  rbp, rsp
    sub  rsp, 0x30
    lea  rcx, [rel c_cyan]
    call set_color
    lea  rcx, [rel s_cell_l]
    call puts
    lea  rcx, [rel s_lbl_id]
    mov  rdx, W_ID
    call put_label
    lea  rcx, [rel s_cell_m]
    call puts
    lea  rcx, [rel s_lbl_tag]
    mov  rdx, W_TAG
    call put_label
    lea  rcx, [rel s_cell_m]
    call puts
    lea  rcx, [rel s_lbl_val]
    mov  rdx, W_VAL
    call put_label
    lea  rcx, [rel s_cell_m]
    call puts
    lea  rcx, [rel s_lbl_content]
    mov  rdx, W_CONTENT
    call put_label
    lea  rcx, [rel s_cell_r]
    call puts
    call reset_color
    call crlf
    mov  rsp, rbp
    pop  rbp
    ret

; print_row(rcx = record ptr)
print_row:
    push rbp
    mov  rbp, rsp
    sub  rsp, 0x40
    mov  [rbp-8], rcx
    lea  rcx, [rel s_cell_l]
    call puts
    mov  rcx, [rbp-8]
    mov  rcx, [rcx+REC_ID]
    mov  rdx, W_ID
    call put_u64_field
    lea  rcx, [rel s_cell_m]
    call puts
    mov  rcx, [rbp-8]
    lea  rcx, [rcx+REC_TAG]
    mov  rdx, W_TAG
    call put_field
    lea  rcx, [rel s_cell_m]
    call puts
    mov  rcx, [rbp-8]
    mov  rcx, [rcx+REC_VALUE]
    mov  rdx, W_VAL
    call put_i64_field
    lea  rcx, [rel s_cell_m]
    call puts
    mov  rcx, [rbp-8]
    lea  rcx, [rcx+REC_CONTENT]
    mov  rdx, W_CONTENT
    call put_field
    lea  rcx, [rel s_cell_r]
    call puts
    call crlf
    mov  rsp, rbp
    pop  rbp
    ret

; print_detail(rcx = record ptr) - full single-row view for SELECT <id>
print_detail:
    push rbp
    mov  rbp, rsp
    sub  rsp, 0x30
    mov  [rbp-8], rbx
    mov  rbx, rcx                    ; slot
    call crlf
    lea  rcx, [rel s_det_id]
    lea  rdx, [rel c_grey]
    call puts_col
    mov  rcx, [rbx+REC_ID]
    lea  rdx, [rel c_white]
    call set_color
    call put_u64
    call reset_color
    call crlf
    lea  rcx, [rel s_det_tag]
    lea  rdx, [rel c_grey]
    call puts_col
    lea  rcx, [rbx+REC_TAG]
    lea  rdx, [rel c_cyan]
    call puts_col
    call crlf
    lea  rcx, [rel s_det_value]
    lea  rdx, [rel c_grey]
    call puts_col
    mov  rcx, [rbx+REC_VALUE]
    xor  rdx, rdx
    call put_i64_field
    call crlf
    lea  rcx, [rel s_det_created]
    lea  rdx, [rel c_grey]
    call puts_col
    mov  rcx, [rbx+REC_CREATED]
    call put_u64
    lea  rcx, [rel s_det_ms]
    call puts
    call crlf
    lea  rcx, [rel s_det_updated]
    lea  rdx, [rel c_grey]
    call puts_col
    mov  rcx, [rbx+REC_UPDATED]
    call put_u64
    lea  rcx, [rel s_det_ms]
    call puts
    call crlf
    lea  rcx, [rel s_det_content]
    lea  rdx, [rel c_grey]
    call puts_col
    lea  rcx, [rbx+REC_CONTENT]
    mov  edx, dword [rbx+REC_CLEN]
    call putn
    call crlf
    call crlf
    mov  rbx, [rbp-8]
    mov  rsp, rbp
    pop  rbp
    ret

; -------------------------- command handlers --------------------------------

; cmd_insert() - INSERT <id> <value> <tag> <content...>
cmd_insert:
    push rbp
    mov  rbp, rsp
    sub  rsp, 0x60
    mov  [rbp-8], rbx
    mov  [rbp-16], rsi
    mov  [rbp-24], rdi
    call skip_spaces_rsi
    call parse_u64
    test rdx, rdx
    jz   .syntax
    mov  [rbp-32], rax               ; id
    test rax, rax
    jz   .badid
    call skip_spaces_rsi
    call parse_i64
    test rdx, rdx
    jz   .syntax
    mov  [rbp-40], rax               ; value
    call skip_spaces_rsi
    lea  rdi, [rel g_tagbuf]
    mov  rdx, TAG_MAX-1
    call parse_tok
    call advance_token               ; drop any overflow of a long tag token
    call skip_spaces_rsi
    lea  rdi, [rel g_contentbuf]
    mov  rdx, CONTENT_MAX-1
    call parse_rest
    mov  [rbp-48], rax               ; content length
    mov  rcx, [rbp-32]
    call store_locate                ; rax=found, rdx=insert
    test rax, rax
    jnz  .dup
    test rdx, rdx
    jz   .full
    mov  rbx, rdx                    ; target slot (preserved across calls)
    call auto_begin                  ; implicit txn unless already inside one
    mov  rcx, rbx
    call txn_capture                 ; record undo image
    test rax, rax
    jz   .toobig
    mov  rax, [rbp-32]
    mov  [rbx+REC_ID], rax
    mov  byte [rbx+REC_STATUS], ST_OCCUPIED
    mov  byte [rbx+REC_KIND], KIND_GENERIC
    mov  eax, [rbp-48]
    mov  [rbx+REC_CLEN], eax
    call now_ms
    mov  [rbx+REC_CREATED], rax
    mov  [rbx+REC_UPDATED], rax
    mov  rax, [rbp-40]
    mov  [rbx+REC_VALUE], rax
    lea  rsi, [rel g_tagbuf]
    lea  rdi, [rbx+REC_TAG]
    mov  rcx, TAG_MAX
    rep  movsb
    lea  rsi, [rel g_contentbuf]
    lea  rdi, [rbx+REC_CONTENT]
    mov  rcx, CONTENT_MAX
    rep  movsb
    inc  qword [rel g_count]
    call auto_commit                 ; durable through the WAL; no-op in a txn
    lea  rcx, [rel s_ok_ins]
    call puts
    jmp  .done
.toobig:
    lea  rcx, [rel s_txn_toobig]
    call puts
    jmp  .done
.dup:
    lea  rcx, [rel s_err_dup]
    call puts
    jmp  .done
.badid:
    lea  rcx, [rel s_err_check]
    call puts
    jmp  .done
.full:
    lea  rcx, [rel s_err_full]
    call puts
    jmp  .done
.syntax:
    lea  rcx, [rel s_err_syntax]
    call puts
.done:
    mov  rdi, [rbp-24]
    mov  rsi, [rbp-16]
    mov  rbx, [rbp-8]
    mov  rsp, rbp
    pop  rbp
    ret

; cmd_update() - UPDATE <id> <value> <tag> <content...>
cmd_update:
    push rbp
    mov  rbp, rsp
    sub  rsp, 0x60
    mov  [rbp-8], rbx
    mov  [rbp-16], rsi
    mov  [rbp-24], rdi
    call skip_spaces_rsi
    call parse_u64
    test rdx, rdx
    jz   .syntax
    mov  [rbp-32], rax
    test rax, rax
    jz   .badid
    call skip_spaces_rsi
    call parse_i64
    test rdx, rdx
    jz   .syntax
    mov  [rbp-40], rax
    call skip_spaces_rsi
    lea  rdi, [rel g_tagbuf]
    mov  rdx, TAG_MAX-1
    call parse_tok
    call advance_token
    call skip_spaces_rsi
    lea  rdi, [rel g_contentbuf]
    mov  rdx, CONTENT_MAX-1
    call parse_rest
    mov  [rbp-48], rax               ; content length
    mov  rcx, [rbp-32]
    call store_locate
    test rax, rax
    jz   .notfound
    mov  rbx, rax                    ; slot (preserved)
    call auto_begin
    mov  rcx, rbx
    call txn_capture
    test rax, rax
    jz   .toobig
    mov  eax, [rbp-48]
    mov  [rbx+REC_CLEN], eax
    call now_ms
    mov  [rbx+REC_UPDATED], rax      ; created is left untouched
    mov  rax, [rbp-40]
    mov  [rbx+REC_VALUE], rax
    lea  rsi, [rel g_tagbuf]
    lea  rdi, [rbx+REC_TAG]
    mov  rcx, TAG_MAX
    rep  movsb
    lea  rsi, [rel g_contentbuf]
    lea  rdi, [rbx+REC_CONTENT]
    mov  rcx, CONTENT_MAX
    rep  movsb
    call auto_commit
    lea  rcx, [rel s_ok_upd]
    call puts
    jmp  .done
.toobig:
    lea  rcx, [rel s_txn_toobig]
    call puts
    jmp  .done
.notfound:
    lea  rcx, [rel s_err_nf]
    call puts
    jmp  .done
.badid:
    lea  rcx, [rel s_err_check]
    call puts
    jmp  .done
.syntax:
    lea  rcx, [rel s_err_syntax]
    call puts
.done:
    mov  rdi, [rbp-24]
    mov  rsi, [rbp-16]
    mov  rbx, [rbp-8]
    mov  rsp, rbp
    pop  rbp
    ret

; cmd_delete() - DELETE <id>
cmd_delete:
    push rbp
    mov  rbp, rsp
    sub  rsp, 0x40
    mov  [rbp-16], rsi
    mov  [rbp-24], rdi
    call skip_spaces_rsi
    call parse_u64
    test rdx, rdx
    jz   .syntax
    mov  rcx, rax
    call store_locate
    test rax, rax
    jz   .notfound
    mov  rdi, rax
    call auto_begin
    mov  rcx, rdi
    call txn_capture
    test rax, rax
    jz   .toobig
    mov  byte [rdi+REC_STATUS], ST_DELETED
    dec  qword [rel g_count]
    call auto_commit
    lea  rcx, [rel s_ok_del]
    call puts
    jmp  .done
.toobig:
    lea  rcx, [rel s_txn_toobig]
    call puts
    jmp  .done
.notfound:
    lea  rcx, [rel s_err_nf]
    call puts
    jmp  .done
.syntax:
    lea  rcx, [rel s_err_syntax]
    call puts
.done:
    mov  rdi, [rbp-24]
    mov  rsi, [rbp-16]
    mov  rsp, rbp
    pop  rbp
    ret

; cmd_truncate() - TRUNCATE : empty the table (every live row -> deleted).
;   Autocommit: clears the slots in RAM then does ONE durable whole-region
;   checkpoint (single fsync), and reports how many rows were removed.
;   In a transaction: each live row's before-image is captured in the undo log
;   so ROLLBACK restores the whole table; the change is applied to disk by
;   COMMIT.
;   Inside a transaction the capture runs as a SEPARATE first pass: if the undo
;   log cannot hold every live row, the command fails having modified nothing,
;   instead of leaving the table half-cleared with a stale row count. That pass
;   is the only admission check needed - a `count + undo_n > UNDO_MAX` estimate
;   would double-count rows this transaction has already captured (captures are
;   de-duplicated per slot) and refuse truncates that actually fit.
cmd_truncate:
    push rbp
    mov  rbp, rsp
    sub  rsp, 0x40
    mov  [rbp-8], rbx                ; slot index
    mov  [rbp-16], rsi
    mov  [rbp-24], rdi
    cmp  qword [rel g_in_txn], 0
    je   .autoreset
    ; pass 1 - capture every live row before touching any of them
    mov  rax, [rel g_undo_n]
    mov  [rbp-40], rax               ; undo watermark, to unwind a refusal
    xor  rbx, rbx
.cap:
    cmp  rbx, CAPACITY
    jae  .marked
    mov  rax, rbx
    shl  rax, REC_SHIFT
    add  rax, [rel g_table]
    cmp  byte [rax+REC_STATUS], ST_OCCUPIED
    jne  .capnext
    mov  rcx, rax
    call txn_capture
    test rax, rax
    jz   .unwind                     ; nothing cleared yet - safe to abort
.capnext:
    inc  rbx
    jmp  .cap
.marked:
    ; Inside a transaction the reset is only *declared*; COMMIT turns it into a
    ; single RESET frame, so a ROLLBACK emits nothing at all.
    mov  qword [rel g_txn_reset], 1
    jmp  .go
.autoreset:
    ; Outside a transaction this is a durable boundary of its own: announce it
    ; in the header BEFORE touching the table, so a crash halfway still yields
    ; exactly one RESET on the next open.
    call cdc_mark_reset
    mov  [rbp-48], rax               ; the sequence the RESET will carry
.go:
    xor  rbx, rbx                    ; index
    mov  qword [rbp-32], 0           ; removed count
.loop:
    cmp  rbx, CAPACITY
    jae  .loopend
    mov  rax, rbx
    shl  rax, REC_SHIFT
    add  rax, [rel g_table]          ; slot ptr
    cmp  byte [rax+REC_STATUS], ST_OCCUPIED
    jne  .lnext
    mov  rdi, rax                    ; live slot
    mov  byte [rdi+REC_STATUS], ST_DELETED
    inc  qword [rbp-32]
    cmp  qword [rel g_in_txn], 0
    jne  .lnext
    mov  rcx, rdi                    ; autocommit: persist just this cleared slot
    call db_write_slot
.lnext:
    inc  rbx
    jmp  .loop
.loopend:
    mov  rax, [rel g_count]
    sub  rax, [rbp-32]
    mov  [rel g_count], rax
    cmp  qword [rel g_in_txn], 0
    jne  .deferred
    ; autocommit: refresh header row-count and fsync once, then publish the
    ; RESET and clear the pending flag - in that order, so the frame is durable
    ; before we stop advertising that one is owed
    call db_write_header
    call db_flush
    mov  rcx, [rbp-48]
    call cdc_finish_reset
.deferred:
    lea  rcx, [rel s_ok_trunc]
    call puts
    mov  rcx, [rbp-32]
    call put_u64
    lea  rcx, [rel s_trunc_post]
    call puts
    jmp  .tdone
.toobig:
    lea  rcx, [rel s_txn_toobig]
    call puts
    jmp  .tdone
.unwind:
    ; The command changed nothing, so the transaction must look untouched too.
    ; Leaving the partial captures behind would keep the undo log artificially
    ; full, make COMMIT stage thousands of unchanged after-images, and (with
    ; change capture) invent events for rows that never moved.
    mov  rax, [rbp-40]
    mov  [rel g_undo_n], rax
    lea  rcx, [rel s_txn_toobig]
    call puts
.tdone:
    mov  rdi, [rbp-24]
    mov  rsi, [rbp-16]
    mov  rbx, [rbp-8]
    mov  rsp, rbp
    pop  rbp
    ret

; --------------------- listing: format and paging ---------------------------
;
; Every listing command (SELECT *, FIND, RANGE) shares the same emission path so
; that a machine consumer sees one protocol. In TABLE mode nothing changed. In
; TSV mode rows are emitted verbatim and terminated by a status line, which is
; what lets a reader know the result set is complete.

; list_start() - reset the page cursor and, in TABLE mode, open the frame.
list_start:
    push rbp
    mov  rbp, rsp
    sub  rsp, 0x30
    mov  rax, [rel g_page_offset]
    mov  [rel g_list_skip], rax
    mov  qword [rel g_list_n], 0
    mov  rsp, rbp
    pop  rbp
    ret

; list_full() -> rax = 1 once the page limit has been reached.
list_full:
    xor  eax, eax
    mov  rcx, [rel g_page_limit]
    test rcx, rcx
    jz   .no                         ; 0 = unlimited
    cmp  [rel g_list_n], rcx
    jb   .no
    mov  eax, 1
.no:
    ret

; list_skip() -> rax = 1 when the current row falls before the page offset
; (and consumes one unit of it). Callers must test this before opening the
; table frame, otherwise a fully skipped page would still print a header.
list_skip:
    mov  rax, [rel g_list_skip]
    test rax, rax
    jz   .keep
    dec  rax
    mov  [rel g_list_skip], rax
    mov  eax, 1
    ret
.keep:
    xor  eax, eax
    ret

; list_row(rcx = slot ptr) - emit one row in the active format and count it.
list_row:
    push rbp
    mov  rbp, rsp
    sub  rsp, 0x30
    cmp  qword [rel g_fmt_tsv], 0
    jne  .tsv
    call print_row
    jmp  .counted
.tsv:
    call tsv_row
.counted:
    inc  qword [rel g_list_n]
    mov  rsp, rbp
    pop  rbp
    ret

; list_report() - in TSV mode, terminate the result set with a row count.
list_report:
    push rbp
    mov  rbp, rsp
    sub  rsp, 0x30
    cmp  qword [rel g_fmt_tsv], 0
    je   .out
    lea  rcx, [rel s_rows_pre]
    call puts
    mov  rcx, [rel g_list_n]
    call put_u64
    lea  rcx, [rel s_rows_post]
    call puts
.out:
    mov  rsp, rbp
    pop  rbp
    ret

; cmd_format() - FORMAT TABLE | TSV
cmd_format:
    push rbp
    mov  rbp, rsp
    sub  rsp, 0x30
    mov  [rbp-16], rsi
    call skip_spaces_rsi
    lea  rdi, [rel kw_tsv]
    call token_eq
    test rax, rax
    jnz  .tsv
    lea  rdi, [rel kw_table]
    call token_eq
    test rax, rax
    jnz  .table
    lea  rcx, [rel s_err_syntax]
    call puts
    jmp  .out
.tsv:
    mov  qword [rel g_fmt_tsv], 1
    lea  rcx, [rel s_fmt_tsv]
    call puts
    jmp  .out
.table:
    mov  qword [rel g_fmt_tsv], 0
    lea  rcx, [rel s_fmt_table]
    call puts
.out:
    mov  rsi, [rbp-16]
    mov  rsp, rbp
    pop  rbp
    ret

; cmd_page() - PAGE <limit> <offset> : bound the listing commands.
; PAGE 0 0 restores the unlimited default.
cmd_page:
    push rbp
    mov  rbp, rsp
    sub  rsp, 0x40
    mov  [rbp-16], rsi
    call skip_spaces_rsi
    call parse_u64
    test rdx, rdx
    jz   .syntax
    mov  rcx, PAGE_LIMIT_MAX
    cmp  rax, rcx
    ja   .syntax
    mov  [rbp-24], rax
    call skip_spaces_rsi
    call parse_u64
    test rdx, rdx
    jz   .syntax
    mov  rcx, CAPACITY
    cmp  rax, rcx
    ja   .syntax
    mov  [rel g_page_offset], rax
    mov  rax, [rbp-24]
    mov  [rel g_page_limit], rax
    lea  rcx, [rel s_page_set]
    call puts
    jmp  .out
.syntax:
    lea  rcx, [rel s_err_syntax]
    call puts
.out:
    mov  rsi, [rbp-16]
    mov  rsp, rbp
    pop  rbp
    ret

; cmd_select() - SELECT <id> | SELECT *
cmd_select:
    push rbp
    mov  rbp, rsp
    sub  rsp, 0x50
    mov  [rbp-8], rbx
    mov  [rbp-16], rsi
    mov  [rbp-24], rdi
    call skip_spaces_rsi
    mov  al, [rsi]
    cmp  al, '*'
    je   .all
    test al, al
    je   .syntax
    call parse_u64
    test rdx, rdx
    jz   .syntax
    mov  rcx, rax
    call store_locate
    test rax, rax
    jz   .notfound
    mov  rcx, rax
    cmp  qword [rel g_fmt_tsv], 0
    jne  .one_tsv
    call print_detail
    jmp  .done
.one_tsv:
    call tsv_row
    jmp  .done
.all:
    call list_start
    xor  rbx, rbx
    cmp  qword [rel g_fmt_tsv], 0
    jne  .aloop
    call tbl_sep
    call tbl_head
    call tbl_sep
.aloop:
    call list_full
    test rax, rax
    jnz  .aend
    cmp  rbx, CAPACITY
    jae  .aend
    mov  rax, rbx
    shl  rax, REC_SHIFT
    add  rax, [rel g_table]
    cmp  byte [rax+REC_STATUS], ST_OCCUPIED
    jne  .anext
    mov  [rbp-40], rax
    call list_skip
    test rax, rax
    jnz  .anext
    mov  rcx, [rbp-40]
    call list_row
.anext:
    inc  rbx
    jmp  .aloop
.aend:
    cmp  qword [rel g_fmt_tsv], 0
    jne  .areport
    call tbl_sep
.areport:
    call list_report
    jmp  .done
.notfound:
    lea  rcx, [rel s_err_nf]
    call puts
    jmp  .done
.syntax:
    lea  rcx, [rel s_err_syntax]
    call puts
.done:
    mov  rdi, [rbp-24]
    mov  rsi, [rbp-16]
    mov  rbx, [rbp-8]
    mov  rsp, rbp
    pop  rbp
    ret

; cmd_count() - COUNT
cmd_count:
    push rbp
    mov  rbp, rsp
    sub  rsp, 0x30
    lea  rcx, [rel s_count_pre]
    call puts
    mov  rcx, [rel g_count]
    call put_u64
    lea  rcx, [rel s_count_post]
    call puts
    mov  rsp, rbp
    pop  rbp
    ret

; vfy_fail(rcx = message, rdx = slot index) - report one integrity problem.
; Output is capped: a systematically corrupted file would otherwise print four
; million lines and bury the summary.
vfy_fail:
    push rbp
    mov  rbp, rsp
    sub  rsp, 0x30
    mov  [rbp-8], rdx
    inc  qword [rel g_vfy_n]
    mov  rax, [rel g_vfy_n]
    cmp  rax, VERIFY_MAX_REPORT
    ja   .quiet
    call puts
    mov  rcx, [rbp-8]
    call put_u64
    call crlf
    jmp  .out
.quiet:
    cmp  rax, VERIFY_MAX_REPORT+1
    jne  .out
    lea  rcx, [rel s_vfy_more]
    call puts
.out:
    mov  rsp, rbp
    pop  rbp
    ret

; cmd_verify() - VERIFY : full logical integrity scan of the store.
;
; The WAL checksum protects a frame in flight; it says nothing about the file
; that frame was applied to. Nothing in the engine ever re-reads the store to
; ask whether it still makes sense, so a truncated, hand-edited or
; partially-restored .dat was served as if it were sound. VERIFY walks every
; slot and checks the invariants the rest of the engine assumes:
;
;   - the status byte is one of the three defined values;
;   - a live row has a non-zero id (0 is the reserved "no key" sentinel);
;   - the declared content length is within the column and lands on its
;     terminator, and both text columns stay NUL-terminated;
;   - the row is reachable by probing from its own hash - this single check
;     catches both a broken probe chain and a duplicate key, because a second
;     row with the same id can never be the one the probe finds first;
;   - the number of live rows matches the header count used by COUNT.
cmd_verify:
    push rbp
    mov  rbp, rsp
    sub  rsp, 0x60
    mov  [rbp-8], rbx
    mov  [rbp-16], rsi
    mov  [rbp-24], rdi
    mov  qword [rel g_vfy_n], 0
    mov  qword [rbp-40], 0           ; live rows counted
    xor  rbx, rbx
.loop:
    cmp  rbx, CAPACITY
    jae  .done_scan
    mov  rsi, rbx
    shl  rsi, REC_SHIFT
    add  rsi, [rel g_table]
    movzx eax, byte [rsi+REC_STATUS]
    cmp  al, ST_OCCUPIED
    je   .live
    cmp  al, ST_EMPTY
    je   .next
    cmp  al, ST_DELETED
    je   .next
    lea  rcx, [rel s_vfy_status]
    mov  rdx, rbx
    call vfy_fail
    jmp  .next
.live:
    inc  qword [rbp-40]
    cmp  qword [rsi+REC_ID], 0
    jne  .chk_clen
    lea  rcx, [rel s_vfy_id]
    mov  rdx, rbx
    call vfy_fail
.chk_clen:
    mov  eax, dword [rsi+REC_CLEN]
    cmp  eax, CONTENT_MAX
    jbe  .chk_term
    lea  rcx, [rel s_vfy_clen]
    mov  rdx, rbx
    call vfy_fail
    jmp  .chk_reach
.chk_term:
    cmp  byte [rsi+REC_TAG+TAG_MAX-1], 0
    jne  .bad_term
    cmp  byte [rsi+REC_CONTENT+CONTENT_MAX-1], 0
    jne  .bad_term
    mov  eax, dword [rsi+REC_CLEN]
    cmp  eax, CONTENT_MAX
    je   .chk_reach                  ; a full column has no room for a NUL
    lea  rcx, [rsi+REC_CONTENT]
    add  rcx, rax
    cmp  byte [rcx], 0
    je   .chk_reach
.bad_term:
    lea  rcx, [rel s_vfy_term]
    mov  rdx, rbx
    call vfy_fail
.chk_reach:
    mov  rcx, [rsi+REC_ID]
    call store_locate
    cmp  rax, rsi
    je   .next
    lea  rcx, [rel s_vfy_reach]
    mov  rdx, rbx
    call vfy_fail
.next:
    inc  rbx
    jmp  .loop
.done_scan:
    mov  rax, [rbp-40]
    cmp  rax, [rel g_count]
    je   .report
    inc  qword [rel g_vfy_n]
    lea  rcx, [rel s_vfy_count]
    call puts
    mov  rcx, [rbp-40]
    call put_u64
    lea  rcx, [rel s_vfy_vs]
    call puts
    mov  rcx, [rel g_count]
    call put_u64
    call crlf
.report:
    cmp  qword [rel g_vfy_n], 0
    jne  .bad
    lea  rcx, [rel s_vfy_ok]
    call puts
    mov  rcx, [rbp-40]
    call put_u64
    lea  rcx, [rel s_vfy_ok_post]
    call puts
    jmp  .out
.bad:
    lea  rcx, [rel s_vfy_bad]
    call puts
    mov  rcx, [rel g_vfy_n]
    call put_u64
    lea  rcx, [rel s_vfy_bad_post]
    call puts
.out:
    mov  rdi, [rbp-24]
    mov  rsi, [rbp-16]
    mov  rbx, [rbp-8]
    mov  rsp, rbp
    pop  rbp
    ret

; contains_ci(rsi = haystack, rdi = needle) -> rax=1 if needle is a substring.
; Both NUL-terminated; ASCII case-insensitive. Empty needle matches.
contains_ci:
    push rbp
    mov  rbp, rsp
    push rbx
    push r12
    push r13
    cmp  byte [rdi], 0
    je   .yes
    mov  r12, rsi
.outer:
    cmp  byte [r12], 0
    je   .no
    mov  rbx, r12                    ; haystack cursor
    mov  r13, rdi                    ; needle cursor
.inner:
    mov  dl, [r13]
    test dl, dl
    je   .yes
    mov  al, [rbx]
    test al, al
    je   .no
    cmp  al, 'A'
    jb   .a_ok
    cmp  al, 'Z'
    ja   .a_ok
    add  al, 32
.a_ok:
    cmp  dl, 'A'
    jb   .d_ok
    cmp  dl, 'Z'
    ja   .d_ok
    add  dl, 32
.d_ok:
    cmp  al, dl
    jne  .advance
    inc  rbx
    inc  r13
    jmp  .inner
.advance:
    inc  r12
    jmp  .outer
.yes:
    mov  rax, 1
    jmp  .out
.no:
    xor  rax, rax
.out:
    pop  r13
    pop  r12
    pop  rbx
    pop  rbp
    ret

; cmd_find() - FIND <substr...> : list rows whose tag or content contains substr
cmd_find:
    push rbp
    mov  rbp, rsp
    sub  rsp, 0x40
    mov  [rbp-8], rbx
    mov  [rbp-16], rsi
    mov  [rbp-24], rdi
    mov  [rbp-32], r12
    call skip_spaces_rsi
    lea  rdi, [rel g_namebuf]
    mov  rdx, 63
    call parse_rest                  ; needle = rest of line
    call list_start
    xor  r12, r12                    ; match count
    xor  rbx, rbx                    ; slot index
.scan:
    call list_full
    test rax, rax
    jnz  .done_scan
    cmp  rbx, CAPACITY
    jae  .done_scan
    mov  rax, rbx
    shl  rax, REC_SHIFT
    add  rax, [rel g_table]
    cmp  byte [rax+REC_STATUS], ST_OCCUPIED
    jne  .next
    mov  [rbp-40], rax               ; slot ptr
    lea  rsi, [rax+REC_TAG]
    lea  rdi, [rel g_namebuf]
    call contains_ci
    test rax, rax
    jnz  .hit
    mov  rax, [rbp-40]
    lea  rsi, [rax+REC_CONTENT]
    lea  rdi, [rel g_namebuf]
    call contains_ci
    test rax, rax
    jz   .next
.hit:
    call list_skip
    test rax, rax
    jnz  .next
    test r12, r12
    jnz  .have_hdr
    cmp  qword [rel g_fmt_tsv], 0
    jne  .have_hdr
    call tbl_sep
    call tbl_head
    call tbl_sep
.have_hdr:
    mov  rcx, [rbp-40]
    call list_row
    inc  r12
.next:
    inc  rbx
    jmp  .scan
.done_scan:
    cmp  qword [rel g_fmt_tsv], 0
    jne  .report
    test r12, r12
    jz   .none
    call tbl_sep
    jmp  .done
.report:
    call list_report
    jmp  .done
.none:
    lea  rcx, [rel s_find_none]
    call puts
.done:
    mov  r12, [rbp-32]
    mov  rdi, [rbp-24]
    mov  rsi, [rbp-16]
    mov  rbx, [rbp-8]
    mov  rsp, rbp
    pop  rbp
    ret

; cmd_range() - RANGE <lo> <hi> : list rows whose value is within [lo,hi]
; (a secondary access path over the value column; linear scan today).
cmd_range:
    push rbp
    mov  rbp, rsp
    sub  rsp, 0x70
    mov  [rbp-8], rbx
    mov  [rbp-16], rsi
    mov  [rbp-24], rdi
    mov  [rbp-32], r12
    call skip_spaces_rsi
    call parse_i64
    test rdx, rdx
    jz   .syntax
    mov  [rbp-48], rax               ; lo
    call skip_spaces_rsi
    call parse_i64
    test rdx, rdx
    jz   .syntax
    mov  [rbp-56], rax               ; hi
    call list_start
    xor  r12, r12                    ; match count
    xor  rbx, rbx                    ; slot index
.scan:
    call list_full
    test rax, rax
    jnz  .done_scan
    cmp  rbx, CAPACITY
    jae  .done_scan
    mov  rax, rbx
    shl  rax, REC_SHIFT
    add  rax, [rel g_table]
    cmp  byte [rax+REC_STATUS], ST_OCCUPIED
    jne  .next
    mov  rcx, [rax+REC_VALUE]        ; i64 value
    cmp  rcx, [rbp-48]
    jl   .next                       ; value < lo (signed)
    cmp  rcx, [rbp-56]
    jg   .next                       ; value > hi (signed)
    mov  [rbp-64], rax               ; slot ptr (survives tbl_* / list_row)
    call list_skip
    test rax, rax
    jnz  .next
    test r12, r12
    jnz  .have_hdr
    cmp  qword [rel g_fmt_tsv], 0
    jne  .have_hdr
    call tbl_sep
    call tbl_head
    call tbl_sep
.have_hdr:
    mov  rcx, [rbp-64]
    call list_row
    inc  r12
.next:
    inc  rbx
    jmp  .scan
.done_scan:
    cmp  qword [rel g_fmt_tsv], 0
    jne  .report
    test r12, r12
    jz   .none
    call tbl_sep
    jmp  .done
.report:
    call list_report
    jmp  .done
.none:
    lea  rcx, [rel s_range_none]
    call puts
    jmp  .done
.syntax:
    lea  rcx, [rel s_err_syntax]
    call puts
.done:
    mov  r12, [rbp-32]
    mov  rdi, [rbp-24]
    mov  rsi, [rbp-16]
    mov  rbx, [rbp-8]
    mov  rsp, rbp
    pop  rbp
    ret

; id_matches(rcx = handle) -> rax = 1 when that handle's file identity equals
; the one already loaded in g_idbuf.
id_matches:
    push rbp
    mov  rbp, rsp
    sub  rsp, 0x30
    test rcx, rcx
    jz   .no
    cmp  rcx, INVALID_HANDLE
    je   .no
    lea  rdx, [rel g_idbuf2]
    call os_file_id
    test rax, rax
    js   .no
    mov  rax, [rel g_idbuf]
    cmp  rax, [rel g_idbuf2]
    jne  .no
    mov  rax, [rel g_idbuf+8]
    cmp  rax, [rel g_idbuf2+8]
    jne  .no
    mov  eax, 1
    jmp  .out
.no:
    xor  eax, eax
.out:
    mov  rsp, rbp
    pop  rbp
    ret

; path_is_live(rcx = path) -> rax = 1 when the path names one of the three files
; this process has open for writing.
;
; A string comparison is not enough. "db.dat", "./db.dat", an absolute path, a
; symlink and a hard link all reach the same bytes, and on Linux the advisory
; flock does not stop a second open from truncating the file. BACKUP db.dat
; therefore used to destroy the database it was asked to protect. Identity is
; the only reliable test, so the target is opened read-only and compared by
; (device, inode) on Linux and (volume, file index) on Windows.
path_is_live:
    push rbp
    mov  rbp, rsp
    sub  rsp, 0x40
    mov  [rbp-8], rbx
    mov  [rbp-16], rcx               ; path (os_exists clobbers rcx)
    call os_exists
    test rax, rax
    jz   .safe                       ; truly absent - nothing to alias
    mov  rcx, [rbp-16]
    call os_open_read
    cmp  rax, INVALID_HANDLE
    je   .noopen                     ; it exists but will not open: assume ours
    mov  rbx, rax
    mov  rcx, rbx
    lea  rdx, [rel g_idbuf]
    call os_file_id
    test rax, rax
    js   .unknown
    mov  rcx, [rel g_dat_handle]
    call id_matches
    test rax, rax
    jnz  .alias
    mov  rcx, [rel g_wal_handle]
    call id_matches
    test rax, rax
    jnz  .alias
    mov  rcx, [rel g_cdc_handle]
    call id_matches
    test rax, rax
    jnz  .alias
    mov  rcx, rbx
    call os_close
    xor  eax, eax
    jmp  .out
.alias:
    mov  rcx, rbx
    call os_close
    mov  eax, 1
    jmp  .out
.unknown:
    ; The file exists but refuses to identify itself. Treating that as "not the
    ; database" is the one guess that can destroy data, so assume the worst.
    mov  rcx, rbx
    call os_close
.noopen:
    mov  eax, 1
    jmp  .out
.safe:
    xor  eax, eax
.out:
    mov  rbx, [rbp-8]
    mov  rsp, rbp
    pop  rbp
    ret

; cmd_backup() - BACKUP <file> : snapshot the current database (header + full
; slot region) to <file>. Rejected while a transaction is open.
;
; The snapshot is written to <file>.part, created exclusively, fully flushed,
; and only then renamed over <file>. Two properties follow: a failed or
; interrupted backup never leaves a plausible-looking half file behind, and it
; never destroys the previous good backup at the same path.
;
; Every transfer is checked. A failure here does NOT abort the process (the
; live database was never touched) but it must never be reported as success,
; so the backup path deliberately avoids db_write_header/db_flush, which abort.
cmd_backup:
    push rbp
    mov  rbp, rsp
    sub  rsp, 0x60
    mov  [rbp-8], rbx
    mov  [rbp-16], rsi
    mov  [rbp-24], rdi
    cmp  qword [rel g_in_txn], 0
    jne  .busy
    call skip_spaces_rsi
    mov  al, [rsi]
    test al, al
    je   .syntax
    lea  rdi, [rel g_bakname]
    mov  rdx, 200
    call parse_tok
    lea  rcx, [rel g_bakname]
    call path_is_live
    test rax, rax
    jnz  .selftarget
    lea  rdi, [rel g_tmpname]
    lea  rsi, [rel g_bakname]
    call strcpy_z
    lea  rsi, [rel s_part_suffix]
    call strcpy_z
    lea  rcx, [rel g_tmpname]
    call os_create_new
    cmp  rax, INVALID_HANDLE
    je   .openfail
    mov  rbx, rax                    ; backup handle
    mov  rax, [rel g_dat_handle]
    mov  [rbp-32], rax               ; saved live handle
    mov  [rel g_dat_handle], rbx
    ; build the header image exactly as db_write_header would, so the snapshot
    ; carries the CDC watermark: a consumer bootstraps by loading a backup and
    ; then replaying every frame whose commit_seq is greater than this
    mov  rax, [rel g_count]
    mov  [rel g_hdr+24], rax
    mov  rax, [rel g_seq]
    mov  [rel g_hdr+HDR_SEQ], rax
    mov  qword [rel g_hdr+HDR_RESETP], 0
    mov  qword [rel g_hdr+HDR_RESETS], 0
    lea  rdi, [rel g_hdr+HDR_TABLE]
    lea  rsi, [rel g_tablename]
    mov  rcx, TABLE_MAX
    call strcpy_n
    xor  rcx, rcx
    lea  rdx, [rel g_hdr]
    mov  r8, HDR_SIZE
    call write_at                    ; 512-byte header at offset 0
    cmp  rax, HDR_SIZE
    jne  .wfail
    mov  rcx, HDR_SIZE
    mov  rdx, [rel g_table]
    mov  r8, CAPACITY*REC_SIZE
    call write_at                    ; full slot region
    mov  rdx, CAPACITY*REC_SIZE
    cmp  rax, rdx
    jne  .wfail
    mov  rcx, [rel g_dat_handle]
    call os_fsync
    test rax, rax
    jnz  .wfail
    mov  rax, [rbp-32]
    mov  [rel g_dat_handle], rax     ; restore live handle
    mov  rcx, rbx
    call os_close                    ; close before renaming: Windows will not
                                     ; replace a path that still has an open
                                     ; handle to the destination
    lea  rcx, [rel g_tmpname]
    lea  rdx, [rel g_bakname]
    call os_rename
    test rax, rax
    jnz  .renamefail
    lea  rcx, [rel s_ok_backup]
    call puts
    jmp  .done
.renamefail:
    lea  rcx, [rel g_tmpname]
    call os_unlink                   ; do not leave a stale .part behind
    lea  rcx, [rel s_err_bak_rename]
    call puts
    jmp  .done
.wfail:
    mov  rax, [rbp-32]
    mov  [rel g_dat_handle], rax     ; restore live handle before reporting
    mov  rcx, rbx
    call os_close
    lea  rcx, [rel g_tmpname]
    call os_unlink                   ; a partial snapshot must not survive
    lea  rcx, [rel s_err_bak_write]
    call puts
    jmp  .done
.selftarget:
    lea  rcx, [rel s_err_bak_self]
    call puts
    jmp  .done
.openfail:
    lea  rcx, [rel s_err_bak_open]
    call puts
    jmp  .done
.busy:
    lea  rcx, [rel s_err_txn_busy]
    call puts
    jmp  .done
.syntax:
    lea  rcx, [rel s_err_syntax]
    call puts
.done:
    mov  rdi, [rbp-24]
    mov  rsi, [rbp-16]
    mov  rbx, [rbp-8]
    mov  rsp, rbp
    pop  rbp
    ret

; cmd_restore() - RESTORE <file> : reload the database (header + slot region)
; from a backup written by BACKUP, then persist it to the live .dat. Rejected
; while a transaction is open.
;
; The backup is fully validated - magic, format fields, count, and the presence
; of the LAST byte of the slot region - *before* a single byte of the live table
; is overwritten. A truncated or foreign backup therefore leaves both the
; in-memory table and the durable .dat exactly as they were.
cmd_restore:
    push rbp
    mov  rbp, rsp
    sub  rsp, 0x60
    mov  [rbp-8], rbx
    mov  [rbp-16], rsi
    mov  [rbp-24], rdi
    cmp  qword [rel g_in_txn], 0
    jne  .busy
    call skip_spaces_rsi
    mov  al, [rsi]
    test al, al
    je   .syntax
    lea  rdi, [rel g_bakname]
    mov  rdx, 200
    call parse_tok
    lea  rcx, [rel g_bakname]
    call os_open_read
    cmp  rax, INVALID_HANDLE
    je   .openfail
    mov  rbx, rax                    ; backup handle
    mov  rax, [rel g_dat_handle]
    mov  [rbp-32], rax               ; saved live handle
    mov  [rel g_dat_handle], rbx     ; read from the backup
    xor  rcx, rcx
    lea  rdx, [rel g_hdr_read]
    mov  r8, HDR_SIZE
    call read_at
    cmp  rax, HDR_SIZE
    jne  .badmagic                   ; short read, or hard error (-1)
    mov  rax, [rel g_hdr]            ; 8-byte magic from the header template
    cmp  rax, [rel g_hdr_read]
    jne  .badmagic
    cmp  dword [rel g_hdr_read+8], DB_VERSION
    jne  .badtrunc
    cmp  dword [rel g_hdr_read+12], REC_SIZE
    jne  .badtrunc
    mov  rax, CAPACITY
    cmp  [rel g_hdr_read+16], rax
    jne  .badtrunc
    mov  rax, [rel g_hdr_read+24]    ; live count
    mov  rdx, CAPACITY
    cmp  rax, rdx
    ja   .badtrunc
    mov  [rbp-40], rax               ; keep it: the probe reuses g_hdr_read
    ; the backup must physically contain the last byte of the slot region
    mov  rcx, rbx
    mov  rdx, HDR_SIZE + CAPACITY*REC_SIZE - 1
    lea  r8, [rel g_hdr_read]
    mov  r9, 1
    call os_pread
    cmp  rax, 1
    jne  .badtrunc                   ; truncated (or unreadable) backup
    ; validated - now it is safe to overwrite the live table. Announce the reset
    ; first (a whole-table replacement is one CDC boundary, not N events), which
    ; must be written through the LIVE handle, not the read-only backup.
    mov  rax, [rbp-32]
    mov  [rel g_dat_handle], rax
    call cdc_mark_reset
    mov  [rbp-48], rax
    mov  [rel g_dat_handle], rbx     ; back to the backup to read the region
    mov  rcx, HDR_SIZE
    mov  rdx, [rel g_table]
    mov  r8, CAPACITY*REC_SIZE
    call read_at
    mov  rdx, CAPACITY*REC_SIZE
    cmp  rax, rdx
    jne  io_fatal_read               ; the table is half-loaded; do not go on
    mov  rax, [rbp-40]
    mov  [rel g_count], rax          ; adopt restored live count
    mov  rax, [rbp-32]
    mov  [rel g_dat_handle], rax     ; restore live handle
    mov  rcx, rbx
    call os_close
    call db_write_header             ; persist restored image to the live .dat
    mov  rcx, HDR_SIZE
    mov  rdx, [rel g_table]
    mov  r8, CAPACITY*REC_SIZE
    call write_at
    mov  rdx, CAPACITY*REC_SIZE
    cmp  rax, rdx
    jne  io_fatal
    call db_flush
    mov  rcx, [rbp-48]
    call cdc_finish_reset
    lea  rcx, [rel s_ok_restore]
    call puts
    jmp  .done
.badmagic:
    mov  rax, [rbp-32]
    mov  [rel g_dat_handle], rax     ; restore live handle before erroring
    mov  rcx, rbx
    call os_close
    lea  rcx, [rel s_err_bak_magic]
    call puts
    jmp  .done
.badtrunc:
    mov  rax, [rbp-32]
    mov  [rel g_dat_handle], rax
    mov  rcx, rbx
    call os_close
    lea  rcx, [rel s_err_bak_trunc]
    call puts
    jmp  .done
.openfail:
    lea  rcx, [rel s_err_bak_open]
    call puts
    jmp  .done
.busy:
    lea  rcx, [rel s_err_txn_busy]
    call puts
    jmp  .done
.syntax:
    lea  rcx, [rel s_err_syntax]
    call puts
.done:
    mov  rdi, [rbp-24]
    mov  rsi, [rbp-16]
    mov  rbx, [rbp-8]
    mov  rsp, rbp
    pop  rbp
    ret

; cmd_bench() - BENCH <n> : reset the table, insert n synthetic rows (timed in
; RAM), then checkpoint the whole table to disk + fsync (timed). This overwrites
; the current database with synthetic data - run it against a scratch db.
; Rejected while a transaction is open: BENCH wipes the live table and
; checkpoints it, which would strand the undo log against slots that no longer
; hold the rows it captured (and BENCH is deliberately not transactional).
cmd_bench:
    push rbp
    mov  rbp, rsp
    sub  rsp, 0xA0
    mov  [rbp-8], rbx
    mov  [rbp-16], rsi
    mov  [rbp-24], rdi
    mov  [rbp-32], r12
    mov  [rbp-40], r13
    cmp  qword [rel g_in_txn], 0
    jne  .busy
    call skip_spaces_rsi
    call parse_u64                   ; rax = n, rdx = ok flag
    test rdx, rdx
    jnz  .haven
    mov  rax, 100000
.haven:
    test rax, rax
    jnz  .nz
    mov  rax, 100000
.nz:
    mov  rcx, (CAPACITY*3)/4          ; cap to keep the load factor < 0.75
    cmp  rax, rcx
    jbe  .ncap
    mov  rax, rcx
.ncap:
    mov  r12, rax                    ; r12 = n
    mov  [rbp-64], rax               ; n_local
    ; reset the table: clear every slot, count = 0. A synthetic reload replaces
    ; the whole table, so it is one RESET for change consumers.
    call cdc_mark_reset
    mov  [rbp-104], rax
    mov  qword [rel g_count], 0
    mov  rdi, [rel g_table]
    mov  rcx, CAPACITY*REC_SIZE
    xor  eax, eax
    rep  stosb
    ; capture one timestamp for all synthetic rows (kept out of the timed loop)
    call now_ms
    mov  [rbp-88], rax
    ; frequency + start timestamp
    call os_perf_freq
    mov  [rel g_qpf], rax
    call os_perf_counter
    mov  [rel g_qpc0], rax
    ; insert loop: id = 1 .. n
    xor  r13, r13
.loop:
    cmp  r13, r12
    jae  .loopend
    lea  rcx, [r13+1]                ; id = i + 1
    mov  [rbp-48], rcx
    call store_locate                ; rdx = insertable slot
    test rdx, rdx
    jz   .lnext
    mov  rdi, rdx
    mov  [rbp-96], rdi               ; slot base
    mov  rax, [rbp-48]
    mov  [rdi+REC_ID], rax
    mov  byte [rdi+REC_STATUS], ST_OCCUPIED
    mov  byte [rdi+REC_KIND], KIND_GENERIC
    mov  [rdi+REC_VALUE], rax
    mov  eax, bench_clen
    mov  [rdi+REC_CLEN], eax
    mov  rax, [rbp-88]
    mov  [rdi+REC_CREATED], rax
    mov  [rdi+REC_UPDATED], rax
    lea  rsi, [rel bench_tag]
    lea  rdi, [rdi+REC_TAG]
    mov  rcx, TAG_MAX
    rep  movsb
    mov  rdi, [rbp-96]
    lea  rsi, [rel bench_content]
    lea  rdi, [rdi+REC_CONTENT]
    mov  rcx, CONTENT_MAX
    rep  movsb
    inc  qword [rel g_count]
.lnext:
    inc  r13
    jmp  .loop
.loopend:
    call os_perf_counter             ; end of in-RAM phase
    mov  [rel g_qpc1], rax
    ; durable checkpoint: whole slot region + header, then fsync
    mov  rcx, HDR_SIZE
    mov  rdx, [rel g_table]
    mov  r8, CAPACITY*REC_SIZE
    call write_at
    mov  rdx, CAPACITY*REC_SIZE
    cmp  rax, rdx
    jne  io_fatal
    call db_write_header
    call db_flush
    mov  rcx, [rbp-104]
    call cdc_finish_reset
    call os_perf_counter
    mov  [rel g_qpc2], rax
    ; ram_ticks = qpc1 - qpc0 (floor at 1 to avoid divide-by-zero)
    mov  rax, [rel g_qpc1]
    sub  rax, [rel g_qpc0]
    jnz  .rt_ok
    mov  rax, 1
.rt_ok:
    mov  [rbp-56], rax
    ; rate = n * freq / ram_ticks
    mov  rax, r12
    mul  qword [rel g_qpf]
    div  qword [rbp-56]
    mov  [rbp-72], rax
    ; total_ms = (qpc2 - qpc0) * 1000 / freq
    mov  rax, [rel g_qpc2]
    sub  rax, [rel g_qpc0]
    mov  rcx, 1000
    mul  rcx
    div  qword [rel g_qpf]
    mov  [rbp-80], rax
    ; report
    lea  rcx, [rel s_bench_pre]
    call puts
    mov  rcx, [rbp-64]
    call put_u64
    lea  rcx, [rel s_bench_rows]
    call puts
    lea  rcx, [rel s_bench_ram]
    call puts
    mov  rcx, [rbp-72]
    call put_u64
    lea  rcx, [rel s_bench_rs]
    call puts
    lea  rcx, [rel s_bench_dur]
    call puts
    mov  rcx, [rbp-80]
    call put_u64
    lea  rcx, [rel s_bench_ms]
    call puts
    jmp  .done
.busy:
    lea  rcx, [rel s_err_txn_busy]
    call puts
.done:
    mov  r13, [rbp-40]
    mov  r12, [rbp-32]
    mov  rdi, [rbp-24]
    mov  rsi, [rbp-16]
    mov  rbx, [rbp-8]
    mov  rsp, rbp
    pop  rbp
    ret

; cmd_help() - HELP (sectioned, aligned, colored)
cmd_help:
    push rbp
    mov  rbp, rsp
    sub  rsp, 0x30
    call crlf
    lea  rcx, [rel h_title]
    lea  rdx, [rel c_white]
    call puts_col
    call crlf
    call crlf
    lea  rcx, [rel h_g_data]
    lea  rdx, [rel c_yellow]
    call puts_col
    call crlf
    lea  rcx, [rel hc_insert]
    lea  rdx, [rel hd_insert]
    call help_row
    lea  rcx, [rel hc_sel1]
    lea  rdx, [rel hd_sel1]
    call help_row
    lea  rcx, [rel hc_selall]
    lea  rdx, [rel hd_selall]
    call help_row
    lea  rcx, [rel hc_update]
    lea  rdx, [rel hd_update]
    call help_row
    lea  rcx, [rel hc_find]
    lea  rdx, [rel hd_find]
    call help_row
    lea  rcx, [rel hc_range]
    lea  rdx, [rel hd_range]
    call help_row
    lea  rcx, [rel hc_delete]
    lea  rdx, [rel hd_delete]
    call help_row
    lea  rcx, [rel hc_trunc]
    lea  rdx, [rel hd_trunc]
    call help_row
    lea  rcx, [rel hc_count]
    lea  rdx, [rel hd_count]
    call help_row
    call crlf
    lea  rcx, [rel h_g_txn]
    lea  rdx, [rel c_yellow]
    call puts_col
    call crlf
    lea  rcx, [rel hc_begin]
    lea  rdx, [rel hd_begin]
    call help_row
    lea  rcx, [rel hc_commit]
    lea  rdx, [rel hd_commit]
    call help_row
    lea  rcx, [rel hc_rback]
    lea  rdx, [rel hd_rback]
    call help_row
    call crlf
    lea  rcx, [rel h_g_cat]
    lea  rdx, [rel c_yellow]
    call puts_col
    call crlf
    lea  rcx, [rel hc_tables]
    lea  rdx, [rel hd_tables]
    call help_row
    lea  rcx, [rel hc_dbs]
    lea  rdx, [rel hd_dbs]
    call help_row
    lea  rcx, [rel hc_schema]
    lea  rdx, [rel hd_schema]
    call help_row
    lea  rcx, [rel hc_types]
    lea  rdx, [rel hd_types]
    call help_row
    lea  rcx, [rel hc_version]
    lea  rdx, [rel hd_version]
    call help_row
    lea  rcx, [rel hc_bench]
    lea  rdx, [rel hd_bench]
    call help_row
    call crlf
    lea  rcx, [rel h_g_bak]
    lea  rdx, [rel c_yellow]
    call puts_col
    call crlf
    lea  rcx, [rel hc_backup]
    lea  rdx, [rel hd_backup]
    call help_row
    lea  rcx, [rel hc_restore]
    lea  rdx, [rel hd_restore]
    call help_row
    lea  rcx, [rel hc_verify]
    lea  rdx, [rel hd_verify]
    call help_row
    call crlf
    lea  rcx, [rel h_g_sess]
    lea  rdx, [rel c_yellow]
    call puts_col
    call crlf
    lea  rcx, [rel hc_format]
    lea  rdx, [rel hd_format]
    call help_row
    lea  rcx, [rel hc_page]
    lea  rdx, [rel hd_page]
    call help_row
    lea  rcx, [rel hc_help]
    lea  rdx, [rel hd_help]
    call help_row
    lea  rcx, [rel hc_exit]
    lea  rdx, [rel hd_exit]
    call help_row
    call crlf
    mov  rsp, rbp
    pop  rbp
    ret

; put_ver(rcx = packed version) - print "major.minor.patch"
put_ver:
    push rbp
    mov  rbp, rsp
    sub  rsp, 0x30
    mov  [rbp-8], rbx
    mov  rbx, rcx
    mov  rcx, rbx
    shr  rcx, 16
    and  rcx, 0xFF
    call put_u64
    lea  rcx, [rel s_verdot]
    call puts
    mov  rcx, rbx
    shr  rcx, 8
    and  rcx, 0xFF
    call put_u64
    lea  rcx, [rel s_verdot]
    call puts
    mov  rcx, rbx
    and  rcx, 0xFF
    call put_u64
    mov  rbx, [rbp-8]
    mov  rsp, rbp
    pop  rbp
    ret

; cmd_version() - VERSION : engine build, on-disk format, and which engine last
;   wrote the open database. The engine number and the format number are
;   deliberately separate: the first moves with every release, the second only
;   when the bytes on disk change meaning.
cmd_version:
    push rbp
    mov  rbp, rsp
    sub  rsp, 0x30
    lea  rcx, [rel s_ver_pre]
    call puts
    mov  ecx, ENGINE_VERSION
    call put_ver
    lea  rcx, [rel s_ver_pre10]
    call puts
    lea  rcx, [rel s_ver_fmt]
    call puts
    mov  ecx, DB_VERSION
    call put_u64
    lea  rcx, [rel s_nl]
    call puts
    lea  rcx, [rel s_ver_rec]
    call puts
    mov  ecx, REC_SIZE
    call put_u64
    lea  rcx, [rel s_ver_recb]
    call puts
    lea  rcx, [rel s_ver_cap]
    call puts
    mov  ecx, CAPACITY
    call put_u64
    lea  rcx, [rel s_ver_slots]
    call puts
    lea  rcx, [rel s_ver_plat]
    call puts
    lea  rcx, [rel s_ver_platname]
    call puts
    ; which engine last wrote this database (0 = predates the stamp)
    mov  rax, [rel g_writer_ver]
    test rax, rax
    jz   .nostamp
    mov  [rbp-16], rax
    lea  rcx, [rel s_ver_writer]
    call puts
    mov  rcx, [rbp-16]
    call put_ver
    lea  rcx, [rel s_nl]
    call puts
    jmp  .done
.nostamp:
    lea  rcx, [rel s_ver_older]
    call puts
.done:
    mov  rsp, rbp
    pop  rbp
    ret

; cmd_schema() - SCHEMA (static record layout)
cmd_schema:
    push rbp
    mov  rbp, rsp
    sub  rsp, 0x30
    call crlf
    lea  rcx, [rel s_schema_title]
    lea  rdx, [rel c_white]
    call puts_col
    lea  rcx, [rel s_schema_body]
    lea  rdx, [rel c_grey]
    call puts_col
    mov  rsp, rbp
    pop  rbp
    ret

; cmd_types() - TYPES (static supported types)
cmd_types:
    push rbp
    mov  rbp, rsp
    sub  rsp, 0x30
    call crlf
    lea  rcx, [rel s_types_title]
    lea  rdx, [rel c_white]
    call puts_col
    lea  rcx, [rel s_types_body]
    lea  rdx, [rel c_grey]
    call puts_col
    mov  rsp, rbp
    pop  rbp
    ret

; cmd_tables() - TABLES (this database holds one logical table)
cmd_tables:
    push rbp
    mov  rbp, rsp
    sub  rsp, 0x40
    call crlf
    lea  rcx, [rel s_tables_title]
    lea  rdx, [rel c_white]
    call puts_col
    lea  rcx, [rel g_base]
    lea  rdx, [rel c_cyan]
    call puts_col
    call crlf
    call crlf
    lea  rcx, [rel s_tables_hdr]
    lea  rdx, [rel c_grey]
    call puts_col
    call crlf
    mov  rcx, 4
    call put_spaces
    lea  rcx, [rel g_tablename]
    lea  rdx, [rel c_cyan]
    call puts_col
    lea  rcx, [rel g_tablename]
    call strlen
    mov  rcx, 29
    sub  rcx, rax
    cmp  rcx, 1
    jge  .pad
    mov  rcx, 1
.pad:
    call put_spaces
    mov  rcx, [rel g_count]
    call put_u64
    call crlf
    call crlf
    mov  rsp, rbp
    pop  rbp
    ret

; cmd_databases() - DATABASES (enumerate *.dat in the current folder)
cmd_databases:
    push rbp
    mov  rbp, rsp
    sub  rsp, 0x40
    mov  [rbp-8], rbx
    mov  [rbp-16], rsi
    mov  [rbp-24], rdi
    call crlf
    lea  rcx, [rel s_dbs_title]
    lea  rdx, [rel c_white]
    call puts_col
    call crlf
    call crlf
    lea  rcx, [rel s_dbs_hdr]
    lea  rdx, [rel c_grey]
    call puts_col
    call crlf
    lea  rcx, [rel s_pat_dat]
    call os_dir_open
    cmp  rax, INVALID_HANDLE
    je   .none
    mov  rbx, rax                    ; directory handle
    mov  qword [rbp-32], 0           ; entries rendered
.row:
    mov  rcx, rbx
    lea  rdx, [rel g_finddata]
    call os_dir_next
    test rax, rax
    jz   .close
    inc  qword [rbp-32]
    mov  rcx, 4
    call put_spaces
    lea  rcx, [rel g_finddata+FIND_NAME]
    lea  rdx, [rel c_cyan]
    call puts_col
    lea  rcx, [rel g_finddata+FIND_NAME]
    call strlen
    mov  rcx, 29
    sub  rcx, rax
    cmp  rcx, 1
    jge  .pad
    mov  rcx, 1
.pad:
    call put_spaces
    mov  ecx, [rel g_finddata+FIND_SIZELOW]
    mov  rdx, 15
    call put_u64_field
    lea  rsi, [rel g_finddata+FIND_NAME]
    lea  rdi, [rel g_datname]
    call streq
    test rax, rax
    jz   .nocur
    lea  rcx, [rel c_green]
    call set_color
    mov  cl, '*'
    call putc
    call reset_color
.nocur:
    call crlf
    jmp  .row
.close:
    mov  rcx, rbx
    call os_dir_close
    cmp  qword [rbp-32], 0
    jne  .done
.none:
    lea  rcx, [rel s_dbs_empty]
    call puts
    call crlf
.done:
    call crlf
    mov  rdi, [rbp-24]
    mov  rsi, [rbp-16]
    mov  rbx, [rbp-8]
    mov  rsp, rbp
    pop  rbp
    ret

; streq(rsi = a, rdi = b) -> rax = 1 if equal (case-sensitive). Clobbers rsi/rdi.
streq:
    mov  cl, [rsi]
    cmp  cl, [rdi]
    jne  .no
    test cl, cl
    je   .yes
    inc  rsi
    inc  rdi
    jmp  streq
.yes:
    mov  rax, 1
    ret
.no:
    xor  rax, rax
    ret

; cmd_begin / cmd_commit / cmd_rollback live in wal.inc (real transactions).

; dispatch(rcx = line ptr) -> rax = CMD_OK / CMD_EXIT
; ro_allowed(rsi = line) -> rax = 1 when the command does not modify anything.
;
; A whitelist, not a blacklist: a command added later is refused by a reader
; until someone has decided it is safe, which is the right default.
ro_allowed:
    push rbp
    mov  rbp, rsp
    sub  rsp, 0x30
    mov  [rbp-16], rdi
    lea  rdi, [rel kw_select]
    call token_eq
    test rax, rax
    jnz  .yes
    lea  rdi, [rel kw_find]
    call token_eq
    test rax, rax
    jnz  .yes
    lea  rdi, [rel kw_range]
    call token_eq
    test rax, rax
    jnz  .yes
    lea  rdi, [rel kw_count]
    call token_eq
    test rax, rax
    jnz  .yes
    lea  rdi, [rel kw_verify]
    call token_eq
    test rax, rax
    jnz  .yes
    lea  rdi, [rel kw_format]
    call token_eq
    test rax, rax
    jnz  .yes
    lea  rdi, [rel kw_page]
    call token_eq
    test rax, rax
    jnz  .yes
    lea  rdi, [rel kw_tables]
    call token_eq
    test rax, rax
    jnz  .yes
    lea  rdi, [rel kw_databases]
    call token_eq
    test rax, rax
    jnz  .yes
    lea  rdi, [rel kw_schema]
    call token_eq
    test rax, rax
    jnz  .yes
    lea  rdi, [rel kw_types]
    call token_eq
    test rax, rax
    jnz  .yes
    lea  rdi, [rel kw_version]
    call token_eq
    test rax, rax
    jnz  .yes
    lea  rdi, [rel kw_help]
    call token_eq
    test rax, rax
    jnz  .yes
    lea  rdi, [rel kw_exit]
    call token_eq
    test rax, rax
    jnz  .yes
    lea  rdi, [rel kw_quit]
    call token_eq
    test rax, rax
    jnz  .yes
    xor  eax, eax
    jmp  .out
.yes:
    mov  eax, 1
.out:
    mov  rdi, [rbp-16]
    mov  rsp, rbp
    pop  rbp
    ret

dispatch:
    push rbp
    mov  rbp, rsp
    sub  rsp, 0x40
    mov  [rbp-16], rsi
    mov  rsi, rcx
    call skip_spaces_rsi
    mov  al, [rsi]
    test al, al
    je   .ok0
    cmp  qword [rel g_readonly], 0
    je   .rw
    call ro_allowed
    test rax, rax
    jnz  .rw
    lea  rcx, [rel s_err_readonly]
    call puts
    jmp  .ok0
.rw:
    lea  rdi, [rel kw_help]
    call token_eq
    test rax, rax
    jnz  .help
    lea  rdi, [rel kw_exit]
    call token_eq
    test rax, rax
    jnz  .exit
    lea  rdi, [rel kw_quit]
    call token_eq
    test rax, rax
    jnz  .exit
    lea  rdi, [rel kw_insert]
    call token_eq
    test rax, rax
    jnz  .insert
    lea  rdi, [rel kw_select]
    call token_eq
    test rax, rax
    jnz  .select
    lea  rdi, [rel kw_update]
    call token_eq
    test rax, rax
    jnz  .update
    lea  rdi, [rel kw_delete]
    call token_eq
    test rax, rax
    jnz  .delete
    lea  rdi, [rel kw_truncate]
    call token_eq
    test rax, rax
    jnz  .truncate
    lea  rdi, [rel kw_count]
    call token_eq
    test rax, rax
    jnz  .count
    lea  rdi, [rel kw_begin]
    call token_eq
    test rax, rax
    jnz  .begin
    lea  rdi, [rel kw_commit]
    call token_eq
    test rax, rax
    jnz  .commit
    lea  rdi, [rel kw_rollback]
    call token_eq
    test rax, rax
    jnz  .rollback
    lea  rdi, [rel kw_tables]
    call token_eq
    test rax, rax
    jnz  .tables
    lea  rdi, [rel kw_databases]
    call token_eq
    test rax, rax
    jnz  .databases
    lea  rdi, [rel kw_schema]
    call token_eq
    test rax, rax
    jnz  .schema
    lea  rdi, [rel kw_version]
    call token_eq
    test rax, rax
    jnz  .version
    lea  rdi, [rel kw_types]
    call token_eq
    test rax, rax
    jnz  .types
    lea  rdi, [rel kw_bench]
    call token_eq
    test rax, rax
    jnz  .bench
    lea  rdi, [rel kw_find]
    call token_eq
    test rax, rax
    jnz  .find
    lea  rdi, [rel kw_range]
    call token_eq
    test rax, rax
    jnz  .range
    lea  rdi, [rel kw_backup]
    call token_eq
    test rax, rax
    jnz  .backup
    lea  rdi, [rel kw_restore]
    call token_eq
    test rax, rax
    jnz  .restore
    lea  rdi, [rel kw_format]
    call token_eq
    test rax, rax
    jnz  .format
    lea  rdi, [rel kw_page]
    call token_eq
    test rax, rax
    jnz  .page
    lea  rdi, [rel kw_verify]
    call token_eq
    test rax, rax
    jnz  .verify
    lea  rcx, [rel s_unknown]
    call puts
    jmp  .ok0
.insert:
    call advance_token
    call cmd_insert
    jmp  .ok0
.select:
    call advance_token
    call cmd_select
    jmp  .ok0
.update:
    call advance_token
    call cmd_update
    jmp  .ok0
.delete:
    call advance_token
    call cmd_delete
    jmp  .ok0
.truncate:
    call cmd_truncate
    jmp  .ok0
.count:
    call cmd_count
    jmp  .ok0
.help:
    call cmd_help
    jmp  .ok0
.begin:
    call cmd_begin
    jmp  .ok0
.commit:
    call cmd_commit
    jmp  .ok0
.rollback:
    call cmd_rollback
    jmp  .ok0
.tables:
    call cmd_tables
    jmp  .ok0
.databases:
    call cmd_databases
    jmp  .ok0
.schema:
    call cmd_schema
    jmp  .ok0
.version:
    call cmd_version
    jmp  .ok0
.types:
    call cmd_types
    jmp  .ok0
.bench:
    call advance_token
    call cmd_bench
    jmp  .ok0
.find:
    call advance_token
    call cmd_find
    jmp  .ok0
.range:
    call advance_token
    call cmd_range
    jmp  .ok0
.backup:
    call advance_token
    call cmd_backup
    jmp  .ok0
.restore:
    call advance_token
    call cmd_restore
    jmp  .ok0
.format:
    call advance_token
    call cmd_format
    jmp  .ok0
.page:
    call advance_token
    call cmd_page
    jmp  .ok0
.verify:
    call cmd_verify
    jmp  .ok0
.exit:
    mov  rax, CMD_EXIT
    jmp  .ret
.ok0:
    xor  rax, rax
.ret:
    mov  rsi, [rbp-16]
    mov  rsp, rbp
    pop  rbp
    ret

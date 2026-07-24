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
parse_u64:
    xor  rax, rax
    xor  r9, r9
.loop:
    movzx ecx, byte [rsi]
    cmp  cl, '0'
    jb   .end
    cmp  cl, '9'
    ja   .end
    imul rax, rax, 10
    sub  cl, '0'
    movzx rcx, cl
    add  rax, rcx
    inc  rsi
    inc  r9
    jmp  .loop
.end:
    test r9, r9
    jz   .err
    mov  rdx, 1
    ret
.err:
    xor  rdx, rdx
    ret

; parse_i64() - optional leading '-' then decimal -> rax value, rdx ok flag
parse_i64:
    mov  al, [rsi]
    cmp  al, '-'
    jne  .pos
    inc  rsi
    call parse_u64
    test rdx, rdx
    jz   .err
    neg  rax
    mov  rdx, 1
    ret
.pos:
    call parse_u64
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
    push rbp
    mov  rbp, rsp
    sub  rsp, 0x20
    lea  rcx, [rel g_ft]
    call [rel iat_GetSystemTimeAsFileTime]
    mov  rax, [rel g_ft]             ; 100-ns ticks since 1601-01-01
    xor  rdx, rdx
    mov  rcx, 10000
    div  rcx                         ; -> ms since 1601
    mov  rcx, 11644473600000         ; ms between 1601 and 1970
    sub  rax, rcx
    mov  rsp, rbp
    pop  rbp
    ret

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
    mov  rcx, rbx
    call txn_capture                 ; record undo image (no-op outside a txn)
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
    cmp  qword [rel g_in_txn], 0
    jne  .deferred
    mov  rcx, rbx
    call db_persist_slot
.deferred:
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
    cmp  qword [rel g_in_txn], 0
    jne  .deferred
    mov  rcx, rbx
    call db_persist_slot
.deferred:
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
    mov  rcx, rdi
    call txn_capture
    test rax, rax
    jz   .toobig
    mov  byte [rdi+REC_STATUS], ST_DELETED
    dec  qword [rel g_count]
    cmp  qword [rel g_in_txn], 0
    jne  .deferred
    mov  rcx, rdi
    call db_persist_slot
.deferred:
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
    call print_detail
    jmp  .done
.all:
    call tbl_sep
    call tbl_head
    call tbl_sep
    xor  rbx, rbx
.aloop:
    cmp  rbx, CAPACITY
    jae  .aend
    mov  rax, rbx
    shl  rax, REC_SHIFT
    add  rax, [rel g_table]
    cmp  byte [rax+REC_STATUS], ST_OCCUPIED
    jne  .anext
    mov  rcx, rax
    call print_row
.anext:
    inc  rbx
    jmp  .aloop
.aend:
    call tbl_sep
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
    xor  r12, r12                    ; match count
    xor  rbx, rbx                    ; slot index
.scan:
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
    test r12, r12
    jnz  .have_hdr
    call tbl_sep
    call tbl_head
    call tbl_sep
.have_hdr:
    mov  rcx, [rbp-40]
    call print_row
    inc  r12
.next:
    inc  rbx
    jmp  .scan
.done_scan:
    test r12, r12
    jz   .none
    call tbl_sep
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
    xor  r12, r12                    ; match count
    xor  rbx, rbx                    ; slot index
.scan:
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
    mov  [rbp-64], rax               ; slot ptr (survives tbl_* / print_row)
    test r12, r12
    jnz  .have_hdr
    call tbl_sep
    call tbl_head
    call tbl_sep
.have_hdr:
    mov  rcx, [rbp-64]
    call print_row
    inc  r12
.next:
    inc  rbx
    jmp  .scan
.done_scan:
    test r12, r12
    jz   .none
    call tbl_sep
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

; cmd_backup() - BACKUP <file> : snapshot the current database (header + full
; slot region) to <file>. Rejected while a transaction is open. Reuses the
; durable-write path by temporarily retargeting g_dat_handle at the backup file.
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
    mov  rdx, GENERIC_READ | GENERIC_WRITE
    xor  r8, r8
    xor  r9, r9
    mov  dword [rsp+0x20], CREATE_ALWAYS
    mov  dword [rsp+0x28], FILE_ATTRIBUTE_NORMAL
    mov  qword [rsp+0x30], 0
    call [rel iat_CreateFileA]
    cmp  rax, INVALID_HANDLE
    je   .openfail
    mov  rbx, rax                    ; backup handle
    mov  rax, [rel g_dat_handle]
    mov  [rbp-32], rax               ; saved live handle
    mov  [rel g_dat_handle], rbx
    call db_write_header             ; 512-byte header at offset 0
    mov  rcx, HDR_SIZE
    mov  rdx, [rel g_table]
    mov  r8, CAPACITY*REC_SIZE
    call write_at                    ; full slot region
    call db_flush
    mov  rax, [rbp-32]
    mov  [rel g_dat_handle], rax     ; restore live handle
    mov  rcx, rbx
    call [rel iat_CloseHandle]
    lea  rcx, [rel s_ok_backup]
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
    mov  rdx, GENERIC_READ
    mov  r8d, 1                      ; FILE_SHARE_READ
    xor  r9, r9
    mov  dword [rsp+0x20], OPEN_EXISTING
    mov  dword [rsp+0x28], FILE_ATTRIBUTE_NORMAL
    mov  qword [rsp+0x30], 0
    call [rel iat_CreateFileA]
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
    jb   .badmagic
    lea  rsi, [rel g_hdr_read]
    lea  rdi, [rel s_magic]
    mov  rcx, 5
.magic:
    mov  al, [rsi]
    cmp  al, [rdi]
    jne  .badmagic
    inc  rsi
    inc  rdi
    dec  rcx
    jnz  .magic
    mov  rcx, HDR_SIZE
    mov  rdx, [rel g_table]
    mov  r8, CAPACITY*REC_SIZE
    call read_at                     ; load slots into the live table
    mov  rax, [rel g_hdr_read+24]
    mov  [rel g_count], rax           ; adopt restored live count
    mov  rax, [rbp-32]
    mov  [rel g_dat_handle], rax     ; restore live handle
    mov  rcx, rbx
    call [rel iat_CloseHandle]
    call db_write_header             ; persist restored image to the live .dat
    mov  rcx, HDR_SIZE
    mov  rdx, [rel g_table]
    mov  r8, CAPACITY*REC_SIZE
    call write_at
    call db_flush
    lea  rcx, [rel s_ok_restore]
    call puts
    jmp  .done
.badmagic:
    mov  rax, [rbp-32]
    mov  [rel g_dat_handle], rax     ; restore live handle before erroring
    mov  rcx, rbx
    call [rel iat_CloseHandle]
    lea  rcx, [rel s_err_bak_magic]
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
cmd_bench:
    push rbp
    mov  rbp, rsp
    sub  rsp, 0xA0
    mov  [rbp-8], rbx
    mov  [rbp-16], rsi
    mov  [rbp-24], rdi
    mov  [rbp-32], r12
    mov  [rbp-40], r13
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
    ; reset the table: clear every slot, count = 0
    mov  qword [rel g_count], 0
    mov  rdi, [rel g_table]
    mov  rcx, CAPACITY*REC_SIZE
    xor  eax, eax
    rep  stosb
    ; capture one timestamp for all synthetic rows (kept out of the timed loop)
    call now_ms
    mov  [rbp-88], rax
    ; frequency + start timestamp
    lea  rcx, [rel g_qpf]
    call [rel iat_QueryPerformanceFrequency]
    lea  rcx, [rel g_qpc0]
    call [rel iat_QueryPerformanceCounter]
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
    lea  rcx, [rel g_qpc1]            ; end of in-RAM phase
    call [rel iat_QueryPerformanceCounter]
    ; durable checkpoint: whole slot region + header, then fsync
    mov  rcx, HDR_SIZE
    mov  rdx, [rel g_table]
    mov  r8, CAPACITY*REC_SIZE
    call write_at
    call db_write_header
    call db_flush
    lea  rcx, [rel g_qpc2]
    call [rel iat_QueryPerformanceCounter]
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
    call crlf
    lea  rcx, [rel h_g_sess]
    lea  rdx, [rel c_yellow]
    call puts_col
    call crlf
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
    lea  rdx, [rel g_finddata]
    call [rel iat_FindFirstFileA]
    cmp  rax, INVALID_HANDLE
    je   .none
    mov  rbx, rax                    ; find handle
.row:
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
    mov  rcx, rbx
    lea  rdx, [rel g_finddata]
    call [rel iat_FindNextFileA]
    test eax, eax
    jnz  .row
    mov  rcx, rbx
    call [rel iat_FindClose]
    jmp  .done
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

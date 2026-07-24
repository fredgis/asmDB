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

; parse_name(rdi = dest[NAME_MAX]) - copy a token from rsi, zero-pad -> rax = len
parse_name:
    xor  rcx, rcx
.loop:
    cmp  rcx, NAME_MAX
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
    cmp  rcx, NAME_MAX
    jae  .done
    mov  byte [rdi+rcx], 0
    inc  rcx
    jmp  .z
.done:
    mov  rax, r8
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
    mov  rdx, W_NAME+2
    call put_repeat
    mov  cl, '+'
    call putc
    mov  cl, '-'
    mov  rdx, W_VAL+2
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
    lea  rcx, [rel s_lbl_name]
    mov  rdx, W_NAME
    call put_label
    lea  rcx, [rel s_cell_m]
    call puts
    lea  rcx, [rel s_lbl_val]
    mov  rdx, W_VAL
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
    lea  rcx, [rcx+REC_NAME]
    mov  rdx, W_NAME
    call put_name_field
    lea  rcx, [rel s_cell_m]
    call puts
    mov  rcx, [rbp-8]
    mov  rcx, [rcx+REC_VALUE]
    mov  rdx, W_VAL
    call put_i64_field
    lea  rcx, [rel s_cell_r]
    call puts
    call crlf
    mov  rsp, rbp
    pop  rbp
    ret

; -------------------------- command handlers --------------------------------

; cmd_insert() - INSERT <id> <value> <name>
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
    call skip_spaces_rsi
    call parse_i64
    test rdx, rdx
    jz   .syntax
    mov  [rbp-40], rax               ; value
    call skip_spaces_rsi
    lea  rdi, [rel g_namebuf]
    call parse_name
    mov  rcx, [rbp-32]
    call store_locate                ; rax=found, rdx=insert
    test rax, rax
    jnz  .dup
    test rdx, rdx
    jz   .full
    mov  rdi, rdx                    ; target slot
    mov  rcx, rdi
    call txn_capture                 ; record undo image (no-op outside a txn)
    test rax, rax
    jz   .toobig
    mov  rax, [rbp-32]
    mov  [rdi+REC_ID], rax
    mov  byte [rdi+REC_STATUS], ST_OCCUPIED
    mov  rax, [rbp-40]
    mov  [rdi+REC_VALUE], rax
    lea  rsi, [rel g_namebuf]
    xor  rcx, rcx
.cpy:
    mov  al, [rsi+rcx]
    mov  [rdi+REC_NAME+rcx], al
    inc  rcx
    cmp  rcx, NAME_MAX
    jb   .cpy
    inc  qword [rel g_count]
    cmp  qword [rel g_in_txn], 0
    jne  .deferred
    mov  rcx, rdi
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

; cmd_update() - UPDATE <id> <value> <name>
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
    call skip_spaces_rsi
    call parse_i64
    test rdx, rdx
    jz   .syntax
    mov  [rbp-40], rax
    call skip_spaces_rsi
    lea  rdi, [rel g_namebuf]
    call parse_name
    mov  rcx, [rbp-32]
    call store_locate
    test rax, rax
    jz   .notfound
    mov  rdi, rax
    mov  rcx, rdi
    call txn_capture
    test rax, rax
    jz   .toobig
    mov  rax, [rbp-40]
    mov  [rdi+REC_VALUE], rax
    lea  rsi, [rel g_namebuf]
    xor  rcx, rcx
.cpy:
    mov  al, [rsi+rcx]
    mov  [rdi+REC_NAME+rcx], al
    inc  rcx
    cmp  rcx, NAME_MAX
    jb   .cpy
    cmp  qword [rel g_in_txn], 0
    jne  .deferred
    mov  rcx, rdi
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
    mov  [rbp-32], rax
    call tbl_sep
    call tbl_head
    call tbl_sep
    mov  rcx, [rbp-32]
    call print_row
    call tbl_sep
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
    shl  rax, 6
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

; cmd_bench() - BENCH <n> : reset the table, insert n synthetic rows (timed in
; RAM), then checkpoint the whole table to disk + fsync (timed). This overwrites
; the current database with synthetic data - run it against a scratch db.
cmd_bench:
    push rbp
    mov  rbp, rsp
    sub  rsp, 0x80
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
    mov  rax, [rbp-48]
    mov  [rdi+REC_ID], rax
    mov  byte [rdi+REC_STATUS], ST_OCCUPIED
    mov  [rdi+REC_VALUE], rax
    lea  rsi, [rel bench_name40]
    lea  rdi, [rdi+REC_NAME]
    mov  rcx, NAME_MAX
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

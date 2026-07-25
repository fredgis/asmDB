; -----------------------------------------------------------------------------
; src/console.inc - buffered console I/O and formatting helpers.
;
; Calling convention (internal): standard Win64 rbp frame. Every function that
; calls a Win32 import reserves >= 0x20 of shadow space and keeps RSP 16-byte
; aligned. Non-volatile registers used (rbx, rsi, rdi, r12) are saved to frame
; locals at [rbp-8], [rbp-16], ...
; -----------------------------------------------------------------------------

; valloc(rcx = size) -> rax = pointer (os_alloc: committed, zeroed, read/write)
valloc:
    jmp  os_alloc

; valloc_req(rcx = size) -> rax = pointer; aborts the process if allocation fails
valloc_req:
    push rbp
    mov  rbp, rsp
    sub  rsp, 0x30
    call valloc
    test rax, rax
    jz   .fail
    mov  rsp, rbp
    pop  rbp
    ret
.fail:
    lea  rcx, [rel s_err_mem]
    call puts
    mov  ecx, 1
    call os_exit

; putn(rcx = ptr, rdx = len) -> writes len bytes to stdout, looping over
; os_write until the whole buffer is flushed (a pipe/ConPTY can accept a write
; only partially, which previously truncated long output such as SELECT *).
putn:
    push rbp
    mov  rbp, rsp
    sub  rsp, 0x40
    mov  [rbp-8], rbx                ; buffer cursor
    mov  [rbp-16], rsi               ; bytes remaining
    ; Reader mode buffers output so a command whose snapshot moved underneath it
    ; can be replayed without printing anything twice.
    cmp  qword [rel g_cap_on], 0
    je   .direct
    mov  rax, [rel g_cap_len]
    add  rax, rdx
    cmp  rax, CAP_BUF_SIZE
    ja   .overflow
    mov  [rbp-24], rdi
    mov  [rbp-32], rax               ; new length
    mov  rsi, rcx
    mov  rdi, [rel g_capbuf]
    add  rdi, [rel g_cap_len]
    mov  rcx, rdx
    rep  movsb
    mov  rax, [rbp-32]
    mov  [rel g_cap_len], rax
    mov  rdi, [rbp-24]
    jmp  .done
.overflow:
    ; Too much output to hold. Stop buffering, flush what we have, and remember
    ; that this command can no longer be replayed silently.
    mov  [rbp-24], rcx
    mov  [rbp-32], rdx
    mov  qword [rel g_cap_on], 0
    mov  qword [rel g_cap_ovf], 1
    mov  rcx, [rel g_capbuf]
    mov  rdx, [rel g_cap_len]
    mov  qword [rel g_cap_len], 0
    test rdx, rdx
    jz   .noflush
    call putn                        ; capture is off now: this writes directly
.noflush:
    mov  rcx, [rbp-24]
    mov  rdx, [rbp-32]
.direct:
    mov  rbx, rcx
    mov  rsi, rdx
.loop:
    test rsi, rsi
    jz   .done
    mov  rcx, [rel g_stdout]         ; handle
    mov  rdx, rbx                    ; buf
    mov  r8, rsi                     ; len
    call os_write
    test rax, rax
    jz   .done                       ; error - stop
    add  rbx, rax
    sub  rsi, rax
    jmp  .loop
.done:
    mov  rsi, [rbp-16]
    mov  rbx, [rbp-8]
    mov  rsp, rbp
    pop  rbp
    ret

; cap_begin() - start buffering console output
cap_begin:
    mov  qword [rel g_cap_len], 0
    mov  qword [rel g_cap_ovf], 0
    mov  qword [rel g_cap_on], 1
    ret

; cap_discard() - throw the buffered output away (the command will be replayed)
cap_discard:
    mov  qword [rel g_cap_len], 0
    mov  qword [rel g_cap_on], 0
    ret

; cap_flush() - emit the buffered output and leave capture mode
cap_flush:
    push rbp
    mov  rbp, rsp
    sub  rsp, 0x30
    mov  qword [rel g_cap_on], 0
    mov  rdx, [rel g_cap_len]
    test rdx, rdx
    jz   .out
    mov  rcx, [rel g_capbuf]
    mov  qword [rel g_cap_len], 0
    call putn
.out:
    mov  rsp, rbp
    pop  rbp
    ret

; puts(rcx = zero-terminated ptr). When color is on, lines beginning with
; "[ OK ]" render green and "[ERR]" render red (status messages only; color
; codes themselves start with ESC so they never re-trigger this path).
puts:
    push rbp
    mov  rbp, rsp
    sub  rsp, 0x40
    mov  [rbp-8], rsi
    mov  [rbp-16], rbx
    mov  rsi, rcx
    xor  ebx, ebx                    ; bl = 1 -> a color was emitted
    cmp  qword [rel g_color], 0
    je   .body
    mov  al, [rsi]
    cmp  al, '['
    jne  .body
    mov  al, [rsi+1]
    cmp  al, 'E'
    je   .err
    cmp  al, ' '
    jne  .body
    mov  al, [rsi+2]
    cmp  al, 'O'
    jne  .body
    lea  rcx, [rel c_green]
    call set_color
    mov  bl, 1
    jmp  .body
.err:
    lea  rcx, [rel c_red]
    call set_color
    mov  bl, 1
.body:
    xor  rdx, rdx
.len:
    cmp  byte [rsi+rdx], 0
    je   .go
    inc  rdx
    jmp  .len
.go:
    mov  rcx, rsi
    call putn
    test bl, bl
    jz   .noreset
    call reset_color
.noreset:
    mov  rbx, [rbp-16]
    mov  rsi, [rbp-8]
    mov  rsp, rbp
    pop  rbp
    ret

; putc(cl = char)
putc:
    push rbp
    mov  rbp, rsp
    sub  rsp, 0x40
    mov  [rel g_onech], cl
    lea  rcx, [rel g_onech]
    mov  rdx, 1
    call putn
    mov  rsp, rbp
    pop  rbp
    ret

; set_color(rcx = ANSI color z-string) - emits it only when color is enabled
set_color:
    cmp  qword [rel g_color], 0
    je   .skip
    jmp  puts
.skip:
    ret

; strlen(rcx = zptr) -> rax = length
strlen:
    xor  rax, rax
.l:
    cmp  byte [rcx+rax], 0
    je   .d
    inc  rax
    jmp  .l
.d:
    ret

; help_row(rcx = command z-str, rdx = description z-str)
;   "    " + command (cyan, padded to 30) + description (grey)
help_row:
    push rbp
    mov  rbp, rsp
    sub  rsp, 0x30
    mov  [rbp-8], rbx
    mov  [rbp-16], rsi
    mov  rbx, rcx                    ; command
    mov  rsi, rdx                    ; description
    mov  rcx, 4
    call put_spaces
    mov  rcx, rbx
    lea  rdx, [rel c_cyan]
    call puts_col
    mov  rcx, rbx
    call strlen
    mov  rcx, 30
    sub  rcx, rax
    cmp  rcx, 1
    jge  .pad
    mov  rcx, 1
.pad:
    call put_spaces
    mov  rcx, rsi
    lea  rdx, [rel c_grey]
    call puts_col
    call crlf
    mov  rsi, [rbp-16]
    mov  rbx, [rbp-8]
    mov  rsp, rbp
    pop  rbp
    ret

; reset_color() - emits ESC[0m only when color is enabled
reset_color:
    cmp  qword [rel g_color], 0
    je   .skip
    lea  rcx, [rel c_reset]
    jmp  puts
.skip:
    ret

; puts_col(rcx = text ptr, rdx = color ptr) - color, text, reset (color-gated)
puts_col:
    push rbp
    mov  rbp, rsp
    sub  rsp, 0x30
    mov  [rbp-8], rbx
    mov  rbx, rcx
    mov  rcx, rdx
    call set_color
    mov  rcx, rbx
    call puts
    call reset_color
    mov  rbx, [rbp-8]
    mov  rsp, rbp
    pop  rbp
    ret

; put_spaces(rcx = count)
put_spaces:
    push rbp
    mov  rbp, rsp
    sub  rsp, 0x40
    mov  [rbp-8], rbx
    mov  rbx, rcx
.loop:
    test rbx, rbx
    jle  .done
    mov  rax, rbx
    cmp  rax, 64
    jbe  .have
    mov  rax, 64
.have:
    sub  rbx, rax
    lea  rcx, [rel g_spaces]
    mov  rdx, rax
    call putn
    jmp  .loop
.done:
    mov  rbx, [rbp-8]
    mov  rsp, rbp
    pop  rbp
    ret

; put_repeat(cl = char, rdx = count)
put_repeat:
    push rbp
    mov  rbp, rsp
    sub  rsp, 0x40
    mov  [rbp-8], rbx
    mov  [rbp-16], rsi
    movzx ebx, cl                    ; char
    mov  rsi, rdx                    ; count
.loop:
    test rsi, rsi
    jle  .done
    mov  rcx, rbx
    call putc
    dec  rsi
    jmp  .loop
.done:
    mov  rsi, [rbp-16]
    mov  rbx, [rbp-8]
    mov  rsp, rbp
    pop  rbp
    ret

; crlf()
crlf:
    push rbp
    mov  rbp, rsp
    sub  rsp, 0x30
    mov  cl, 13
    call putc
    mov  cl, 10
    call putc
    mov  rsp, rbp
    pop  rbp
    ret

; print_banner() - colored startup banner (art stays plain when color is off)
print_banner:
    push rbp
    mov  rbp, rsp
    sub  rsp, 0x30
    call crlf
    lea  rcx, [rel bnr1]
    lea  rdx, [rel c_indigo]
    call puts_col
    call crlf
    lea  rcx, [rel bnr2]
    lea  rdx, [rel c_indigo]
    call puts_col
    call crlf
    lea  rcx, [rel bnr3]
    lea  rdx, [rel c_blue]
    call puts_col
    call crlf
    lea  rcx, [rel bnr4]
    lea  rdx, [rel c_cyan]
    call puts_col
    call crlf
    lea  rcx, [rel bnr5]
    lea  rdx, [rel c_cyan]
    call puts_col
    call crlf
    call crlf
    lea  rcx, [rel s_tagline]
    lea  rdx, [rel c_white]
    call puts_col
    call crlf
    lea  rcx, [rel s_meta]
    lea  rdx, [rel c_dim]
    call puts_col
    lea  rcx, [rel s_bnr_ver]
    lea  rdx, [rel c_dim]
    call puts_col
    mov  ecx, ENGINE_VERSION
    call put_ver
    call crlf
    call crlf
    lea  rcx, [rel s_hint_a]
    lea  rdx, [rel c_grey]
    call puts_col
    lea  rcx, [rel s_hint_hi1]
    lea  rdx, [rel c_yellow]
    call puts_col
    lea  rcx, [rel s_hint_b]
    lea  rdx, [rel c_grey]
    call puts_col
    lea  rcx, [rel s_hint_hi2]
    lea  rdx, [rel c_yellow]
    call puts_col
    lea  rcx, [rel s_hint_c]
    lea  rdx, [rel c_grey]
    call puts_col
    call crlf
    call crlf
    mov  rsp, rbp
    pop  rbp
    ret

; u64_to_dec(rcx = value, rdx = buf) -> rax = length (no NUL written)
u64_to_dec:
    push rbp
    mov  rbp, rsp
    push rdi                         ; save the CALLER's rdi, not the buffer
    mov  rax, rcx                    ; value
    mov  rdi, rdx                    ; buf
    xor  rcx, rcx                    ; digit count
    mov  r9, 10
.divloop:
    xor  rdx, rdx
    div  r9                          ; rax = quotient, rdx = remainder
    add  dl, '0'
    mov  [rdi+rcx], dl
    inc  rcx
    test rax, rax
    jnz  .divloop
    ; reverse [rdi .. rdi+rcx-1]
    mov  rax, rcx                    ; return length
    xor  r8, r8                      ; i = 0
    lea  r9, [rcx-1]                 ; j = len-1
.rev:
    cmp  r8, r9
    jge  .done
    mov  dl, [rdi+r8]
    mov  r10b, [rdi+r9]
    mov  [rdi+r8], r10b
    mov  [rdi+r9], dl
    inc  r8
    dec  r9
    jmp  .rev
.done:
    pop  rdi
    pop  rbp
    ret

; i64_to_dec(rcx = value, rdx = buf) -> rax = length
i64_to_dec:
    push rbp
    mov  rbp, rsp
    sub  rsp, 0x30
    test rcx, rcx
    jns  .pos
    mov  byte [rdx], '-'
    neg  rcx
    add  rdx, 1
    call u64_to_dec
    add  rax, 1
    jmp  .done
.pos:
    call u64_to_dec
.done:
    mov  rsp, rbp
    pop  rbp
    ret

; put_u64(rcx = value)
put_u64:
    push rbp
    mov  rbp, rsp
    sub  rsp, 0x30
    lea  rdx, [rel g_tmp]
    call u64_to_dec
    lea  rcx, [rel g_tmp]
    mov  rdx, rax
    call putn
    mov  rsp, rbp
    pop  rbp
    ret

; put_u64_field(rcx = value, rdx = width) - decimal + right pad to width
put_u64_field:
    push rbp
    mov  rbp, rsp
    sub  rsp, 0x40
    mov  [rbp-8], rbx
    mov  rbx, rdx                    ; width
    lea  rdx, [rel g_tmp]
    call u64_to_dec                  ; rax = len
    mov  [rbp-16], rax
    lea  rcx, [rel g_tmp]
    mov  rdx, rax
    call putn
    mov  rcx, rbx
    sub  rcx, [rbp-16]
    jle  .nopad
    call put_spaces
.nopad:
    mov  rbx, [rbp-8]
    mov  rsp, rbp
    pop  rbp
    ret

; put_i64_field(rcx = value, rdx = width)
put_i64_field:
    push rbp
    mov  rbp, rsp
    sub  rsp, 0x40
    mov  [rbp-8], rbx
    mov  rbx, rdx
    lea  rdx, [rel g_tmp]
    call i64_to_dec
    mov  [rbp-16], rax
    lea  rcx, [rel g_tmp]
    mov  rdx, rax
    call putn
    mov  rcx, rbx
    sub  rcx, [rbp-16]
    jle  .nopad
    call put_spaces
.nopad:
    mov  rbx, [rbp-8]
    mov  rsp, rbp
    pop  rbp
    ret

; put_field(rcx = ptr, rdx = width) - print up to `width` printable chars
; (stopping at NUL), right-pad with spaces. Longer text is truncated with a
; trailing '~' so columns never overflow.
put_field:
    push rbp
    mov  rbp, rsp
    sub  rsp, 0x40
    mov  [rbp-8], rbx
    mov  [rbp-16], rsi
    mov  rsi, rcx
    mov  rbx, rdx                    ; width
    xor  rax, rax
.len:
    cmp  rax, rbx
    jae  .over
    cmp  byte [rsi+rax], 0
    je   .print
    inc  rax
    jmp  .len
.over:
    cmp  byte [rsi+rax], 0
    je   .print                      ; exactly fills the column
    mov  rcx, rsi                    ; truncated: width-1 chars + '~'
    mov  rdx, rbx
    dec  rdx
    call putn
    mov  cl, '~'
    call putc
    jmp  .out
.print:
    mov  [rbp-24], rax               ; printable length
    mov  rcx, rsi
    mov  rdx, rax
    call putn
    mov  rcx, rbx
    sub  rcx, [rbp-24]
    jle  .out
    call put_spaces
.out:
    mov  rsi, [rbp-16]
    mov  rbx, [rbp-8]
    mov  rsp, rbp
    pop  rbp
    ret

; tsv_esc(rcx = src, rdx = max, r8 = dest) -> rax = bytes written.
;
; Copies up to `max` bytes (stopping at the first NUL) into `dest`, escaping the
; four sequences that would otherwise break the line protocol: backslash, TAB,
; LF and CR. Every other byte is copied verbatim, so UTF-8 survives untouched -
; the engine stores bytes and this format must not reinterpret them.
tsv_esc:
    push rbp
    mov  rbp, rsp
    push rbx
    push rsi
    push rdi
    mov  rsi, rcx
    mov  rdi, r8
    xor  rbx, rbx                    ; source index
    xor  r9, r9                      ; bytes written
.loop:
    cmp  rbx, rdx
    jae  .done
    movzx eax, byte [rsi+rbx]
    test al, al
    je   .done
    cmp  al, 0x5C                   ; backslash
    je   .esc_bs
    cmp  al, 9
    je   .esc_t
    cmp  al, 10
    je   .esc_n
    cmp  al, 13
    je   .esc_r
    mov  [rdi+r9], al
    inc  r9
    inc  rbx
    jmp  .loop
.esc_bs:
    mov  al, 0x5C
    jmp  .emit2
.esc_t:
    mov  al, 't'
    jmp  .emit2
.esc_n:
    mov  al, 'n'
    jmp  .emit2
.esc_r:
    mov  al, 'r'
.emit2:
    mov  byte [rdi+r9], 0x5C
    mov  [rdi+r9+1], al
    add  r9, 2
    inc  rbx
    jmp  .loop
.done:
    mov  rax, r9
    pop  rdi
    pop  rsi
    pop  rbx
    pop  rbp
    ret

; tsv_row(rcx = record ptr) - emit one machine-readable row:
;   R \t id \t value \t created \t updated \t tag \t content CRLF
;
; Built in one scratch buffer and written with a single call: a per-byte writer
; would issue a syscall per character on a scan of the whole store. Nothing here
; is ever truncated - that is the entire point of this format.
tsv_row:
    push rbp
    mov  rbp, rsp
    sub  rsp, 0x40
    mov  [rbp-8], rbx
    mov  [rbp-16], rdi
    mov  rbx, rcx                    ; slot
    mov  rdi, [rel g_tsvbuf]         ; write cursor
    mov  byte [rdi], 'R'
    mov  byte [rdi+1], 9
    add  rdi, 2
    mov  rcx, [rbx+REC_ID]
    mov  rdx, rdi
    call u64_to_dec
    add  rdi, rax
    mov  byte [rdi], 9
    inc  rdi
    mov  rcx, [rbx+REC_VALUE]
    mov  rdx, rdi
    call i64_to_dec
    add  rdi, rax
    mov  byte [rdi], 9
    inc  rdi
    mov  rcx, [rbx+REC_CREATED]
    mov  rdx, rdi
    call u64_to_dec
    add  rdi, rax
    mov  byte [rdi], 9
    inc  rdi
    mov  rcx, [rbx+REC_UPDATED]
    mov  rdx, rdi
    call u64_to_dec
    add  rdi, rax
    mov  byte [rdi], 9
    inc  rdi
    lea  rcx, [rbx+REC_TAG]
    mov  rdx, TAG_MAX
    mov  r8, rdi
    call tsv_esc
    add  rdi, rax
    mov  byte [rdi], 9
    inc  rdi
    lea  rcx, [rbx+REC_CONTENT]
    mov  rdx, CONTENT_MAX
    mov  r8, rdi
    call tsv_esc
    add  rdi, rax
    mov  byte [rdi], 13
    mov  byte [rdi+1], 10
    add  rdi, 2
    mov  rcx, [rel g_tsvbuf]
    mov  rdx, rdi
    sub  rdx, rcx
    call putn
    mov  rdi, [rbp-16]
    mov  rbx, [rbp-8]
    mov  rsp, rbp
    pop  rbp
    ret

; console_fill() -> rax = bytes read (0 = EOF); refills g_readbuf
console_fill:
    push rbp
    mov  rbp, rsp
    sub  rsp, 0x40
    mov  rcx, [rel g_stdin]
    mov  rdx, [rel g_readbuf]
    mov  r8d, READ_BUF_SIZE
    call os_read
    test rax, rax
    jz   .eof
    mov  [rel g_readlen], rax
    mov  qword [rel g_readpos], 0
    ; One-time: skip a leading UTF-8 BOM (EF BB BF) at the very start of the
    ; stream. Some shells (e.g. PowerShell piping to a native command) prepend
    ; one, which would otherwise turn the first command into an unknown token.
    cmp  qword [rel g_bom_seen], 0
    jne  .done
    mov  qword [rel g_bom_seen], 1
    cmp  rax, 3
    jb   .done
    mov  rcx, [rel g_readbuf]
    cmp  byte [rcx], 0xEF
    jne  .done
    cmp  byte [rcx+1], 0xBB
    jne  .done
    cmp  byte [rcx+2], 0xBF
    jne  .done
    mov  qword [rel g_readpos], 3
    jmp  .done
.eof:
    mov  qword [rel g_readlen], 0
    mov  qword [rel g_readpos], 0
    xor  rax, rax
.done:
    mov  rsp, rbp
    pop  rbp
    ret

; console_getc() -> rax = byte (0..255) or -1 on EOF
console_getc:
    push rbp
    mov  rbp, rsp
    sub  rsp, 0x30
.retry:
    mov  rax, [rel g_readpos]
    cmp  rax, [rel g_readlen]
    jb   .have
    call console_fill
    test rax, rax
    jz   .eof
    jmp  .retry                      ; a BOM skip may have consumed the whole
                                     ; buffer (first pipe write = the 3-byte BOM
                                     ; only) - re-check before indexing
.have:
    mov  rdx, [rel g_readpos]
    mov  rcx, [rel g_readbuf]
    movzx eax, byte [rcx+rdx]
    inc  rdx
    mov  [rel g_readpos], rdx
    jmp  .done
.eof:
    mov  rax, -1
.done:
    mov  rsp, rbp
    pop  rbp
    ret

; read_line(rcx = dest, rdx = max) -> rax = length, -1 on EOF with no data,
; or -2 when the line was longer than the buffer.
;
; An over-long line must never be executed. Silently dropping the tail turns
; "INSERT 1 5 tag <very long content>" into a shorter row that the caller
; believes was stored verbatim, and a truncated DELETE/RESTORE would act on a
; different target than the one typed. Overflow is a refusal, not a trim.
read_line:
    push rbp
    mov  rbp, rsp
    sub  rsp, 0x40
    mov  [rbp-8], rbx
    mov  [rbp-16], rsi
    mov  rsi, rcx                    ; dest
    mov  [rbp-24], rdx               ; max
    xor  rbx, rbx                    ; count
    mov  qword [rbp-32], 0           ; overflow flag
.next:
    call console_getc
    cmp  rax, -1
    je   .eof
    cmp  al, 10
    je   .eol
    cmp  al, 13
    je   .next
    mov  rcx, [rbp-24]
    dec  rcx
    cmp  rbx, rcx
    jae  .over                       ; keep consuming to EOL, but remember
    mov  [rsi+rbx], al
    inc  rbx
    jmp  .next
.over:
    mov  qword [rbp-32], 1
    jmp  .next
.eol:
    mov  byte [rsi+rbx], 0
    cmp  qword [rbp-32], 0
    jne  .toolong
    mov  rax, rbx
    jmp  .done
.toolong:
    mov  byte [rsi], 0               ; never hand a partial command to dispatch
    mov  rax, -2
    jmp  .done
.eof:
    test rbx, rbx
    jnz  .eol
    mov  rax, -1
.done:
    mov  rsi, [rbp-16]
    mov  rbx, [rbp-8]
    mov  rsp, rbp
    pop  rbp
    ret

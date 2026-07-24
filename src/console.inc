; -----------------------------------------------------------------------------
; src/console.inc - buffered console I/O and formatting helpers.
;
; Calling convention (internal): standard Win64 rbp frame. Every function that
; calls a Win32 import reserves >= 0x20 of shadow space and keeps RSP 16-byte
; aligned. Non-volatile registers used (rbx, rsi, rdi, r12) are saved to frame
; locals at [rbp-8], [rbp-16], ...
; -----------------------------------------------------------------------------

; valloc(rcx = size) -> rax = pointer (VirtualAlloc, MEM_COMMIT|RESERVE, RW)
valloc:
    push rbp
    mov  rbp, rsp
    sub  rsp, 0x30
    mov  rdx, rcx                    ; dwSize
    xor  rcx, rcx                    ; lpAddress = NULL
    mov  r8d, MEM_COMMIT_RESERVE
    mov  r9d, PAGE_READWRITE
    call [rel iat_VirtualAlloc]
    mov  rsp, rbp
    pop  rbp
    ret

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
    call [rel iat_ExitProcess]

; putn(rcx = ptr, rdx = len) -> writes len bytes to stdout
putn:
    push rbp
    mov  rbp, rsp
    sub  rsp, 0x40
    mov  r8, rdx                     ; nNumberOfBytesToWrite
    mov  rdx, rcx                    ; lpBuffer
    mov  rcx, [rel g_stdout]         ; hFile
    lea  r9, [rel g_written]         ; lpNumberOfBytesWritten
    mov  qword [rsp+0x20], 0         ; lpOverlapped = NULL
    call [rel iat_WriteFile]
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
    mov  rax, rcx                    ; value
    mov  rdi, rdx                    ; buf  (rdi is non-volatile; save/restore)
    push rdi
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

; console_fill() -> rax = bytes read (0 = EOF); refills g_readbuf
console_fill:
    push rbp
    mov  rbp, rsp
    sub  rsp, 0x40
    mov  rcx, [rel g_stdin]
    mov  rdx, [rel g_readbuf]
    mov  r8d, READ_BUF_SIZE
    lea  r9, [rel g_readlen_dw]
    mov  qword [rsp+0x20], 0
    call [rel iat_ReadFile]
    test rax, rax
    jz   .eof
    mov  eax, [rel g_readlen_dw]
    test eax, eax
    jz   .eof
    mov  [rel g_readlen], rax
    mov  qword [rel g_readpos], 0
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
    mov  rax, [rel g_readpos]
    cmp  rax, [rel g_readlen]
    jb   .have
    call console_fill
    test rax, rax
    jz   .eof
    xor  rax, rax                    ; pos = 0 after fill
.have:
    mov  rcx, [rel g_readbuf]
    movzx eax, byte [rcx+rax]
    mov  rdx, [rel g_readpos]
    inc  rdx
    mov  [rel g_readpos], rdx
    jmp  .done
.eof:
    mov  rax, -1
.done:
    mov  rsp, rbp
    pop  rbp
    ret

; read_line(rcx = dest, rdx = max) -> rax = length, or -1 on EOF with no data
read_line:
    push rbp
    mov  rbp, rsp
    sub  rsp, 0x40
    mov  [rbp-8], rbx
    mov  [rbp-16], rsi
    mov  rsi, rcx                    ; dest
    mov  [rbp-24], rdx               ; max
    xor  rbx, rbx                    ; count
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
    jae  .next                       ; drop overflow, keep consuming to EOL
    mov  [rsi+rbx], al
    inc  rbx
    jmp  .next
.eol:
    mov  byte [rsi+rbx], 0
    mov  rax, rbx
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

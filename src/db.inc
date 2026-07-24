; -----------------------------------------------------------------------------
; src/db.inc - on-disk persistence for asmdb.dat (header + slot region).
; Autocommit durability: every mutation writes the slot + header and flushes.
; -----------------------------------------------------------------------------

; strcpy_z(rdi = dest, rsi = src) -> rdi points at the terminating NUL written
strcpy_z:
    mov  al, [rsi]
    mov  [rdi], al
    test al, al
    je   .done
    inc  rsi
    inc  rdi
    jmp  strcpy_z
.done:
    ret

; strcpy_n(rdi = dest, rsi = src, rcx = count) - copy src until NUL, zero-pad to
; exactly count bytes. Clobbers rax, r8, r10.
strcpy_n:
    xor  r8, r8
    xor  r10b, r10b
.l:
    cmp  r8, rcx
    jae  .d
    test r10b, r10b
    jnz  .pad
    mov  al, [rsi+r8]
    test al, al
    jz   .startpad
    mov  [rdi+r8], al
    inc  r8
    jmp  .l
.startpad:
    mov  r10b, 1
.pad:
    mov  byte [rdi+r8], 0
    inc  r8
    jmp  .l
.d:
    ret

; read_at(rcx = offset, rdx = buf, r8 = len) -> rax = bytes read
read_at:
    push rbp
    mov  rbp, rsp
    sub  rsp, 0x50
    mov  [rbp-8], rcx
    mov  [rbp-16], rdx
    mov  [rbp-24], r8
    mov  rcx, [rel g_dat_handle]
    mov  rdx, [rbp-8]
    xor  r8, r8
    mov  r9d, FILE_BEGIN
    call [rel iat_SetFilePointerEx]
    mov  rcx, [rel g_dat_handle]
    mov  rdx, [rbp-16]
    mov  r8, [rbp-24]
    lea  r9, [rel g_io_dw]
    mov  qword [rsp+0x20], 0
    call [rel iat_ReadFile]
    mov  eax, [rel g_io_dw]
    mov  rsp, rbp
    pop  rbp
    ret

; write_at(rcx = offset, rdx = buf, r8 = len)
write_at:
    push rbp
    mov  rbp, rsp
    sub  rsp, 0x50
    mov  [rbp-8], rcx
    mov  [rbp-16], rdx
    mov  [rbp-24], r8
    mov  rcx, [rel g_dat_handle]
    mov  rdx, [rbp-8]
    xor  r8, r8
    mov  r9d, FILE_BEGIN
    call [rel iat_SetFilePointerEx]
    mov  rcx, [rel g_dat_handle]
    mov  rdx, [rbp-16]
    mov  r8, [rbp-24]
    lea  r9, [rel g_io_dw]
    mov  qword [rsp+0x20], 0
    call [rel iat_WriteFile]
    mov  rsp, rbp
    pop  rbp
    ret

; db_flush()
db_flush:
    push rbp
    mov  rbp, rsp
    sub  rsp, 0x30
    mov  rcx, [rel g_dat_handle]
    call [rel iat_FlushFileBuffers]
    mov  rsp, rbp
    pop  rbp
    ret

; db_write_header() - refresh count field then persist the 512-byte header
db_write_header:
    push rbp
    mov  rbp, rsp
    sub  rsp, 0x30
    mov  [rbp-8], rsi
    mov  [rbp-16], rdi
    mov  rax, [rel g_count]
    mov  [rel g_hdr+24], rax
    lea  rdi, [rel g_hdr+HDR_TABLE]
    lea  rsi, [rel g_tablename]
    mov  rcx, TABLE_MAX
    call strcpy_n
    xor  rcx, rcx
    lea  rdx, [rel g_hdr]
    mov  r8, HDR_SIZE
    call write_at
    mov  rdi, [rbp-16]
    mov  rsi, [rbp-8]
    mov  rsp, rbp
    pop  rbp
    ret

; db_write_slot(rcx = slot ptr) - write one 256-byte record to disk
db_write_slot:
    push rbp
    mov  rbp, rsp
    sub  rsp, 0x30
    mov  [rbp-8], rcx
    call store_slot_index            ; rax = index (rcx = slot ptr)
    shl  rax, REC_SHIFT
    add  rax, HDR_SIZE
    mov  rcx, rax
    mov  rdx, [rbp-8]
    mov  r8, REC_SIZE
    call write_at
    mov  rsp, rbp
    pop  rbp
    ret

; db_persist_slot(rcx = slot ptr) - slot + header + flush (durable autocommit)
db_persist_slot:
    push rbp
    mov  rbp, rsp
    sub  rsp, 0x30
    call db_write_slot               ; rcx = slot ptr
    call db_write_header
    call db_flush
    mov  rsp, rbp
    pop  rbp
    ret

; db_init_names() - derive g_datname / g_walname from the command-line arg
db_init_names:
    push rbp
    mov  rbp, rsp
    sub  rsp, 0x40
    mov  [rbp-16], rsi
    mov  [rbp-24], rdi
    call [rel iat_GetCommandLineA]
    mov  rsi, rax
    ; skip program name (handle quoted path)
    mov  al, [rsi]
    cmp  al, '"'
    jne  .noq
    inc  rsi
.q:
    mov  al, [rsi]
    test al, al
    je   .default
    inc  rsi
    cmp  al, '"'
    jne  .q
    jmp  .afterprog
.noq:
    mov  al, [rsi]
    test al, al
    je   .default
    cmp  al, ' '
    je   .afterprog
    inc  rsi
    jmp  .noq
.afterprog:
    call skip_spaces_rsi
    mov  al, [rsi]
    test al, al
    je   .default
    cmp  al, '"'
    jne  .copy
    inc  rsi
.copy:
    lea  rdi, [rel g_base]
    xor  rcx, rcx
.cl:
    mov  al, [rsi]
    test al, al
    je   .cend
    cmp  al, ' '
    je   .cend
    cmp  al, '"'
    je   .cend
    cmp  rcx, 200
    jae  .cend
    mov  [rdi+rcx], al
    inc  rsi
    inc  rcx
    jmp  .cl
.cend:
    mov  byte [rdi+rcx], 0
    test rcx, rcx
    jz   .default
    ; optional 2nd arg = table name
    mov  al, [rsi]
    cmp  al, '"'
    jne  .tsp
    inc  rsi
.tsp:
    call skip_spaces_rsi
    mov  al, [rsi]
    test al, al
    je   .build
    cmp  al, '"'
    jne  .tcopy
    inc  rsi
.tcopy:
    lea  rdi, [rel g_argtable]
    xor  rcx, rcx
.tl:
    mov  al, [rsi]
    test al, al
    je   .tend
    cmp  al, ' '
    je   .tend
    cmp  al, '"'
    je   .tend
    cmp  rcx, TABLE_MAX-1
    jae  .tend
    mov  [rdi+rcx], al
    inc  rsi
    inc  rcx
    jmp  .tl
.tend:
    mov  byte [rdi+rcx], 0
    test rcx, rcx
    jz   .build
    mov  dword [rel g_have_argtable], 1
    jmp  .build
.default:
    lea  rdi, [rel g_base]
    lea  rsi, [rel s_defbase]
    call strcpy_z
.build:
    lea  rdi, [rel g_datname]
    lea  rsi, [rel g_base]
    call strcpy_z
    lea  rsi, [rel s_dotdat]
    call strcpy_z
    lea  rdi, [rel g_walname]
    lea  rsi, [rel g_base]
    call strcpy_z
    lea  rsi, [rel s_dotwal]
    call strcpy_z
    mov  rdi, [rbp-24]
    mov  rsi, [rbp-16]
    mov  rsp, rbp
    pop  rbp
    ret

; db_open() - open/create g_datname; load header + slots, or initialize a new file
db_open:
    push rbp
    mov  rbp, rsp
    sub  rsp, 0x50
    lea  rcx, [rel g_datname]
    mov  rdx, GENERIC_READ | GENERIC_WRITE
    xor  r8, r8                      ; exclusive - no sharing (single-writer)
    xor  r9, r9
    mov  dword [rsp+0x20], OPEN_ALWAYS
    mov  dword [rsp+0x28], FILE_ATTRIBUTE_NORMAL
    mov  qword [rsp+0x30], 0
    call [rel iat_CreateFileA]
    mov  [rel g_dat_handle], rax
    cmp  rax, INVALID_HANDLE
    je   .openfail
    call wal_open
    call wal_recover
    ; read the header
    xor  rcx, rcx
    lea  rdx, [rel g_hdr_read]
    mov  r8, HDR_SIZE
    call read_at
    cmp  rax, HDR_SIZE
    jb   .newfile
    ; validate magic (5 bytes)
    lea  rsi, [rel g_hdr_read]
    lea  rdi, [rel s_magic]
    mov  rcx, 5
.magic:
    mov  al, [rsi]
    cmp  al, [rdi]
    jne  .newfile
    inc  rsi
    inc  rdi
    dec  rcx
    jnz  .magic
    ; load count and slot region
    mov  rax, [rel g_hdr_read+24]
    mov  [rel g_count], rax
    ; resolve table name: CLI arg overrides, else header, else base
    cmp  dword [rel g_have_argtable], 0
    jne  .name_arg
    lea  rsi, [rel g_hdr_read+HDR_TABLE]
    mov  al, [rsi]
    test al, al
    jnz  .name_copy
    lea  rsi, [rel g_base]
.name_copy:
    lea  rdi, [rel g_tablename]
    mov  rcx, TABLE_MAX
    call strcpy_n
    jmp  .name_done
.name_arg:
    lea  rsi, [rel g_argtable]
    lea  rdi, [rel g_tablename]
    mov  rcx, TABLE_MAX
    call strcpy_n
    call db_write_header
    call db_flush
.name_done:
    mov  rcx, HDR_SIZE
    mov  rdx, [rel g_table]
    mov  r8, CAPACITY*REC_SIZE
    call read_at
    jmp  .done
.newfile:
    mov  qword [rel g_count], 0
    cmp  dword [rel g_have_argtable], 0
    jne  .nf_arg
    lea  rsi, [rel g_base]
    jmp  .nf_copy
.nf_arg:
    lea  rsi, [rel g_argtable]
.nf_copy:
    lea  rdi, [rel g_tablename]
    mov  rcx, TABLE_MAX
    call strcpy_n
    call db_write_header
    mov  rcx, HDR_SIZE
    mov  rdx, [rel g_table]
    mov  r8, CAPACITY*REC_SIZE
    call write_at
    call db_flush
.done:
    mov  rsp, rbp
    pop  rbp
    ret
.openfail:
    call [rel iat_GetLastError]      ; read before any call clobbers it
    cmp  eax, ERROR_SHARING_VIOLATION
    jne  .openfail_generic
    lea  rcx, [rel s_err_lock]
    call puts
    mov  ecx, 1
    call [rel iat_ExitProcess]
.openfail_generic:
    lea  rcx, [rel s_err_open]
    call puts
    mov  ecx, 1
    call [rel iat_ExitProcess]

; db_close()
db_close:
    push rbp
    mov  rbp, rsp
    sub  rsp, 0x30
    call db_flush
    mov  rcx, [rel g_dat_handle]
    call [rel iat_CloseHandle]
    call wal_close
    mov  rsp, rbp
    pop  rbp
    ret

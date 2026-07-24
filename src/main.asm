; -----------------------------------------------------------------------------
; src/main.asm - asmdb: a minimalist transactional database in x86-64 assembly.
;
; Assembled by NASM alone (no linker, no CRT):
;   nasm -f bin main.asm -o ..\build\asmdb.exe   (run from src\)
;
; The PE64 image, kernel32 import table and all code/data live in one section.
; The record store is allocated at runtime via VirtualAlloc.
; -----------------------------------------------------------------------------
BITS 64
ORG 0x400000

%include "asmdb.inc"

; ============================= DOS HEADER ====================================
dos_header:
    db 'MZ'
    times 0x3a db 0
    dd RVA(pe_header)

; ============================= PE HEADER =====================================
pe_header:
    db 'PE', 0, 0
    dw 0x8664                        ; Machine = AMD64
    dw 1                             ; NumberOfSections
    dd 0                             ; TimeDateStamp
    dd 0                             ; PointerToSymbolTable
    dd 0                             ; NumberOfSymbols
    dw opt_header_end - opt_header   ; SizeOfOptionalHeader
    dw 0x0022                        ; EXECUTABLE_IMAGE | LARGE_ADDRESS_AWARE

opt_header:
    dw 0x020b                        ; PE32+
    db 0, 0
    dd RVA(sec_end) - RVA(sec_start) ; SizeOfCode
    dd 0
    dd 0
    dd RVA(entry)                    ; AddressOfEntryPoint
    dd RVA(sec_start)                ; BaseOfCode
    dq IMAGEBASE
    dd ALIGN                         ; SectionAlignment
    dd ALIGN                         ; FileAlignment
    dw 6, 0
    dw 0, 0
    dw 6, 0
    dd 0
    dd image_size                    ; SizeOfImage
    dd ALIGN                         ; SizeOfHeaders
    dd 0
    dw 3                             ; Subsystem = WINDOWS_CUI
    dw 0
    dq 0x100000
    dq 0x1000
    dq 0x100000
    dq 0x1000
    dd 0
    dd 16                            ; NumberOfRvaAndSizes
    dd 0, 0                          ; [0] Export
    dd RVA(import_dir), import_dir_size ; [1] Import
    times 14 dd 0, 0
opt_header_end:

; ============================= SECTION TABLE =================================
section_header:
    db '.text', 0, 0, 0
    dd RVA(sec_end) - RVA(sec_start) ; VirtualSize
    dd RVA(sec_start)                ; VirtualAddress
    dd sec_raw_size                  ; SizeOfRawData
    dd RVA(sec_start)                ; PointerToRawData
    dd 0, 0
    dw 0, 0
    dd 0xE0000060                    ; CODE | EXECUTE | READ | WRITE
headers_end:
    times ALIGN - (headers_end - dos_header) db 0

; ============================= .text SECTION =================================
sec_start:

; ------------------------------- entry --------------------------------------
entry:
    push rbp
    mov  rbp, rsp
    and  rsp, -16                    ; guarantee 16-byte alignment
    sub  rsp, 0x40

    mov  ecx, STD_OUTPUT_HANDLE
    call [rel iat_GetStdHandle]
    mov  [rel g_stdout], rax
    mov  ecx, STD_INPUT_HANDLE
    call [rel iat_GetStdHandle]
    mov  [rel g_stdin], rax

    ; enable ANSI colors only when stdout is a real console (not piped)
    mov  rcx, [rel g_stdout]
    lea  rdx, [rel g_conmode]
    call [rel iat_GetConsoleMode]
    test eax, eax
    jz   .nocolor
    mov  rcx, [rel g_stdout]
    mov  edx, [rel g_conmode]
    or   edx, ENABLE_VT
    call [rel iat_SetConsoleMode]
    mov  qword [rel g_color], 1
.nocolor:

    mov  ecx, READ_BUF_SIZE
    call valloc_req
    mov  [rel g_readbuf], rax
    mov  ecx, LINE_MAX
    call valloc_req
    mov  [rel g_linebuf], rax
    mov  rcx, CAPACITY*REC_SIZE
    call valloc_req
    mov  [rel g_table], rax
    mov  rcx, UNDO_MAX*UNDO_ENTRY
    call valloc_req
    mov  [rel g_undo], rax
    mov  rcx, WAL_BUF_SIZE
    call valloc_req
    mov  [rel g_walbuf], rax

    mov  qword [rel g_readpos], 0
    mov  qword [rel g_readlen], 0
    mov  qword [rel g_count], 0
    mov  qword [rel g_in_txn], 0
    mov  qword [rel g_undo_n], 0

    call db_init_names
    call db_open

    call print_banner

    call repl_loop

    call db_close
    xor  ecx, ecx
    call [rel iat_ExitProcess]

; ----------------------------- REPL loop ------------------------------------
repl_loop:
    push rbp
    mov  rbp, rsp
    sub  rsp, 0x30
.loop:
    lea  rcx, [rel s_prompt]
    lea  rdx, [rel c_prompt]
    call puts_col
    mov  rcx, [rel g_linebuf]
    mov  rdx, LINE_MAX
    call read_line
    cmp  rax, -1
    je   .quit
    mov  rcx, [rel g_linebuf]
    call dispatch
    cmp  rax, CMD_EXIT
    je   .quit
    jmp  .loop
.quit:
    mov  rsp, rbp
    pop  rbp
    ret

; --------------------------- included modules -------------------------------
%include "console.inc"
%include "parse.inc"
%include "store.inc"
%include "db.inc"
%include "wal.inc"
%include "data.inc"

sec_end:

sec_raw_size equ ((sec_end - sec_start) + ALIGN - 1) & ~(ALIGN - 1)
image_size   equ (ALIGN + sec_raw_size + ALIGN - 1) & ~(ALIGN - 1)

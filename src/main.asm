; -----------------------------------------------------------------------------
; src/main.asm - asmdb: a minimalist transactional database in x86-64 assembly.
;
; Assembled by NASM alone (no linker, no CRT):
;   Windows: nasm -f bin main.asm -o ..\build\asmdb.exe        (run from src\)
;   Linux:   nasm -f bin -dLINUX main.asm -o ../build/asmdb    (run from src/)
;
; A single read/write/execute image holds all code, data and globals. On
; Windows it is a hand-built PE64 with a kernel32 import table; on Linux it is a
; hand-built ELF64 that issues syscalls directly. Every OS interaction goes
; through the os_* platform layer (os_win.inc / os_linux.inc). The record store
; is allocated at runtime (VirtualAlloc on Windows, mmap on Linux).
; -----------------------------------------------------------------------------
BITS 64

%include "asmdb.inc"

%ifdef LINUX
; ============================= ELF64 HEADER ==================================
%include "elf.inc"
%else
ORG IMAGEBASE

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
%endif

; ------------------------------- entry --------------------------------------
entry:
%ifdef LINUX
    mov  [rel g_sp0], rsp            ; capture argc/argv pointer before aligning
%endif
    and  rsp, -16                    ; guarantee 16-byte alignment
    sub  rsp, 0x40

    call os_init_std                 ; std handles + ANSI colour enable

    mov  ecx, READ_BUF_SIZE
    call valloc_req
    mov  [rel g_readbuf], rax
    mov  ecx, LINE_MAX
    call valloc_req
    mov  [rel g_linebuf], rax
    ; g_table is NOT allocated here: db_open maps the .dat copy-on-write, so the
    ; store costs address space rather than 1 GiB of committed, zeroed memory.
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

    call crc32_init                  ; WAL frame checksums

    call db_init_names
    cmp  qword [rel g_upgrade], 0
    jne  .upgrade
    call db_open

    call print_banner

    call repl_loop

    call db_close
    xor  ecx, ecx
    call os_exit
.upgrade:
    call db_upgrade                  ; migrate in place of the normal session
    mov  ecx, eax
    call os_exit

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
%ifdef LINUX
%include "os_linux.inc"
%else
%include "os_win.inc"
%endif
%include "data.inc"

sec_end:

%ifndef LINUX
sec_raw_size equ ((sec_end - sec_start) + ALIGN - 1) & ~(ALIGN - 1)
image_size   equ (ALIGN + sec_raw_size + ALIGN - 1) & ~(ALIGN - 1)
%endif

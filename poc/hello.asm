; -----------------------------------------------------------------------------
; poc/hello.asm - Minimal PE64 executable built with NASM alone (-f bin).
; No linker, no CRT. Hand-crafted PE header + kernel32 import table.
; Proves the toolchain path for the asmdb project.
;
;   Build:  nasm -f bin poc\hello.asm -o build\hello.exe
;   Run:    build\hello.exe
; -----------------------------------------------------------------------------
BITS 64
ORG 0x400000

%define IMAGEBASE 0x400000
%define ALIGN     0x200
%define RVA(x)    ((x) - IMAGEBASE)

; ============================= DOS HEADER ====================================
dos_header:
    db 'MZ'                          ; e_magic
    times 0x3a db 0                  ; pad up to e_lfanew field (offset 0x3c)
    dd RVA(pe_header)                ; e_lfanew

; ============================= PE HEADER =====================================
pe_header:
    db 'PE', 0, 0                    ; Signature

; ---- IMAGE_FILE_HEADER ----
    dw 0x8664                        ; Machine = IMAGE_FILE_MACHINE_AMD64
    dw 1                             ; NumberOfSections
    dd 0                             ; TimeDateStamp
    dd 0                             ; PointerToSymbolTable
    dd 0                             ; NumberOfSymbols
    dw opt_header_end - opt_header   ; SizeOfOptionalHeader
    dw 0x0022                        ; Characteristics: EXECUTABLE_IMAGE | LARGE_ADDRESS_AWARE

; ---- IMAGE_OPTIONAL_HEADER64 ----
opt_header:
    dw 0x020b                        ; Magic = PE32+
    db 0, 0                          ; Linker version
    dd RVA(sec_end) - RVA(sec_start) ; SizeOfCode
    dd 0                             ; SizeOfInitializedData
    dd 0                             ; SizeOfUninitializedData
    dd RVA(entry)                    ; AddressOfEntryPoint
    dd RVA(sec_start)                ; BaseOfCode
    dq IMAGEBASE                     ; ImageBase
    dd ALIGN                         ; SectionAlignment
    dd ALIGN                         ; FileAlignment
    dw 6, 0                          ; OS version
    dw 0, 0                          ; Image version
    dw 6, 0                          ; Subsystem version
    dd 0                             ; Win32VersionValue
    dd image_size                    ; SizeOfImage
    dd ALIGN                         ; SizeOfHeaders
    dd 0                             ; CheckSum
    dw 3                             ; Subsystem = WINDOWS_CUI (console)
    dw 0                             ; DllCharacteristics
    dq 0x100000                      ; SizeOfStackReserve
    dq 0x1000                        ; SizeOfStackCommit
    dq 0x100000                      ; SizeOfHeapReserve
    dq 0x1000                        ; SizeOfHeapCommit
    dd 0                             ; LoaderFlags
    dd 16                            ; NumberOfRvaAndSizes
    ; Data directories
    dd 0, 0                          ; [0]  Export
    dd RVA(import_dir), import_dir_size ; [1] Import
    times 14 dd 0, 0                 ; [2..15]
opt_header_end:

; ============================= SECTION TABLE =================================
section_header:
    db '.text', 0, 0, 0              ; Name
    dd RVA(sec_end) - RVA(sec_start) ; VirtualSize
    dd RVA(sec_start)                ; VirtualAddress
    dd sec_raw_size                  ; SizeOfRawData
    dd RVA(sec_start)                ; PointerToRawData (== VA, alignment trick)
    dd 0                             ; PointerToRelocations
    dd 0                             ; PointerToLinenumbers
    dw 0                             ; NumberOfRelocations
    dw 0                             ; NumberOfLinenumbers
    dd 0xE0000060                    ; CODE | EXECUTE | READ | WRITE
headers_end:

    times ALIGN - (headers_end - dos_header) db 0   ; pad to SizeOfHeaders

; ============================= .text SECTION =================================
sec_start:
entry:
    sub  rsp, 40                     ; shadow space + align
    mov  ecx, -11                    ; STD_OUTPUT_HANDLE
    call [rel iat_GetStdHandle]
    mov  rcx, rax                    ; hFile
    lea  rdx, [rel msg]              ; lpBuffer
    mov  r8d, msg_len                ; nNumberOfBytesToWrite
    lea  r9,  [rel written]          ; lpNumberOfBytesWritten
    mov  qword [rsp+32], 0           ; lpOverlapped = NULL
    call [rel iat_WriteFile]
    xor  ecx, ecx                    ; exit code 0
    call [rel iat_ExitProcess]

msg:     db 'asmdb POC: hello from a linker-free PE64!', 13, 10
msg_len  equ $ - msg
written:  dd 0

; ---- Import directory ----
align 4
import_dir:
    dd 0                             ; OriginalFirstThunk (0 -> use FirstThunk)
    dd 0                             ; TimeDateStamp
    dd 0                             ; ForwarderChain
    dd RVA(dll_name)                 ; Name
    dd RVA(iat)                      ; FirstThunk
    times 5 dd 0                     ; null terminator descriptor
import_dir_size equ $ - import_dir

align 8
iat:
iat_GetStdHandle: dq RVA(hint_GetStdHandle)
iat_WriteFile:    dq RVA(hint_WriteFile)
iat_ExitProcess:  dq RVA(hint_ExitProcess)
                  dq 0

dll_name: db 'kernel32.dll', 0

align 2
hint_GetStdHandle: dw 0
    db 'GetStdHandle', 0
align 2
hint_WriteFile:    dw 0
    db 'WriteFile', 0
align 2
hint_ExitProcess:  dw 0
    db 'ExitProcess', 0

sec_end:

; Raw size of section on disk, rounded up to FileAlignment.
sec_raw_size  equ ((sec_end - sec_start) + ALIGN - 1) & ~(ALIGN - 1)
; SizeOfImage = headers + section virtual size, rounded to SectionAlignment.
image_size    equ (ALIGN + sec_raw_size + ALIGN - 1) & ~(ALIGN - 1)

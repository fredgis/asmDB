; -----------------------------------------------------------------------------
; src/elf.inc - hand-built ELF64 header for the Linux build (assembled by NASM
; alone with -f bin -dLINUX; no linker, no CRT).
;
; The whole image is one read/write/execute PT_LOAD segment mapped at 0x400000:
; code, data and globals all live together (there is no separate .bss - every
; global is file-initialised - so p_filesz == p_memsz). The kernel enters at
; `entry` (defined in main.asm right after this header) with argc/argv on the
; stack.
; -----------------------------------------------------------------------------
ORG 0x400000

ehdr:
    db  0x7F, 'E', 'L', 'F'          ; EI_MAG
    db  2                            ; EI_CLASS   = ELFCLASS64
    db  1                            ; EI_DATA    = ELFDATA2LSB (little-endian)
    db  1                            ; EI_VERSION = EV_CURRENT
    db  0                            ; EI_OSABI   = System V
    dq  0                            ; EI_ABIVERSION + 7 pad bytes
    dw  2                            ; e_type      = ET_EXEC
    dw  0x3E                         ; e_machine   = AMD x86-64
    dd  1                            ; e_version
    dq  entry                        ; e_entry     (absolute virtual address)
    dq  phdr - ehdr                  ; e_phoff     (program header file offset)
    dq  0                            ; e_shoff     (no section headers)
    dd  0                            ; e_flags
    dw  64                           ; e_ehsize    (ELF64 header size)
    dw  56                           ; e_phentsize (program header entry size)
    dw  1                            ; e_phnum
    dw  0                            ; e_shentsize
    dw  0                            ; e_shnum
    dw  0                            ; e_shstrndx

phdr:
    dd  1                            ; p_type   = PT_LOAD
    dd  7                            ; p_flags  = PF_R | PF_W | PF_X
    dq  0                            ; p_offset (map from the start of the file)
    dq  ehdr                         ; p_vaddr  (= 0x400000)
    dq  ehdr                         ; p_paddr
    dq  sec_end - ehdr               ; p_filesz (whole image)
    dq  sec_end - ehdr               ; p_memsz  (no BSS: memsz == filesz)
    dq  0x1000                       ; p_align  (page)

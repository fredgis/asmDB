; -----------------------------------------------------------------------------
; src/store.inc - open-addressing hash table over fixed 256-byte records.
; The record array IS the index (allocated via VirtualAlloc at startup).
; -----------------------------------------------------------------------------

; store_hash(rcx = id) -> rax = slot index (0 .. CAPACITY-1)
store_hash:
    mov  rax, rcx
    mov  rdx, GOLDEN
    imul rax, rdx                    ; low 64 bits of id * golden ratio
    shr  rax, CAP_SHIFT              ; keep the top log2(CAPACITY) bits
    ret

; store_locate(rcx = id)
;   -> rax = pointer to matching OCCUPIED record, or 0 if not found
;   -> rdx = pointer to first insertable slot (EMPTY/DELETED), or 0 if full
store_locate:
    push rbp
    mov  rbp, rsp
    sub  rsp, 0x40
    mov  [rbp-8], rbx
    mov  [rbp-16], rsi
    mov  [rbp-24], rdi
    mov  [rbp-32], r12
    mov  rbx, rcx                    ; id
    call store_hash                  ; rax = index (rcx still = id)
    mov  rsi, rax                    ; probe index
    mov  rdi, [rel g_table]          ; base
    xor  r12, r12                    ; insert candidate = NULL
    xor  r8, r8                      ; probe counter
.probe:
    mov  rax, rsi
    shl  rax, REC_SHIFT              ; index * REC_SIZE
    add  rax, rdi                    ; slot pointer
    mov  cl, [rax+REC_STATUS]
    cmp  cl, ST_EMPTY
    je   .empty
    cmp  cl, ST_DELETED
    je   .deleted
    mov  rdx, [rax+REC_ID]           ; OCCUPIED -> compare id
    cmp  rdx, rbx
    je   .found
    jmp  .cont
.deleted:
    test r12, r12
    jnz  .cont
    mov  r12, rax                    ; remember first reusable slot
    jmp  .cont
.empty:
    test r12, r12
    jnz  .use_cand
    mov  r12, rax
.use_cand:
    xor  rax, rax                    ; not found
    mov  rdx, r12                    ; insertion point
    jmp  .ret
.cont:
    inc  rsi
    and  rsi, CAPACITY-1
    inc  r8
    cmp  r8, CAPACITY
    jb   .probe
    xor  rax, rax                    ; scanned whole table: not found
    mov  rdx, r12                    ; candidate (deleted) or 0 if truly full
    jmp  .ret
.found:
    xor  rdx, rdx
    jmp  .ret
.ret:
    mov  r12, [rbp-32]
    mov  rdi, [rbp-24]
    mov  rsi, [rbp-16]
    mov  rbx, [rbp-8]
    mov  rsp, rbp
    pop  rbp
    ret

; store_slot_index(rcx = slot ptr) -> rax = index
store_slot_index:
    mov  rax, rcx
    sub  rax, [rel g_table]
    shr  rax, REC_SHIFT
    ret

; -----------------------------------------------------------------------------
; CRC-32 (IEEE 802.3, reflected, polynomial 0xEDB88320) - used to checksum WAL
; frames so a byte flipped *inside* a committed frame is detected instead of
; being replayed into the database.
;
; Table-driven: 256 dwords built once at startup (2048 iterations) turns the
; per-byte cost into one table lookup, so checksumming a commit frame is
; proportional to the bytes actually staged, not to a fixed 1 MiB.
; -----------------------------------------------------------------------------

; crc32_init() - fill g_crctab. Clobbers only volatile registers.
crc32_init:
    lea  r8, [rel g_crctab]
    xor  r9d, r9d                    ; i
.byte:
    mov  eax, r9d                    ; c = i
    mov  ecx, 8
.bit:
    test eax, 1
    jz   .noxor
    shr  eax, 1
    xor  eax, 0xEDB88320
    jmp  .cont
.noxor:
    shr  eax, 1
.cont:
    dec  ecx
    jnz  .bit
    mov  [r8+r9*4], eax
    inc  r9d
    cmp  r9d, 256
    jb   .byte
    ret

; crc32(rcx = ptr, rdx = len) -> rax = checksum, zero-extended to 64 bits
;   Uses only volatile registers (rax, rcx, rdx, r8-r11), so callers keep their
;   saved state across the call.
crc32:
    mov  r8, rcx                     ; ptr
    mov  r9, rdx                     ; len
    lea  r10, [rel g_crctab]
    mov  eax, 0xFFFFFFFF
    xor  r11, r11                    ; i
.loop:
    cmp  r11, r9
    jae  .done
    movzx ecx, byte [r8+r11]
    xor  ecx, eax
    and  ecx, 0xFF                   ; (crc ^ byte) & 0xFF
    mov  edx, eax
    shr  edx, 8                      ; crc >> 8
    mov  ecx, [r10+rcx*4]
    xor  edx, ecx
    mov  eax, edx
    inc  r11
    jmp  .loop
.done:
    not  eax                         ; final xor with 0xFFFFFFFF
    ret

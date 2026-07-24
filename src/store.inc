; -----------------------------------------------------------------------------
; src/store.inc - open-addressing hash table over fixed 64-byte records.
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

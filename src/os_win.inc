; -----------------------------------------------------------------------------
; src/os_win.inc - Windows (Win64 / kernel32) backend for the os_* platform
; interface. Included only when NOT building with -dLINUX.
;
; Every os_* function takes arguments in the Win64 register order
; (rcx, rdx, r8, r9) and returns in rax. Non-volatile registers rbx, rsi, rdi,
; rbp, r12-r15 are preserved (the kernel32 imports honour the Win64 ABI, so the
; thin wrappers here are automatically safe). The kernel32 import table lives at
; the bottom of this file so it is excluded from the Linux image.
; -----------------------------------------------------------------------------

; --------------------------- process / startup ------------------------------

; os_init_std() - resolve std handles and enable ANSI colour only for a real
; interactive console. Colour is enabled only when BOTH stdin and stdout are
; consoles; if either is redirected (a pipe, as in scripted/CI use) output stays
; plain so captured text carries no escape codes.
os_init_std:
    push rbp
    mov  rbp, rsp
    sub  rsp, 0x30
    mov  ecx, STD_OUTPUT_HANDLE
    call [rel iat_GetStdHandle]
    mov  [rel g_stdout], rax
    mov  ecx, STD_INPUT_HANDLE
    call [rel iat_GetStdHandle]
    mov  [rel g_stdin], rax
    ; stdin must be a console too, else treat the session as non-interactive
    mov  rcx, [rel g_stdin]
    lea  rdx, [rel g_conmode]
    call [rel iat_GetConsoleMode]
    test eax, eax
    jz   .nocolor
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
    mov  rsp, rbp
    pop  rbp
    ret

; os_exit(rcx = code) - never returns
os_exit:
    sub  rsp, 0x28
    call [rel iat_ExitProcess]

; os_cmdline() -> rax = pointer to the full command line
os_cmdline:
    push rbp
    mov  rbp, rsp
    sub  rsp, 0x20
    call [rel iat_GetCommandLineA]
    mov  rsp, rbp
    pop  rbp
    ret

; --------------------------------- memory -----------------------------------

; os_alloc(rcx = size) -> rax = zeroed pointer, or 0 on failure
os_alloc:
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

; ------------------------------ console I/O ---------------------------------

; os_write(rcx = handle, rdx = buf, r8 = len) -> rax = bytes written
os_write:
    push rbp
    mov  rbp, rsp
    sub  rsp, 0x40
    lea  r9, [rel g_written]         ; lpNumberOfBytesWritten
    mov  qword [rsp+0x20], 0         ; lpOverlapped = NULL
    call [rel iat_WriteFile]
    test rax, rax
    jz   .zero
    mov  eax, [rel g_written]
    jmp  .done
.zero:
    xor  eax, eax
.done:
    mov  rsp, rbp
    pop  rbp
    ret

; os_read(rcx = handle, rdx = buf, r8 = len) -> rax = bytes read (0 = EOF)
os_read:
    push rbp
    mov  rbp, rsp
    sub  rsp, 0x40
    lea  r9, [rel g_readlen_dw]
    mov  qword [rsp+0x20], 0
    call [rel iat_ReadFile]
    test rax, rax
    jz   .zero
    mov  eax, [rel g_readlen_dw]
    jmp  .done
.zero:
    xor  eax, eax
.done:
    mov  rsp, rbp
    pop  rbp
    ret

; ------------------------------- file I/O -----------------------------------

; os_open(rcx = name) -> rax = handle, or -1 (sets g_open_locked on share denial)
;   opens read/write, creating if absent, with no sharing (single writer)
os_open:
    push rbp
    mov  rbp, rsp
    sub  rsp, 0x50
    mov  [rbp-8], rbx
    mov  rdx, GENERIC_READ | GENERIC_WRITE
    xor  r8, r8                      ; exclusive - no sharing
    xor  r9, r9
    mov  dword [rsp+0x20], OPEN_ALWAYS
    mov  dword [rsp+0x28], FILE_ATTRIBUTE_NORMAL
    mov  qword [rsp+0x30], 0
    call [rel iat_CreateFileA]
    mov  rbx, rax
    cmp  rax, INVALID_HANDLE
    je   .fail
.ret:
    mov  rax, rbx
    mov  rbx, [rbp-8]
    mov  rsp, rbp
    pop  rbp
    ret
.fail:
    mov  qword [rel g_open_locked], 0
    call [rel iat_GetLastError]      ; read before other calls clobber it
    cmp  eax, ERROR_SHARING_VIOLATION
    jne  .ret
    mov  qword [rel g_open_locked], 1
    jmp  .ret

; os_create(rcx = name) -> rax = handle, or -1  (create/truncate, read/write)
os_create:
    push rbp
    mov  rbp, rsp
    sub  rsp, 0x50
    mov  rdx, GENERIC_READ | GENERIC_WRITE
    xor  r8, r8
    xor  r9, r9
    mov  dword [rsp+0x20], CREATE_ALWAYS
    mov  dword [rsp+0x28], FILE_ATTRIBUTE_NORMAL
    mov  qword [rsp+0x30], 0
    call [rel iat_CreateFileA]
    mov  rsp, rbp
    pop  rbp
    ret

; os_open_read(rcx = name) -> rax = handle, or -1  (open existing, read/shared)
os_open_read:
    push rbp
    mov  rbp, rsp
    sub  rsp, 0x50
    mov  rdx, GENERIC_READ
    mov  r8d, 1                      ; FILE_SHARE_READ
    xor  r9, r9
    mov  dword [rsp+0x20], OPEN_EXISTING
    mov  dword [rsp+0x28], FILE_ATTRIBUTE_NORMAL
    mov  qword [rsp+0x30], 0
    call [rel iat_CreateFileA]
    mov  rsp, rbp
    pop  rbp
    ret

; os_pread(rcx = handle, rdx = offset, r8 = buf, r9 = len) -> rax = bytes read
os_pread:
    push rbp
    mov  rbp, rsp
    sub  rsp, 0x50
    mov  [rbp-8], rcx
    mov  [rbp-16], r8
    mov  [rbp-24], r9
    xor  r8, r8                      ; SetFilePointerEx: lpNewFilePointer = NULL
    mov  r9d, FILE_BEGIN
    call [rel iat_SetFilePointerEx]  ; rcx = handle, rdx = offset
    mov  rcx, [rbp-8]
    mov  rdx, [rbp-16]
    mov  r8, [rbp-24]
    lea  r9, [rel g_io_dw]
    mov  qword [rsp+0x20], 0
    call [rel iat_ReadFile]
    mov  eax, [rel g_io_dw]
    mov  rsp, rbp
    pop  rbp
    ret

; os_pwrite(rcx = handle, rdx = offset, r8 = buf, r9 = len)
os_pwrite:
    push rbp
    mov  rbp, rsp
    sub  rsp, 0x50
    mov  [rbp-8], rcx
    mov  [rbp-16], r8
    mov  [rbp-24], r9
    xor  r8, r8
    mov  r9d, FILE_BEGIN
    call [rel iat_SetFilePointerEx]
    mov  rcx, [rbp-8]
    mov  rdx, [rbp-16]
    mov  r8, [rbp-24]
    lea  r9, [rel g_io_dw]
    mov  qword [rsp+0x20], 0
    call [rel iat_WriteFile]
    mov  eax, [rel g_io_dw]
    mov  rsp, rbp
    pop  rbp
    ret

; os_fsync(rcx = handle)
os_fsync:
    push rbp
    mov  rbp, rsp
    sub  rsp, 0x30
    call [rel iat_FlushFileBuffers]
    mov  rsp, rbp
    pop  rbp
    ret

; os_truncate(rcx = handle, rdx = size) - set the file length to `size`
os_truncate:
    push rbp
    mov  rbp, rsp
    sub  rsp, 0x40
    mov  [rbp-8], rcx
    xor  r8, r8
    mov  r9d, FILE_BEGIN
    call [rel iat_SetFilePointerEx]  ; move pointer to `size`
    mov  rcx, [rbp-8]
    call [rel iat_SetEndOfFile]
    mov  rsp, rbp
    pop  rbp
    ret

; os_set_sparse(rcx = handle) - mark the file sparse (holes cost no disk)
os_set_sparse:
    push rbp
    mov  rbp, rsp
    sub  rsp, 0x50
    mov  edx, FSCTL_SET_SPARSE
    xor  r8, r8                      ; lpInBuffer = NULL
    xor  r9, r9                      ; nInBufferSize = 0
    mov  qword [rsp+0x20], 0         ; lpOutBuffer = NULL
    mov  qword [rsp+0x28], 0         ; nOutBufferSize = 0
    lea  rax, [rel g_io_dw]
    mov  [rsp+0x30], rax             ; lpBytesReturned
    mov  qword [rsp+0x38], 0         ; lpOverlapped = NULL
    call [rel iat_DeviceIoControl]
    mov  rsp, rbp
    pop  rbp
    ret

; os_close(rcx = handle)
os_close:
    push rbp
    mov  rbp, rsp
    sub  rsp, 0x30
    call [rel iat_CloseHandle]
    mov  rsp, rbp
    pop  rbp
    ret

; ------------------------------- time ---------------------------------------

; os_now_ms() -> rax = current unix epoch time in milliseconds
os_now_ms:
    push rbp
    mov  rbp, rsp
    sub  rsp, 0x20
    lea  rcx, [rel g_ft]
    call [rel iat_GetSystemTimeAsFileTime]
    mov  rax, [rel g_ft]             ; 100-ns ticks since 1601-01-01
    xor  rdx, rdx
    mov  rcx, 10000
    div  rcx                         ; -> ms since 1601
    mov  rcx, 11644473600000         ; ms between 1601 and 1970
    sub  rax, rcx
    mov  rsp, rbp
    pop  rbp
    ret

; os_perf_counter() -> rax = high-resolution monotonic tick count
os_perf_counter:
    push rbp
    mov  rbp, rsp
    sub  rsp, 0x30
    lea  rcx, [rel g_perfbuf]
    call [rel iat_QueryPerformanceCounter]
    mov  rax, [rel g_perfbuf]
    mov  rsp, rbp
    pop  rbp
    ret

; os_perf_freq() -> rax = ticks per second
os_perf_freq:
    push rbp
    mov  rbp, rsp
    sub  rsp, 0x30
    lea  rcx, [rel g_perfbuf]
    call [rel iat_QueryPerformanceFrequency]
    mov  rax, [rel g_perfbuf]
    mov  rsp, rbp
    pop  rbp
    ret

; --------------------------- directory listing ------------------------------
; Fills g_finddata (WIN32_FIND_DATAA layout: name at +44, size-low at +32).

; os_dir_open(rcx = glob pattern, e.g. "*.dat") -> rax = handle, or -1
os_dir_open:
    push rbp
    mov  rbp, rsp
    sub  rsp, 0x30
    lea  rdx, [rel g_finddata]
    call [rel iat_FindFirstFileA]
    mov  [rel g_dir_handle], rax
    cmp  rax, INVALID_HANDLE
    je   .fail
    mov  qword [rel g_dir_first], 1  ; first entry already staged in g_finddata
    mov  rsp, rbp
    pop  rbp
    ret
.fail:
    mov  rax, -1
    mov  rsp, rbp
    pop  rbp
    ret

; os_dir_next(rcx = handle, rdx = out) -> rax = 1 (entry ready) / 0 (end)
os_dir_next:
    push rbp
    mov  rbp, rsp
    sub  rsp, 0x30
    cmp  qword [rel g_dir_first], 0
    je   .more
    mov  qword [rel g_dir_first], 0
    mov  rax, 1
    jmp  .out
.more:
    mov  rcx, [rel g_dir_handle]
    lea  rdx, [rel g_finddata]
    call [rel iat_FindNextFileA]
    test eax, eax
    jz   .none
    mov  rax, 1
    jmp  .out
.none:
    xor  rax, rax
.out:
    mov  rsp, rbp
    pop  rbp
    ret

; os_dir_close(rcx = handle)
os_dir_close:
    push rbp
    mov  rbp, rsp
    sub  rsp, 0x30
    mov  rcx, [rel g_dir_handle]
    call [rel iat_FindClose]
    mov  rsp, rbp
    pop  rbp
    ret

; --------------------------- Windows-only scratch ---------------------------
                align 8
g_written:     dd 0
g_readlen_dw:  dd 0
g_io_dw:       dd 0
g_conmode:     dd 0
                align 8
g_ft:          dq 0
g_perfbuf:     dq 0
g_dir_handle:  dq 0
g_dir_first:   dq 0

; ============================== import table ================================
                align 4
import_dir:
    dd 0                             ; OriginalFirstThunk
    dd 0                             ; TimeDateStamp
    dd 0                             ; ForwarderChain
    dd RVA(dll_name)                 ; Name
    dd RVA(iat)                      ; FirstThunk
    times 5 dd 0                     ; null descriptor
import_dir_size equ $ - import_dir

                align 8
iat:
iat_GetStdHandle:      dq RVA(h_GetStdHandle)
iat_WriteFile:         dq RVA(h_WriteFile)
iat_ReadFile:          dq RVA(h_ReadFile)
iat_VirtualAlloc:      dq RVA(h_VirtualAlloc)
iat_CreateFileA:       dq RVA(h_CreateFileA)
iat_SetFilePointerEx:  dq RVA(h_SetFilePointerEx)
iat_FlushFileBuffers:  dq RVA(h_FlushFileBuffers)
iat_SetEndOfFile:      dq RVA(h_SetEndOfFile)
iat_CloseHandle:       dq RVA(h_CloseHandle)
iat_GetCommandLineA:   dq RVA(h_GetCommandLineA)
iat_GetConsoleMode:    dq RVA(h_GetConsoleMode)
iat_SetConsoleMode:    dq RVA(h_SetConsoleMode)
iat_FindFirstFileA:    dq RVA(h_FindFirstFileA)
iat_FindNextFileA:     dq RVA(h_FindNextFileA)
iat_FindClose:         dq RVA(h_FindClose)
iat_ExitProcess:       dq RVA(h_ExitProcess)
iat_QueryPerformanceCounter:   dq RVA(h_QueryPerformanceCounter)
iat_QueryPerformanceFrequency: dq RVA(h_QueryPerformanceFrequency)
iat_GetSystemTimeAsFileTime:   dq RVA(h_GetSystemTimeAsFileTime)
iat_GetLastError:      dq RVA(h_GetLastError)
iat_DeviceIoControl:   dq RVA(h_DeviceIoControl)
                       dq 0

dll_name: db 'kernel32.dll', 0

                align 2
h_GetStdHandle:      dw 0
    db 'GetStdHandle', 0
                align 2
h_WriteFile:         dw 0
    db 'WriteFile', 0
                align 2
h_ReadFile:          dw 0
    db 'ReadFile', 0
                align 2
h_VirtualAlloc:      dw 0
    db 'VirtualAlloc', 0
                align 2
h_CreateFileA:       dw 0
    db 'CreateFileA', 0
                align 2
h_SetFilePointerEx:  dw 0
    db 'SetFilePointerEx', 0
                align 2
h_FlushFileBuffers:  dw 0
    db 'FlushFileBuffers', 0
                align 2
h_SetEndOfFile:      dw 0
    db 'SetEndOfFile', 0
                align 2
h_CloseHandle:       dw 0
    db 'CloseHandle', 0
                align 2
h_GetCommandLineA:   dw 0
    db 'GetCommandLineA', 0
                align 2
h_GetConsoleMode:    dw 0
    db 'GetConsoleMode', 0
                align 2
h_SetConsoleMode:    dw 0
    db 'SetConsoleMode', 0
                align 2
h_FindFirstFileA:    dw 0
    db 'FindFirstFileA', 0
                align 2
h_FindNextFileA:     dw 0
    db 'FindNextFileA', 0
                align 2
h_FindClose:         dw 0
    db 'FindClose', 0
                align 2
h_ExitProcess:       dw 0
    db 'ExitProcess', 0
                align 2
h_QueryPerformanceCounter:   dw 0
    db 'QueryPerformanceCounter', 0
                align 2
h_QueryPerformanceFrequency: dw 0
    db 'QueryPerformanceFrequency', 0
                align 2
h_GetSystemTimeAsFileTime: dw 0
    db 'GetSystemTimeAsFileTime', 0
                align 2
h_GetLastError:      dw 0
    db 'GetLastError', 0
                align 2
h_DeviceIoControl:   dw 0
    db 'DeviceIoControl', 0

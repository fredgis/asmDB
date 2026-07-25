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

; os_open(rcx = name) -> rax = handle, or -1 (sets g_open_locked on lock denial)
;   Opens read/write, creating if absent, and lets other processes READ the file
;   while we hold it. Single-writer exclusion is enforced by an exclusive lock on
;   a sentinel byte far past the data region, not by denying the share: denying
;   it also blocked readers, which is the whole point of reader mode. The
;   sentinel is outside anything either side ever reads or writes, so it costs
;   nothing and conflicts only with another writer.
os_open:
    push rbp
    mov  rbp, rsp
    sub  rsp, 0x60
    mov  [rbp-8], rbx
    mov  rdx, GENERIC_READ | GENERIC_WRITE
    mov  r8d, 1                      ; FILE_SHARE_READ
    xor  r9, r9
    mov  dword [rsp+0x20], OPEN_ALWAYS
    mov  dword [rsp+0x28], FILE_ATTRIBUTE_NORMAL
    mov  qword [rsp+0x30], 0
    call [rel iat_CreateFileA]
    mov  rbx, rax
    cmp  rax, INVALID_HANDLE
    je   .fail
    ; LockFileEx(handle, EXCLUSIVE|FAIL_IMMEDIATELY, 0, 1, 0, &overlapped)
    ; OVERLAPPED: Internal +0, InternalHigh +8, Offset +16, OffsetHigh +20,
    ; hEvent +24. Putting the offset anywhere else locks byte 0 instead, which
    ; would make every read of the header fail with a lock violation.
    mov  rcx, rbx
    mov  edx, LOCKFILE_EXCLUSIVE | LOCKFILE_FAIL_IMMEDIATELY
    xor  r8d, r8d                    ; reserved
    mov  r9d, 1                      ; nNumberOfBytesToLockLow
    mov  qword [rel g_lockovl], 0
    mov  qword [rel g_lockovl+8], 0
    mov  r10, WRITER_LOCK_OFFSET     ; via a register: a 64-bit immediate does
    mov  [rel g_lockovl+16], r10     ; not fit in "mov qword [mem], imm"
    mov  qword [rel g_lockovl+24], 0
    lea  rax, [rel g_lockovl]
    mov  dword [rsp+0x20], 0         ; nNumberOfBytesToLockHigh
    mov  [rsp+0x28], rax             ; lpOverlapped
    call [rel iat_LockFileEx]
    test eax, eax
    jz   .locked
    mov  rax, rbx
    jmp  .ret
.locked:
    mov  rcx, rbx
    call [rel iat_CloseHandle]
    mov  qword [rel g_open_locked], 1
    mov  rbx, -1
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

; os_map_read(rcx = handle, rdx = size) -> rax = base address, or 0.
; A shared read-only view: readers observe the writer's committed pages through
; the page cache instead of copying a gigabyte at startup.
os_map_read:
    push rbp
    mov  rbp, rsp
    sub  rsp, 0x50
    mov  [rbp-8], rbx
    mov  rbx, rdx                    ; size
    xor  edx, edx                    ; lpAttributes
    mov  r8d, PAGE_READONLY
    mov  r9, rbx
    shr  r9, 32                      ; dwMaximumSizeHigh
    mov  eax, ebx
    mov  [rsp+0x20], eax             ; dwMaximumSizeLow
    mov  qword [rsp+0x28], 0         ; lpName
    call [rel iat_CreateFileMappingA]
    test rax, rax
    jz   .fail
    mov  [rbp-16], rax               ; mapping handle
    mov  rcx, rax
    mov  edx, FILE_MAP_READ
    xor  r8d, r8d                    ; offset high
    xor  r9d, r9d                    ; offset low
    mov  qword [rsp+0x20], 0         ; whole file
    call [rel iat_MapViewOfFile]
    mov  [rbp-24], rax
    mov  rcx, [rbp-16]
    call [rel iat_CloseHandle]       ; the view keeps the mapping alive
    mov  rax, [rbp-24]
    jmp  .done
.fail:
    xor  eax, eax
.done:
    mov  rbx, [rbp-8]
    mov  rsp, rbp
    pop  rbp
    ret

; os_open_shared(rcx = name) -> rax = handle, or -1
;   Like os_open, but lets other processes READ the file while we hold it open
;   for writing. Used for <db>.cdc so a change consumer can follow the log
;   live; there is still only ever one writer, since the .dat lock is exclusive.
os_open_shared:
    push rbp
    mov  rbp, rsp
    sub  rsp, 0x50
    mov  rdx, GENERIC_READ | GENERIC_WRITE
    mov  r8d, 1                      ; FILE_SHARE_READ
    xor  r9, r9
    mov  dword [rsp+0x20], OPEN_ALWAYS
    mov  dword [rsp+0x28], FILE_ATTRIBUTE_NORMAL
    mov  qword [rsp+0x30], 0
    call [rel iat_CreateFileA]
    mov  rsp, rbp
    pop  rbp
    ret

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

; os_create_new(rcx = name) -> rax = handle, or -1 if the file already exists.
; Exclusive creation: used for anything that will later be renamed into place,
; so a stale temporary from a previous run is never silently reused.
os_create_new:
    push rbp
    mov  rbp, rsp
    sub  rsp, 0x50
    mov  rdx, GENERIC_READ | GENERIC_WRITE
    xor  r8, r8
    xor  r9, r9
    mov  dword [rsp+0x20], CREATE_NEW
    mov  dword [rsp+0x28], FILE_ATTRIBUTE_NORMAL
    mov  qword [rsp+0x30], 0
    call [rel iat_CreateFileA]
    mov  rsp, rbp
    pop  rbp
    ret

; os_file_id(rcx = handle, rdx = 16-byte out) -> rax = 0 ok / -1 error.
; Writes (volume serial, file index) - the pair that identifies a file
; regardless of the path used to reach it. Comparing paths as strings is not
; enough: a relative path, "./db.dat" and a hard link all name the same bytes.
os_file_id:
    push rbp
    mov  rbp, rsp
    sub  rsp, 0x40
    mov  [rbp-8], rbx
    mov  rbx, rdx                    ; out
    lea  rdx, [rel g_bhfi]
    call [rel iat_GetFileInformationByHandle]
    test eax, eax
    jz   .fail
    mov  eax, dword [rel g_bhfi+28]  ; dwVolumeSerialNumber
    mov  [rbx], rax
    mov  eax, dword [rel g_bhfi+44]  ; nFileIndexHigh
    shl  rax, 32
    mov  ecx, dword [rel g_bhfi+48]  ; nFileIndexLow
    or   rax, rcx
    mov  [rbx+8], rax
    xor  eax, eax
    jmp  .done
.fail:
    mov  rax, -1
.done:
    mov  rbx, [rbp-8]
    mov  rsp, rbp
    pop  rbp
    ret

; os_rename(rcx = old, rdx = new) -> rax = 0 ok / -1. Replaces new atomically.
os_rename:
    push rbp
    mov  rbp, rsp
    sub  rsp, 0x30
    mov  r8d, MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH
    call [rel iat_MoveFileExA]
    test eax, eax
    jz   .fail
    xor  eax, eax
    jmp  .done
.fail:
    mov  rax, -1
.done:
    mov  rsp, rbp
    pop  rbp
    ret

; os_unlink(rcx = name) -> rax = 0 ok / -1
os_unlink:
    push rbp
    mov  rbp, rsp
    sub  rsp, 0x30
    call [rel iat_DeleteFileA]
    test eax, eax
    jz   .fail
    xor  eax, eax
    jmp  .done
.fail:
    mov  rax, -1
.done:
    mov  rsp, rbp
    pop  rbp
    ret

; os_exists(rcx = name) -> rax = 1 if the path exists, 0 if not.
; Deliberately not implemented as "try to open it": the live database is held
; with no sharing, so opening it fails with a sharing violation rather than
; "not found", and a caller testing for existence would conclude the file is
; absent. GetFileAttributesA answers without needing any data access.
os_exists:
    push rbp
    mov  rbp, rsp
    sub  rsp, 0x30
    call [rel iat_GetFileAttributesA]
    cmp  eax, -1
    je   .no
    mov  eax, 1
    jmp  .done
.no:
    xor  eax, eax
.done:
    mov  rsp, rbp
    pop  rbp
    ret

; os_open_read(rcx = name) -> rax = handle, or -1  (open existing, read-only)
;   Shares both read AND write: a reader has to be able to open a file the
;   single writer is holding. Windows requires each opener's share mode to
;   permit the access the other already has, so FILE_SHARE_READ alone would
;   make every reader fail while a writer is running.
os_open_read:
    push rbp
    mov  rbp, rsp
    sub  rsp, 0x50
    mov  rdx, GENERIC_READ
    mov  r8d, 3                      ; FILE_SHARE_READ | FILE_SHARE_WRITE
    xor  r9, r9
    mov  dword [rsp+0x20], OPEN_EXISTING
    mov  dword [rsp+0x28], FILE_ATTRIBUTE_NORMAL
    mov  qword [rsp+0x30], 0
    call [rel iat_CreateFileA]
    mov  rsp, rbp
    pop  rbp
    ret

; os_pread(rcx = handle, rdx = offset, r8 = buf, r9 = len)
;   -> rax = bytes read (0 = EOF), or -1 on error
os_pread:
    push rbp
    mov  rbp, rsp
    sub  rsp, 0x50
    mov  [rbp-8], rcx
    mov  [rbp-16], r8
    mov  [rbp-24], r9
    mov  dword [rel g_io_dw], 0      ; never report a stale count
    xor  r8, r8                      ; SetFilePointerEx: lpNewFilePointer = NULL
    mov  r9d, FILE_BEGIN
    call [rel iat_SetFilePointerEx]  ; rcx = handle, rdx = offset
    test eax, eax
    jz   .fail                       ; seek failed - do NOT read at the old offset
    mov  rcx, [rbp-8]
    mov  rdx, [rbp-16]
    mov  r8, [rbp-24]
    lea  r9, [rel g_io_dw]
    mov  qword [rsp+0x20], 0
    call [rel iat_ReadFile]
    test eax, eax
    jz   .fail
    mov  eax, [rel g_io_dw]
    jmp  .done
.fail:
    mov  rax, -1
.done:
    mov  rsp, rbp
    pop  rbp
    ret

; os_pwrite(rcx = handle, rdx = offset, r8 = buf, r9 = len)
;   -> rax = bytes written, or -1 on error
os_pwrite:
    push rbp
    mov  rbp, rsp
    sub  rsp, 0x50
    mov  [rbp-8], rcx
    mov  [rbp-16], r8
    mov  [rbp-24], r9
    mov  dword [rel g_io_dw], 0
    xor  r8, r8
    mov  r9d, FILE_BEGIN
    call [rel iat_SetFilePointerEx]
    test eax, eax
    jz   .fail                       ; seek failed - do NOT write at the old offset
    mov  rcx, [rbp-8]
    mov  rdx, [rbp-16]
    mov  r8, [rbp-24]
    lea  r9, [rel g_io_dw]
    mov  qword [rsp+0x20], 0
    call [rel iat_WriteFile]
    test eax, eax
    jz   .fail
    mov  eax, [rel g_io_dw]
    jmp  .done
.fail:
    mov  rax, -1
.done:
    mov  rsp, rbp
    pop  rbp
    ret

; os_fsync(rcx = handle) -> rax = 0 on success, -1 on failure
os_fsync:
    push rbp
    mov  rbp, rsp
    sub  rsp, 0x30
    call [rel iat_FlushFileBuffers]
    test eax, eax
    jz   .fail
    xor  rax, rax
    jmp  .done
.fail:
    mov  rax, -1
.done:
    mov  rsp, rbp
    pop  rbp
    ret

; os_truncate(rcx = handle, rdx = size) - set the file length to `size`
;   -> rax = 0 on success, -1 on failure
os_truncate:
    push rbp
    mov  rbp, rsp
    sub  rsp, 0x40
    mov  [rbp-8], rcx
    xor  r8, r8
    mov  r9d, FILE_BEGIN
    call [rel iat_SetFilePointerEx]  ; move pointer to `size`
    test eax, eax
    jz   .fail
    mov  rcx, [rbp-8]
    call [rel iat_SetEndOfFile]
    test eax, eax
    jz   .fail
    xor  rax, rax
    jmp  .done
.fail:
    mov  rax, -1
.done:
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

; os_filesize(rcx = handle) -> rax = size in bytes, or -1 on failure
os_filesize:
    push rbp
    mov  rbp, rsp
    sub  rsp, 0x30
    lea  rdx, [rel g_fsize]
    call [rel iat_GetFileSizeEx]
    test eax, eax
    jz   .fail
    mov  rax, [rel g_fsize]
    jmp  .done
.fail:
    mov  rax, -1
.done:
    mov  rsp, rbp
    pop  rbp
    ret

; os_map_cow(rcx = handle, rdx = size) -> rax = base address, or 0 on failure
;   Maps the file COPY-ON-WRITE: reads fault in from the file, writes go to
;   private pages that never reach it. That is what lets the store be "loaded"
;   in O(1) while leaving the durability model alone - the file is still only
;   ever changed by the explicit write_at/fsync paths.
os_map_cow:
    push rbp
    mov  rbp, rsp
    sub  rsp, 0x50
    mov  [rbp-8], rbx
    mov  rbx, rdx                    ; size (kept across both calls)
    ; CreateFileMappingA(hFile, NULL, PAGE_WRITECOPY, sizeHigh, sizeLow, NULL)
    xor  rdx, rdx                    ; lpAttributes
    mov  r8d, PAGE_WRITECOPY
    mov  r9, rbx
    shr  r9, 32                      ; dwMaximumSizeHigh
    mov  eax, ebx                    ; dwMaximumSizeLow
    mov  [rsp+0x20], eax
    mov  qword [rsp+0x28], 0         ; lpName
    call [rel iat_CreateFileMappingA]
    test rax, rax
    jz   .fail
    mov  [rbp-24], rax               ; section handle
    ; MapViewOfFile(hMap, FILE_MAP_COPY, 0, 0, size)
    mov  rcx, rax
    mov  edx, FILE_MAP_COPY
    xor  r8, r8                      ; offset high
    xor  r9, r9                      ; offset low
    mov  [rsp+0x20], rbx             ; dwNumberOfBytesToMap
    call [rel iat_MapViewOfFile]
    mov  [rbp-32], rax               ; view (0 on failure)
    mov  rcx, [rbp-24]
    call [rel iat_CloseHandle]       ; the view keeps the section alive
    mov  rax, [rbp-32]
    jmp  .done
.fail:
    xor  rax, rax
.done:
    mov  rbx, [rbp-8]
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
g_fsize:       dq 0
g_dir_handle:  dq 0
g_dir_first:   dq 0
g_bhfi:        times 52 db 0        ; BY_HANDLE_FILE_INFORMATION
                align 8
g_lockovl:     times 32 db 0        ; OVERLAPPED for the writer lock
                align 8

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
iat_GetFileSizeEx:     dq RVA(h_GetFileSizeEx)
iat_CreateFileMappingA: dq RVA(h_CreateFileMappingA)
iat_MapViewOfFile:     dq RVA(h_MapViewOfFile)
iat_GetFileInformationByHandle: dq RVA(h_GetFileInformationByHandle)
iat_MoveFileExA:       dq RVA(h_MoveFileExA)
iat_DeleteFileA:       dq RVA(h_DeleteFileA)
iat_GetFileAttributesA: dq RVA(h_GetFileAttributesA)
iat_LockFileEx:        dq RVA(h_LockFileEx)
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
                align 2
h_GetFileSizeEx:     dw 0
    db 'GetFileSizeEx', 0
                align 2
h_CreateFileMappingA: dw 0
    db 'CreateFileMappingA', 0
                align 2
h_MapViewOfFile:     dw 0
    db 'MapViewOfFile', 0
                align 2
h_GetFileInformationByHandle: dw 0
    db 'GetFileInformationByHandle', 0
                align 2
h_MoveFileExA:       dw 0
    db 'MoveFileExA', 0
                align 2
h_DeleteFileA:       dw 0
    db 'DeleteFileA', 0
                align 2
h_GetFileAttributesA: dw 0
    db 'GetFileAttributesA', 0
                align 2
h_LockFileEx:        dw 0
    db 'LockFileEx', 0

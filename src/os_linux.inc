; -----------------------------------------------------------------------------
; src/os_linux.inc - Linux x86-64 (raw syscall) backend for the os_* platform
; interface. Included only when building with -dLINUX.
;
; Convention: every os_* function takes arguments in the Win64 register order
; (rcx, rdx, r8, r9) - the order the rest of asmdb already uses - and returns in
; rax. The Linux syscall ABI passes args in rdi, rsi, rdx, r10, r8, r9 with the
; number in rax and clobbers rcx and r11. Because the shared code treats
; rbx/rsi/rdi/rbp/r12-r15 as non-volatile (Win64 rules), each wrapper saves and
; restores any of rsi/rdi/rbx/r12 it touches before issuing the syscall.
;
; No import table, no dynamic linker: the kernel is called directly.
; -----------------------------------------------------------------------------

%define DIRBUF_SIZE 8192

; ---- syscall numbers (x86-64) ----
%define SYS_read          0
%define SYS_write         1
%define SYS_open          2
%define SYS_close         3
%define SYS_stat          4
%define SYS_lseek         8
%define SYS_mmap          9
%define SYS_ioctl         16
%define SYS_pread64       17
%define SYS_pwrite64      18
%define SYS_fsync         74
%define SYS_flock         73
%define SYS_ftruncate     77
%define SYS_getdents64    217
%define SYS_clock_gettime 228
%define SYS_exit_group    231

; ---- open() flags / misc ----
%define O_RDONLY     0x0
%define O_WRONLY     0x1
%define O_RDWR       0x2
%define O_CREAT      0x40
%define O_TRUNC      0x200
%define O_DIRECTORY  0x10000
%define MODE_0644    0x1A4
%define PROT_RW      0x3
%define MAP_PRIV_ANON 0x22
%define MAP_PRIVATE  0x02
%define SEEK_END     2
%define LOCK_EXNB    0x6              ; LOCK_EX (2) | LOCK_NB (4)
%define TCGETS       0x5401
%define CLK_REALTIME  0
%define CLK_MONOTONIC 1

; --------------------------- process / startup ------------------------------

; os_init_std() - std handles are fixed fds; colour on when stdout is a tty
os_init_std:
    push rbp
    mov  rbp, rsp
    sub  rsp, 0x20
    mov  qword [rel g_stdout], 1
    mov  qword [rel g_stdin], 0
    mov  qword [rel g_color], 0
    mov  edi, 1                      ; fd 1 (stdout)
    mov  esi, TCGETS
    lea  rdx, [rel g_termbuf]
    mov  eax, SYS_ioctl
    syscall
    test rax, rax                    ; 0 on a real tty, -ENOTTY otherwise
    jnz  .done
    mov  edi, 0                      ; fd 0 (stdin) must be a tty too
    mov  esi, TCGETS
    lea  rdx, [rel g_termbuf]
    mov  eax, SYS_ioctl
    syscall
    test rax, rax
    jnz  .done
    mov  qword [rel g_color], 1
.done:
    mov  rsp, rbp
    pop  rbp
    ret

; os_exit(rcx = code) - never returns
os_exit:
    mov  edi, ecx
    mov  eax, SYS_exit_group
    syscall
    ret

; os_cmdline() -> rax = joined "argv0 argv1 ..." command-line string
;   Reconstructs a single string (like Win32 GetCommandLineA) from the argv
;   vector the kernel left on the stack at _start, so db_init_names is shared.
os_cmdline:
    push rbp
    mov  rbp, rsp
    sub  rsp, 0x20
    mov  [rbp-8], rbx
    mov  [rbp-16], rsi
    mov  [rbp-24], rdi
    mov  rsi, [rel g_sp0]            ; -> [argc][argv0][argv1]...[NULL]
    mov  rbx, [rsi]                  ; argc
    add  rsi, 8                      ; &argv[0]
    lea  rdi, [rel g_cmdline]
    lea  rcx, [rel g_cmdline+1000]   ; hard cap
.arg:
    test rbx, rbx
    jz   .end
    mov  rax, [rsi]                  ; argv[i]
    test rax, rax
    jz   .end
.ch:
    mov  dl, [rax]
    test dl, dl
    jz   .argend
    cmp  rdi, rcx
    jae  .argend
    mov  [rdi], dl
    inc  rdi
    inc  rax
    jmp  .ch
.argend:
    cmp  rdi, rcx
    jae  .end
    mov  byte [rdi], ' '
    inc  rdi
    add  rsi, 8
    dec  rbx
    jmp  .arg
.end:
    mov  byte [rdi], 0
    lea  rax, [rel g_cmdline]
    mov  rdi, [rbp-24]
    mov  rsi, [rbp-16]
    mov  rbx, [rbp-8]
    mov  rsp, rbp
    pop  rbp
    ret

; --------------------------------- memory -----------------------------------

; os_alloc(rcx = size) -> rax = zeroed pointer, or 0 on failure
os_alloc:
    push rbp
    mov  rbp, rsp
    sub  rsp, 0x20
    mov  [rbp-8], rsi
    mov  [rbp-16], rdi
    xor  edi, edi                    ; addr = NULL (kernel chooses)
    mov  rsi, rcx                    ; length
    mov  edx, PROT_RW
    mov  r10d, MAP_PRIV_ANON
    mov  r8, -1                      ; fd = -1
    xor  r9, r9                      ; offset = 0
    mov  eax, SYS_mmap
    syscall
    cmp  rax, -4095                  ; unsigned: [-4095,-1] is an errno
    jae  .fail
    jmp  .done
.fail:
    xor  eax, eax
.done:
    mov  rdi, [rbp-16]
    mov  rsi, [rbp-8]
    mov  rsp, rbp
    pop  rbp
    ret

; ------------------------------ console I/O ---------------------------------

; os_write(rcx = fd, rdx = buf, r8 = len) -> rax = bytes written (0 on error)
os_write:
    push rbp
    mov  rbp, rsp
    sub  rsp, 0x20
    mov  [rbp-8], rsi
    mov  [rbp-16], rdi
    mov  rdi, rcx
    mov  rsi, rdx
    mov  rdx, r8
    mov  eax, SYS_write
    syscall
    test rax, rax
    jns  .done                       ; >= 0 = byte count
    xor  eax, eax                    ; error -> report 0 written
.done:
    mov  rdi, [rbp-16]
    mov  rsi, [rbp-8]
    mov  rsp, rbp
    pop  rbp
    ret

; os_read(rcx = fd, rdx = buf, r8 = len) -> rax = bytes read (0 = EOF)
os_read:
    push rbp
    mov  rbp, rsp
    sub  rsp, 0x20
    mov  [rbp-8], rsi
    mov  [rbp-16], rdi
    mov  rdi, rcx
    mov  rsi, rdx
    mov  rdx, r8
    mov  eax, SYS_read
    syscall
    test rax, rax
    jns  .done                       ; >= 0 = byte count
    xor  eax, eax                    ; error -> treat as EOF
.done:
    mov  rdi, [rbp-16]
    mov  rsi, [rbp-8]
    mov  rsp, rbp
    pop  rbp
    ret

; ------------------------------- file I/O -----------------------------------

; os_open(rcx = name) -> rax = fd, or -1 (sets g_open_locked on lock conflict)
;   read/write, create if absent, then an exclusive advisory lock (single writer)
os_open:
    push rbp
    mov  rbp, rsp
    sub  rsp, 0x30
    mov  [rbp-8], rsi
    mov  [rbp-16], rdi
    mov  [rbp-24], rbx
    mov  qword [rel g_open_locked], 0
    mov  rdi, rcx                    ; pathname
    mov  esi, O_RDWR | O_CREAT
    mov  edx, MODE_0644
    mov  eax, SYS_open
    syscall
    test rax, rax
    js   .fail
    mov  rbx, rax                    ; fd
    mov  rdi, rbx
    mov  esi, LOCK_EXNB
    mov  eax, SYS_flock
    syscall
    test rax, rax
    js   .locked
    mov  rax, rbx
    jmp  .done
.locked:
    mov  rdi, rbx
    mov  eax, SYS_close
    syscall
    mov  qword [rel g_open_locked], 1
    mov  rax, -1
    jmp  .done
.fail:
    mov  rax, -1
.done:
    mov  rbx, [rbp-24]
    mov  rdi, [rbp-16]
    mov  rsi, [rbp-8]
    mov  rsp, rbp
    pop  rbp
    ret

; os_create(rcx = name) -> rax = fd, or -1  (create/truncate, read/write)
os_create:
    push rbp
    mov  rbp, rsp
    sub  rsp, 0x20
    mov  [rbp-8], rsi
    mov  [rbp-16], rdi
    mov  rdi, rcx
    mov  esi, O_RDWR | O_CREAT | O_TRUNC
    mov  edx, MODE_0644
    mov  eax, SYS_open
    syscall
    test rax, rax
    jns  .done
    mov  rax, -1
.done:
    mov  rdi, [rbp-16]
    mov  rsi, [rbp-8]
    mov  rsp, rbp
    pop  rbp
    ret

; os_open_read(rcx = name) -> rax = fd, or -1  (open existing, read-only)
os_open_read:
    push rbp
    mov  rbp, rsp
    sub  rsp, 0x20
    mov  [rbp-8], rsi
    mov  [rbp-16], rdi
    mov  rdi, rcx
    xor  esi, esi                    ; O_RDONLY
    xor  edx, edx
    mov  eax, SYS_open
    syscall
    test rax, rax
    jns  .done
    mov  rax, -1
.done:
    mov  rdi, [rbp-16]
    mov  rsi, [rbp-8]
    mov  rsp, rbp
    pop  rbp
    ret

; os_pread(rcx = fd, rdx = offset, r8 = buf, r9 = len)
;   -> rax = bytes read (0 = EOF), or -1 on error
os_pread:
    push rbp
    mov  rbp, rsp
    sub  rsp, 0x20
    mov  [rbp-8], rsi
    mov  [rbp-16], rdi
    mov  rdi, rcx                    ; fd
    mov  rsi, r8                     ; buf
    mov  r10, rdx                    ; offset
    mov  rdx, r9                     ; count
    mov  eax, SYS_pread64
    syscall
    test rax, rax
    jns  .done                       ; >= 0: byte count (0 = EOF)
    mov  rax, -1                     ; -errno collapses to a single error code
.done:
    mov  rdi, [rbp-16]
    mov  rsi, [rbp-8]
    mov  rsp, rbp
    pop  rbp
    ret

; os_pwrite(rcx = fd, rdx = offset, r8 = buf, r9 = len)
;   -> rax = bytes written, or -1 on error
os_pwrite:
    push rbp
    mov  rbp, rsp
    sub  rsp, 0x20
    mov  [rbp-8], rsi
    mov  [rbp-16], rdi
    mov  rdi, rcx
    mov  rsi, r8
    mov  r10, rdx
    mov  rdx, r9
    mov  eax, SYS_pwrite64
    syscall
    test rax, rax
    jns  .done
    mov  rax, -1
.done:
    mov  rdi, [rbp-16]
    mov  rsi, [rbp-8]
    mov  rsp, rbp
    pop  rbp
    ret

; os_fsync(rcx = fd) -> rax = 0 on success, -1 on failure
os_fsync:
    push rbp
    mov  rbp, rsp
    sub  rsp, 0x20
    mov  [rbp-16], rdi
    mov  rdi, rcx
    mov  eax, SYS_fsync
    syscall
    test rax, rax
    jns  .ok
    mov  rax, -1
    jmp  .done
.ok:
    xor  rax, rax
.done:
    mov  rdi, [rbp-16]
    mov  rsp, rbp
    pop  rbp
    ret

; os_truncate(rcx = fd, rdx = size) - set the file length (extend or shrink)
;   -> rax = 0 on success, -1 on failure
os_truncate:
    push rbp
    mov  rbp, rsp
    sub  rsp, 0x20
    mov  [rbp-8], rsi
    mov  [rbp-16], rdi
    mov  rdi, rcx
    mov  rsi, rdx
    mov  eax, SYS_ftruncate
    syscall
    test rax, rax
    jns  .ok
    mov  rax, -1
    jmp  .done
.ok:
    xor  rax, rax
.done:
    mov  rdi, [rbp-16]
    mov  rsi, [rbp-8]
    mov  rsp, rbp
    pop  rbp
    ret

; os_set_sparse(rcx = fd) - no-op: Linux files are sparse by default, so the
;   ftruncate in db_open already leaves unwritten slots as unallocated holes.
os_set_sparse:
    ret

; os_filesize(rcx = fd) -> rax = size in bytes, or -1 on failure
;   lseek is safe here: all data I/O uses pread64/pwrite64, which ignore the
;   file position.
os_filesize:
    push rbp
    mov  rbp, rsp
    sub  rsp, 0x20
    mov  [rbp-8], rsi
    mov  [rbp-16], rdi
    mov  rdi, rcx
    xor  rsi, rsi
    mov  rdx, SEEK_END
    mov  eax, SYS_lseek
    syscall
    test rax, rax
    jns  .done
    mov  rax, -1
.done:
    mov  rdi, [rbp-16]
    mov  rsi, [rbp-8]
    mov  rsp, rbp
    pop  rbp
    ret

; os_map_cow(rcx = fd, rdx = size) -> rax = base address, or 0 on failure
;   MAP_PRIVATE: reads fault in from the file, writes go to private pages that
;   never reach it, so the durability model stays exactly as it was.
os_map_cow:
    push rbp
    mov  rbp, rsp
    sub  rsp, 0x30
    mov  [rbp-8], rsi
    mov  [rbp-16], rdi
    mov  r8, rcx                     ; fd
    mov  rsi, rdx                    ; length
    xor  rdi, rdi                    ; addr = NULL
    mov  rdx, PROT_RW
    mov  r10, MAP_PRIVATE
    xor  r9, r9                      ; offset 0
    mov  eax, SYS_mmap
    syscall
    cmp  rax, -4095                  ; -errno range -> failure
    jb   .done
    xor  rax, rax
.done:
    mov  rdi, [rbp-16]
    mov  rsi, [rbp-8]
    mov  rsp, rbp
    pop  rbp
    ret

; os_close(rcx = fd)
os_close:
    push rbp
    mov  rbp, rsp
    sub  rsp, 0x20
    mov  [rbp-16], rdi
    mov  rdi, rcx
    mov  eax, SYS_close
    syscall
    mov  rdi, [rbp-16]
    mov  rsp, rbp
    pop  rbp
    ret

; ------------------------------- time ---------------------------------------

; os_now_ms() -> rax = current unix epoch time in milliseconds
os_now_ms:
    push rbp
    mov  rbp, rsp
    sub  rsp, 0x20
    mov  [rbp-8], rsi
    mov  [rbp-16], rdi
    xor  edi, edi                    ; CLOCK_REALTIME
    lea  rsi, [rel g_ts]
    mov  eax, SYS_clock_gettime
    syscall
    mov  rax, [rel g_ts]             ; tv_sec
    imul rax, rax, 1000              ; seconds -> ms
    mov  r9, rax
    mov  rax, [rel g_ts+8]           ; tv_nsec
    xor  edx, edx
    mov  ecx, 1000000
    div  rcx                         ; rax = nsec / 1e6
    add  rax, r9
    mov  rdi, [rbp-16]
    mov  rsi, [rbp-8]
    mov  rsp, rbp
    pop  rbp
    ret

; os_perf_counter() -> rax = monotonic nanosecond tick count
os_perf_counter:
    push rbp
    mov  rbp, rsp
    sub  rsp, 0x20
    mov  [rbp-8], rsi
    mov  [rbp-16], rdi
    mov  edi, CLK_MONOTONIC
    lea  rsi, [rel g_ts]
    mov  eax, SYS_clock_gettime
    syscall
    mov  rax, [rel g_ts]
    imul rax, rax, 1000000000
    add  rax, [rel g_ts+8]
    mov  rdi, [rbp-16]
    mov  rsi, [rbp-8]
    mov  rsp, rbp
    pop  rbp
    ret

; os_perf_freq() -> rax = ticks per second (nanoseconds -> 1e9)
os_perf_freq:
    mov  rax, 1000000000
    ret

; --------------------------- directory listing ------------------------------
; Enumerates files in the current directory whose name ends with the pattern's
; suffix (the "*.dat" glob is reduced to ".dat"). Fills the caller's out struct
; at +FIND_NAME (name) and +FIND_SIZELOW (size low 32) to match the layout the
; DATABASES renderer expects.

; os_dir_open(rcx = pattern) -> rax = fd, or -1
os_dir_open:
    push rbp
    mov  rbp, rsp
    sub  rsp, 0x30
    mov  [rbp-8], rsi
    mov  [rbp-16], rdi
    mov  [rbp-24], rbx
    mov  rsi, rcx                    ; pattern
    cmp  byte [rsi], '*'
    jne  .cpsuf
    inc  rsi
.cpsuf:
    lea  rdi, [rel g_dir_suf]
    xor  rbx, rbx
.sufl:
    mov  al, [rsi]
    mov  [rdi], al
    test al, al
    jz   .sufd
    inc  rsi
    inc  rdi
    inc  rbx
    jmp  .sufl
.sufd:
    mov  [rel g_dir_suflen], rbx
    lea  rdi, [rel s_dot]
    mov  esi, O_RDONLY | O_DIRECTORY
    xor  edx, edx
    mov  eax, SYS_open
    syscall
    test rax, rax
    js   .fail
    mov  [rel g_dir_fd], rax
    mov  qword [rel g_dir_pos], 0
    mov  qword [rel g_dir_len], 0
    mov  rax, [rel g_dir_fd]
    jmp  .done
.fail:
    mov  rax, -1
.done:
    mov  rbx, [rbp-24]
    mov  rdi, [rbp-16]
    mov  rsi, [rbp-8]
    mov  rsp, rbp
    pop  rbp
    ret

; os_dir_next(rcx = fd, rdx = out) -> rax = 1 (entry ready) / 0 (end)
os_dir_next:
    push rbp
    mov  rbp, rsp
    sub  rsp, 0x40
    mov  [rbp-8], rbx
    mov  [rbp-16], rsi
    mov  [rbp-24], rdi
    mov  [rbp-32], r12
    mov  r12, rdx                    ; out struct
.scan:
    mov  rax, [rel g_dir_pos]
    cmp  rax, [rel g_dir_len]
    jb   .have
    mov  rdi, [rel g_dir_fd]
    lea  rsi, [rel g_dirbuf]
    mov  edx, DIRBUF_SIZE
    mov  eax, SYS_getdents64
    syscall
    test rax, rax
    jle  .none                       ; 0 = end of dir, < 0 = error
    mov  [rel g_dir_len], rax
    mov  qword [rel g_dir_pos], 0
.have:
    lea  rbx, [rel g_dirbuf]
    add  rbx, [rel g_dir_pos]
    movzx eax, word [rbx+16]         ; d_reclen
    add  [rel g_dir_pos], rax        ; advance cursor for next call
    lea  rsi, [rbx+19]               ; d_name
    xor  rax, rax                    ; strlen(name)
.nl:
    cmp  byte [rsi+rax], 0
    je   .nld
    inc  rax
    jmp  .nl
.nld:
    mov  rcx, [rel g_dir_suflen]
    cmp  rax, rcx
    jb   .scan                       ; name shorter than suffix
    lea  rdi, [rsi+rax]
    sub  rdi, rcx                    ; tail = name + len - suflen
    lea  rdx, [rel g_dir_suf]
.cmpl:
    test rcx, rcx
    jz   .match
    mov  al, [rdi]
    cmp  al, [rdx]
    jne  .scan
    inc  rdi
    inc  rdx
    dec  rcx
    jmp  .cmpl
.match:
    lea  rdi, [r12+FIND_NAME]        ; copy name into out struct
.cpn:
    mov  al, [rsi]
    mov  [rdi], al
    test al, al
    jz   .cpnd
    inc  rsi
    inc  rdi
    jmp  .cpn
.cpnd:
    lea  rdi, [rbx+19]               ; stat(name, g_statbuf) for size
    lea  rsi, [rel g_statbuf]
    mov  eax, SYS_stat
    syscall
    mov  eax, [rel g_statbuf+48]     ; st_size low 32 -> FIND_SIZELOW
    mov  [r12+FIND_SIZELOW], eax
    mov  rax, 1
    jmp  .out
.none:
    xor  rax, rax
.out:
    mov  r12, [rbp-32]
    mov  rdi, [rbp-24]
    mov  rsi, [rbp-16]
    mov  rbx, [rbp-8]
    mov  rsp, rbp
    pop  rbp
    ret

; os_dir_close(rcx = fd)
os_dir_close:
    push rbp
    mov  rbp, rsp
    sub  rsp, 0x20
    mov  [rbp-16], rdi
    mov  rdi, [rel g_dir_fd]
    mov  eax, SYS_close
    syscall
    mov  rdi, [rbp-16]
    mov  rsp, rbp
    pop  rbp
    ret

; ----------------------------- Linux-only data ------------------------------
                align 8
g_sp0:        dq 0                   ; saved stack pointer at _start (argc/argv)
g_cmdline:    times 1024 db 0
g_ts:         times 16 db 0          ; struct timespec { i64 sec; i64 nsec; }
g_termbuf:    times 64 db 0
g_statbuf:    times 160 db 0
g_dir_fd:     dq 0
g_dir_pos:    dq 0
g_dir_len:    dq 0
g_dir_suflen: dq 0
g_dir_suf:    times 32 db 0
s_dot:        db '.', 0
                align 8
g_dirbuf:     times DIRBUF_SIZE db 0

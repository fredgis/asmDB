; -----------------------------------------------------------------------------
; src/data.inc - globals, strings, on-disk header template, import table.
; All of this lives in the single read/write .text section.
; -----------------------------------------------------------------------------

; ------------------------------- globals ------------------------------------
g_stdout:      dq 0
g_stdin:       dq 0
g_written:     dd 0
g_readlen_dw:  dd 0
g_io_dw:       dd 0
g_readbuf:     dq 0
g_readlen:     dq 0
g_readpos:     dq 0
g_linebuf:     dq 0
g_table:       dq 0
g_count:       dq 0
g_dat_handle:  dq 0
g_wal_handle:  dq 0
g_in_txn:      dq 0
g_undo:        dq 0
g_undo_n:      dq 0
g_count_snap:  dq 0
g_walbuf:      dq 0
g_onech:       db 0
               align 8
g_tmp:         times 32 db 0
g_spaces:      times 64 db ' '
g_namebuf:     times 64 db 0
g_base:        times 216 db 0
g_datname:     times 224 db 0
g_walname:     times 224 db 0
g_hdr_read:    times HDR_SIZE db 0

; --------------------------- on-disk header ---------------------------------
                align 8
g_hdr:
    db 'ASMDB', 0, 0, 0              ; +0  magic (8 bytes)
    dd DB_VERSION                    ; +8
    dd REC_SIZE                      ; +12
    dq CAPACITY                      ; +16
    dq 0                             ; +24 live count (rewritten at runtime)
    times HDR_SIZE-32 db 0           ; pad to 512

; ------------------------------- strings ------------------------------------
s_magic:       db 'ASMDB', 0
s_defbase:     db 'asmdb', 0
s_dotdat:      db '.dat', 0
s_dotwal:      db '.wal', 0
                align 8
wal_magic:     db 'ASMWAL01'
wal_commit:    db 'COMMIT01'

s_prompt:      db 'asmdb> ', 0
s_unknown:     db '[ERR] unknown command - type HELP', 13, 10, 0
s_ok_ins:      db '[ OK ] 1 row inserted', 13, 10, 0
s_ok_upd:      db '[ OK ] 1 row updated', 13, 10, 0
s_ok_del:      db '[ OK ] 1 row deleted', 13, 10, 0
s_err_dup:     db '[ERR] key already exists', 13, 10, 0
s_err_nf:      db '[ERR] key not found', 13, 10, 0
s_err_full:    db '[ERR] table full', 13, 10, 0
s_err_syntax:  db '[ERR] syntax error - type HELP', 13, 10, 0
s_count_pre:   db '[ OK ] ', 0
s_count_post:  db ' row(s)', 13, 10, 0
s_txn:         db '[ OK ] autocommit mode (each statement is durable)', 13, 10, 0
s_txn_begin:    db '[ OK ] transaction started', 13, 10, 0
s_txn_commit:   db '[ OK ] transaction committed', 13, 10, 0
s_txn_rollback: db '[ OK ] transaction rolled back', 13, 10, 0
s_txn_none:     db '[ERR] no active transaction', 13, 10, 0
s_txn_active:   db '[ERR] transaction already active', 13, 10, 0
s_txn_toobig:   db '[ERR] transaction too large - COMMIT or ROLLBACK', 13, 10, 0

s_cell_l:      db '| ', 0
s_cell_m:      db ' | ', 0
s_cell_r:      db ' |', 0
s_lbl_id:      db 'id', 0
s_lbl_name:    db 'name', 0
s_lbl_val:     db 'value', 0

s_help:
    db 13, 10
    db '  asmdb commands', 13, 10
    db '  ------------------------------------------------------', 13, 10
    db '  INSERT <id> <value> <name>   add a row', 13, 10
    db '  SELECT <id>                  show one row', 13, 10
    db '  SELECT *                     show all rows', 13, 10
    db '  UPDATE <id> <value> <name>   modify a row', 13, 10
    db '  DELETE <id>                  remove a row', 13, 10
    db '  COUNT                        number of live rows', 13, 10
    db '  BEGIN | COMMIT | ROLLBACK    transaction control', 13, 10
    db '  HELP                         this screen', 13, 10
    db '  EXIT | QUIT                  leave asmdb', 13, 10
    db 13, 10, 0

; -------------------------------- banner ------------------------------------
banner:
    db 13, 10
    db '    _    ____  __  __ ____  ____ ', 13, 10
    db '   / \  / ___||  \/  |  _ \| __ )', 13, 10
    db '  / _ \ \___ \| |\/| | | | |  _ \', 13, 10
    db ' / ___ \ ___) | |  | | |_| | |_) |', 13, 10
    db '/_/   \_\____/|_|  |_|____/|____/ ', 13, 10
    db 13, 10
    db '  +---------------------------------------------+', 13, 10
    db '  |  minimalist transactional DB - x86-64 asm   |', 13, 10
    db '  |  NASM -f bin | no linker | no CRT           |', 13, 10
    db '  +---------------------------------------------+', 13, 10
    db 13, 10
    db '  Type HELP for commands, EXIT to quit.', 13, 10
    db 13, 10, 0

; ------------------------------- keywords -----------------------------------
kw_insert:     db 'INSERT', 0
kw_select:     db 'SELECT', 0
kw_update:     db 'UPDATE', 0
kw_delete:     db 'DELETE', 0
kw_count:      db 'COUNT', 0
kw_help:       db 'HELP', 0
kw_exit:       db 'EXIT', 0
kw_quit:       db 'QUIT', 0
kw_begin:      db 'BEGIN', 0
kw_commit:     db 'COMMIT', 0
kw_rollback:   db 'ROLLBACK', 0

; ----------------------------- import table ---------------------------------
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
iat_ExitProcess:       dq RVA(h_ExitProcess)
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
h_ExitProcess:       dw 0
    db 'ExitProcess', 0

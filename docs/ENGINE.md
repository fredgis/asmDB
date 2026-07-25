# asmdb — Engine Specification

> The precise technical reference for **asmdb**: a minimalist, transactional
> database written in **x86-64 assembly** (NASM, `-f bin`), with **no linker**
> and **no C runtime**. One engine source builds two native binaries — a
> **Windows PE64** (raw Win32) and a **Linux ELF64** (raw `syscall`s) — behind a
> thin `os_*` platform layer. It provides WAL-durable transactions, an ASCII-art
> REPL, and a **Model Context Protocol** server that exposes it as a generic
> CRUD store (durable **memory for AI agents** being one example use case).
>
> This document describes what the engine *actually does today*, byte for byte.
> For the high-level tour and benchmarks, see the [README](../README.md); for
> what is planned next, see [§12 Roadmap](#12-roadmap).

---

## Table of contents

1. [Design goals & constraints](#1-design-goals--constraints)
2. [Build toolchain & executable layout (PE64 + ELF64)](#2-build-toolchain--executable-layout-pe64--elf64)
3. [Calling convention & register discipline](#3-calling-convention--register-discipline)
4. [Record layout (256-byte record)](#4-record-layout-256-byte-record)
5. [Hash table — the store *is* the index](#5-hash-table--the-store-is-the-index)
6. [On-disk formats](#6-on-disk-formats)
7. [Transactions, durability & crash recovery](#7-transactions-durability--crash-recovery)
8. [Timestamps](#8-timestamps)
9. [REPL command grammar](#9-repl-command-grammar)
10. [Supported column types](#10-supported-column-types)
11. [MCP server — CRUD interface](#11-mcp-server--crud-interface)
12. [Roadmap](#12-roadmap)
13. [Source map](#13-source-map)

---

## 1. Design goals & constraints

| Axis | Decision |
|------|----------|
| Architecture | x86-64 (AMD64) |
| Assembler | **NASM**, Intel syntax |
| Linking | **None** — `nasm -f bin` emits the PE64 / ELF64 directly |
| Runtime | **No CRT** — raw **Win32** (`kernel32.dll`) on Windows, raw **syscalls** on Linux |
| Portability | One source; a thin **`os_*`** layer is the only per-OS code (§2.4) |
| Data model | **Fixed-size** records, 256 B (four cache lines) |
| Index | **Open-addressing** hash table (the store IS the index) |
| Transactions | **WAL** (write-ahead log) → atomicity, durability, recovery |
| Interface | **REPL** over stdin/stdout, ASCII-art presentation |
| Integration | **MCP** server (Node) exposing the engine as a generic CRUD store |

**Design center.** The record schema is a general-purpose fixed shape: a numeric
`value`, automatic creation/update timestamps, a short category `tag`, and a
free-text `content` field — all fixed-width so every operation is pointer
arithmetic. The whole store is a single flat hash region that is memory-mapped
into RAM at startup, so CRUD is in-memory and durability is layered on top by
the WAL. (Agent memory is one workload this shape suits — not the only one.)

### Deliberate non-goals (today)

- Full SQL, joins, or secondary indexes.
- Multi-process concurrency, networking, replication.
- Non-integer primary keys (v1 key is `u64`; the MCP layer hashes strings to it).
- Dynamic table resizing (capacity is fixed and documented).

Everything in [§12 Roadmap](#12-roadmap) — columnar storage, compression,
bitmap/secondary indexes, partitioning, parallel scans, MVCC — is **not yet
implemented** and is labelled as such throughout.

---

## 2. Build toolchain & executable layout (PE64 + ELF64)

```
nasm -f bin -i src\ src\main.asm       -o build\asmdb.exe   ; Windows PE64
nasm -f bin -dLINUX src\main.asm       -o build\asmdb       ; Linux   ELF64
```

`-f bin` emits a **flat binary**; asmdb hand-writes the *entire* executable
image for each OS — there is no linker and no import library on either platform.
A compile-time switch (`-dLINUX`) selects the platform header (`elf.inc`) and
backend (`os_linux.inc`); without it, `main.asm` emits the PE64 and includes
`os_win.inc`. The ~2,000 lines of engine logic are compiled verbatim for both.

### 2.1 Windows PE64

- asmdb hand-writes the DOS stub, `IMAGE_FILE_HEADER`, `IMAGE_OPTIONAL_HEADER64`,
  the section table, and the import table.
- **RVA == file offset.** `SectionAlignment == FileAlignment == 0x200` (see
  `ALIGN` in `asmdb.inc`), so a symbol's virtual address equals its file offset.
  This is what makes a hand-written import table tractable — every thunk
  references its target by RVA, which is just its offset.
- **Image base** is `0x400000`; `RVA(x)` in the source is simply `x - IMAGEBASE`.
- The result is a single self-contained **~27 KB PE64** whose only dependency is
  `kernel32.dll`. The 1 GiB record region (sparse on disk) is **not** in the exe —
  it is obtained from `VirtualAlloc` at startup.

#### kernel32 imports

The centralized import table in `data.inc` binds these functions (all called
via `[rel iat_*]` thunks):

```
GetStdHandle   ReadFile        WriteFile       CreateFileA
SetFilePointerEx  FlushFileBuffers  SetEndOfFile  CloseHandle
VirtualAlloc   ExitProcess     GetSystemTimeAsFileTime
QueryPerformanceCounter  QueryPerformanceFrequency
GetConsoleMode  SetConsoleMode  FindFirstFileA  FindNextFileA  FindClose
GetCommandLineA  GetLastError  DeviceIoControl
```

`GetSystemTimeAsFileTime` powers automatic timestamps (§8);
`QueryPerformanceCounter/Frequency` power the `BENCH` command; `FindFirstFileA`
enumerates `*.dat` for the `DATABASES` command; `GetConsoleMode/SetConsoleMode`
enable ANSI colour when stdout is a real console.

### 2.2 Linux ELF64

The ELF binary is just as hand-built — there is **no libc, no dynamic loader, no
imports at all**. `elf.inc` emits a 64-byte ELF header followed by a single
program header describing one `PT_LOAD` segment that is mapped **RWX** at
`0x400000`:

```asm
; elf.inc — hand-written ELF64 header (excerpt); ORG 0x400000
ehdr:
    db  0x7F, 'E', 'L', 'F'          ; EI_MAG
    db  2, 1, 1, 0                   ; ELFCLASS64, LSB, EV_CURRENT, System V
    dq  0                            ; EI_ABIVERSION + 7 pad
    dw  2                            ; e_type      = ET_EXEC
    dw  0x3E                         ; e_machine   = x86-64
    dd  1                            ; e_version
    dq  entry                        ; e_entry     (absolute vaddr)
    dq  phdr - ehdr                  ; e_phoff
    ...
phdr:
    dd  1                            ; p_type   = PT_LOAD
    dd  7                            ; p_flags  = R | W | X
    dq  0                            ; p_offset (map from start of file)
    dq  ehdr                         ; p_vaddr  (= 0x400000)
    dq  ehdr                         ; p_paddr
    dq  sec_end - ehdr               ; p_filesz (whole image)
    dq  sec_end - ehdr               ; p_memsz  (no BSS: memsz == filesz)
    dq  0x1000                       ; p_align  (page)
```

Because `p_filesz == p_memsz`, every buffer is **file-initialised** (there is no
separate `.bss`), which keeps the loader trivial and the ELF fully static. The
1 GiB record region comes from an `mmap` syscall at startup. `tests/validate_elf.py`
asserts these invariants in CI, and the smoke suite runs the ELF **natively on
Ubuntu**.

### 2.3 The `os_*` platform layer

Everything above the OS — the REPL, parser, hash store, transactions and WAL — is
platform-agnostic and compiled identically for both targets. All OS divergence is
funnelled through a small set of `os_*` primitives, implemented once in
`os_win.inc` and once in `os_linux.inc`:

```
os_init_std      open stdin/stdout, detect a TTY (colour gate)
os_open          open/create a file            (CreateFileA  / openat)
os_read/os_write sequential console + file I/O (ReadFile     / read,  WriteFile / write)
os_pread/os_pwrite  positioned slot I/O        (SetFilePointerEx+ReadFile / pread64, pwrite64)
os_alloc         small runtime buffers         (VirtualAlloc / mmap anon)
os_map_cow       map the store copy-on-write   (CreateFileMapping+MapViewOfFile / mmap MAP_PRIVATE)
os_filesize      file length, for validation   (GetFileSizeEx / lseek SEEK_END)
os_flush         force durability              (FlushFileBuffers / fsync)
os_truncate      shrink a file (WAL checkpoint)(SetEndOfFile / ftruncate)
os_now_ms        wall-clock epoch ms           (GetSystemTimeAsFileTime / clock_gettime)
os_exit          terminate                     (ExitProcess / exit_group)
```

Both backends present the **same contract**: arguments in the Win64 order
(`rcx, rdx, r8, r9`), result in `rax`, and callee-saved `rbx/rsi/rdi/r12`
preserved. The Linux backend translates that contract into the SysV syscall ABI
(`rdi, rsi, rdx, r10, r8, r9`, number in `rax`, `syscall`) inside each wrapper, so
callers never see the difference.

### 2.4 Windows ↔ Linux syscall mapping

| `os_*` primitive | Windows (`kernel32`) | Linux (syscall #) |
|---|---|---|
| `os_open` | `CreateFileA` | `open` (2) |
| `os_read` | `ReadFile` | `read` (0) |
| `os_write` | `WriteFile` | `write` (1) |
| `os_pread` | `SetFilePointerEx` + `ReadFile` | `pread64` (17) |
| `os_pwrite` | `SetFilePointerEx` + `WriteFile` | `pwrite64` (18) |
| `os_alloc` | `VirtualAlloc` | `mmap` anon (9) |
| `os_map_cow` | `CreateFileMappingA` + `MapViewOfFile` | `mmap` `MAP_PRIVATE` (9) |
| `os_filesize` | `GetFileSizeEx` | `lseek` `SEEK_END` (8) |
| `os_flush` | `FlushFileBuffers` | `fsync` (74) |
| `os_truncate` | `SetEndOfFile` | `ftruncate` (77) |
| `os_now_ms` | `GetSystemTimeAsFileTime` | `clock_gettime` (228) |
| `os_isatty` | `GetConsoleMode` | `ioctl(TCGETS)` (16) |
| `os_exit` | `ExitProcess` | `exit_group` (231) |

Build/run helpers live in `build.ps1` (`-Run` launches the REPL; `-Linux`
cross-emits the ELF) and `build.sh` (native Linux build).

---

## 3. Calling convention & register discipline

- **External calls** use the Win64 ABI: integer args in `rcx, rdx, r8, r9`,
  return in `rax`, **32 bytes of shadow space** reserved by the caller,
  16-byte stack alignment at the call site. Every function establishes a
  `push rbp / mov rbp, rsp / sub rsp, N` frame that reserves shadow space for
  its callees.
- **The `os_*` layer keeps this contract on both platforms.** Callers always pass
  `rcx, rdx, r8, r9` → `rax`, even on Linux; the Linux wrapper shuffles those into
  the SysV syscall registers (`rdi, rsi, rdx, r10, r8, r9`, number in `rax`) and
  preserves the Win64 callee-saved set the engine relies on:

  ```asm
  ; os_linux.inc — os_write(rcx=fd, rdx=buf, r8=len) -> rax=bytes written
  os_write:
      mov  rax, SYS_write            ; 1
      mov  rdi, rcx                  ; fd   (Win64 rcx -> SysV rdi)
      mov  rsi, rdx                  ; buf  (Win64 rdx -> SysV rsi)
      mov  rdx, r8                   ; len  (Win64 r8  -> SysV rdx)
      syscall                        ; result already in rax
      ret
  ```

- **Internal helpers** follow a lightweight private convention: arguments in
  `rcx, rdx, r8, r9` (documented per function), result in `rax`. During command
  dispatch and handlers, **`rsi` is the line cursor** — it walks the input line
  and is preserved across tokenizer calls.
- Callee-saved registers (`rbx, rsi, rdi, r12-r15`) are spilled to the local
  frame when a helper needs them, and restored on exit — on **both** platforms,
  because the engine assumes the Win64 saved-register set everywhere.
- `os_now_ms` and other OS-calling helpers bump their frame to include the
  32-byte shadow area before a Windows call.

---

## 4. Record layout (256-byte record)

Each record is exactly **256 bytes = four 64-byte cache lines**, so slot *i*
lives at byte offset `i << REC_SHIFT` (`REC_SHIFT = 8`).

| Offset | Size | Field     | Type       | Description |
|-------:|-----:|-----------|------------|-------------|
| 0      | 8    | `id`      | `u64`      | primary key |
| 8      | 1    | `status`  | `u8`       | `0` empty / `1` live / `2` deleted (tombstone) |
| 9      | 1    | `kind`    | `u8`       | row-kind tag (reserved, default `0`) |
| 12     | 4    | `clen`    | `u32`      | content byte length |
| 16     | 8    | `created` | `i64`      | creation time, unix epoch ms (auto) |
| 24     | 8    | `updated` | `i64`      | last-update time, unix epoch ms (auto) |
| 32     | 8    | `value`   | `i64`      | numeric payload / score |
| 40     | 40   | `tag`     | `char[40]` | category / namespace, NUL-padded |
| 80     | 176  | `content` | `char[176]`| free text, NUL-padded |

- The `tag` field stores at most **39** bytes plus a guaranteed NUL; `content`
  at most **175** bytes plus a guaranteed NUL. The parser caps input at
  `TAG_MAX-1` / `CONTENT_MAX-1` so a terminator always exists inside the fixed
  field even though the copy always writes the full width.
- `clen` records the exact content length so the detail view can print content
  precisely (`putn` with an explicit length) without scanning for a NUL.
- Fixed width ⇒ O(1) `slot << 8` addressing and cache-friendly sequential scans
  (used by `SELECT *`, `FIND`, `COUNT`).

The `SCHEMA` command prints this exact table at runtime.

---

## 5. Hash table — the store *is* the index

- The store is a single array of **`CAPACITY = 4194304`** slots (`2^22`),
  `256 B` each → a **1 GiB** contiguous region, **mapped copy-on-write from the
  `.dat`** rather than allocated and read (§6.1). The backing file is created
  **sparse**, so unused slots cost neither disk nor RAM.

- **Hash function — Fibonacci (multiplicative) hashing.** Multiply the key by the
  64-bit golden-ratio constant `⌊2^64 / φ⌋` and keep the **top** `log2(CAPACITY)`
  bits. The top bits mix in the most entropy from the multiply, so even dense,
  sequential ids scatter uniformly across the table with a single `imul`:

  ```asm
  ; src/store.inc — store_hash(rcx = id) -> rax = slot in [0, CAPACITY)
  store_hash:
      mov  rax, rcx
      mov  rdx, GOLDEN          ; 0x9E3779B97F4A7C15  = floor(2^64 / phi)
      imul rax, rdx             ; low 64 bits of id * golden ratio
      shr  rax, CAP_SHIFT       ; CAP_SHIFT = 64 - log2(CAPACITY) = 64 - 22 = 42
      ret                       ; -> keep the top 22 bits
  ```

- **Collision resolution — linear probing.** Walk contiguous slots
  `(h + i) mod CAPACITY` until the key, an empty slot, or a reusable tombstone is
  found. Contiguous probing is cache-optimal (each step is the next cache line),
  and the first tombstone seen is remembered as the insertion point so space is
  reclaimed. `CAPACITY` is a power of two, so the modulo is a single `AND`:

  ```asm
  ; src/store.inc — store_locate probe loop (simplified)
  .probe:
      mov  rax, rsi
      shl  rax, REC_SHIFT       ; slot index * 256  (REC_SHIFT = 8)
      add  rax, rdi             ; rax = &table[slot]
      mov  cl, [rax+REC_STATUS]
      cmp  cl, ST_EMPTY         ; 0 -> key absent, insert here
      je   .empty
      cmp  cl, ST_DELETED       ; 2 -> tombstone, remember as candidate
      je   .deleted
      mov  rdx, [rax+REC_ID]    ; 1 -> occupied, compare the key
      cmp  rdx, rbx
      je   .found
  .cont:
      inc  rsi
      and  rsi, CAPACITY-1      ; wrap: power-of-two modulo is one AND
      inc  r8
      cmp  r8, CAPACITY
      jb   .probe               ; bounded: never loops forever
  ```

- **Deletion:** tombstone (`status = 2`) so probe chains stay intact; a later
  INSERT may reuse a tombstoned slot (the `.deleted` branch above).
- **Load factor** is intended to stay `< 0.75`; INSERT into a full table returns
  an explicit error (resizing is [future work](#12-roadmap)).
- `SELECT <id>`, `UPDATE`, `DELETE` are all O(1) average (hash + short probe).
  `SELECT *`, `FIND` and `COUNT` are O(capacity) linear scans over the region.

---

## 6. On-disk formats

Two files per database, named from the DB base name: `<db>.dat` and `<db>.wal`.

### 6.1 `<db>.dat` — data file

```
[ 512-byte header ]
  +0    8   magic      "ASMDB\0\0\0"
  +8    4   version    u32   DB_VERSION
  +12   4   rec_size   u32   REC_SIZE (256)
  +16   8   capacity   u64   CAPACITY (2^22)
  +24   8   count      u64   live record count
  +32   48  table      char[48]  logical table name (NUL-padded)
  ...       reserved (padding to 512)
[ Slot region: CAPACITY * 256 B ]   ← direct image of the in-RAM hash table
```

The header is 512 bytes (`HDR_SIZE`); the slot region is a byte-for-byte image
of the live hash table. `count` is refreshed in the header on every durable
write. The logical table name is resolved from (in priority order) a CLI
argument, the header, or the DB base name.

A brand-new `.dat` is created **sparse**: `db_open` issues `DeviceIoControl`
with `FSCTL_SET_SPARSE`, then `SetEndOfFile` extends the file to the full
`HDR_SIZE + CAPACITY*256` logical size **without allocating or zeroing 1 GiB**.
Unwritten slots read back as zero and cost nothing on disk, so an empty database
occupies a few kilobytes. Individual `WriteFile`s (autocommit, `COMMIT`,
`BENCH` checkpoint) lazily materialise only the slots they touch.

#### The store is a copy-on-write mapping, not a buffer

`g_table` does **not** point at a 1 GiB allocation that was read from disk. The
slot region is **mapped copy-on-write** — `CreateFileMapping(PAGE_WRITECOPY)` +
`MapViewOfFile(FILE_MAP_COPY)` on Windows, `mmap(PROT_READ|PROT_WRITE,
MAP_PRIVATE)` on Linux — and `g_table = mapped_base + HDR_SIZE`.

```asm
    mov  rcx, [rel g_dat_handle]
    mov  rdx, HDR_SIZE + CAPACITY*REC_SIZE
    call os_map_cow                  ; reads fault in; writes stay private
    test rax, rax
    jz   .mapfail
    add  rax, HDR_SIZE               ; slot region starts after the header
    mov  [rel g_table], rax
```

Three properties follow, and the third is the reason this is safe:

- **Open is O(1).** Nothing is read or committed up front. Opening a database
  measured ~600 ms *regardless of its contents* before this change (0 rows,
  1 000 rows and 1 000 000 rows were indistinguishable); it is now ~80 ms, and
  that remainder is process start, not the store.
- **Residency follows the data.** Pages materialise only when touched, so a
  million-row database peaks at **~5 MB** of working set instead of ~1 029 MB.
- **Durability is untouched.** A *private* mapping means writes to `g_table`
  never reach the file. The `.dat` still changes only through the explicit
  `write_at` / `fsync` paths of §7, so the WAL protocol, the undo log and the
  "in a transaction, nothing is durable until COMMIT" invariant all hold exactly
  as before. A shared mapping would have broken that: the OS could flush an
  uncommitted page at any time.

The mapping is created **after** `wal_recover`, because recovery writes to the
file directly and a private mapping is not guaranteed to observe writes made to
the file after it was created. The file size is checked explicitly first
(`os_filesize`) — that replaces the old "read the whole region and see if it
came up short" truncation test, and it matters because `CreateFileMapping`
would otherwise silently grow a truncated file to fit.

**The trade-off, stated plainly:** a full-table scan (`SELECT *`, `FIND`,
`RANGE`, `TRUNCATE`) now faults the region in rather than walking RAM that was
already resident, which costs about **26 % more on a full `FIND`** and more than
that on a sparsely populated table. Every other operation — and every
invocation's startup — is several times faster, and the memory saving is what
makes one container per instance realistic (see [SAAS.md](SAAS.md)). Closing
that gap is the next roadmap item: a **persisted dense status directory**, so a
scan streams a few MiB instead of touching the whole region.

#### Versioning and upgrades

Two numbers, deliberately independent:

| | Where | Moves when | Governs |
|---|---|---|---|
| **Engine version** (`ENGINE_MAJOR/MINOR/PATCH`) | `asmdb.inc`, shown by the banner and `VERSION` | every release | nothing at runtime — it is *reported*, never *enforced* |
| **Storage format** (`DB_VERSION`) | header `+8` | only when the bytes in `<db>.dat` change meaning | whether a file opens at all |

Pre-1.0 the rule is: while `MAJOR` is `0`, `MINOR` marks a milestone or a
behaviour change and `PATCH` marks fixes, performance and docs. 1.0 is declared
deliberately.

The header carries the engine version that last wrote the file at
`HDR_ENGINE (+80)`, purely for diagnostics — `VERSION` prints it, and it never
influences whether the database can be opened. Files written before 0.9.0 have
zero there and are reported as unstamped.

**The upgrade path.** `db_open` refuses anything it does not fully understand
(above), which is safe but leaves the operator stuck. `asmdb <db> --upgrade`
(`db_upgrade`) is the escape hatch:

1. Open the source **read-only** and read its header.
2. If `version`, `rec_size` and `capacity` all match this build → nothing to do.
3. If `version` or `rec_size` differ → refuse. There is no migration path for
   those in this build, and guessing at a record layout would destroy data.
4. If only `capacity` differs → the records themselves are unchanged but they
   hash to different slots, so create `<db>.upgraded.dat`, map it, stream the
   source region in `WAL_BUF_SIZE` chunks, and re-insert every live row through
   `store_locate`. The logical table name is carried over.

The source is never written to, and the result is a *new* file the operator
swaps in. That is the whole safety argument: a migration that goes wrong costs
nothing, so it can be attempted freely. A future format change adds a step 3
branch rather than a new mechanism.

#### Open-time validation
Only a **0-byte** file is treated as a new database. Anything else must pass
every check below, because silently "recreating" a file we failed to parse would
destroy real data:

| Condition | Outcome |
|---|---|
| file is 0 bytes | create a new database (sparse, header written) |
| 1 .. 511 bytes | `[ERR] database file is incomplete or corrupt` — a partially written header |
| magic ≠ `ASMDB\0\0\0` (all 8 bytes) | `[ERR] … incomplete or corrupt` |
| `version`, `rec_size` or `capacity` ≠ this build | `[ERR] incompatible database format` |
| `count > CAPACITY` | `[ERR] … incomplete or corrupt` |
| slot region shorter than `CAPACITY*256` | `[ERR] … incomplete or corrupt` |

Each of these exits with status 1 **without writing a byte**. The WAL is only
opened and replayed *after* the header has been validated, so a corrupt `.dat`
is never mutated by recovery.

### 6.2 `<db>.wal` — write-ahead log

The WAL is a **single staging frame** that mirrors the in-memory buffer
(`g_walbuf`) to disk:

```
+0    8              magic  'ASMWAL02'
+8    8              N      entry count
+16   8              count  live-row count to publish into the header on apply
+24   N * (8 + 256)  entries: { u64 slot index ; 256-byte after-image }
+M    8              marker 'COMMIT01'   ┐ written and flushed LAST,
+M+8  8              crc32  of [0, M)    ┘ together, in one write
```

- Each entry is `UNDO_ENTRY = 8 + 256 = 264` bytes: a slot index followed by the
  **post-mutation image** of that slot, so replay is idempotent redo.
- A single entry format captures INSERT, UPDATE and DELETE alike (DELETE writes
  a slot whose `status = 2`).
- The `'COMMIT01'` marker is the atomicity point: it is written and flushed only
  after the entries are durable.
- The **CRC-32** (IEEE, reflected, poly `0xEDB88320`) covers the header and all
  entries. It ships in the *same* write and flush as the marker, so a frame can
  never be "committed but unchecksummed". A table-driven implementation
  (`crc32_init` builds 256 dwords once at startup) keeps the cost proportional
  to the bytes actually staged, not to the 2 MiB buffer.
- Frames carrying the older `'ASMWAL01'` magic have no checksum and are still
  replayed, so upgrading the binary never discards a transaction that was
  already acknowledged.

---

## 7. Transactions, durability & crash recovery

### 7.1 In-memory transaction model

`BEGIN` opens a transaction (`g_in_txn = 1`), resets the undo counter, and
snapshots the live `count`. While a transaction is open, every mutation:

1. is applied **in RAM only** (directly into the hash region), and
2. records an **undo entry** (slot index + *pre-image*) via `txn_capture`, so
   `ROLLBACK` can restore it. The undo log holds up to `UNDO_MAX = 4096`
   touched slots.

`txn_capture` captures a slot **at most once per transaction**: it scans the
existing entries for the slot index first and keeps the *first* pre-image it
recorded. Three consequences follow, and all three matter:

- the 4096-entry ceiling limits **distinct rows touched**, not statements
  issued — a loop that rewrites one row a million times uses one entry;
- `ROLLBACK` restores the row's **original** image rather than an intermediate
  one;
- `COMMIT` stages exactly one after-image per row, so the WAL frame stays
  proportional to the working set instead of the write count.

```asm
; txn_capture(rcx = slot ptr) - dedup by slot index, keep the first image
    call store_slot_index            ; rax = index of this slot
    mov  rbx, [rel g_undo]
    xor  rsi, rsi
.scan:
    cmp  rsi, [rel g_undo_n]
    jae  .append
    cmp  [rbx], rax                  ; already captured in this txn?
    je   .ok                         ; yes - first pre-image wins
    add  rbx, UNDO_ENTRY
    inc  rsi
    jmp  .scan
```

Mutations issued **outside** `BEGIN…COMMIT` are autocommitted — each is its own
implicit single-statement transaction that writes through to `<db>.dat`.

`BACKUP`, `RESTORE` and `BENCH` are refused while a transaction is open: each
rewrites or replaces the whole table, which would strand the undo log against
slots that no longer hold the rows it captured.

### 7.2 Commit protocol (two-phase flush)

`COMMIT` performs a strict write-ahead sequence (`cmd_commit`):

1. Stage the frame in `g_walbuf`: magic, `N`, new `count`, then the **current
   after-image** of every touched slot read from the live table.
2. `WriteFile` the header + entries to the WAL, then **`FlushFileBuffers`**.
3. Write the `'COMMIT01'` marker and **`FlushFileBuffers` again** — the
   transaction is now durably committed.
4. Apply each after-image to `<db>.dat` (`write_at` at `HDR_SIZE + slot*256`).
5. `db_write_header`, `db_flush`, then **`wal_truncate`** — the checkpoint that
   empties the WAL.

If the process dies before step 3 completes, the WAL has no valid marker and the
transaction never happened. If it dies between steps 3 and 5, the marked WAL is
replayed on next startup.

The *order* of the two flushes is the entire correctness argument — the marker is
written and flushed **only after** the data is already durable in the log:

```asm
; src/wal.inc — cmd_commit two-phase flush (order is the invariant)
    call wal_write            ; 1. header + N after-images -> <db>.wal
    call wal_flush            ; 2. fsync: data is now safe in the log
    mov  rax, [rel wal_commit]
    mov  [rsi], rax           ; 3. append the 'COMMIT01' marker ...
    ...
    call wal_write
    call wal_flush            ;    ... and fsync AGAIN -> transaction committed
    ; --- past this line the commit survives any crash ---
.apply:                       ; 4. redo after-images into <db>.dat
    ...
    call write_at
    ...
    call db_write_header
    call db_flush
    call wal_truncate         ; 5. checkpoint: empty the WAL
```

### 7.3 Crash recovery

`wal_recover` runs in `db_open` — **after** the `.dat` header has been validated
(§6.1), so a corrupt data file is never mutated by recovery — and *before* the
table is read into RAM:

1. Read the WAL frame. If it is unreadable, shorter than the 24-byte header, or
   the magic mismatches, or `N > UNDO_MAX`, or the `'COMMIT01'` marker is
   missing at `24 + N*264` → **discard** (truncate) the WAL. An incomplete
   transaction simply never existed.
2. Validate the frame's *contents* before touching disk: every entry's slot
   index must be `< CAPACITY` and the stored `count` must be `<= CAPACITY`.
   Otherwise redo would write a 256-byte record at an arbitrary file offset and
   grow the `.dat` past its region, so the whole frame is discarded instead.
3. Verify the **CRC-32** stored next to the marker (`'ASMWAL02'` frames). Three
   outcomes, and the distinction matters:
   - *checksum absent because the frame is short* → the final 16-byte write was
     torn, so the commit never completed → **discard**;
   - *checksum present and matching* → replay;
   - *checksum present and mismatching* → the transaction **was** committed and
     acknowledged, but its bytes are damaged. Replaying would write corrupt
     records; discarding would silently lose an acknowledged transaction.
     Neither is acceptable, so the engine **refuses to open** and says so,
     leaving the `.wal` in place. The operator can restore from a backup, or
     delete the `.wal` to reopen at the last checkpoint.
4. Otherwise the frame is committed: **redo** every after-image into
   `<db>.dat`, publish the stored `count` into the header, flush, and truncate
   the WAL. Every redo write is checked; a failure aborts (§7.5) rather than
   leaving the checkpoint half-applied.

Both open paths then read the slot region into RAM — including the path that
*created* the `.dat`, because a committed WAL can predate the data file and its
replayed rows must land in memory as well as on disk.

The result is **atomicity** (all-or-nothing per transaction), **durability**
(flush before acknowledging), and clean crash recovery with idempotent redo.

### 7.4 Rollback

`ROLLBACK` walks the undo log in reverse, copying each pre-image back into its
slot, restores the snapshotted `count`, truncates the WAL, and clears the
transaction flag. Nothing durable was written, so there is nothing to undo on
disk.

### 7.5 I/O error propagation

Durability is only as good as the error checking underneath it, so every layer
reports failure explicitly rather than returning a plausible-looking number.

| Layer | Contract |
|---|---|
| `os_pread` / `os_pwrite` | bytes transferred, or **`-1`** on error. On Windows both the `SetFilePointerEx` seek *and* the `ReadFile`/`WriteFile` are checked, and the byte counter is zeroed first so a failed call can never return a stale count. On Linux a negative `-errno` collapses to `-1`, which keeps it distinct from a `0` that means EOF. |
| `os_fsync` / `os_truncate` | **`0`** on success, **`-1`** on failure. |
| `read_at` | total bytes read, or `-1`. A short read means "the file really is that short" and is reported as such — callers compare against the length they asked for. |
| `write_at` | total bytes written, or `-1`. An error **or a zero-byte write** (no forward progress, e.g. a full disk) is a failure: a partial write is never reported as success. |
| `wal_write` | loops over short writes; any failure aborts. |

On a durable path — `db_write_slot`, `db_write_header`, `db_flush`, the WAL
writes and flushes, the `COMMIT` checkpoint, WAL redo, and the `BENCH`
checkpoint — a failure calls `io_fatal`, which prints

```
[ERR] I/O failure on a durable write - aborting to avoid an inconsistent database
```

and exits with status 1. This is deliberate: once a durable write has failed,
RAM and disk may disagree, and continuing to serve `[ OK ]` replies over a
database we can no longer vouch for is worse than stopping. The engine **never
prints `[ OK ] ` after a failed write.**

A failed **read** goes to `io_fatal_read` instead — nothing durable is at risk,
but the in-memory image would be incomplete, so the engine stops rather than
serve rows it only partially loaded.

> **How the abort path is tested.** Since a real `ENOSPC` is hard to stage,
> the suites assemble a throwaway binary with `-dFAULT_INJECT=<n>`, which makes
> the *n*-th `write_at` fail. The tests assert that the engine aborts, explains
> why, does **not** print `transaction committed`, and leaves a committed WAL
> that a normal binary then replays — which also proves the assembly CRC-32 the
> writer produced is the one the reader expects. The `%ifdef` contributes zero
> bytes to the shipping binary.

`BACKUP` is the one exception that reports without aborting — it writes to a
*separate* file and leaves the live database untouched, so a failure there is
just `[ERR] backup failed - write error, file is incomplete`. `RESTORE`
validates the snapshot completely (magic, format fields, count, and a probe for
the **last byte** of the record region) *before* overwriting a single byte of
the live table, so a truncated or foreign snapshot leaves both RAM and disk
exactly as they were.

---

## 8. Timestamps

`created` and `updated` are set automatically by the engine, never by the
caller. `os_now_ms` returns unix epoch milliseconds, computed differently per
platform but presented identically:

```
Windows:  GetSystemTimeAsFileTime(&ft)        ; 100-ns ticks since 1601-01-01
          ms = ft / 10000 - 11644473600000    ; -> unix epoch ms
Linux:    clock_gettime(CLOCK_REALTIME, &ts)  ; {tv_sec, tv_nsec} since 1970
          ms = ts.tv_sec * 1000 + ts.tv_nsec / 1000000
```

`INSERT` sets both `created` and `updated` to `os_now_ms()`; `UPDATE` sets
`updated` only and preserves `created`. The detail view (`SELECT <id>`) prints
both as raw millisecond integers.

---

## 9. REPL command grammar

The dispatcher tokenizes on whitespace and matches the first token
case-insensitively. `tag` is a single token; `content` is *rest-of-line* (spaces
allowed).

| Command | Effect |
|---------|--------|
| `INSERT <id> <value> <tag> <content...>` | **C**reate a record (auto timestamps; `id ≥ 1`) |
| `SELECT <id>` | **R**ead one record → detail block (full content + timestamps) |
| `SELECT *` | Read all → 4-column ASCII table (`id \| tag \| value \| content`) |
| `UPDATE <id> <value> <tag> <content...>` | **U**pdate a record (bumps `updated`) |
| `DELETE <id>` | **D**elete a record (tombstone) |
| `TRUNCATE` | Remove **every** row (transaction-aware; tombstones + one header write) |
| `FIND <substr>` | Case-insensitive substring scan over `tag` + `content` |
| `RANGE <lo> <hi>` | List rows whose `value` is within `[lo, hi]` (inclusive) |
| `COUNT` | Number of live records |
| `BEGIN` / `COMMIT` / `ROLLBACK` | Multi-statement transactions |
| `TABLES` | List the logical table in this database + row count |
| `DATABASES` | Enumerate `*.dat` files in the current folder |
| `SCHEMA` | Print the record layout (§4) |
| `TYPES` | Print the supported column types (§10) |
| `BENCH [n]` | Insert *n* synthetic rows and report rows/second |
| `BACKUP <file>` | Snapshot this database (header + slot region) to `<file>` |
| `RESTORE <file>` | Reload this database from a `BACKUP` snapshot |
| `HELP` | ASCII-art help screen |
| `EXIT` / `QUIT` | Flush and quit |

- Integer parsing/formatting is hand-written (`atoi`/`itoa`); there is no CRT.
- `SELECT *`, `FIND` and `RANGE` render a bordered table with a `~` truncation
  marker when a field is wider than its column; `SELECT <id>` renders the full
  untruncated content plus both timestamps.
- `INSERT`/`UPDATE` enforce the `id ≥ 1` **CHECK** constraint (id `0` is
  reserved); duplicate keys are rejected on `INSERT`.
- `BACKUP`/`RESTORE` are refused while a transaction is open — `COMMIT` or
  `ROLLBACK` first. A second engine process opening a database already held by
  another is refused (exclusive **single-writer** lock).

---

## 10. Supported column types

asmdb stores **raw bits** in fixed cells; the application (or an agent via the
MCP server) chooses the interpretation. The `TYPES` command prints:

| Type | Bits | Domain | Column(s) |
|------|-----:|--------|-----------|
| `u64` | 64 | `0 .. 1.8e19` | `id` (key) |
| `i64` | 64 | `-9.2e18 .. 9.2e18` | `value` |
| `u32` / `i32` | 32 | narrowed integer | `value`, `clen` |
| `u16` / `i16` | 16 | narrowed integer | `value` |
| `u8` / `i8` | 8 | narrowed integer | `kind`, `value` |
| `bool` | 8 | `0` = false / `1` = true | `value` |
| `f64` | 64 | IEEE-754 double (raw bits) | `value` |
| `timestamp` | 64 | unix epoch ms | `created`, `updated` |
| `char[40]` | 320 | fixed ASCII text, ≤ 40 B | `tag` |
| `char[176]` | 1408 | fixed ASCII text, ≤ 176 B | `content` |

A row therefore carries one 64-bit numeric `value` cell (into which narrow ints,
`bool`, `f64` and timestamps all fit as raw bits), two automatic timestamps, a
short `tag`, and a free-text `content` field.

---

## 11. MCP server — CRUD interface

The `mcp/` package is a Node [Model Context Protocol](https://modelcontextprotocol.io)
server that exposes asmdb to any MCP client as a **generic CRUD store**. See
[`mcp/README.md`](../mcp/README.md) for setup and client registration.

```mermaid
flowchart LR
    CLIENT["MCP client<br/>(agent / IDE)"] -->|MCP stdio| SERVER["asmdb-mcp<br/>(Node)"]
    SERVER -->|stdin/stdout| ENGINE["asmdb.exe<br/>(engine)"]

    classDef client fill:#1f6feb,stroke:#0b3d91,color:#fff
    classDef server fill:#6e4aa0,stroke:#3b1e75,color:#fff
    classDef engine fill:#1a7f37,stroke:#0b4a20,color:#fff
    class CLIENT client
    class SERVER server
    class ENGINE engine
```

- The server keeps **one long-lived `asmdb.exe` process**, so the 1 GiB region
  is read once at startup and every tool call is an in-memory hash lookup plus a
  durable write. On client disconnect it shuts the engine down cleanly (no
  orphaned process).
- A row is addressed by a numeric **`id`** (used as-is) or a string **`key`**
  that the server hashes to asmdb's `u64` `id` with **64-bit FNV-1a**. The
  engine stays a pure id-keyed store — no secondary string index needed.
- Field mapping: `id`/`key → id`, `tag → tag` (namespace/category),
  `value → value` (numeric payload/score), `content → content` (free text);
  `created` / `updated` are automatic.

### Tools

| Tool | Arguments | Description |
|------|-----------|-------------|
| `db_insert` | `id`\|`key`, `content?`, `tag?`, `value?`, `upsert?` | insert a row; `upsert:true` overwrites instead of erroring |
| `db_update` | `id`\|`key`, `content?`, `tag?`, `value?` | overwrite an existing row (errors if absent) |
| `db_get`    | `id`\|`key` | fetch one row with value, tag, content, timestamps |
| `db_delete` | `id`\|`key` | remove a row |
| `db_find`   | `query` | case-insensitive substring search over tag + content |
| `db_list`   | — | return every live row |
| `db_count`  | — | number of live rows |

`db_insert` with `upsert:true` tries `INSERT`, and on an "already exists" reply
from the engine retries as `UPDATE`, so the same id/key overwrites in place and
bumps `updated`.

### Example use case — agent memory

The generic tools cover long-term **memory for an AI agent** directly: address
each memory by a string `key` (e.g. `user.timezone`), use `tag` as a namespace,
`value` as an optional score, and `content` as the remembered text; call
`db_insert` with `upsert:true` to store-or-overwrite and `db_get`/`db_find` to
recall. This is one workload the record shape suits — not the only one.

---

## 12. Roadmap

> **Scope of this roadmap.** Everything here is the **engine** — it stays
> **100% x86-64 assembly** (NASM, `-f bin`, no linker, no CRT). Turning asmdb
> into a hosted product (network protocol, multi-tenancy, billing, HA) is a
> *separate* concern and is tracked in **[`SAAS.md`](SAAS.md)**; that layer may
> use higher-level languages, but it never replaces the assembly core.

### Delivered ✅

| # | Milestone | Status |
|--:|-----------|--------|
| 1 | Toolchain + PE64 proof-of-concept | ✅ done |
| 2 | PE skeleton + Win32 + ASCII-art banner | ✅ done |
| 3 | REPL loop, tokenizer, `HELP`/`EXIT`, prompt | ✅ done |
| 4 | In-memory hash store: `INSERT`/`SELECT`/`UPDATE`/`DELETE`/`COUNT` | ✅ done |
| 5 | ASCII-art table + detail rendering, boxed status | ✅ done |
| 6 | Disk persistence (`<db>.dat`: header, load/save) | ✅ done |
| 7 | WAL + multi-statement `BEGIN`/`COMMIT`/`ROLLBACK` | ✅ done |
| 8 | Crash recovery (idempotent WAL redo at startup) | ✅ done |
| 9 | Tests + 100k-row benchmark vs SQLite + docs | ✅ done |
| 10 | 256-byte record schema (numeric value, timestamps, tag, content) | ✅ done |
| 11 | `FIND` substring search; `SCHEMA`/`TYPES`/`TABLES`/`DATABASES` | ✅ done |
| 12 | MCP server (7 generic CRUD tools) + language clients (Py/C#/C) | ✅ done |
| 13 | Fatal-I/O and out-of-memory guards (open failure aborts cleanly) | ✅ done |
| 14 | `RANGE` value access path; `id ≥ 1` CHECK constraint | ✅ done |
| 15 | `BACKUP`/`RESTORE` snapshot commands | ✅ done |
| 16 | Exclusive single-writer lock (concurrent open refused) | ✅ done |
| 17 | 1 GiB capacity (`2^22` slots) on **sparse** `.dat`; 2M-row benchmark vs SQLite | ✅ done |
| 18 | **Linux ELF64 port**: hand-built ELF header + raw-`syscall` backend behind the `os_*` layer; `TRUNCATE` command; CI runs the ELF natively on Ubuntu | ✅ done |

Everything below is **future work** — listed to set direction honestly, not to
imply it exists. The current engine is a single-table row store with one hash
index. Each phase is deliberately achievable *in assembly*.

### v1.0 — Harden the core (durability & safety)

The theme is "never lie about durability, never corrupt on crash."

| Item | What it adds | CRUD path helped |
|------|--------------|------------------|
| ~~**CRC32 on WAL frames**~~ | ✅ **done** — table-driven CRC-32 written and flushed with the commit marker; a damaged committed frame is refused instead of replayed (§6.2, §7.3) | durable C/U/D |
| ~~**Lazy (copy-on-write) `.dat` mapping**~~ | ✅ **done** — the store is mapped `FILE_MAP_COPY` / `MAP_PRIVATE` instead of committed and read. Open went from ~600 ms *regardless of size* to ~80 ms, and peak working set on a 1 M-row database from ~1 029 MB to ~5 MB. Durability is unchanged: a private mapping keeps writes out of the file (§6.1) | every command, and per-instance density |
| **Persisted dense status directory** ⭐ | **the new bottleneck.** With the store mapped lazily, a full scan (`SELECT *`, `FIND`, `RANGE`, `TRUNCATE`) faults the whole region: ~26 % slower on a full `FIND`, worse on a sparse table. Persisting one status byte per slot as a third region lets a scan stream ~4 MiB instead of touching 1 GiB. It must be *persisted*, not rebuilt at open — rebuilding means scanning the records, which is the very fault storm it exists to avoid. Needs a "clean shutdown" header flag so a stale directory is rebuilt after a crash instead of trusted | every full scan |
| **Incremental checkpoint** | a dirty-slot bitmap so `COMMIT` flushes only touched pages, not the whole 1 GiB region — the fix for the bulk-durable benchmark | durable bulk write |
| **Group commit** | coalesce concurrent `COMMIT`s into one `fsync` | high-rate durable writes |
| **Dynamic resize / rehash** | grow the table past load factor 0.75 instead of erroring; power-of-two doubling + incremental re-probe | all CRUD at scale |
| ~~**Short-write / error propagation**~~ | ✅ **done** — every read/write/flush return is checked; a failed durable write aborts instead of acknowledging (§7.5) | all persistence |

> **Measured, and one idea deliberately sequenced.** A dense one-byte-per-slot
> status mirror held only in RAM was prototyped before the mapping landed and
> **reverted**: back then a full scan was lost in the noise of the ~600 ms open,
> and the mirror's rebuild pass made every open ~100 ms *slower*. The mapping
> changed the economics — scans are now the dominant cost — but it also rules
> out the RAM-only version, because rebuilding the mirror at open would fault
> the whole file and give back the win. Hence the persisted variant above.

### v1.5 — Make reads fast at scale (indexing & scans)

The theme is "stop doing O(capacity) scans."

| Item | What it adds | CRUD path helped |
|------|--------------|------------------|
| **Secondary hash index on `tag`** | O(1) "all rows with tag = X" instead of a full scan in `FIND` | filtered Read |
| **Bitmap index on `kind`** | one bit per slot per kind; AND/OR predicates by streaming bitmaps | multi-predicate Read |
| **Dense status mirror** | one byte per slot in a contiguous array so a scan streams 4 MiB instead of touching 1 GiB of strided records. **Depends on the lazy mapping** (v1.0) — see the note there for why it does not pay off before | every full scan |
| **AVX2 / AVX-512 scan kernels** | vectorised `SELECT *`/`FIND`/`COUNT`: compare 32–64 slots per instruction over the dense mirror above, with a CPUID gate and a scalar fallback | analytical Read |
| **Range queries on `value`/`created`** | `SELECT WHERE value > n`, `created BETWEEN a AND b` over a sorted side-index | temporal recall |
| **Prefix / fuzzy `FIND`** | substring search accelerated with a SIMD `memchr`-style first-byte filter | search |

### v2.0 — Columnar & compression (analytics)

The theme is "touch only the bytes a query needs."

| Item | What it adds | CRUD path helped |
|------|--------------|------------------|
| **Column split** | store `value`, `created`, `updated` in contiguous arrays beside the row store | scan-heavy Read, `SUM`/`COUNT` |
| **Bit-packing to declared `TYPES` width** | a `u8`-typed `value` column shrinks 8× | Read scans, bulk load |
| **Frame-of-reference + delta** | encode timestamps as deltas from a base; ints as offsets from a min | storage, cache misses |
| **Dictionary-encoded `tag`** | replace repeated tags with small codes | storage, group-by |
| **RLE for `kind`/`status`** | run-length encode low-cardinality columns | scans |

### v3.0 — Concurrency, partitioning & portability

The theme is "more cores, more machines, more OSes — still assembly."

| Item | What it adds | CRUD path helped |
|------|--------------|------------------|
| **Partitioning** | shard slots into `<db>.partN.dat` by key hash; prune irrelevant partitions | all CRUD at scale |
| **Parallel scans** | one worker thread per partition (`CreateThread`), fan-in results | analytical Read, bulk ops |
| **MVCC + snapshot isolation** | versioned rows so readers never block writers; a lock-free ring for versions | concurrent workloads |
| **Overlapped / async I/O** | Windows IOCP for checkpoint writes off the commit path | durable throughput |
| **macOS port** | extend the `os_*` layer with a BSD `syscall`/`svc` backend and a Mach-O emitter (the **Linux ELF64 port is already shipped** — see Delivered #18) | portability |
| **Binary wire protocol** | a length-prefixed request/response codec in assembly, replacing line parsing — the substrate the [SaaS](SAAS.md) data plane speaks | networked access |

> **Honest benchmark note.** Durable *bulk* insert checkpoints by writing the
> entire preallocated region because open-addressed hashing scatters rows across
> the 1 GiB area — ~1 GiB flushed regardless of row count. It is the most disk-
> and page-cache-sensitive figure in the README table: it edges *ahead* of
> SQLite on warm best-of-3 runs yet can trail it on cold, fresh-file runs. The
> **incremental (dirty-slot) checkpoint** (v1.0) and **partitioning** (v3.0)
> items above are what will make it *consistently* fast; they are not yet
> implemented.

### Transactional-database principles — coverage

The classic **ACID** guarantees plus the operational pillars every real database
needs, scored against asmdb — ✅ delivered, ◐ partial, 🗺️ planned. This maps the
roadmap above onto the principles it satisfies, and marks which pillars belong to
the hosted [SaaS layer](SAAS.md) rather than the single-node engine.

| # | Principle | Status | Where / how |
|--:|-----------|:------:|-------------|
| 1 | **Atomicity** | ✅ | `BEGIN`/`COMMIT`/`ROLLBACK` + undo log (§7) |
| 2 | **Consistency** | ✅ | unique primary key, fixed-width typed columns (§4, §10), and `CHECK`-style domain validation (`id ≥ 1` reserved-key rule + bounded field lengths) enforced at write |
| 3 | **Isolation** | ✅ | serial (serializable) execution — a single writer holds the DB exclusively, so no dirty / non-repeatable / phantom reads are possible; MVCC for concurrent readers is a throughput optimization on the roadmap |
| 4 | **Durability** | ✅ | WAL + `FlushFileBuffers` (§6, §7); every durable write and flush is checked, and a failure aborts instead of acknowledging (§7.5) |
| 5 | **Crash recovery** | ✅ | idempotent WAL redo with commit marker **and CRC-32 per frame** (§6.2, §7.3); open-time header validation refuses a truncated/foreign/incompatible `.dat` instead of silently recreating it (§6.1) |
| 6 | **Concurrency control** | ✅ | exclusive database lock (single-writer): a second engine opening the same file is refused with a clear "locked" message; group commit / finer-grained locking → roadmap |
| 7 | **Indexing & access paths** | ✅ | O(1) primary hash index (§5) plus full-scan (`SELECT *`), substring (`FIND`) and value-range (`RANGE`) access paths; index-accelerated secondary columns → v1.5 |
| 8 | **Query & access interface** | ✅ | REPL grammar (§9), MCP CRUD tools (§11), Python/C#/C clients |
| 9 | **Backup & restore / PITR** | ✅ | in-engine `BACKUP`/`RESTORE` snapshot commands (§9), with the snapshot fully validated before any live data is overwritten (§7.5); WAL shipping + point-in-time recovery → [SaaS layer](SAAS.md) |
| 10 | **Security & observability** | 🗺️ | authz, encryption, audit, metrics → [SaaS layer](SAAS.md) (engine stays single-node) |

The engine now delivers **nine of the ten** principles single-node: the full
transactional core (1–5), single-writer concurrency control (6), a primary
index plus three secondary access paths (7), the query interface (8), and
in-engine backup/restore (9). Only **security & observability** (10) — and the
*scale-out* facets of concurrency (6) and PITR (9) — are deferred to the
[SaaS layer](SAAS.md). The engine stays 100% assembly throughout.

---

## 13. Source map

The binary is monolithic: `main.asm` carries the platform header (PE import
table, or the ELF header via `elf.inc` under `-dLINUX`) and `%include`s the
modules; code and data are concatenated into a single section.

```
src/
  asmdb.inc     ; shared constants, 256-byte record layout, capacity, hash consts
  main.asm      ; PE/ELF header, init, REPL loop, shutdown, %includes
  elf.inc       ; hand-built ELF64 header (Linux, -dLINUX only)
  os_win.inc    ; Windows backend for the os_* layer (kernel32 thunks, Win64 ABI)
  os_linux.inc  ; Linux backend for the os_* layer (raw syscalls, SysV -> Win64)
  console.inc   ; puts, put_u64/i64, buffered read_line (BOM-tolerant), ASCII art
  parse.inc     ; tokenizer, atoi/itoa, dispatch + all command handlers
  store.inc     ; hash-table CRUD (hash, find, insert, update, delete)
  db.inc        ; file open/create, 512-byte header, load/persist
  wal.inc       ; WAL staging, two-phase commit, checkpoint, crash recovery
  data.inc      ; strings, globals, buffers, kernel32 import table (Windows)
```

The store itself is **not** in the exe — it is the 1 GiB region **mapped
copy-on-write** from `<db>.dat`, so only the pages actually touched ever become
resident.

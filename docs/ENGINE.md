# asmdb — Engine Specification

> The precise technical reference for **asmdb**: a minimalist, transactional
> database written in **x86-64 assembly** (NASM, `-f bin`), with **no linker**,
> **no C runtime**, raw **Win32** calls, WAL-durable transactions, an ASCII-art
> REPL, and a **Model Context Protocol** server that exposes it as a generic
> CRUD store (durable **memory for AI agents** being one example use case).
>
> This document describes what the engine *actually does today*, byte for byte.
> For the high-level tour and benchmarks, see the [README](../README.md); for
> what is planned next, see [§12 Roadmap](#12-roadmap).

---

## Table of contents

1. [Design goals & constraints](#1-design-goals--constraints)
2. [Build toolchain & PE64 layout](#2-build-toolchain--pe64-layout)
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
| Linking | **None** — `nasm -f bin` emits the PE64 directly |
| Runtime | **No CRT** — raw **Win32** (`kernel32.dll`) only |
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

## 2. Build toolchain & PE64 layout

```
nasm -f bin -i src\ src\main.asm -o build\asmdb.exe
```

- **`-f bin`** emits a flat binary. asmdb hand-writes the entire PE image: the
  DOS stub, `IMAGE_FILE_HEADER`, `IMAGE_OPTIONAL_HEADER64`, the section table,
  and the import table. There is no linker and no import library.
- **RVA == file offset.** `SectionAlignment == FileAlignment == 0x200` (see
  `ALIGN` in `asmdb.inc`), so a symbol's virtual address equals its file
  offset. This is what makes a hand-written import table tractable — every
  thunk references its target by RVA, which is just its offset.
- **Image base** is `0x400000`; `RVA(x)` in the source is simply `x - IMAGEBASE`.
- Build/run helpers live in `build.ps1` (`-Run` launches the REPL).

The resulting binary is a **single self-contained ~18 KB PE64** with no external
dependency besides `kernel32.dll`. The 64 MiB record region is **not** in the
exe — it is obtained from `VirtualAlloc` at startup.

### kernel32 imports

The centralized import table in `data.inc` binds these functions (all called
via `[rel iat_*]` thunks):

```
GetStdHandle   ReadFile        WriteFile       CreateFileA
SetFilePointerEx  FlushFileBuffers  SetEndOfFile  CloseHandle
VirtualAlloc   ExitProcess     GetSystemTimeAsFileTime
QueryPerformanceCounter  QueryPerformanceFrequency
GetConsoleMode  SetConsoleMode  FindFirstFileA  FindClose
```

`GetSystemTimeAsFileTime` powers automatic timestamps (§8);
`QueryPerformanceCounter/Frequency` power the `BENCH` command; `FindFirstFileA`
enumerates `*.dat` for the `DATABASES` command; `GetConsoleMode/SetConsoleMode`
enable ANSI colour when stdout is a real console.

---

## 3. Calling convention & register discipline

- **External calls** use the Win64 ABI: integer args in `rcx, rdx, r8, r9`,
  return in `rax`, **32 bytes of shadow space** reserved by the caller,
  16-byte stack alignment at the call site. Every function establishes a
  `push rbp / mov rbp, rsp / sub rsp, N` frame that reserves shadow space for
  its callees.
- **Internal helpers** follow a lightweight private convention: arguments in
  `rcx, rdx, r8, r9` (documented per function), result in `rax`. During command
  dispatch and handlers, **`rsi` is the line cursor** — it walks the input line
  and is preserved across tokenizer calls.
- Callee-saved registers (`rbx, rsi, rdi, r12-r15`) are spilled to the local
  frame when a helper needs them, and restored on exit.
- `now_ms` and other Win32-calling helpers bump their frame to include the
  32-byte shadow area before the call.

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

- The store is a single array of **`CAPACITY = 262144`** slots (`2^18`),
  `256 B` each → a **64 MiB** contiguous region from `VirtualAlloc`.
- **Hash function** (Fibonacci / multiplicative):

  ```
  h = (id * 0x9E3779B97F4A7C15) >> CAP_SHIFT        ; CAP_SHIFT = 64 - 18 = 46
  ```

  A single `imul` gives a well-spread bucket in `[0, CAPACITY)`.
- **Collision resolution:** linear probing, `(h + i) mod CAPACITY`, which is
  cache-optimal because probes walk contiguous slots.
- **Deletion:** tombstone (`status = 2`) so probe chains stay intact; a later
  INSERT may reuse a tombstoned slot.
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
  +0    5   magic      "ASMDB"
  ...       version / rec_size fields
  +24   8   count      u64   live record count
  +32   48  table      char[48]  logical table name (NUL-padded)
  ...       reserved (padding to 512)
[ Slot region: CAPACITY * 256 B ]   ← direct image of the in-RAM hash table
```

The header is 512 bytes (`HDR_SIZE`); the slot region is a byte-for-byte image
of the live hash table, so load = `ReadFile` into the `VirtualAlloc` region and
persist = `WriteFile` of the touched slots plus the header. `count` is refreshed
in the header on every durable write. The logical table name is resolved from
(in priority order) a CLI argument, the header, or the DB base name.

### 6.2 `<db>.wal` — write-ahead log

The WAL is a **single staging frame** that mirrors the in-memory buffer
(`g_walbuf`) to disk:

```
+0    8              magic  'ASMWAL01'
+8    8              N      entry count
+16   8              count  live-row count to publish into the header on apply
+24   N * (8 + 256)  entries: { u64 slot index ; 256-byte after-image }
+..   8              marker 'COMMIT01'   (written and flushed LAST)
```

- Each entry is `UNDO_ENTRY = 8 + 256 = 264` bytes: a slot index followed by the
  **post-mutation image** of that slot, so replay is idempotent redo.
- A single entry format captures INSERT, UPDATE and DELETE alike (DELETE writes
  a slot whose `status = 2`).
- The `'COMMIT01'` marker is the atomicity point: it is written and flushed only
  after the entries are durable.

---

## 7. Transactions, durability & crash recovery

### 7.1 In-memory transaction model

`BEGIN` opens a transaction (`g_in_txn = 1`), resets the undo counter, and
snapshots the live `count`. While a transaction is open, every mutation:

1. is applied **in RAM only** (directly into the hash region), and
2. records an **undo entry** (slot index + *pre-image*) via `txn_capture`, so
   `ROLLBACK` can restore it. The undo log holds up to `UNDO_MAX = 4096`
   touched slots.

Mutations issued **outside** `BEGIN…COMMIT` are autocommitted — each is its own
implicit single-statement transaction that writes through to `<db>.dat`.

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

### 7.3 Crash recovery

`wal_recover` runs in `db_open`, after both files are open and *before* the
table is read in:

1. Read the WAL frame. If it is shorter than the 24-byte header, or the magic
   mismatches, or `N > UNDO_MAX`, or the `'COMMIT01'` marker is missing at
   `24 + N*264` → **discard** (truncate) the WAL. An incomplete transaction
   simply never existed.
2. Otherwise the frame is committed: **redo** every after-image into
   `<db>.dat`, publish the stored `count` into the header, flush, and truncate
   the WAL.

The result is **atomicity** (all-or-nothing per transaction), **durability**
(flush before acknowledging), and clean crash recovery with idempotent redo.

### 7.4 Rollback

`ROLLBACK` walks the undo log in reverse, copying each pre-image back into its
slot, restores the snapshotted `count`, truncates the WAL, and clears the
transaction flag. Nothing durable was written, so there is nothing to undo on
disk.

---

## 8. Timestamps

`created` and `updated` are set automatically by the engine, never by the
caller. `now_ms` computes unix epoch milliseconds:

```
GetSystemTimeAsFileTime(&ft)            ; 100-ns ticks since 1601-01-01
ms = ft / 10000 - 11644473600000        ; → unix epoch ms
```

`INSERT` sets both `created` and `updated` to `now_ms()`; `UPDATE` sets
`updated` only and preserves `created`. The detail view (`SELECT <id>`) prints
both as raw millisecond integers.

---

## 9. REPL command grammar

The dispatcher tokenizes on whitespace and matches the first token
case-insensitively. `tag` is a single token; `content` is *rest-of-line* (spaces
allowed).

| Command | Effect |
|---------|--------|
| `INSERT <id> <value> <tag> <content...>` | **C**reate a record (auto timestamps) |
| `SELECT <id>` | **R**ead one record → detail block (full content + timestamps) |
| `SELECT *` | Read all → 4-column ASCII table (`id \| tag \| value \| content`) |
| `UPDATE <id> <value> <tag> <content...>` | **U**pdate a record (bumps `updated`) |
| `DELETE <id>` | **D**elete a record (tombstone) |
| `FIND <substr>` | Case-insensitive substring scan over `tag` + `content` |
| `COUNT` | Number of live records |
| `BEGIN` / `COMMIT` / `ROLLBACK` | Multi-statement transactions |
| `TABLES` | List the logical table in this database + row count |
| `DATABASES` | Enumerate `*.dat` files in the current folder |
| `SCHEMA` | Print the record layout (§4) |
| `TYPES` | Print the supported column types (§10) |
| `BENCH [n]` | Insert *n* synthetic rows and report rows/second |
| `HELP` | ASCII-art help screen |
| `EXIT` / `QUIT` | Flush and quit |

- Integer parsing/formatting is hand-written (`atoi`/`itoa`); there is no CRT.
- `SELECT *` and `FIND` render a bordered table with a `~` truncation marker
  when a field is wider than its column; `SELECT <id>` renders the full
  untruncated content plus both timestamps.

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

```
MCP client (agent / IDE) ──MCP stdio──▶ asmdb-mcp (Node) ──stdin/stdout──▶ asmdb.exe
```

- The server keeps **one long-lived `asmdb.exe` process**, so the 64 MiB region
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

Everything below is **future work** — listed to set direction honestly, not to
imply it exists. The current engine is a single-table row store with one hash
index. Each phase is deliberately achievable *in assembly*.

### v1.0 — Harden the core (durability & safety)

The theme is "never lie about durability, never corrupt on crash."

| Item | What it adds | CRUD path helped |
|------|--------------|------------------|
| **CRC32 on WAL frames** | detect torn/garbled logs on recovery (SSE4.2 `crc32` instruction) | durable C/U/D |
| **Incremental checkpoint** | a dirty-slot bitmap so `COMMIT` flushes only touched pages, not the whole 64 MiB region — the fix for the bulk-durable benchmark | durable bulk write |
| **Group commit** | coalesce concurrent `COMMIT`s into one `fsync` | high-rate durable writes |
| **Dynamic resize / rehash** | grow the table past load factor 0.75 instead of erroring; power-of-two doubling + incremental re-probe | all CRUD at scale |
| **Short-write / error propagation** | check every `WriteFile`/`ReadFile` return, surface `[ERR] io` instead of silently continuing | all persistence |

### v1.5 — Make reads fast at scale (indexing & scans)

The theme is "stop doing O(capacity) scans."

| Item | What it adds | CRUD path helped |
|------|--------------|------------------|
| **Secondary hash index on `tag`** | O(1) "all rows with tag = X" instead of a full scan in `FIND` | filtered Read |
| **Bitmap index on `kind`** | one bit per slot per kind; AND/OR predicates by streaming bitmaps | multi-predicate Read |
| **AVX2 / AVX-512 scan kernels** | vectorised `SELECT *`/`FIND`/`COUNT`: compare 8–16 status bytes or `value` cells per instruction | analytical Read |
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
| **Linux/macOS port** | a thin syscall layer (`syscall` on Linux, `svc`/BSD on macOS) behind the same core; ELF/Mach-O emitters | portability |
| **Binary wire protocol** | a length-prefixed request/response codec in assembly, replacing line parsing — the substrate the [SaaS](SAAS.md) data plane speaks | networked access |

> **Honest benchmark note.** Durable *bulk* insert currently checkpoints by
> writing the entire preallocated region because open-addressed hashing scatters
> rows across the 64 MiB area. This is why the bulk-durable number trails SQLite
> slightly in the README table — the **incremental checkpoint** (v1.0) and
> **partitioning** (v3.0) items above are the fix, and are not yet implemented.

### Transactional-database principles — coverage

The classic **ACID** guarantees plus the operational pillars every real database
needs, scored against asmdb — ✅ delivered, ◐ partial, 🗺️ planned. This maps the
roadmap above onto the principles it satisfies, and marks which pillars belong to
the hosted [SaaS layer](SAAS.md) rather than the single-node engine.

| # | Principle | Status | Where / how |
|--:|-----------|:------:|-------------|
| 1 | **Atomicity** | ✅ | `BEGIN`/`COMMIT`/`ROLLBACK` + undo log (§7) |
| 2 | **Consistency** | ◐ | unique primary key, fixed-width types (§4, §10); `CHECK`-style constraints → roadmap |
| 3 | **Isolation** | ◐ | single-writer today; MVCC + snapshot isolation → v3.0 |
| 4 | **Durability** | ✅ | WAL + `FlushFileBuffers` (§6, §7) |
| 5 | **Crash recovery** | ✅ | idempotent WAL redo with commit marker (§7); CRC32 frames → v1.0 |
| 6 | **Concurrency control** | ◐ | single-writer per instance; group commit → v1.0, MVCC → v3.0 (SaaS runs one instance per DB) |
| 7 | **Indexing & access paths** | ◐ | O(1) primary hash (§5); secondary / bitmap / range indexes → v1.5 |
| 8 | **Query & access interface** | ✅ | REPL grammar (§9), MCP CRUD tools (§11), Python/C#/C clients |
| 9 | **Backup & restore / PITR** | ◐ | copy `.dat`/`.wal`; snapshots + WAL shipping + PITR → SaaS / roadmap |
| 10 | **Security & observability** | 🗺️ | authz, encryption, audit, metrics → [SaaS layer](SAAS.md) (engine stays single-node) |

The engine owns the **transactional core** (1, 4, 5, 8 delivered; 2, 3, 7
advancing across v1.0–v3.0 above). The **service pillars** (6 at scale, 9, 10)
are the job of `SAAS.md` — and the engine stays 100% assembly throughout.

---

## 13. Source map

The binary is monolithic: `main.asm` carries the PE header + centralized import
table and `%include`s the modules; code and data are concatenated into `.text`.

```
src/
  asmdb.inc     ; shared constants, 256-byte record layout, Win32 values
  main.asm      ; PE header, IAT, init, REPL loop, shutdown, %includes
  console.inc   ; puts, put_u64/i64, buffered read_line, put_field, ASCII art
  parse.inc     ; tokenizer, atoi/itoa, now_ms, dispatch + all command handlers
  store.inc     ; hash-table CRUD (hash, find, insert, update, delete)
  db.inc        ; file open/create, 512-byte header, load/persist
  wal.inc       ; WAL staging, two-phase commit, checkpoint, crash recovery
  data.inc      ; strings, globals, buffers, kernel32 import table
```

The store itself is **not** in the exe — it is the 64 MiB `VirtualAlloc` region
loaded from `<db>.dat` at startup.

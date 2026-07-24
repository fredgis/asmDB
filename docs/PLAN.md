# asmdb — Design Plan

> A minimalist, performance-oriented **transactional** database in **x86-64
> assembly**, with full CRUD and an **ASCII-art CLI**.

---

## 1. Goals & constraints

| Axis | Decision |
|------|----------|
| Architecture | x86-64 (AMD64) |
| Assembler | **NASM 3.02**, Intel syntax |
| Linking | **None** — `nasm -f bin` emits the PE64 directly |
| Runtime | **No CRT** — raw **Win32** calls (`kernel32.dll`) |
| Data model | **Fixed-size** records (64 B, cache-line aligned) |
| Index | **Open-addressing** hash table (the store IS the index) |
| Transactions | **WAL** (write-ahead log) → atomicity, durability, crash recovery |
| Interface | **REPL** over stdin/stdout, **ASCII-art** presentation |

### Non-goals (out of scope for v1)
- Full SQL / joins / secondary indexes.
- Multi-process concurrency, networking, replication.
- Non-integer keys (v1: `u64` primary key).
- Dynamic table resizing (fixed capacity, documented).

### Feasibility proof (already validated ✅)
`poc/hello.asm` → a **752-byte PE64**, no linker, no CRT, calling
`GetStdHandle`/`WriteFile`/`ExitProcess`. `src/main.asm` extends that base and
prints the ASCII-art banner (build: `1208 bytes`).

---

## 2. Build toolchain

```
nasm -f bin -i src\ src\main.asm -o build\asmdb.exe
```

- **`-f bin`**: flat binary output. We hand-craft the PE header ourselves
  (DOS stub, `IMAGE_FILE_HEADER`, `IMAGE_OPTIONAL_HEADER64`, section table,
  import table). No external dependency.
- **Alignment trick**: `SectionAlignment == FileAlignment == 0x200`, so
  **RVA == file offset**. This dramatically simplifies hand-writing the import
  table (thunks reference by RVA = offset).
- Script: `build.ps1` (`-Run` to launch, `-Poc` for the proof-of-concept).

---

## 3. Data model

### 3.1 Record (64 bytes — one cache line)

| Offset | Size | Field    | Description                              |
|-------:|-----:|----------|------------------------------------------|
| 0      | 8    | `id`     | primary key `u64`                         |
| 8      | 1    | `status` | 0=EMPTY, 1=OCCUPIED, 2=DELETED (tombstone)|
| 9      | 7    | `pad`    | reserved / alignment                      |
| 16     | 8    | `value`  | `i64` integer                             |
| 24     | 40   | `name`   | fixed ASCII string (`\0` padded)          |

Fixed size ⇒ O(1) `slot * 64` addressing, cache-friendly sequential scans.

### 3.2 Hash table (the store is the index)

- Array of `capacity` slots (`capacity` = power of two).
- **Hash**: `h = (id * 0x9E3779B97F4A7C15) >> (64 - log2(capacity))`
  (Fibonacci/multiplicative hashing → good spread, single `imul`).
- **Collision resolution**: linear probing (`(h + i) & (capacity-1)`),
  excellent cache behavior.
- **Deletion**: tombstone (`status=DELETED`) so probe chains stay intact;
  reusable by a later INSERT.
- Target load factor < 0.7; INSERT into a full table → explicit error
  (resizing is future work).

### 3.3 Memory

At startup: `VirtualAlloc(capacity * 64)`, load the data file into RAM. All
CRUD runs **in memory** (very fast); durability comes from the WAL + disk flush
(see §5).

---

## 4. On-disk file format

### 4.1 `asmdb.dat` — data

```
[ 512-byte header ]
  magic     "ASMDB\0\0\0"  (8 B)
  version   u32
  rec_size  u32   (= 64)
  capacity  u64   (slot count)
  count     u64   (live records)
  reserved  ...   (padding to 512)
[ Slot region: capacity * 64 B ]  ← direct image of the hash table
```

### 4.2 `asmdb.wal` — write-ahead log

Physical redo log, a sequence of framed records:

```
BEGIN  : { tag=1, txid=u64 }
WRITE  : { tag=2, txid=u64, slot=u64, record[64] }   ; post-image of the slot
COMMIT : { tag=3, txid=u64, crc32=u32 }
```

- We log the **full post-mutation slot image** (idempotent redo).
- A `WRITE` record captures INSERT, UPDATE and DELETE alike (DELETE writes a
  slot with `status=DELETED`).

---

## 5. Transactions, durability & recovery

### 5.1 Commit protocol (write-ahead)
1. `BEGIN` → allocate a `txid`, mark an open transaction in memory.
2. Each mutation: apply in RAM **and** append a `WRITE` to the WAL staging
   buffer; record an undo entry (pre-image) for rollback.
3. `COMMIT`:
   a. append `COMMIT{txid, crc}`;
   b. **`FlushFileBuffers(wal)`** → durability guaranteed on disk;
   c. apply the slots to `asmdb.dat` (write-through);
   d. `FlushFileBuffers(dat)`, then **checkpoint** (truncate the WAL).
4. `ROLLBACK` → discard the WAL staging buffer and **restore** touched slots
   from their pre-images.

The atomicity point is the flushed `COMMIT` write: a transaction without a
durable `COMMIT` does not exist after a crash.

### 5.2 Startup recovery
1. Load `asmdb.dat` into memory.
2. Replay `asmdb.wal`: **redo** only transactions whose `COMMIT` (valid CRC) is
   present; ignore any partial transaction.
3. Re-apply to `.dat`, flush, truncate the WAL.

⇒ **Atomicity** (all-or-nothing per transaction) + **Durability** (flush before
acknowledging) + clean crash recovery.

### 5.3 Autocommit
Mutations issued outside `BEGIN…COMMIT` are each their own implicit
transaction (implicit BEGIN + immediate COMMIT).

---

## 6. REPL interface (ASCII-art CLI)

### 6.1 Command grammar

| Command | CRUD effect |
|---------|-------------|
| `INSERT <id> <value> <name>` | **C**reate |
| `SELECT <id>` \| `SELECT *`   | **R**ead (single row / full scan) |
| `UPDATE <id> <value> <name>` | **U**pdate |
| `DELETE <id>`                | **D**elete |
| `BEGIN` / `COMMIT` / `ROLLBACK` | transactions |
| `COUNT`                      | number of live records |
| `HELP`                       | help screen (ASCII art) |
| `EXIT` / `QUIT`              | quit (flush + close) |

Parsing: whitespace tokenizer, hand-written `atoi`/`itoa`, dispatch on the
first token (case-insensitive).

### 6.2 ASCII-art presentation
- **Banner**: figlet-style "ASMDB" at launch (already in place).
- **`SELECT`** → bordered ASCII table:
  ```
  +--------+------------------------+------------+
  | id     | name                   | value      |
  +--------+------------------------+------------+
  | 1      | alice                  | 100        |
  +--------+------------------------+------------+
  ```
- **Boxed status**: `[ OK ] 1 row inserted`, `[ERR] key not found`.
- **Prompt**: `asmdb> `.
- **7-bit ASCII** charset (`+ - |`) for console compatibility.

---

## 7. Source layout (included into one `-f bin` binary)

The binary is monolithic: `main.asm` carries the PE header + the centralized
import table, and `%include`s the modules (code/data are concatenated into the
`.text` section). The store is **not** in the exe (allocated via `VirtualAlloc`).

```
src/
  asmdb.inc     ; shared constants, record layout, Win32 values
  main.asm      ; PE header, IAT, init, REPL loop, shutdown, %includes
  console.inc   ; puts, put_u64/i64, buffered read_line, ASCII-art helpers
  parse.inc     ; tokenizer, atoi/itoa, command dispatch
  store.inc     ; hash table CRUD (hash, find, insert, update, delete)
  db.inc        ; file open/create, header, load/persist
  wal.inc       ; WAL append, flush, checkpoint, recovery
  data.inc      ; strings, globals, import table
```

**Required kernel32 imports**: `GetStdHandle`, `ReadFile`, `WriteFile`,
`CreateFileA`, `SetFilePointerEx`, `FlushFileBuffers`, `SetEndOfFile`,
`CloseHandle`, `VirtualAlloc`, `ExitProcess`.

---

## 8. Roadmap (phases)

| # | Phase | Deliverable | Status |
|--:|-------|-------------|--------|
| 1 | Toolchain + PE64 PoC | `poc/hello.asm` runs | ✅ done |
| 2 | PE skeleton + Win32 + banner | `src/main.asm` prints ASCII art | ✅ done |
| 3 | REPL loop + parsing | `read_line`, tokenizer, `HELP`/`EXIT`, prompt | ⬜ |
| 4 | In-memory store (CRUD) | hash table + INSERT/SELECT/UPDATE/DELETE/COUNT | ⬜ |
| 5 | ASCII-art table rendering | bordered `SELECT` / `SELECT *`, boxed status | ⬜ |
| 6 | Disk persistence | `asmdb.dat`: create/open, header, load/save | ⬜ |
| 7 | WAL + transactions | `BEGIN`/`COMMIT`/`ROLLBACK`, append+flush | ⬜ |
| 8 | Crash recovery | replay WAL at startup | ⬜ |
| 9 | Tests + bench + docs | stdin scripts, crash/recovery test, benchmark | ⬜ |

---

## 9. Test strategy

- **Functional**: PowerShell scripts feeding commands via stdin and checking
  output (golden files) — `tests/`.
- **Crash/recovery**: start a transaction, kill the process before checkpoint,
  restart, verify expected state (committed replayed, uncommitted ignored).
- **Performance**: bulk INSERT/SELECT micro-benchmark (timed via PowerShell or
  `QueryPerformanceCounter`), reported as ops/s.

---

## 10. Risks & mitigations

| Risk | Mitigation |
|------|------------|
| Malformed PE header | RVA==offset trick; PoC validated; incremental builds |
| x64 calling convention (shadow space, 16-byte alignment) | Uniform `rbp` frame prologue reserving 32 B shadow + alignment |
| WAL corruption | CRC32 on `COMMIT`; strictly idempotent redo replay |
| Full table | Explicit `[ERR] table full`; resize is future work |
| Names > 40 B | Truncate + warn; field size documented |

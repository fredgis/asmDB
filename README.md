<div align="center">
  <img src="docs/assets/asmdb-hero.png" alt="asmdb — a transactional database in x86-64 assembly" width="100%">
</div>

<p align="center">
  <a href="#"><img src="https://img.shields.io/badge/assembler-NASM%203.x-6E4AA0" alt="assembler"></a>
  <a href="#"><img src="https://img.shields.io/badge/arch-x86--64-1f6feb" alt="arch"></a>
  <a href="#"><img src="https://img.shields.io/badge/build-nasm%20--f%20bin-0b3d91" alt="build"></a>
  <a href="#"><img src="https://img.shields.io/badge/runtime-Win32%20%2F%20no%20CRT-bf8700" alt="runtime"></a>
  <a href="#"><img src="https://img.shields.io/badge/binary-~14%20KB-1a7f37" alt="size"></a>
  <a href="#"><img src="https://img.shields.io/badge/dependencies-0-2da44e" alt="deps"></a>
</p>

**asmdb** is a tiny, transactional key/value database engine written from
scratch in x86-64 assembly. **No linker, no C runtime, no libraries** — NASM
emits the Windows PE executable directly (`nasm -f bin`) and the program calls
`kernel32.dll` through a hand-built import table. Yet it is genuinely durable:
every statement is flushed to disk, `BEGIN`/`COMMIT`/`ROLLBACK` are real, and a
write-ahead log makes crash recovery atomic.

```text
asmdb> INSERT 1001 1299 Contoso_Ltd
[ OK ] 1 row inserted
asmdb> SELECT *
+------------+------------------------+----------------+
| id         | name                   | value          |
+------------+------------------------+----------------+
| 1001       | Contoso_Ltd            | 1299           |
+------------+------------------------+----------------+
```

---

## Why it's interesting

- **Zero dependencies** — assembled by NASM alone. No linker, no CRT, no DLL but `kernel32`.
- **One cache line per row** — fixed 64-byte records in an open-addressing hash
  table; the record array *is* the index. Lookups are Fibonacci hash + linear probe.
- **Durable by default** — autocommit flushes every mutation (`FlushFileBuffers`).
- **Real transactions** — `BEGIN` / `COMMIT` / `ROLLBACK` backed by an undo log.
- **Crash-safe** — a WAL with a commit marker is replayed or discarded atomically on startup.
- **A real CLI** — colored banner, sectioned `HELP`, catalog commands, boxed result tables.

## Quickstart

Requires Windows x64 and NASM 3.x (`winget install --id NASM.NASM -e`).

```powershell
.\build.ps1                 # -> build\asmdb.exe
.\build.ps1 -Run            # build, then launch the REPL
.\build\asmdb.exe SalesDB SalesTransactions
```

The first argument names the database (`<name>.dat` + `<name>.wal`); the
optional second argument names the table (stored in the file header).

Load the bundled sample — ten rows in one atomic transaction:

```powershell
.\examples\seed-salesdb.ps1 -Fresh
```

## Commands

| Command | Description |
|---|---|
| `INSERT <id> <value> <name>` | add a new row |
| `SELECT <id>` · `SELECT *` | show one row / list all rows |
| `UPDATE <id> <value> <name>` | modify an existing row |
| `DELETE <id>` | remove a row by key |
| `COUNT` | number of live rows |
| `BEGIN` · `COMMIT` · `ROLLBACK` | transaction control |
| `TABLES` | the table held in this database |
| `DATABASES` | list `*.dat` databases in the current folder |
| `SCHEMA` | show the record layout |
| `TYPES` | supported column types |
| `HELP` | command reference |
| `EXIT` · `QUIT` | leave asmdb |

## Data model & supported types

Every row is a **fixed 64-byte record** — no varints, no BLOBs, no schema
changes. That constraint is what keeps the engine small and predictable.

| Offset | Size | Field | Type | Notes |
|-------:|-----:|-------|------|-------|
| `0`  | 8  | `id`     | `u64`      | primary key |
| `8`  | 1  | `status` | `u8`       | `0` empty · `1` live · `2` deleted (tombstone) |
| `16` | 8  | `value`  | `i64`      | signed payload |
| `24` | 40 | `name`   | `char[40]` | ASCII, NUL-padded |

One `.dat` file is one database holding one logical table; its name lives in the
512-byte header (magic `ASMDB`, version, capacity, live count, table name).

## How it works

```mermaid
flowchart LR
    IN([stdin]) --> REPL[REPL + dispatch]
    REPL --> CRUD[CRUD handlers]
    CRUD --> HASH[hash table<br/>64-byte records in RAM]
    CRUD -->|autocommit / COMMIT| DAT[(asmdb.dat)]
    CRUD -->|transaction| WAL[(write-ahead log)]
    WAL -. checkpoint .-> DAT
    CRUD --> OUT([ASCII tables → stdout])

    classDef a fill:#1f6feb,stroke:#0b3d91,color:#fff
    classDef b fill:#1a7f37,stroke:#0b4a20,color:#fff
    classDef c fill:#6e4aa0,stroke:#3b1e75,color:#fff
    class REPL,CRUD a
    class HASH,DAT b
    class WAL c
```

The data path is a straight line: `stdin` → REPL → command dispatch → CRUD
handler → the in-RAM hash table, with every durable change flowing to the `.dat`
file (and, inside a transaction, through the write-ahead log first). Colored
ASCII tables go back out on `stdout`. The details — hashing, the calling
convention, and exactly how transactions stay durable — are in
[Inside the engine](#inside-the-engine) below.

## Performance

Inserting **20,000 rows**, best of 3 runs. Process-spawn and database-open cost
is measured separately and subtracted, so these figures reflect the engine's
insert path rather than shell overhead.

| Workload | Durability | Throughput | Latency |
|---|---|--:|--:|
| **Autocommit** — one transaction per row | `FlushFileBuffers` **per row** | **≈ 790 rows/s** | ≈ 1,270 µs/row |
| **Transaction** — batches of 4,000 rows | `FlushFileBuffers` **per commit** | **≈ 74,000 rows/s** | ≈ 13.5 µs/row |

Wrapping inserts in a single `BEGIN … COMMIT` is roughly **90× faster** than
durable per-row autocommit. The costly part is the disk flush, not the work:
autocommit fsyncs after *every* row, while a transaction applies all rows in RAM
and fsyncs **once** at commit.

<sub>Measured on an Intel Core Ultra 7 268V · NVMe SSD · Windows 11 · single-threaded.
Throughput is disk- and machine-dependent — reproduce it yourself:</sub>

```powershell
.\examples\bench.ps1                       # 20,000 rows, best of 3
.\examples\bench.ps1 -Rows 40000 -Runs 5   # heavier run
```

## Inside the engine

How ~14 KB of assembly becomes a durable database.

### The executable — no linker, no CRT

NASM emits the Windows PE directly (`nasm -f bin`); there is no linker step. The
trick is alignment: with `SectionAlignment == FileAlignment == 0x200`, every RVA
equals its offset in the file, so the import table can be laid out by hand — a
small array of thunks pointing at hint/name entries that Windows binds to
`kernel32.dll` at load time. Code, data and imports share a single RWX section;
the 4 MB record store is `VirtualAlloc`'d at runtime, which is why the binary
stays tiny.

### The record store — one cache line per row

Each row is a fixed **64-byte record** (exactly one cache line), and the records
live in an open-addressing hash table where the record array *is* the index —
there is no separate structure to keep in sync. The slot for a key is a
Fibonacci hash: multiply by the 64-bit golden-ratio constant and keep the top
bits.

```asm
; store_hash(rcx = id) -> rax = slot 0..65535
mov  rax, rcx
mov  rdx, 0x9E3779B97F4A7C15   ; 2^64 / golden ratio
imul rax, rdx                  ; scramble the key across the whole table
shr  rax, 48                   ; keep the top 16 bits (log2 of 65,536)
```

Collisions are resolved by linear probing (`slot = (slot + 1) & (CAPACITY-1)`),
and a deleted row is marked with a **tombstone** (`status = 2`) instead of being
cleared, so probe chains that once ran through it still terminate correctly.

### Calling convention

Every routine follows one shape: an `rbp` frame, at least 32 bytes of shadow
space, and `rsp` kept 16-byte aligned before each `kernel32` call — the Win64
ABI, applied uniformly so the code reads the same everywhere. During parsing,
`rsi` is the cursor walking the input line one byte at a time.

### Transactions — undo log + write-ahead log

Two logs do all the work. An **undo log** makes `ROLLBACK` possible; a
**write-ahead log (WAL)** makes `COMMIT` durable and crash-safe.

- **`BEGIN`** snapshots the live row count and clears the undo log.
- **Each mutation in a transaction** is applied to the RAM table immediately, and
  the *previous* 64-byte image of the touched slot is appended to the undo log.
  The `.dat` file is **not** written yet.
- **`ROLLBACK`** walks the undo log in reverse, restoring each saved image, then
  drops back to the snapshot count. Disk was never touched, so there is nothing
  to reverse on disk.
- **`COMMIT`** is two-phase, and the *order* is what guarantees durability:

  1. stage every *after*-image into the WAL buffer, write it to `<db>.wal`, and
     `FlushFileBuffers`;
  2. append an 8-byte `COMMIT` marker and flush **again** — after this flush the
     transaction is durable even if the machine dies a microsecond later;
  3. apply the after-images to `<db>.dat` and flush;
  4. truncate the WAL.

The marker in step 2 is the atomic switch: it is written *after* the data is
already safe in the log, so a log either has a marker (the transaction happened)
or it does not (it did not).

### Crash recovery

On startup, before the table is loaded, asmdb inspects the WAL. A log with a
valid magic **and** a commit marker is replayed into the `.dat`; a torn or
marker-less log is discarded. Replay is **idempotent** — each WAL entry is an
absolute write to a slot index, so applying an already-applied log changes
nothing. That is the classic redo-logging invariant, in a few hundred bytes of
assembly.

See [`docs/PLAN.md`](docs/PLAN.md) for the full design and roadmap.

## Connect from your app (Python · C# · C)

There is **no driver or network protocol** — asmdb is a stdin/stdout REPL. To use
it from another language you **spawn the process and pipe commands**; colors are
disabled automatically when the output is redirected, so you get clean ASCII back.

```python
from asmdb_client import Asmdb
db = Asmdb(r".\build\asmdb.exe", "SalesDB", "SalesTransactions")
db.run("BEGIN", "INSERT 1 500 alice", "COMMIT")
print(db.select_all())     # [{'id': 1, 'name': 'alice', 'value': 500}]
```

Ready-to-run examples live in [`clients/`](clients/) (Python, C#, C), along with
notes on adding a proper `--json` batch mode or a TCP server for a real driver.

## Project layout

```
asmdb/
  src/          main.asm + .inc modules (console, parse, store, db, wal, data)
  clients/      stdio client examples: Python, C#, C
  examples/     seed-salesdb.ps1 sample loader, bench.ps1 throughput test
  tests/        smoke.ps1 + make_wal.py crash-recovery fixture
  docs/         PLAN.md design notes, assets/ (hero image + generator)
  poc/          minimal 752-byte PE64 proof-of-concept
  build.ps1     locates NASM and assembles from src\
```

## License

MIT — see [`LICENSE`](LICENSE).

<div align="center">
  <img src="docs/assets/asmdb-logo.png" alt="asmdb logo" width="150">

  <h1>asmdb</h1>

  <p>
    <strong>A transactional CRUD database engine, hand-written in x86-64 assembly —<br>
    tuned for agent memory, with a Model Context Protocol server.</strong><br>
    No linker. No C runtime. No dependencies. ~18 KB. And it is genuinely fast.
  </p>

  <img src="docs/assets/asmdb-banner.png" alt="asmdb — a transactional database engine in x86-64 assembly" width="100%">

  <p>
    <a href="#"><img src="https://img.shields.io/badge/assembler-NASM%203.x-6E4AA0" alt="assembler"></a>
    <a href="#"><img src="https://img.shields.io/badge/arch-x86--64-1f6feb" alt="arch"></a>
    <a href="#"><img src="https://img.shields.io/badge/build-nasm%20--f%20bin-0b3d91" alt="build"></a>
    <a href="#"><img src="https://img.shields.io/badge/runtime-Win32%20%2F%20no%20CRT-bf8700" alt="runtime"></a>
    <a href="#"><img src="https://img.shields.io/badge/binary-~18%20KB-1a7f37" alt="size"></a>
    <a href="#"><img src="https://img.shields.io/badge/MCP-agent%20memory-6e4aa0" alt="mcp"></a>
    <a href="#"><img src="https://img.shields.io/badge/dependencies-0-2da44e" alt="deps"></a>
  </p>
</div>

---

**asmdb** is a tiny, transactional database engine written from scratch in
x86-64 assembly. NASM emits the Windows PE executable directly (`nasm -f bin`) —
there is **no linker, no C runtime, no libraries** — and the program talks to
`kernel32.dll` through a hand-built import table. Yet it is a real database:
every statement is flushed to disk, `BEGIN`/`COMMIT`/`ROLLBACK` are real
transactions, and a write-ahead log makes crash recovery atomic.

Its 256-byte record is tuned for **AI-agent memory** — a numeric score,
automatic created/updated timestamps, a short `tag`, and a free-text `content`
field — and a bundled **[MCP server](mcp/)** exposes it to any agent as durable
long-term memory.

```text
asmdb> INSERT 1001 5 project asmdb is a database engine written in x86-64 assembly
[ OK ] 1 row inserted
asmdb> SELECT *
+----------+------------------+------------+------------------------------------------+
| id       | tag              | value      | content                                  |
+----------+------------------+------------+------------------------------------------+
| 1001     | project          | 5          | asmdb is a database engine written in ~  |
+----------+------------------+------------+------------------------------------------+
asmdb> FIND assembly
  1 match
```

Because the engine does one thing — fixed-shape rows in a single hash-indexed
table — it does that one thing at speeds a general-purpose SQL database cannot
touch: **~25 million inserts/second** in RAM (measured below, and reproducible).
That is the whole point of writing a database in assembly.

## Table of contents

- [Why it's interesting](#why-its-interesting)
- [Quickstart](#quickstart)
- [Commands](#commands)
- [Data model & supported types](#data-model--supported-types)
- [Agent memory & the MCP server](#agent-memory--the-mcp-server)
- [How asmdb works](#how-asmdb-works) — the 60-second version, then a deep dive
- [On-disk format: `.dat` and `.wal`](#on-disk-format-dat-and-wal)
- [Performance](#performance) — benchmarks vs SQLite
- [How a modern database goes faster](#how-a-modern-database-goes-faster)
- [Connect from your app](#connect-from-your-app-python--c--c)
- [Engine specification](#engine-specification)
- [Roadmap & SaaS plan](#roadmap--saas-plan)
- [Project layout](#project-layout)

## Why it's interesting

- **Zero dependencies** — assembled by NASM alone. No linker, no CRT, no DLL but `kernel32`.
- **Four cache lines per row** — fixed 256-byte records in an open-addressing hash
  table; the record array *is* the index. Lookups are Fibonacci hash + linear probe.
- **Built for agent memory** — a score, auto `created`/`updated` timestamps, a
  `tag` namespace and free-text `content`, plus a `FIND` substring search.
- **MCP server included** — [`mcp/`](mcp/) turns asmdb into durable memory for an
  AI agent (store / recall / search / list / delete).
- **Durable by default** — autocommit flushes every mutation (`FlushFileBuffers`).
- **Real transactions** — `BEGIN` / `COMMIT` / `ROLLBACK` backed by an undo log.
- **Crash-safe** — a WAL with a commit marker is replayed or discarded atomically on startup.
- **Genuinely fast** — a built-in `BENCH` command measures the engine directly (see [Performance](#performance)).
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
| `INSERT <id> <value> <tag> <content...>` | add a new row (auto `created`/`updated`) |
| `SELECT <id>` | show one row as a detail block (full content + timestamps) |
| `SELECT *` | list all rows as a 4-column table |
| `UPDATE <id> <value> <tag> <content...>` | modify an existing row (bumps `updated`) |
| `DELETE <id>` | remove a row by key |
| `FIND <substr>` | case-insensitive substring search over `tag` + `content` |
| `COUNT` | number of live rows |
| `BEGIN` · `COMMIT` · `ROLLBACK` | transaction control |
| `BENCH <n>` | insert *n* synthetic rows and report engine rows/sec |
| `TABLES` | the table held in this database |
| `DATABASES` | list `*.dat` databases in the current folder |
| `SCHEMA` | show the record layout |
| `TYPES` | supported column types |
| `HELP` | command reference |
| `EXIT` · `QUIT` | leave asmdb |

Here `tag` is a single token; `content` is the rest of the line (spaces allowed).

## Data model & supported types

Every row is a **fixed 256-byte record** — exactly four CPU cache lines. That
single constraint is what keeps the engine small, predictable, and fast, and the
fields are shaped for **agent memory**: a numeric score, two automatic
timestamps, a short category `tag`, and a free-text `content` field. The physical
layout never changes:

| Offset | Size | Field | Type | Notes |
|-------:|-----:|-------|------|-------|
| `0`  | 8   | `id`      | `u64`       | primary key |
| `8`  | 1   | `status`  | `u8`        | `0` empty · `1` live · `2` deleted (tombstone) |
| `9`  | 1   | `kind`    | `u8`        | memory-kind enum (reserved, default `0`) |
| `12` | 4   | `clen`    | `u32`       | content byte length |
| `16` | 8   | `created` | `i64`       | creation time, unix epoch ms (auto) |
| `24` | 8   | `updated` | `i64`       | last-update time, unix epoch ms (auto) |
| `32` | 8   | `value`   | `i64`       | numeric score / payload |
| `40` | 40  | `tag`     | `char[40]`  | category / namespace, NUL-padded |
| `80` | 176 | `content` | `char[176]` | free text, NUL-padded |

On top of that raw layout, `TYPES` advertises a catalog of **logical types**.
Narrow integers, booleans and floats all ride inside the 64-bit `value` cell —
asmdb stores the raw bits and your application (or an agent via the MCP server)
chooses the interpretation:

| Type | Bits | Domain | Column(s) |
|------|-----:|--------|-----------|
| `u64`         | 64   | `0 .. 1.8e19`              | `id` (key) |
| `i64`         | 64   | `-9.2e18 .. 9.2e18`        | `value` |
| `u32` / `i32` | 32   | narrowed integer           | `value`, `clen` |
| `u16` / `i16` | 16   | narrowed integer           | `value` |
| `u8`  / `i8`  | 8    | narrowed integer           | `kind`, `value` |
| `bool`        | 8    | `0 = false` / `1 = true`   | `value` |
| `f64`         | 64   | IEEE-754 double (bits)     | `value` |
| `timestamp`   | 64   | unix epoch milliseconds    | `created`, `updated` |
| `char[40]`    | 320  | fixed ASCII text, ≤ 40 B   | `tag` |
| `char[176]`   | 1408 | fixed ASCII text, ≤ 176 B  | `content` |

One `.dat` file is one database holding one logical table; its name lives in the
512-byte header. See [On-disk format](#on-disk-format-dat-and-wal) for the exact bytes.

## Agent memory & the MCP server

asmdb ships with a Node [Model Context Protocol](https://modelcontextprotocol.io)
server in [`mcp/`](mcp/) that turns the engine into **durable long-term memory
for an AI agent**. It keeps one long-lived `asmdb.exe` process (the 64 MiB region
is read once), and exposes five tools:

| Tool | Arguments | Description |
|------|-----------|-------------|
| `memory_store`  | `key`, `content`, `tag?`, `value?` | insert or overwrite a memory (upsert on the same key) |
| `memory_recall` | `key` | fetch one memory with content, tag, value, timestamps |
| `memory_search` | `query` | case-insensitive substring search over tag + content |
| `memory_list`   | — | return every stored memory |
| `memory_delete` | `key` | remove a memory by key |

An agent addresses each memory by a free-text `key`, which the server hashes to
asmdb's `u64` primary id with 64-bit FNV-1a — so the engine stays a pure id-keyed
store with no secondary index. `tag` becomes a namespace, `value` an optional
score, `content` the remembered text, and `created`/`updated` are automatic.

```bash
cd mcp && npm install && npm test      # end-to-end test against a scratch DB
```

See [`mcp/README.md`](mcp/README.md) for client registration (Claude / VS Code /
Copilot) and configuration.

## How asmdb works

### The 60-second version

Picture a huge coat-check with **262,144 numbered hooks**. To store a row, asmdb
runs the row's `id` through a scrambling function that turns it into a hook
number, and hangs the 256-byte row there. To find it again, it runs the *same*
function and walks straight to that hook — no scanning, no index to maintain,
because **the array of hooks *is* the index**. If two rows want the same hook,
the second one takes the next free hook along (a "linear probe").

That whole coat-check lives in memory, so reads and writes are essentially free.
Durability is a separate job: when you change data, asmdb also writes it to a
file and asks Windows to physically flush it to the disk. Inside a transaction it
is cleverer — it stages all the changes in a **write-ahead log**, flushes that
once, stamps it "committed", and only then updates the main file. If the power
dies mid-way, startup either finds a fully-committed log (and replays it) or an
incomplete one (and throws it away). You never see a half-written transaction.

Now the diagram, then the deep dive.

```mermaid
flowchart LR
    IN([stdin]) --> REPL[REPL + dispatch]
    REPL --> CRUD[CRUD handlers]
    CRUD --> HASH[hash table<br/>256-byte records in RAM]
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

### The deep dive

How ~18 KB of assembly becomes a durable database.

#### The executable — no linker, no CRT

NASM emits the Windows PE directly (`nasm -f bin`); there is no linker step. The
trick is alignment: with `SectionAlignment == FileAlignment == 0x200`, every RVA
equals its offset in the file, so the import table can be laid out by hand — a
small array of thunks pointing at hint/name entries that Windows binds to
`kernel32.dll` at load time. Code, data and imports share a single section; the
64 MiB record store is `VirtualAlloc`'d at runtime, which is why the binary stays
~18 KB on disk.

#### The record store — four cache lines per row

Each row is a fixed **256-byte record** (exactly four cache lines), and the
records live in an open-addressing hash table of **262,144 slots** where the
record array *is* the index — there is no separate structure to keep in sync. The
slot for a key is a Fibonacci hash: multiply by the 64-bit golden-ratio constant
and keep the top bits.

```asm
; store_hash(rcx = id) -> rax = slot 0 .. 262143
mov  rax, rcx
mov  rdx, 0x9E3779B97F4A7C15   ; 2^64 / golden ratio
imul rax, rdx                  ; scramble the key across the whole table
shr  rax, 46                   ; keep the top 18 bits (log2 of 262,144)
```

Collisions are resolved by linear probing (`slot = (slot + 1) & (CAPACITY-1)`),
and a deleted row is marked with a **tombstone** (`status = 2`) instead of being
cleared, so probe chains that once ran through it still terminate correctly.
Multiplying by the golden ratio scatters even sequential keys across the whole
table, which keeps probe chains short and lookups close to O(1).

#### Calling convention

Every routine follows one shape: an `rbp` frame, at least 32 bytes of shadow
space, and `rsp` kept 16-byte aligned before each `kernel32` call — the Win64
ABI, applied uniformly so the code reads the same everywhere. During parsing,
`rsi` is the cursor walking the input line one byte at a time.

#### Transactions — undo log + write-ahead log

Two logs do all the work. An **undo log** makes `ROLLBACK` possible; a
**write-ahead log (WAL)** makes `COMMIT` durable and crash-safe.

- **`BEGIN`** snapshots the live row count and clears the undo log.
- **Each mutation in a transaction** is applied to the RAM table immediately, and
  the *previous* 256-byte image of the touched slot is appended to the undo log.
  The `.dat` file is **not** written yet.
- **`ROLLBACK`** walks the undo log in reverse, restoring each saved image, then
  drops back to the snapshot count. Disk was never touched, so there is nothing
  to reverse on disk.
- **`COMMIT`** is two-phase, and the *order* is what guarantees durability:

  1. stage every *after*-image into the WAL buffer, write it to `<db>.wal`, and
     `FlushFileBuffers`;
  2. append an 8-byte `COMMIT01` marker and flush **again** — after this flush the
     transaction is durable even if the machine dies a microsecond later;
  3. apply the after-images to `<db>.dat` and flush;
  4. truncate the WAL.

The marker in step 2 is the atomic switch: it is written *after* the data is
already safe in the log, so a log either has a marker (the transaction happened)
or it does not (it did not).

#### Crash recovery

On startup, before the table is loaded, asmdb inspects the WAL. A log with a
valid magic **and** a commit marker is replayed into the `.dat`; a torn or
marker-less log is discarded. Replay is **idempotent** — each WAL entry is an
absolute write to a slot index, so applying an already-applied log changes
nothing. That is the classic redo-logging invariant, in a few hundred bytes of
assembly.

## On-disk format: `.dat` and `.wal`

asmdb persists a database as **two files** next to each other: `<name>.dat` holds
the data, `<name>.wal` is the transaction log (present only while a commit is in
flight, or after a crash).

### `<name>.dat` — the data file

A **512-byte header** followed by the fixed slot array. Every RVA-style offset is
exact; there is no padding surprise because the record size never changes.

```
offset  size  field        value / meaning
------  ----  -----------  ---------------------------------------------
   0      8   magic        "ASMDB\0\0\0"
   8      4   version      1
  12      4   record_size  256
  16      8   capacity     262144
  24      8   live_count   number of live rows (rewritten on each flush)
  32     48   table_name   ASCII, NUL-padded
  80    432   reserved     zero-filled to 512
 512   64 MiB slot array   capacity × 256-byte records
```

Slot *i* lives at file offset `512 + i * 256`. A record is
`u64 id · u8 status · u8 kind · u32 clen · i64 created · i64 updated · i64 value
· char[40] tag · char[176] content`; `status` is `0` empty, `1` live, `2`
tombstone. Because the on-disk slot layout mirrors the in-RAM table exactly,
loading a database is a single `ReadFile` of the whole slot region — no parsing,
no per-row deserialization.

> Note: `db_open` validates only the 5-byte magic, not the version or capacity,
> so a database created by an older build still opens after the capacity was
> raised. The header is authoritative for `live_count` and `table_name`.

### `<name>.wal` — the write-ahead log

Written only during `COMMIT` and read only during recovery. Layout, in the exact
order it is flushed:

```
offset        size        field    meaning
------------  ----------  -------  --------------------------------------
   0            8         magic    "ASMWAL01"
   8            8         N        number of staged entries
  16            8         count    live_count to stamp into the header
  24         N × 264      entries  N × { u64 slot_index ; 256-byte after-image }
24 + N×264      8         marker   "COMMIT01"  (written & flushed LAST)
```

The marker is the commit point. Recovery reads the log, checks the magic, bounds
`N`, and looks for `COMMIT01` at the computed offset. If everything lines up it
replays each entry as an absolute write to `512 + slot_index × 256`; otherwise it
discards the log. Since every entry is an absolute slot write, replaying a log
twice is harmless — recovery is idempotent.

## Performance

asmdb ships with a `BENCH <n>` command that times the engine **from the inside**
using `QueryPerformanceCounter`, with no text protocol and no shell in the way.
The harness below runs `BENCH`, the two end-to-end stdio modes, and — for an
honest baseline — the **same workloads on SQLite** (via Python's in-process
`sqlite3`, i.e. the C API with no protocol overhead, which is generous to SQLite).

```powershell
.\examples\bench.ps1                         # 100,000 rows, best of 3, + SQLite compare
.\examples\bench.ps1 -Rows 100000 -NoCompare # asmdb only
```

### asmdb vs SQLite — 100,000 rows

Records are **256 bytes** and the store is a preallocated **64 MiB** region.

| Workload | asmdb | SQLite 3.49.1 | ratio |
|---|--:|--:|--:|
| **Engine insert** — in-RAM, one transaction | **≈ 25,425,883** rows/s | 1,807,704 rows/s | **≈ 14.1× faster** |
| **Durable bulk load** — one checkpoint + `fsync` | ≈ 1,351,351 rows/s | 1,488,082 rows/s | ≈ 0.9× (slightly slower) |
| **Durable per-row** — one `fsync` per row | **≈ 2,067** rows/s | 276 rows/s | **≈ 7.5× faster** |

A fourth figure, not in the table because SQLite has no equivalent, is the
**transaction throughput over the stdio protocol** — the realistic
"over-the-wire" number a client sees, including command parsing and per-row acks:
**≈ 23,090 rows/s** (100k rows in `BEGIN…COMMIT` batches).

The story the numbers tell: the disk flush dominates durability. Autocommit
`fsync`s after *every* row (~2,067/s); a transaction applies every row in RAM and
`fsync`s **once** (millions/s). Wrapping inserts in `BEGIN … COMMIT` is the single
biggest speed lever.

### Why asmdb wins — and the honest caveats

asmdb is faster on **in-RAM inserts (≈ 14×)** and **per-row durability (≈ 7.5×)**
because **it does far less**: a fixed 256-byte schema, a single table, no SQL
parser, no query planner, no secondary indexes, no MVCC, no concurrency control.
SQLite is a full relational engine doing all of that. So this is *not* "assembly
beats C" — it is **a specialized key/value store beating a general-purpose SQL
database at the narrow thing it was built for.**

The **durable bulk-load row is honestly ≈ 0.9× — slightly *slower* than SQLite**.
The reason is a real, documented trade-off: because the open-addressed hash
scatters rows across the whole 64 MiB region, the bulk checkpoint currently
writes the *entire* preallocated region rather than just the dirty rows. At 256
bytes/row that is more bytes to flush than SQLite's page cache commits. The fix —
an incremental (dirty-page) checkpoint and partitioned files — is on the
[roadmap](#how-a-modern-database-goes-faster), not yet implemented, so the number
is reported as-is rather than hidden.

<sub>Measured on an Intel Core Ultra 7 268V · NVMe SSD · Windows 11 · single-threaded ·
best of 3 · SQLite 3.49.1 in-process (C API, no protocol). Throughput is disk- and
machine-dependent — reproduce it with the command above.</sub>

## How a modern database goes faster

asmdb today is a **row store**: whole 256-byte records, one table, one thread. That
is a deliberate v1 tradeoff — small, predictable, cache-friendly. Here is how the
big engines (SQL Server, PostgreSQL, DuckDB, ClickHouse) push further, which CRUD
path each technique accelerates, and where it sits on asmdb's roadmap.

| Technique | What it buys you | Speeds up | In asmdb |
|---|---|---|---|
| Open-addressing hash index (array *is* the index) | O(1) average key lookup, zero index maintenance | Create / Read / Update / Delete by key | ✅ implemented |
| Fibonacci hashing | scatters keys, short probe chains | Read / Update probing | ✅ implemented |
| WAL + group commit | amortize one `fsync` over many rows | durable Create / Update / Delete | ✅ implemented |
| Columnar storage | store each column contiguously; touch only the columns a query needs | analytical Reads, `COUNT` / `SUM` scans | 🗺️ roadmap |
| Lightweight compression (RLE, dictionary, bit-packing, frame-of-reference) | fewer bytes ⇒ fewer cache misses and less I/O | Read scans, bulk load | 🗺️ roadmap |
| Secondary & bitmap indexes | fast lookup on non-key columns | Reads with predicates | 🗺️ roadmap |
| Partitioning + file split | prune irrelevant data, shrink the working set, parallel I/O | all CRUD at scale | 🗺️ roadmap |
| SIMD + multi-threading | process many rows per instruction / per core | analytical Reads, bulk ops | 🗺️ roadmap |
| MVCC | readers never block writers | concurrent workloads | 🗺️ roadmap |

**Columnar + compression.** A row store reads a whole 256-byte record even to sum
one column. A *column* store keeps each column in its own contiguous run, so a
`SUM(value)` streams only the `value` array through the CPU — and because a column
holds one kind of data, it compresses hard: run-length encoding for repeats,
dictionaries for low-cardinality text, bit-packing and frame-of-reference for
narrow integers. Less data moved means fewer cache misses and less disk I/O on
every Read. In asmdb the natural first step is to split the `value` cell out of
the record into a packed column and bit-pack it to its declared `TYPES` width
(a `u8` column would shrink 8×).

**Partitioning + parallelism.** Beyond a certain size one file and one thread stop
scaling. Modern engines **partition** data (by key range or hash) into separate
files, so a query can *prune* whole partitions it doesn't need and process the
survivors **in parallel** — one thread or core per partition, often with **SIMD**
scanning 8–16 values per instruction inside each. asmdb's fixed-width slot array
is already SIMD- and shard-friendly: the slot region could be split into *P*
files of `CAPACITY/P` slots, each with its own WAL, checkpointed by *P* threads at
once. The single-file, single-thread design is what keeps v1 honest and tiny; the
layout was chosen so these are additive, not rewrites.

Everything marked 🗺️ is future work, called out plainly so the benchmarks above
stay honest: they measure what asmdb **does today**, not what it might do.

## Connect from your app (Python · C# · C)

There is **no driver or network protocol** — asmdb is a stdin/stdout REPL. To use
it from another language you **spawn the process and pipe commands**; colors are
disabled automatically when the output is redirected, so you get clean ASCII back.

```python
from asmdb_client import Asmdb
db = Asmdb(r".\build\asmdb.exe", "SalesDB", "SalesTransactions")
db.run("BEGIN", "INSERT 1 500 customer Contoso Ltd - key account", "COMMIT")
print(db.select_all())     # [{'id': 1, 'tag': 'customer', 'value': 500, 'content': 'Contoso Ltd - key account'}]
```

Ready-to-run examples live in [`clients/`](clients/) (Python, C#, C), along with
notes on adding a proper `--json` batch mode or a TCP server for a real driver.
For AI agents, the [`mcp/`](mcp/) server is the turnkey path — no piping required.

## Engine specification

For the precise, byte-level technical reference — PE64 layout, calling
convention, record store, hash function, on-disk formats, the two-phase commit
and recovery protocol, the MCP integration, and the full roadmap — see
**[`docs/ENGINE.md`](docs/ENGINE.md)**.

## Roadmap & SaaS plan

Two documents, deliberately kept in separate lanes:

- **[`docs/ENGINE.md`](docs/ENGINE.md) — the engine roadmap.** Everything here
  stays **100% x86-64 assembly**: hardening (CRC32 WAL, incremental checkpoint,
  group commit, dynamic resize), fast reads (secondary/bitmap indexes, AVX2/512
  scans, range queries), columnar storage + compression, then concurrency,
  partitioning, an in-asm binary wire protocol, and a Linux syscall port. See
  [§12 Roadmap](docs/ENGINE.md#12-roadmap).
- **[`docs/SAAS.md`](docs/SAAS.md) — the productization plan.** How the assembly
  engine becomes a hosted, multi-tenant **agent-memory-as-a-service** (remote
  MCP over HTTP/SSE): architecture, wire protocols, tenancy & isolation, auth,
  quotas/metering, durability/backups, HA/replication, security/compliance,
  observability, deployment, pricing, and a phased GTM. The engine is the data
  plane and stays assembly; **this control/service layer may use any language**
  (Rust/Go), by design.

## Project layout

```
asmdb/
  src/          main.asm + .inc modules (console, parse, store, db, wal, data)
  mcp/          Model Context Protocol server (agent memory) + tests
  clients/      stdio client examples: Python, C#, C
  examples/     seed-salesdb.ps1 sample loader, bench.ps1 + bench_sqlite.py
  tests/        smoke.ps1 + make_wal.py crash-recovery fixture
  docs/         ENGINE.md spec, SAAS.md plan, assets/ (logo, banner, generator)
  poc/          minimal 752-byte PE64 proof-of-concept
  build.ps1     locates NASM and assembles from src\
```

See [`docs/ENGINE.md`](docs/ENGINE.md) for the full engine specification and
roadmap, and [`docs/SAAS.md`](docs/SAAS.md) for the SaaS productization plan.

## License

MIT — see [`LICENSE`](LICENSE).

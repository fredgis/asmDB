<div align="center">

```text
    _    ____  __  __ ____  ____
   / \  / ___||  \/  |  _ \| __ )
  / _ \ \___ \| |\/| | | | |  _ \
 / ___ \ ___) | |  | | |_| | |_) |
/_/   \_\____/|_|  |_|____/|____/
```

### a minimalist **transactional** database in **x86-64 assembly**

Full CRUD · write-ahead log · crash recovery · ASCII-art CLI

![assembler](https://img.shields.io/badge/assembler-NASM%203.x-6E4AA0)
![arch](https://img.shields.io/badge/arch-x86--64-1f6feb)
![output](https://img.shields.io/badge/build-nasm%20--f%20bin-0b3d91)
![runtime](https://img.shields.io/badge/runtime-Win32%20%2F%20no%20CRT-bf8700)
![size](https://img.shields.io/badge/binary-~10%20KB-1a7f37)
![deps](https://img.shields.io/badge/dependencies-0-2da44e)

</div>

---

`asmdb` is a tiny key/value database engine written from scratch in x86-64
assembly. There is **no linker**, **no C runtime**, and **no external library** —
NASM emits the Windows PE executable directly (`nasm -f bin`) and the program
talks to `kernel32.dll` through a hand-crafted import table.

Despite fitting in ~10 KB, it is a genuinely **transactional** store: every
statement is durable, `BEGIN`/`COMMIT`/`ROLLBACK` are real, and a write-ahead
log guarantees atomic recovery after a crash.

## Highlights

- **Zero dependencies** — assembled by NASM alone, no linker, no CRT.
- **Cache-friendly core** — fixed 64-byte records (one cache line) in an
  open-addressing hash table; the record array *is* the index.
- **Fast hashing** — Fibonacci hashing (`id * 2^64/φ >> 52`) + linear probing.
- **Durable by default** — autocommit flushes each mutation to disk.
- **Real transactions** — `BEGIN` / `COMMIT` / `ROLLBACK` with an undo log.
- **Crash-safe** — a WAL with a commit marker is replayed or discarded
  atomically on startup.
- **ASCII-art CLI** — a REPL that renders results as boxed tables.

## Architecture

```mermaid
flowchart TD
    STDIN([stdin]) --> REPL[REPL loop<br/>read_line]
    REPL --> DISP[dispatch]
    DISP --> PARSE[tokenizer<br/>+ integer/name parsers]
    PARSE --> CMD[CRUD handlers]
    CMD --> HASH[open-addressing<br/>hash table]
    HASH --> REC[64-byte records<br/>in VirtualAlloc'd RAM]
    CMD -->|autocommit / COMMIT| DAT[(asmdb.dat<br/>512B header + slots)]
    CMD -->|transaction| WAL[(WAL<br/>after-images + marker)]
    WAL -. checkpoint .-> DAT
    CMD --> TBL[ASCII table renderer]
    TBL --> STDOUT([stdout])

    classDef cli fill:#8250df,stroke:#3b1e75,color:#fff
    classDef eng fill:#1f6feb,stroke:#0b3d91,color:#fff
    classDef sto fill:#1a7f37,stroke:#0b4a20,color:#fff
    classDef dur fill:#bf8700,stroke:#7a5600,color:#fff
    classDef io  fill:#57606a,stroke:#24292f,color:#fff
    class REPL,TBL cli
    class DISP,PARSE,CMD eng
    class HASH,REC sto
    class DAT,WAL dur
    class STDIN,STDOUT io
```

### Record layout (64 bytes)

| Offset | Size | Field    | Notes                              |
|-------:|-----:|----------|------------------------------------|
| `0`    | 8    | `id`     | `u64` primary key                  |
| `8`    | 1    | `status` | `0` empty · `1` occupied · `2` deleted |
| `16`   | 8    | `value`  | `i64` payload                      |
| `24`   | 40   | `name`   | zero-padded ASCII                  |

The on-disk file is a 512-byte header (magic `ASMDB`, version, capacity, live
count) followed by `CAPACITY × 64` slot bytes — a direct image of the in-memory
table.

## How a write becomes durable

```mermaid
flowchart LR
    A[INSERT / UPDATE / DELETE] --> B[store_locate<br/>hash + probe]
    B --> C[mutate 64B slot in RAM]
    C --> D{inside a<br/>transaction?}
    D -- no --> E[write slot to asmdb.dat]
    E --> F[rewrite header]
    F --> G[[FlushFileBuffers]]
    G --> H([durable])
    D -- yes --> I[append undo entry<br/>defer disk write to COMMIT]

    classDef op   fill:#1f6feb,stroke:#0b3d91,color:#fff
    classDef dec  fill:#bf8700,stroke:#7a5600,color:#fff
    classDef disk fill:#6e4aa0,stroke:#3b1e75,color:#fff
    classDef ok   fill:#1a7f37,stroke:#0b4a20,color:#fff
    class A,B,C,I op
    class D dec
    class E,F,G disk
    class H ok
```

## Transactions & the write-ahead log

```mermaid
%%{init: {'theme':'base','themeVariables':{'fontFamily':'monospace','primaryColor':'#1f6feb','primaryTextColor':'#fff','primaryBorderColor':'#0b3d91','lineColor':'#8250df','actorBkg':'#1f6feb','actorTextColor':'#fff','signalColor':'#57606a','noteBkgColor':'#bf8700','noteTextColor':'#fff'}}}%%
sequenceDiagram
    autonumber
    participant U as User
    participant M as RAM table
    participant W as WAL file
    participant D as asmdb.dat
    U->>M: BEGIN (snapshot count, clear undo log)
    U->>M: INSERT / UPDATE / DELETE
    M->>M: apply change + append undo (old image)
    U->>W: COMMIT — write magic + after-images + count
    W->>W: flush
    U->>W: write COMMIT marker
    W->>W: flush  ← transaction is now durable
    W->>D: apply after-images + header
    D->>D: flush (checkpoint)
    W->>W: truncate
    Note over U,D: ROLLBACK instead? replay the undo log in reverse — disk untouched
```

## Crash recovery

On startup the WAL is inspected before the table is loaded. Recovery is
**idempotent**: replaying an already-applied WAL is harmless.

```mermaid
flowchart TD
    S[startup: db_open] --> R[read WAL]
    R --> M{magic ASMWAL01?}
    M -- no --> X[discard and truncate]
    M -- yes --> K{commit marker present?}
    K -- no --> X
    K -- yes --> P[replay after-images<br/>into asmdb.dat]
    P --> H[rewrite header + flush]
    H --> T[truncate WAL]
    X --> L[load table into RAM]
    T --> L

    classDef start fill:#8250df,stroke:#3b1e75,color:#fff
    classDef dec   fill:#bf8700,stroke:#7a5600,color:#fff
    classDef act   fill:#1f6feb,stroke:#0b3d91,color:#fff
    classDef done  fill:#1a7f37,stroke:#0b4a20,color:#fff
    class S start
    class M,K dec
    class R,P,H,X act
    class T,L done
```

## Hash probing

```mermaid
flowchart LR
    ID[id] --> HH["hash = id * GOLDEN"]
    HH --> SLOT["slot = hash >> 52"]
    SLOT --> P{slot state?}
    P -- EMPTY --> INS[free slot<br/>insert / not-found]
    P -- DELETED --> REU[remember reusable slot,<br/>keep probing]
    P -- OCCUPIED --> EQ{id matches?}
    EQ -- yes --> HIT[found]
    EQ -- no --> NX["next = (slot + 1) mod CAPACITY"]
    NX --> P
    REU --> NX

    classDef k fill:#1f6feb,stroke:#0b3d91,color:#fff
    classDef d fill:#bf8700,stroke:#7a5600,color:#fff
    classDef g fill:#1a7f37,stroke:#0b4a20,color:#fff
    class ID,HH,SLOT,NX k
    class P,EQ d
    class INS,REU,HIT g
```

Slots move through three states; tombstones keep probe chains intact:

```mermaid
%%{init: {'theme':'base','themeVariables':{'fontFamily':'monospace','primaryColor':'#1f6feb','primaryTextColor':'#fff','primaryBorderColor':'#0b3d91','lineColor':'#8250df'}}}%%
stateDiagram-v2
    [*] --> EMPTY
    EMPTY --> OCCUPIED: INSERT
    OCCUPIED --> OCCUPIED: UPDATE
    OCCUPIED --> DELETED: DELETE
    DELETED --> OCCUPIED: INSERT (reuse)
```

## Requirements

- Windows x64
- NASM 3.x — `winget install --id NASM.NASM -e`

## Build & run

```powershell
.\build.ps1          # -> build\asmdb.exe
.\build.ps1 -Run     # build then run
.\build.ps1 -Poc     # assemble the proof-of-concept poc\hello.asm
```

Or invoke NASM directly (run from the `src\` directory so `%include` resolves):

```powershell
cd src
nasm -f bin main.asm -o ..\build\asmdb.exe
```

The optional first argument names the database (default `asmdb`), producing
`<name>.dat` and `<name>.wal`:

```powershell
.\build\asmdb.exe SalesDB
```

## REPL commands

```
INSERT <id> <value> <name>    add a row
SELECT <id>                   show one row
SELECT *                      show all rows
UPDATE <id> <value> <name>    modify a row
DELETE <id>                   remove a row
COUNT                         number of live rows
BEGIN | COMMIT | ROLLBACK     transaction control
HELP                          command list
EXIT | QUIT                   leave asmdb
```

## Sample: seed the SalesDB / SalesTransactions demo

A helper script loads ten `SalesTransactions` rows into a sample `SalesDB`
inside a single atomic transaction:

```powershell
.\examples\seed-salesdb.ps1 -Fresh
```

The `SalesTransactions` fields map onto asmdb's record shape as
`id → transaction id`, `value → amount`, `name → customer`:

```
asmdb> [ OK ] transaction started
asmdb> [ OK ] 1 row inserted        (x10)
asmdb> [ OK ] transaction committed
asmdb> +------------+------------------------+----------------+
| id         | name                   | value          |
+------------+------------------------+----------------+
| 1005       | Tailspin_Toys          | 3799           |
| 1010       | Blue_Yonder            | 649            |
| 1002       | Fabrikam_Inc           | 499            |
| 1007       | Litware_Inc            | 4599           |
| 1004       | Northwind_Traders      | 149            |
| 1009       | Fourth_Coffee          | 1899           |
| 1001       | Contoso_Ltd            | 1299           |
| 1006       | Wingtip_Toys           | 899            |
| 1003       | Adventure_Works        | 2599           |
| 1008       | Proseware_Inc          | 249            |
+------------+------------------------+----------------+
asmdb> [ OK ] 10 row(s)
```

(Rows appear in hash order, not insertion order — that's the probe layout.)

Re-open the same database to prove durability:

```powershell
.\build\asmdb.exe SalesDB
asmdb> SELECT *
asmdb> COUNT
```

## Project layout

```
asmdb/
  src/
    main.asm      PE64 header, entry point, REPL loop, module includes
    asmdb.inc     constants, record layout, Win32 values
    console.inc   buffered stdin/stdout, number formatting
    parse.inc     tokenizer + CRUD handlers + dispatch + table renderer
    store.inc     hash function + open-addressing probe
    db.inc        asmdb.dat header/slot persistence
    wal.inc       write-ahead log, transactions, crash recovery
    data.inc      globals, strings, banner, import table
  poc/            minimal 752-byte PE64 proof-of-concept (reference)
  examples/       seed-salesdb.ps1 sample loader
  tests/          test helpers (make_wal.py crash-recovery fixture)
  docs/           PLAN.md — detailed design
  build.ps1       build script (locates NASM, assembles from src\)
```

## Design notes

- **Linker-free PE64.** `SectionAlignment == FileAlignment == 0x200`, so every
  RVA equals its file offset — the import thunks can be laid out by hand.
- **One section.** Code, data and the import table share a single
  read/write/execute `.text` section; the record store lives outside the binary
  in `VirtualAlloc`'d memory, keeping the executable tiny.
- **Uniform ABI.** Every routine uses an `rbp` frame with ≥ 32 bytes of shadow
  space and keeps `rsp` 16-byte aligned before each Win32 call.

See [`docs/PLAN.md`](docs/PLAN.md) for the full design and the phase-by-phase
roadmap.

## License

MIT — see [`LICENSE`](LICENSE).

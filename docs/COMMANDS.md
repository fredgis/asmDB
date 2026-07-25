<div align="center">
  <img src="assets/asmdb-logo.png" alt="asmdb logo" width="110">

  <h1>asmdb — command dictionary</h1>

  <p><em>Every command the engine understands, with syntax, rules and worked examples.</em></p>
</div>

---

asmdb is driven by a **line-oriented REPL** over `stdin`/`stdout`. One line is
one command; the first token is the verb (case-insensitive), the rest are its
arguments. This page is the complete reference — the [README](../README.md) links
here instead of inlining the list.

- **[Conventions](#conventions)**
- **[Quick reference](#quick-reference)**
- **Data:** [`INSERT`](#insert) · [`SELECT`](#select) · [`UPDATE`](#update) · [`DELETE`](#delete) · [`TRUNCATE`](#truncate) · [`FIND`](#find) · [`RANGE`](#range) · [`COUNT`](#count)
- **Transactions:** [`BEGIN`](#begin) · [`COMMIT`](#commit) · [`ROLLBACK`](#rollback)
- **Catalog:** [`TABLES`](#tables) · [`DATABASES`](#databases) · [`SCHEMA`](#schema) · [`TYPES`](#types) · [`BENCH`](#bench)
- **Backup:** [`BACKUP`](#backup) · [`RESTORE`](#restore)
- **Session:** [`HELP`](#help) · [`EXIT` / `QUIT`](#exit--quit)
- **[Why there is no `CREATE TABLE` / `DROP` / `ALTER`](#why-there-is-no-create-table--drop--alter)**
- **[Error reference](#error-reference)**

---

## Conventions

| Placeholder | Meaning |
|---|---|
| `<id>` | primary key, an unsigned integer **≥ 1** and **< 2⁶⁴** (id `0` is reserved; a literal too large to fit is rejected as a syntax error, never wrapped) |
| `<value>` / `<val>` | the 64-bit signed numeric cell (`i64`); may be interpreted as any narrower [type](#types) by the caller |
| `<tag>` | a **single token** (no spaces), ≤ 40 bytes — a category / namespace |
| `<text>` / `<content>` | the **rest of the line** (spaces allowed), ≤ 176 bytes |
| `<substr>` | a search string for [`FIND`](#find) |
| `<lo> <hi>` | inclusive numeric bounds for [`RANGE`](#range) |
| `<file>` | a path for [`BACKUP`](#backup) / [`RESTORE`](#restore) |

Rules that apply everywhere:

- **Verbs are case-insensitive** (`insert`, `INSERT`, `Insert` are equal); `tag`
  and `content` bytes are stored verbatim.
- **`tag` is one token; `content` is everything after it** to end of line.
- Extra whitespace between tokens is ignored. A leading UTF-8 BOM on the stream
  is skipped, so piping from any shell/editor is safe.
- Colors are emitted only when `stdin` **and** `stdout` are both a terminal; when
  either is redirected (a pipe, a file, CI) the output is plain ASCII.

---

## Quick reference

| Command | Purpose |
|---|---|
| [`INSERT <id> <val> <tag> <text>`](#insert) | add a new row (auto `created`/`updated`) |
| [`SELECT <id>`](#select) | show one row as a detail block |
| [`SELECT *`](#select) | list every live row as a table |
| [`UPDATE <id> <val> <tag> <text>`](#update) | overwrite an existing row (bumps `updated`) |
| [`DELETE <id>`](#delete) | remove one row by key |
| [`TRUNCATE`](#truncate) | remove **every** row (transaction-aware) |
| [`FIND <substr>`](#find) | case-insensitive substring search over `tag` + `content` |
| [`RANGE <lo> <hi>`](#range) | list rows whose `value` is in `[lo, hi]` |
| [`COUNT`](#count) | number of live rows |
| [`BEGIN`](#begin) · [`COMMIT`](#commit) · [`ROLLBACK`](#rollback) | transaction control |
| [`TABLES`](#tables) | the table held in this database |
| [`DATABASES`](#databases) | list `*.dat` databases in the current folder |
| [`SCHEMA`](#schema) | show the fixed record layout |
| [`TYPES`](#types) | supported logical column types |
| [`BENCH <n>`](#bench) | insert *n* synthetic rows and report engine rows/sec |
| [`BACKUP <file>`](#backup) | snapshot this database to `<file>` |
| [`RESTORE <file>`](#restore) | reload this database from a snapshot |
| [`HELP`](#help) | in-app command reference |
| [`EXIT` / `QUIT`](#exit--quit) | leave asmdb |

---

## Data commands

### `INSERT`

```
INSERT <id> <value> <tag> <content...>
```

Add a new row. `created` and `updated` are set automatically to the current unix
epoch in milliseconds. In autocommit mode the row is flushed to disk immediately;
inside a transaction it is staged until [`COMMIT`](#commit).

**Constraints** — `id` must be **≥ 1** (a `CHECK`; `0` is reserved) and must not
already exist (unique primary key); `tag` ≤ 40 bytes; `content` ≤ 176 bytes.

```text
asmdb> INSERT 1001 5 project asmdb is written in x86-64 assembly
[ OK ] 1 row inserted
```

Errors: `[ERR] id already exists`, `[ERR] id must be >= 1`, `[ERR] table full`.

---

### `SELECT`

```
SELECT <id>      show one row as a detail block (full content + timestamps)
SELECT *         list every live row as a 4-column table
```

`SELECT <id>` prints the whole record, including the full (untruncated) `content`
and both timestamps. `SELECT *` prints a boxed table with the `content` column
truncated to fit.

```text
asmdb> SELECT 1001
  id       : 1001
  tag      : project
  value    : 5
  created  : 1718900000123
  updated  : 1718900000123
  content  : asmdb is written in x86-64 assembly

asmdb> SELECT *
+----------+------------------+------------+------------------------------------------+
| id       | tag              | value      | content                                  |
+----------+------------------+------------+------------------------------------------+
| 1001     | project          | 5          | asmdb is written in x86-64 assembly      |
+----------+------------------+------------+------------------------------------------+
[ OK ] 1 row(s)
```

Error: `[ERR] key not found` (for `SELECT <id>` when the id is absent).

---

### `UPDATE`

```
UPDATE <id> <value> <tag> <content...>
```

Overwrite an **existing** row's `value`, `tag` and `content`. `created` is
preserved; `updated` is bumped to now. Transaction-aware like `INSERT`.

```text
asmdb> UPDATE 1001 9 project asmdb now targets Windows and Linux
[ OK ] 1 row updated
```

Error: `[ERR] key not found` if the id does not exist.

---

### `DELETE`

```
DELETE <id>
```

Remove a single row by key. The slot is marked with a **tombstone** (`status = 2`)
rather than cleared, so open-addressing probe chains that once ran through it
still terminate correctly. Transaction-aware.

```text
asmdb> DELETE 1001
[ OK ] 1 row deleted
```

Error: `[ERR] key not found` if the id does not exist.

---

### `TRUNCATE`

```
TRUNCATE
```

Remove **every** row in the table in one operation — the bulk counterpart to
`DELETE`. It is fully **transaction-aware**:

- **Autocommit** — each live slot is tombstoned and only the affected slots (plus
  the header) are written and flushed; the sparse 1 GiB region is *not*
  materialized.
- **Inside a transaction** — every removed row's before-image is captured in the
  undo log, so [`ROLLBACK`](#rollback) restores the whole table and
  [`COMMIT`](#commit) makes the empty table durable.

```text
asmdb> TRUNCATE
[ OK ] table truncated - 3 row(s) removed
```

If a transaction is open and clearing the table would exceed the undo capacity,
it is refused with `[ERR] transaction too large` — split it or `TRUNCATE` in
autocommit mode.

---

### `FIND`

```
FIND <substr>
```

Case-insensitive **substring** search over both `tag` and `content` of every live
row. Matches are printed as a table (same shape as `SELECT *`).

```text
asmdb> FIND assembly
+----------+------------------+------------+------------------------------------------+
| id       | tag              | value      | content                                  |
+----------+------------------+------------+------------------------------------------+
| 1001     | project          | 9          | asmdb now targets Windows and Linux      |
+----------+------------------+------------+------------------------------------------+
[ OK ] 1 match
```

`[ OK ] no matching rows` when nothing matches.

---

### `RANGE`

```
RANGE <lo> <hi>
```

List every live row whose numeric `value` falls within the inclusive interval
`[lo, hi]`. A predicate scan — a preview of the indexed access paths on the
roadmap.

```text
asmdb> RANGE 200 260
+----------+------------------+------------+------------------------------------------+
| id       | tag              | value      | content                                  |
+----------+------------------+------------+------------------------------------------+
| 42       | metric           | 250        | yy                                       |
+----------+------------------+------------+------------------------------------------+
[ OK ] 1 row(s)
```

---

### `COUNT`

```
COUNT
```

Print the number of live rows (tombstones excluded). O(1) — it reads the
maintained `live_count`, not a scan.

```text
asmdb> COUNT
[ OK ] 2 row(s)
```

---

## Transaction commands

asmdb transactions are backed by an **undo log** (for `ROLLBACK`) and a
**write-ahead log** (for durable, crash-safe `COMMIT`). See the
[engine spec](ENGINE.md) for the two-phase commit protocol.

> **Undo capacity counts *rows*, not writes.** A slot is captured at most once
> per transaction, so the 4096-entry undo log limits how many **distinct rows**
> a transaction touches — not how many statements it runs. Updating the same row
> a million times inside one transaction uses a single undo entry, and
> `ROLLBACK` restores its *original* image.

### `BEGIN`

```
BEGIN
```

Start a transaction: snapshots the live row count and clears the undo log.
Subsequent mutations are applied in RAM but **not** written to `.dat` until
`COMMIT`. Nesting is not supported — a second `BEGIN` is an error.

```text
asmdb> BEGIN
[ OK ] transaction started
```

---

### `COMMIT`

```
COMMIT
```

Make all pending changes durable via two-phase commit: stage after-images to the
WAL and `fsync`, write a commit marker and `fsync` again, apply to `.dat`, then
truncate the WAL. After this returns, the data survives a crash.

```text
asmdb> COMMIT
[ OK ] transaction committed
```

Error: `[ERR] no transaction` if none is open.

---

### `ROLLBACK`

```
ROLLBACK
```

Discard all pending changes: walk the undo log in reverse, restoring each saved
256-byte image, then drop back to the snapshot count. The disk was never touched,
so nothing is reversed on disk.

```text
asmdb> ROLLBACK
[ OK ] transaction rolled back
```

Error: `[ERR] no transaction` if none is open.

---

## Catalog commands

### `TABLES`

```
TABLES
```

Show the single logical table held in this database (its name lives in the
512-byte file header). One `.dat` file is one database with one table.

```text
asmdb> TABLES
  SalesTransactions
[ OK ] 1 table
```

---

### `DATABASES`

```
DATABASES
```

List the `*.dat` databases in the current working folder.

```text
asmdb> DATABASES
  SalesDB.dat
  Bench2M.dat
[ OK ] 2 database(s)
```

---

### `SCHEMA`

```
SCHEMA
```

Print the fixed 256-byte record layout — offsets, sizes, fields and physical
types. The layout never changes; that is what keeps the engine fast.

```text
asmdb> SCHEMA
  record layout - fixed 256 bytes per row
    offset  size  field    type
    ------  ----  -------  -------------------------------------
    0       8     id       u64   primary key
    8       1     status   u8    0 empty / 1 live / 2 deleted
    9       1     kind     u8    row-kind tag (reserved)
    12      4     clen     u32   content byte length
    16      8     created  i64   unix epoch ms (auto)
    24      8     updated  i64   unix epoch ms (auto)
    32      8     value    i64   numeric score / payload
    40      40    tag      char[40]  category, NUL-padded
    80      176   content  char[176] free text, NUL-padded
```

---

### `TYPES`

```
TYPES
```

Show the catalog of **logical** column types. Narrow integers, `bool`, `f64` and
`timestamp` all ride inside the 64-bit `value` cell — asmdb keeps the raw bits and
the caller (your app, or an agent via the MCP server) picks the interpretation.

```text
asmdb> TYPES
  supported column types
    type         bits  domain                      column
    ----------   ----  --------------------------  -----------
    u64            64  0 .. 1.8e19                 id (key)
    i64            64  -9.2e18 .. 9.2e18           value
    u32 / i32      32  narrowed integer            value, clen
    u16 / i16      16  narrowed integer            value
    u8  / i8        8  narrowed integer            kind, value
    bool            8  0 = false / 1 = true        value
    f64            64  IEEE-754 double (raw bits)  value
    timestamp      64  unix epoch ms               created, updated
    char[40]      320  fixed ASCII text, <= 40 B   tag
    char[176]    1408  fixed ASCII text, <=176 B   content
```

---

### `BENCH`

```
BENCH <n>
```

Insert *n* synthetic rows in a tight in-RAM loop (no text protocol, no per-row
disk I/O), timed internally with a high-resolution counter, then checkpoint once
and report throughput. This is how the [Performance](../README.md#performance)
numbers are produced. `n` is capped to the table capacity.

```text
asmdb> BENCH 1000000
  in-RAM insert  :  18342105 rows/sec
  fsync total    :        just over one second for the durable checkpoint
[ OK ] benchmark complete
```

> `BENCH` mutates the open database (it replaces its contents with synthetic
> rows). Run it against a scratch database name, or `TRUNCATE` afterwards.
> It is **refused inside a transaction** — `COMMIT` or `ROLLBACK` first.

---

## Backup commands

`BACKUP` and `RESTORE` are refused inside a transaction (`COMMIT` or `ROLLBACK`
first).

### `BACKUP`

```
BACKUP <file>
```

Write a consistent snapshot of the current database to `<file>`. Every write and
the final flush are checked: if any of them fails the command reports
`[ERR] backup failed - write error, file is incomplete` and the partial file is
never announced as a usable snapshot. The live database is not touched either
way.

```text
asmdb> BACKUP salesdb.bak
[ OK ] backup written
```

---

### `RESTORE`

```
RESTORE <file>
```

Replace the current database contents with a snapshot previously written by
`BACKUP`. The live set after `RESTORE` matches the snapshot exactly.

The snapshot is **fully validated before a single byte of the live table is
overwritten** — magic, format fields, row count and the presence of the last
byte of the record region. A foreign file is rejected with
`[ERR] not an asmdb backup (bad magic)`; a truncated or incompatible one with
`[ERR] backup is truncated or incompatible - nothing restored`. In both cases
the current database is left exactly as it was, in memory and on disk.

```text
asmdb> RESTORE salesdb.bak
[ OK ] database restored - 10 row(s)
```

---

## Session commands

### `HELP`

```
HELP
```

Print the in-app command reference, grouped by section (Data, Transactions,
Catalog, Backup, Session).

---

### `EXIT` / `QUIT`

```
EXIT
QUIT
```

Leave asmdb. Any open transaction is discarded (it was never made durable). Both
spellings are equivalent; end-of-input (a closed pipe / Ctrl-Z / Ctrl-D) exits
the same way.

---

## Why there is no `CREATE TABLE` / `DROP` / `ALTER`

This is intentional — the questions "where is `CREATE TABLE`?" and "where is
`DROP`?" have precise answers:

- **`CREATE TABLE` — implicit, by design.** asmdb is a *single-table* engine with
  one **fixed 256-byte schema** ([`SCHEMA`](#schema)). There is no DDL because the
  schema cannot vary: the table is created automatically when you open a database
  name that has no `.dat` yet, and its name comes from the second CLI argument
  (`asmdb.exe SalesDB SalesTransactions`) and is stored in the file header. This
  fixed shape is exactly what makes the engine tiny and fast — the record array
  *is* the index, with no per-table metadata to manage.
- **`DROP TABLE` — delete the file, or `TRUNCATE`.** To empty a table use
  [`TRUNCATE`](#truncate); to remove a database entirely, delete its `<name>.dat`
  (and `<name>.wal`) file. Because one database is one file, "drop" is a
  file-system operation, not a SQL statement.
- **`ALTER TABLE` — not applicable.** The schema is fixed, so there are no columns
  to add, drop or retype. The `value` cell already spans every numeric
  [type](#types); `tag` and `content` cover text.
- **Multiple tables / real DDL** are a deliberate non-goal for the v1 engine; a
  richer catalog is discussed in the [engine roadmap](ENGINE.md#12-roadmap).

So the full mutation surface is: create a row ([`INSERT`](#insert)), read
([`SELECT`](#select) / [`FIND`](#find) / [`RANGE`](#range)), update
([`UPDATE`](#update)), and delete one ([`DELETE`](#delete)) or all
([`TRUNCATE`](#truncate)) rows — CRUD in full, minus DDL that a fixed-schema
engine does not need.

---

## Error reference

Every failure prints one `[ERR]` line and leaves the database unchanged. The
engine never prints `[ OK ]` after a failed write.

| Message | Meaning |
|---|---|
| `unknown command - type HELP` | the verb was not recognised |
| `syntax error - type HELP` | missing/malformed argument, or a number that does not fit in 64 bits |
| `constraint: id must be >= 1 (0 is reserved)` | id `0` is not a usable key |
| `key already exists` | [`INSERT`](#insert) on a live key — use [`UPDATE`](#update) |
| `key not found` | [`UPDATE`](#update) / [`DELETE`](#delete) / [`SELECT`](#select) on a missing key |
| `table full` | no free slot remains at the current capacity |
| `no active transaction` | [`COMMIT`](#commit) / [`ROLLBACK`](#rollback) outside a transaction |
| `transaction already active` | nested [`BEGIN`](#begin) |
| `transaction too large - COMMIT or ROLLBACK` | more than 4096 **distinct rows** touched in one transaction (for `TRUNCATE`, the whole live table must fit — it fails having changed nothing) |
| `finish the transaction first (COMMIT or ROLLBACK)` | [`BACKUP`](#backup), [`RESTORE`](#restore) or [`BENCH`](#bench) attempted inside a transaction |
| `cannot open database file` | the `.dat`/`.wal` could not be opened |
| `database is locked by another process (single-writer)` | another asmdb instance already holds the file |
| `database file is incomplete or corrupt - refusing to open <file>` | the `.dat` is non-empty but not a valid, complete asmdb file — it is **never** silently recreated. The message names the file and how to proceed |
| `incompatible database format - refusing to open <file>` | the `.dat` was written by a build with a different on-disk layout. The message prints this build's version/record size/capacity next to the file's, so you can see exactly what differs |
| `write-ahead log is corrupt (checksum mismatch) - refusing to open <file>` | a committed WAL frame no longer matches its CRC-32. Replaying it would write corrupt rows and discarding it would lose an acknowledged transaction, so the engine stops and keeps the log. Restore from a backup, or delete the `.wal` to reopen at the last checkpoint |
| `cannot open backup file` | the [`BACKUP`](#backup)/[`RESTORE`](#restore) path could not be opened |
| `not an asmdb backup (bad magic)` | the file given to [`RESTORE`](#restore) is not an asmdb snapshot |
| `backup is truncated or incompatible - nothing restored` | the snapshot is short or from another layout; the live database is untouched |
| `backup failed - write error, file is incomplete` | a [`BACKUP`](#backup) transfer or flush failed; the partial file is not a usable snapshot |
| `I/O failure on a durable write - aborting to avoid an inconsistent database` | a durable write or `fsync` failed. asmdb **exits (status 1)** rather than continue with memory and disk out of sync |
| `I/O failure while reading - aborting rather than serving partial data` | a read failed. Nothing durable is at risk, but the in-memory table would be incomplete, so asmdb exits instead of serving half-loaded rows |
| `out of memory` | the startup allocations failed |

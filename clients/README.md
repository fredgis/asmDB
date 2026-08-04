# Connecting to asmdb from your application

Current engine: **1.7.0**, storage format **2**. The binaries are 43,749 bytes
(PE64) and 52,221 bytes (ELF64), and downloads are published at
<https://www.asmdb.cloud/downloads/> with SHA-256 hashes in the manifest.

**asmdb is not a server and there is no driver / client library.** It is a
single executable that behaves as a REPL: it reads one command per line from
**stdin** and writes results to **stdout**. There is no socket, shared library,
or long-lived daemon to connect to. The local engine also has no authentication,
encryption or audit log; put those controls around it if you embed it.

So "connecting" means one thing: **spawn `asmdb` as a child process and pipe
text to it.** The executable is `asmdb.exe` on Windows and `asmdb` elsewhere.
All examples honor `ASMDB_EXE`; when it is not set they look in `..\..\build`.

```
asmdb <database> [table]      # commands in on stdin, results out on stdout
```

Since 1.7.0 every command terminates with `[ OK ]` or `[ERR]`. Stdio clients
may therefore read one response per command; older engines missed terminators on
`HELP`, `SCHEMA`, `VERSION` and empty `SELECT *`, which could desynchronise a
stream reader.

## Machine-readable output

For applications, switch the REPL to TSV mode before listing rows:

```
FORMAT TSV
PAGE 100 0
SELECT *
QUIT
```

`SELECT <id>`, `SELECT *`, `FIND <substr>` and `RANGE <lo> <hi>` then emit one
untruncated row per line:

```
R<TAB>id<TAB>value<TAB>created<TAB>updated<TAB>tag<TAB>content
```

In `tag` and `content`, only backslash, tab, LF, and CR are escaped as `\\`,
`\t`, `\n`, and `\r`. `PAGE 0 0` restores unlimited listing. `FORMAT TABLE`
returns to the human-readable table format.

Keep `id` and `value` as decimal strings in any JSON or network protocol. A
`u64` id and `i64` value do not fit safely in every JavaScript number. Tags are
limited to 39 usable UTF-8 bytes, content to 175 usable UTF-8 bytes, and the
engine refuses over-long values rather than truncating them. The fixed record
size is 256 bytes. Local databases default to the large table: 4,194,304 slots,
with 3,145,728 usable rows — the service's published ceiling, three quarters of
the 4,194,304 slot table. The engine itself applies no load-factor cap.

There is also a hosted option: cloud instances expose REST at
`https://www.asmdb.cloud/db/<instance>/v1/rows` and MCP at
`https://www.asmdb.cloud/db/<instance>/mcp` with the instance bearer token. See
[`../docs/SAAS.md`](../docs/SAAS.md) for the platform shape.

## Examples in this folder

| Language | File | Notes |
|----------|------|-------|
| Python   | [`python/asmdb_client.py`](python/asmdb_client.py) | `subprocess.run` with argv; parses TSV rows without truncation |
| C#       | [`csharp/AsmdbClient.cs`](csharp/AsmdbClient.cs)   | `ProcessStartInfo.ArgumentList` with redirected stdio |
| C        | [`c/asmdb_client.c`](c/asmdb_client.c)             | `CreateProcess` on Windows, `fork`/`execv` on POSIX; no shell |

Build the engine first (`.\scripts\build.ps1` on Windows or `./scripts/build.sh` on Linux).

### Python

```python
from asmdb_client import Asmdb

db = Asmdb("MemoryDB", "notes")
db.run("INSERT 1 500 alice first memory about alice",
       "INSERT 2 750 bob follow-up on bob", "COMMIT")
print(db.select_all())
# [Row(id=1, value=500, created='...', updated='...', tag='alice',
#      content='first memory about alice'), ...]
```

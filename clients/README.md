# Connecting to asmdb from your application

**asmdb is not a server and there is no driver / client library.** It is a
single executable that behaves as a REPL: it reads one command per line from
**stdin** and writes results to **stdout**. There is no socket, shared library,
or long-lived daemon to connect to.

So "connecting" means one thing: **spawn `asmdb` as a child process and pipe
text to it.** The executable is `asmdb.exe` on Windows and `asmdb` elsewhere.
All examples honor `ASMDB_EXE`; when it is not set they look in `..\..\build`.

```
asmdb <database> [table]      # commands in on stdin, results out on stdout
```

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

## Examples in this folder

| Language | File | Notes |
|----------|------|-------|
| Python   | [`python/asmdb_client.py`](python/asmdb_client.py) | `subprocess.run` with argv; parses TSV rows without truncation |
| C#       | [`csharp/AsmdbClient.cs`](csharp/AsmdbClient.cs)   | `ProcessStartInfo.ArgumentList` with redirected stdio |
| C        | [`c/asmdb_client.c`](c/asmdb_client.c)             | `CreateProcess` on Windows, `fork`/`execv` on POSIX; no shell |

Build the engine first (`.\build.ps1` on Windows or `./build.sh` on Linux).

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

# Connecting to asmdb from your application

**asmdb is not a server and there is no driver / client library.** It is a
single ~27 KB executable that behaves as a REPL: it reads one command per line
from **stdin** and writes ASCII results to **stdout**. There is no socket, no
shared library, and no wire protocol.

So "connecting" means one thing: **spawn `asmdb.exe` as a child process and pipe
text to it.** A helpful property for automation — asmdb detects when stdout is
*not* a real console (i.e. it is redirected/piped) and **turns colors off
automatically**, so the output your program captures is clean, plain ASCII.

```
asmdb.exe <database> [table]      # commands in on stdin, results out on stdout
```

## What you send / what you get back

You send commands exactly as you would type them in the REPL:

```
INSERT 1 500 alice first memory about alice
SELECT *
QUIT
```

You read back the banner, the `asmdb> ` prompts, status lines
(`[ OK ] ...` / `[ERR] ...`), and boxed ASCII tables for `SELECT`. You are
scraping human-readable output, not parsing a structured protocol — fine for
scripting and demos, deliberately simple.

## Examples in this folder

| Language | File | Notes |
|----------|------|-------|
| Python   | [`python/asmdb_client.py`](python/asmdb_client.py) | `subprocess.run`; includes a `SELECT *` table parser → list of dicts |
| C#       | [`csharp/AsmdbClient.cs`](csharp/AsmdbClient.cs)   | `System.Diagnostics.Process` with redirected stdio |
| C        | [`c/asmdb_client.c`](c/asmdb_client.c)             | `_popen`; comments show the two-pipe pattern for capturing output |

Each example assumes it is run from its own folder and finds the binary at
`..\..\build\asmdb.exe`. Build the engine first with `.\build.ps1` from the
repository root.

### Python

```python
from asmdb_client import Asmdb
db = Asmdb(r"..\..\build\asmdb.exe", "MemoryDB", "notes")
db.run("INSERT 1 500 alice first memory about alice",
       "INSERT 2 750 bob follow-up on bob", "COMMIT")
print(db.select_all())
# [{'id': 1, 'tag': 'alice', 'value': 500, 'content': 'first memory about alice'}, ...]
```

## Want a real driver?

The clean path is to add a **machine-readable mode** to the engine so clients
don't have to scrape ASCII:

1. **`--json` batch mode** — suppress the banner/prompt and emit one JSON object
   per command result. A thin library in each language then just parses JSON.
   Small change to the assembly REPL.
2. **TCP server mode** (`asmdb --listen <port>`) — accept the same text/JSON
   commands over a socket via Winsock. This is what turns asmdb into a database
   you genuinely *connect* to, with multi-language clients and pooling.

Neither exists yet; the stdio approach above is what works today.

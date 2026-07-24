# asmdb MCP server

A [Model Context Protocol](https://modelcontextprotocol.io) server that exposes
the **asmdb** transactional engine as a **generic CRUD store** over MCP. Any MCP
client can insert, update, get, delete, search, list and count rows — all backed
by the WAL-durable x86-64 assembly engine.

**Agent memory is one example use case** (address each memory by a string key,
use `tag` as a namespace and `content` as the remembered text) — but the tools
are a general-purpose database interface, not memory-specific.

```
┌──────────────┐   MCP (stdio)   ┌───────────────┐   stdin/stdout   ┌────────────┐
│  MCP client  │ ───────────────▶│ asmdb-mcp     │ ────────────────▶│ asmdb.exe  │
│ (agent, IDE) │◀─────────────── │ (Node server) │◀──────────────── │  (engine)  │
└──────────────┘   tool calls    └───────────────┘   commands       └────────────┘
                                                                       asmdb.dat
                                                                       asmdb.wal
```

The server keeps **one long-lived `asmdb.exe` process** for the whole session,
so the 64 MiB record region is read from disk once at startup; every tool call
is then an in-memory hash lookup plus a small durable write. When the MCP client
disconnects, the server shuts the engine down cleanly (no orphaned process).

## Addressing rows: `id` or `key`

Every record-addressed tool accepts **either**:

- `id` — a numeric primary key (`u64`), used as-is (the generic-DB pattern), or
- `key` — a free-text string that the server hashes to a `u64` id with 64-bit
  **FNV-1a** (the named-record / agent-memory pattern).

So the engine stays a pure id-keyed store — no secondary string index needed.
The rest of the record maps as:

| Field     | asmdb column | notes |
|-----------|--------------|-------|
| `id`/`key`| `id`         | integer as-is, or FNV-1a(key) → u64 |
| `tag`     | `tag`        | short single-word category / namespace (≤ 39 chars) |
| `value`   | `value`      | optional numeric payload / score (i64) |
| `content` | `content`    | free text (≤ 175 chars) |
| —         | `created` / `updated` | set automatically (unix ms) |

## Tools

| Tool | Arguments | Description |
|------|-----------|-------------|
| `db_insert` | `id`\|`key`, `content?`, `tag?`, `value?`, `upsert?` | insert a row; `upsert:true` overwrites instead of erroring |
| `db_update` | `id`\|`key`, `content?`, `tag?`, `value?` | overwrite an existing row (errors if absent) |
| `db_get`    | `id`\|`key` | fetch one row with value, tag, content, timestamps |
| `db_delete` | `id`\|`key` | remove a row |
| `db_find`   | `query` | case-insensitive substring search over tag + content |
| `db_list`   | — | return every live row |
| `db_count`  | — | number of live rows |

## Install & run

```bash
cd mcp
npm install
node src/server.js       # speaks MCP over stdio
npm test                 # end-to-end test against a scratch database
```

Build the engine first (`powershell -File build.ps1` from the repo root) so
`build/asmdb.exe` exists.

### Configuration

| Env var | Default | Purpose |
|---------|---------|---------|
| `ASMDB_EXE` | `../build/asmdb.exe` | path to the engine binary |
| `ASMDB_DIR` | `~/.asmdb` | directory holding the data files |
| `ASMDB_DB`  | `asmdb` | database base name (`<db>.dat` / `<db>.wal`) |

### Register with an MCP client

Add the server to your client's MCP configuration (example for a
`mcpServers` map, as used by Claude Desktop / VS Code / Copilot):

```json
{
  "mcpServers": {
    "asmdb": {
      "command": "node",
      "args": ["C:/Users/you/repo-asmdb/mcp/src/server.js"],
      "env": {
        "ASMDB_EXE": "C:/Users/you/repo-asmdb/build/asmdb.exe",
        "ASMDB_DIR": "C:/Users/you/.asmdb",
        "ASMDB_DB": "asmdb"
      }
    }
  }
}
```

## Examples

**Generic key/value+text store**, addressing rows by numeric id:

```jsonc
db_insert { "id": 1001, "tag": "order", "value": 4200, "content": "invoice #1001 paid" }
db_get    { "id": 1001 }
db_find   { "query": "invoice" }
```

**Agent long-term memory**, addressing rows by string key (create-or-update
with `upsert`):

```jsonc
db_insert { "key": "user.timezone", "content": "Europe/Paris", "tag": "profile", "upsert": true }
db_get    { "key": "user.timezone" }        // → durable across restarts
db_delete { "key": "user.timezone" }
```

Both patterns hit the same assembly engine, where each record is four cache
lines and every write is WAL-durable.

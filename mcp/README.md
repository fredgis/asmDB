# asmdb MCP server

A [Model Context Protocol](https://modelcontextprotocol.io) server that turns
**asmdb** into durable long-term **memory for AI agents**. An agent can store
facts, recall them by key, search them, list them, and delete them — all backed
by the WAL-durable x86-64 assembly engine.

```
┌──────────────┐   MCP (stdio)   ┌───────────────┐   stdin/stdout   ┌────────────┐
│  AI agent /  │ ───────────────▶│ asmdb-mcp     │ ────────────────▶│ asmdb.exe  │
│  MCP client  │◀─────────────── │ (Node server) │◀──────────────── │  (engine)  │
└──────────────┘   tool calls    └───────────────┘   commands       └────────────┘
                                                                     agentmem.dat
                                                                     agentmem.wal
```

The server keeps **one long-lived `asmdb.exe` process** for the whole session,
so the 64 MiB record region is read from disk once at startup; every tool call
is then an in-memory hash lookup plus a small durable write.

## How keys map to records

An agent addresses each memory by a free-text `key` (e.g. `user.name`,
`project.stack`). The server hashes that key to asmdb's `u64` primary id with
64-bit FNV-1a, so the engine stays a pure id-keyed store — no secondary string
index needed. The rest of the record maps naturally:

| MCP field | asmdb column | notes |
|-----------|--------------|-------|
| `key`     | `id`         | FNV-1a(key) → u64 |
| `tag`     | `tag`        | short single-word category (≤ 39 chars) |
| `value`   | `value`      | optional numeric score (i64) |
| `content` | `content`    | the remembered text (≤ 175 chars) |
| —         | `created` / `updated` | set automatically (unix ms) |

## Tools

| Tool | Arguments | Description |
|------|-----------|-------------|
| `memory_store`  | `key`, `content`, `tag?`, `value?` | insert or overwrite a memory (upsert on the same key) |
| `memory_recall` | `key` | fetch one memory with content, tag, value and timestamps |
| `memory_search` | `query` | case-insensitive substring search over tag + content |
| `memory_list`   | — | return every stored memory |
| `memory_delete` | `key` | remove a memory by key |

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
| `ASMDB_DB`  | `agentmem` | database base name (`<db>.dat` / `<db>.wal`) |

### Register with an MCP client

Add the server to your client's MCP configuration (example for a
`mcpServers` map, as used by Claude Desktop / VS Code / Copilot):

```json
{
  "mcpServers": {
    "asmdb-memory": {
      "command": "node",
      "args": ["C:/Users/you/repo-asmdb/mcp/src/server.js"],
      "env": {
        "ASMDB_EXE": "C:/Users/you/repo-asmdb/build/asmdb.exe",
        "ASMDB_DIR": "C:/Users/you/.asmdb",
        "ASMDB_DB": "agentmem"
      }
    }
  }
}
```

Once connected, the agent can call e.g. `memory_store` with
`{ "key": "user.timezone", "content": "Europe/Paris", "tag": "profile" }`, then
later `memory_recall` with `{ "key": "user.timezone" }` to get it back — durably,
across restarts, from an assembly database that fits in a cache line ×4.

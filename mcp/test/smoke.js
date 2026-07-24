// smoke.js - end-to-end test of the asmdb MCP server via the SDK client.
// Spawns server.js (which spawns asmdb.exe) over stdio, calls each tool, and
// asserts on the results. Uses a throwaway data dir. Exits non-zero on failure.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const server = resolve(__dirname, "..", "src", "server.js");
const exe = resolve(__dirname, "..", "..", "build", "asmdb.exe");

if (!existsSync(exe)) {
  console.error(`engine missing: ${exe} - build it first`);
  process.exit(2);
}

const dataDir = mkdtempSync(join(tmpdir(), "asmdb-mcp-"));
let fails = 0;
const check = (name, cond) => {
  console.log(`  [${cond ? "PASS" : "FAIL"}] ${name}`);
  if (!cond) fails++;
};
const parse = (res) => JSON.parse(res.content[0].text);

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [server],
  env: { ...process.env, ASMDB_EXE: exe, ASMDB_DIR: dataDir, ASMDB_DB: "testmem" },
});
const client = new Client({ name: "asmdb-mcp-test", version: "1.0.0" });

try {
  await client.connect(transport);

  const tools = (await client.listTools()).tools.map((t) => t.name).sort();
  check(
    "exposes the CRUD tool set",
    ["db_count", "db_delete", "db_find", "db_get", "db_insert", "db_list", "db_update"]
      .every((t) => tools.includes(t))
  );

  // Address rows by string key (hashed to the id) - the agent-memory pattern.
  const s1 = parse(
    await client.callTool({
      name: "db_insert",
      arguments: {
        key: "user.name",
        content: "The user prefers to be called Fred",
        tag: "profile",
        value: 1,
      },
    })
  );
  check("insert by key creates a row", s1.ok && s1.action === "inserted");

  const dup = parse(
    await client.callTool({
      name: "db_insert",
      arguments: { key: "user.name", content: "dup", tag: "profile" },
    })
  );
  check("insert without upsert rejects a duplicate", dup.ok === false && /exists/i.test(dup.error));

  const s2 = parse(
    await client.callTool({
      name: "db_insert",
      arguments: { key: "user.name", content: "The user goes by Fred G", tag: "profile", upsert: true },
    })
  );
  check("insert with upsert overwrites the row", s2.ok && s2.action === "updated" && s2.id === s1.id);

  // Address a row by explicit numeric id - the generic-DB pattern.
  const s3 = parse(
    await client.callTool({
      name: "db_insert",
      arguments: { id: 42, content: "asmdb is written in x86-64 assembly with NASM", tag: "project" },
    })
  );
  check("insert by numeric id creates a row", s3.ok && s3.id === "42");

  const upd = parse(
    await client.callTool({ name: "db_update", arguments: { id: 42, content: "asmdb: a DB in assembly", tag: "project", value: 7 } })
  );
  check("update by id succeeds", upd.ok && upd.action === "updated");

  const r = parse(await client.callTool({ name: "db_get", arguments: { key: "user.name" } }));
  check("get returns updated content", r.found && /Fred G/.test(r.content));
  check("get has timestamps", Number.isFinite(r.created) && Number.isFinite(r.updated));

  const search = parse(
    await client.callTool({ name: "db_find", arguments: { query: "assembly" } })
  );
  check("find matches the project row", search.count === 1 && /assembly/i.test(search.matches[0].content));

  const list = parse(await client.callTool({ name: "db_list", arguments: {} }));
  check("list returns both rows", list.count === 2);

  const cnt = parse(await client.callTool({ name: "db_count", arguments: {} }));
  check("count returns two", cnt.ok && cnt.count === 2);

  const del = parse(await client.callTool({ name: "db_delete", arguments: { key: "user.name" } }));
  check("delete removes the row", del.deleted === true);

  const gone = parse(await client.callTool({ name: "db_get", arguments: { key: "user.name" } }));
  check("get after delete is not found", gone.found === false);
} catch (err) {
  console.error("test error:", err);
  fails++;
} finally {
  await client.close().catch(() => {});
  // Best-effort cleanup: the engine may take a moment to release the data
  // files after the client disconnects. Retry, then give up quietly - a
  // leftover temp dir must never fail the test run.
  for (let i = 0; i < 30; i++) {
    try {
      rmSync(dataDir, { recursive: true, force: true });
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
}

if (fails > 0) {
  console.log(`\n${fails} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll MCP checks passed.");

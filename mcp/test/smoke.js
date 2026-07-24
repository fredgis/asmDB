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
    "exposes five memory tools",
    ["memory_delete", "memory_list", "memory_recall", "memory_search", "memory_store"]
      .every((t) => tools.includes(t))
  );

  const s1 = parse(
    await client.callTool({
      name: "memory_store",
      arguments: {
        key: "user.name",
        content: "The user prefers to be called Fred",
        tag: "profile",
        value: 1,
      },
    })
  );
  check("store inserts", s1.ok && s1.action === "inserted");

  const s2 = parse(
    await client.callTool({
      name: "memory_store",
      arguments: { key: "user.name", content: "The user goes by Fred G", tag: "profile" },
    })
  );
  check("re-store updates same key", s2.ok && s2.action === "updated" && s2.id === s1.id);

  await client.callTool({
    name: "memory_store",
    arguments: {
      key: "project.stack",
      content: "asmdb is written in x86-64 assembly with NASM",
      tag: "project",
    },
  });

  const r = parse(await client.callTool({ name: "memory_recall", arguments: { key: "user.name" } }));
  check("recall returns updated content", r.found && /Fred G/.test(r.content));
  check("recall has timestamps", Number.isFinite(r.created) && Number.isFinite(r.updated));

  const search = parse(
    await client.callTool({ name: "memory_search", arguments: { query: "assembly" } })
  );
  check("search finds project memory", search.count === 1 && /assembly/i.test(search.matches[0].content));

  const list = parse(await client.callTool({ name: "memory_list", arguments: {} }));
  check("list returns two memories", list.count === 2);

  const del = parse(await client.callTool({ name: "memory_delete", arguments: { key: "user.name" } }));
  check("delete removes the key", del.deleted === true);

  const gone = parse(await client.callTool({ name: "memory_recall", arguments: { key: "user.name" } }));
  check("recall after delete is not found", gone.found === false);
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

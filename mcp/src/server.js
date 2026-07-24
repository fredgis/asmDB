#!/usr/bin/env node
// server.js - Model Context Protocol server backed by asmdb.
//
// Exposes the asmdb transactional engine over MCP as a generic CRUD store:
// db_insert / db_update / db_get / db_delete / db_find / db_list / db_count.
// Rows are addressed by a numeric `id` (u64) or a string `key` that the server
// hashes to the id with FNV-1a, so the engine stays a pure id-keyed store with
// no secondary string index. tag = category/namespace, value = numeric
// payload/score, content = free text; created/updated timestamps are automatic.
//
// Agent memory is one example use case (key = memory name, tag = namespace,
// content = the remembered text) - not the only one.
//
// Configuration (environment variables):
//   ASMDB_EXE  path to asmdb.exe      (default: ../../build/asmdb.exe)
//   ASMDB_DIR  directory for data     (default: ~/.asmdb)
//   ASMDB_DB   database base name     (default: asmdb)

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { existsSync, mkdirSync } from "node:fs";

import {
  AsmdbSession,
  keyToId,
  sanitizeTag,
  sanitizeContent,
  parseTable,
  parseDetail,
} from "./asmdb.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const EXE =
  process.env.ASMDB_EXE || resolve(__dirname, "..", "..", "build", "asmdb.exe");
const DIR = process.env.ASMDB_DIR || join(homedir(), ".asmdb");
const DB = process.env.ASMDB_DB || "asmdb";

if (!existsSync(EXE)) {
  console.error(`[asmdb-mcp] engine not found at ${EXE}`);
  console.error("[asmdb-mcp] build it first: powershell -File build.ps1");
  process.exit(1);
}
if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true });

const session = new AsmdbSession(EXE, DB, DIR);
await session.ready; // consume the banner

const ok = (text) => ({ content: [{ type: "text", text }] });
const json = (obj) => ok(JSON.stringify(obj, null, 2));

const server = new McpServer({ name: "asmdb", version: "1.0.0" });

// Resolve a record id from either an explicit numeric `id` (u64) or a string
// `key` hashed with FNV-1a. Returns { id } (decimal string) or { error }.
function resolveId({ id, key }) {
  if (id !== undefined && id !== null && `${id}`.trim() !== "") {
    const s = `${id}`.trim();
    if (!/^\d+$/.test(s)) {
      return { error: `invalid id "${s}" - expected a non-negative integer (use \`key\` for huge/string ids)` };
    }
    const n = BigInt(s);
    if (n === 0n) return { error: "id 0 is reserved - use id >= 1 or a string key" };
    if (n >= 1n << 64n) return { error: `id "${s}" exceeds the u64 range` };
    return { id: s };
  }
  if (key !== undefined && key !== null && `${key}` !== "") {
    return { id: keyToId(key) };
  }
  return { error: "provide either `id` (integer) or `key` (string)" };
}

// Shared id/key selector for every record-addressed tool.
const idKey = {
  id: z
    .union([z.number().int(), z.string()])
    .optional()
    .describe("numeric primary key (u64) - provide this or `key`"),
  key: z
    .string()
    .optional()
    .describe("string key hashed to the id with FNV-1a - provide this or `id`"),
};

server.registerTool(
  "db_insert",
  {
    title: "Insert a row",
    description:
      "Insert a new row into asmdb. Address it by `id` (u64) or `key` " +
      "(string, hashed to the id). `content` is free text (<=175 chars), " +
      "`tag` a short single-word category/namespace, `value` an optional " +
      "numeric payload/score. Set `upsert:true` to overwrite instead of " +
      "erroring when the row already exists. Example use - agent memory: " +
      "key = the memory name, tag = namespace, content = the remembered text.",
    inputSchema: {
      ...idKey,
      content: z.string().optional().describe("free text payload (<=175 chars)"),
      tag: z.string().optional().describe("short category / namespace (single word)"),
      value: z.number().optional().describe("optional numeric payload / score (default 0)"),
      upsert: z.boolean().optional().describe("overwrite an existing row instead of erroring"),
    },
  },
  async ({ id, key, content, tag, value, upsert }) => {
    const r = resolveId({ id, key });
    if (r.error) return json({ ok: false, error: r.error });
    const t = sanitizeTag(tag);
    const c = sanitizeContent(content);
    const v = Number.isFinite(value) ? Math.trunc(value) : 0;
    let out = await session.command(`INSERT ${r.id} ${v} ${t} ${c}`);
    let action = "inserted";
    if (/already exists/i.test(out)) {
      if (!upsert) return json({ ok: false, error: "row already exists", id: r.id });
      out = await session.command(`UPDATE ${r.id} ${v} ${t} ${c}`);
      action = "updated";
    }
    if (/\[ERR\]/.test(out)) return json({ ok: false, error: out.trim(), id: r.id });
    return json({ ok: true, action, id: r.id, tag: t, value: v });
  }
);

server.registerTool(
  "db_update",
  {
    title: "Update a row",
    description:
      "Overwrite an existing row's value, tag and content. Address it by " +
      "`id` or `key`. Fails if the row does not exist (use db_insert with " +
      "upsert to create-or-update).",
    inputSchema: {
      ...idKey,
      content: z.string().optional().describe("new free text payload (<=175 chars)"),
      tag: z.string().optional().describe("new category / namespace (single word)"),
      value: z.number().optional().describe("new numeric payload / score (default 0)"),
    },
  },
  async ({ id, key, content, tag, value }) => {
    const r = resolveId({ id, key });
    if (r.error) return json({ ok: false, error: r.error });
    const t = sanitizeTag(tag);
    const c = sanitizeContent(content);
    const v = Number.isFinite(value) ? Math.trunc(value) : 0;
    const out = await session.command(`UPDATE ${r.id} ${v} ${t} ${c}`);
    if (/not found/i.test(out)) return json({ ok: false, found: false, id: r.id });
    if (/\[ERR\]/.test(out)) return json({ ok: false, error: out.trim(), id: r.id });
    return json({ ok: true, action: "updated", id: r.id, tag: t, value: v });
  }
);

server.registerTool(
  "db_get",
  {
    title: "Get one row",
    description:
      "Fetch a single row by `id` or `key`, with its value, tag, content " +
      "and created/updated timestamps.",
    inputSchema: { ...idKey },
  },
  async ({ id, key }) => {
    const r = resolveId({ id, key });
    if (r.error) return json({ ok: false, error: r.error });
    const out = await session.command(`SELECT ${r.id}`);
    if (/not found/i.test(out)) return json({ ok: true, found: false, id: r.id });
    const rec = parseDetail(out);
    if (!rec) return ok(out.trim());
    return json({ ok: true, found: true, ...rec });
  }
);

server.registerTool(
  "db_delete",
  {
    title: "Delete a row",
    description: "Remove the row addressed by `id` or `key`, if it exists.",
    inputSchema: { ...idKey },
  },
  async ({ id, key }) => {
    const r = resolveId({ id, key });
    if (r.error) return json({ ok: false, error: r.error });
    const out = await session.command(`DELETE ${r.id}`);
    const deleted = /1 row deleted/i.test(out);
    return json({ ok: true, deleted, id: r.id });
  }
);

server.registerTool(
  "db_find",
  {
    title: "Search rows",
    description:
      "Case-insensitive substring search across every row's tag and " +
      "content. Returns all matching rows.",
    inputSchema: {
      query: z.string().min(1).describe("substring to look for"),
    },
  },
  async ({ query }) => {
    const q = sanitizeContent(query);
    const out = await session.command(`FIND ${q}`);
    const rows = parseTable(out);
    return json({ ok: true, query: q, count: rows.length, matches: rows });
  }
);

server.registerTool(
  "db_list",
  {
    title: "List all rows",
    description: "Return every live row (id, tag, value, content).",
    inputSchema: {},
  },
  async () => {
    const out = await session.command("SELECT *");
    const rows = parseTable(out);
    return json({ ok: true, count: rows.length, rows });
  }
);

server.registerTool(
  "db_count",
  {
    title: "Count rows",
    description: "Return the number of live rows in the database.",
    inputSchema: {},
  },
  async () => {
    const out = await session.command("COUNT");
    const m = out.match(/\[\s*OK\s*\]\s*(\d+)/);
    return json({ ok: true, count: m ? Number(m[1]) : null });
  }
);

async function shutdown() {
  if (shutdown.called) return;
  shutdown.called = true;
  await session.close();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
// When the MCP client disconnects, our stdin is closed. Shut the engine down
// gracefully so we never leave an orphaned asmdb.exe holding the data files.
process.stdin.on("end", shutdown);
process.stdin.on("close", shutdown);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`[asmdb-mcp] ready - engine ${EXE}, db ${join(DIR, DB)}.dat`);

#!/usr/bin/env node
// server.js - Model Context Protocol server backed by asmdb.
//
// Exposes asmdb as durable long-term memory for an AI agent. Each memory is
// addressed by a free-text `key`; the server hashes the key to asmdb's u64
// primary id (FNV-1a), so the engine stays a pure id-keyed store and needs no
// secondary string index. tag = category/namespace, value = numeric score,
// content = the remembered text. created/updated timestamps are automatic.
//
// Configuration (environment variables):
//   ASMDB_EXE  path to asmdb.exe      (default: ../../build/asmdb.exe)
//   ASMDB_DIR  directory for data     (default: ~/.asmdb)
//   ASMDB_DB   database base name     (default: agentmem)

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
const DB = process.env.ASMDB_DB || "agentmem";

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

const server = new McpServer({ name: "asmdb-memory", version: "1.0.0" });

server.registerTool(
  "memory_store",
  {
    title: "Store a memory",
    description:
      "Store or overwrite a memory in asmdb. `key` is a stable free-text " +
      "handle (hashed to the record id), `content` is the text to remember " +
      "(<=175 chars), `tag` is a short single-word category, and `value` is " +
      "an optional numeric score. Re-storing the same key updates it.",
    inputSchema: {
      key: z.string().min(1).describe("stable identifier for this memory"),
      content: z.string().describe("the text to remember"),
      tag: z
        .string()
        .optional()
        .describe("short category / namespace (single word)"),
      value: z
        .number()
        .optional()
        .describe("optional numeric score or weight (default 0)"),
    },
  },
  async ({ key, content, tag, value }) => {
    const id = keyToId(key);
    const t = sanitizeTag(tag);
    const c = sanitizeContent(content);
    const v = Number.isFinite(value) ? Math.trunc(value) : 0;
    let out = await session.command(`INSERT ${id} ${v} ${t} ${c}`);
    let action = "inserted";
    if (/already exists/i.test(out)) {
      out = await session.command(`UPDATE ${id} ${v} ${t} ${c}`);
      action = "updated";
    }
    if (/\[ERR\]/.test(out)) {
      return ok(`error storing "${key}": ${out.trim()}`);
    }
    return json({ ok: true, action, key, id, tag: t, value: v });
  }
);

server.registerTool(
  "memory_recall",
  {
    title: "Recall a memory by key",
    description:
      "Retrieve a single memory by its exact `key`, including its content, " +
      "tag, numeric value and created/updated timestamps.",
    inputSchema: {
      key: z.string().min(1).describe("the key used when the memory was stored"),
    },
  },
  async ({ key }) => {
    const id = keyToId(key);
    const out = await session.command(`SELECT ${id}`);
    if (/key not found/i.test(out)) {
      return json({ ok: false, found: false, key });
    }
    const rec = parseDetail(out);
    if (!rec) return ok(out.trim());
    return json({ ok: true, found: true, key, ...rec });
  }
);

server.registerTool(
  "memory_search",
  {
    title: "Search memories",
    description:
      "Case-insensitive substring search across every memory's tag and " +
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
  "memory_list",
  {
    title: "List all memories",
    description: "Return every stored memory (id, tag, value, content).",
    inputSchema: {},
  },
  async () => {
    const out = await session.command("SELECT *");
    const rows = parseTable(out);
    return json({ ok: true, count: rows.length, memories: rows });
  }
);

server.registerTool(
  "memory_delete",
  {
    title: "Delete a memory by key",
    description: "Remove the memory addressed by `key`, if it exists.",
    inputSchema: {
      key: z.string().min(1).describe("the key of the memory to delete"),
    },
  },
  async ({ key }) => {
    const id = keyToId(key);
    const out = await session.command(`DELETE ${id}`);
    const deleted = /1 row deleted/i.test(out);
    return json({ ok: true, deleted, key, id });
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

#!/usr/bin/env node
// server.js - Model Context Protocol server backed by asmdb.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { homedir, platform } from "node:os";
import { existsSync, mkdirSync } from "node:fs";

import {
  AsmdbSession,
  I64_MAX,
  I64_MIN,
  U64_MAX,
  engineError,
  keyToId,
  okStatus,
  parseDecimalInRange,
  parseTsvRows,
} from "./asmdb.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ENGINE_NAME = platform() === "win32" ? "asmdb.exe" : "asmdb";
const EXE = process.env.ASMDB_EXE || resolve(__dirname, "..", "..", "build", ENGINE_NAME);
const DIR = process.env.ASMDB_DIR || join(homedir(), ".asmdb");
const DB = process.env.ASMDB_DB || "asmdb";
const SERVER_VERSION = "1.2.0";
// The engine stores 40- and 176-byte columns but reserves the last byte of
// each as a terminator, so the usable payload is 39 and 175 bytes. Anything
// longer is refused by the engine, not truncated.
const TAG_MAX_BYTES = 39;
const CONTENT_MAX_BYTES = 175;
const KEY_PREFIX = "\\asmdb-key:";
const KEY_DELIM = ";";

if (!existsSync(EXE)) {
  console.error(`[asmdb-mcp] engine not found at ${EXE}`);
  const buildHint =
    platform() === "win32"
      ? "build it first: powershell -ExecutionPolicy Bypass -File build.ps1"
      : "build it first from the repository root (for example: ./build.sh or make)";
  console.error(`[asmdb-mcp] ${buildHint}`);
  process.exit(1);
}
if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true });

const session = new AsmdbSession(EXE, DB, DIR);
await session.ready;
const formatOut = await session.command("FORMAT TSV");
if (engineError(formatOut)) {
  console.error(`[asmdb-mcp] warning: engine did not accept FORMAT TSV: ${engineError(formatOut)}`);
}

const ok = (text) => ({ content: [{ type: "text", text }] });
const json = (obj) => ok(JSON.stringify(obj, null, 2));
const fail = (errorKind, error, extra = {}) => json({ ok: false, errorKind, error, ...extra });
const success = (obj) => json({ ok: true, ...obj });

const server = new McpServer({ name: "asmdb", version: SERVER_VERSION });

function hasInvalidUtf16(s) {
  return /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(s);
}

function validateUtf8Text(value, label, maxBytes, { token = false, allowEmpty = true } = {}) {
  const s = String(value ?? "");
  if (!allowEmpty && s.length === 0) throw new Error(`${label} must not be empty`);
  if (hasInvalidUtf16(s)) throw new Error(`${label} must be valid UTF-8 text`);
  if (/[\0\r\n\t]/.test(s)) throw new Error(`${label} must not contain NUL, TAB, LF or CR`);
  if (token && /\s/u.test(s)) throw new Error(`${label} must not contain whitespace`);
  if (maxBytes !== undefined) {
    const bytes = Buffer.byteLength(s, "utf8");
    if (bytes > maxBytes) throw new Error(`${label} is ${bytes} bytes; limit is ${maxBytes} UTF-8 bytes`);
  }
  return s;
}

function cleanTag(tag) {
  return validateUtf8Text(tag ?? "-", "tag", TAG_MAX_BYTES, { token: true, allowEmpty: false });
}

function cleanContent(content) {
  return validateUtf8Text(content ?? "", "content", CONTENT_MAX_BYTES);
}

function base64url(s) {
  return Buffer.from(s, "utf8").toString("base64url");
}

function unbase64url(s) {
  return Buffer.from(s, "base64url").toString("utf8");
}

function makeStoredContent(content, key) {
  if (key === undefined || key === null) return content;
  const prefix = `${KEY_PREFIX}${base64url(String(key))}${KEY_DELIM}`;
  const stored = prefix + content;
  const bytes = Buffer.byteLength(stored, "utf8");
  if (bytes > CONTENT_MAX_BYTES) {
    throw new Error(
      `content plus key metadata is ${bytes} bytes; keyed rows are limited to ${CONTENT_MAX_BYTES} UTF-8 bytes in the engine`
    );
  }
  return stored;
}

function decodeStoredContent(content) {
  if (!content.startsWith(KEY_PREFIX)) return { content };
  const end = content.indexOf(KEY_DELIM, KEY_PREFIX.length);
  if (end === -1) return { content };
  const encoded = content.slice(KEY_PREFIX.length, end);
  try {
    return { key: unbase64url(encoded), content: content.slice(end + KEY_DELIM.length) };
  } catch {
    return { content };
  }
}

function presentRow(row) {
  const decoded = decodeStoredContent(row.content);
  return { ...row, content: decoded.content };
}

function verifyKey(row, expectedKey) {
  if (expectedKey === undefined || expectedKey === null) return { row: presentRow(row) };
  const decoded = decodeStoredContent(row.content);
  if (decoded.key !== String(expectedKey)) {
    return {
      errorKind: "keyCollision",
      error: "stored key metadata does not match the requested key; refusing to return a colliding row",
    };
  }
  return { row: { ...row, content: decoded.content } };
}

function parseIdInput(id) {
  if (typeof id === "number") {
    if (!Number.isSafeInteger(id)) throw new Error("id numbers must be safe integers; pass large ids as decimal strings");
    if (id <= 0) throw new Error("id 0 is reserved - use id >= 1 or a string key");
    return parseDecimalInRange(String(id), 1n, U64_MAX, "id");
  }
  return parseDecimalInRange(String(id).trim(), 1n, U64_MAX, "id");
}

function parseValueInput(value) {
  if (value === undefined || value === null || value === "") return "0";
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new Error("value numbers must be safe integers; pass large values as decimal strings");
    return parseDecimalInRange(String(value), I64_MIN, I64_MAX, "value");
  }
  return parseDecimalInRange(String(value).trim(), I64_MIN, I64_MAX, "value");
}

function resolveId({ id, key }) {
  if (id !== undefined && id !== null && `${id}`.trim() !== "") return { id: parseIdInput(id) };
  if (key !== undefined && key !== null && `${key}` !== "") return { id: keyToId(key), key: String(key) };
  throw new Error("provide either `id` (u64 decimal string) or `key` (string)");
}

function parseLimitOffset({ limit = 100, offset = 0 }) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
    throw new Error("limit must be an integer from 1 through 1000");
  }
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("offset must be a non-negative safe integer");
  return { limit, offset };
}

async function engine(command) {
  const out = await session.command(command);
  const err = engineError(out);
  if (err) throw Object.assign(new Error(err), { engine: true });
  return out;
}

async function setPage(limit, offset) {
  const out = await engine(`PAGE ${limit} ${offset}`);
  if (!okStatus(out)) throw new Error("engine did not confirm PAGE setting");
}

async function selectRow(id) {
  const out = await session.command(`SELECT ${id}`);
  const err = engineError(out);
  if (err && /not found/i.test(err)) return null;
  if (err) throw Object.assign(new Error(err), { engine: true });
  const rows = parseTsvRows(out);
  if (rows.length > 1) throw new Error("engine returned more than one row for SELECT id");
  return rows[0] ?? null;
}

async function transactional(fn) {
  await engine("BEGIN");
  try {
    const result = await fn();
    await engine("COMMIT");
    return result;
  } catch (err) {
    try {
      await session.command("ROLLBACK");
    } catch {
      /* best effort */
    }
    throw err;
  }
}

function mapError(err, id) {
  const msg = err?.message || String(err);
  if (err?.errorKind) return fail(err.errorKind, msg, id ? { id } : {});
  if (/not found/i.test(msg)) return fail("notFound", msg, id ? { id } : {});
  if (/already exists/i.test(msg)) return fail("alreadyExists", msg, id ? { id } : {});
  if (/timed out/i.test(msg)) return fail("timeout", msg, id ? { id } : {});
  if (/exceeded output cap/i.test(msg)) return fail("outputTooLarge", msg, id ? { id } : {});
  if (err?.engine) return fail("engineError", msg, id ? { id } : {});
  return fail("invalidArgument", msg, id ? { id } : {});
}

const idKey = {
  id: z
    .union([z.number(), z.string()])
    .optional()
    .describe("primary key as a u64 decimal string; JS safe-integer numbers are accepted for small ids"),
  key: z.string().optional().describe("string key hashed to the id with FNV-1a and verified on read"),
};
const valueSchema = z
  .union([z.number(), z.string()])
  .optional()
  .describe("i64 decimal string; JS safe-integer numbers are accepted for small values");
const pageSchema = {
  limit: z.number().int().min(1).max(1000).optional().describe("maximum rows to return (default 100, max 1000)"),
  offset: z.number().int().min(0).optional().describe("zero-based row offset (default 0)"),
};

server.registerTool(
  "db_insert",
  {
    title: "Insert a row",
    description: "Insert a row addressed by u64 `id` or string `key`. Set `upsert:true` for atomic create-or-update.",
    inputSchema: {
      ...idKey,
      content: z.string().optional().describe("UTF-8 text payload (176 engine bytes max; keyed rows reserve metadata bytes)"),
      tag: z.string().optional().describe("UTF-8 tag token (40 bytes max, no whitespace)"),
      value: valueSchema,
      upsert: z.boolean().optional().describe("atomically update an existing row instead of failing"),
    },
  },
  async ({ id, key, content, tag, value, upsert }) => {
    let r;
    try {
      r = resolveId({ id, key });
      const t = cleanTag(tag);
      const c = makeStoredContent(cleanContent(content), r.key);
      const v = parseValueInput(value);
      let action = "inserted";
      if (upsert) {
        action = await transactional(async () => {
          const insertOut = await session.command(`INSERT ${r.id} ${v} ${t} ${c}`);
          const insertErr = engineError(insertOut);
          if (!insertErr) return "inserted";
          if (!/already exists/i.test(insertErr)) throw Object.assign(new Error(insertErr), { engine: true });
          if (r.key) {
            const existing = await selectRow(r.id);
            const verified = existing && verifyKey(existing, r.key);
            if (!verified || verified.errorKind) {
              throw Object.assign(new Error(verified?.error || "key collision"), { errorKind: "keyCollision" });
            }
          }
          await engine(`UPDATE ${r.id} ${v} ${t} ${c}`);
          return "updated";
        });
      } else {
        const insertOut = await session.command(`INSERT ${r.id} ${v} ${t} ${c}`);
        const insertErr = engineError(insertOut);
        if (insertErr && /already exists/i.test(insertErr) && r.key) {
          const existing = await selectRow(r.id);
          const verified = existing && verifyKey(existing, r.key);
          if (verified?.errorKind) return fail(verified.errorKind, verified.error, { id: r.id });
        }
        if (insertErr) throw Object.assign(new Error(insertErr), { engine: true });
      }
      return success({ action, id: r.id, tag: t, value: v });
    } catch (err) {
      return mapError(err, r?.id);
    }
  }
);

server.registerTool(
  "db_update",
  {
    title: "Update a row",
    description: "Overwrite an existing row addressed by `id` or `key`.",
    inputSchema: {
      ...idKey,
      content: z.string().optional().describe("UTF-8 text payload (176 engine bytes max; keyed rows reserve metadata bytes)"),
      tag: z.string().optional().describe("UTF-8 tag token (40 bytes max, no whitespace)"),
      value: valueSchema,
    },
  },
  async ({ id, key, content, tag, value }) => {
    let r;
    try {
      r = resolveId({ id, key });
      const t = cleanTag(tag);
      const c = makeStoredContent(cleanContent(content), r.key);
      const v = parseValueInput(value);
      if (r.key) {
        const existing = await selectRow(r.id);
        if (!existing) return fail("notFound", "key not found", { id: r.id });
        const verified = verifyKey(existing, r.key);
        if (verified.errorKind) return fail(verified.errorKind, verified.error, { id: r.id });
      }
      await engine(`UPDATE ${r.id} ${v} ${t} ${c}`);
      return success({ action: "updated", id: r.id, tag: t, value: v });
    } catch (err) {
      return mapError(err, r?.id);
    }
  }
);

server.registerTool(
  "db_get",
  {
    title: "Get one row",
    description: "Fetch a single row by `id` or verified string `key`.",
    inputSchema: { ...idKey },
  },
  async ({ id, key }) => {
    let r;
    try {
      r = resolveId({ id, key });
      const out = await session.command(`SELECT ${r.id}`);
      const err = engineError(out);
      if (err && /not found/i.test(err)) return success({ found: false, id: r.id, record: null });
      if (err) throw Object.assign(new Error(err), { engine: true });
      const row = parseTsvRows(out)[0] ?? null;
      if (!row) throw new Error("engine returned no TSV row for an existing id");
      const verified = verifyKey(row, r.key);
      if (verified.errorKind) return fail(verified.errorKind, verified.error, { id: r.id });
      return success({ found: true, ...verified.row, record: verified.row });
    } catch (err) {
      return mapError(err, r?.id);
    }
  }
);

server.registerTool(
  "db_delete",
  {
    title: "Delete a row",
    description: "Remove the row addressed by `id` or `key`.",
    inputSchema: { ...idKey },
  },
  async ({ id, key }) => {
    let r;
    try {
      r = resolveId({ id, key });
      if (r.key) {
        const row = await selectRow(r.id);
        if (!row) return success({ deleted: false, id: r.id });
        const verified = verifyKey(row, r.key);
        if (verified.errorKind) return fail(verified.errorKind, verified.error, { id: r.id });
      }
      const out = await engine(`DELETE ${r.id}`);
      const deleted = /1 row deleted/i.test(out);
      return success({ deleted, id: r.id });
    } catch (err) {
      return mapError(err, r?.id);
    }
  }
);

server.registerTool(
  "db_find",
  {
    title: "Search rows",
    description: "Case-insensitive substring search over tag and content, with mandatory pagination.",
    inputSchema: {
      query: z.string().min(1).describe("UTF-8 substring to look for"),
      ...pageSchema,
    },
  },
  async ({ query, limit, offset }) => {
    try {
      const page = parseLimitOffset({ limit, offset });
      const q = validateUtf8Text(query, "query", undefined, { allowEmpty: false });
      await setPage(page.limit, page.offset);
      const rows = parseTsvRows(await engine(`FIND ${q}`)).map(presentRow);
      const hasMore = rows.length === page.limit;
      return success({
        query: q,
        count: rows.length,
        matches: rows,
        limit: page.limit,
        offset: page.offset,
        hasMore,
        nextOffset: hasMore ? page.offset + page.limit : null,
      });
    } catch (err) {
      return mapError(err);
    }
  }
);

server.registerTool(
  "db_list",
  {
    title: "List rows",
    description: "Return live rows with mandatory pagination.",
    inputSchema: { ...pageSchema },
  },
  async ({ limit, offset }) => {
    try {
      const page = parseLimitOffset({ limit, offset });
      await setPage(page.limit, page.offset);
      const rows = parseTsvRows(await engine("SELECT *")).map(presentRow);
      const hasMore = rows.length === page.limit;
      return success({
        count: rows.length,
        rows,
        limit: page.limit,
        offset: page.offset,
        hasMore,
        nextOffset: hasMore ? page.offset + page.limit : null,
      });
    } catch (err) {
      return mapError(err);
    }
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
    try {
      const out = await engine("COUNT");
      const m = out.match(/\[\s*OK\s*\]\s*(\d+)/);
      if (!m) throw new Error("could not parse COUNT response");
      return success({ count: Number(m[1]) });
    } catch (err) {
      return mapError(err);
    }
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
process.stdin.on("end", shutdown);
process.stdin.on("close", shutdown);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`[asmdb-mcp ${SERVER_VERSION}] ready - engine ${EXE}, db ${join(DIR, DB)}.dat`);

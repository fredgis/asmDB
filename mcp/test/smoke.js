// smoke.js - end-to-end test of the asmdb MCP server via the SDK client.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { platform } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const mcpRoot = resolve(__dirname, "..");
const server = resolve(mcpRoot, "src", "server.js");
const exeName = platform() === "win32" ? "asmdb.exe" : "asmdb";
const exe = resolve(mcpRoot, "..", "build", exeName);

if (!existsSync(exe)) {
  console.error(`engine missing: ${exe} - build it first`);
  process.exit(2);
}

const smokeRoot = resolve(mcpRoot, ".smoke-data");
mkdirSync(smokeRoot, { recursive: true });
const dataDir = mkdtempSync(join(smokeRoot, "run-"));
let fails = 0;
let skips = 0;
const check = (name, cond) => {
  console.log(`  [${cond ? "PASS" : "FAIL"}] ${name}`);
  if (!cond) fails++;
};
const skip = (name, reason) => {
  console.log(`  [SKIP] ${name} - ${reason}`);
  skips++;
};
const parse = (res) => JSON.parse(res.content[0].text);

async function probeTsv() {
  return new Promise((resolveProbe) => {
    const child = spawn(exe, ["probe"], { cwd: dataDir, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    let out = "";
    let sent = false;
    const done = (ok) => {
      child.kill();
      resolveProbe(ok);
    };
    const timer = setTimeout(() => done(false), 5000);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (d) => {
      out += d;
      if (!sent && out.includes("asmdb> ")) {
        sent = true;
        child.stdin.write("FORMAT TSV\nEXIT\n");
      }
      if (/\[\s*OK\s*\]/.test(out) || /\[\s*ERR\s*\]/.test(out)) {
        clearTimeout(timer);
        done(/\[\s*OK\s*\]/.test(out));
      }
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolveProbe(false);
    });
  });
}

const tsvAvailable = await probeTsv();

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [server],
  env: { ...process.env, ASMDB_EXE: exe, ASMDB_DIR: dataDir, ASMDB_DB: "testmem" },
});
const client = new Client({ name: "asmdb-mcp-test", version: "1.1.0" });

try {
  await client.connect(transport);

  const tools = (await client.listTools()).tools.map((t) => t.name).sort();
  check(
    "exposes the CRUD tool set",
    ["db_count", "db_delete", "db_find", "db_get", "db_insert", "db_list", "db_update"].every((t) =>
      tools.includes(t)
    )
  );

  const s1 = parse(
    await client.callTool({
      name: "db_insert",
      arguments: { key: "user.name", content: "The user prefers to be called Fred", tag: "profile", value: "1" },
    })
  );
  check("insert by key creates a row", s1.ok && s1.action === "inserted" && typeof s1.id === "string");

  const dup = parse(
    await client.callTool({ name: "db_insert", arguments: { key: "user.name", content: "dup", tag: "profile" } })
  );
  check("insert without upsert rejects a duplicate", dup.ok === false && dup.errorKind === "alreadyExists");

  const s2 = parse(
    await client.callTool({
      name: "db_insert",
      arguments: { key: "user.name", content: "The user goes by Fred G", tag: "profile", upsert: true },
    })
  );
  check("insert with upsert overwrites the row", s2.ok && s2.action === "updated" && s2.id === s1.id);

  const s3 = parse(
    await client.callTool({
      name: "db_insert",
      arguments: { id: "42", content: "asmdb is written in x86-64 assembly with NASM", tag: "project" },
    })
  );
  check("insert by numeric id creates a row", s3.ok && s3.id === "42");

  const upd = parse(
    await client.callTool({
      name: "db_update",
      arguments: { id: "42", content: "asmdb: a DB in assembly", tag: "project", value: "7" },
    })
  );
  check("update by id succeeds", upd.ok && upd.action === "updated" && upd.value === "7");

  const cnt = parse(await client.callTool({ name: "db_count", arguments: {} }));
  check("count returns two", cnt.ok && cnt.count === 2);

  if (!tsvAvailable) {
    skip("TSV-dependent read, pagination and UTF-8 checks", "engine does not support FORMAT TSV yet");
  } else {
    const r = parse(await client.callTool({ name: "db_get", arguments: { key: "user.name" } }));
    check("get returns updated content", r.ok && r.found && /Fred G/.test(r.content));
    check("get has timestamps", Number.isFinite(r.created) && Number.isFinite(r.updated));

    const search = parse(await client.callTool({ name: "db_find", arguments: { query: "assembly" } }));
    check("find matches the project row", search.ok && search.count === 1 && /assembly/i.test(search.matches[0].content));

    const list = parse(await client.callTool({ name: "db_list", arguments: {} }));
    check("list returns both rows", list.ok && list.count === 2);

    const longContent = "roundtrip-" + "x".repeat(165);
    const longIns = parse(
      await client.callTool({ name: "db_insert", arguments: { id: "100", tag: "long", content: longContent } })
    );
    check("insert accepts 175-byte content", longIns.ok);
    const longGet = parse(await client.callTool({ name: "db_get", arguments: { id: "100" } }));
    const longFind = parse(await client.callTool({ name: "db_find", arguments: { query: "roundtrip", limit: 10 } }));
    const longList = parse(await client.callTool({ name: "db_list", arguments: { limit: 100 } }));
    check("175-byte content round-trips through get", longGet.ok && longGet.content === longContent);
    check("175-byte content round-trips through find", longFind.ok && longFind.matches.some((m) => m.content === longContent));
    check("175-byte content round-trips through list", longList.ok && longList.rows.some((m) => m.content === longContent));

    const utf8 = "café naïve jalapeño 😀";
    const utfIns = parse(await client.callTool({ name: "db_insert", arguments: { id: "101", tag: "utf8", content: utf8 } }));
    const utfGet = parse(await client.callTool({ name: "db_get", arguments: { id: "101" } }));
    check("UTF-8 content survives unchanged", utfIns.ok && utfGet.ok && utfGet.content === utf8);

    const maxId = "18446744073709551615";
    const minI64 = "-9223372036854775808";
    const maxI64 = "9223372036854775807";
    const extreme1 = parse(
      await client.callTool({ name: "db_insert", arguments: { id: maxId, value: minI64, tag: "extreme", content: "min" } })
    );
    const extremeGet1 = parse(await client.callTool({ name: "db_get", arguments: { id: maxId } }));
    const extreme2 = parse(
      await client.callTool({ name: "db_insert", arguments: { id: "102", value: maxI64, tag: "extreme", content: "max" } })
    );
    const extremeGet2 = parse(await client.callTool({ name: "db_get", arguments: { id: "102" } }));
    check("u64 id and i64 minimum value are strings", extreme1.ok && extremeGet1.id === maxId && extremeGet1.value === minI64);
    check("i64 maximum value is a string", extreme2.ok && extremeGet2.value === maxI64);

    for (let i = 0; i < 5; i++) {
      await client.callTool({ name: "db_insert", arguments: { id: String(200 + i), tag: "page", content: `page-${i}` } });
    }
    const allPage = parse(await client.callTool({ name: "db_find", arguments: { query: "page-", limit: 10, offset: 0 } }));
    const page = parse(await client.callTool({ name: "db_find", arguments: { query: "page-", limit: 2, offset: 1 } }));
    check(
      "pagination returns the right slice and hasMore",
      page.ok &&
        page.hasMore === true &&
        page.nextOffset === 3 &&
        JSON.stringify(page.matches.map((r) => r.id)) === JSON.stringify(allPage.matches.slice(1, 3).map((r) => r.id))
    );

    const badTag = parse(await client.callTool({ name: "db_insert", arguments: { id: "300", tag: "t".repeat(41), content: "x" } }));
    const badContent = parse(
      await client.callTool({ name: "db_insert", arguments: { id: "301", tag: "bad", content: "x".repeat(177) } })
    );
    check("oversize tag is rejected", badTag.ok === false && badTag.errorKind === "invalidArgument");
    check("oversize content is rejected", badContent.ok === false && badContent.errorKind === "invalidArgument");

    const unsafe = parse(
      await client.callTool({ name: "db_get", arguments: { id: 9007199254740992 } })
    );
    check("unsafe numeric id is rejected", unsafe.ok === false && unsafe.errorKind === "invalidArgument");

    const del = parse(await client.callTool({ name: "db_delete", arguments: { key: "user.name" } }));
    check("delete removes the keyed row", del.ok && del.deleted === true);

    const gone = parse(await client.callTool({ name: "db_get", arguments: { key: "user.name" } }));
    check("get after delete is not found", gone.ok && gone.found === false);
  }
} catch (err) {
  console.error("test error:", err);
  fails++;
} finally {
  await client.close().catch(() => {});
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
console.log(`\nAll MCP checks passed.${skips ? ` (${skips} skip group(s).)` : ""}`);

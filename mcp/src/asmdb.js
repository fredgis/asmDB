// asmdb.js - drive a single long-lived asmdb.exe process over stdin/stdout.
//
// asmdb is a REPL: it prints "asmdb> ", reads one command line, prints the
// result, and repeats. We keep ONE process alive for the whole MCP session so
// the 64 MiB record region is read from disk exactly once (at startup); every
// tool call is then an in-memory hash lookup plus a small durable write.
//
// Framing: every command produces exactly one "asmdb> " prompt afterwards, so
// we resolve queued readers FIFO whenever a prompt appears in the stream. DB
// output (tables, [ OK ] / [ERR] lines) never contains the prompt string.

import { spawn } from "node:child_process";

const PROMPT = "asmdb> ";

export class AsmdbSession {
  /**
   * @param {string} exePath  path to asmdb.exe
   * @param {string} dbName   database base name (creates <dbName>.dat/.wal)
   * @param {string} cwd      working directory that holds the data files
   */
  constructor(exePath, dbName, cwd) {
    this.buf = "";
    this.queue = [];
    this.closed = false;
    this.proc = spawn(exePath, [dbName], {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.proc.stdout.setEncoding("utf8");
    this.proc.stdout.on("data", (d) => this._onData(d));
    this.proc.stderr.setEncoding("utf8");
    this.proc.stderr.on("data", () => {});
    this.proc.on("exit", () => {
      this.closed = true;
      while (this.queue.length) this.queue.shift().reject(new Error("asmdb exited"));
    });
    // First waiter consumes the banner + initial prompt.
    this.ready = new Promise((resolve, reject) =>
      this.queue.push({ resolve, reject })
    );
  }

  _onData(chunk) {
    this.buf += chunk;
    // Resolve queued readers FIFO on each prompt. To be robust against DB
    // content that happens to contain the literal "asmdb> ", only treat the
    // prompt as a frame boundary when it starts a line (buffer start or right
    // after a newline) - the engine always emits it at column 0, while any
    // echoed content appears mid-line inside a table cell or detail field.
    while (this.queue.length) {
      let idx = -1;
      let from = 0;
      for (;;) {
        const hit = this.buf.indexOf(PROMPT, from);
        if (hit === -1) break;
        if (hit === 0 || this.buf[hit - 1] === "\n") {
          idx = hit;
          break;
        }
        from = hit + PROMPT.length;
      }
      if (idx === -1) break;
      const segment = this.buf.slice(0, idx);
      this.buf = this.buf.slice(idx + PROMPT.length);
      this.queue.shift().resolve(segment);
    }
  }

  /** Send one command line, resolve with the text printed before the next prompt. */
  command(line) {
    if (this.closed) return Promise.reject(new Error("asmdb session is closed"));
    return new Promise((resolve, reject) => {
      this.queue.push({ resolve, reject });
      this.proc.stdin.write(line + "\n");
    });
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    // Resolve only once the engine has fully exited and released its data
    // files, so callers can safely delete the db directory afterwards.
    const exited = new Promise((resolve) => {
      if (this.proc.exitCode !== null || this.proc.signalCode !== null) {
        resolve();
        return;
      }
      this.proc.once("exit", resolve);
    });
    try {
      this.proc.stdin.write("EXIT\n");
      this.proc.stdin.end();
    } catch {
      /* ignore */
    }
    // Safety net: if the engine does not exit promptly, terminate it so we
    // never leave an orphaned asmdb.exe holding the data files open.
    const killer = setTimeout(() => {
      try {
        this.proc.kill();
      } catch {
        /* ignore */
      }
    }, 2000);
    await exited;
    clearTimeout(killer);
  }
}

/** 64-bit FNV-1a hash of a string key, returned as a decimal string (asmdb id). */
export function keyToId(key) {
  const mask = (1n << 64n) - 1n;
  let h = 1469598103934665603n; // FNV offset basis
  const prime = 1099511628211n;
  for (const byte of Buffer.from(String(key), "utf8")) {
    h ^= BigInt(byte);
    h = (h * prime) & mask;
  }
  if (h === 0n) h = 1n; // never use id 0
  return h.toString(10);
}

/** Collapse a value into a single-token tag (<= 39 chars, no spaces). */
export function sanitizeTag(tag) {
  const t = String(tag || "-")
    .replace(/\s+/g, "_")
    .replace(/[^\x21-\x7e]/g, "")
    .slice(0, 39);
  return t.length ? t : "-";
}

/** Flatten content onto one line and clamp to the engine's 175-byte field. */
export function sanitizeContent(content) {
  return String(content ?? "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/[^\x20-\x7e]/g, "")
    .slice(0, 175);
}

/** Parse a boxed SELECT * / FIND table into [{id, tag, value, content}, ...]. */
export function parseTable(text) {
  const rows = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line.startsWith("|")) continue;
    const cells = line
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split("|")
      .map((c) => c.trim());
    if (cells.length === 4 && /^-?\d+$/.test(cells[0])) {
      rows.push({
        id: cells[0],
        tag: cells[1],
        value: Number(cells[2]),
        content: cells[3].replace(/~$/, ""),
      });
    }
  }
  return rows;
}

/** Parse the SELECT <id> detail block into a record object, or null. */
export function parseDetail(text) {
  const get = (label) => {
    const m = text.match(new RegExp(`^\\s*${label}\\s*:\\s*(.*)$`, "m"));
    return m ? m[1].trim() : null;
  };
  const id = get("id");
  if (id === null) return null;
  const created = get("created");
  const updated = get("updated");
  return {
    id,
    tag: get("tag"),
    value: Number(get("value")),
    created: created ? Number(created.replace(/\s*ms$/, "")) : null,
    updated: updated ? Number(updated.replace(/\s*ms$/, "")) : null,
    content: get("content") ?? "",
  };
}

// asmdb.js - drive a single long-lived asmdb process over stdin/stdout.
//
// The MCP server uses the engine's machine-readable TSV mode. Human table
// output is intentionally not parsed because the table renderer truncates data.

import { spawn } from "node:child_process";

const PROMPT = "asmdb> ";
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
const STDERR_TAIL_BYTES = 8192;

export const U64_MAX = (1n << 64n) - 1n;
export const I64_MIN = -(1n << 63n);
export const I64_MAX = (1n << 63n) - 1n;

function configuredPositiveInt(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n > 0 ? n : fallback;
}

export class AsmdbSession {
  /**
   * @param {string} exePath  path to asmdb executable
   * @param {string} dbName   database base name (creates <dbName>.dat/.wal)
   * @param {string} cwd      working directory that holds the data files
   */
  constructor(exePath, dbName, cwd) {
    this.buf = "";
    this.queue = [];
    this.closed = false;
    this.discardFrames = 0;
    this.stderrTail = "";
    this.timeoutMs = configuredPositiveInt("ASMDB_TIMEOUT_MS", DEFAULT_TIMEOUT_MS);
    this.maxOutputBytes = configuredPositiveInt("ASMDB_MAX_OUTPUT_BYTES", DEFAULT_MAX_OUTPUT_BYTES);

    this.proc = spawn(exePath, [dbName], {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.proc.stdout.setEncoding("utf8");
    this.proc.stdout.on("data", (d) => this._onData(d));
    this.proc.stderr.setEncoding("utf8");
    this.proc.stderr.on("data", (d) => this._onStderr(d));
    this.proc.on("error", (err) => this._failAll(new Error(`failed to start asmdb: ${err.message}`)));
    this.proc.on("exit", (code, signal) => {
      this.closed = true;
      const why = signal ? `signal ${signal}` : `exit code ${code}`;
      this._failAll(new Error(`asmdb exited unexpectedly (${why})${this.stderrSummary()}`));
    });

    // First waiter consumes the banner + initial prompt.
    this.ready = new Promise((resolve, reject) => {
      this._enqueue({ resolve, reject, command: "<startup>" });
    });
  }

  stderrSummary() {
    return this.stderrTail ? `; stderr: ${this.stderrTail.trim()}` : "";
  }

  _onStderr(chunk) {
    this.stderrTail = (this.stderrTail + chunk).slice(-STDERR_TAIL_BYTES);
    if (chunk.trim()) console.error(`[asmdb] ${chunk.trim()}`);
  }

  _enqueue(entry) {
    entry.done = false;
    entry.timer = setTimeout(() => {
      if (entry.done) return;
      entry.done = true;
      this.queue = this.queue.filter((q) => q !== entry);
      this.discardFrames++;
      entry.reject(new Error(`asmdb command timed out after ${this.timeoutMs} ms: ${entry.command}`));
    }, this.timeoutMs);
    this.queue.push(entry);
  }

  _finish(entry, fn, value) {
    if (entry.done) return;
    entry.done = true;
    clearTimeout(entry.timer);
    fn(value);
  }

  _failAll(err) {
    while (this.queue.length) {
      const entry = this.queue.shift();
      this._finish(entry, entry.reject, err);
    }
  }

  _promptIndex() {
    let from = 0;
    for (;;) {
      const hit = this.buf.indexOf(PROMPT, from);
      if (hit === -1) return -1;
      if (hit === 0 || this.buf[hit - 1] === "\n") return hit;
      from = hit + PROMPT.length;
    }
  }

  _onData(chunk) {
    this.buf += chunk;

    while (this.discardFrames > 0) {
      const idx = this._promptIndex();
      if (idx === -1) {
        if (Buffer.byteLength(this.buf, "utf8") > this.maxOutputBytes) {
          this.buf = this.buf.slice(-PROMPT.length);
        }
        return;
      }
      this.buf = this.buf.slice(idx + PROMPT.length);
      this.discardFrames--;
    }

    while (this.queue.length) {
      if (Buffer.byteLength(this.buf, "utf8") > this.maxOutputBytes) {
        const entry = this.queue.shift();
        this.buf = "";
        this.discardFrames++;
        this._finish(
          entry,
          entry.reject,
          new Error(`asmdb command exceeded output cap of ${this.maxOutputBytes} bytes: ${entry.command}`)
        );
        return;
      }

      const idx = this._promptIndex();
      if (idx === -1) break;
      const segment = this.buf.slice(0, idx);
      this.buf = this.buf.slice(idx + PROMPT.length);
      const entry = this.queue.shift();
      this._finish(entry, entry.resolve, segment);
    }
  }

  /** Send one command line, resolving with the text printed before the next prompt. */
  async command(line) {
    if (this.closed) throw new Error(`asmdb session is closed${this.stderrSummary()}`);
    let entry;
    const output = new Promise((resolve, reject) => {
      entry = { resolve, reject, command: line };
      this._enqueue(entry);
    });

    try {
      if (!this.proc.stdin.write(line + "\n")) {
        await new Promise((resolve, reject) => {
          const cleanup = () => {
            this.proc.stdin.off("drain", onDrain);
            this.proc.stdin.off("error", onError);
          };
          const onDrain = () => {
            cleanup();
            resolve();
          };
          const onError = (err) => {
            cleanup();
            reject(err);
          };
          this.proc.stdin.once("drain", onDrain);
          this.proc.stdin.once("error", onError);
        });
      }
    } catch (err) {
      if (entry && !entry.done) {
        entry.done = true;
        clearTimeout(entry.timer);
        this.queue = this.queue.filter((q) => q !== entry);
        entry.reject(err);
      }
    }

    return output;
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
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

/** 64-bit FNV-1a hash of a string key, returned as a decimal asmdb id. */
export function keyToId(key) {
  const mask = U64_MAX;
  let h = 1469598103934665603n;
  const prime = 1099511628211n;
  for (const byte of Buffer.from(String(key), "utf8")) {
    h ^= BigInt(byte);
    h = (h * prime) & mask;
  }
  if (h === 0n) h = 1n;
  return h.toString(10);
}

export function parseDecimalInRange(text, min, max, label) {
  const s = String(text).trim();
  if (!/^-?\d+$/.test(s)) throw new Error(`${label} is not a decimal integer`);
  const n = BigInt(s);
  if (n < min || n > max) throw new Error(`${label} is outside the supported range`);
  return s;
}

function unescapeTsvField(s) {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== "\\") {
      out += s[i];
      continue;
    }
    const next = s[++i];
    if (next === "\\") out += "\\";
    else if (next === "t") out += "\t";
    else if (next === "n") out += "\n";
    else if (next === "r") out += "\r";
    else {
      out += "\\";
      if (next !== undefined) out += next;
    }
  }
  return out;
}

/** Parse FORMAT TSV row lines into records; id/value remain decimal strings. */
export function parseTsvRows(text) {
  const rows = [];
  for (const raw of text.split(/\r?\n/)) {
    if (!raw.startsWith("R\t")) continue;
    const cells = raw.split("\t");
    if (cells.length !== 7) throw new Error(`malformed TSV row from engine: ${raw}`);
    const [, id, value, created, updated, tag, content] = cells;
    rows.push({
      id: parseDecimalInRange(id, 1n, U64_MAX, "id"),
      value: parseDecimalInRange(value, I64_MIN, I64_MAX, "value"),
      created: Number(parseDecimalInRange(created, 0n, U64_MAX, "created")),
      updated: Number(parseDecimalInRange(updated, 0n, U64_MAX, "updated")),
      tag: unescapeTsvField(tag),
      content: unescapeTsvField(content),
    });
  }
  return rows;
}

export function engineError(text) {
  const m = text.match(/\[\s*ERR\s*\]\s*(.*)/i);
  return m ? m[1].trim() || "engine error" : null;
}

export function okStatus(text) {
  return /\[\s*OK\s*\]/i.test(text);
}

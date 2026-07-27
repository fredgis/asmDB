import { decode as decodeMessagePack } from "@msgpack/msgpack";
import type { DecoderMode } from "@/types/workload";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: false });

export const CONTENT_LIMIT_BYTES = 176;

export function clampToUtf8Bytes(value: string, limit = CONTENT_LIMIT_BYTES): string {
  let output = "";
  for (const character of value) {
    if (encoder.encode(output + character).length > limit) break;
    output += character;
  }
  return output;
}

export function byteLength(value: string): number {
  return encoder.encode(value).length;
}

function parseHex(value: string): Uint8Array {
  const compact = value.replace(/[^0-9a-f]/gi, "");
  if (compact.length % 2 !== 0) throw new Error("Hex input must contain complete byte pairs.");
  return Uint8Array.from(compact.match(/.{2}/g)?.map((part) => Number.parseInt(part, 16)) ?? []);
}

function parseBase64(value: string): Uint8Array {
  const binary = atob(value.replace(/\s/g, ""));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function parseCsv(value: string): string[][] {
  const rows: string[][] = [];
  let cell = "";
  let row: string[] = [];
  let quoted = false;

  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    const next = value[index + 1];
    if (character === '"' && quoted && next === '"') {
      cell += '"';
      index += 1;
    } else if (character === '"') {
      quoted = !quoted;
    } else if (character === "," && !quoted) {
      row.push(cell);
      cell = "";
    } else if ((character === "\n" || character === "\r") && !quoted) {
      if (character === "\r" && next === "\n") index += 1;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += character;
    }
  }
  row.push(cell);
  rows.push(row);
  return rows;
}

function stringify(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

export function decodeSample(mode: DecoderMode, sample: string): { status: string; preview: string } {
  if (mode === "none") return { status: "None", preview: sample };
  if (mode === "hex") return { status: "Hex", preview: decoder.decode(parseHex(sample)) };
  if (mode === "base64") return { status: "Base64", preview: decoder.decode(parseBase64(sample)) };
  if (mode === "json") return { status: "JSON", preview: JSON.stringify(JSON.parse(sample), null, 2) };
  if (mode === "csv") return { status: "CSV", preview: JSON.stringify(parseCsv(sample), null, 2) };
  return { status: "MessagePack", preview: stringify(decodeMessagePack(parseBase64(sample))) };
}

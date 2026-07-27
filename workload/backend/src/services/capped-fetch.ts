import { z } from "zod";
import type { AppConfig } from "../config.js";
import { HttpError } from "../errors.js";

export interface CappedResponse {
  status: number;
  ok: boolean;
  headers: Headers;
  text: string;
}

export async function fetchTextCapped(
  url: string,
  init: RequestInit,
  capBytes: number,
  timeoutMs: number
): Promise<CappedResponse> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const reader = response.body?.getReader();
    if (!reader) {
      return { status: response.status, ok: response.ok, headers: response.headers, text: "" };
    }

    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > capBytes) {
        await reader.cancel();
        throw new HttpError(
          502,
          "upstream_too_large",
          `Upstream response exceeded ${capBytes} bytes`
        );
      }
      chunks.push(value);
    }

    return {
      status: response.status,
      ok: response.ok,
      headers: response.headers,
      text: Buffer.concat(chunks).toString("utf8"),
    };
  } catch (err: unknown) {
    if (err instanceof HttpError) throw err;
    if (err instanceof Error && err.name === "AbortError") {
      throw new HttpError(504, "upstream_timeout", "Upstream request timed out");
    }
    const message = err instanceof Error ? err.message : "Upstream request failed";
    throw new HttpError(502, "upstream_unavailable", message);
  } finally {
    clearTimeout(timeout);
  }
}

export async function fetchJsonCapped<T>(
  schema: z.ZodType<T>,
  url: string,
  init: RequestInit,
  config: AppConfig,
  capBytes = config.upstreamJsonBytes
): Promise<{ status: number; ok: boolean; headers: Headers; data: T }> {
  const response = await fetchTextCapped(url, init, capBytes, config.upstreamTimeoutMs);
  let json: unknown;
  try {
    json = response.text.length > 0 ? JSON.parse(response.text) : undefined;
  } catch {
    throw new HttpError(502, "upstream_malformed", "Upstream returned malformed JSON");
  }

  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    throw new HttpError(502, "upstream_malformed", "Upstream JSON did not match contract");
  }

  return { ...response, data: parsed.data };
}

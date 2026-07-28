import { z } from "zod";
import type { AppConfig } from "../config.js";
import { HttpError } from "../errors.js";
import { fetchTextCapped, type CappedResponse } from "./capped-fetch.js";

const frameSchema = z
  .object({
    commitSeq: z.string(),
    flags: z.object({ reset: z.boolean().optional() }).passthrough().optional(),
    ops: z.array(z.record(z.string(), z.unknown())),
  })
  .passthrough();

const cdcGapSchema = z.object({
  error: z.object({
    code: z.literal("cdc_gap"),
    message: z.string(),
    baseSeq: z.string(),
    requestedFrom: z.string(),
  }),
});

const cdcCorruptSchema = z.object({
  error: z.object({
    code: z.literal("cdc_corrupt"),
    message: z.string(),
    detail: z.string().optional(),
    baseSeq: z.string().optional(),
    lastSeq: z.string().optional(),
    commitSeq: z.string().optional(),
  }),
});

const shareUnreadableSchema = z.object({
  error: z.object({
    code: z.literal("share_unreadable"),
    message: z.string(),
    detail: z.string().optional(),
  }),
});

export interface CdcPreview {
  baseSeq: string;
  lastSeq: string;
  hasMore: boolean;
  frames: z.infer<typeof frameSchema>[];
}

function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

function optionalDetails(values: Record<string, string | undefined>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(values).filter((entry): entry is [string, string] => entry[1] !== undefined)
  );
}

function bodySnippet(text: string): string | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  return trimmed.length > 256 ? `${trimmed.slice(0, 256)}…` : trimmed;
}

export class CdcGatewayService {
  constructor(private readonly config: AppConfig) {}

  async passthrough(
    instanceId: string,
    from: string,
    limit: number,
    authorization: string
  ): Promise<{ status: number; body: string; headers: Record<string, string> }> {
    const url = new URL(joinUrl(this.config.gatewayUrl, `/cdc/${encodeURIComponent(instanceId)}`));
    url.searchParams.set("from", from);
    url.searchParams.set("limit", String(limit));

    const response = await fetchTextCapped(
      url.toString(),
      {
        method: "GET",
        headers: {
          accept: "application/x-ndjson, application/json",
          authorization,
        },
      },
      this.config.notebookCdcBytes,
      this.config.upstreamTimeoutMs
    );

    const headers: Record<string, string> = {};
    for (const name of ["x-asmdb-base-seq", "x-asmdb-last-seq", "x-asmdb-has-more"]) {
      const value = response.headers.get(name);
      if (value !== null) headers[name] = value;
    }
    const contentType = response.headers.get("content-type");
    headers["content-type"] = contentType ?? "application/x-ndjson";
    return { status: response.status, body: response.text, headers };
  }

  async preview(instanceId: string, from: string, limit: number): Promise<CdcPreview> {
    const url = new URL(joinUrl(this.config.gatewayUrl, `/cdc/${encodeURIComponent(instanceId)}`));
    url.searchParams.set("from", from);
    url.searchParams.set("limit", String(limit));

    const response = await fetchTextCapped(
      url.toString(),
      {
        method: "GET",
        headers: {
          accept: "application/x-ndjson, application/json",
          authorization: `Bearer ${this.config.gatewayToken}`,
        },
      },
      this.config.upstreamCdcBytes,
      this.config.upstreamTimeoutMs
    );

    if (response.status === 409) {
      this.throwCdcConflict(response.text);
    }

    if ([502, 503, 504].includes(response.status)) {
      this.throwTransientGateway(response);
    }

    if (!response.ok) {
      throw new HttpError(
        502,
        "upstream_unavailable",
        `CDC gateway returned status ${response.status}`
      );
    }

    const frames = response.text
      .split(/\r?\n/)
      .filter((line) => line.length > 0)
      .map((line) => {
        try {
          return frameSchema.parse(JSON.parse(line));
        } catch {
          throw new HttpError(502, "upstream_malformed", "CDC gateway returned malformed NDJSON");
        }
      });

    return {
      baseSeq: response.headers.get("x-asmdb-base-seq") ?? from,
      lastSeq: response.headers.get("x-asmdb-last-seq") ?? (frames.at(-1)?.commitSeq ?? from),
      hasMore: response.headers.get("x-asmdb-has-more") === "true",
      frames,
    };
  }

  private throwCdcConflict(text: string): never {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new HttpError(502, "upstream_malformed", "CDC gateway returned malformed 409 response");
    }

    const gap = cdcGapSchema.safeParse(parsed);
    if (gap.success) {
      throw new HttpError(409, "cdc_gap", gap.data.error.message, {
        baseSeq: gap.data.error.baseSeq,
        requestedFrom: gap.data.error.requestedFrom,
      });
    }

    const corrupt = cdcCorruptSchema.safeParse(parsed);
    if (corrupt.success) {
      throw new HttpError(
        409,
        "cdc_corrupt",
        corrupt.data.error.message,
        optionalDetails({
          detail: corrupt.data.error.detail,
          baseSeq: corrupt.data.error.baseSeq,
          lastSeq: corrupt.data.error.lastSeq,
          commitSeq: corrupt.data.error.commitSeq,
        })
      );
    }

    throw new HttpError(502, "upstream_malformed", "CDC gateway 409 did not contain a known CDC conflict code");
  }

  private throwTransientGateway(response: CappedResponse): never {
    let parsed: unknown;
    try {
      parsed = JSON.parse(response.text);
    } catch {
      parsed = undefined;
    }

    const unreadable = shareUnreadableSchema.safeParse(parsed);
    if (unreadable.success) {
      throw new HttpError(503, "share_unreadable", unreadable.data.error.message, {
        ...optionalDetails({ detail: unreadable.data.error.detail }),
      });
    }

    throw new HttpError(503, "share_unreadable", "CDC gateway is temporarily unavailable", {
      upstreamStatus: response.status,
      ...optionalDetails({ upstreamBodySnippet: bodySnippet(response.text) }),
    });
  }
}

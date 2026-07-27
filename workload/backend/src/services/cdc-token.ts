import { createHmac, timingSafeEqual } from "node:crypto";
import type { AppConfig } from "../config.js";
import { HttpError } from "../errors.js";

export interface CdcTokenReference {
  reference: string;
  instanceId: string;
  expiresAt: string;
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

export class CdcTokenService {
  constructor(private readonly config: AppConfig) {}

  mint(instanceId: string, userId: string): CdcTokenReference {
    const expiresAtMs = Date.now() + this.config.cdcTokenTtlSeconds * 1000;
    const payload = {
      typ: "asmdb-cdc-reference",
      instanceId,
      sub: userId,
      exp: Math.floor(expiresAtMs / 1000),
    };
    const encodedPayload = base64url(JSON.stringify(payload));
    const signature = this.sign(encodedPayload);

    return {
      reference: `cdc_ref.${encodedPayload}.${signature}`,
      instanceId,
      expiresAt: new Date(expiresAtMs).toISOString(),
    };
  }

  verify(reference: string): string {
    const parts = reference.split(".");
    if (parts.length !== 3 || parts[0] !== "cdc_ref") {
      throw new HttpError(401, "unauthorized", "Invalid CDC token reference");
    }

    const [, encodedPayload, signature] = parts;
    if (!encodedPayload || !signature || !this.signatureMatches(encodedPayload, signature)) {
      throw new HttpError(401, "unauthorized", "Invalid CDC token reference signature");
    }

    const payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8")) as {
      instanceId?: string;
      exp?: number;
    };

    if (!payload.instanceId || !payload.exp || payload.exp < Math.floor(Date.now() / 1000)) {
      throw new HttpError(401, "unauthorized", "CDC token reference expired or malformed");
    }

    return payload.instanceId;
  }

  private sign(encodedPayload: string): string {
    return createHmac("sha256", this.config.gatewayToken)
      .update(encodedPayload)
      .digest("base64url");
  }

  private signatureMatches(encodedPayload: string, signature: string): boolean {
    const expected = Buffer.from(this.sign(encodedPayload));
    const actual = Buffer.from(signature);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  }
}

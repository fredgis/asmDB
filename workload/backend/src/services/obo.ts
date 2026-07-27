import { ManagedIdentityCredential } from "@azure/identity";
import { z } from "zod";
import type { AppConfig } from "../config.js";
import { HttpError } from "../errors.js";
import { fetchJsonCapped, fetchTextCapped } from "./capped-fetch.js";

const cloudConfigSchema = z.object({ scope: z.string().min(1) }).passthrough();
const tokenResponseSchema = z.object({ access_token: z.string().min(1) }).passthrough();

export interface ClientAssertionProvider {
  getAssertion(): Promise<string>;
}

const tokenExchangeAudience = "api://AzureADTokenExchange";
const assertionRefreshSkewMs = 5 * 60 * 1000;

function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

export class ManagedIdentityClientAssertionProvider implements ClientAssertionProvider {
  private readonly credential: ManagedIdentityCredential;
  private cachedAssertion: { token: string; expiresOnTimestamp: number } | undefined;

  constructor(config: AppConfig) {
    this.credential = config.managedIdentityClientId
      ? new ManagedIdentityCredential(config.managedIdentityClientId)
      : new ManagedIdentityCredential();
  }

  async getAssertion(): Promise<string> {
    if (
      this.cachedAssertion &&
      this.cachedAssertion.expiresOnTimestamp - assertionRefreshSkewMs > Date.now()
    ) {
      return this.cachedAssertion.token;
    }

    const token = await this.credential.getToken(tokenExchangeAudience);
    if (!token) {
      throw new HttpError(
        502,
        "obo_exchange_failed",
        "Managed identity did not return a client assertion token"
      );
    }

    this.cachedAssertion = token;
    return token.token;
  }
}

export class OboTokenBroker {
  private cachedScope: string | undefined;
  private readonly clientAssertionProvider: ClientAssertionProvider | undefined;

  constructor(config: AppConfig, clientAssertionProvider?: ClientAssertionProvider) {
    this.config = config;
    this.clientAssertionProvider = config.useManagedIdentity
      ? clientAssertionProvider ?? new ManagedIdentityClientAssertionProvider(config)
      : undefined;
  }

  private readonly config: AppConfig;

  async exchange(userAssertion: string): Promise<string> {
    const scope = await this.getCloudScope();
    const tokenEndpoint =
      this.config.tokenEndpoint ??
      `https://login.microsoftonline.com/${this.config.tenantId}/oauth2/v2.0/token`;

    const form = new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      client_id: this.config.clientId,
      assertion: userAssertion,
      requested_token_use: "on_behalf_of",
      scope,
    });

    if (this.config.useManagedIdentity) {
      const clientAssertion = await this.getClientAssertion();
      form.set(
        "client_assertion_type",
        "urn:ietf:params:oauth:client-assertion-type:jwt-bearer"
      );
      form.set("client_assertion", clientAssertion);
    } else if (this.config.clientSecret) {
      form.set("client_secret", this.config.clientSecret);
    } else {
      throw new HttpError(
        500,
        "obo_exchange_failed",
        "OBO client authentication is not configured. Set ASMDB_WL_USE_MANAGED_IDENTITY=true or ASMDB_WL_ENTRA_CLIENT_SECRET."
      );
    }

    const response = await fetchTextCapped(
      tokenEndpoint,
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: form,
      },
      64 * 1024,
      this.config.upstreamTimeoutMs
    );

    if (!response.ok) {
      throw new HttpError(
        502,
        "obo_exchange_failed",
        `On-behalf-of exchange failed with status ${response.status}`
      );
    }

    let json: unknown;
    try {
      json = JSON.parse(response.text);
    } catch {
      throw new HttpError(502, "obo_exchange_failed", "On-behalf-of exchange returned malformed JSON");
    }

    const parsed = tokenResponseSchema.safeParse(json);
    if (!parsed.success) {
      throw new HttpError(502, "obo_exchange_failed", "On-behalf-of exchange response did not include an access token");
    }

    return parsed.data.access_token;
  }

  private async getClientAssertion(): Promise<string> {
    if (!this.clientAssertionProvider) {
      throw new HttpError(500, "obo_exchange_failed", "Managed identity assertion provider is not configured");
    }
    return this.clientAssertionProvider.getAssertion();
  }

  private async getCloudScope(): Promise<string> {
    if (this.config.cloudScope) return this.config.cloudScope;
    if (this.cachedScope) return this.cachedScope;

    const response = await fetchJsonCapped(
      cloudConfigSchema,
      joinUrl(this.config.cloudApi, "/config"),
      { method: "GET", headers: { accept: "application/json" } },
      this.config,
      64 * 1024
    );

    if (!response.ok) {
      throw new HttpError(
        502,
        "obo_exchange_failed",
        `Could not discover asmDB Cloud scope (status ${response.status})`
      );
    }

    this.cachedScope = response.data.scope;
    return this.cachedScope;
  }
}

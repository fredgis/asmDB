import type { WorkloadClientAPI } from "@ms-fabric/workload-client";

let cachedToken: { token: string; expiresAt: number } | null = null;
let inFlightToken: Promise<string | undefined> | null = null;

function expiryMs(expiry?: Date) {
  const value = expiry instanceof Date ? expiry.getTime() : undefined;
  return value && Number.isFinite(value) ? value : Date.now() + 5 * 60 * 1000;
}

function isUsableCachedToken() {
  return cachedToken && cachedToken.expiresAt - Date.now() > 60 * 1000;
}

export async function getFabricToken(
  workloadClient: WorkloadClientAPI | null,
  forceRefresh = false
): Promise<string | undefined> {
  if (!workloadClient) return undefined;
  if (!forceRefresh && isUsableCachedToken() && cachedToken) return cachedToken.token;
  if (!forceRefresh && inFlightToken) return inFlightToken;

  inFlightToken = workloadClient.auth
    .acquireAccessToken({
      additionalScopesToConsent: [],
      claimsForConditionalAccessPolicy: "",
    })
    .then((result) => {
      if (!result?.token) return undefined;
      cachedToken = { token: result.token, expiresAt: expiryMs(result.expiry) };
      return result.token;
    })
    .catch((error) => {
      console.warn("Failed to acquire Fabric access token:", error);
      return undefined;
    })
    .finally(() => {
      inFlightToken = null;
    });

  return inFlightToken;
}

export function invalidateFabricToken() {
  cachedToken = null;
}

export function authHeaders(token: string | undefined): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}


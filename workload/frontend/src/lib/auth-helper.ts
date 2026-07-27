import type { WorkloadClientAPI } from "@ms-fabric/workload-client";
import { BACKEND_SCOPE } from "../workload-constants";

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

  // acquireFrontendAccessToken, not acquireAccessToken. The latter is the WDK
  // "Remote" method: it asks Fabric to mint a token for the audience declared
  // in the manifest's AADBEApp/ResourceId. This workload is
  // HostingType="FERemote", which has no AADBEApp element at all, so Fabric
  // cannot determine an audience and refuses before contacting Entra - hence
  // no network request, and the opaque `{error: 2}` in the console, which is
  // WorkloadAuthError.WorkloadConfigError: "the redirectUri/Audience does not
  // meet the requirements".
  inFlightToken = workloadClient.auth
    .acquireFrontendAccessToken({ scopes: [BACKEND_SCOPE] })
    .then((result): string | undefined => {
      if (!result?.token) return undefined;
      cachedToken = { token: result.token, expiresAt: expiryMs(result.expiry) };
      return result.token;
    })
    .catch((error: unknown): string | undefined => {
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


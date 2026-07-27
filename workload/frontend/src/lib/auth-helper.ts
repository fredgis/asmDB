import type { WorkloadClientAPI } from "@ms-fabric/workload-client";

export async function getFabricToken(
  workloadClient: WorkloadClientAPI | null
): Promise<string | undefined> {
  if (!workloadClient) return undefined;

  try {
    const result = await workloadClient.auth.acquireAccessToken({
      additionalScopesToConsent: [],
      claimsForConditionalAccessPolicy: "",
    });
    return result?.token;
  } catch (error) {
    console.warn("Failed to acquire Fabric access token:", error);
    return undefined;
  }
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

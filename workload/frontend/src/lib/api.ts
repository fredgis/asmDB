import type { WorkloadClientAPI } from "@ms-fabric/workload-client";
import { authHeaders, getFabricToken } from "./auth-helper";
import type { DatabaseInfo } from "@/types/workload";

export async function fetchHealth(workloadClient: WorkloadClientAPI | null): Promise<Response> {
  const token = await getFabricToken(workloadClient);
  return fetch("/health", { headers: authHeaders(token) });
}

export async function fetchDatabases(
  workloadClient: WorkloadClientAPI | null
): Promise<DatabaseInfo[]> {
  const token = await getFabricToken(workloadClient);
  const response = await fetch("/api/databases", { headers: authHeaders(token) });
  if (!response.ok) {
    throw new Error(`Database request failed with ${response.status}`);
  }
  const payload = (await response.json()) as { databases?: DatabaseInfo[] };
  return (payload.databases ?? []).filter((database) => database.tier === "premium");
}

export async function previewCdc(
  workloadClient: WorkloadClientAPI | null,
  instanceId: string
): Promise<unknown> {
  const token = await getFabricToken(workloadClient);
  const response = await fetch(`/api/cdc/${encodeURIComponent(instanceId)}/preview?limit=20`, {
    headers: authHeaders(token),
  });
  if (!response.ok) {
    throw new Error(`CDC preview failed with ${response.status}`);
  }
  return response.json();
}

import type { WorkloadClientAPI } from "@ms-fabric/workload-client";
import { authHeaders, getFabricToken } from "./auth-helper";
import type { DatabaseInfo, LoadIssue } from "@/types/workload";

export const API_BASE = import.meta.env.VITE_API_URL ?? (import.meta.env.DEV ? "" : "https://asmdb-analytical-backend.azurewebsites.net");

export class DependencyError extends Error {
  constructor(public readonly issue: LoadIssue, message = issue.message) {
    super(message);
    this.name = "DependencyError";
  }
}

function url(path: string) {
  return `${API_BASE}${path}`;
}

async function parseFailure(response: Response, fallback: string): Promise<LoadIssue> {
  let payload: { errorCode?: string; code?: string; message?: string; dependency?: string } | null = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  const code = payload?.errorCode ?? payload?.code ?? String(response.status);
  const message = payload?.message ?? fallback;
  const lowered = code.toLowerCase();
  const dependency = lowered.includes("identity") || lowered.includes("obo") || lowered.includes("consent") || response.status === 401 || response.status === 403
    ? "identity"
    : lowered.includes("asmdb") || lowered.includes("cloud")
      ? "asmdb-cloud"
      : "backend";
  return { dependency, code, message };
}

export async function fetchHealth(workloadClient: WorkloadClientAPI | null): Promise<{ status: string; version?: string }> {
  const token = await getFabricToken(workloadClient);
  let response: Response;
  try {
    response = await fetch(url("/health"), { headers: authHeaders(token) });
  } catch (error) {
    throw new DependencyError({ dependency: "backend", message: `Backend is unreachable: ${error instanceof Error ? error.message : String(error)}` });
  }
  if (!response.ok) throw new DependencyError(await parseFailure(response, "Backend health check failed."));
  return response.json() as Promise<{ status: string; version?: string }>;
}

export async function fetchDatabases(workloadClient: WorkloadClientAPI | null): Promise<DatabaseInfo[]> {
  const token = await getFabricToken(workloadClient);
  let response: Response;
  try {
    response = await fetch(url("/api/databases"), { headers: authHeaders(token) });
  } catch (error) {
    throw new DependencyError({ dependency: "backend", message: `Backend is unreachable: ${error instanceof Error ? error.message : String(error)}` });
  }
  if (!response.ok) throw new DependencyError(await parseFailure(response, "Could not list asmDB Cloud databases."));
  const payload = (await response.json()) as { databases?: DatabaseInfo[] };
  return (payload.databases ?? []).filter((database) => database.tier === "premium");
}

export async function previewCdc(workloadClient: WorkloadClientAPI | null, instanceId: string): Promise<unknown> {
  const token = await getFabricToken(workloadClient);
  let response: Response;
  try {
    response = await fetch(url(`/api/cdc/${encodeURIComponent(instanceId)}/preview?limit=20`), { headers: authHeaders(token) });
  } catch (error) {
    throw new DependencyError({ dependency: "backend", message: `CDC preview request could not reach the backend: ${error instanceof Error ? error.message : String(error)}` });
  }
  if (!response.ok) throw new DependencyError(await parseFailure(response, "CDC preview failed."));
  return response.json();
}


import { authHeaders, invalidateFabricToken } from "./auth-helper";
import type { DatabaseInfo, DecoderMode, GeneratedNotebook, LoadIssue } from "@/types/workload";

export const API_BASE = import.meta.env.VITE_API_URL ?? (import.meta.env.DEV ? "" : "https://asmdb-analytical-backend.azurewebsites.net");

export class DependencyError extends Error {
  constructor(public readonly issue: LoadIssue, message = issue.message) {
    super(message);
    this.name = "DependencyError";
  }
}

type ValidationError = { path?: unknown; message?: unknown };
type ErrorPayload = {
  errorCode?: string;
  code?: string;
  message?: string;
  dependency?: string;
  validationErrors?: ValidationError[];
  error?: {
    errorCode?: string;
    code?: string;
    message?: string;
    dependency?: string;
    validationErrors?: ValidationError[];
  };
};

function url(path: string) {
  return `${API_BASE}${path}`;
}

async function parseFailure(response: Response, fallback: string): Promise<LoadIssue> {
  let payload: ErrorPayload | null = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  if (response.status === 401) invalidateFabricToken();
  console.error("Backend request failed", { status: response.status, url: response.url, payload });

  const error = payload?.error ?? payload ?? undefined;
  const code = error?.errorCode ?? error?.code ?? String(response.status);
  const validationErrors = Array.isArray(error?.validationErrors) ? error.validationErrors : [];
  const validationMessage = validationErrors
    .map((entry) => `${String(entry.path ?? "value")}: ${String(entry.message ?? "invalid value")}`)
    .join("; ");
  const message = validationMessage || error?.message || fallback;
  const lowered = `${error?.dependency ?? ""} ${code} ${message}`.toLowerCase();
  const dependency = lowered.includes("asmdb") || lowered.includes("cloud")
    ? "asmdb-cloud"
    : lowered.includes("fabric")
      ? "fabric"
      : lowered.includes("identity") || lowered.includes("obo") || lowered.includes("consent") || response.status === 401
        ? "identity"
        : "backend";
  return { dependency, code, message, raw: payload };
}

export async function fetchHealth(token: string): Promise<{ status: string; version?: string }> {
  let response: Response;
  try {
    response = await fetch(url("/health"), { headers: authHeaders(token) });
  } catch (error) {
    throw new DependencyError({ dependency: "backend", message: `Backend is unreachable: ${error instanceof Error ? error.message : String(error)}` });
  }
  if (!response.ok) throw new DependencyError(await parseFailure(response, "Backend health check failed."));
  return response.json() as Promise<{ status: string; version?: string }>;
}

export async function fetchDatabases(token: string): Promise<DatabaseInfo[]> {
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

export async function previewCdc(token: string, instanceId: string): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url(`/api/cdc/${encodeURIComponent(instanceId)}/preview?limit=20`), { headers: authHeaders(token) });
  } catch (error) {
    throw new DependencyError({ dependency: "backend", message: `CDC preview request could not reach the backend: ${error instanceof Error ? error.message : String(error)}` });
  }
  if (!response.ok) throw new DependencyError(await parseFailure(response, "CDC preview failed."));
  return response.json();
}

export interface CreateNotebookRequest {
  workspaceId: string;
  displayName: string;
  sourceDatabaseId: string;
  sourceDatabaseName: string;
  lakehouseId: string;
  lakehouseName: string;
  tablePrefix?: string;
  decoder?: DecoderMode;
}

export async function createNotebook(token: string, body: CreateNotebookRequest): Promise<Omit<GeneratedNotebook, "createdAt">> {
  let response: Response;
  try {
    response = await fetch(url("/api/notebooks"), {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify(body),
    });
  } catch (error) {
    throw new DependencyError({ dependency: "backend", message: `Notebook request could not reach the backend: ${error instanceof Error ? error.message : String(error)}` });
  }
  if (!response.ok) throw new DependencyError(await parseFailure(response, "Notebook generation failed."));
  return response.json() as Promise<Omit<GeneratedNotebook, "createdAt">>;
}

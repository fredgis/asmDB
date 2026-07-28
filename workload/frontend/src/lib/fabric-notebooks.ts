import type { WorkloadClientAPI } from "@ms-fabric/workload-client";
import { DependencyError } from "./api";

export const FABRIC_API_SCOPES = [
  "https://api.fabric.microsoft.com/Item.Execute.All",
  "https://api.fabric.microsoft.com/Item.ReadWrite.All",
] as const;

const FABRIC_API_BASE = "https://api.fabric.microsoft.com/v1";
const RUN_NOTEBOOK_JOB_TYPE = "RunNotebook";

let cachedFabricApiToken: { token: string; expiresAt: number } | null = null;
let inFlightFabricApiToken: Promise<string | undefined> | null = null;

export type ScheduleCadence = "Minute" | "Hourly" | "Daily" | "Weekly" | "Monthly";

export interface FabricScheduleConfiguration {
  type: "Cron" | "Daily" | "Weekly" | "Monthly";
  interval?: number;
  times?: string[];
  weekdays?: string[];
  recurrence?: number;
  occurrence?: { occurrenceType: "DayOfMonth"; dayOfMonth: number };
  startDateTime: string;
  endDateTime: string;
  localTimeZoneId: string;
}

export interface FabricNotebookSchedule {
  id: string;
  enabled: boolean;
  configuration: FabricScheduleConfiguration;
  nextRunDateTime?: string;
  nextRunTime?: string;
}

export interface NotebookRunInstance {
  id?: string;
  status?: string;
  createdDateTime?: string;
}

export interface ScheduleDraft {
  cadence: ScheduleCadence;
  minuteInterval: number;
  hourlyInterval: number;
  time: string;
  weekdays: string[];
  dayOfMonth: number;
  startDateTime: string;
  endDateTime: string;
  localTimeZoneId: string;
}

function expiryMs(expiry?: Date) {
  const value = expiry instanceof Date ? expiry.getTime() : undefined;
  return value && Number.isFinite(value) ? value : Date.now() + 5 * 60 * 1000;
}

function isUsableCachedToken() {
  return cachedFabricApiToken && cachedFabricApiToken.expiresAt - Date.now() > 60 * 1000;
}

export async function getFabricApiToken(workloadClient: WorkloadClientAPI | null, forceRefresh = false): Promise<string | undefined> {
  if (!workloadClient) return undefined;
  if (!forceRefresh && isUsableCachedToken() && cachedFabricApiToken) return cachedFabricApiToken.token;
  if (!forceRefresh && inFlightFabricApiToken) return inFlightFabricApiToken;

  inFlightFabricApiToken = workloadClient.auth
    .acquireFrontendAccessToken({ scopes: [...FABRIC_API_SCOPES] })
    .then((result): string | undefined => {
      if (!result?.token) return undefined;
      cachedFabricApiToken = { token: result.token, expiresAt: expiryMs(result.expiry) };
      return result.token;
    })
    .catch((error: unknown): string | undefined => {
      console.warn("Failed to acquire Fabric API token:", error);
      return undefined;
    })
    .finally(() => {
      inFlightFabricApiToken = null;
    });

  return inFlightFabricApiToken;
}

function fabricUrl(workspaceId: string, notebookId: string, path: string) {
  return `${FABRIC_API_BASE}/workspaces/${encodeURIComponent(workspaceId)}/items/${encodeURIComponent(notebookId)}/jobs/${RUN_NOTEBOOK_JOB_TYPE}${path}`;
}

function fabricHeaders(token: string) {
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}

function plainLanguage(code: string) {
  if (code === "InsufficientPrivileges") return "Consent or Fabric permissions are missing.";
  if (code === "ItemNotFound") return "The notebook no longer exists in this workspace.";
  if (code === "ScheduleExceedsLimit") return "This notebook already has the maximum 20 schedules.";
  return "";
}

async function parseFabricFailure(response: Response, fallback: string) {
  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  console.error("Fabric notebook request failed", { status: response.status, url: response.url, payload });
  const root = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
  const error = root.error && typeof root.error === "object" ? root.error as Record<string, unknown> : root;
  const code = String(error.errorCode ?? error.code ?? response.status);
  const message = String(error.message ?? fallback);
  const hint = plainLanguage(code);
  return {
    dependency: "fabric" as const,
    code,
    message: hint ? `${message} ${hint}` : message,
    raw: payload,
  };
}

async function fabricFetch<T>(token: string, url: string, init?: RequestInit, accepted: number[] = [200]): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, { ...init, headers: { ...fabricHeaders(token), ...(init?.headers ?? {}) } });
  } catch (error) {
    throw new DependencyError({ dependency: "fabric", message: `Fabric API request failed before a response: ${error instanceof Error ? error.message : String(error)}` });
  }
  if (!accepted.includes(response.status)) throw new DependencyError(await parseFabricFailure(response, "Fabric notebook API request failed."));
  const body = await response.text();
  if (!body) return {} as T;
  try {
    return JSON.parse(body) as T;
  } catch {
    return {} as T;
  }
}

function itemUrl(workspaceId: string, itemId: string) {
  return `${FABRIC_API_BASE}/workspaces/${encodeURIComponent(workspaceId)}/items/${encodeURIComponent(itemId)}`;
}

export async function deleteNotebook(token: string, workspaceId: string, notebookId: string): Promise<void> {
  try {
    await fabricFetch<unknown>(token, itemUrl(workspaceId, notebookId), { method: "DELETE" }, [200, 202, 204]);
  } catch (error) {
    const code = error instanceof DependencyError ? String((error as { code?: unknown }).code ?? "") : "";
    if (code === "ItemNotFound" || code === "404") return;
    throw error;
  }
}

function schedulesFromPayload(payload: unknown): FabricNotebookSchedule[] {
  if (Array.isArray(payload)) return payload as FabricNotebookSchedule[];
  if (!payload || typeof payload !== "object") return [];
  const record = payload as Record<string, unknown>;
  if (Array.isArray(record.value)) return record.value as FabricNotebookSchedule[];
  if (Array.isArray(record.schedules)) return record.schedules as FabricNotebookSchedule[];
  return [];
}

export async function listNotebookSchedules(token: string, workspaceId: string, notebookId: string): Promise<FabricNotebookSchedule[]> {
  const payload = await fabricFetch<unknown>(token, fabricUrl(workspaceId, notebookId, "/schedules"));
  return schedulesFromPayload(payload);
}

export async function saveNotebookSchedule(token: string, workspaceId: string, notebookId: string, body: { enabled: boolean; configuration: FabricScheduleConfiguration }, scheduleId?: string): Promise<FabricNotebookSchedule> {
  const method = scheduleId ? "PATCH" : "POST";
  const url = fabricUrl(workspaceId, notebookId, scheduleId ? `/schedules/${encodeURIComponent(scheduleId)}` : "/schedules");
  return fabricFetch<FabricNotebookSchedule>(token, url, { method, body: JSON.stringify(body) }, scheduleId ? [200] : [201]);
}

export async function runNotebookNow(token: string, workspaceId: string, notebookId: string): Promise<NotebookRunInstance> {
  return fabricFetch<NotebookRunInstance>(token, fabricUrl(workspaceId, notebookId, "/instances"), { method: "POST" }, [202]);
}


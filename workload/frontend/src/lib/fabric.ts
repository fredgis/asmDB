import type { WorkloadClientAPI } from "@ms-fabric/workload-client";
import { authHeaders, invalidateFabricToken } from "./auth-helper";
import { API_BASE, DependencyError } from "./api";
import type { LakehouseInfo, LoadIssue } from "@/types/workload";

import { resolveCurrentItemId } from "./itemContext";

function cachedWorkspaceId(): string | null {
  try {
    return window.sessionStorage.getItem("asmdb.workspaceObjectIdHint");
  } catch {
    return null;
  }
}

export async function resolveWorkspaceId(workloadClient: WorkloadClientAPI | null): Promise<string> {
  const hintedWorkspaceId = cachedWorkspaceId();
  if (hintedWorkspaceId) return hintedWorkspaceId;

  const resolution = resolveCurrentItemId();
  if (!workloadClient?.itemCrud) {
    throw new DependencyError({ dependency: "fabric", code: "missing_item_client", message: "Cannot resolve the current workspace because itemCrud is not available from the workload client." });
  }
  if (!resolution.itemId) {
    const message = resolution.diagnostic ?? "Cannot resolve the current workspace because the workload item id is absent from the route.";
    console.warn(message);
    throw new DependencyError({ dependency: "fabric", code: "missing_item_id", message });
  }

  try {
    const result = await workloadClient.itemCrud.getItem({ itemId: resolution.itemId });
    if (!result.item.workspaceId) {
      throw new Error(`itemCrud.getItem returned no workspaceId for item ${resolution.itemId}.`);
    }
    return result.item.workspaceId;
  } catch (error) {
    const message = `Could not resolve workspace id from ${resolution.source} (${resolution.itemId}): ${error instanceof Error ? error.message : String(error)}`;
    console.warn(message, error);
    throw new DependencyError({ dependency: "fabric", code: "workspace_resolution_failed", message });
  }
}

async function parseLakehouseFailure(response: Response): Promise<LoadIssue> {
  let payload: { code?: string; errorCode?: string; message?: string } | null = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  const code = payload?.code ?? payload?.errorCode ?? String(response.status);
  const defaultMessage = code === "bad_request"
    ? "The current workspace id is missing or invalid."
    : code === "fabric_forbidden"
      ? "Fabric refused this user. Check Fabric consent and workspace/item permissions."
      : code === "fabric_unavailable"
        ? "Fabric is reachable through the backend but is currently failing."
        : `Lakehouse request failed with ${response.status}.`;
  return { dependency: "fabric", code, message: payload?.message ?? defaultMessage };
}

export async function fetchLakehouses(token: string, workspaceId: string): Promise<LakehouseInfo[]> {
  let response: Response;
  try {
    response = await fetch(`${API_BASE}/api/lakehouses?workspaceId=${encodeURIComponent(workspaceId)}`, {
      headers: authHeaders(token),
    });
  } catch (error) {
    throw new DependencyError({ dependency: "backend", message: `Lakehouse request could not reach the backend: ${error instanceof Error ? error.message : String(error)}` });
  }

  if (response.status === 401) invalidateFabricToken();
  if (!response.ok) throw new DependencyError(await parseLakehouseFailure(response));
  const payload = (await response.json()) as { lakehouses?: LakehouseInfo[] };
  return payload.lakehouses ?? [];
}



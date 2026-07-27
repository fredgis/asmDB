import type { WorkloadClientAPI } from "@ms-fabric/workload-client";
import { authHeaders, invalidateFabricToken } from "./auth-helper";
import { API_BASE, DependencyError } from "./api";
import type { LakehouseInfo, LoadIssue } from "@/types/workload";

type ItemIdResolution = { itemId: string | null; source: string; diagnostic?: string };

const guidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function itemIdFromLocation(location = window.location): ItemIdResolution {
  const params = new URLSearchParams(location.search);
  for (const key of ["itemId", "itemObjectId", "objectId"]) {
    const value = params.get(key);
    if (value) return { itemId: value, source: `query parameter ${key}` };
  }

  const parts = location.pathname.split("/").filter(Boolean);
  const syncHubIndex = parts.indexOf("sync-hub");
  if (syncHubIndex >= 0 && parts[syncHubIndex + 1]) {
    return { itemId: parts[syncHubIndex + 1], source: "route segment after /sync-hub" };
  }

  const guid = parts.find((part) => guidPattern.test(part));
  if (guid) return { itemId: guid, source: "first GUID route segment" };

  return {
    itemId: null,
    source: "none",
    diagnostic: `Could not parse the workload item id from path "${location.pathname}" or query "${location.search}". Expected /sync-hub/<itemId> or an itemId/itemObjectId/objectId query parameter.`,
  };
}

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

  const resolution = itemIdFromLocation();
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


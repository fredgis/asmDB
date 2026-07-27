// Must match workload/manifest/WorkloadManifest.xml root workload name.
// Fabric resolves pages and item actions by this exact ID.
export const WORKLOAD_ID = "Org.AsmdbAnalytical";

// Must match workload/manifest/items/SyncHub/SyncHubItem.json name and
// workload/manifest/items/SyncHub/SyncHubItem.xml item type suffix.
export const SYNC_HUB_ITEM_NAME = "SyncHub";
export const SYNC_HUB_ITEM_TYPE = `${WORKLOAD_ID}.${SYNC_HUB_ITEM_NAME}`;

// Must match workload/manifest/items/SyncHub/SyncHubItem.json editor.path.
export const SYNC_HUB_EDITOR_PATH = "/sync-hub";

// Must match the Entra redirect URI path configured for the workload SPA.
export const CLOSE_REDIRECT_PATH = "/close";

// Must match the Application ID URI on the workload's Entra app, and the
// scope it exposes. The backend accepts this URI as a token audience.
export const APP_ID_URI = "https://asmdb.cloud/fe/be/Org.AsmdbAnalytical/1";
export const BACKEND_SCOPE = `${APP_ID_URI}/FabricWorkloadControl`;

export function isKnownFrontendPath(pathname: string): boolean {
  return pathname === "/" || pathname.startsWith(SYNC_HUB_EDITOR_PATH) || pathname.startsWith(CLOSE_REDIRECT_PATH);
}

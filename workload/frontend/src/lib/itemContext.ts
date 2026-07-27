const guidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type ItemIdResolution = { itemId: string | null; source: string; diagnostic?: string };

export function resolveCurrentItemId(location = window.location): ItemIdResolution {
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

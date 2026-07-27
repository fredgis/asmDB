import type { WorkloadClientAPI } from "@ms-fabric/workload-client";
import type { LineageGraph, SyncLink } from "@/types/workload";
import { resolveCurrentItemId } from "./itemContext";

const LINKS_PART_PATH = "links.json";
const LINEAGE_PART_PATH = "lineage/graph.json";
const INLINE_BASE64 = "InlineBase64";

type DefinitionPart = { path: string; payload: string; payloadType: "InlineBase64" };
type ItemDefinition = { format: string; parts: DefinitionPart[] };

export class ItemDefinitionStorageError extends Error {
  constructor(public readonly code: "item_unresolved" | "definition_read_failed" | "definition_write_rejected" | "invalid_definition", message: string) {
    super(message);
    this.name = "ItemDefinitionStorageError";
  }
}

function encodeUtf8Base64(value: string) {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary);
}

function decodeUtf8Base64(value: string) {
  const binary = atob(value);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

function resolveItemId(): string {
  const resolution = resolveCurrentItemId();
  if (!resolution.itemId) {
    throw new ItemDefinitionStorageError(
      "item_unresolved",
      resolution.diagnostic ?? "Cannot determine which Fabric workload item to save to; the item id is absent from the route."
    );
  }
  return resolution.itemId;
}

async function getDefinition(workloadClient: WorkloadClientAPI | null): Promise<{ itemId: string; definition: ItemDefinition }> {
  if (!workloadClient?.itemCrud) {
    throw new ItemDefinitionStorageError("item_unresolved", "Cannot access item definitions because itemCrud is not available from the workload client.");
  }
  const itemId = resolveItemId();
  try {
    const result = await workloadClient.itemCrud.getItemDefinition({ itemId });
    const definition = result.definition as ItemDefinition;
    return { itemId, definition: { format: definition.format, parts: Array.isArray(definition.parts) ? definition.parts : [] } };
  } catch (error) {
    throw new ItemDefinitionStorageError(
      "definition_read_failed",
      `Could not read the item definition for ${itemId}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

function readJsonPart<T>(definition: ItemDefinition, path: string, empty: T): T {
  const part = definition.parts.find((candidate) => candidate.path === path);
  if (!part) return empty;
  try {
    return JSON.parse(decodeUtf8Base64(part.payload)) as T;
  } catch (error) {
    throw new ItemDefinitionStorageError(
      "invalid_definition",
      `The item definition part ${path} is not valid UTF-8 JSON: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

function replaceJsonPart(definition: ItemDefinition, path: string, value: unknown): ItemDefinition {
  const part: DefinitionPart = {
    path,
    payload: encodeUtf8Base64(JSON.stringify(value, null, 2)),
    payloadType: INLINE_BASE64,
  };
  return {
    format: definition.format,
    parts: [...definition.parts.filter((candidate) => candidate.path !== path), part],
  };
}

async function updateDefinition(workloadClient: WorkloadClientAPI, itemId: string, definition: ItemDefinition) {
  try {
    await workloadClient.itemCrud.updateItemDefinition({
      itemId,
      payload: { definition: definition as never },
    });
  } catch (error) {
    throw new ItemDefinitionStorageError(
      "definition_write_rejected",
      `Fabric rejected the item definition update for ${itemId}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

export async function loadLinks(workloadClient: WorkloadClientAPI | null): Promise<SyncLink[]> {
  const { definition } = await getDefinition(workloadClient);
  return readJsonPart<SyncLink[]>(definition, LINKS_PART_PATH, []);
}

export async function loadLineage(workloadClient: WorkloadClientAPI | null): Promise<LineageGraph | null> {
  const { definition } = await getDefinition(workloadClient);
  return readJsonPart<LineageGraph | null>(definition, LINEAGE_PART_PATH, null);
}

export async function saveLinkState(workloadClient: WorkloadClientAPI | null, links: SyncLink[]) {
  if (!workloadClient?.itemCrud) {
    throw new ItemDefinitionStorageError("item_unresolved", "Cannot save because itemCrud is not available from the workload client.");
  }
  const { itemId, definition } = await getDefinition(workloadClient);
  const withLinks = replaceJsonPart(definition, LINKS_PART_PATH, links);
  const withLineage = replaceJsonPart(withLinks, LINEAGE_PART_PATH, graphFromLinks(links));
  await updateDefinition(workloadClient, itemId, withLineage);
  const { definition: savedDefinition } = await getDefinition(workloadClient);
  return readJsonPart<SyncLink[]>(savedDefinition, LINKS_PART_PATH, []);
}

export function graphFromLinks(links: SyncLink[]): LineageGraph {
  const nodes = new Map<string, { id: string; label: string; kind: "database" | "lakehouse" }>();
  const edges = links.map((link) => {
    const sourceId = link.sourceId ? `db:${link.sourceId}` : `db:${link.source}`;
    const targetId = link.targetId ? `lakehouse:${link.targetId}` : `lakehouse:${link.target}`;
    nodes.set(sourceId, { id: sourceId, label: link.source, kind: "database" });
    nodes.set(targetId, { id: targetId, label: link.target, kind: "lakehouse" });
    return { id: link.id, source: sourceId, target: targetId, status: link.status };
  });
  return { nodes: Array.from(nodes.values()), edges };
}


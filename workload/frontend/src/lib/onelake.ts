import type { WorkloadClientAPI } from "@ms-fabric/workload-client";
import type { LineageGraph, SyncLink } from "@/types/workload";

type StorageClient = {
  readFileAsText?: (...args: string[]) => Promise<string>;
  writeFileAsText?: (...args: string[]) => Promise<void>;
};

function storage(workloadClient: WorkloadClientAPI | null): StorageClient | null {
  const candidate = workloadClient as unknown as {
    oneLake?: StorageClient;
    onelake?: StorageClient;
    storage?: StorageClient;
  } | null;
  return candidate?.oneLake ?? candidate?.onelake ?? candidate?.storage ?? null;
}

async function readText(workloadClient: WorkloadClientAPI | null, path: string) {
  const client = storage(workloadClient);
  if (!client?.readFileAsText) return null;
  try {
    return await client.readFileAsText(path);
  } catch (error) {
    console.warn(`Could not read ${path} from OneLake`, error);
    return null;
  }
}

async function writeText(workloadClient: WorkloadClientAPI | null, path: string, content: string) {
  const client = storage(workloadClient);
  if (!client?.writeFileAsText) return false;
  try {
    await client.writeFileAsText(path, content);
    return true;
  } catch (error) {
    console.warn(`Could not write ${path} to OneLake`, error);
    return false;
  }
}

export async function loadLinks(workloadClient: WorkloadClientAPI | null): Promise<SyncLink[] | null> {
  const text = await readText(workloadClient, "Files/links.json");
  if (!text) return null;
  try {
    return JSON.parse(text) as SyncLink[];
  } catch (error) {
    console.warn("Invalid Files/links.json", error);
    return null;
  }
}

export async function saveLinks(workloadClient: WorkloadClientAPI | null, links: SyncLink[]) {
  return writeText(workloadClient, "Files/links.json", JSON.stringify(links, null, 2));
}

export async function loadLineage(workloadClient: WorkloadClientAPI | null): Promise<LineageGraph | null> {
  const text = await readText(workloadClient, "Files/lineage/graph.json");
  if (!text) return null;
  try {
    return JSON.parse(text) as LineageGraph;
  } catch (error) {
    console.warn("Invalid Files/lineage/graph.json", error);
    return null;
  }
}

export async function saveLineage(workloadClient: WorkloadClientAPI | null, graph: LineageGraph) {
  return writeText(workloadClient, "Files/lineage/graph.json", JSON.stringify(graph, null, 2));
}

export function graphFromLinks(links: SyncLink[]): LineageGraph {
  const nodes = new Map<string, { id: string; label: string; kind: "database" | "lakehouse" }>();
  const edges = links.map((link) => {
    const sourceId = `db:${link.source}`;
    const targetId = `lakehouse:${link.target}`;
    nodes.set(sourceId, { id: sourceId, label: link.source, kind: "database" });
    nodes.set(targetId, { id: targetId, label: link.target, kind: "lakehouse" });
    return { id: link.id, source: sourceId, target: targetId, status: link.status };
  });
  return { nodes: Array.from(nodes.values()), edges };
}

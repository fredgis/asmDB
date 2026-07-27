export type RequestState = "not-configured" | "no-data" | "failed" | "ready" | "stale" | "checking";
export type DecoderMode = "none" | "hex" | "base64" | "json" | "csv" | "messagepack";
export type LinkState = "Active" | "Planned" | "Warning";

export interface DatabaseInfo {
  id: string;
  name: string;
  tier: string;
  engine: string;
  endpoint: string;
  rows?: number;
  capacity?: number;
}

export interface LakehouseInfo {
  id: string;
  name: string;
  workspaceId: string;
}

export interface SyncLink {
  id: string;
  source: string;
  sourceId?: string;
  target: string;
  targetId?: string;
  mode: string;
  prefix: string;
  decoder: DecoderMode;
  createNotebook: boolean;
  status: LinkState;
  lastRun?: string;
  nextRun?: string;
  lag?: string;
  lastGoodSampleAt?: string;
}

export interface LineageGraph {
  nodes: { id: string; label: string; kind: "database" | "lakehouse" }[];
  edges: { id: string; source: string; target: string; status: LinkState; lastRunId?: string }[];
}

export interface RunRecord {
  id: string;
  source: string;
  target: string;
  status: LinkState | "Failed";
  lastRun?: string;
  lag?: string;
  message?: string;
}

export type Dependency = "backend" | "identity" | "asmdb-cloud" | "fabric" | "onelake";

export interface LoadIssue {
  dependency: Dependency;
  message: string;
  code?: string;
}

export interface Loadable<T> {
  state: RequestState;
  data: T;
  issue?: LoadIssue;
  updatedAt?: Date;
}

import { useCallback, useEffect, useMemo, useState } from "react";
import type { KeyboardEvent } from "react";
import { Button, Checkbox, Dropdown, Input, Option, Textarea } from "@fluentui/react-components";
import type { OptionOnSelectData, SelectionEvents } from "@fluentui/react-components";
import type { ItemJobInstance, ItemSchedule } from "@ms-fabric/workload-client";
import { useWorkloadClient } from "./context/WorkloadContext";
import { useThemePreference, type ThemePreference } from "./context/ThemePreferenceContext";
import { createNotebook as createNotebookArtifact, DependencyError, fetchDatabases, fetchHealth, previewCdc } from "./lib/api";
import { fetchLakehouses, resolveWorkspaceId } from "./lib/fabric";
import { getFabricToken } from "./lib/auth-helper";
import { byteLength, CONTENT_LIMIT_BYTES, decodeSample } from "./lib/decoder";
import { graphFromLinks, loadLinks, saveLinkState } from "./lib/onelake";
import type { DatabaseInfo, DecoderMode, GeneratedNotebook, LakehouseInfo, LinkState, LoadIssue, Loadable, RequestState, RunRecord, SyncLink } from "./types/workload";
import "./styles.css";

const decoderOptions: { value: DecoderMode; label: string }[] = [
  { value: "none", label: "None" },
  { value: "hex", label: "Hex" },
  { value: "base64", label: "Base64" },
  { value: "json", label: "JSON" },
  { value: "csv", label: "CSV" },
  { value: "messagepack", label: "MessagePack" },
];

const emptyIssue: LoadIssue = { dependency: "backend", message: "Not checked yet." };
const NOTEBOOK_JOB_TYPE = "RunNotebook";

interface CdcFrame {
  commitSeq?: string;
  flags?: { reset?: boolean };
  ops?: CdcOperation[];
}

interface CdcOperation {
  op?: "upsert" | "delete" | string;
  id?: string;
  record?: Partial<Record<"id" | "tag" | "content" | "value" | "created" | "updated", string>>;
}

type PreviewEntry =
  | { kind: "reset"; commitSeq: string }
  | { kind: "op"; commitSeq: string; op: string; id: string; tag: string; content: string; value: string; created: string; updated: string };

function emptyLoadable<T>(data: T): Loadable<T> {
  return { state: "checking", data, issue: emptyIssue };
}

function issueFrom(error: unknown, fallback: LoadIssue): LoadIssue {
  if (error instanceof DependencyError) return error.issue;
  const code = typeof error === "object" && error && "code" in error ? String((error as { code?: unknown }).code) : fallback.code;
  return { ...fallback, code, message: error instanceof Error ? error.message : String(error) };
}

function statusIcon(status: LinkState | "Failed") {
  if (status === "Active") return "✓";
  if (status === "Planned") return "○";
  return "!";
}

function statusClass(status: LinkState | "Failed") {
  if (status === "Active") return "stateActive";
  if (status === "Planned") return "statePlanned";
  return "stateWarning";
}

function issueText(issue?: LoadIssue) {
  if (!issue) return "Request failed.";
  return `${issue.dependency}${issue.code ? `/${issue.code}` : ""}: ${issue.message}`;
}

function stateLabel(state: RequestState) {
  if (state === "checking") return "Checking";
  if (state === "ready") return "Ready";
  if (state === "no-data") return "No data";
  if (state === "not-configured") return "Not configured";
  if (state === "stale") return "Stale";
  return "Request failed";
}

function formatTime(date?: Date) {
  return date ? date.toLocaleTimeString() : "never";
}

function formatEpochMilliseconds(value: string) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return value || "—";
  return new Date(parsed).toLocaleString();
}

function notebookNameFor(link: SyncLink) {
  return `asmDB Sync - ${link.source} to ${link.target}`.slice(0, 120);
}

function notebookCodeFor(link: SyncLink) {
  return `# asmDB analytical sync notebook
# Generated for: ${link.source} -> ${link.target}

from pyspark.sql import functions as F

source_database_id = "${link.sourceId ?? ""}"
source_database_name = "${link.source}"
target_lakehouse_id = "${link.targetId ?? ""}"
target_lakehouse_name = "${link.target}"
table_prefix = "${link.prefix}"
decoder = "${link.decoder}"

# The generated notebook replicates asmDB gateway CDC events on the configured schedule.
frames = asmdb.read_cdc(
    database_id=source_database_id,
    decoder=decoder,
)

records = (
    frames
    .select("commitSeq", "op", "record.*")
    .withColumn("created_ts", F.to_timestamp(F.col("created").cast("double") / 1000))
    .withColumn("updated_ts", F.to_timestamp(F.col("updated").cast("double") / 1000))
)

target_table = f"{table_prefix}{source_database_name.lower().replace('-', '_')}"
(
    records.write
    .format("delta")
    .mode("append")
    .saveAsTable(target_table)
)
`;
}

function schedulePayload(notebookId: string, cadence: "Hourly" | "Daily", enabled: boolean, existing?: ItemSchedule): ItemSchedule {
  const weekdays = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"].map((key) => ({ key, selected: true }));
  return {
    jobDefinitionObjectId: existing?.jobDefinitionObjectId ?? "",
    itemObjectId: notebookId,
    itemJobType: existing?.itemJobType ?? NOTEBOOK_JOB_TYPE,
    scheduleEnabled: enabled,
    scheduleType: cadence,
    localTimeZoneId: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    scheduleWeekdays: weekdays as ItemSchedule["scheduleWeekdays"],
    scheduleHours: cadence === "Daily" ? ["00:00"] : undefined,
    cronPeriod: cadence === "Hourly" ? 1 : undefined,
    cronUnit: cadence === "Hourly" ? "Hours" : undefined,
    executionData: "{}",
    maxConcurrency: 1,
    maxNumRetries: 1,
  } as ItemSchedule;
}

function extractFrames(preview: unknown): CdcFrame[] {
  if (Array.isArray(preview)) return preview.filter(isRecord) as CdcFrame[];
  if (!isRecord(preview)) return [];
  for (const key of ["frames", "items", "data", "rows", "records"]) {
    const value = preview[key];
    if (Array.isArray(value)) return value.filter(isRecord) as CdcFrame[];
  }
  return [preview as CdcFrame];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object");
}

function previewEntries(preview: unknown): PreviewEntry[] {
  return extractFrames(preview).flatMap((frame) => {
    const commitSeq = String(frame.commitSeq ?? "—");
    if (frame.flags?.reset) return [{ kind: "reset", commitSeq } satisfies PreviewEntry];
    const ops = Array.isArray(frame.ops) ? frame.ops : [];
    return ops.map<PreviewEntry>((operation) => ({
      kind: "op" as const,
      commitSeq,
      op: operation.op ?? "unknown",
      id: operation.id ?? operation.record?.id ?? "—",
      tag: operation.record?.tag ?? "—",
      content: operation.record?.content ?? "—",
      value: operation.record?.value ?? "—",
      created: operation.record?.created ?? "—",
      updated: operation.record?.updated ?? "—",
    }));
  });
}

function firstPreviewSample(preview: unknown): string {
  const candidates: unknown[] = [];
  if (Array.isArray(preview)) candidates.push(...preview);
  else if (preview && typeof preview === "object") {
    const object = preview as Record<string, unknown>;
    for (const key of ["rows", "records", "frames", "items", "data"]) {
      const value = object[key];
      if (Array.isArray(value)) candidates.push(...value);
    }
    candidates.push(preview);
  }

  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== "object") continue;
    const text = findContent(candidate as Record<string, unknown>);
    if (text) return text;
  }
  return "";
}

function findContent(value: Record<string, unknown>): string {
  for (const key of ["content", "content_raw", "contentRaw", "sample"]) {
    const candidate = value[key];
    if (typeof candidate === "string") return candidate;
  }
  for (const candidate of Object.values(value)) {
    if (candidate && typeof candidate === "object") {
      const nested = findContent(candidate as Record<string, unknown>);
      if (nested) return nested;
    }
  }
  return "";
}

function App() {
  const workloadClient = useWorkloadClient();
  const { preference, effectiveTheme, setPreference } = useThemePreference();
  const [databases, setDatabases] = useState<Loadable<DatabaseInfo[]>>(emptyLoadable([]));
  const [lakehouses, setLakehouses] = useState<Loadable<LakehouseInfo[]>>(emptyLoadable([]));
  const [links, setLinks] = useState<Loadable<SyncLink[]>>(emptyLoadable([]));
  const [connection, setConnection] = useState<Loadable<{ status?: string; version?: string }>>(emptyLoadable({}));
  const [sourceId, setSourceId] = useState("");
  const [targetId, setTargetId] = useState("");
  const [prefix, setPrefix] = useState("");
  const [createNotebook, setCreateNotebook] = useState(true);
  const [decoder, setDecoder] = useState<DecoderMode>("none");
  const [sample, setSample] = useState("");
  const [toast, setToast] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState("");
  const [previewState, setPreviewState] = useState<RequestState>("not-configured");
  const [previewText, setPreviewText] = useState("Select a premium asmDB database and request a CDC preview. No sample has been fetched yet.");
  const [previewRows, setPreviewRows] = useState<PreviewEntry[]>([]);
  const [saveState, setSaveState] = useState<RequestState>("not-configured");
  const [saveMessage, setSaveMessage] = useState("Choose a source database and target lakehouse, then create a link.");
  const [deleteConfirmId, setDeleteConfirmId] = useState("");
  const [activeTab, setActiveTab] = useState<"links" | "notebooks" | "monitoring">("links");
  const [selectedNotebookId, setSelectedNotebookId] = useState("");
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [notebookState, setNotebookState] = useState<RequestState>("not-configured");
  const [notebookMessage, setNotebookMessage] = useState("Generate a notebook from a saved link.");
  const [schedule, setSchedule] = useState<ItemSchedule | null>(null);
  const [jobHistory, setJobHistory] = useState<ItemJobInstance[]>([]);
  const [scheduleCadence, setScheduleCadence] = useState<"Hourly" | "Daily">("Daily");

  const showToast = useCallback((message: string) => {
    setToast(message);
    window.setTimeout(() => setToast(null), 2600);
  }, []);

  const refresh = useCallback(async () => {
    setConnection((current) => ({ ...current, state: "checking" }));
    setDatabases((current) => ({ ...current, state: "checking" }));
    setLakehouses((current) => ({ ...current, state: "checking" }));
    setLinks((current) => ({ ...current, state: "checking" }));

    const token = await getFabricToken(workloadClient);
    const tokenIssue: LoadIssue = {
      dependency: "identity",
      code: "token_unavailable",
      message: "Could not acquire the workload token. Sign in to Fabric again or check consent for the workload application.",
    };

    if (!token) {
      setConnection({ state: "failed", data: {}, issue: tokenIssue });
      setDatabases({ state: "failed", data: [], issue: tokenIssue });
      setLakehouses({ state: "failed", data: [], issue: tokenIssue });
      setSourceId("");
      setTargetId("");
    } else {
      try {
        const health = await fetchHealth(token);
        setConnection({ state: "ready", data: health, updatedAt: new Date() });
      } catch (error) {
        setConnection({ state: "failed", data: {}, issue: issueFrom(error, { dependency: "backend", message: "Backend health check failed." }) });
      }

      try {
        const premiumDatabases = await fetchDatabases(token);
        setDatabases({ state: premiumDatabases.length ? "ready" : "no-data", data: premiumDatabases, updatedAt: new Date() });
        setSourceId((current) => current && premiumDatabases.some((database) => database.id === current) ? current : premiumDatabases[0]?.id ?? "");
      } catch (error) {
        setDatabases({ state: "failed", data: [], issue: issueFrom(error, { dependency: "asmdb-cloud", message: "Could not list premium asmDB databases." }) });
        setSourceId("");
      }

      try {
        const workspaceId = await resolveWorkspaceId(workloadClient);
        const workspaceLakehouses = await fetchLakehouses(token, workspaceId);
        setLakehouses({ state: workspaceLakehouses.length ? "ready" : "no-data", data: workspaceLakehouses, updatedAt: new Date() });
        setTargetId((current) => current && workspaceLakehouses.some((lakehouse) => lakehouse.id === current) ? current : workspaceLakehouses[0]?.id ?? "");
      } catch (error) {
        setLakehouses({ state: "failed", data: [], issue: issueFrom(error, { dependency: "fabric", message: "Could not list Fabric lakehouses in this workspace." }) });
        setTargetId("");
      }
    }

    try {
      const storedLinks = await loadLinks(workloadClient);
      setLinks({ state: storedLinks.length ? "ready" : "no-data", data: storedLinks, updatedAt: new Date() });
      setSelectedId((current) => current && storedLinks.some((link) => link.id === current) ? current : storedLinks[0]?.id ?? "");
    } catch (error) {
      setLinks({ state: "failed", data: [], issue: issueFrom(error, { dependency: "item-definition", message: "Could not read links.json from this workload item definition." }) });
      setSelectedId("");
    }
  }, [workloadClient]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const selectedSource = databases.data.find((database) => database.id === sourceId) ?? null;
  const selectedTarget = lakehouses.data.find((lakehouse) => lakehouse.id === targetId) ?? null;
  const selectedLink = links.data.find((link) => link.id === selectedId) ?? null;
  const notebooks = links.data.flatMap((link) => link.notebook ? [{ ...link.notebook, link }] : []);
  const selectedNotebook = notebooks.find((notebook) => notebook.notebookId === selectedNotebookId) ?? notebooks[0] ?? null;
  const lineage = useMemo(() => graphFromLinks(links.data), [links.data]);
  const activeLinks = links.data.filter((link) => link.status === "Active").length;
  const plannedLinks = links.data.filter((link) => link.status === "Planned").length;
  const warningLinks = links.data.filter((link) => link.status === "Warning").length;
  const successfulRuns = jobHistory.filter((job) => job.isSuccessful).length;
  const failedRuns = jobHistory.filter((job) => !job.isSuccessful).length;
  const decoded = useMemo(() => {
    if (!sample) return { status: decoderOptions.find((item) => item.value === decoder)?.label ?? "None", preview: "No CDC sample fetched yet.", failed: false };
    try {
      return { ...decodeSample(decoder, sample), failed: false };
    } catch (error) {
      return { status: decoderOptions.find((item) => item.value === decoder)?.label ?? decoder, preview: `Decoder error: ${error instanceof Error ? error.message : String(error)}`, failed: true };
    }
  }, [decoder, sample]);

  const activityRows: RunRecord[] = jobHistory.length && selectedNotebook
    ? jobHistory.slice(0, 5).map((job) => ({ id: job.itemJobInstanceId, source: selectedNotebook.link.source, target: selectedNotebook.link.target, status: job.isSuccessful ? "Active" : "Failed", lastRun: job.jobEndTimeUtc || job.jobStartTimeUtc || job.jobScheduleTimeUtc, lag: job.statusString, message: job.serviceExceptionJson }))
    : links.data.filter((link) => link.lastRun && link.lastRun !== "Never run").map((link) => ({ id: link.id, source: link.source, target: link.target, status: link.status, lastRun: link.lastRun, lag: link.lag }));
  const canCreate = Boolean(selectedSource && selectedTarget && links.state !== "failed");
  const headerIssue = connection.state === "failed" ? connection.issue : databases.state === "failed" ? databases.issue : lakehouses.state === "failed" ? lakehouses.issue : links.state === "failed" ? links.issue : undefined;
  const headerChecking = connection.state === "checking" || databases.state === "checking" || lakehouses.state === "checking" || links.state === "checking";
  const headerConnected = !headerIssue && !headerChecking && connection.state === "ready";
  const headerStatusClass = headerConnected ? "connected" : headerChecking ? "checking" : "unavailable";

  const selectLink = useCallback((linkId: string) => {
    setSelectedId(linkId);
    setDetailsOpen(true);
  }, []);

  useEffect(() => {
    setSelectedNotebookId((current) => current && notebooks.some((notebook) => notebook.notebookId === current) ? current : notebooks[0]?.notebookId ?? "");
  }, [notebooks]);

  useEffect(() => {
    if (!selectedNotebook || !workloadClient?.itemSchedule) {
      setSchedule(null);
      setJobHistory([]);
      return;
    }
    let cancelled = false;
    void Promise.allSettled([
      workloadClient.itemSchedule.listItemSchedules({ itemObjectId: selectedNotebook.notebookId }),
      workloadClient.itemSchedule.getItemJobHistory({ objectId: selectedNotebook.notebookId }),
    ]).then(([schedules, history]) => {
      if (cancelled) return;
      if (schedules.status === "fulfilled") {
        const notebookSchedule = schedules.value.itemSchedules.find((item) => item.itemJobType === NOTEBOOK_JOB_TYPE) ?? schedules.value.itemSchedules[0] ?? null;
        setSchedule(notebookSchedule);
        if (notebookSchedule?.scheduleType === "Hourly" || notebookSchedule?.scheduleType === "Daily") setScheduleCadence(notebookSchedule.scheduleType);
      } else {
        console.error("Could not read notebook schedules", schedules.reason);
        setSchedule(null);
      }
      if (history.status === "fulfilled") {
        setJobHistory(history.value.history ?? []);
      } else {
        console.error("Could not read notebook job history", history.reason);
        setJobHistory([]);
      }
    });
    return () => { cancelled = true; };
  }, [selectedNotebook, workloadClient]);

  function onSelect(setter: (value: string) => void) {
    return (_event: SelectionEvents, data: OptionOnSelectData) => {
      if (data.optionValue) setter(data.optionValue);
    };
  }

  function onDecoderSelect(_event: SelectionEvents, data: OptionOnSelectData) {
    if (data.optionValue) setDecoder(data.optionValue as DecoderMode);
  }

  async function createLink() {
    setSaveState("checking");
    if (!selectedSource || !selectedTarget) {
      setSaveState("not-configured");
      setSaveMessage("Select both a premium asmDB source database and a Fabric target lakehouse before creating a link.");
      return;
    }
    const link: SyncLink = {
      id: `${selectedSource.id}-${selectedTarget.id}-${Date.now()}`,
      source: selectedSource.name,
      sourceId: selectedSource.id,
      target: selectedTarget.name,
      targetId: selectedTarget.id,
      prefix,
      decoder,
      createNotebook,
      status: "Planned",
    };
    const nextLinks = [link, ...links.data];
    try {
      const persistedLinks = await saveLinkState(workloadClient, nextLinks);
      setLinks({ state: persistedLinks.length ? "ready" : "no-data", data: persistedLinks, updatedAt: new Date() });
      setSelectedId(persistedLinks.find((saved) => saved.id === link.id)?.id ?? persistedLinks[0]?.id ?? "");
      const savedLink = persistedLinks.find((saved) => saved.id === link.id) ?? link;
      if (createNotebook) {
        setSaveState("ready");
        setSaveMessage(`Saved link. Generating notebook ${notebookNameFor(savedLink)}…`);
        await generateNotebookFor(savedLink, persistedLinks);
        return;
      }
    } catch (error) {
      console.error("Create Link failed", error);
      const code = typeof error === "object" && error && "code" in error ? String((error as { code?: unknown }).code) : "unknown";
      const message = `[${code}] ${error instanceof Error ? error.message : String(error)}`;
      setSaveState("failed");
      setSaveMessage(message);
      showToast(message);
      return;
    }
    setSaveState("ready");
    setSaveMessage(`Saved to links.json and lineage/graph.json: ${selectedSource.name} -> ${selectedTarget.name}.`);
    showToast(`Sync link saved: ${selectedSource.name} to ${selectedTarget.name}.`);
  }

  async function deleteLink(linkId: string) {
    const link = links.data.find((candidate) => candidate.id === linkId);
    if (!link) return;
    setSaveState("checking");
    try {
      const persistedLinks = await saveLinkState(workloadClient, links.data.filter((candidate) => candidate.id !== linkId));
      setLinks({ state: persistedLinks.length ? "ready" : "no-data", data: persistedLinks, updatedAt: new Date() });
      setSelectedId(persistedLinks[0]?.id ?? "");
      setDeleteConfirmId("");
      setSaveState("ready");
      setSaveMessage(`Deleted ${link.source} -> ${link.target} from links.json and lineage/graph.json.`);
      showToast("Sync link deleted.");
    } catch (error) {
      console.error("Delete Link failed", error);
      const code = typeof error === "object" && error && "code" in error ? String((error as { code?: unknown }).code) : "unknown";
      const message = `[${code}] ${error instanceof Error ? error.message : String(error)}`;
      setSaveState("failed");
      setSaveMessage(message);
      showToast(message);
    }
  }

  async function resolveNotebookLink(link: SyncLink, currentLinks: SyncLink[]) {
    let resolved = link;
    const missing: string[] = [];
    if (!resolved.sourceId) {
      const match = databases.data.find((database) => database.name === resolved.source);
      if (match) resolved = { ...resolved, sourceId: match.id };
      else missing.push(`source database "${resolved.source}"`);
    }
    if (!resolved.targetId) {
      const match = lakehouses.data.find((lakehouse) => lakehouse.name === resolved.target);
      if (match) resolved = { ...resolved, targetId: match.id };
      else missing.push(`target lakehouse "${resolved.target}"`);
    }
    if (missing.length) {
      throw new Error(`Cannot generate a notebook because the ${missing.join(" and ")} could not be resolved from the current lists. It may have been renamed or deleted.`);
    }
    if (resolved !== link) {
      const repaired = currentLinks.map((candidate) => candidate.id === link.id ? resolved : candidate);
      const persisted = await saveLinkState(workloadClient, repaired);
      setLinks({ state: persisted.length ? "ready" : "no-data", data: persisted, updatedAt: new Date() });
      resolved = persisted.find((candidate) => candidate.id === link.id) ?? resolved;
      return { link: resolved, links: persisted };
    }
    return { link: resolved, links: currentLinks };
  }

  async function generateNotebookFor(link: SyncLink, currentLinks = links.data) {
      setNotebookState("checking");
      setNotebookMessage(`Generating ${notebookNameFor(link)}…`);
      try {
        const resolved = await resolveNotebookLink(link, currentLinks);
        const resolvedLink = resolved.link;
        const token = await getFabricToken(workloadClient);
        if (!token) throw new DependencyError({ dependency: "identity", code: "token_unavailable", message: "Could not acquire the workload token." });
        const workspaceId = await resolveWorkspaceId(workloadClient);
        if (!decoderOptions.some((option) => option.value === resolvedLink.decoder)) {
          throw new DependencyError({
            dependency: "backend",
            code: "invalid_decoder",
            message: `decoder: "${String(resolvedLink.decoder)}" is not supported by this frontend.`,
          });
        }
        const notebook = await createNotebookArtifact(token, {
          workspaceId,
          displayName: notebookNameFor(resolvedLink),
          sourceDatabaseId: resolvedLink.sourceId,
          sourceDatabaseName: resolvedLink.source,
          lakehouseId: resolvedLink.targetId,
          lakehouseName: resolvedLink.target,
          tablePrefix: resolvedLink.prefix || undefined,
          decoder: resolvedLink.decoder,
        });
        const created: GeneratedNotebook = { ...notebook, createdAt: new Date().toISOString() };
        const persistedLinks = await saveLinkState(workloadClient, resolved.links.map((candidate) => candidate.id === resolvedLink.id ? { ...candidate, notebook: created, createNotebook: true } : candidate));
        setLinks({ state: persistedLinks.length ? "ready" : "no-data", data: persistedLinks, updatedAt: new Date() });
        setSelectedNotebookId(created.notebookId);
        setActiveTab("notebooks");
        setNotebookState("ready");
        setNotebookMessage(`Notebook generated: ${created.displayName}.`);
        showToast(`Notebook generated: ${created.displayName}.`);
      } catch (error) {
        console.error("Notebook generation failed", error);
        const issue = issueFrom(error, { dependency: "backend", message: "Notebook generation failed." });
        setNotebookState("failed");
        setNotebookMessage(`${issue.code ? `[${issue.code}] ` : ""}${issue.message}`);
        showToast(issue.message);
      }
    }

  async function saveSchedule(enabled: boolean) {
      if (!selectedNotebook || !workloadClient?.itemSchedule) return;
      setNotebookState("checking");
      setNotebookMessage("Saving notebook schedule…");
      try {
        const payload = schedulePayload(selectedNotebook.notebookId, scheduleCadence, enabled, schedule ?? undefined);
        const saved = schedule?.jobDefinitionObjectId
          ? await workloadClient.itemSchedule.updateItemScheduledJobs({ objectId: selectedNotebook.notebookId, payload })
          : await workloadClient.itemSchedule.createItemScheduledJobs({ objectId: selectedNotebook.notebookId, payload });
        setSchedule(saved);
        setNotebookState("ready");
        setNotebookMessage(enabled ? `Schedule enabled. Next run: ${saved.nextJobScheduleTime ?? saved.nextJobScheduleTimeUtc ?? "not reported yet"}.` : "Schedule disabled.");
      } catch (error) {
        console.error("Schedule save failed", error);
        setNotebookState("failed");
        setNotebookMessage(error instanceof Error ? error.message : String(error));
      }
    }

  async function runNotebookNow() {
      if (!selectedNotebook || !workloadClient?.itemSchedule) return;
      setNotebookState("checking");
      setNotebookMessage("Starting notebook run…");
      try {
        const run = await workloadClient.itemSchedule.runItemJob({ itemObjectId: selectedNotebook.notebookId, itemJobType: NOTEBOOK_JOB_TYPE, payload: { executionData: "{}" } });
        setJobHistory((current) => [run, ...current]);
        setNotebookState("ready");
        setNotebookMessage(`Run started: ${run.statusString}.`);
      } catch (error) {
        console.error("Run now failed", error);
        setNotebookState("failed");
        setNotebookMessage(error instanceof Error ? error.message : String(error));
      }
    }

  async function openNotebook(notebook: GeneratedNotebook) {
      if (!notebook.webUrl || !workloadClient?.navigation) return;
      try {
        await workloadClient.navigation.openBrowserTab({ url: notebook.webUrl });
      } catch (error) {
        console.error("Could not open notebook", error);
        setNotebookState("failed");
        setNotebookMessage(error instanceof Error ? error.message : String(error));
      }
  }

  async function onPreviewCdc() {
    if (!selectedSource) {
      setPreviewState("not-configured");
      setPreviewText("Select a premium asmDB database before requesting a CDC preview.");
      setPreviewRows([]);
      return;
    }
    setPreviewState("checking");
    setPreviewText("Requesting a bounded CDC preview from the backend.");
    try {
      const token = await getFabricToken(workloadClient);
      if (!token) {
        throw new DependencyError({ dependency: "identity", code: "token_unavailable", message: "Could not acquire the workload token. Sign in to Fabric again or check consent for the workload application." });
      }
      const preview = await previewCdc(token, selectedSource.id);
      const text = JSON.stringify(preview, null, 2);
      const content = firstPreviewSample(preview);
      const rows = previewEntries(preview);
      setSample(content.slice(0, CONTENT_LIMIT_BYTES));
      setPreviewRows(rows);
      setPreviewState(rows.length || content || text !== "{}" ? "ready" : "no-data");
      setPreviewText(rows.length ? `${rows.length} CDC preview ${rows.length === 1 ? "entry" : "entries"} returned.` : "The request succeeded but no content sample was present in the preview payload.");
    } catch (error) {
      setPreviewState("failed");
      setPreviewText(issueFrom(error, { dependency: "backend", message: "CDC preview failed." }).message);
      setPreviewRows([]);
    }
  }

  return (
    <div className="appShell">
      <main id="main" className="mainContent workloadContent">
        <header className="topBar">
          <div className="titleCluster">
            <img className="smallLogo" src="/assets/asmdb-logo.png" alt="asmDB" width="48" height="48" />
            <div className="productTitle"><h1>asmDB Analytical Capabilities</h1><p>Analytical sync links from premium asmDB databases to Fabric lakehouses in this workspace.</p></div>
          </div>
          <div className="statusCluster">
            <ThemeModeControl preference={preference} effectiveTheme={effectiveTheme} onChange={setPreference} />
            <span className={`dependencyChip ${headerStatusClass}`}>{headerConnected ? `✓ Connected at ${formatTime(connection.updatedAt)}` : headerChecking ? "○ Checking dependencies" : `! ${issueText(headerIssue)}`}</span>
            <Button onClick={() => void refresh()}>Retry</Button>
          </div>
        </header>

        <section className="dashboard" aria-label="asmDB analytical dashboard">
          <section className="hero panel" aria-labelledby="overview-heading">
            <div className="introCard">
              <div className="heroVisual"><img src="/assets/asmdb-logo.png" alt="" width="150" height="150" /></div>
              <div><h2 id="overview-heading">Sync asmDB databases to Fabric lakehouses</h2><p>Create a link, generate the notebook, and track lineage from this workload item.</p></div>
            </div>
            <Kpi title="Premium asmDB databases" state={databases.state} value={databases.state === "ready" ? String(databases.data.length) : "—"} caption={databases.state === "no-data" ? "No premium databases visible for this user." : databases.state === "failed" ? issueText(databases.issue) : "From GET /api/databases."} />
            <Kpi title="Workspace lakehouses" state={lakehouses.state} value={lakehouses.state === "ready" ? String(lakehouses.data.length) : "—"} caption={lakehouses.state === "failed" ? issueText(lakehouses.issue) : "From Fabric workspace items."} />
            <Kpi title="Sync links" state={links.state} value={links.state === "ready" ? String(links.data.length) : "—"} caption={links.state === "no-data" ? "No links in links.json yet." : "From this item definition."} />
            <Kpi title="Sync health" state={jobHistory.length ? "ready" : links.state} value={jobHistory.length ? `${successfulRuns}/${jobHistory.length}` : "—"} caption={jobHistory.length ? `${failedRuns} failed notebook runs in history.` : "Unknown until a real run record exists."} />
          </section>

          <div className="tabBar" role="tablist" aria-label="Workload views">
            <button type="button" role="tab" aria-selected={activeTab === "links"} className={activeTab === "links" ? "selected" : ""} onClick={() => setActiveTab("links")}>Sync links</button>
            <button type="button" role="tab" aria-selected={activeTab === "notebooks"} className={activeTab === "notebooks" ? "selected" : ""} onClick={() => setActiveTab("notebooks")}>Notebooks {notebooks.length ? `(${notebooks.length})` : ""}</button>
            <button type="button" role="tab" aria-selected={activeTab === "monitoring"} className={activeTab === "monitoring" ? "selected" : ""} onClick={() => setActiveTab("monitoring")}>Monitoring</button>
          </div>

          {activeTab === "links" ? <section className="middleGrid">
            <article className="panel" aria-labelledby="create-heading">
              <div className="panelHead"><h2 id="create-heading"><span aria-hidden="true">ↄ</span>Create Sync Link</h2></div>
              <form className="formGrid" onSubmit={(event) => event.preventDefault()}>
                <label htmlFor="source">Source Database</label>
                <Dropdown id="source" value={selectedSource?.name ?? stateLabel(databases.state)} selectedOptions={sourceId ? [sourceId] : []} onOptionSelect={onSelect(setSourceId)} disabled={!databases.data.length}>
                  {databases.data.map((database) => <Option key={database.id} value={database.id}>{database.name}</Option>)}
                </Dropdown>
                <FieldState loadable={databases} empty="No premium asmDB databases are available for this Fabric identity. If this is unexpected, check asmDB Cloud access and premium tier." />

                <label htmlFor="target">Target Lakehouse</label>
                <Dropdown id="target" value={selectedTarget?.name ?? stateLabel(lakehouses.state)} selectedOptions={targetId ? [targetId] : []} onOptionSelect={onSelect(setTargetId)} disabled={!lakehouses.data.length}>
                  {lakehouses.data.map((lakehouse) => <Option key={lakehouse.id} value={lakehouse.id}>{lakehouse.name}</Option>)}
                </Dropdown>
                <FieldState loadable={lakehouses} empty="No lakehouses were found in the current Fabric workspace." />

                <label htmlFor="prefix">Target Table Prefix</label>
                <Input id="prefix" value={prefix} onChange={(_, data) => setPrefix(data.value)} placeholder="Optional prefix" />
                <div className="checkboxRow"><Checkbox id="notebook" checked={createNotebook} onChange={(_, data) => setCreateNotebook(Boolean(data.checked))} label="Create Notebook" /><p className="fieldCaption inlineCaption">Generates a Fabric notebook after the link is saved, then stores the notebook id with the link.</p></div>

                <section className="decoderBox" aria-labelledby="decoder-heading">
                  <div className="decoderTitle"><h3 id="decoder-heading">Content decoding</h3><div className="decoderActions"><Button size="small" type="button" onClick={onPreviewCdc} disabled={!selectedSource || previewState === "checking"}>{previewState === "checking" ? "Fetching…" : "Fetch CDC sample"}</Button><span className="surfaceBadge">{byteLength(sample)} / {CONTENT_LIMIT_BYTES} bytes</span></div></div>
                  <div className="decoderGrid">
                    <label htmlFor="decoder">Decoder</label>
                    <Dropdown id="decoder" value={decoderOptions.find((item) => item.value === decoder)?.label} selectedOptions={[decoder]} onOptionSelect={onDecoderSelect}>
                      {decoderOptions.map((item) => <Option key={item.value} value={item.value}>{item.label}</Option>)}
                    </Dropdown>
                    <label htmlFor="sample">Content sample</label>
                    <Textarea id="sample" value={sample} readOnly placeholder="Use Fetch CDC sample to load real content from the selected database." resize="vertical" />
                  </div>
                  <p className="helpText">Decoder defaults to None. Changing a decoder requires a reseed. Raw content is always retained as content_raw.</p>
                  <div className="previewBox">
                    <div><span>Decoded preview</span><span className={`surfaceBadge ${decoded.failed ? "surfaceBadgeDanger" : ""}`}>{decoded.status}</span></div>
                    <pre aria-live="polite">{decoded.preview}</pre>
                  </div>
                </section>
                <div className="actions"><Button type="button" onClick={onPreviewCdc} disabled={!selectedSource || previewState === "checking"}>{previewState === "checking" ? "Fetching…" : "Preview CDC"}</Button>{/* Fabric sandboxes workload iframes without allow-forms, so this must not be a submit button: native form submission is blocked before React receives onSubmit. */}<Button appearance="primary" type="button" onClick={() => void createLink()} disabled={!canCreate || saveState === "checking"}>{saveState === "checking" ? "Saving…" : "✦ Create Link"}</Button></div>
                <div className="saveStatus"><StateMessage state={saveState} text={saveMessage} /></div>
              </form>
            </article>

            <article className="panel" aria-labelledby="lineage-heading">
              <div className="panelHead"><h2 id="lineage-heading"><span aria-hidden="true">⌘</span>Current Lineage</h2></div>
              <div className="lineageList">
                {lineage.edges.length ? <LineageDiagram graph={lineage} selectedId={selectedId} onSelect={selectLink} /> : <LineageEmpty state={links.state} text={links.state === "failed" ? issueText(links.issue) : "Create a sync link to draw asmDB databases on the left, Fabric lakehouses on the right, and status-labelled edges between them. The graph is stored in lineage/graph.json."} />}
                <LineageLegend />
              </div>
            </article>
          </section> : activeTab === "notebooks" ? <NotebooksView notebooks={notebooks} selectedNotebookId={selectedNotebook?.notebookId ?? ""} onSelect={setSelectedNotebookId} onGenerate={generateNotebookFor} links={links.data} state={notebookState} message={notebookMessage} schedule={schedule} cadence={scheduleCadence} onCadence={setScheduleCadence} onSaveSchedule={saveSchedule} onRunNow={runNotebookNow} onOpen={openNotebook} history={jobHistory} /> : <MonitoringView links={links.data} activityRows={activityRows} activeLinks={activeLinks} plannedLinks={plannedLinks} warningLinks={warningLinks} successfulRuns={successfulRuns} failedRuns={failedRuns} onSelect={selectLink} />}

          <section className="panel cdcPanel" aria-labelledby="cdc-heading"><div className="panelHead"><h2 id="cdc-heading"><span aria-hidden="true">▤</span>CDC Preview</h2></div><div className="panelBody"><StateMessage state={previewState} text={previewText} />{previewRows.length ? <CdcPreview entries={previewRows} /> : null}</div></section>

          <footer className="footer"><span>{connection.updatedAt ? `✓ Data checked: ${formatTime(connection.updatedAt)}` : "○ Data not checked yet"}</span></footer>
        </section>
      </main>
      {detailsOpen && selectedLink ? <div className="detailOverlay" role="dialog" aria-modal="true" aria-labelledby="detail-heading"><article className="panel detailPopup"><div className="panelHead"><h2 id="detail-heading"><span aria-hidden="true">ↄ</span>Selected Link Details</h2><Button type="button" onClick={() => setDetailsOpen(false)}>Close</Button></div><LinkSummary link={selectedLink} confirmDelete={deleteConfirmId === selectedLink.id} onAskDelete={() => setDeleteConfirmId(selectedLink.id)} onCancelDelete={() => setDeleteConfirmId("")} onDelete={() => void deleteLink(selectedLink.id)} onGenerateNotebook={() => void generateNotebookFor(selectedLink)} /></article></div> : null}
      <div className={`toast ${toast ? "show" : ""}`} role="status" aria-live="polite">{toast}</div>
    </div>
  );
}

function Kpi({ title, value, caption, state }: { title: string; value: string; caption: string; state: RequestState }) {
  return <article className="kpi"><span>{title}</span><strong>{value}</strong><em>{stateLabel(state)} · {caption}</em></article>;
}

function FieldState<T>({ loadable, empty }: { loadable: Loadable<T[]>; empty: string }) {
  if (loadable.state === "ready") return null;
  const text = loadable.state === "failed" ? issueText(loadable.issue) : loadable.state === "checking" ? "Checking…" : empty;
  return <p className="fieldCaption">{text}</p>;
}

function ThemeModeControl({ preference, effectiveTheme, onChange }: { preference: ThemePreference; effectiveTheme: "light" | "dark"; onChange: (preference: ThemePreference) => void }) {
  const options: { value: ThemePreference; label: string }[] = [
    { value: "auto", label: `Auto (${effectiveTheme})` },
    { value: "light", label: "Light" },
    { value: "dark", label: "Dark" },
  ];
  return <div className="themeModeControl" role="group" aria-label="Theme mode">
    {options.map((option) => <button key={option.value} type="button" className={preference === option.value ? "selected" : ""} aria-pressed={preference === option.value} onClick={() => onChange(option.value)}>{option.label}</button>)}
  </div>;
}

function StateMessage({ state, text }: { state: RequestState; text: string }) {
  return <div className={`stateMessage ${state}`}><strong>{stateLabel(state)}</strong><pre>{text}</pre></div>;
}

function LineageLegend() {
  return <div className="legend lineageLegend" aria-label="Lineage visual treatments">
    <span><i className="legendLine stateActive" />Active</span>
    <span><i className="legendLine statePlanned" />Planned</span>
    <span><i className="legendLine stateWarning" />Warning</span>
  </div>;
}

function MonitoringView({ links, activityRows, activeLinks, plannedLinks, warningLinks, successfulRuns, failedRuns, onSelect }: { links: SyncLink[]; activityRows: RunRecord[]; activeLinks: number; plannedLinks: number; warningLinks: number; successfulRuns: number; failedRuns: number; onSelect: (id: string) => void }) {
  return <section className="monitoringGrid">
    <article className="panel monitoringHero">
      <div className="panelHead"><h2><span aria-hidden="true">◴</span>Run monitoring</h2></div>
      <div className="monitorStats">
        <div><strong>{activityRows.length || "—"}</strong><span>real run records</span></div>
        <div><strong>{successfulRuns || "—"}</strong><span>successful runs</span></div>
        <div><strong>{failedRuns || "—"}</strong><span>failed runs</span></div>
        <div><strong>{links.length || "—"}</strong><span>saved links</span></div>
      </div>
    </article>
    <article className="panel">
      <div className="panelHead"><h2><span aria-hidden="true">▤</span>Recent Sync Activity</h2></div>
      {activityRows.length ? <div className="activityList">{activityRows.map((row) => <button type="button" className="activityItem" key={row.id} onClick={() => { const link = links.find((candidate) => candidate.source === row.source && candidate.target === row.target); if (link) onSelect(link.id); }}><span>{row.source} → {row.target}</span><span className={`compactStatus ${statusClass(row.status)}`}>{statusIcon(row.status)} {row.status}</span><small>{row.lastRun ?? "Unknown"} · {row.lag ?? "Unknown"}</small></button>)}</div> : <div className="quietPanel"><span className="surfaceBadge">No runs yet</span><p>Run history appears here after generated notebooks run on demand or on schedule.</p></div>}
    </article>
    <article className="panel">
      <div className="panelHead"><h2><span aria-hidden="true">◇</span>Coverage & Readiness</h2></div>
      <div className="readinessSummary"><p>{links.length ? `${links.length} saved ${links.length === 1 ? "link" : "links"}: ${activeLinks} active, ${plannedLinks} planned, ${warningLinks} warning.` : "No coverage to report until a link is saved."}</p><div className="readinessBar" aria-hidden="true"><span className="barActive" style={{ flexGrow: activeLinks }} /><span className="barPlanned" style={{ flexGrow: plannedLinks }} /><span className="barWarning" style={{ flexGrow: warningLinks }} /></div><div className="linkHealthList">{links.map((link) => <button type="button" key={link.id} onClick={() => onSelect(link.id)}><span>{link.source} → {link.target}</span><span className={`compactStatus ${statusClass(link.status)}`}>{statusIcon(link.status)} {link.status}</span></button>)}</div></div>
    </article>
  </section>;
}

function LinkSummary({ link, confirmDelete, onAskDelete, onCancelDelete, onDelete, onGenerateNotebook }: { link: SyncLink; confirmDelete: boolean; onAskDelete: () => void; onCancelDelete: () => void; onDelete: () => void; onGenerateNotebook: () => void }) {
  return <div className="linkSummary">
    <div className="linkPair">
      <span className="linkEndpoint sourceEndpoint">▤ {link.source}</span>
      <span className="linkArrow">→</span>
      <span className="linkEndpoint targetEndpoint">⌂ {link.target}</span>
    </div>
    <span className={`compactStatus ${statusClass(link.status)}`}>{statusIcon(link.status)} {link.status}</span>
    <p>{link.status === "Planned" ? "This link is configured and waiting for its first real run." : "This link is selected in the lineage graph."}</p>
    <details className="linkMore">
      <summary>Show technical details</summary>
      <dl>
        <div><dt>Decoder</dt><dd>{decoderOptions.find((item) => item.value === link.decoder)?.label ?? "None"}</dd></div>
        <div><dt>Prefix</dt><dd>{link.prefix || "None"}</dd></div>
        <div><dt>Notebook</dt><dd>{link.notebook ? link.notebook.displayName : "Not generated"}</dd></div>
      </dl>
    </details>
    <div className="deleteZone">
      {!link.notebook ? <Button type="button" appearance="primary" onClick={onGenerateNotebook}>Generate notebook</Button> : <span className="surfaceBadge">Notebook ready</span>}
      {confirmDelete ? <div className="deleteConfirm"><span>Delete this link?</span><Button size="small" type="button" onClick={onCancelDelete}>Cancel</Button><Button size="small" appearance="primary" type="button" onClick={onDelete}>Delete</Button></div> : <Button type="button" onClick={onAskDelete}>Delete link</Button>}
    </div>
  </div>;
}

function NotebooksView({
  notebooks,
  selectedNotebookId,
  onSelect,
  onGenerate,
  links,
  state,
  message,
  schedule,
  cadence,
  onCadence,
  onSaveSchedule,
  onRunNow,
  onOpen,
  history,
}: {
  notebooks: Array<GeneratedNotebook & { link: SyncLink }>;
  selectedNotebookId: string;
  onSelect: (id: string) => void;
  onGenerate: (link: SyncLink) => void;
  links: SyncLink[];
  state: RequestState;
  message: string;
  schedule: ItemSchedule | null;
  cadence: "Hourly" | "Daily";
  onCadence: (cadence: "Hourly" | "Daily") => void;
  onSaveSchedule: (enabled: boolean) => void;
  onRunNow: () => void;
  onOpen: (notebook: GeneratedNotebook) => void;
  history: ItemJobInstance[];
}) {
  const selected = notebooks.find((notebook) => notebook.notebookId === selectedNotebookId) ?? notebooks[0] ?? null;
  return <section className="notebooksGrid">
    <article className="panel notebookListPanel">
      <div className="panelHead"><h2><span aria-hidden="true">▤</span>Generated notebooks</h2></div>
      <div className="notebookList">
        {notebooks.length ? notebooks.map((notebook) => <button type="button" key={notebook.notebookId} className={selected?.notebookId === notebook.notebookId ? "notebookItem selected" : "notebookItem"} onClick={() => onSelect(notebook.notebookId)}><strong>{notebook.displayName}</strong><span>{notebook.link.source} → {notebook.link.target}</span><small>Created {new Date(notebook.createdAt).toLocaleString()}</small></button>) : <StateMessage state="no-data" text="No generated notebooks yet. Choose a saved link below to create one." />}
        {!notebooks.length && links.length ? <div className="generateList">{links.map((link) => <Button key={link.id} type="button" appearance="primary" onClick={() => onGenerate(link)}>Generate notebook for {link.source} → {link.target}</Button>)}</div> : null}
      </div>
    </article>
    <article className="panel notebookDetailPanel">
      <div className="panelHead"><h2><span aria-hidden="true">⌘</span>Notebook details</h2></div>
      {selected ? <div className="notebookDetail">
        <div className="notebookHero">
          <div><h3>{selected.displayName}</h3><p>{selected.link.source} → {selected.link.target}</p></div>
          <div className="notebookActions">{selected.webUrl ? <Button type="button" onClick={() => onOpen(selected)}>Open in Fabric</Button> : null}<Button type="button" appearance="primary" onClick={onRunNow}>Run now</Button></div>
        </div>
        <StateMessage state={state} text={message} />
        <section className="scheduleBox" aria-labelledby="schedule-heading">
          <h3 id="schedule-heading">Schedule</h3>
          <p className="scheduleNote">Direct notebook schedules run as the user who created or last updated the schedule. For durable unattended operation, use a Data Factory pipeline with Workspace Identity authentication.</p>
          <div className="scheduleControls">
            <label htmlFor="cadence">Cadence</label>
            <Dropdown id="cadence" value={cadence} selectedOptions={[cadence]} onOptionSelect={(_, data) => { if (data.optionValue === "Hourly" || data.optionValue === "Daily") onCadence(data.optionValue); }}>
              <Option value="Hourly">Hourly</Option>
              <Option value="Daily">Daily</Option>
            </Dropdown>
            <Button type="button" onClick={() => onSaveSchedule(true)}>Enable schedule</Button>
            <Button type="button" onClick={() => onSaveSchedule(false)}>Disable</Button>
          </div>
          <p className="fieldCaption inlineCaption">Current: {schedule?.scheduleEnabled ? `${schedule.scheduleType}; next run ${schedule.nextJobScheduleTime ?? schedule.nextJobScheduleTimeUtc ?? "not reported"}` : "disabled or not created yet"}.</p>
        </section>
        <section className="codePreview" aria-labelledby="code-heading"><h3 id="code-heading">PySpark preview</h3><pre>{notebookCodeFor(selected.link)}</pre></section>
        <section className="jobHistory" aria-labelledby="history-heading"><h3 id="history-heading">Recent runs</h3>{history.length ? <div className="tableWrap"><table><thead><tr><th>Status</th><th>Scheduled</th><th>Started</th><th>Ended</th></tr></thead><tbody>{history.slice(0, 5).map((job) => <tr key={job.itemJobInstanceId}><td>{job.statusString}</td><td>{job.jobScheduleTimeUtc || "—"}</td><td>{job.jobStartTimeUtc || "—"}</td><td>{job.jobEndTimeUtc || "—"}</td></tr>)}</tbody></table></div> : <p className="fieldCaption inlineCaption">No real job history returned yet.</p>}</section>
      </div> : <StateMessage state="not-configured" text="Generate a notebook from a saved link to preview code and configure scheduling." />}
    </article>
  </section>;
}

function LineageEmpty({ state, text }: { state: RequestState; text: string }) {
  return <div className="lineageEmpty"><svg viewBox="0 0 720 220" role="img" aria-label="Empty lineage diagram placeholder"><defs><linearGradient id="emptyEdge" x1="0" x2="1"><stop offset="0%" stopColor="var(--asmdb-accent)" /><stop offset="100%" stopColor="var(--asmdb-accent-2)" /></linearGradient></defs><rect className="lineageGhostNode" x="34" y="54" width="190" height="52" rx="6" /><rect className="lineageGhostNode" x="496" y="54" width="190" height="52" rx="6" /><path className="lineageGhostEdge" d="M232 80 C330 28 390 28 488 80" /><rect className="lineageGhostNode" x="34" y="130" width="190" height="52" rx="6" /><rect className="lineageGhostNode" x="496" y="130" width="190" height="52" rx="6" /><path className="lineageGhostEdge dashed" d="M232 156 C330 204 390 204 488 156" /><text className="lineageGhostLabel" x="129" y="85" textAnchor="middle">asmDB database</text><text className="lineageGhostLabel" x="591" y="85" textAnchor="middle">Fabric lakehouse</text><text className="lineageGhostLabel" x="360" y="116" textAnchor="middle">Active · Planned · Warning</text></svg><StateMessage state={state === "failed" ? "failed" : "no-data"} text={text} /></div>;
}

function LineageDiagram({ graph, selectedId, onSelect }: { graph: ReturnType<typeof graphFromLinks>; selectedId: string; onSelect: (id: string) => void }) {
  const databases = graph.nodes.filter((node) => node.kind === "database");
  const lakehouses = graph.nodes.filter((node) => node.kind === "lakehouse");
  const height = Math.max(260, Math.max(databases.length, lakehouses.length, graph.edges.length) * 96 + 70);
  const sourceTotals = graph.edges.reduce<Record<string, number>>((totals, edge) => ({ ...totals, [edge.source]: (totals[edge.source] ?? 0) + 1 }), {});
  const targetTotals = graph.edges.reduce<Record<string, number>>((totals, edge) => ({ ...totals, [edge.target]: (totals[edge.target] ?? 0) + 1 }), {});
  const sourceSeen: Record<string, number> = {};
  const targetSeen: Record<string, number> = {};
  const yFor = (nodes: typeof graph.nodes, id: string) => {
    const index = Math.max(0, nodes.findIndex((node) => node.id === id));
    return 58 + index * 96;
  };
  const anchorY = (baseY: number, total: number, ordinal: number) => baseY + 12 + ((ordinal + 1) * 36) / (total + 1);
  const firstEdgeForNode = (nodeId: string) => graph.edges.find((edge) => edge.source === nodeId || edge.target === nodeId);
  const selectNode = (nodeId: string) => {
    const edge = firstEdgeForNode(nodeId);
    if (edge) onSelect(edge.id);
  };
  const onNodeKeyDown = (nodeId: string) => (event: KeyboardEvent<SVGGElement>) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      selectNode(nodeId);
    }
  };
  return <><svg className="lineageSvg" viewBox={`0 0 900 ${height}`} role="img" aria-label="Current lineage graph">
    <defs><marker id="lineageArrow" viewBox="0 0 10 10" refX="7" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor" /></marker></defs>
    <text className="lineageColumnTitle" x="170" y="30" textAnchor="middle">asmDB databases</text>
    <text className="lineageColumnTitle" x="730" y="30" textAnchor="middle">Fabric lakehouses</text>
    {databases.map((node) => <g key={node.id} className={`lineageNodeGroup ${selectedId && graph.edges.find((edge) => edge.id === selectedId)?.source === node.id ? "selected" : ""}`} role="button" tabIndex={0} onClick={() => selectNode(node.id)} onKeyDown={onNodeKeyDown(node.id)} aria-label={`Select first link from ${node.label}`}><rect className="lineageNode lineageSource" x="40" y={yFor(databases, node.id)} width="260" height="60" rx="6" /><text className="lineageNodeText" x="64" y={yFor(databases, node.id) + 37}>▤ {node.label}</text></g>)}
    {lakehouses.map((node) => <g key={node.id} className={`lineageNodeGroup ${selectedId && graph.edges.find((edge) => edge.id === selectedId)?.target === node.id ? "selected" : ""}`} role="button" tabIndex={0} onClick={() => selectNode(node.id)} onKeyDown={onNodeKeyDown(node.id)} aria-label={`Select first link to ${node.label}`}><rect className="lineageNode lineageTarget" x="600" y={yFor(lakehouses, node.id)} width="260" height="60" rx="6" /><text className="lineageNodeText" x="624" y={yFor(lakehouses, node.id) + 37}>⌂ {node.label}</text></g>)}
    {graph.edges.map((edge) => {
      const sourceNode = graph.nodes.find((node) => node.id === edge.source);
      const targetNode = graph.nodes.find((node) => node.id === edge.target);
      const sourceOrdinal = sourceSeen[edge.source] ?? 0;
      const targetOrdinal = targetSeen[edge.target] ?? 0;
      sourceSeen[edge.source] = sourceOrdinal + 1;
      targetSeen[edge.target] = targetOrdinal + 1;
      const sourceY = anchorY(yFor(databases, edge.source), sourceTotals[edge.source] ?? 1, sourceOrdinal);
      const targetY = anchorY(yFor(lakehouses, edge.target), targetTotals[edge.target] ?? 1, targetOrdinal);
      const path = `M 312 ${sourceY} C 430 ${sourceY}, 470 ${targetY}, 588 ${targetY}`;
      return <g className={`lineageEdgeGroup ${statusClass(edge.status)} ${selectedId === edge.id ? "selected" : ""}`} key={edge.id} role="button" tabIndex={0} onClick={() => onSelect(edge.id)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onSelect(edge.id); } }} aria-label={`Select ${edge.status} link from ${sourceNode?.label ?? "database"} to ${targetNode?.label ?? "lakehouse"}`}>
        <title>{sourceNode?.label} to {targetNode?.label}: {statusIcon(edge.status)} {edge.status}</title>
        <path className="lineageEdgeHit" d={path} />
        <path className="lineageEdgePath" d={path} markerEnd="url(#lineageArrow)" />
      </g>;
    })}
  </svg><div className="lineageMobileList">{graph.edges.map((edge) => {
    const sourceNode = graph.nodes.find((node) => node.id === edge.source);
    const targetNode = graph.nodes.find((node) => node.id === edge.target);
    return <button key={edge.id} type="button" className="lineageMobileItem" onClick={() => onSelect(edge.id)}><span>▤ {sourceNode?.label}</span><span className={`compactStatus ${statusClass(edge.status)}`}>{statusIcon(edge.status)} {edge.status}</span><span>⌂ {targetNode?.label}</span></button>;
  })}</div></>;
}

function CdcPreview({ entries }: { entries: PreviewEntry[] }) {
  return <div className="cdcPreview"><div className="cdcTableWrap"><table className="cdcTable"><thead><tr><th>Commit</th><th>Op</th><th>ID</th><th>Tag</th><th>Content</th><th>Value</th><th>Created</th><th>Updated</th></tr></thead><tbody>{entries.map((entry, index) => entry.kind === "reset" ? <tr key={`${entry.commitSeq}-${index}`}><td>{entry.commitSeq}</td><td colSpan={7}><span className="surfaceBadge">Reset marker</span> Log was seeded; no row operation in this frame.</td></tr> : <tr key={`${entry.commitSeq}-${entry.id}-${index}`}><td>{entry.commitSeq}</td><td>{entry.op}</td><td>{entry.id}</td><td>{entry.tag}</td><td><span className="truncateCell" title={entry.content}>{entry.content}</span></td><td>{entry.value}</td><td title={entry.created}>{formatEpochMilliseconds(entry.created)}</td><td title={entry.updated}>{formatEpochMilliseconds(entry.updated)}</td></tr>)}</tbody></table></div><div className="cdcCards">{entries.map((entry, index) => entry.kind === "reset" ? <article key={`${entry.commitSeq}-${index}`} className="cdcCard"><strong>Commit {entry.commitSeq}</strong><span className="surfaceBadge">Reset marker</span><p>Log was seeded; no row operation in this frame.</p></article> : <article key={`${entry.commitSeq}-${entry.id}-${index}`} className="cdcCard"><strong>Commit {entry.commitSeq} · {entry.op}</strong><dl><div><dt>ID</dt><dd>{entry.id}</dd></div><div><dt>Tag</dt><dd>{entry.tag}</dd></div><div><dt>Content</dt><dd title={entry.content}>{entry.content}</dd></div><div><dt>Value</dt><dd>{entry.value}</dd></div><div><dt>Created</dt><dd title={entry.created}>{formatEpochMilliseconds(entry.created)}</dd></div><div><dt>Updated</dt><dd title={entry.updated}>{formatEpochMilliseconds(entry.updated)}</dd></div></dl></article>)}</div></div>;
}

export default App;

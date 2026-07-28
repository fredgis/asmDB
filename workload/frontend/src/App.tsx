import { useCallback, useEffect, useMemo, useState } from "react";
import type { KeyboardEvent } from "react";
import { Button, Dropdown, Input, Option, Textarea } from "@fluentui/react-components";
import type { OptionOnSelectData, SelectionEvents } from "@fluentui/react-components";
import { useWorkloadClient } from "./context/WorkloadContext";
import { useThemePreference, type ThemePreference } from "./context/ThemePreferenceContext";
import { createNotebook as createNotebookArtifact, DependencyError, fetchDatabases, fetchHealth, previewCdc } from "./lib/api";
import { deleteNotebook, getFabricApiToken, listNotebookSchedules, runNotebookNow as runNotebookNowViaRest, saveNotebookSchedule, type FabricNotebookSchedule, type NotebookRunInstance, type ScheduleCadence, type ScheduleDraft } from "./lib/fabric-notebooks";
import { fetchLakehouses, resolveWorkspaceId } from "./lib/fabric";
import { getFabricToken } from "./lib/auth-helper";
import { byteLength, CONTENT_LIMIT_BYTES, decodeSample } from "./lib/decoder";
import { graphFromLinks, loadLinks, saveLinkState } from "./lib/onelake";
import type { DatabaseInfo, DecoderMode, GeneratedNotebook, LakehouseInfo, LinkState, LoadIssue, Loadable, NotebookStatus, RequestState, RunRecord, SyncLink } from "./types/workload";
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
const weekdays = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const timezoneMap: Record<string, string> = {
  UTC: "UTC",
  "Etc/UTC": "UTC",
  "Europe/Paris": "Romance Standard Time",
  "Europe/Brussels": "Romance Standard Time",
  "Europe/Madrid": "Romance Standard Time",
  "Europe/Berlin": "W. Europe Standard Time",
  "Europe/Amsterdam": "W. Europe Standard Time",
  "Europe/London": "GMT Standard Time",
  "America/New_York": "Eastern Standard Time",
  "America/Chicago": "Central Standard Time",
  "America/Denver": "Mountain Standard Time",
  "America/Los_Angeles": "Pacific Standard Time",
};

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

interface NotebookListItem {
  key: string;
  displayName: string;
  status: NotebookStatus | "not-created";
  link: SyncLink;
  notebook?: GeneratedNotebook;
}

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

function notebookStatusFor(link: SyncLink): NotebookListItem["status"] {
  if (link.notebookStatus) return link.notebookStatus;
  if (link.notebook) return "created";
  return "not-created";
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

function highlightPython(code: string) {
  const keywordPattern = /\b(from|import|as|if|else|elif|for|while|in|return|with|def|class|True|False|None)\b/g;
  const tokenPattern = /(#.*$|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\b\d+(?:\.\d+)?\b|\b(?:from|import|as|if|else|elif|for|while|in|return|with|def|class|True|False|None)\b)/gm;
  return code.split(tokenPattern).filter(Boolean).map((part, index) => {
    let className = "";
    if (part.startsWith("#")) className = "pyComment";
    else if (part.startsWith("\"") || part.startsWith("'")) className = "pyString";
    else if (/^\d/.test(part)) className = "pyNumber";
    else if (keywordPattern.test(part)) className = "pyKeyword";
    keywordPattern.lastIndex = 0;
    return className ? <span className={className} key={index}>{part}</span> : <span key={index}>{part}</span>;
  });
}

function pad(value: number) {
  return String(value).padStart(2, "0");
}

function toLocalDateTimeInput(date: Date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function withoutSeconds(value: string) {
  return value.slice(0, 16);
}

function toFabricLocalDateTime(value: string) {
  const normalised = value.includes("T") ? value : toLocalDateTimeInput(new Date(value));
  const [date, time = "00:00"] = normalised.split("T");
  return `${date}T${time.slice(0, 5)}:00`;
}

function defaultScheduleDraft(): ScheduleDraft {
  const now = new Date();
  now.setMinutes(Math.ceil(now.getMinutes() / 15) * 15, 0, 0);
  const end = new Date(now);
  end.setFullYear(end.getFullYear() + 1);
  const iana = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  return {
    cadence: "Daily",
    minuteInterval: 15,
    hourlyInterval: 1,
    time: "09:00",
    weekdays: ["Monday", "Wednesday", "Friday"],
    dayOfMonth: 15,
    startDateTime: toLocalDateTimeInput(now),
    endDateTime: toLocalDateTimeInput(end),
    localTimeZoneId: timezoneMap[iana] ?? "UTC",
  };
}

function draftFromSchedule(schedule: FabricNotebookSchedule | null): ScheduleDraft {
  const draft = defaultScheduleDraft();
  if (!schedule?.configuration) return draft;
  const config = schedule.configuration;
  const firstTime = config.times?.[0] ?? draft.time;
  return {
    ...draft,
    cadence: config.type === "Cron" ? (config.interval && config.interval < 60 ? "Minute" : "Hourly") : config.type,
    minuteInterval: config.type === "Cron" && config.interval && config.interval < 60 ? config.interval : draft.minuteInterval,
    hourlyInterval: config.type === "Cron" && config.interval && config.interval >= 60 ? Math.max(1, Math.round(config.interval / 60)) : draft.hourlyInterval,
    time: firstTime,
    weekdays: config.weekdays?.length ? config.weekdays : draft.weekdays,
    dayOfMonth: config.occurrence?.dayOfMonth ?? draft.dayOfMonth,
    startDateTime: config.startDateTime ? withoutSeconds(config.startDateTime) : draft.startDateTime,
    endDateTime: config.endDateTime ? withoutSeconds(config.endDateTime) : draft.endDateTime,
    localTimeZoneId: config.localTimeZoneId ?? draft.localTimeZoneId,
  };
}

function scheduleBody(draft: ScheduleDraft, enabled: boolean) {
  const common = {
    startDateTime: toFabricLocalDateTime(draft.startDateTime),
    endDateTime: toFabricLocalDateTime(draft.endDateTime),
    localTimeZoneId: draft.localTimeZoneId || "UTC",
  };
  if (draft.cadence === "Minute") return { enabled, configuration: { type: "Cron" as const, interval: Math.max(1, draft.minuteInterval), ...common } };
  if (draft.cadence === "Hourly") return { enabled, configuration: { type: "Cron" as const, interval: Math.max(1, draft.hourlyInterval) * 60, ...common } };
  if (draft.cadence === "Daily") return { enabled, configuration: { type: "Daily" as const, times: [draft.time], ...common } };
  if (draft.cadence === "Weekly") return { enabled, configuration: { type: "Weekly" as const, times: [draft.time], weekdays: draft.weekdays.length ? draft.weekdays : ["Monday"], ...common } };
  return { enabled, configuration: { type: "Monthly" as const, times: [draft.time], recurrence: 1, occurrence: { occurrenceType: "DayOfMonth" as const, dayOfMonth: Math.min(31, Math.max(1, draft.dayOfMonth)) }, ...common } };
}

function nextRunText(schedule: FabricNotebookSchedule | null) {
  return schedule?.nextRunDateTime ?? schedule?.nextRunTime ?? "not reported yet";
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
  const [decoder, setDecoder] = useState<DecoderMode>("none");
  const [sample, setSample] = useState("");
  const [toast, setToast] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState("");
  const [previewState, setPreviewState] = useState<RequestState>("not-configured");
  const [previewText, setPreviewText] = useState("Select a premium asmDB database and request a CDC preview. No sample has been fetched yet.");
  const [previewRows, setPreviewRows] = useState<PreviewEntry[]>([]);
  const [saveState, setSaveState] = useState<RequestState>("not-configured");
  const [saveMessage, setSaveMessage] = useState("");
  const [deleteConfirmId, setDeleteConfirmId] = useState("");
  const [activeTab, setActiveTab] = useState<"links" | "notebooks" | "monitoring">("links");
  const [selectedNotebookId, setSelectedNotebookId] = useState("");
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [notebookState, setNotebookState] = useState<RequestState>("not-configured");
  const [notebookMessage, setNotebookMessage] = useState("Create a link to create its notebook automatically.");
  const [schedule, setSchedule] = useState<FabricNotebookSchedule | null>(null);
  const [jobHistory, setJobHistory] = useState<NotebookRunInstance[]>([]);
  const [scheduleDraft, setScheduleDraft] = useState<ScheduleDraft>(() => defaultScheduleDraft());

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
  // Keep notebook rows stable so schedule effects depend on the notebook id
  // instead of a new object identity on every render.
  const notebooks = useMemo(
    () => links.data
      .filter((link) => link.notebook || link.notebookStatus || link.notebookError)
      .map((link) => ({
        key: link.notebook?.notebookId ?? link.id,
        displayName: link.notebook?.displayName ?? notebookNameFor(link),
        status: notebookStatusFor(link),
        notebook: link.notebook,
        link,
      })),
    [links.data]
  );
  const selectedNotebook = useMemo(
    () => notebooks.find((notebook) => notebook.key === selectedNotebookId) ?? notebooks[0] ?? null,
    [notebooks, selectedNotebookId]
  );
  const lineage = useMemo(() => graphFromLinks(links.data), [links.data]);
  const activeLinks = links.data.filter((link) => link.status === "Active").length;
  const plannedLinks = links.data.filter((link) => link.status === "Planned").length;
  const warningLinks = links.data.filter((link) => link.status === "Warning").length;
  const successfulRuns = jobHistory.filter((job) => `${job.status ?? ""}`.toLowerCase().includes("success")).length;
  const failedRuns = jobHistory.filter((job) => `${job.status ?? ""}`.toLowerCase().includes("fail")).length;
  const decoded = useMemo(() => {
    if (!sample) return { status: decoderOptions.find((item) => item.value === decoder)?.label ?? "None", preview: "No CDC sample fetched yet.", failed: false };
    try {
      return { ...decodeSample(decoder, sample), failed: false };
    } catch (error) {
      return { status: decoderOptions.find((item) => item.value === decoder)?.label ?? decoder, preview: `Decoder error: ${error instanceof Error ? error.message : String(error)}`, failed: true };
    }
  }, [decoder, sample]);

  const activityRows: RunRecord[] = jobHistory.length && selectedNotebook
    ? jobHistory.slice(0, 5).map((job, index) => ({ id: job.id ?? `run-${index}`, source: selectedNotebook.link.source, target: selectedNotebook.link.target, status: `${job.status ?? ""}`.toLowerCase().includes("fail") ? "Failed" : "Active", lastRun: job.createdDateTime ?? new Date().toISOString(), lag: job.status ?? "Accepted" }))
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
    setSelectedNotebookId((current) => current && notebooks.some((notebook) => notebook.key === current) ? current : notebooks[0]?.key ?? "");
  }, [notebooks]);

  const selectedNotebookKey = selectedNotebook?.notebook?.notebookId ?? "";

  useEffect(() => {
    if (!selectedNotebookKey) {
      setSchedule(null);
      setJobHistory([]);
      setScheduleDraft(defaultScheduleDraft());
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const token = await getFabricApiToken(workloadClient);
        if (!token) throw new DependencyError({ dependency: "identity", code: "fabric_token_unavailable", message: "Could not acquire a Fabric API token for notebook schedules." });
        const workspaceId = await resolveWorkspaceId(workloadClient);
        const schedules = await listNotebookSchedules(token, workspaceId, selectedNotebookKey);
        if (cancelled) return;
        const notebookSchedule = schedules[0] ?? null;
        setSchedule(notebookSchedule);
        setScheduleDraft(draftFromSchedule(notebookSchedule));
        setJobHistory([]);
      } catch (error) {
        if (cancelled) return;
        console.error("Could not read notebook schedules", error);
        setSchedule(null);
        setScheduleDraft(defaultScheduleDraft());
        setJobHistory([]);
      }
    })();
    return () => { cancelled = true; };
  }, [selectedNotebookKey, workloadClient]);

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
      status: "Planned",
      notebookStatus: "creating",
    };
    const nextLinks = [link, ...links.data];
    try {
      const persistedLinks = await saveLinkState(workloadClient, nextLinks);
      setLinks({ state: persistedLinks.length ? "ready" : "no-data", data: persistedLinks, updatedAt: new Date() });
      const savedLink = persistedLinks.find((saved) => saved.id === link.id) ?? link;
      setSelectedId(savedLink.id);
      setSaveState("ready");
      setSaveMessage(`Saved to links.json and lineage/graph.json: ${selectedSource.name} -> ${selectedTarget.name}. Creating notebook…`);
      showToast(`Sync link saved: ${selectedSource.name} to ${selectedTarget.name}. Creating notebook…`);
      await generateNotebookFor(savedLink, persistedLinks);
    } catch (error) {
      console.error("Create Link failed", error);
      const code = typeof error === "object" && error && "code" in error ? String((error as { code?: unknown }).code) : "unknown";
      const message = `[${code}] ${error instanceof Error ? error.message : String(error)}`;
      setSaveState("failed");
      setSaveMessage(message);
      showToast(message);
      return;
    }
  }

  async function deleteLink(linkId: string) {
    const link = links.data.find((candidate) => candidate.id === linkId);
    if (!link) return;
    setSaveState("checking");

    let notebookOutcome = "";
    if (link.notebook?.notebookId) {
      try {
        const token = await getFabricApiToken(workloadClient);
        if (!token) throw new Error("A Fabric API token was not returned.");
        const workspaceId = await resolveWorkspaceId(workloadClient);
        await deleteNotebook(token, workspaceId, link.notebook.notebookId);
        notebookOutcome = ` Notebook "${link.notebook.displayName}" was deleted.`;
      } catch (error) {
        console.error("Notebook delete failed", error);
        const reason = error instanceof Error ? error.message : String(error);
        notebookOutcome = ` Notebook "${link.notebook.displayName}" could not be deleted and still exists in the workspace: ${reason}`;
      }
    }

    try {
      const persistedLinks = await saveLinkState(workloadClient, links.data.filter((candidate) => candidate.id !== linkId));
      setLinks({ state: persistedLinks.length ? "ready" : "no-data", data: persistedLinks, updatedAt: new Date() });
      setSelectedId(persistedLinks[0]?.id ?? "");
      setDeleteConfirmId("");
      setSaveState("ready");
      setSaveMessage(`Deleted ${link.source} -> ${link.target} from links.json and lineage/graph.json.${notebookOutcome}`);
      showToast(notebookOutcome.includes("could not be deleted") ? "Sync link deleted; the notebook remains." : "Sync link deleted.");
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
        const creatingLinks = currentLinks.map((candidate) => candidate.id === link.id ? { ...candidate, notebookStatus: "creating" as const, notebookError: undefined } : candidate);
        const creatingPersisted = await saveLinkState(workloadClient, creatingLinks);
        setLinks({ state: creatingPersisted.length ? "ready" : "no-data", data: creatingPersisted, updatedAt: new Date() });
        const creatingLink = creatingPersisted.find((candidate) => candidate.id === link.id) ?? link;
        const resolved = await resolveNotebookLink(creatingLink, creatingPersisted);
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
        const latest = await loadLinks(workloadClient);
        const baseLinks = latest.some((candidate) => candidate.id === resolvedLink.id) ? latest : resolved.links;
        const persistedLinks = await saveLinkState(workloadClient, baseLinks.map((candidate) => candidate.id === resolvedLink.id ? { ...candidate, notebook: created, notebookStatus: "created" as const, notebookError: undefined } : candidate));
        setLinks({ state: persistedLinks.length ? "ready" : "no-data", data: persistedLinks, updatedAt: new Date() });
        setSelectedNotebookId(created.notebookId);
        setActiveTab("notebooks");
        setNotebookState("ready");
        setNotebookMessage(`Notebook generated: ${created.displayName}.`);
        setSaveMessage(`Saved link and created notebook: ${created.displayName}.`);
        showToast(`Notebook generated: ${created.displayName}.`);
      } catch (error) {
        console.error("Notebook generation failed", error);
        const issue = issueFrom(error, { dependency: "backend", message: "Notebook generation failed." });
        try {
          const latest = await loadLinks(workloadClient);
          const baseLinks = latest.some((candidate) => candidate.id === link.id) ? latest : currentLinks;
          const failedLinks = baseLinks.map((candidate) => candidate.id === link.id ? { ...candidate, notebookStatus: "failed" as const, notebookError: `${issue.code ? `[${issue.code}] ` : ""}${issue.message}` } : candidate);
          const persistedLinks = await saveLinkState(workloadClient, failedLinks);
          setLinks({ state: persistedLinks.length ? "ready" : "no-data", data: persistedLinks, updatedAt: new Date() });
        } catch (persistError) {
          console.error("Could not persist notebook failure status", persistError);
        }
        setNotebookState("failed");
        setNotebookMessage(`${issue.code ? `[${issue.code}] ` : ""}${issue.message}`);
        setSaveMessage(`Link saved, but notebook creation failed: ${issue.message}`);
        showToast(issue.message);
      }
    }

  async function saveSchedule(enabled: boolean) {
      if (!selectedNotebook?.notebook) return;
      setNotebookState("checking");
      setNotebookMessage("Saving notebook schedule…");
      try {
        const token = await getFabricApiToken(workloadClient);
        if (!token) throw new DependencyError({ dependency: "identity", code: "fabric_token_unavailable", message: "Could not acquire a Fabric API token for notebook schedules." });
        const workspaceId = await resolveWorkspaceId(workloadClient);
        const saved = await saveNotebookSchedule(token, workspaceId, selectedNotebook.notebook.notebookId, scheduleBody(scheduleDraft, enabled), schedule?.id ?? selectedNotebook.link.notebookScheduleId);
        setSchedule(saved);
        setScheduleDraft(draftFromSchedule(saved));
        const latest = await loadLinks(workloadClient);
        const persistedLinks = await saveLinkState(workloadClient, latest.map((candidate) => candidate.id === selectedNotebook.link.id ? { ...candidate, notebookStatus: saved.enabled ? "scheduled" as const : "unscheduled" as const, notebookScheduleId: saved.id } : candidate));
        setLinks({ state: persistedLinks.length ? "ready" : "no-data", data: persistedLinks, updatedAt: new Date() });
        setNotebookState("ready");
        setNotebookMessage(enabled ? `Schedule enabled. Next run: ${nextRunText(saved)}.` : "Schedule disabled.");
      } catch (error) {
        console.error("Schedule save failed", error);
        const issue = issueFrom(error, { dependency: "fabric", message: "Notebook schedule request failed." });
        setNotebookState("failed");
        setNotebookMessage(`${issue.code ? `[${issue.code}] ` : ""}${issue.message}`);
      }
    }

  async function runNotebookNow() {
      if (!selectedNotebook?.notebook) return;
      setNotebookState("checking");
      setNotebookMessage("Starting notebook run…");
      try {
        const token = await getFabricApiToken(workloadClient);
        if (!token) throw new DependencyError({ dependency: "identity", code: "fabric_token_unavailable", message: "Could not acquire a Fabric API token to run the notebook." });
        const workspaceId = await resolveWorkspaceId(workloadClient);
        const run = await runNotebookNowViaRest(token, workspaceId, selectedNotebook.notebook.notebookId);
        setJobHistory((current) => [run, ...current]);
        setNotebookState("ready");
        setNotebookMessage(`Run accepted by Fabric${run.id ? `: ${run.id}` : ""}.`);
      } catch (error) {
        console.error("Run now failed", error);
        const issue = issueFrom(error, { dependency: "fabric", message: "Run now failed." });
        setNotebookState("failed");
        setNotebookMessage(`${issue.code ? `[${issue.code}] ` : ""}${issue.message}`);
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

          {activeTab === "links" ? <>
          <section className="middleGrid">
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
          </section>
          <section className="panel cdcPanel" aria-labelledby="cdc-heading"><div className="panelHead"><h2 id="cdc-heading"><span aria-hidden="true">▤</span>CDC Preview</h2></div><div className="panelBody"><StateMessage state={previewState} text={previewText} />{previewRows.length ? <CdcPreview entries={previewRows} /> : null}</div></section>
          </> : activeTab === "notebooks" ? <NotebooksView notebooks={notebooks} selectedNotebookId={selectedNotebook?.key ?? ""} onSelect={setSelectedNotebookId} state={notebookState} message={notebookMessage} schedule={schedule} draft={scheduleDraft} onDraft={setScheduleDraft} onSaveSchedule={saveSchedule} onRunNow={runNotebookNow} onOpen={openNotebook} history={jobHistory} /> : <MonitoringView links={links.data} activityRows={activityRows} activeLinks={activeLinks} plannedLinks={plannedLinks} warningLinks={warningLinks} successfulRuns={successfulRuns} failedRuns={failedRuns} onSelect={selectLink} />}

          <footer className="footer"><span>{connection.updatedAt ? `✓ Data checked: ${formatTime(connection.updatedAt)}` : "○ Data not checked yet"}</span></footer>
        </section>
      </main>
      {detailsOpen && selectedLink ? <div className="detailOverlay" role="dialog" aria-modal="true" aria-labelledby="detail-heading"><article className="panel detailPopup"><div className="panelHead"><h2 id="detail-heading"><span aria-hidden="true">ↄ</span>Selected Link Details</h2><Button type="button" onClick={() => setDetailsOpen(false)}>Close</Button></div><LinkSummary link={selectedLink} confirmDelete={deleteConfirmId === selectedLink.id} onAskDelete={() => setDeleteConfirmId(selectedLink.id)} onCancelDelete={() => setDeleteConfirmId("")} onDelete={() => void deleteLink(selectedLink.id)} /></article></div> : null}
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

function LinkSummary({ link, confirmDelete, onAskDelete, onCancelDelete, onDelete }: { link: SyncLink; confirmDelete: boolean; onAskDelete: () => void; onCancelDelete: () => void; onDelete: () => void }) {
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
      <span className={`surfaceBadge ${link.notebookStatus === "failed" ? "surfaceBadgeDanger" : ""}`}>{notebookStatusLabel(notebookStatusFor(link))}</span>
      {confirmDelete ? <div className="deleteConfirm"><span>{link.notebook ? `Delete this link and its notebook "${link.notebook.displayName}"?` : "Delete this link?"}</span><Button size="small" type="button" onClick={onCancelDelete}>Cancel</Button><Button size="small" appearance="primary" type="button" onClick={onDelete}>{link.notebook ? "Delete link and notebook" : "Delete link"}</Button></div> : <Button type="button" onClick={onAskDelete}>Delete link</Button>}
    </div>
  </div>;
}

function notebookStatusLabel(status: NotebookListItem["status"]) {
  switch (status) {
    case "creating": return "Creating";
    case "created": return "Created";
    case "scheduled": return "Scheduled";
    case "unscheduled": return "Not scheduled";
    case "failed": return "Failed to create";
    default: return "Not created";
  }
}

function NotebooksView({
  notebooks,
  selectedNotebookId,
  onSelect,
  state,
  message,
  schedule,
  draft,
  onDraft,
  onSaveSchedule,
  onRunNow,
  onOpen,
  history,
}: {
  notebooks: NotebookListItem[];
  selectedNotebookId: string;
  onSelect: (id: string) => void;
  state: RequestState;
  message: string;
  schedule: FabricNotebookSchedule | null;
  draft: ScheduleDraft;
  onDraft: (draft: ScheduleDraft) => void;
  onSaveSchedule: (enabled: boolean) => void;
  onRunNow: () => void;
  onOpen: (notebook: GeneratedNotebook) => void;
  history: NotebookRunInstance[];
}) {
  const selected = notebooks.find((notebook) => notebook.key === selectedNotebookId) ?? notebooks[0] ?? null;
  const selectedNotebook = selected?.notebook ?? null;
  const updateDraft = (patch: Partial<ScheduleDraft>) => onDraft({ ...draft, ...patch });
  const toggleWeekday = (day: string) => {
    const hasDay = draft.weekdays.includes(day);
    const next = hasDay ? draft.weekdays.filter((item) => item !== day) : [...draft.weekdays, day];
    updateDraft({ weekdays: next.length ? next : [day] });
  };
  return <section className="notebooksGrid">
    <article className="panel notebookListPanel">
      <div className="panelHead"><h2><span aria-hidden="true">▤</span>Generated notebooks</h2></div>
      <div className="notebookList">
        {notebooks.length ? notebooks.map((notebook) => <button type="button" key={notebook.key} className={selected?.key === notebook.key ? "notebookItem selected" : "notebookItem"} onClick={() => onSelect(notebook.key)}>
          <strong>{notebook.displayName}</strong>
          <span>{notebook.link.source} → {notebook.link.target}</span>
          <small><span className={`compactStatus ${notebook.status === "failed" ? "statusWarning" : notebook.status === "created" || notebook.status === "scheduled" ? "statusActive" : "statusPlanned"}`}>{notebookStatusLabel(notebook.status)}</span>{notebook.notebook ? ` · Created ${new Date(notebook.notebook.createdAt).toLocaleString()}` : ""}</small>
        </button>) : <StateMessage state="no-data" text="No notebooks yet. Create a sync link to create its notebook automatically." />}
      </div>
    </article>
    <article className="panel notebookDetailPanel">
      <div className="panelHead"><h2><span aria-hidden="true">⌘</span>Notebook details</h2></div>
      {selected ? <div className="notebookDetail">
        <div className="notebookHero">
          <div><h3>{selected.displayName}</h3><p>{selected.link.source} → {selected.link.target}</p></div>
          <div className="notebookActions">{selectedNotebook?.webUrl ? <Button type="button" onClick={() => onOpen(selectedNotebook)}>Open in Fabric</Button> : null}{selectedNotebook ? <Button type="button" appearance="primary" onClick={onRunNow}>Run now</Button> : null}</div>
        </div>
        <StateMessage state={selected.status === "failed" ? "failed" : selected.status === "creating" ? "checking" : selectedNotebook ? state : "not-configured"} text={selected.link.notebookError ?? (selectedNotebook ? message : "The link exists, but no notebook is attached to it. Create Link now creates notebooks automatically for new links; older links may need to be recreated.")} />
        {selectedNotebook ? <section className="scheduleBox" aria-labelledby="schedule-heading">
          <h3 id="schedule-heading">Schedule</h3>
          <p className="scheduleNote">Schedules use Fabric REST for first-party Notebook items. The token is requested for Fabric API Item.Execute.All and Item.ReadWrite.All scopes.</p>
          <div className="scheduleGrid">
            <label htmlFor="cadence">Cadence</label>
            <Dropdown id="cadence" value={draft.cadence} selectedOptions={[draft.cadence]} onOptionSelect={(_, data) => { if (data.optionValue) updateDraft({ cadence: data.optionValue as ScheduleCadence }); }}>
              <Option value="Minute">By the minute</Option>
              <Option value="Hourly">Hourly</Option>
              <Option value="Daily">Daily</Option>
              <Option value="Weekly">Weekly</Option>
              <Option value="Monthly">Monthly</Option>
            </Dropdown>
            {draft.cadence === "Minute" ? <><label htmlFor="minuteInterval">Every</label><Input id="minuteInterval" type="number" min="1" value={String(draft.minuteInterval)} onChange={(_, data) => updateDraft({ minuteInterval: Math.max(1, Number(data.value) || 15) })} contentAfter="minutes" /></> : null}
            {draft.cadence === "Hourly" ? <><label htmlFor="hourlyInterval">Every</label><Input id="hourlyInterval" type="number" min="1" value={String(draft.hourlyInterval)} onChange={(_, data) => updateDraft({ hourlyInterval: Math.max(1, Number(data.value) || 1) })} contentAfter="hours" /></> : null}
            {draft.cadence === "Daily" || draft.cadence === "Weekly" || draft.cadence === "Monthly" ? <><label htmlFor="scheduleTime">Time</label><Input id="scheduleTime" type="time" value={draft.time} onChange={(_, data) => updateDraft({ time: data.value })} /></> : null}
            {draft.cadence === "Weekly" ? <div className="weekdayPicker" role="group" aria-label="Weekdays">{weekdays.map((day) => <button key={day} type="button" className={draft.weekdays.includes(day) ? "selected" : ""} aria-pressed={draft.weekdays.includes(day)} onClick={() => toggleWeekday(day)}>{day.slice(0, 3)}</button>)}</div> : null}
            {draft.cadence === "Monthly" ? <><label htmlFor="dayOfMonth">Day of month</label><Input id="dayOfMonth" type="number" min="1" max="31" value={String(draft.dayOfMonth)} onChange={(_, data) => updateDraft({ dayOfMonth: Math.min(31, Math.max(1, Number(data.value) || 1)) })} /></> : null}
            <label htmlFor="startDateTime">Start</label><Input id="startDateTime" type="datetime-local" value={draft.startDateTime} onChange={(_, data) => updateDraft({ startDateTime: data.value })} />
            <label htmlFor="endDateTime">End</label><Input id="endDateTime" type="datetime-local" value={draft.endDateTime} onChange={(_, data) => updateDraft({ endDateTime: data.value })} />
            <label htmlFor="timeZone">Time zone</label><Input id="timeZone" value={draft.localTimeZoneId} onChange={(_, data) => updateDraft({ localTimeZoneId: data.value || "UTC" })} />
          </div>
          <div className="scheduleControls"><Button type="button" onClick={() => onSaveSchedule(true)} appearance="primary">Save schedule</Button><Button type="button" onClick={() => onSaveSchedule(false)}>Disable</Button></div>
          <p className="fieldCaption inlineCaption">Current: {schedule?.enabled ? `enabled; next run ${nextRunText(schedule)}` : "disabled or not created yet"}.</p>
        </section> : null}
        {selectedNotebook ? <section className="codePreview" aria-labelledby="code-heading"><h3 id="code-heading">PySpark preview</h3><pre>{highlightPython(notebookCodeFor(selected.link))}</pre></section> : null}
        {selectedNotebook ? <section className="jobHistory" aria-labelledby="history-heading"><h3 id="history-heading">Recent runs</h3>{history.length ? <div className="tableWrap"><table><thead><tr><th>Status</th><th>Accepted</th><th>Instance</th></tr></thead><tbody>{history.slice(0, 5).map((job, index) => <tr key={job.id ?? index}><td>{job.status ?? "Accepted"}</td><td>{job.createdDateTime || "just now"}</td><td>{job.id || "not returned"}</td></tr>)}</tbody></table></div> : <p className="fieldCaption inlineCaption">No run started from this session yet.</p>}</section> : null}
      </div> : <StateMessage state="not-configured" text="No notebook has been created yet. Create a sync link to create one automatically." />}
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

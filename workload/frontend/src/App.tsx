import { useCallback, useEffect, useMemo, useState } from "react";
import { Badge, Button, Checkbox, Dropdown, Input, Option, Textarea } from "@fluentui/react-components";
import type { OptionOnSelectData, SelectionEvents } from "@fluentui/react-components";
import { useWorkloadClient } from "./context/WorkloadContext";
import { DependencyError, fetchDatabases, fetchHealth, previewCdc } from "./lib/api";
import { fetchLakehouses, resolveWorkspaceId } from "./lib/fabric";
import { getFabricToken } from "./lib/auth-helper";
import { byteLength, CONTENT_LIMIT_BYTES, decodeSample } from "./lib/decoder";
import { graphFromLinks, loadLinks, saveLinkState } from "./lib/onelake";
import type { DatabaseInfo, DecoderMode, LakehouseInfo, LinkState, LoadIssue, Loadable, RequestState, RunRecord, SyncLink } from "./types/workload";
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
  const [databases, setDatabases] = useState<Loadable<DatabaseInfo[]>>(emptyLoadable([]));
  const [lakehouses, setLakehouses] = useState<Loadable<LakehouseInfo[]>>(emptyLoadable([]));
  const [links, setLinks] = useState<Loadable<SyncLink[]>>(emptyLoadable([]));
  const [connection, setConnection] = useState<Loadable<{ status?: string; version?: string }>>(emptyLoadable({}));
  const [sourceId, setSourceId] = useState("");
  const [targetId, setTargetId] = useState("");
  const [mode, setMode] = useState("CDC Incremental");
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
  const lineage = useMemo(() => graphFromLinks(links.data), [links.data]);
  const activeLinks = links.data.filter((link) => link.status === "Active").length;
  const plannedLinks = links.data.filter((link) => link.status === "Planned").length;
  const warningLinks = links.data.filter((link) => link.status === "Warning").length;
  const decoded = useMemo(() => {
    if (!sample) return { status: decoderOptions.find((item) => item.value === decoder)?.label ?? "None", preview: "No CDC sample fetched yet.", failed: false };
    try {
      return { ...decodeSample(decoder, sample), failed: false };
    } catch (error) {
      return { status: decoderOptions.find((item) => item.value === decoder)?.label ?? decoder, preview: `Decoder error: ${error instanceof Error ? error.message : String(error)}`, failed: true };
    }
  }, [decoder, sample]);

  const activityRows: RunRecord[] = links.data.map((link) => ({ id: link.id, source: link.source, target: link.target, status: link.status, lastRun: link.lastRun, lag: link.lag }));
  const canCreate = Boolean(selectedSource && selectedTarget && links.state !== "failed");
  const connectionBadge = "tint";
  const headerIssue = connection.state === "failed" ? connection.issue : databases.state === "failed" ? databases.issue : lakehouses.state === "failed" ? lakehouses.issue : links.state === "failed" ? links.issue : undefined;
  const headerChecking = connection.state === "checking" || databases.state === "checking" || lakehouses.state === "checking" || links.state === "checking";
  const headerConnected = !headerIssue && !headerChecking && connection.state === "ready";

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
      mode,
      prefix,
      decoder,
      createNotebook,
      status: "Planned",
      lastRun: "Never run",
      nextRun: createNotebook ? "Awaiting notebook schedule" : "Notebook not generated",
      lag: "No data",
    };
    const nextLinks = [link, ...links.data];
    try {
      const persistedLinks = await saveLinkState(workloadClient, nextLinks);
      setLinks({ state: persistedLinks.length ? "ready" : "no-data", data: persistedLinks, updatedAt: new Date() });
      setSelectedId(persistedLinks.find((saved) => saved.id === link.id)?.id ?? persistedLinks[0]?.id ?? "");
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
            <Badge appearance={connectionBadge} color={headerConnected ? "success" : headerChecking ? "brand" : "danger"}>{headerConnected ? `✓ Connected at ${formatTime(connection.updatedAt)}` : headerChecking ? "○ Checking dependencies" : `! ${issueText(headerIssue)}`}</Badge>
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
            <Kpi title="Sync health" state={links.state} value="—" caption="Unknown until a real run record exists." />
          </section>

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

                <label htmlFor="mode">Sync Mode</label>
                <Dropdown id="mode" value={mode} selectedOptions={[mode]} onOptionSelect={onSelect(setMode)}>
                  <Option value="CDC Incremental">CDC Incremental</Option>
                  <Option value="Full reload">Full reload</Option>
                </Dropdown>
                <label htmlFor="prefix">Target Table Prefix</label>
                <Input id="prefix" value={prefix} onChange={(_, data) => setPrefix(data.value)} placeholder="Optional prefix" />
                <div className="checkboxRow"><Checkbox id="notebook" checked={createNotebook} onChange={(_, data) => setCreateNotebook(Boolean(data.checked))} label="Create Notebook" /></div>

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
                <div className="actions"><Button type="button" onClick={() => { setCreateNotebook(true); setSaveMessage("Notebook creation will be requested when this link is saved."); showToast("Notebook creation will be requested when this link is saved."); }}>Generate Notebook</Button><Button type="button" onClick={onPreviewCdc} disabled={!selectedSource || previewState === "checking"}>{previewState === "checking" ? "Fetching…" : "Preview CDC"}</Button>{/* Fabric sandboxes workload iframes without allow-forms, so this must not be a submit button: native form submission is blocked before React receives onSubmit. */}<Button appearance="primary" type="button" onClick={() => void createLink()} disabled={!canCreate || saveState === "checking"}>{saveState === "checking" ? "Saving…" : "✦ Create Link"}</Button></div>
                <div className="saveStatus"><StateMessage state={saveState} text={saveMessage} /></div>
              </form>
            </article>

            <article className="panel" aria-labelledby="lineage-heading">
              <div className="panelHead"><h2 id="lineage-heading"><span aria-hidden="true">⌘</span>Current Lineage</h2></div>
              <div className="lineageList">
                {lineage.edges.length ? <LineageDiagram graph={lineage} selectedId={selectedId} onSelect={setSelectedId} /> : <LineageEmpty state={links.state} text={links.state === "failed" ? issueText(links.issue) : "Create a sync link to draw asmDB databases on the left, Fabric lakehouses on the right, and status-labelled edges between them. The graph is stored in lineage/graph.json."} />}
                <div className="legend" aria-label="Lineage states"><span>✓ Active</span><span>○ Planned</span><span>! Warning</span></div>
              </div>
            </article>
          </section>

          <section className="bottomGrid">
            <article className="panel tablePanel" aria-labelledby="activity-heading">
              <div className="panelHead"><h2 id="activity-heading"><span aria-hidden="true">◴</span>Recent Sync Activity</h2></div>
              {activityRows.length ? <div className="tableWrap"><table><thead><tr><th>Source → Target</th><th>Status</th><th>Last Run</th><th>Lag</th></tr></thead><tbody>{activityRows.map((row) => <tr key={row.id}><td>{row.source} → {row.target}</td><td><span className={statusClass(row.status)}>{statusIcon(row.status)} {row.status}</span></td><td>{row.lastRun ?? "Unknown"}</td><td>{row.lag ?? "Unknown"}</td></tr>)}</tbody></table></div> : <StateMessage state="no-data" text="No run records exist yet. Activity will appear after a saved link has a notebook run." />}
            </article>

            <article className="panel" aria-labelledby="detail-heading">
              <div className="panelHead"><h2 id="detail-heading"><span aria-hidden="true">ↄ</span>Selected Link Details</h2></div>
              {selectedLink ? <div className="detailsBody"><div className="detailTitle"><span>▤ {selectedLink.source}</span><span>→</span><span>⌂ {selectedLink.target}</span></div><dl className="detailsGrid"><div><dt>Status</dt><dd className={statusClass(selectedLink.status)}>{statusIcon(selectedLink.status)} {selectedLink.status}</dd></div><div><dt>Current Lag</dt><dd>{selectedLink.lag ?? "Unknown"}</dd></div><div><dt>Notebook</dt><dd>{selectedLink.createNotebook ? "Requested" : "Not requested"}</dd></div><div><dt>Decoder</dt><dd>{decoderOptions.find((item) => item.value === selectedLink.decoder)?.label ?? "None"}</dd></div><div><dt>Last Run</dt><dd>{selectedLink.lastRun ?? "Unknown"}</dd></div><div><dt>Next Run</dt><dd>{selectedLink.nextRun ?? "Unknown"}</dd></div><div><dt>Sync Mode</dt><dd>{selectedLink.mode}</dd></div><div><dt>Table Prefix</dt><dd>{selectedLink.prefix || "None"}</dd></div></dl></div> : <StateMessage state="not-configured" text="No link is selected because no link is stored in this workload item." />}
            </article>

            <article className="panel" aria-labelledby="coverage-heading">
              <div className="panelHead"><h2 id="coverage-heading"><span aria-hidden="true">◇</span>Coverage & Readiness</h2></div>
              <div className="coverage honestCoverage"><div className="donut unknownDonut" aria-label="Coverage unknown"><strong>—</strong><span>Coverage</span></div><div className="coverageList"><span><i className="stateActive" />Active links <strong>{links.state === "ready" ? activeLinks : "—"}</strong></span><span><i className="statePlanned" />Planned links <strong>{links.state === "ready" ? plannedLinks : "—"}</strong></span><span><i className="stateWarning" />Warnings <strong>{links.state === "ready" ? warningLinks : "—"}</strong></span><span><i />Not configured <strong>—</strong></span></div></div>
            </article>
          </section>

          <section className="panel cdcPanel" aria-labelledby="cdc-heading"><div className="panelHead"><h2 id="cdc-heading"><span aria-hidden="true">▤</span>CDC Preview</h2></div><div className="panelBody"><StateMessage state={previewState} text={previewText} />{previewRows.length ? <CdcPreview entries={previewRows} /> : null}</div></section>

          <footer className="footer"><span>{connection.updatedAt ? `✓ Data checked: ${formatTime(connection.updatedAt)}` : "○ Data not checked yet"}</span></footer>
        </section>
      </main>
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

function StateMessage({ state, text }: { state: RequestState; text: string }) {
  return <div className={`stateMessage ${state}`}><strong>{stateLabel(state)}</strong><pre>{text}</pre></div>;
}

function LineageEmpty({ state, text }: { state: RequestState; text: string }) {
  return <div className="lineageEmpty"><svg viewBox="0 0 720 220" role="img" aria-label="Empty lineage diagram placeholder"><defs><linearGradient id="emptyEdge" x1="0" x2="1"><stop offset="0%" stopColor="var(--asmdb-accent)" /><stop offset="100%" stopColor="var(--asmdb-accent-2)" /></linearGradient></defs><rect className="lineageGhostNode" x="34" y="54" width="190" height="52" rx="14" /><rect className="lineageGhostNode" x="496" y="54" width="190" height="52" rx="14" /><path className="lineageGhostEdge" d="M232 80 C330 28 390 28 488 80" /><rect className="lineageGhostNode" x="34" y="130" width="190" height="52" rx="14" /><rect className="lineageGhostNode" x="496" y="130" width="190" height="52" rx="14" /><path className="lineageGhostEdge dashed" d="M232 156 C330 204 390 204 488 156" /><text className="lineageGhostLabel" x="129" y="85" textAnchor="middle">asmDB database</text><text className="lineageGhostLabel" x="591" y="85" textAnchor="middle">Fabric lakehouse</text><text className="lineageGhostLabel" x="360" y="116" textAnchor="middle">Active · Planned · Warning</text></svg><StateMessage state={state === "failed" ? "failed" : "no-data"} text={text} /></div>;
}

function LineageDiagram({ graph, selectedId, onSelect }: { graph: ReturnType<typeof graphFromLinks>; selectedId: string; onSelect: (id: string) => void }) {
  const databases = graph.nodes.filter((node) => node.kind === "database");
  const lakehouses = graph.nodes.filter((node) => node.kind === "lakehouse");
  const height = Math.max(240, Math.max(databases.length, lakehouses.length, graph.edges.length) * 86 + 54);
  const yFor = (nodes: typeof graph.nodes, id: string) => {
    const index = Math.max(0, nodes.findIndex((node) => node.id === id));
    return 48 + index * 86;
  };
  return <svg className="lineageSvg" viewBox={`0 0 820 ${height}`} role="img" aria-label="Current lineage graph">
    <defs><marker id="lineageArrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor" /></marker></defs>
    <text className="lineageColumnTitle" x="120" y="24" textAnchor="middle">asmDB databases</text>
    <text className="lineageColumnTitle" x="700" y="24" textAnchor="middle">Fabric lakehouses</text>
    {databases.map((node) => <g key={node.id}><rect className="lineageNode lineageSource" x="24" y={yFor(databases, node.id)} width="220" height="54" rx="14" /><text className="lineageNodeText" x="46" y={yFor(databases, node.id) + 33}>▤ {node.label}</text></g>)}
    {lakehouses.map((node) => <g key={node.id}><rect className="lineageNode lineageTarget" x="576" y={yFor(lakehouses, node.id)} width="220" height="54" rx="14" /><text className="lineageNodeText" x="598" y={yFor(lakehouses, node.id) + 33}>⌂ {node.label}</text></g>)}
    {graph.edges.map((edge, index) => {
      const sourceY = yFor(databases, edge.source) + 27;
      const targetY = yFor(lakehouses, edge.target) + 27;
      const labelY = (sourceY + targetY) / 2 - 7 + (index % 2 ? 14 : 0);
      return <g className={`lineageEdgeGroup ${statusClass(edge.status)} ${selectedId === edge.id ? "selected" : ""}`} key={edge.id} role="button" tabIndex={0} onClick={() => onSelect(edge.id)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") onSelect(edge.id); }} aria-label={`${edge.status} lineage edge`}>
        <path className="lineageEdgePath" d={`M 244 ${sourceY} C 360 ${sourceY}, 460 ${targetY}, 576 ${targetY}`} markerEnd="url(#lineageArrow)" />
        <rect className="lineageEdgeLabelBg" x="344" y={labelY - 16} width="132" height="30" rx="15" />
        <text className="lineageEdgeLabel" x="410" y={labelY + 4} textAnchor="middle">{statusIcon(edge.status)} {edge.status}</text>
      </g>;
    })}
  </svg>;
}

function CdcPreview({ entries }: { entries: PreviewEntry[] }) {
  return <div className="cdcPreview"><div className="cdcTableWrap"><table className="cdcTable"><thead><tr><th>Commit</th><th>Op</th><th>ID</th><th>Tag</th><th>Content</th><th>Value</th><th>Created</th><th>Updated</th></tr></thead><tbody>{entries.map((entry, index) => entry.kind === "reset" ? <tr key={`${entry.commitSeq}-${index}`}><td>{entry.commitSeq}</td><td colSpan={7}><span className="surfaceBadge">Reset marker</span> Log was seeded; no row operation in this frame.</td></tr> : <tr key={`${entry.commitSeq}-${entry.id}-${index}`}><td>{entry.commitSeq}</td><td>{entry.op}</td><td>{entry.id}</td><td>{entry.tag}</td><td><span className="truncateCell" title={entry.content}>{entry.content}</span></td><td>{entry.value}</td><td title={entry.created}>{formatEpochMilliseconds(entry.created)}</td><td title={entry.updated}>{formatEpochMilliseconds(entry.updated)}</td></tr>)}</tbody></table></div><div className="cdcCards">{entries.map((entry, index) => entry.kind === "reset" ? <article key={`${entry.commitSeq}-${index}`} className="cdcCard"><strong>Commit {entry.commitSeq}</strong><span className="surfaceBadge">Reset marker</span><p>Log was seeded; no row operation in this frame.</p></article> : <article key={`${entry.commitSeq}-${entry.id}-${index}`} className="cdcCard"><strong>Commit {entry.commitSeq} · {entry.op}</strong><dl><div><dt>ID</dt><dd>{entry.id}</dd></div><div><dt>Tag</dt><dd>{entry.tag}</dd></div><div><dt>Content</dt><dd title={entry.content}>{entry.content}</dd></div><div><dt>Value</dt><dd>{entry.value}</dd></div><div><dt>Created</dt><dd title={entry.created}>{formatEpochMilliseconds(entry.created)}</dd></div><div><dt>Updated</dt><dd title={entry.updated}>{formatEpochMilliseconds(entry.updated)}</dd></div></dl></article>)}</div></div>;
}

export default App;




import { useCallback, useEffect, useMemo, useState } from "react";
import { Badge, Button, Checkbox, Dropdown, Input, Option, Textarea } from "@fluentui/react-components";
import type { OptionOnSelectData, SelectionEvents } from "@fluentui/react-components";
import { useWorkloadClient } from "./context/WorkloadContext";
import { DependencyError, fetchDatabases, fetchHealth, previewCdc } from "./lib/api";
import { fetchLakehouses, resolveWorkspaceId } from "./lib/fabric";
import { byteLength, CONTENT_LIMIT_BYTES, decodeSample } from "./lib/decoder";
import { graphFromLinks, loadLinks, saveLineage, saveLinks } from "./lib/onelake";
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

function emptyLoadable<T>(data: T): Loadable<T> {
  return { state: "checking", data, issue: emptyIssue };
}

function issueFrom(error: unknown, fallback: LoadIssue): LoadIssue {
  if (error instanceof DependencyError) return error.issue;
  return { ...fallback, message: error instanceof Error ? error.message : String(error) };
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

  const showToast = useCallback((message: string) => {
    setToast(message);
    window.setTimeout(() => setToast(null), 2600);
  }, []);

  const refresh = useCallback(async () => {
    setConnection((current) => ({ ...current, state: "checking" }));
    setDatabases((current) => ({ ...current, state: "checking" }));
    setLakehouses((current) => ({ ...current, state: "checking" }));
    setLinks((current) => ({ ...current, state: "checking" }));

    try {
      const health = await fetchHealth(workloadClient);
      setConnection({ state: "ready", data: health, updatedAt: new Date() });
    } catch (error) {
      setConnection({ state: "failed", data: {}, issue: issueFrom(error, { dependency: "backend", message: "Backend health check failed." }) });
    }

    try {
      const premiumDatabases = await fetchDatabases(workloadClient);
      setDatabases({ state: premiumDatabases.length ? "ready" : "no-data", data: premiumDatabases, updatedAt: new Date() });
      setSourceId((current) => current && premiumDatabases.some((database) => database.id === current) ? current : premiumDatabases[0]?.id ?? "");
    } catch (error) {
      setDatabases({ state: "failed", data: [], issue: issueFrom(error, { dependency: "asmdb-cloud", message: "Could not list premium asmDB databases." }) });
      setSourceId("");
    }

    try {
      const workspaceId = await resolveWorkspaceId(workloadClient);
      const workspaceLakehouses = await fetchLakehouses(workloadClient, workspaceId);
      setLakehouses({ state: workspaceLakehouses.length ? "ready" : "no-data", data: workspaceLakehouses, updatedAt: new Date() });
      setTargetId((current) => current && workspaceLakehouses.some((lakehouse) => lakehouse.id === current) ? current : workspaceLakehouses[0]?.id ?? "");
    } catch (error) {
      setLakehouses({ state: "failed", data: [], issue: issueFrom(error, { dependency: "fabric", message: "Could not list Fabric lakehouses in this workspace." }) });
      setTargetId("");
    }

    try {
      const storedLinks = await loadLinks(workloadClient);
      setLinks({ state: storedLinks.length ? "ready" : "no-data", data: storedLinks, updatedAt: new Date() });
      setSelectedId((current) => current && storedLinks.some((link) => link.id === current) ? current : storedLinks[0]?.id ?? "");
    } catch (error) {
      setLinks({ state: "failed", data: [], issue: issueFrom(error, { dependency: "onelake", message: "Could not read Files/links.json from this workload item." }) });
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

  function onSelect(setter: (value: string) => void) {
    return (_event: SelectionEvents, data: OptionOnSelectData) => {
      if (data.optionValue) setter(data.optionValue);
    };
  }

  function onDecoderSelect(_event: SelectionEvents, data: OptionOnSelectData) {
    if (data.optionValue) setDecoder(data.optionValue as DecoderMode);
  }

  async function createLink(event: React.FormEvent) {
    event.preventDefault();
    if (!selectedSource || !selectedTarget) return;
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
    const savedLinks = await saveLinks(workloadClient, nextLinks);
    const savedLineage = await saveLineage(workloadClient, graphFromLinks(nextLinks));
    if (!savedLinks || !savedLineage) {
      showToast("Could not save the link to this workload item's OneLake Files folder. Nothing was added.");
      return;
    }
    setLinks({ state: "ready", data: nextLinks, updatedAt: new Date() });
    setSelectedId(link.id);
    showToast(`Sync link saved: ${selectedSource.name} to ${selectedTarget.name}.`);
  }

  async function onPreviewCdc() {
    if (!selectedSource) {
      setPreviewState("not-configured");
      setPreviewText("Select a premium asmDB database before requesting a CDC preview.");
      return;
    }
    setPreviewState("checking");
    setPreviewText("Requesting a bounded CDC preview from the backend.");
    try {
      const preview = await previewCdc(workloadClient, selectedSource.id);
      const text = JSON.stringify(preview, null, 2);
      const content = firstPreviewSample(preview);
      setSample(content.slice(0, CONTENT_LIMIT_BYTES));
      setPreviewState(content || text !== "{}" ? "ready" : "no-data");
      setPreviewText(content ? text : "The request succeeded but no content sample was present in the preview payload.");
    } catch (error) {
      setPreviewState("failed");
      setPreviewText(issueFrom(error, { dependency: "backend", message: "CDC preview failed." }).message);
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
            <Badge appearance={connectionBadge} color={connection.state === "ready" ? "success" : connection.state === "checking" ? "brand" : "danger"}>{connection.state === "ready" ? `✓ Connected at ${formatTime(connection.updatedAt)}` : connection.state === "checking" ? "○ Checking dependencies" : `! ${issueText(connection.issue)}`}</Badge>
            <Button onClick={() => void refresh()}>Retry</Button>
          </div>
        </header>

        <section className="dashboard" aria-label="asmDB analytical dashboard">
          <section className="hero panel" aria-labelledby="overview-heading">
            <div className="introCard">
              <div className="heroVisual"><img src="/assets/asmdb-logo.png" alt="" width="150" height="150" /></div>
              <div><h2 id="overview-heading">Connect real asmDB premium databases to real Fabric lakehouses</h2><p>No bearer token entry. The backend uses the signed-in Fabric identity to list the same premium asmDB Cloud databases the user can access in the console.</p></div>
            </div>
            <Kpi title="Premium asmDB databases" state={databases.state} value={databases.state === "ready" ? String(databases.data.length) : "—"} caption={databases.state === "no-data" ? "No premium databases visible for this user." : databases.state === "failed" ? issueText(databases.issue) : "From GET /api/databases."} />
            <Kpi title="Workspace lakehouses" state={lakehouses.state} value={lakehouses.state === "ready" ? String(lakehouses.data.length) : "—"} caption={lakehouses.state === "failed" ? issueText(lakehouses.issue) : "From Fabric workspace items."} />
            <Kpi title="Sync links" state={links.state} value={links.state === "ready" ? String(links.data.length) : "—"} caption={links.state === "no-data" ? "No links in Files/links.json yet." : "From this item OneLake Files."} />
            <Kpi title="Sync health" state={links.state} value="—" caption="Unknown until a real run record exists." />
          </section>

          <section className="middleGrid">
            <article className="panel" aria-labelledby="create-heading">
              <div className="panelHead"><h2 id="create-heading"><span aria-hidden="true">ↄ</span>Create Sync Link</h2></div>
              <form className="formGrid" onSubmit={createLink}>
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
                  <div className="decoderTitle"><h3 id="decoder-heading">Content decoding</h3><Badge appearance="tint">{byteLength(sample)} / {CONTENT_LIMIT_BYTES} bytes</Badge></div>
                  <div className="decoderGrid">
                    <label htmlFor="decoder">Decoder</label>
                    <Dropdown id="decoder" value={decoderOptions.find((item) => item.value === decoder)?.label} selectedOptions={[decoder]} onOptionSelect={onDecoderSelect}>
                      {decoderOptions.map((item) => <Option key={item.value} value={item.value}>{item.label}</Option>)}
                    </Dropdown>
                    <label htmlFor="sample">Content sample</label>
                    <Textarea id="sample" value={sample} readOnly placeholder="Fetch CDC preview to load a real content sample." resize="vertical" />
                  </div>
                  <p className="helpText">Decoder defaults to None. Changing a decoder requires a reseed. Raw content is always retained as content_raw.</p>
                  <div className="previewBox">
                    <div><span>Decoded preview</span><Badge appearance="tint" color={decoded.failed ? "danger" : "brand"}>{decoded.status}</Badge></div>
                    <pre aria-live="polite">{decoded.preview}</pre>
                  </div>
                </section>
                <div className="actions"><Button type="button" onClick={() => { setCreateNotebook(true); showToast("Notebook creation will be requested when this link is saved."); }}>Generate Notebook</Button><Button type="button" onClick={onPreviewCdc} disabled={!selectedSource}>Preview CDC</Button><Button appearance="primary" type="submit" disabled={!canCreate}>✦ Create Link</Button></div>
              </form>
            </article>

            <article className="panel" aria-labelledby="lineage-heading">
              <div className="panelHead"><h2 id="lineage-heading"><span aria-hidden="true">⌘</span>Current Lineage</h2></div>
              <div className="lineageList">
                {lineage.edges.length ? lineage.edges.map((edge) => {
                  const sourceNode = lineage.nodes.find((node) => node.id === edge.source);
                  const targetNode = lineage.nodes.find((node) => node.id === edge.target);
                  return <button className="lineageRow" type="button" key={edge.id} onClick={() => setSelectedId(edge.id)} aria-label={`${sourceNode?.label} to ${targetNode?.label}, ${edge.status}`}><span className="node src">▤ {sourceNode?.label}</span><span className={`edge ${statusClass(edge.status)}`}><span>{statusIcon(edge.status)} {edge.status}</span></span><span className="node target">⌂ {targetNode?.label}</span></button>;
                }) : <StateMessage state={links.state === "failed" ? "failed" : "no-data"} text={links.state === "failed" ? issueText(links.issue) : "No sync links are stored in this workload item yet. Create a link to write Files/links.json and Files/lineage/graph.json."} />}
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

          <section className="panel cdcPanel" aria-label="CDC preview state"><StateMessage state={previewState} text={previewText} /></section>

          <footer className="footer"><span>{connection.updatedAt ? `✓ Data checked: ${formatTime(connection.updatedAt)}` : "○ Data not checked yet"}</span><span>◌ Auto-refresh: manual retry</span><nav><a href="../../docs/WORKLOAD.md">Documentation ↗</a><a href="https://asmdb.cloud">asmDB Status ↗</a></nav></footer>
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

export default App;



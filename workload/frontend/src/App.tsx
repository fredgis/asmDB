import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Badge,
  Button,
  Checkbox,
  Dropdown,
  Input,
  Option,
  Textarea,
  Tooltip,
} from "@fluentui/react-components";
import type { OptionOnSelectData, SelectionEvents } from "@fluentui/react-components";
import { useWorkloadClient } from "./context/WorkloadContext";
import { fetchDatabases, fetchHealth, previewCdc } from "./lib/api";
import { byteLength, clampToUtf8Bytes, CONTENT_LIMIT_BYTES, decodeSample } from "./lib/decoder";
import { graphFromLinks, loadLineage, loadLinks, saveLineage, saveLinks } from "./lib/onelake";
import type { DatabaseInfo, DecoderMode, LinkState, RunRecord, SyncLink } from "./types/workload";
import "./styles.css";

const lakehouses = ["Sales_Lakehouse", "CRM_Lakehouse", "Supply_Lakehouse", "Product_Lakehouse", "Finance_Lakehouse"];
const decoderOptions: { value: DecoderMode; label: string }[] = [
  { value: "none", label: "None" },
  { value: "hex", label: "Hex" },
  { value: "base64", label: "Base64" },
  { value: "json", label: "JSON" },
  { value: "csv", label: "CSV" },
  { value: "messagepack", label: "MessagePack" },
];

const fallbackDatabases: DatabaseInfo[] = [
  { id: "db_orders", name: "Orders_DB", tier: "premium", engine: "asmdb", endpoint: "unknown" },
  { id: "db_customer360", name: "Customer360_DB", tier: "premium", engine: "asmdb", endpoint: "unknown" },
  { id: "db_inventory", name: "Inventory_DB", tier: "premium", engine: "asmdb", endpoint: "unknown" },
  { id: "db_products", name: "Products_DB", tier: "premium", engine: "asmdb", endpoint: "unknown" },
  { id: "db_finance", name: "Finance_DB", tier: "premium", engine: "asmdb", endpoint: "unknown" },
];

const fallbackLinks: SyncLink[] = [
  { id: "orders-sales", source: "Orders_DB", target: "Sales_Lakehouse", mode: "CDC Incremental", prefix: "sales_", decoder: "none", createNotebook: true, status: "Active", lastRun: "Last good sample retained", nextRun: "Unknown", lag: "2 min" },
  { id: "customer-crm", source: "Customer360_DB", target: "CRM_Lakehouse", mode: "CDC Incremental", prefix: "crm_", decoder: "json", createNotebook: true, status: "Active", lastRun: "Last good sample retained", nextRun: "Unknown", lag: "4 min" },
  { id: "inventory-supply", source: "Inventory_DB", target: "Supply_Lakehouse", mode: "CDC Incremental", prefix: "supply_", decoder: "csv", createNotebook: true, status: "Warning", lastRun: "Request failed; sample stale", nextRun: "Unknown", lag: "Unknown" },
  { id: "products-product", source: "Products_DB", target: "Product_Lakehouse", mode: "CDC Incremental", prefix: "product_", decoder: "none", createNotebook: false, status: "Planned", lastRun: "Never run", nextRun: "Not scheduled", lag: "No data" },
];

const emptyDatabase: DatabaseInfo = { id: "not-configured", name: "No premium database configured", tier: "premium", engine: "asmdb", endpoint: "unknown" };

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

function formatCount(value: number | null) {
  return value === null ? "Unknown" : String(value);
}

function App() {
  const workloadClient = useWorkloadClient();
  const [databases, setDatabases] = useState<DatabaseInfo[]>(fallbackDatabases);
  const [links, setLinks] = useState<SyncLink[]>(fallbackLinks);
  const [source, setSource] = useState(fallbackDatabases[0].name);
  const [target, setTarget] = useState(lakehouses[0]);
  const [mode, setMode] = useState("CDC Incremental");
  const [prefix, setPrefix] = useState("sales_");
  const [createNotebook, setCreateNotebook] = useState(true);
  const [decoder, setDecoder] = useState<DecoderMode>("none");
  const [sample, setSample] = useState('{"orderId":42,"status":"ready","country":"FR"}');
  const [toast, setToast] = useState<string | null>(null);
  const [backendState, setBackendState] = useState<"not-configured" | "ready" | "failed" | "stale">("not-configured");
  const [lastUpdated, setLastUpdated] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState(fallbackLinks[0].id);
  const [previewState, setPreviewState] = useState<"not-configured" | "no-data" | "failed" | "ready" | "stale">("not-configured");
  const [previewText, setPreviewText] = useState("Preview CDC has not been requested.");

  const selectedLink = links.find((link) => link.id === selectedId) ?? links[0];

  const showToast = useCallback((message: string) => {
    setToast(message);
    window.setTimeout(() => setToast(null), 2600);
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function loadOneLakeState() {
      const storedLinks = await loadLinks(workloadClient);
      if (!cancelled && storedLinks?.length) {
        setLinks(storedLinks);
        setSelectedId(storedLinks[0].id);
      }
      await loadLineage(workloadClient);
    }

    void loadOneLakeState();
    return () => {
      cancelled = true;
    };
  }, [workloadClient]);

  useEffect(() => {
    let cancelled = false;

    async function pollBackend() {
      try {
        await fetchHealth(workloadClient);
        const premiumDatabases = await fetchDatabases(workloadClient);
        if (cancelled) return;
        if (premiumDatabases.length) {
          setDatabases(premiumDatabases);
          setSource((current) => premiumDatabases.some((database) => database.name === current) ? current : premiumDatabases[0].name);
          setBackendState("ready");
        } else {
          setBackendState("not-configured");
        }
        setLastUpdated(new Date().toLocaleTimeString());
      } catch (error) {
        console.warn("Backend poll failed; retaining last good UI state", error);
        if (!cancelled) setBackendState((current) => (current === "ready" ? "stale" : "failed"));
      }
    }

    void pollBackend();
    const timer = window.setInterval(pollBackend, 60000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [workloadClient]);

  const byteCount = byteLength(sample);
  const decoded = useMemo(() => {
    try {
      return { ...decodeSample(decoder, sample), failed: false };
    } catch (error) {
      return { status: decoderOptions.find((item) => item.value === decoder)?.label ?? decoder, preview: `Decoder error: ${error instanceof Error ? error.message : String(error)}`, failed: true };
    }
  }, [decoder, sample]);

  const lineage = useMemo(() => graphFromLinks(links), [links]);
  const activeLinks = links.filter((link) => link.status === "Active").length;
  const plannedLinks = links.filter((link) => link.status === "Planned").length;
  const warningLinks = links.filter((link) => link.status === "Warning").length;
  const coverage = databases.length ? Math.round((links.length / databases.length) * 100) : null;

  const activityRows: RunRecord[] = links.map((link) => ({
    id: link.id,
    source: link.source,
    target: link.target,
    status: link.status,
    lastRun: link.lastRun,
    lag: link.lag,
  }));

  function onSelect(setter: (value: string) => void) {
    return (_event: SelectionEvents, data: OptionOnSelectData) => {
      if (data.optionValue) setter(data.optionValue);
    };
  }

  function onDecoderSelect(_event: SelectionEvents, data: OptionOnSelectData) {
    if (data.optionValue) setDecoder(data.optionValue as DecoderMode);
  }

  function onSampleChange(value: string) {
    const bounded = clampToUtf8Bytes(value);
    setSample(bounded);
    if (bounded !== value) showToast("Content sample is limited to 176 UTF-8 bytes.");
  }

  async function createLink(event: React.FormEvent) {
    event.preventDefault();
    const link: SyncLink = {
      id: `${source}-${target}-${Date.now()}`,
      source,
      target,
      mode,
      prefix: prefix || "none",
      decoder,
      createNotebook,
      status: createNotebook ? "Planned" : "Planned",
      lastRun: "Never run",
      nextRun: createNotebook ? "Awaiting notebook schedule" : "Notebook not generated",
      lag: "No data",
    };
    const nextLinks = [link, ...links];
    setLinks(nextLinks);
    setSelectedId(link.id);
    await saveLinks(workloadClient, nextLinks);
    await saveLineage(workloadClient, graphFromLinks(nextLinks));
    showToast(`Sync link planned: ${source} to ${target}.`);
  }

  async function onPreviewCdc() {
    const db = databases.find((database) => database.name === source) ?? emptyDatabase;
    if (db.id === emptyDatabase.id) {
      setPreviewState("not-configured");
      setPreviewText("No premium source database is configured.");
      return;
    }
    try {
      const preview = await previewCdc(workloadClient, db.id);
      const text = JSON.stringify(preview, null, 2);
      setPreviewState(text === "{}" ? "no-data" : "ready");
      setPreviewText(text === "{}" ? "The request succeeded but returned no CDC rows." : text);
    } catch (error) {
      setPreviewState((current) => (current === "ready" ? "stale" : "failed"));
      setPreviewText((current) => current.startsWith("Preview CDC") ? `Request failed: ${error instanceof Error ? error.message : String(error)}` : current);
    }
  }

  return (
    <div className="appShell">
      <aside className="fabricRail" aria-label="Fabric navigation mock shell">
        <div className="fabricBrand"><span className="fabricMark" aria-hidden="true" /><span>Fabric</span></div>
        <nav className="railNav" aria-label="Fabric sections">
          {["Home", "Create", "Browse", "OneLake", "Apps", "Metrics", "Monitoring hub", "Workspaces"].map((item) => (
            <a href="#main" key={item}><span aria-hidden="true">◇</span><span>{item}</span></a>
          ))}
        </nav>
        <div className="workspaceCard"><span>CA</span><strong>Contoso Analytics Workspace</strong></div>
        <a className="feedbackLink" href="mailto:support@example.invalid">Give feedback</a>
      </aside>

      <main id="main" className="mainContent">
        <header className="topBar">
          <div className="titleCluster">
            <Dropdown aria-label="Workspace" selectedOptions={["Contoso Analytics Workspace"]} value="Contoso Analytics Workspace" className="workspaceSelect">
              <Option value="Contoso Analytics Workspace">Contoso Analytics Workspace</Option>
            </Dropdown>
            <img className="smallLogo" src="/assets/asmdb-logo.png" alt="asmDB" width="48" height="48" />
            <div className="productTitle"><h1>asmDB Analytical Capabilities</h1><p>Unified analytical sync and lineage for Microsoft Fabric</p></div>
          </div>
          <div className="statusCluster">
            <Badge appearance="tint" color={backendState === "ready" ? "success" : backendState === "stale" ? "warning" : "danger"}>
              {backendState === "ready" ? "✓ Backend connected" : backendState === "stale" ? "! Last sample stale" : backendState === "not-configured" ? "○ Not configured" : "! Backend unavailable"}
            </Badge>
            <Button aria-label="Settings" appearance="subtle">⚙</Button>
            <Button aria-label="Help" appearance="subtle">?</Button>
            <div className="avatarBlock"><span className="avatar">SA</span><span><strong>System Admin</strong><small>Contoso</small></span></div>
          </div>
        </header>

        <section className="dashboard" aria-label="asmDB analytical dashboard">
          <section className="hero panel" aria-labelledby="overview-heading">
            <div className="introCard">
              <div className="heroVisual"><img src="/assets/asmdb-logo.png" alt="" width="150" height="150" /></div>
              <div><h2 id="overview-heading">Connect asmDB premium databases to Fabric lakehouses</h2><p>Create analytical sync links with lineage, monitoring, content decoding, and resilient status panels that retain the last good sample when a request misses.</p></div>
            </div>
            <article className="kpi"><span>▤ Connected Premium Databases</span><strong>{formatCount(databases.length || null)}</strong><em>{backendState === "ready" ? "Backend filtered to premium" : "Using last known or local sample"}</em></article>
            <article className="kpi"><span>⌂ Synced Lakehouses</span><strong>{formatCount(new Set(links.map((link) => link.target)).size || null)}</strong><em>Derived from link definitions</em></article>
            <article className="kpi"><span>ↄ Active Sync Links</span><strong>{activeLinks}</strong><em>{plannedLinks} planned, {warningLinks} warning</em></article>
            <article className="kpi"><span>◇ Sync Health</span><strong>Unknown</strong><em>Never invent consumption figures</em></article>
          </section>

          <section className="middleGrid">
            <article className="panel" aria-labelledby="create-heading">
              <div className="panelHead"><h2 id="create-heading"><span aria-hidden="true">ↄ</span>Create Sync Link</h2></div>
              <form className="formGrid" onSubmit={createLink}>
                <label htmlFor="source">Source Database</label>
                <Dropdown id="source" value={source} selectedOptions={[source]} onOptionSelect={onSelect(setSource)}>
                  {(databases.length ? databases : [emptyDatabase]).map((database) => <Option key={database.id} value={database.name}>{database.name}</Option>)}
                </Dropdown>
                <label htmlFor="target">Target Lakehouse</label>
                <Dropdown id="target" value={target} selectedOptions={[target]} onOptionSelect={onSelect(setTarget)}>
                  {lakehouses.map((lakehouse) => <Option key={lakehouse} value={lakehouse}>{lakehouse}</Option>)}
                </Dropdown>
                <label htmlFor="mode">Sync Mode</label>
                <Dropdown id="mode" value={mode} selectedOptions={[mode]} onOptionSelect={onSelect(setMode)}>
                  <Option value="CDC Incremental">CDC Incremental</Option>
                  <Option value="Full reload">Full reload</Option>
                </Dropdown>
                <label htmlFor="prefix">Target Table Prefix</label>
                <Input id="prefix" value={prefix} onChange={(_, data) => setPrefix(data.value)} />
                <div className="checkboxRow"><Checkbox id="notebook" checked={createNotebook} onChange={(_, data) => setCreateNotebook(Boolean(data.checked))} label="Create Notebook" /></div>

                <section className="decoderBox" aria-labelledby="decoder-heading">
                  <div className="decoderTitle"><h3 id="decoder-heading">Content decoding</h3><Badge appearance="tint">{byteCount} / {CONTENT_LIMIT_BYTES} bytes</Badge></div>
                  <div className="decoderGrid">
                    <label htmlFor="decoder">Decoder</label>
                    <Dropdown id="decoder" value={decoderOptions.find((item) => item.value === decoder)?.label} selectedOptions={[decoder]} onOptionSelect={onDecoderSelect}>
                      {decoderOptions.map((item) => <Option key={item.value} value={item.value}>{item.label}</Option>)}
                    </Dropdown>
                    <label htmlFor="sample">Content sample</label>
                    <Textarea id="sample" value={sample} onChange={(_, data) => onSampleChange(data.value)} resize="vertical" />
                  </div>
                  <p className="helpText">Changing a decoder requires a reseed. Raw content is always retained as content_raw.</p>
                  <div className="previewBox">
                    <div><span>Decoded preview</span><Badge appearance="tint" color={decoded.failed ? "danger" : "brand"}>{decoded.status}</Badge></div>
                    <pre aria-live="polite">{decoded.preview}</pre>
                  </div>
                </section>
                <div className="actions"><Button type="button" onClick={() => { setCreateNotebook(true); showToast("Notebook generation requested."); }}>Generate Notebook</Button><Button type="button" onClick={onPreviewCdc}>Preview CDC</Button><Button appearance="primary" type="submit">✦ Create Link</Button></div>
              </form>
            </article>

            <article className="panel" aria-labelledby="lineage-heading">
              <div className="panelHead"><h2 id="lineage-heading"><span aria-hidden="true">⌘</span>Current Lineage</h2><div className="lineageControls"><Button size="small">Fit to view</Button><Button size="small">−</Button><span>100%</span><Button size="small">+</Button></div></div>
              <div className="lineageList">
                {lineage.edges.length ? lineage.edges.map((edge) => {
                  const sourceNode = lineage.nodes.find((node) => node.id === edge.source);
                  const targetNode = lineage.nodes.find((node) => node.id === edge.target);
                  return <button className="lineageRow" type="button" key={edge.id} onClick={() => setSelectedId(edge.id)} aria-label={`${sourceNode?.label} to ${targetNode?.label}, ${edge.status}`}><span className="node src">▤ {sourceNode?.label}</span><span className={`edge ${statusClass(edge.status)}`}><span>{statusIcon(edge.status)} {edge.status}</span></span><span className="node target">⌂ {targetNode?.label}</span></button>;
                }) : <StateMessage state="no-data" text="No lineage edges have been written to Files/lineage/graph.json." />}
                <div className="legend" aria-label="Lineage states"><span>✓ Active</span><span>○ Planned</span><span>! Warning</span></div>
              </div>
            </article>
          </section>

          <section className="bottomGrid">
            <article className="panel tablePanel" aria-labelledby="activity-heading">
              <div className="panelHead"><h2 id="activity-heading"><span aria-hidden="true">◴</span>Recent Sync Activity</h2></div>
              <div className="tableWrap"><table><thead><tr><th>Source → Target</th><th>Status</th><th>Last Run</th><th>Lag</th></tr></thead><tbody>{activityRows.map((row) => <tr key={row.id}><td>{row.source} → {row.target}</td><td><span className={statusClass(row.status)}>{statusIcon(row.status)} {row.status}</span></td><td>{row.lastRun ?? "Unknown"}</td><td>{row.lag ?? "Unknown"}</td></tr>)}</tbody></table></div>
            </article>

            <article className="panel" aria-labelledby="detail-heading">
              <div className="panelHead"><h2 id="detail-heading"><span aria-hidden="true">ↄ</span>Selected Link Details</h2></div>
              {selectedLink ? <div className="detailsBody"><div className="detailTitle"><span>▤ {selectedLink.source}</span><span>→</span><span>⌂ {selectedLink.target}</span></div><dl className="detailsGrid"><div><dt>Status</dt><dd className={statusClass(selectedLink.status)}>{statusIcon(selectedLink.status)} {selectedLink.status}</dd></div><div><dt>Current Lag</dt><dd>{selectedLink.lag ?? "Unknown"}</dd></div><div><dt>Notebook</dt><dd>{selectedLink.createNotebook ? "Generated or requested" : "Not generated"}</dd></div><div><dt>Decoder</dt><dd>{decoderOptions.find((item) => item.value === selectedLink.decoder)?.label ?? "None"}</dd></div><div><dt>Last Run</dt><dd>{selectedLink.lastRun ?? "Unknown"}</dd></div><div><dt>Next Run</dt><dd>{selectedLink.nextRun ?? "Unknown"}</dd></div><div><dt>Sync Mode</dt><dd>{selectedLink.mode}</dd></div><div><dt>Table Prefix</dt><dd>{selectedLink.prefix || "None"}</dd></div></dl><Button>↗ Open Notebook</Button></div> : <StateMessage state="not-configured" text="Select or create a link to show details." />}
            </article>

            <article className="panel" aria-labelledby="coverage-heading">
              <div className="panelHead"><h2 id="coverage-heading"><span aria-hidden="true">◇</span>Coverage & Readiness</h2></div>
              <div className="coverage"><div className="donut" aria-label={`Coverage ${coverage === null ? "unknown" : `${coverage} percent`}`}><strong>{coverage === null ? "?" : `${coverage}%`}</strong><span>Coverage</span></div><div className="coverageList"><span><i className="stateActive" />Fully Synced <strong>{activeLinks}</strong></span><span><i className="statePlanned" />Planned <strong>{plannedLinks}</strong></span><span><i className="stateWarning" />Warning <strong>{warningLinks}</strong></span><span><i />Not Configured <strong>{Math.max(databases.length - links.length, 0)}</strong></span></div></div>
            </article>
          </section>

          <section className="panel cdcPanel" aria-label="CDC preview state"><StateMessage state={previewState} text={previewText} /></section>

          <footer className="footer"><span>{lastUpdated ? `✓ Data updated: ${lastUpdated}` : "○ Data update: not configured"}</span><span>◌ Auto-refresh: On</span><nav><a href="../../docs/WORKLOAD.md">Documentation ↗</a><a href="https://asmdb.cloud">asmDB Status ↗</a></nav></footer>
        </section>
      </main>
      <div className={`toast ${toast ? "show" : ""}`} role="status" aria-live="polite">{toast}</div>
    </div>
  );
}

function StateMessage({ state, text }: { state: "not-configured" | "no-data" | "failed" | "ready" | "stale"; text: string }) {
  const label = state === "not-configured" ? "Not configured" : state === "no-data" ? "No data" : state === "failed" ? "Request failed" : state === "stale" ? "Stale sample" : "Ready";
  return <div className={`stateMessage ${state}`}><strong>{label}</strong><pre>{text}</pre></div>;
}

export default App;

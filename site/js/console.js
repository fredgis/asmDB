// asmdb Cloud — signed-in console.
// Management calls use the Entra token; row preview and CLI use the instance token.
(function () {
  "use strict";

  var API = "/api/v1";
  var ADMIN_GROUP = "ASMDB_ADMIN";
  var POLL_BASE_MS = 5000;
  var POLL_MAX_MS = 30000;
  var PREVIEW_LIMIT = "20";
  var TOKEN_SESSION_PREFIX = "asmdb.instanceToken.";

  function id(name) { return document.getElementById(name); }
  var out = id("db-out");
  var nameEl = id("db-name");
  var tierEl = id("db-tier");
  var createBtn = id("db-create");
  var listBtn = id("db-list");
  var openSelected = id("open-selected-db");
  var saveToken = id("save-token");
  var rotateTokenBtn = id("rotate-token");
  var createTokenOutput = id("create-token-output");
  var rotatedTokenOutput = id("rotated-token-output");
  var authPanel = id("auth-panel");
  var authSignIn = id("auth-signin");
  var authStatus = id("auth-status");
  var authDetail = id("auth-detail");
  var consoleApp = id("console-app");
  var authUser = id("auth-user");
  var authSignOut = id("auth-signout");
  var selectedDbName = id("selected-db-name");
  var selectedDbId = id("selected-db-id");
  var databaseViewName = id("database-view-name");
  var databaseViewMeta = id("database-view-meta");
  var databaseList = id("database-list");
  var dbListStatus = id("db-list-status");
  var previewStatus = id("preview-status");
  var previewRows = id("preview-rows");
  var monitorState = id("monitor-state");
  var metricRows = id("metric-rows");
  var metricRowsHint = id("metric-rows-hint");
  var rowsMeterWrap = id("rows-meter-wrap");
  var rowsMeter = id("rows-meter");
  var metricCpu = id("metric-cpu");
  var metricMemory = id("metric-memory");
  var metricMemoryDetail = id("metric-memory-detail");
  var metricStorage = id("metric-storage");
  var navVersion = id("nav-version");
  var heroVersion = id("hero-version");
  var footVersion = id("foot-version");
  var termDbId = id("term-db-id");
  var termState = id("term-state");
  var termMeta = id("term-meta");
  var termToken = id("term-token");
  var tokenNeeded = id("token-needed");
  var tokenHeld = id("token-held");
  var tokenMask = id("token-mask");
  var tokenHeldDb = id("token-held-db");
  var tokenReveal = id("token-reveal");
  var termScreen = id("term-screen");
  var termForm = id("term-form");
  var termCommand = id("term-command");
  var termSend = id("term-send");
  var loadSampleBtn = id("load-sample");
  var upgradeDbBtn = id("upgrade-db");
  var upgradeStatus = id("upgrade-status");
  var deleteDbBtn = id("delete-db");
  var benchSize = id("bench-size");
  var benchRun = id("bench-run");
  var benchResult = id("bench-result");
  var costStatus = id("cost-status");
  var costBasis = id("cost-basis");
  var costTotal = id("cost-total");
  var costCounts = id("cost-counts");
  var costRows = id("cost-rows");
  var binaryList = id("binary-list");
  var bannerMarkup = termScreen.innerHTML;

  var databases = [];
  var currentDb = null;
  var currentSelectionId = "";
  var tokenById = Object.create(null);
  var transcript = [];
  var terminalDbId = "";
  var history = [];
  var historyAt = 0;
  var statsPrevious = Object.create(null);
  var pollTimer = 0;
  var revealTimer = 0;
  var pollDelay = POLL_BASE_MS;
  var loadingList = false;
  var activeView = "create";
  var auth = { config: null, client: null, account: null, ready: false };
  var COLD_RETRY_DELAYS = [0, 1000, 2000, 4000, 8000, 10000, 10000, 10000];

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c];
    });
  }
  function attr(s) { return esc(s).replace(/"/g, "&quot;"); }
  function say(html, state) {
    out.innerHTML = html;
    if (state) { out.setAttribute("data-state", state); }
    else { out.removeAttribute("data-state"); }
  }
  function setAuthPanel(status, detail, state) {
    authStatus.textContent = status;
    authDetail.textContent = detail;
    if (state) { authPanel.setAttribute("data-state", state); }
    else { authPanel.removeAttribute("data-state"); }
  }

  function routeFromHash() {
    var h = window.location.hash.replace(/^#/, "");
    if (h === "console-access") { return "access"; }
    if (h === "database") { return "database"; }
    if (h === "cli") { return "cli"; }
    if (h === "costs") { return "costs"; }
    if (h === "create") { return "create"; }
    return activeView;
  }
  function applyRoute() {
    var view = routeFromHash();
    activeView = view;
    Array.prototype.forEach.call(document.querySelectorAll("[data-console-view]"), function (panel) {
      panel.hidden = panel.getAttribute("data-console-view") !== view;
    });
    Array.prototype.forEach.call(document.querySelectorAll("[data-console-tab]"), function (tab) {
      if (tab.getAttribute("data-console-tab") === view) { tab.setAttribute("aria-current", "page"); }
      else { tab.removeAttribute("aria-current"); }
    });
    if (view === "database") {
      if (currentDb) { refreshSelectedStats(); loadPreview(); }
      else { renderPreviewMessage("Open a database from Access first."); }
    } else if (view === "cli") {
      showTerminal(currentDb);
    } else if (view === "costs") {
      loadCosts();
    }
  }
  function setHash(hash) {
    if (window.location.hash !== hash) { window.location.hash = hash; }
    else { applyRoute(); }
  }

  function showSignedOut(status, detail, state) {
    stopPolling();
    authPanel.hidden = false;
    consoleApp.hidden = true;
    setAuthPanel(status || "Not signed in.", detail || "Sign in to create databases and open the console.", state);
  }
  function showSignedIn() {
    authPanel.hidden = true;
    consoleApp.hidden = false;
    authUser.textContent = (auth.account && (auth.account.name || auth.account.username)) || "Microsoft account";
    applyRoute();
    say("Loading databases…");
    loadDatabases({ selectFirst: false });
    startPolling();
  }
  function busy(on, btn, label) {
    createBtn.disabled = on;
    listBtn.disabled = on;
    if (btn) { btn.textContent = on ? label : btn.dataset.label; }
  }
  [createBtn, listBtn, authSignIn, authSignOut, saveToken, rotateTokenBtn, loadSampleBtn, upgradeDbBtn, deleteDbBtn, benchRun].forEach(function (b) {
    if (b) { b.dataset.label = b.textContent; }
  });

  function jsonFromResponse(r) {
    return r.text().then(function (body) {
      var type = (r.headers && r.headers.get("content-type") || "").toLowerCase();
      var isJson = type.indexOf("application/json") !== -1 || type.indexOf("+json") !== -1;
      var data = null;
      if (body && isJson) {
        try { data = JSON.parse(body); } catch (e) {
          var parseErr = new Error("the server returned invalid JSON");
          parseErr.status = r.status;
          parseErr.code = "invalid_json";
          throw parseErr;
        }
      }
      if (body && !isJson) {
        var textErr = new Error(nonJsonMessage(r.status, body));
        textErr.status = r.status;
        textErr.code = isColdStartResponse(r.status, body) ? "cold_start" : "non_json_response";
        throw textErr;
      }
      if (!r.ok) {
        var msg = (data && data.error && data.error.message) || (r.status + " " + r.statusText);
        var err = new Error(msg);
        err.status = r.status;
        err.code = (data && data.error && data.error.code) || "http_" + r.status;
        if (data && data.error && data.error.detail) { err.detail = data.error.detail; }
        throw err;
      }
      return data;
    });
  }
  function isColdStartResponse(status, body) {
    return status === 404 && /Azure Container App|Container App is stopped|stopped or does not exist|id="unavailable"/i.test(String(body || ""));
  }
  function nonJsonMessage(status, body) {
    if (isColdStartResponse(status, body)) {
      return "the instance is waking; Azure returned its cold-start page instead of JSON";
    }
    return "the server returned a non-JSON response (" + status + ")";
  }
  function delay(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }
  function withColdRetry(operation, onWake) {
    var started = Date.now();
    function attempt(i) {
      return operation().catch(function (e) {
        if (e && e.code === "cold_start" && Date.now() - started < 45000 && i < COLD_RETRY_DELAYS.length - 1) {
          if (onWake) { onWake(i + 1); }
          return delay(COLD_RETRY_DELAYS[i + 1]).then(function () { return attempt(i + 1); });
        }
        throw e;
      });
    }
    return attempt(0);
  }
  function fetchConfig() {
    if (window.location.protocol === "file:") {
      setAuthPanel("Not signed in.", "Serve this page from the control plane to load Entra sign-in configuration.", "");
      return Promise.resolve(null);
    }
    return fetch(API + "/config", { headers: { "accept": "application/json" } })
      .then(jsonFromResponse)
      .then(function (cfg) {
        if (!cfg || !cfg.tenantId || !cfg.clientId || !cfg.scope) {
          throw new Error("the control plane returned an incomplete auth configuration");
        }
        return cfg;
      });
  }
  function initAuth(cfg) {
    if (!cfg) { return Promise.resolve(); }
    if (!window.msal || !window.msal.PublicClientApplication) { throw new Error("MSAL browser did not load"); }
    auth.config = cfg;
    auth.client = new window.msal.PublicClientApplication({
      auth: {
        clientId: cfg.clientId,
        authority: "https://login.microsoftonline.com/" + cfg.tenantId,
        redirectUri: window.location.href.split("#")[0]
      },
      cache: { cacheLocation: "sessionStorage", storeAuthStateInCookie: false }
    });
    return auth.client.initialize()
      .then(function () { return auth.client.handleRedirectPromise(); })
      .then(function (result) {
        if (result && result.account) {
          auth.account = result.account;
          auth.client.setActiveAccount(auth.account);
        } else {
          auth.account = auth.client.getActiveAccount() || auth.client.getAllAccounts()[0] || null;
          if (auth.account) { auth.client.setActiveAccount(auth.account); }
        }
        auth.ready = true;
        if (auth.account) { showSignedIn(); }
        else { showSignedOut("Not signed in.", "Sign in with Microsoft. Access requires membership of " + ADMIN_GROUP + ".", ""); }
      });
  }
  function authInitFailed(e) {
    auth.ready = false;
    showSignedOut("Sign-in configuration unavailable.", "The control plane did not provide Entra configuration. The public site is still available.", "error");
    authDetail.textContent = e && e.message ? authDetail.textContent + " " + e.message : authDetail.textContent;
  }
  function signIn() {
    if (!auth.ready || !auth.client || !auth.config) {
      setAuthPanel("Sign-in is not ready.", "The control plane configuration is unavailable from this origin.", "error");
      return;
    }
    authSignIn.disabled = true;
    authSignIn.textContent = "redirecting…";
    auth.client.loginRedirect({ scopes: [auth.config.scope] });
  }
  function signOut() {
    if (!auth.client) { return; }
    stopPolling();
    clearAllSessionTokens();
    authSignOut.disabled = true;
    authSignOut.textContent = "signing out…";
    auth.client.logoutRedirect({ account: auth.account });
  }
  function getConsoleToken() {
    if (!auth.account || !auth.client || !auth.config) {
      var missing = new Error("sign in with Microsoft before using the console");
      missing.code = "not_signed_in";
      return Promise.reject(missing);
    }
    var req = { account: auth.account, scopes: [auth.config.scope] };
    return auth.client.acquireTokenSilent(req)
      .then(function (result) { return result.accessToken; })
      .catch(function (e) {
        if (window.msal && e instanceof window.msal.InteractionRequiredAuthError) {
          return auth.client.acquireTokenRedirect(req);
        }
        throw e;
      });
  }
  function request(path, options) {
    return getConsoleToken().then(function (token) {
      var ctl = new AbortController();
      var timer = setTimeout(function () { ctl.abort(); }, 30000);
      options = options || {};
      options.signal = ctl.signal;
      options.headers = options.headers || {};
      options.headers.Authorization = "Bearer " + token;
      return fetch(API + path, options)
        .then(function (r) { clearTimeout(timer); return jsonFromResponse(r); })
        .catch(function (e) {
          clearTimeout(timer);
          if (e.name === "AbortError") {
            var t = new Error("the control plane did not answer within 30 seconds");
            t.code = "api_unreachable";
            t.timedOut = true;
            throw t;
          }
          if (e.status === 403) {
            var f = new Error("your account is signed in but is not a member of " + ADMIN_GROUP);
            f.code = "forbidden";
            throw f;
          }
          if (e instanceof TypeError) {
            var n = new Error("the control plane API is unreachable");
            n.code = "api_unreachable";
            throw n;
          }
          throw e;
        });
    });
  }

  function formatDecimalString(value) {
    var s = String(value == null || value === "" ? "0" : value);
    var sign = "";
    if (s.charAt(0) === "-") { sign = "-"; s = s.slice(1); }
    s = s.replace(/^0+(?=\d)/, "");
    return sign + s.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  }
  function renderBinariesUnavailable() {
    binaryList.innerHTML = '<div class="binary-empty">Binary manifest unavailable. The download list cannot be verified from this origin.</div>';
  }
  function renderBinaries(manifest) {
    var builds = manifest && Array.isArray(manifest.builds) ? manifest.builds : [];
    if (!builds.length) { renderBinariesUnavailable(); return; }
    binaryList.innerHTML = builds.map(function (build) {
      var title = [build.os, build.arch, build.format].filter(Boolean).join(" · ");
      var file = String(build.file || "");
      var href = "/downloads/" + file.replace(/^\/+/, "");
      return '<article class="binary-card">' +
        '<div class="binary-card__head"><div>' +
        '<p class="sec__kicker">' + esc(build.os || "build") + '</p>' +
        '<h3 class="binary-card__title">' + esc(title || file || "binary") + '</h3>' +
        '</div><span class="badge">' + esc(build.format || "binary") + '</span></div>' +
        '<p class="binary-card__meta">' + esc(file) + '<br>' + esc(formatDecimalString(build.bytes)) + ' bytes</p>' +
        '<p class="binary-card__hash"><strong>SHA-256</strong><span>' + esc(build.sha256 || "unavailable") + '</span></p>' +
        '<a class="btn btn--primary" href="' + attr(href) + '" download>Download</a>' +
      '</article>';
    }).join("");
  }
  function loadBinaries() {
    if (!binaryList) { return; }
    fetch("/downloads/manifest.json", { headers: { "accept": "application/json" } })
      .then(jsonFromResponse)
      .then(renderBinaries)
      .catch(renderBinariesUnavailable);
  }
  function renderVersion(data) {
    var engine = data && data.engine;
    var source = versionSource(data);
    if (!engine) {
      if (navVersion) { navVersion.hidden = true; navVersion.textContent = ""; }
      if (heroVersion) { heroVersion.innerHTML = '<span class="dot" aria-hidden="true"></span> engine version unavailable'; }
      if (footVersion) { footVersion.textContent = "Engine version unavailable · MIT licence"; }
      return;
    }
    if (navVersion) {
      navVersion.textContent = "v" + engine;
      navVersion.hidden = false;
    }
    if (heroVersion) {
      heroVersion.innerHTML = '<span class="dot" aria-hidden="true"></span> engine ' + esc(engine) + (source ? ' · ' + esc(source) : '');
    }
    if (footVersion) {
      footVersion.textContent = "Engine " + engine + (source ? " · " + source : "") + " · MIT licence";
    }
  }
  function versionSource(data) {
    if (!data) { return ""; }
    return data.engineSource || data.engineVersionSource || data.versionSource || data.source || "";
  }
  function loadVersion() {
    fetch(API + "/version", { headers: { "accept": "application/json" } })
      .then(jsonFromResponse)
      .then(renderVersion)
      .catch(function () { renderVersion(null); });
  }
  function formatBytes(value) {
    if (value == null || value === "") { return "—"; }
    var n;
    try { n = BigInt(value); } catch (e) { return formatDecimalString(value) + " B"; }
    var units = ["B", "KiB", "MiB", "GiB", "TiB"];
    var unit = 0;
    var scaled = n * 100n;
    while (scaled >= 102400n && unit < units.length - 1) { scaled = scaled / 1024n; unit += 1; }
    var whole = scaled / 100n;
    var frac = scaled % 100n;
    if (unit === 0) { return formatDecimalString(String(n)) + " B"; }
    var fracText = (frac < 10n ? "0" + String(frac) : String(frac)).replace(/0+$/, "");
    return formatDecimalString(String(whole)) + (fracText ? "." + fracText : "") + " " + units[unit];
  }
  function formatMoney(value) {
    if (value == null || value === "") { return "—"; }
    var n = Number(value);
    if (!isFinite(n)) { return "—"; }
    return "$" + n.toFixed(n < 1 ? 4 : 2);
  }
  function formatHours(value) {
    if (value == null || value === "") { return "—"; }
    var n = Number(value);
    if (!isFinite(n)) { return "—"; }
    return n.toFixed(n < 10 ? 3 : 1).replace(/\.?0+$/, "") + " h";
  }
  function percentFromDecimalStrings(used, total) {
    try {
      var u = BigInt(used || "0");
      var t = BigInt(total || "0");
      if (t <= 0n) { return null; }
      return Number((u * 10000n) / t) / 100;
    } catch (e) { return null; }
  }
  function setRowsMeter(rows, capacity) {
    var percent = percentFromDecimalStrings(rows, capacity);
    if (percent == null || percent <= 0) {
      rowsMeter.style.width = "0";
      rowsMeter.removeAttribute("data-tiny");
      rowsMeterWrap.setAttribute("data-empty", "true");
      return;
    }
    rowsMeterWrap.removeAttribute("data-empty");
    var width = percent;
    if (width > 0 && width < 0.7) { width = 0.7; }
    if (width > 100) { width = 100; }
    rowsMeter.style.width = width + "%";
    if (percent > 0 && percent < 0.1) { rowsMeter.setAttribute("data-tiny", "true"); }
    else { rowsMeter.removeAttribute("data-tiny"); }
  }
  function databaseLabel(db) { return db && (db.name || db.id) || "database"; }
  function databaseEngine(db) {
    return db && db.engine ? String(db.engine) : "unknown";
  }
  function databaseEngineSource(db) {
    return versionSource(db);
  }
  function databaseEngineText(db) {
    var engine = databaseEngine(db);
    var source = databaseEngineSource(db);
    return "engine " + engine + (source ? " · " + source : "");
  }
  function asleepLabel(reason) {
    if (!reason) { return "unavailable"; }
    if (/^(stopped|scaledtozero|scaled_to_zero|sleeping|sleep|zero replicas)$/i.test(String(reason))) { return "asleep"; }
    return String(reason).replace(/_/g, " ");
  }
  function isAsleep(db) {
    var state = String(db && db.state || "").toLowerCase().replace(/[^a-z0-9]/g, "");
    return state === "stopped" || state === "scaledtozero" || state === "sleeping" || state === "sleep";
  }
  function renderStatsUnavailable(reason) {
    var label = asleepLabel(reason);
    monitorState.textContent = label;
    metricRows.textContent = label === "asleep" ? "asleep" : "No sample";
    metricRowsHint.textContent = label === "asleep"
      ? "Free and standard instances can scale to zero. Open the CLI or preview to wake it."
      : "Stats unavailable for the selected database.";
    metricCpu.textContent = "—";
    metricMemory.textContent = label === "asleep" ? "asleep" : "No sample";
    if (metricMemoryDetail) { metricMemoryDetail.textContent = label === "asleep" ? "working set unavailable while asleep" : "working set unavailable"; }
    metricStorage.textContent = "allocated storage —";
    setRowsMeter("0", "0");
  }
  function renderStatsEmpty() {
    monitorState.textContent = "—";
    metricRows.textContent = "No database selected";
    metricRowsHint.textContent = "Open a database from Access to request stats.";
    metricCpu.textContent = "—";
    metricMemory.textContent = "No database selected";
    if (metricMemoryDetail) { metricMemoryDetail.textContent = "working set unavailable"; }
    metricStorage.textContent = "allocated storage —";
    setRowsMeter("0", "0");
  }
  function renderStats(db, payload) {
    if (!db) { renderStatsEmpty(); return; }
    if (isAsleep(db)) { renderStatsUnavailable(db.state); return; }
    if (!payload) {
      monitorState.textContent = "waiting";
      metricRows.textContent = "No sample yet";
      metricRowsHint.textContent = "Rows are shown against capacity when the first stats sample arrives.";
      metricCpu.textContent = "—";
      metricMemory.textContent = "No sample yet";
      if (metricMemoryDetail) { metricMemoryDetail.textContent = "waiting for working set sample"; }
      metricStorage.textContent = "allocated storage —";
      setRowsMeter("0", "0");
      return;
    }
    if (payload.available === false) { renderStatsUnavailable(payload.reason); return; }
    var stats = payload.stats || payload;
    var rows = stats.rows || "0";
    var capacity = stats.capacity || "4194304";
    var rowsPercent = percentFromDecimalStrings(rows, capacity);
    monitorState.textContent = stats.engine ? "engine " + stats.engine : "running";
    metricRows.textContent = formatDecimalString(rows) + " / " + formatDecimalString(capacity);
    metricRowsHint.textContent = rowsPercent == null ? "capacity unavailable" : rowsPercent.toFixed(rowsPercent < 1 ? 2 : 1) + " % of row capacity";
    setRowsMeter(rows, capacity);
    var memory = stats.memory || {};
    var workingSet = memory.workingSetBytes != null && memory.workingSetBytes !== "" ? memory.workingSetBytes : memory.usedBytes;
    metricMemory.textContent = formatBytes(workingSet) + " working set / " + formatBytes(memory.limitBytes);
    if (metricMemoryDetail) {
      metricMemoryDetail.textContent = "total " + formatBytes(memory.usedBytes) + "; reclaimable " + formatBytes(memory.reclaimableBytes);
    }
    metricStorage.textContent = "allocated storage " + formatBytes((stats.storage || {}).dataBytes);
    metricCpu.textContent = cpuText(db.id, stats.cpu || {});
  }
  function cpuText(idValue, cpu) {
    var usage = cpu.usageUsec;
    var cores = typeof cpu.limitCores === "number" ? cpu.limitCores : Number(cpu.limitCores);
    if (!usage || !cores) { return "—"; }
    var now = Date.now();
    var current;
    try { current = BigInt(usage); } catch (e) { return "—"; }
    var prev = statsPrevious[idValue];
    statsPrevious[idValue] = { usage: current, sampledAt: now };
    if (!prev || current < prev.usage) { return "—"; }
    var elapsedUsec = (now - prev.sampledAt) * 1000;
    if (elapsedUsec <= 0) { return "—"; }
    var percent = (Number(current - prev.usage) / (elapsedUsec * cores)) * 100;
    return isFinite(percent) ? percent.toFixed(percent < 10 ? 1 : 0) + " %" : "—";
  }

  function updateSelectedChrome() {
    if (!currentDb) {
      selectedDbName.textContent = "none";
      selectedDbId.textContent = "choose an instance before previewing rows or running CLI commands";
      databaseViewName.textContent = "no database selected";
      databaseViewMeta.textContent = "Open a database from Access before previewing data.";
      if (loadSampleBtn) { loadSampleBtn.disabled = true; }
      if (deleteDbBtn) { deleteDbBtn.disabled = true; }
      if (upgradeDbBtn) {
        upgradeDbBtn.hidden = false;
        upgradeDbBtn.disabled = true;
        upgradeDbBtn.textContent = "Upgrade database";
      }
      if (upgradeStatus) { upgradeStatus.textContent = "Open a database first."; }
      return;
    }
    selectedDbName.textContent = databaseLabel(currentDb);
    selectedDbId.textContent = currentDb.id + " · " + (currentDb.tier || "tier") + " · " + (currentDb.state || "state") + " · " + databaseEngineText(currentDb);
    databaseViewName.textContent = databaseLabel(currentDb);
    databaseViewMeta.textContent = currentDb.endpoint
      ? currentDb.id + " · " + (currentDb.state || "state") + " · " + databaseEngineText(currentDb) + " · " + currentDb.endpoint
      : currentDb.id + " · " + (currentDb.state || "state") + " · " + databaseEngineText(currentDb);
    if (loadSampleBtn) { loadSampleBtn.disabled = false; }
    if (deleteDbBtn) { deleteDbBtn.disabled = false; }
    if (upgradeDbBtn) {
      var runningEngine = databaseEngine(currentDb);
      var targetEngine = currentDb.availableEngine || "unknown";
      upgradeDbBtn.hidden = false;
      if (currentDb.upgradeAvailable) {
        upgradeDbBtn.disabled = false;
        upgradeDbBtn.textContent = "Upgrade " + runningEngine + " → " + targetEngine;
        if (upgradeStatus) { upgradeStatus.textContent = "Upgrade available: " + runningEngine + " to " + targetEngine + "."; }
      } else {
        upgradeDbBtn.disabled = true;
        upgradeDbBtn.textContent = "Upgrade database";
        if (upgradeStatus) { upgradeStatus.textContent = "Running " + runningEngine + " — current."; }
      }
    }
  }
  function renderDatabases() {
    dbListStatus.textContent = databases.length ? String(databases.length) : "empty";
    if (!databases.length) {
      databaseList.innerHTML = '<div class="db-empty">No databases yet. Create one, or refresh after provisioning from another session.</div>';
      updateSelectedChrome();
      return;
    }
    databaseList.innerHTML = databases.map(function (db) {
      var selected = currentDb && currentDb.id === db.id;
      var state = isAsleep(db) ? "asleep" : (db.state || "state");
      return '<button class="db-item" type="button" role="option" aria-selected="' + (selected ? "true" : "false") + '" data-db-id="' + attr(db.id) + '">' +
        '<span class="db-item__main"><span class="db-item__name">' + esc(databaseLabel(db)) + '</span>' +
        '<span class="db-item__id">' + esc(db.id) + '</span></span>' +
        '<span class="db-item__rows">' + esc(state) + '</span>' +
        '<span class="db-item__meta">' + esc(db.tier || "tier") + ' · ' + esc(databaseEngineText(db)) + ' · endpoint ' + esc(db.endpoint || "unavailable") + '</span>' +
      '</button>';
    }).join("");
    updateSelectedChrome();
  }
  function findDb(idValue) {
    for (var i = 0; i < databases.length; i += 1) {
      if (databases[i].id === idValue) { return databases[i]; }
    }
    return null;
  }
  function selectDatabase(db, options) {
    options = options || {};
    var previousId = currentDb && currentDb.id;
    var nextId = db && db.id;
    var refreshOnly = !!options.refresh || (previousId && nextId && previousId === nextId && options.reset !== true);
    if (previousId !== nextId) { clearDatabaseScopedMessages(nextId); }
    currentDb = db ? Object.assign({}, currentDb && currentDb.id === db.id ? currentDb : {}, db) : null;
    currentSelectionId = currentDb ? currentDb.id : "";
    if (currentDb) {
      if (currentDb.token) { rememberInstanceTokenFor(currentDb.id, currentDb.token); }
      var remembered = tokenForDatabase(currentDb.id);
      if (remembered) {
        termToken.value = remembered;
        clearTokenNeeded();
      } else if (!currentDb.token) {
        termToken.value = "";
      }
      updateTokenHeld();
    } else {
      updateTokenHeld();
    }
    updateSelectedChrome();
    renderDatabases();
    if (refreshOnly) { return; }
    renderStats(currentDb, null);
    showTerminal(currentDb, { reset: true });
    if (currentDb && options.route) { setHash(options.route); }
  }
  function clearDatabaseScopedMessages(nextId) {
    if (rotatedTokenOutput) {
      rotatedTokenOutput.hidden = true;
      rotatedTokenOutput.textContent = "";
      rotatedTokenOutput.removeAttribute("data-state");
      rotatedTokenOutput.removeAttribute("data-db-id");
    }
    if (benchResult) { benchResult.textContent = "No bench run yet."; }
    if (previewRows) {
      previewStatus.textContent = "—";
      previewRows.innerHTML = '<tr><td colspan="5">' + esc(nextId ? "Open the selected database view to load rows." : "Select a database.") + '</td></tr>';
    }
    clearTokenNeeded();
    say(nextId ? "Ready. Selected database changed." : "Ready. Select a database.", "ok");
  }
  function renderPreviewMessage(message) {
    previewStatus.textContent = "—";
    previewRows.innerHTML = '<tr><td colspan="5">' + esc(message) + '</td></tr>';
  }
  function renderPreviewRows(rows) {
    previewStatus.textContent = rows.length ? (String(rows.length) + " rows") : "empty";
    if (!rows.length) {
      previewRows.innerHTML = '<tr><td colspan="5">No rows in the first bounded page.</td></tr>';
      return;
    }
    previewRows.innerHTML = rows.map(function (row) {
      return "<tr><td>" + esc(formatDecimalString(row.id)) + "</td><td>" +
        esc(formatDecimalString(row.value)) + "</td><td>" + esc(row.tag) + "</td><td>" +
        esc(row.content) + "</td><td>" + esc(formatDecimalString(row.updated)) + "</td></tr>";
    }).join("");
  }
  function tokenSessionKey(idValue) { return TOKEN_SESSION_PREFIX + idValue; }
  function readSessionToken(idValue) {
    try { return window.sessionStorage.getItem(tokenSessionKey(idValue)) || ""; }
    catch (e) { return ""; }
  }
  function writeSessionToken(idValue, token) {
    try { window.sessionStorage.setItem(tokenSessionKey(idValue), token); }
    catch (e) { /* session memory is best effort */ }
  }
  function clearSessionToken(idValue) {
    try { window.sessionStorage.removeItem(tokenSessionKey(idValue)); }
    catch (e) { /* session memory is best effort */ }
  }
  function clearAllSessionTokens() {
    try {
      Object.keys(window.sessionStorage).forEach(function (key) {
        if (key.indexOf(TOKEN_SESSION_PREFIX) === 0) { window.sessionStorage.removeItem(key); }
      });
    } catch (e) { /* session memory is best effort */ }
    tokenById = Object.create(null);
    if (currentDb) { delete currentDb.token; }
    updateTokenHeld();
  }
  function maskToken(token) {
    token = String(token || "");
    if (!token) { return "none"; }
    if (token.length <= 12) { return token.slice(0, 2) + "…" + token.slice(-2); }
    return token.slice(0, 6) + "…" + token.slice(-6);
  }
  function updateTokenHeld(reveal) {
    var token = currentDb ? tokenForDatabase(currentDb.id) : "";
    if (!tokenHeld || !tokenMask) { return; }
    if (!token) {
      tokenHeld.hidden = true;
      tokenMask.textContent = "none";
      if (tokenReveal) { tokenReveal.hidden = true; }
      return;
    }
    tokenHeld.hidden = false;
    tokenHeld.setAttribute("data-revealed", reveal ? "true" : "false");
    // Name the database the token belongs to. Without it, a token held for one
    // database is indistinguishable from a token held for another, and a
    // credential pasted against the wrong selection looks identical to the
    // right one.
    if (tokenHeldDb) { tokenHeldDb.textContent = databaseLabel(currentDb); }
    tokenMask.textContent = reveal ? token : maskToken(token);
    if (tokenReveal) {
      tokenReveal.hidden = false;
      tokenReveal.setAttribute("aria-pressed", reveal ? "true" : "false");
    }
  }
  function clearTokenNeeded() {
    if (tokenNeeded) {
      tokenNeeded.hidden = true;
      tokenNeeded.textContent = "";
    }
  }
  function showTokenNeeded(action) {
    var dbName = databaseLabel(currentDb);
    var dbId = currentDb && currentDb.id ? currentDb.id : "selected database";
    if (tokenNeeded) {
      tokenNeeded.hidden = false;
      tokenNeeded.textContent = action + " needs the instance token for " + dbName + " (" + dbId + "). The token is shown once at creation, and this browser session does not have it. Paste it below, or rotate the token with your Entra sign-in.";
    }
    setHash("#console-access");
    setTimeout(function () { termToken.focus(); }, 0);
  }
  function requireInstanceToken(action) {
    var token = currentDb ? tokenForDatabase(currentDb.id) : "";
    if (token) {
      rememberInstanceToken(token);
      clearTokenNeeded();
      return token;
    }
    showTokenNeeded(action);
    return "";
  }
  function tokenForDatabase(idValue) {
    if (!idValue) { return ""; }
    var sessionToken = tokenById[idValue] || readSessionToken(idValue);
    if (sessionToken) {
      tokenById[idValue] = sessionToken;
      return sessionToken;
    }
    if (currentDb && currentDb.id === idValue && currentDb.token) { return currentDb.token; }
    return "";
  }
  function rememberInstanceTokenFor(idValue, token) {
    if (!idValue || !token) { return; }
    tokenById[idValue] = token;
    writeSessionToken(idValue, token);
    if (currentDb && currentDb.id === idValue) { currentDb.token = token; }
  }
  function rememberInstanceToken(token) {
    if (!currentDb || !token) { return; }
    rememberInstanceTokenFor(currentDb.id, token);
    updateTokenHeld();
  }
  function oneTimeTokenMarkup(d, intro, extraWarning) {
    return [
      '<span class="ok">[ OK ]</span> ' + esc(intro),
      '<span class="k">id       </span> ' + esc(d.id),
      '<span class="k">name     </span> ' + esc(d.name),
      '<span class="k">tier     </span> ' + esc(d.tier),
      '<span class="k">state    </span> ' + esc(d.state),
      '<span class="k">engine   </span> ' + esc(databaseEngineText(d)),
      '<span class="k">endpoint </span> ' + esc(d.endpoint),
      "",
      '<span class="k">token    </span> <span class="danger">' + esc(d.token) + '</span>',
      '<span class="danger">          shown once — put it in a secret manager now</span>',
      '<span class="token-copy-row"><button class="btn btn--ghost" type="button" data-copy-token-for="' + attr(d.id) + '">Copy token</button><span class="danger">' + esc(extraWarning) + '</span></span>',
      '<span class="token-copy-row"><button class="btn btn--ghost" type="button" data-dismiss-token-output>Dismiss token from this screen</button></span>'
    ].join("\n");
  }
  function loadPreview() {
    if (!currentDb || !currentDb.endpoint) {
      renderPreviewMessage("Open a database from Access first.");
      return Promise.resolve();
    }
    var dbId = currentDb.id;
    var endpoint = currentDb.endpoint;
    var label = databaseLabel(currentDb);
    var token = tokenForDatabase(dbId);
    if (!token) {
      renderPreviewMessage("Paste the instance token in Access to preview rows for " + label + ".");
      return Promise.resolve();
    }
    previewStatus.textContent = "loading";
    return withColdRetry(function () {
      return fetch(endpoint.replace(/\/$/, "") + "/v1/rows?limit=" + PREVIEW_LIMIT + "&offset=0", {
        headers: { "Authorization": "Bearer " + token, "accept": "application/json" }
      }).then(jsonFromResponse);
    }, function () {
      previewStatus.textContent = "waking";
      renderPreviewMessage("Waking the instance. Azure returned a cold-start page; retrying…");
    })
      .then(function (data) { renderPreviewRows((data && data.rows) || []); })
      .catch(function (e) {
        previewStatus.textContent = e && e.code === "cold_start" ? "waking" : "unavailable";
        renderPreviewMessage(e && e.code === "cold_start" ? "The instance is still waking after 45 seconds. Try preview again." : (e && e.message ? e.message : "Preview unavailable."));
      });
  }
  function loadDatabases(options) {
    options = options || {};
    if (loadingList || document.visibilityState === "hidden") { return Promise.resolve(); }
    loadingList = true;
    dbListStatus.textContent = "loading";
    return request("/databases", { method: "GET" })
      .then(function (data) {
        loadingList = false;
        pollDelay = POLL_BASE_MS;
        databases = (data && data.databases) || [];
        databases.forEach(function (db) { if (db.token) { tokenById[db.id] = db.token; } });
        var selected = currentDb && findDb(currentDb.id);
        var refreshingSelected = !!selected;
        if (!selected && options.selectFirst && databases.length) { selected = databases[0]; }
        if (selected) { selectDatabase(selected, { refresh: refreshingSelected }); }
        else { renderDatabases(); }
        if (!options.silent) {
          say(databases.length ? "Ready. Use Access to choose a database, or Create to provision another." : "Ready. Create a database or refresh Access.", "ok");
        }
      })
      .catch(function (e) {
        loadingList = false;
        pollDelay = Math.min(POLL_MAX_MS, pollDelay * 2);
        dbListStatus.textContent = "error";
        fail(e);
      });
  }
  function refreshSelectedStats() {
    if (!currentDb) { renderStats(null, null); return Promise.resolve(); }
    if (isAsleep(currentDb)) { renderStatsUnavailable(currentDb.state); return Promise.resolve(); }
    monitorState.textContent = "loading";
    return request("/databases/" + encodeURIComponent(currentDb.id) + "/stats", { method: "GET" })
      .then(function (data) { renderStats(currentDb, data); })
      .catch(function () {
        pollDelay = Math.min(POLL_MAX_MS, pollDelay * 2);
        renderStatsUnavailable("unavailable");
      });
  }
  function renderCosts(data) {
    var counts = data && data.counts || {};
    var rows = data && Array.isArray(data.databases) ? data.databases : [];
    costStatus.textContent = rows.length ? String(rows.length) : "empty";
    costBasis.textContent = (data && data.basis) || "estimated from Azure Monitor replica time at public list rates; not an invoice";
    costTotal.textContent = formatMoney(data && data.totalUsd);
    costCounts.innerHTML = ["free", "standard", "premium"].map(function (tier) {
      return "<span>" + esc(tier) + " " + esc(formatDecimalString(counts[tier] || 0)) + "</span>";
    }).join("");
    if (!rows.length) {
      costRows.innerHTML = '<tr><td colspan="7">No databases in this cost window.</td></tr>';
      return;
    }
    costRows.innerHTML = rows.map(function (row) {
      var noData = row.metricsUnavailable || ((row.activeHours || 0) === 0 && (row.pausedHours || 0) === 0 && (row.estimatedComputeUsd || 0) === 0);
      var active = noData ? "no data yet" : formatHours(row.activeHours);
      var paused = noData ? "no data yet" : formatHours(row.pausedHours);
      var cost = noData ? "no data yet" : formatMoney(row.estimatedComputeUsd);
      return "<tr>" +
        "<td>" + esc(row.name || row.id || "database") + "<br><span class=\"db-item__id\">" + esc(row.id || "") + "</span></td>" +
        "<td>" + esc(row.tier || "—") + "</td>" +
        "<td>" + esc(row.size || "—") + "</td>" +
        "<td>" + esc(asleepLabel(row.state || "—")) + "</td>" +
        "<td>" + esc(active) + "</td>" +
        "<td>" + esc(paused) + "</td>" +
        "<td>" + esc(cost) + "</td>" +
      "</tr>";
    }).join("");
  }
  function loadCosts() {
    if (!auth.account) { return Promise.resolve(); }
    costStatus.textContent = "loading";
    costRows.innerHTML = '<tr><td colspan="7">Loading cost estimate…</td></tr>';
    return request("/costs", { method: "GET" })
      .then(renderCosts)
      .catch(function (e) {
        costStatus.textContent = "unavailable";
        costRows.innerHTML = '<tr><td colspan="7">' + esc((e && e.message) || "Cost estimate unavailable.") + '</td></tr>';
      });
  }
  function startPolling() { stopPolling(); schedulePoll(POLL_BASE_MS); }
  function stopPolling() { if (pollTimer) { clearTimeout(pollTimer); pollTimer = 0; } }
  function schedulePoll(delay) {
    stopPolling();
    pollTimer = setTimeout(function () {
      if (document.visibilityState === "hidden" || !auth.account) { return; }
      loadDatabases({ selectFirst: false, silent: true }).then(function () {
        if (activeView === "database") { return refreshSelectedStats(); }
        return null;
      }).then(function () { schedulePoll(pollDelay); });
    }, delay);
  }

  function setTerminalState(text) { termState.textContent = text; }
  function paintTerminal() {
    termScreen.innerHTML = transcript.join("\n");
    termScreen.scrollTop = termScreen.scrollHeight;
  }
  function writeTerminal(lines) {
    Array.prototype.push.apply(transcript, lines.map(esc));
    if (transcript.length > 700) { transcript = transcript.slice(transcript.length - 700); }
    paintTerminal();
  }
  function showTerminal(db, options) {
    options = options || {};
    if (!db) {
      termDbId.textContent = "no database selected";
      termMeta.textContent = "Open a database from Access before running commands.";
      termCommand.disabled = true;
      termSend.disabled = true;
      setTerminalState("no database");
      if (terminalDbId || options.reset || !transcript.length) {
        terminalDbId = "";
        transcript = [bannerMarkup, "", esc("asmdb> open a database from Access")];
        paintTerminal();
      }
      return;
    }
    termDbId.textContent = databaseLabel(db) + " (" + db.id + ")";
    termMeta.textContent = "Selected " + db.id + ". Commands use the instance token, not the Entra token.";
    var token = tokenForDatabase(db.id);
    if (token) { termToken.value = token; }
    // A command in flight owns the terminal's state and its input. A poll that
    // lands mid-command must not flip "running" back to "ready", nor re-enable
    // controls the command handler deliberately disabled — that is the flicker
    // the five-second refresh used to cause. Only a refresh can be pre-empted
    // this way; selecting a database always takes the controls back.
    var busy = options.refresh && termCommand.disabled;
    if (!busy) {
      termCommand.disabled = false;
      termSend.disabled = false;
      setTerminalState(isAsleep(db) ? "asleep" : "ready");
    }
    if (options.reset || terminalDbId !== db.id || !transcript.length) {
      terminalDbId = db.id;
      transcript = [bannerMarkup, "", esc("database " + db.id)];
      paintTerminal();
    }
  }
  function execRequest(dbId, token, command) {
    return withColdRetry(function () {
      var ctl = new AbortController();
      var timer = setTimeout(function () { ctl.abort(); }, 60000);
      return fetch(API + "/databases/" + encodeURIComponent(dbId) + "/exec", {
        method: "POST",
        signal: ctl.signal,
        headers: { "content-type": "application/json", "Authorization": "Bearer " + token },
        body: JSON.stringify({ command: command })
      })
        .then(function (r) {
          clearTimeout(timer);
          return jsonFromResponse(r).then(function (data) { return data || {}; });
        })
        .catch(function (e) {
          clearTimeout(timer);
          if (e.name === "AbortError") {
            var t = new Error("the instance did not answer within 60 seconds");
            t.code = "timeout";
            throw t;
          }
          throw e;
        });
    }, function () {
      setTerminalState("waking");
      writeTerminal(["waking the instance; retrying…"]);
    });
  }
  function runTerminalCommand(command) {
    if (!currentDb || !currentDb.id) { setHash("#console-access"); return; }
    if (/[\r\n]/.test(command)) {
      writeTerminal(["asmdb> " + command, "[ERR] command must be a single line", ""]);
      return;
    }
    command = command.trim();
    if (!command) { return; }
    var dbId = currentDb.id;
    var token = requireInstanceToken("Running " + command);
    if (!token) { return; }
    history.push(command);
    historyAt = history.length;
    termCommand.value = "";
    termCommand.disabled = true;
    termSend.disabled = true;
    setTerminalState("running");
    writeTerminal(["asmdb> " + command]);
    var wake = setTimeout(function () { setTerminalState("waking"); writeTerminal(["waking the instance…"]); }, 1200);
    execRequest(dbId, token, command)
      .then(function (d) {
        clearTimeout(wake);
        setTerminalState(d.ok === false ? "engine error" : "ready");
        writeTerminal((d.output || []).concat([""]));
        if (/^(INSERT|UPDATE|DELETE|TRUNCATE|SELECT|COUNT)\b/i.test(command)) {
          refreshSelectedStats();
          loadPreview();
        }
      })
      .catch(function (e) {
        clearTimeout(wake);
        setTerminalState("transport error");
        writeTerminal(["[ERR] " + (e.code || "error"), "      " + e.message, ""]);
      })
      .then(function () {
        termCommand.disabled = false;
        termSend.disabled = false;
        termCommand.focus();
      });
  }
  function renderCreated(d) {
    if (d.token) {
      tokenById[d.id] = d.token;
      writeSessionToken(d.id, d.token);
    }
    var tokenMarkup = oneTimeTokenMarkup(d, "database created", "This is the only time the token will be shown in clear text.");
    if (createTokenOutput) {
      createTokenOutput.hidden = false;
      createTokenOutput.innerHTML = tokenMarkup;
      createTokenOutput.setAttribute("data-state", "ok");
    }
    say(tokenMarkup, "ok");
    var existing = findDb(d.id);
    if (existing) { Object.assign(existing, d); }
    else { databases.unshift(d); }
    selectDatabase(d);
  }
  function sampleCommands() {
    var base = String(Date.now()) + "0";
    return [
      "INSERT " + base + " 1 engine asmdb stores one fixed-shape row per slot",
      "INSERT " + String(BigInt(base) + 1n) + " 2 wal write-ahead log keeps committed updates durable",
      "INSERT " + String(BigInt(base) + 2n) + " 3 mcp MCP tools call the same engine commands",
      "INSERT " + String(BigInt(base) + 3n) + " 4 cdc CDC frames preserve committed change order",
      "INSERT " + String(BigInt(base) + 4n) + " 5 bench BENCH writes rows for test data"
    ];
  }
  function runCommandsInOrder(commands, index, outputs, dbId, token) {
    outputs = outputs || [];
    if (index >= commands.length) { return Promise.resolve(outputs); }
    writeTerminal(["asmdb> " + commands[index]]);
    return execRequest(dbId, token, commands[index]).then(function (d) {
      writeTerminal((d.output || []).concat([""]));
      outputs.push({ command: commands[index], data: d });
      return runCommandsInOrder(commands, index + 1, outputs, dbId, token);
    });
  }
  function loadSampleData() {
    if (!currentDb) { setHash("#console-access"); return; }
    var dbId = currentDb.id;
    var token = requireInstanceToken("Loading sample data");
    if (!token) {
      renderPreviewMessage("Instance token required before loading sample data.");
      return;
    }
    loadSampleBtn.disabled = true;
    previewStatus.textContent = "loading";
    renderPreviewMessage("Loading sample data into " + databaseLabel(currentDb) + "…");
    writeTerminal(["loading sample data into " + databaseLabel(currentDb), ""]);
    runCommandsInOrder(sampleCommands(), 0, [], dbId, token)
      .then(function () {
        previewStatus.textContent = "loading";
        return loadPreview();
      })
      .then(function () { refreshSelectedStats(); })
      .catch(function (e) {
        previewStatus.textContent = e.code === "cold_start" ? "waking" : "unavailable";
        renderPreviewMessage((e && e.message) || "Sample load failed.");
      })
      .then(function () { loadSampleBtn.disabled = false; });
  }
  function upgradeCurrentDatabase() {
    if (!currentDb || !currentDb.upgradeAvailable) { return; }
    upgradeDbBtn.disabled = true;
    upgradeDbBtn.textContent = "upgrading…";
    say("Upgrading " + esc(databaseLabel(currentDb)) + ". The instance restarts during the upgrade.");
    request("/databases/" + encodeURIComponent(currentDb.id) + "/upgrade", { method: "POST" })
      .then(function (data) {
        var upgraded = data && data.database;
        if (upgraded) {
          var existing = findDb(upgraded.id);
          if (existing) { Object.assign(existing, upgraded); }
          selectDatabase(upgraded, { refresh: true });
        }
        say("Upgrade complete. " + esc((data && data.warning) || ""), "ok");
        return loadDatabases({ selectFirst: false });
      })
      .catch(fail)
      .then(function () {
        upgradeDbBtn.disabled = false;
        updateSelectedChrome();
      });
  }
  function renderRotatedToken(data, db) {
    var token = data && data.token;
    if (!token) { throw new Error("token rotation did not return a token"); }
    rememberInstanceTokenFor(db.id, token);
    if (currentDb && currentDb.id === db.id) { updateTokenHeld(); }
    if (rotatedTokenOutput && currentDb && currentDb.id === db.id) {
      var display = Object.assign({}, db, currentDb, { token: token });
      rotatedTokenOutput.hidden = false;
      rotatedTokenOutput.setAttribute("data-db-id", db.id);
      rotatedTokenOutput.innerHTML = [
        oneTimeTokenMarkup(display, "token rotation response received", "Update every client that used the previous token."),
        '<span class="k">warning  </span> ' + esc((data && data.warning) || "Token rotation restarts the instance and briefly interrupts active connections."),
        '<span class="k">state    </span> new token returned; the instance may still be restarting'
      ].join("\n");
      rotatedTokenOutput.setAttribute("data-state", "ok");
    }
    clearTokenNeeded();
    if (currentDb && currentDb.id === db.id) {
      say("New token returned for " + esc(databaseLabel(db)) + ". The instance may still be restarting; update every client that used the previous token.", "ok");
    }
  }
  function renderRotationTimeout(db) {
    clearSessionToken(db.id);
    delete tokenById[db.id];
    if (currentDb && currentDb.id === db.id) {
      delete currentDb.token;
      termToken.value = "";
      updateTokenHeld();
      if (rotatedTokenOutput) {
        rotatedTokenOutput.hidden = false;
        rotatedTokenOutput.removeAttribute("data-state");
        rotatedTokenOutput.setAttribute("data-db-id", db.id);
        rotatedTokenOutput.innerHTML = [
          '<span class="k">status   </span> rotation status unknown',
          '<span class="k">database </span> ' + esc(databaseLabel(db)) + ' (' + esc(db.id) + ')',
          '<span class="danger">          the request took longer than the console waited; the operation may still be in progress</span>',
          '<span class="danger">          the old token may already be invalid, and no new token was received by this browser</span>',
          "",
          "Wait for the instance to finish restarting, refresh the database state, then rotate again if you still do not have a working token. A 401 from the old token means the first rotation completed server-side."
        ].join("\n");
      }
      say("Token rotation status unknown for " + esc(databaseLabel(db)) + ". It may still be running; do not assume the old token still works.", "ok");
    }
  }
  function rotateCurrentToken() {
    if (!currentDb) {
      setHash("#console-access");
      if (tokenNeeded) {
        tokenNeeded.hidden = false;
        tokenNeeded.textContent = "Select a database before rotating its instance token.";
      }
      return;
    }
    var expected = databaseLabel(currentDb);
    var typed = window.prompt(
      "Rotate token for " + expected + ".\n\n" +
      "This issues a new token, invalidates the old one immediately, restarts the instance, and interrupts clients until they are updated.\n\n" +
      "Type " + expected + " to continue."
    );
    if (typed !== expected) { return; }
    var db = Object.assign({}, currentDb);
    rotateTokenBtn.disabled = true;
    rotateTokenBtn.textContent = "rotating…";
    if (rotatedTokenOutput) { rotatedTokenOutput.hidden = true; rotatedTokenOutput.textContent = ""; }
    request("/databases/" + encodeURIComponent(db.id) + "/rotate-token", { method: "POST" })
      .then(function (data) { renderRotatedToken(data, db); })
      .catch(function (e) {
        if (e && e.timedOut) {
          renderRotationTimeout(db);
          return;
        }
        if (rotatedTokenOutput && currentDb && currentDb.id === db.id) {
          rotatedTokenOutput.hidden = false;
          rotatedTokenOutput.setAttribute("data-db-id", db.id);
          rotatedTokenOutput.innerHTML = '<span class="err">[ERR]</span> ' + esc(e.code || "error") + "\n      " + esc(e.message || "token rotation failed");
          rotatedTokenOutput.setAttribute("data-state", "error");
        }
      })
      .then(function () {
        rotateTokenBtn.disabled = false;
        rotateTokenBtn.textContent = rotateTokenBtn.dataset.label;
      });
  }
  function deleteCurrentDatabase() {
    if (!currentDb) { setHash("#console-access"); return; }
    var expected = databaseLabel(currentDb);
    var typed = window.prompt("Type " + expected + " to delete this database and its data.");
    if (typed !== expected) { return; }
    deleteDbBtn.disabled = true;
    request("/databases/" + encodeURIComponent(currentDb.id), { method: "DELETE" })
      .then(function () {
        clearSessionToken(currentDb.id);
        if (currentDb && currentDb.id) { delete tokenById[currentDb.id]; }
        databases = databases.filter(function (db) { return db.id !== currentDb.id; });
        currentDb = null;
        termToken.value = "";
        updateTokenHeld();
        renderDatabases();
        renderStats(null, null);
        renderPreviewMessage("Database deleted. Select another instance.");
        showTerminal(null);
        setHash("#console-access");
      })
      .catch(function (e) {
        renderPreviewMessage((e && e.message) || "Delete failed.");
      })
      .then(function () { deleteDbBtn.disabled = false; });
  }
  function parseBenchOutput(lines) {
    var text = (lines || []).join("\n");
    function pick(re) {
      var m = text.match(re);
      return m ? m[1] : "";
    }
    return {
      rows: pick(/([0-9][0-9,]*)\s+rows?\b/i) || pick(/inserted[^0-9]*([0-9][0-9,]*)/i),
      elapsed: pick(/([0-9][0-9,.]*\s*(?:ms|s|sec|secs|seconds))\b/i),
      rate: pick(/([0-9][0-9,.]*)\s*(?:rows\/s|rows per second|row\/s)\b/i)
    };
  }
  function renderBenchResult(result) {
    var parts = [];
    if (result.rows) { parts.push("rows " + result.rows); }
    if (result.elapsed) { parts.push("elapsed " + result.elapsed); }
    if (result.rate) { parts.push("rows/s " + result.rate); }
    benchResult.textContent = parts.length ? parts.join(" · ") : "Bench complete. See engine output above.";
  }
  function runBench() {
    if (!currentDb) { setHash("#console-access"); return; }
    var command = "BENCH " + benchSize.value;
    var dbId = currentDb.id;
    var token = requireInstanceToken("Running " + command);
    if (!token) {
      benchResult.textContent = "Instance token required before running BENCH.";
      return;
    }
    benchRun.disabled = true;
    termCommand.disabled = true;
    termSend.disabled = true;
    setTerminalState("bench");
    benchResult.textContent = "Running " + command + ". This writes real rows.";
    writeTerminal(["asmdb> " + command, "BENCH writes real rows into this database."]);
    execRequest(dbId, token, command)
      .then(function (d) {
        setTerminalState(d.ok === false ? "engine error" : "ready");
        writeTerminal((d.output || []).concat([""]));
        renderBenchResult(parseBenchOutput(d.output || []));
        refreshSelectedStats();
        loadPreview();
      })
      .catch(function (e) {
        setTerminalState("transport error");
        benchResult.textContent = (e && e.message) || "BENCH failed.";
        writeTerminal(["[ERR] " + (e.code || "error"), "      " + ((e && e.message) || "BENCH failed."), ""]);
      })
      .then(function () {
        benchRun.disabled = false;
        termCommand.disabled = false;
        termSend.disabled = false;
      });
  }
  function fail(e) {
    if (e.code === "not_signed_in") { showSignedOut("Not signed in.", "Sign in with Microsoft before using the console.", ""); return; }
    if (e.code === "forbidden") { say('<span class="err">[ERR]</span> forbidden\n      signed in, but not a member of ' + ADMIN_GROUP, "error"); return; }
    if (e.code === "api_unreachable") { say('<span class="err">[ERR]</span> api_unreachable\n      signed in, but the control plane API is unreachable', "error"); return; }
    say('<span class="err">[ERR]</span> ' + esc(e.code || "error") + "\n      " + esc(e.message), "error");
  }
  function copyTokenFor(idValue, button) {
    var token = tokenById[idValue] || readSessionToken(idValue);
    if (!token) { return; }
    var label = button.textContent;
    function done(text) {
      button.textContent = text;
      setTimeout(function () { button.textContent = label; }, 900);
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(token).then(function () { done("copied"); }).catch(function () { done("copy failed"); });
    } else {
      done("copy unavailable");
    }
  }
  function setTokenReveal(on) {
    if (revealTimer) {
      clearTimeout(revealTimer);
      revealTimer = 0;
    }
    updateTokenHeld(on);
    if (tokenReveal) { tokenReveal.textContent = on ? "Hide token" : "Reveal for 10s"; }
  }
  function revealTokenTemporarily() {
    setTokenReveal(true);
    revealTimer = setTimeout(function () { setTokenReveal(false); }, 10000);
  }
  function handleTokenOutputClick(e, container) {
    var copy = e.target.closest("[data-copy-token-for]");
    if (copy) { copyTokenFor(copy.getAttribute("data-copy-token-for"), copy); return; }
    var dismiss = e.target.closest("[data-dismiss-token-output]");
    if (dismiss) {
      container.hidden = true;
      container.textContent = "";
    }
  }

  createBtn.addEventListener("click", function () {
    var name = (nameEl.value || "").trim();
    if (!/^[a-z0-9][a-z0-9-]{0,38}[a-z0-9]$/.test(name)) {
      say('<span class="err">[ERR]</span> invalid_request\n      name must be 2–40 chars: lowercase letters, digits and hyphens,\n      starting and ending with a letter or digit', "error");
      nameEl.focus();
      return;
    }
    busy(true, createBtn, "creating…");
    say("provisioning a container… this takes a few seconds");
    request("/databases", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: name, tier: tierEl.value })
    }).then(renderCreated).catch(fail).then(function () { busy(false, createBtn); });
  });
  out.addEventListener("click", function (e) {
    handleTokenOutputClick(e, out);
  });
  if (createTokenOutput) {
    createTokenOutput.addEventListener("click", function (e) { handleTokenOutputClick(e, createTokenOutput); });
  }
  listBtn.addEventListener("click", function () {
    busy(true, listBtn, "loading…");
    loadDatabases({ selectFirst: false }).then(function () { busy(false, listBtn); });
  });
  openSelected.addEventListener("click", function (e) {
    if (!currentDb) {
      e.preventDefault();
      renderPreviewMessage("Select a database before opening the database view.");
    }
  });
  databaseList.addEventListener("click", function (e) {
    var button = e.target.closest("[data-db-id]");
    if (!button) { return; }
    var db = findDb(button.getAttribute("data-db-id"));
    if (db) { selectDatabase(db); }
  });
  saveToken.addEventListener("click", function () {
    var token = termToken.value.trim();
    if (!currentDb) { setHash("#console-access"); return; }
    if (!token) { termToken.focus(); return; }
    rememberInstanceToken(token);
    clearTokenNeeded();
    saveToken.textContent = "saved";
    setTimeout(function () { saveToken.textContent = saveToken.dataset.label; }, 900);
    if (activeView === "database") { loadPreview(); }
  });
  if (tokenReveal) {
    // One behaviour, not two. Hold-to-reveal and click-to-reveal-for-10s were
    // both wired to this button: a click fired pointerdown, pointerup and click
    // in sequence, and any pointerleave afterwards cancelled the reveal — so
    // moving the mouse off the button re-masked it immediately and the control
    // looked broken. The label promises ten seconds, so that is what it does,
    // and it works from the keyboard.
    tokenReveal.addEventListener("click", revealTokenTemporarily);
    tokenReveal.addEventListener("keydown", function (e) {
      if (e.key === " " || e.key === "Enter") {
        e.preventDefault();
        revealTokenTemporarily();
      }
    });
  }
  loadSampleBtn.addEventListener("click", loadSampleData);
  rotateTokenBtn.addEventListener("click", rotateCurrentToken);
  rotatedTokenOutput.addEventListener("click", function (e) {
    handleTokenOutputClick(e, rotatedTokenOutput);
  });
  upgradeDbBtn.addEventListener("click", upgradeCurrentDatabase);
  deleteDbBtn.addEventListener("click", deleteCurrentDatabase);
  benchRun.addEventListener("click", runBench);
  authSignIn.addEventListener("click", signIn);
  authSignOut.addEventListener("click", signOut);
  termForm.addEventListener("submit", function (e) { e.preventDefault(); runTerminalCommand(termCommand.value); });
  termToken.addEventListener("change", function () {
    var token = termToken.value.trim();
    if (token) {
      rememberInstanceToken(token);
      clearTokenNeeded();
    }
  });
  termCommand.addEventListener("keydown", function (e) {
    if (e.key === "ArrowUp" && history.length) {
      e.preventDefault();
      historyAt = Math.max(0, historyAt - 1);
      termCommand.value = history[historyAt] || "";
    } else if (e.key === "ArrowDown" && history.length) {
      e.preventDefault();
      historyAt = Math.min(history.length, historyAt + 1);
      termCommand.value = history[historyAt] || "";
    }
  });
  Array.prototype.forEach.call(document.querySelectorAll("[data-command]"), function (b) {
    b.addEventListener("click", function () {
      termCommand.value = b.getAttribute("data-command");
      termCommand.focus();
    });
  });
  Array.prototype.forEach.call(document.querySelectorAll("[data-tier]"), function (b) {
    b.addEventListener("click", function () {
      tierEl.value = b.getAttribute("data-tier");
      setHash("#create");
      nameEl.focus();
    });
  });
  window.addEventListener("hashchange", applyRoute);
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "hidden") { stopPolling(); }
    else if (auth.account) { loadDatabases({ selectFirst: false }).then(startPolling); }
  });

  renderDatabases();
  renderStats(null, null);
  showTerminal(null);
  applyRoute();
  loadVersion();
  loadBinaries();

  showSignedOut("Loading sign-in configuration…", "The public site remains available while the console checks Entra configuration.", "");
  fetchConfig().then(initAuth).catch(authInitFailed);
})();

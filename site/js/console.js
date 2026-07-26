// asmdb Cloud — signed-in console.
// Management calls use the Entra token; row preview and CLI use the instance token.
(function () {
  "use strict";

  var API = "/api/v1";
  var ADMIN_GROUP = "ASMDB_ADMIN";
  var POLL_BASE_MS = 5000;
  var POLL_MAX_MS = 30000;
  var PREVIEW_LIMIT = "20";

  function id(name) { return document.getElementById(name); }
  var out = id("db-out");
  var nameEl = id("db-name");
  var tierEl = id("db-tier");
  var createBtn = id("db-create");
  var listBtn = id("db-list");
  var openSelected = id("open-selected-db");
  var saveToken = id("save-token");
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
  var metricStorage = id("metric-storage");
  var termDbId = id("term-db-id");
  var termState = id("term-state");
  var termMeta = id("term-meta");
  var termToken = id("term-token");
  var termScreen = id("term-screen");
  var termForm = id("term-form");
  var termCommand = id("term-command");
  var termSend = id("term-send");
  var binaryList = id("binary-list");
  var bannerMarkup = termScreen.innerHTML;

  var databases = [];
  var currentDb = null;
  var tokenById = Object.create(null);
  var transcript = [];
  var history = [];
  var historyAt = 0;
  var statsPrevious = Object.create(null);
  var pollTimer = 0;
  var pollDelay = POLL_BASE_MS;
  var loadingList = false;
  var activeView = "create";
  var auth = { config: null, client: null, account: null, ready: false };

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
  [createBtn, listBtn, authSignIn, authSignOut, saveToken].forEach(function (b) {
    if (b) { b.dataset.label = b.textContent; }
  });

  function jsonFromResponse(r) {
    return r.text().then(function (body) {
      var data = null;
      try { data = body ? JSON.parse(body) : null; } catch (e) { /* not JSON */ }
      if (!r.ok) {
        var msg = (data && data.error && data.error.message) || body || (r.status + " " + r.statusText);
        var err = new Error(msg);
        err.status = r.status;
        err.code = (data && data.error && data.error.code) || "http_" + r.status;
        if (data && data.error && data.error.detail) { err.detail = data.error.detail; }
        throw err;
      }
      return data;
    });
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
  function stoppedLabel(reason) {
    if (!reason) { return "unavailable"; }
    if (/^(stopped|scaledtozero|scaled_to_zero|sleeping|sleep)$/i.test(String(reason))) { return "stopped"; }
    return String(reason).replace(/_/g, " ");
  }
  function isStopped(db) {
    var state = String(db && db.state || "").toLowerCase().replace(/[^a-z0-9]/g, "");
    return state === "stopped" || state === "scaledtozero" || state === "sleeping" || state === "sleep";
  }
  function renderStatsUnavailable(reason) {
    var label = stoppedLabel(reason);
    monitorState.textContent = label;
    metricRows.textContent = label === "stopped" ? "stopped" : "No sample";
    metricRowsHint.textContent = label === "stopped"
      ? "Free and standard instances can scale to zero; no stats request is sent while stopped."
      : "Stats unavailable for the selected database.";
    metricCpu.textContent = "—";
    metricMemory.textContent = label === "stopped" ? "stopped" : "No sample";
    metricStorage.textContent = "allocated storage —";
    setRowsMeter("0", "0");
  }
  function renderStatsEmpty() {
    monitorState.textContent = "—";
    metricRows.textContent = "No database selected";
    metricRowsHint.textContent = "Open a database from Access to request stats.";
    metricCpu.textContent = "—";
    metricMemory.textContent = "No database selected";
    metricStorage.textContent = "allocated storage —";
    setRowsMeter("0", "0");
  }
  function renderStats(db, payload) {
    if (!db) { renderStatsEmpty(); return; }
    if (isStopped(db)) { renderStatsUnavailable(db.state); return; }
    if (!payload) {
      monitorState.textContent = "waiting";
      metricRows.textContent = "No sample yet";
      metricRowsHint.textContent = "Rows are shown against capacity when the first stats sample arrives.";
      metricCpu.textContent = "—";
      metricMemory.textContent = "No sample yet";
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
    metricMemory.textContent = formatBytes((stats.memory || {}).usedBytes) + " / " + formatBytes((stats.memory || {}).limitBytes);
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
      return;
    }
    selectedDbName.textContent = databaseLabel(currentDb);
    selectedDbId.textContent = currentDb.id + " · " + (currentDb.tier || "tier") + " · " + (currentDb.state || "state");
    databaseViewName.textContent = databaseLabel(currentDb);
    databaseViewMeta.textContent = currentDb.endpoint
      ? currentDb.id + " · " + (currentDb.state || "state") + " · " + currentDb.endpoint
      : currentDb.id + " · " + (currentDb.state || "state");
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
      var state = isStopped(db) ? "stopped" : (db.state || "state");
      return '<button class="db-item" type="button" role="option" aria-selected="' + (selected ? "true" : "false") + '" data-db-id="' + attr(db.id) + '">' +
        '<span class="db-item__main"><span class="db-item__name">' + esc(databaseLabel(db)) + '</span>' +
        '<span class="db-item__id">' + esc(db.id) + '</span></span>' +
        '<span class="db-item__rows">' + esc(state) + '</span>' +
        '<span class="db-item__meta">' + esc(db.tier || "tier") + ' · endpoint ' + esc(db.endpoint || "unavailable") + '</span>' +
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
    currentDb = db ? Object.assign({}, db) : null;
    if (currentDb && tokenById[currentDb.id]) { currentDb.token = tokenById[currentDb.id]; }
    if (currentDb && !currentDb.token) { termToken.value = ""; }
    updateSelectedChrome();
    renderDatabases();
    renderStats(currentDb, null);
    showTerminal(currentDb);
    if (currentDb && options.route) { setHash(options.route); }
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
  function instanceToken() {
    if (!currentDb) { return ""; }
    return currentDb.token || tokenById[currentDb.id] || termToken.value.trim();
  }
  function rememberInstanceToken(token) {
    if (!currentDb || !token) { return; }
    currentDb.token = token;
    tokenById[currentDb.id] = token;
  }
  function loadPreview() {
    if (!currentDb || !currentDb.endpoint) {
      renderPreviewMessage("Open a database from Access first.");
      return Promise.resolve();
    }
    if (isStopped(currentDb)) {
      renderPreviewMessage("Instance is stopped. No row request is sent from the monitoring view.");
      return Promise.resolve();
    }
    var token = instanceToken();
    if (!token) {
      renderPreviewMessage("Paste the instance token in Access to preview rows for " + databaseLabel(currentDb) + ".");
      return Promise.resolve();
    }
    rememberInstanceToken(token);
    previewStatus.textContent = "loading";
    return fetch(currentDb.endpoint.replace(/\/$/, "") + "/v1/rows?limit=" + PREVIEW_LIMIT + "&offset=0", {
      headers: { "Authorization": "Bearer " + token, "accept": "application/json" }
    })
      .then(jsonFromResponse)
      .then(function (data) { renderPreviewRows((data && data.rows) || []); })
      .catch(function (e) {
        previewStatus.textContent = "unavailable";
        renderPreviewMessage(e && e.message ? e.message : "Preview unavailable.");
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
        if (!selected && options.selectFirst && databases.length) { selected = databases[0]; }
        if (selected) { selectDatabase(selected); }
        else { renderDatabases(); }
        say(databases.length ? "Ready. Use Access to choose a database, or Create to provision another." : "Ready. Create a database or refresh Access.", "ok");
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
    if (isStopped(currentDb)) { renderStatsUnavailable(currentDb.state); return Promise.resolve(); }
    monitorState.textContent = "loading";
    return request("/databases/" + encodeURIComponent(currentDb.id) + "/stats", { method: "GET" })
      .then(function (data) { renderStats(currentDb, data); })
      .catch(function () {
        pollDelay = Math.min(POLL_MAX_MS, pollDelay * 2);
        renderStatsUnavailable("unavailable");
      });
  }
  function startPolling() { stopPolling(); schedulePoll(POLL_BASE_MS); }
  function stopPolling() { if (pollTimer) { clearTimeout(pollTimer); pollTimer = 0; } }
  function schedulePoll(delay) {
    stopPolling();
    pollTimer = setTimeout(function () {
      if (document.visibilityState === "hidden" || !auth.account) { return; }
      loadDatabases({ selectFirst: false }).then(function () {
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
  function showTerminal(db) {
    if (!db) {
      termDbId.textContent = "no database selected";
      termMeta.textContent = "Open a database from Access before running commands.";
      termCommand.disabled = true;
      termSend.disabled = true;
      setTerminalState("no database");
      transcript = [bannerMarkup, "", esc("asmdb> open a database from Access")];
      paintTerminal();
      return;
    }
    termDbId.textContent = databaseLabel(db) + " (" + db.id + ")";
    termMeta.textContent = "Selected " + db.id + ". Commands use the instance token, not the Entra token.";
    if (instanceToken()) { termToken.value = instanceToken(); }
    termCommand.disabled = false;
    termSend.disabled = false;
    setTerminalState(isStopped(db) ? "stopped" : "ready");
    transcript = [bannerMarkup, "", esc("database " + db.id)];
    paintTerminal();
  }
  function execRequest(command) {
    var ctl = new AbortController();
    var timer = setTimeout(function () { ctl.abort(); }, 60000);
    return fetch(API + "/databases/" + encodeURIComponent(currentDb.id) + "/exec", {
      method: "POST",
      signal: ctl.signal,
      headers: { "content-type": "application/json", "Authorization": "Bearer " + instanceToken() },
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
  }
  function runTerminalCommand(command) {
    if (!currentDb || !currentDb.id) { setHash("#console-access"); return; }
    if (/[\r\n]/.test(command)) {
      writeTerminal(["asmdb> " + command, "[ERR] command must be a single line", ""]);
      return;
    }
    command = command.trim();
    if (!command) { return; }
    if (!instanceToken()) {
      setHash("#console-access");
      termToken.focus();
      writeTerminal(["[ERR] paste the instance token in Access before running a command", ""]);
      return;
    }
    rememberInstanceToken(instanceToken());
    history.push(command);
    historyAt = history.length;
    termCommand.value = "";
    termCommand.disabled = true;
    termSend.disabled = true;
    setTerminalState("running");
    writeTerminal(["asmdb> " + command]);
    var wake = setTimeout(function () { setTerminalState("waking"); writeTerminal(["waking the instance…"]); }, 1200);
    execRequest(command)
      .then(function (d) {
        clearTimeout(wake);
        setTerminalState(d.ok === false ? "engine error" : "ready");
        writeTerminal((d.output || []).concat([""]));
        if (/^(INSERT|UPDATE|DELETE|TRUNCATE|SELECT|COUNT)\b/i.test(command)) {
          refreshSelectedStats();
          if (!isStopped(currentDb)) { loadPreview(); }
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
    if (d.token) { tokenById[d.id] = d.token; }
    say([
      '<span class="ok">[ OK ]</span> database created\n',
      '<span class="k">id       </span> ' + esc(d.id),
      '<span class="k">name     </span> ' + esc(d.name),
      '<span class="k">tier     </span> ' + esc(d.tier),
      '<span class="k">state    </span> ' + esc(d.state),
      '<span class="k">endpoint </span> ' + esc(d.endpoint),
      "",
      '<span class="k">token    </span> ' + esc(d.token),
      '<span class="err">          shown once — put it in a secret manager now</span>'
    ].join("\n"), "ok");
    var existing = findDb(d.id);
    if (existing) { Object.assign(existing, d); }
    else { databases.unshift(d); }
    selectDatabase(d, { route: "#database" });
    loadDatabases({ selectFirst: false });
  }
  function fail(e) {
    if (e.code === "not_signed_in") { showSignedOut("Not signed in.", "Sign in with Microsoft before using the console.", ""); return; }
    if (e.code === "forbidden") { say('<span class="err">[ERR]</span> forbidden\n      signed in, but not a member of ' + ADMIN_GROUP, "error"); return; }
    if (e.code === "api_unreachable") { say('<span class="err">[ERR]</span> api_unreachable\n      signed in, but the control plane API is unreachable', "error"); return; }
    say('<span class="err">[ERR]</span> ' + esc(e.code || "error") + "\n      " + esc(e.message), "error");
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
    saveToken.textContent = "saved";
    setTimeout(function () { saveToken.textContent = saveToken.dataset.label; }, 900);
    if (activeView === "database") { loadPreview(); }
  });
  authSignIn.addEventListener("click", signIn);
  authSignOut.addEventListener("click", signOut);
  termForm.addEventListener("submit", function (e) { e.preventDefault(); runTerminalCommand(termCommand.value); });
  termToken.addEventListener("change", function () {
    var token = termToken.value.trim();
    if (token) { rememberInstanceToken(token); }
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
  loadBinaries();

  showSignedOut("Loading sign-in configuration…", "The public site remains available while the console checks Entra configuration.", "");
  fetchConfig().then(initAuth).catch(authInitFailed);
})();

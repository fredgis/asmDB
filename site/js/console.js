// asmdb Cloud — provisioning console.
//
// Talks to the control plane at the same origin. Database values remain strings
// unless arithmetic is needed for display-only ratios: u64 identifiers and i64
// values are never parsed into JavaScript numbers for presentation.

(function () {
  "use strict";

  var API = "/api/v1";
  var ADMIN_GROUP = "ASMDB_ADMIN";
  var POLL_BASE_MS = 5000;
  var POLL_MAX_MS = 30000;
  var PREVIEW_LIMIT = "20";

  var out = document.getElementById("db-out");
  var nameEl = document.getElementById("db-name");
  var tierEl = document.getElementById("db-tier");
  var createBtn = document.getElementById("db-create");
  var listBtn = document.getElementById("db-list");
  var authPanel = document.getElementById("auth-panel");
  var authSignIn = document.getElementById("auth-signin");
  var authStatus = document.getElementById("auth-status");
  var authDetail = document.getElementById("auth-detail");
  var consoleApp = document.getElementById("console-app");
  var authUser = document.getElementById("auth-user");
  var authSignOut = document.getElementById("auth-signout");
  var databaseList = document.getElementById("database-list");
  var dbListStatus = document.getElementById("db-list-status");
  var previewStatus = document.getElementById("preview-status");
  var previewRows = document.getElementById("preview-rows");
  var monitorState = document.getElementById("monitor-state");
  var metricRows = document.getElementById("metric-rows");
  var rowsMeter = document.getElementById("rows-meter");
  var metricCpu = document.getElementById("metric-cpu");
  var metricMemory = document.getElementById("metric-memory");
  var metricStorage = document.getElementById("metric-storage");
  var term = document.getElementById("db-terminal");
  var termDbId = document.getElementById("term-db-id");
  var termState = document.getElementById("term-state");
  var termMeta = document.getElementById("term-meta");
  var termTokenWrap = document.getElementById("term-token-wrap");
  var termToken = document.getElementById("term-token");
  var termScreen = document.getElementById("term-screen");
  var termForm = document.getElementById("term-form");
  var termCommand = document.getElementById("term-command");
  var termSend = document.getElementById("term-send");

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
  var auth = { config: null, client: null, account: null, ready: false };

  var bannerLines = [
    "                              ____  ",
    "    ____ __________ ___  ____/ / /_ ",
    "   / __ `/ ___/ __ `__ \\/ __  / __ \\",
    "  / /_/ (__  ) / / / / / /_/ / /_/ /",
    "  \\__,_/____/_/ /_/ /_/\\__,_/_.___/ "
  ];
  var tagline = "  a minimalist transactional database engine, in x86-64 assembly";
  var metaPrefix = "  nasm -f bin  .  no linker  .  no CRT  .  WAL-durable  .  Windows + Linux  .  v";

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c];
    });
  }

  function attr(s) {
    return esc(s).replace(/"/g, "&quot;");
  }

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
    say("Loading databases…");
    loadDatabases({ selectFirst: true });
    startPolling();
  }

  function busy(on, btn, label) {
    createBtn.disabled = on;
    listBtn.disabled = on;
    if (btn) { btn.textContent = on ? label : btn.dataset.label; }
  }

  [createBtn, listBtn, authSignIn, authSignOut].forEach(function (b) {
    if (b) { b.dataset.label = b.textContent; }
  });

  function jsonFromResponse(r) {
    return r.text().then(function (body) {
      var data = null;
      try { data = body ? JSON.parse(body) : null; } catch (e) { /* not json */ }
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
      setAuthPanel(
        "Not signed in.",
        "Serve this page from the control plane to load Entra sign-in configuration.",
        ""
      );
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
    if (!window.msal || !window.msal.PublicClientApplication) {
      throw new Error("MSAL browser did not load");
    }
    auth.config = cfg;
    auth.client = new window.msal.PublicClientApplication({
      auth: {
        clientId: cfg.clientId,
        authority: "https://login.microsoftonline.com/" + cfg.tenantId,
        redirectUri: window.location.href.split("#")[0]
      },
      cache: {
        cacheLocation: "sessionStorage",
        storeAuthStateInCookie: false
      }
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
        .then(function (r) {
          clearTimeout(timer);
          return jsonFromResponse(r);
        })
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
    if (s.charAt(0) === "-") {
      sign = "-";
      s = s.slice(1);
    }
    s = s.replace(/^0+(?=\d)/, "");
    return sign + s.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  }

  function formatBytes(value) {
    if (value == null || value === "") { return "—"; }
    var n;
    try { n = BigInt(value); } catch (e) { return formatDecimalString(value) + " B"; }
    var units = ["B", "KiB", "MiB", "GiB", "TiB"];
    var unit = 0;
    var scaled = n * 100n;
    while (scaled >= 102400n && unit < units.length - 1) {
      scaled = scaled / 1024n;
      unit += 1;
    }
    var whole = scaled / 100n;
    var frac = scaled % 100n;
    if (unit === 0) { return formatDecimalString(String(n)) + " B"; }
    var fracText = frac < 10n ? "0" + String(frac) : String(frac);
    fracText = fracText.replace(/0+$/, "");
    return formatDecimalString(String(whole)) + (fracText ? "." + fracText : "") + " " + units[unit];
  }

  function percentFromDecimalStrings(used, total) {
    try {
      var u = BigInt(used || "0");
      var t = BigInt(total || "0");
      if (t <= 0n) { return null; }
      var hundredths = (u * 10000n) / t;
      return Number(hundredths) / 100;
    } catch (e) {
      return null;
    }
  }

  function setRowsMeter(rows, capacity) {
    var percent = percentFromDecimalStrings(rows, capacity);
    if (percent == null) {
      rowsMeter.style.width = "0";
      rowsMeter.removeAttribute("data-tiny");
      return;
    }
    var width = percent;
    if (width > 0 && width < 0.7) { width = 0.7; }
    if (width > 100) { width = 100; }
    rowsMeter.style.width = width + "%";
    if (percent > 0 && percent < 0.1) { rowsMeter.setAttribute("data-tiny", "true"); }
    else { rowsMeter.removeAttribute("data-tiny"); }
  }

  function databaseLabel(db) {
    return db.name || db.id || "database";
  }

  function unwrapStats(db) {
    if (!db || !db.stats) { return null; }
    if (db.stats.available === false) { return { available: false, reason: db.stats.reason || "unavailable" }; }
    return { available: true, stats: db.stats.stats || db.stats };
  }

  function normalizeStatsPayload(payload) {
    if (!payload) { return null; }
    if (payload.available === false) { return { available: false, reason: payload.reason || "unavailable" }; }
    return { available: true, stats: payload.stats || payload };
  }

  function stoppedLabel(reason) {
    if (!reason) { return "unavailable"; }
    if (reason === "Stopped" || reason === "stopped" || reason === "ScaledToZero" || reason === "scaled_to_zero") {
      return "stopped";
    }
    return reason.replace(/_/g, " ");
  }

  function renderStatsUnavailable(reason) {
    var label = stoppedLabel(reason);
    monitorState.textContent = label;
    metricRows.textContent = label;
    metricCpu.textContent = "—";
    metricMemory.textContent = label;
    metricStorage.textContent = "allocated storage —";
    setRowsMeter("0", "0");
  }

  function renderStats(db, payload) {
    var normalized = normalizeStatsPayload(payload) || unwrapStats(db);
    if (!normalized) {
      monitorState.textContent = "—";
      metricRows.textContent = "—";
      metricCpu.textContent = "—";
      metricMemory.textContent = "—";
      metricStorage.textContent = "allocated storage —";
      setRowsMeter("0", "0");
      return;
    }
    if (!normalized.available) {
      renderStatsUnavailable(normalized.reason);
      return;
    }
    var stats = normalized.stats || {};
    var rows = stats.rows || "0";
    var capacity = stats.capacity || "4194304";
    monitorState.textContent = stats.engine ? "engine " + stats.engine : "running";
    metricRows.textContent = formatDecimalString(rows) + " / " + formatDecimalString(capacity);
    setRowsMeter(rows, capacity);
    var memory = stats.memory || {};
    metricMemory.textContent = formatBytes(memory.usedBytes) + " / " + formatBytes(memory.limitBytes);
    var storage = stats.storage || {};
    metricStorage.textContent = "allocated storage " + formatBytes(storage.dataBytes);
    metricCpu.textContent = cpuText(db.id, stats.cpu || {});
  }

  function cpuText(id, cpu) {
    var usage = cpu.usageUsec;
    var cores = typeof cpu.limitCores === "number" ? cpu.limitCores : Number(cpu.limitCores);
    if (!usage || !cores) { return "—"; }
    var now = Date.now();
    var current;
    try { current = BigInt(usage); } catch (e) { return "—"; }
    var prev = statsPrevious[id];
    statsPrevious[id] = { usage: current, sampledAt: now };
    if (!prev || current < prev.usage) { return "—"; }
    var elapsedUsec = (now - prev.sampledAt) * 1000;
    if (elapsedUsec <= 0) { return "—"; }
    var deltaUsec = Number(current - prev.usage);
    var percent = (deltaUsec / (elapsedUsec * cores)) * 100;
    if (!isFinite(percent)) { return "—"; }
    return percent.toFixed(percent < 10 ? 1 : 0) + " %";
  }

  function renderDatabases() {
    dbListStatus.textContent = databases.length ? String(databases.length) : "empty";
    if (!databases.length) {
      databaseList.innerHTML = '<div class="db-empty">No databases yet.</div>';
      renderPreviewMessage("Create a database to preview rows.");
      renderStats(null, null);
      showTerminal(null);
      return;
    }
    databaseList.innerHTML = databases.map(function (db) {
      var selected = currentDb && currentDb.id === db.id;
      var stats = unwrapStats(db);
      var rows = stats && stats.available && stats.stats
        ? formatDecimalString(stats.stats.rows || "0") + " rows"
        : stoppedLabel(stats && stats.reason);
      return '<button class="db-item" type="button" role="option" aria-selected="' + (selected ? "true" : "false") + '" data-db-id="' + attr(db.id) + '">' +
        '<span class="db-item__main"><span class="db-item__name">' + esc(databaseLabel(db)) + '</span>' +
        '<span class="db-item__id">' + esc(db.id) + '</span></span>' +
        '<span class="db-item__meta">' + esc(db.tier || "tier") + ' · ' + esc(db.state || "state") + '</span>' +
        '<span class="db-item__rows">' + esc(rows || "—") + '</span>' +
      '</button>';
    }).join("");
  }

  function findDb(id) {
    for (var i = 0; i < databases.length; i += 1) {
      if (databases[i].id === id) { return databases[i]; }
    }
    return null;
  }

  function selectDatabase(db, options) {
    options = options || {};
    currentDb = db ? Object.assign({}, db) : null;
    if (currentDb && tokenById[currentDb.id]) { currentDb.token = tokenById[currentDb.id]; }
    if (currentDb && !currentDb.token) { termToken.value = ""; }
    renderDatabases();
    renderStats(currentDb, currentDb && currentDb.stats);
    showTerminal(currentDb);
    if (currentDb && currentDb.token && options.preview !== false) { loadPreview(); }
    else if (currentDb) { renderPreviewMessage("Paste the instance token to preview rows for " + databaseLabel(currentDb) + "."); }
    else { renderPreviewMessage("Select a database."); }
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
      return "<tr>" +
        "<td>" + esc(formatDecimalString(row.id)) + "</td>" +
        "<td>" + esc(formatDecimalString(row.value)) + "</td>" +
        "<td>" + esc(row.tag) + "</td>" +
        "<td>" + esc(row.content) + "</td>" +
        "<td>" + esc(formatDecimalString(row.updated)) + "</td>" +
      "</tr>";
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
      renderPreviewMessage("Select a database.");
      return;
    }
    var token = instanceToken();
    if (!token) {
      renderPreviewMessage("Paste the instance token to preview rows.");
      return;
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
    return request("/databases?include_stats=true", { method: "GET" })
      .then(function (data) {
        loadingList = false;
        pollDelay = POLL_BASE_MS;
        databases = (data && data.databases) || [];
        databases.forEach(function (db) {
          if (db.token) { tokenById[db.id] = db.token; }
        });
        var selected = currentDb && findDb(currentDb.id);
        if (!selected && options.selectFirst && databases.length) { selected = databases[0]; }
        if (selected) { selectDatabase(selected, { preview: false }); }
        else { renderDatabases(); }
        say(databases.length ? "Ready. Select a database, run the CLI, or create another." : "Ready. Create a database to open the console.", "ok");
      })
      .catch(function (e) {
        loadingList = false;
        pollDelay = Math.min(POLL_MAX_MS, pollDelay * 2);
        dbListStatus.textContent = "error";
        fail(e);
      });
  }

  function refreshSelectedStats() {
    if (!currentDb) { return; }
    request("/databases/" + encodeURIComponent(currentDb.id) + "/stats", { method: "GET" })
      .then(function (data) { renderStats(currentDb, data); })
      .catch(function () { renderStatsUnavailable("unavailable"); });
  }

  function startPolling() {
    stopPolling();
    schedulePoll(POLL_BASE_MS);
  }

  function stopPolling() {
    if (pollTimer) {
      clearTimeout(pollTimer);
      pollTimer = 0;
    }
  }

  function schedulePoll(delay) {
    stopPolling();
    pollTimer = setTimeout(function () {
      if (document.visibilityState === "hidden" || !auth.account) {
        schedulePoll(POLL_BASE_MS);
        return;
      }
      loadDatabases({ selectFirst: false }).then(function () {
        schedulePoll(pollDelay);
      });
    }, delay);
  }

  function setTerminalState(text) {
    termState.textContent = text;
  }

  function bannerHTML() {
    var art = bannerLines.map(function (line, index) {
      return '<span class="banner-art banner-art--' + (index + 1) + '">' + esc(line) + '</span>';
    }).join("\n");
    return art + "\n\n" +
      '<span class="banner-tagline">' + esc(tagline) + '</span>\n' +
      '<span class="banner-meta">' + esc(metaPrefix) + '<span class="banner-version">1.5.0</span></span>\n\n' +
      '<span class="banner-hint">  type <span class="banner-hot">HELP</span> for commands, or <span class="banner-hot">QUIT</span> to exit</span>';
  }

  function paintTerminal() {
    termScreen.innerHTML = transcript.join("\n");
    termScreen.scrollTop = termScreen.scrollHeight;
  }

  function writeTerminal(lines) {
    Array.prototype.push.apply(transcript, lines.map(esc));
    if (transcript.length > 700) {
      transcript = transcript.slice(transcript.length - 700);
    }
    paintTerminal();
  }

  function showTerminal(db) {
    if (!db) {
      termDbId.textContent = "no database selected";
      termMeta.textContent = "Create or select a database. The CLI opens here.";
      termTokenWrap.hidden = true;
      termCommand.disabled = true;
      termSend.disabled = true;
      transcript = [bannerHTML(), "", esc("asmdb> select a database")];
      paintTerminal();
      return;
    }
    termDbId.textContent = db.id;
    termMeta.textContent = db.endpoint
      ? "Control plane proxy to " + db.endpoint
      : "Control plane proxy. Paste the instance token to send commands.";
    termTokenWrap.hidden = !!instanceToken();
    if (instanceToken()) { termToken.value = instanceToken(); }
    termCommand.disabled = false;
    termSend.disabled = false;
    setTerminalState("ready");
    transcript = [bannerHTML(), "", esc("database " + db.id)];
    paintTerminal();
  }

  function execRequest(command) {
    var ctl = new AbortController();
    var timer = setTimeout(function () { ctl.abort(); }, 60000);
    var token = instanceToken();
    return fetch(API + "/databases/" + encodeURIComponent(currentDb.id) + "/exec", {
      method: "POST",
      signal: ctl.signal,
      headers: {
        "content-type": "application/json",
        "Authorization": "Bearer " + token
      },
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
    if (!currentDb || !currentDb.id) { return; }
    if (/[\r\n]/.test(command)) {
      writeTerminal(["asmdb> " + command, "[ERR] command must be a single line", ""]);
      return;
    }
    command = command.trim();
    if (!command) { return; }
    var token = instanceToken();
    if (!token) {
      termTokenWrap.hidden = false;
      termToken.focus();
      writeTerminal(["[ERR] paste the instance token before running a command", ""]);
      return;
    }
    rememberInstanceToken(token);
    history.push(command);
    historyAt = history.length;
    termCommand.value = "";
    termCommand.disabled = true;
    termSend.disabled = true;
    setTerminalState("running");
    writeTerminal(["asmdb> " + command]);
    var wake = setTimeout(function () {
      setTerminalState("waking");
      writeTerminal(["waking the instance…"]);
    }, 1200);
    execRequest(command)
      .then(function (d) {
        clearTimeout(wake);
        setTerminalState(d.ok === false ? "engine error" : "ready");
        writeTerminal((d.output || []).concat([""]));
        if (/^(INSERT|UPDATE|DELETE|TRUNCATE|SELECT|COUNT)\b/i.test(command)) {
          loadPreview();
          refreshSelectedStats();
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
    var lines = [
      '<span class="ok">[ OK ]</span> database created\n',
      '<span class="k">id       </span> ' + esc(d.id),
      '<span class="k">name     </span> ' + esc(d.name),
      '<span class="k">tier     </span> ' + esc(d.tier),
      '<span class="k">state    </span> ' + esc(d.state),
      '<span class="k">endpoint </span> ' + esc(d.endpoint),
      "",
      '<span class="k">token    </span> ' + esc(d.token),
      '<span class="err">          shown once — put it in a secret manager now</span>'
    ];
    say(lines.join("\n"), "ok");
    var existing = findDb(d.id);
    if (existing) { Object.assign(existing, d); }
    else { databases.unshift(d); }
    selectDatabase(d);
    loadDatabases({ selectFirst: false });
  }

  function fail(e) {
    if (e.code === "not_signed_in") {
      showSignedOut("Not signed in.", "Sign in with Microsoft before using the console.", "");
      return;
    }
    if (e.code === "forbidden") {
      say('<span class="err">[ERR]</span> forbidden\n      signed in, but not a member of ' + ADMIN_GROUP, "error");
      return;
    }
    if (e.code === "api_unreachable") {
      say('<span class="err">[ERR]</span> api_unreachable\n      signed in, but the control plane API is unreachable', "error");
      return;
    }
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
    })
      .then(renderCreated)
      .catch(fail)
      .then(function () { busy(false, createBtn); });
  });

  listBtn.addEventListener("click", function () {
    busy(true, listBtn, "loading…");
    loadDatabases({ selectFirst: true })
      .then(function () { busy(false, listBtn); });
  });

  databaseList.addEventListener("click", function (e) {
    var button = e.target.closest("[data-db-id]");
    if (!button) { return; }
    var db = findDb(button.getAttribute("data-db-id"));
    if (db) { selectDatabase(db); }
  });

  authSignIn.addEventListener("click", signIn);
  authSignOut.addEventListener("click", signOut);

  termForm.addEventListener("submit", function (e) {
    e.preventDefault();
    runTerminalCommand(termCommand.value);
  });

  termToken.addEventListener("change", function () {
    var token = termToken.value.trim();
    if (token) {
      rememberInstanceToken(token);
      termTokenWrap.hidden = true;
      loadPreview();
    }
  });

  termCommand.addEventListener("keydown", function (e) {
    if (e.key === "ArrowUp") {
      if (history.length) {
        e.preventDefault();
        historyAt = Math.max(0, historyAt - 1);
        termCommand.value = history[historyAt] || "";
      }
    } else if (e.key === "ArrowDown") {
      if (history.length) {
        e.preventDefault();
        historyAt = Math.min(history.length, historyAt + 1);
        termCommand.value = history[historyAt] || "";
      }
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
      document.getElementById("create").scrollIntoView({ behavior: "smooth", block: "start" });
      nameEl.focus();
    });
  });

  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "hidden") { stopPolling(); }
    else if (auth.account) { loadDatabases({ selectFirst: false }).then(startPolling); }
  });

  renderDatabases();
  showTerminal(null);
  showSignedOut("Loading sign-in configuration…", "The public site remains available while the console checks Entra configuration.", "");
  fetchConfig().then(initAuth).catch(authInitFailed);
})();

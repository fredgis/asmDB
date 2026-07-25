// asmdb Cloud — provisioning console.
//
// Talks to the control plane at the same origin. Every identifier and value
// stays a string end to end: a u64 key and an i64 value do not survive a
// JavaScript number, and rounding someone's primary key is not a trade-off.

(function () {
  "use strict";

  var API = "/api/v1";
  var ADMIN_GROUP = "ASMDB_ADMIN";
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
  var currentDb = null;
  var transcript = [];
  var history = [];
  var historyAt = 0;
  var auth = { config: null, client: null, account: null, ready: false };

  function esc(s) {
    return String(s).replace(/[&<>]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c];
    });
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
    authPanel.hidden = false;
    consoleApp.hidden = true;
    setAuthPanel(status || "Not signed in.", detail || "Sign in to create databases and open the CLI.", state);
  }

  function showSignedIn() {
    authPanel.hidden = true;
    consoleApp.hidden = false;
    authUser.textContent = (auth.account && (auth.account.name || auth.account.username)) || "Microsoft account";
    say("Ready. Pick a tier and press create.");
  }

  function busy(on, btn, label) {
    createBtn.disabled = on;
    listBtn.disabled = on;
    if (btn) { btn.textContent = on ? label : btn.dataset.label; }
  }

  [createBtn, listBtn, authSignIn, authSignOut].forEach(function (b) { b.dataset.label = b.textContent; });

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

  function setTerminalState(text) {
    termState.textContent = text;
  }

  function paintTerminal() {
    termScreen.textContent = transcript.join("\n");
    termScreen.scrollTop = termScreen.scrollHeight;
  }

  function writeTerminal(lines) {
    Array.prototype.push.apply(transcript, lines);
    if (transcript.length > 600) {
      transcript = transcript.slice(transcript.length - 600);
    }
    paintTerminal();
  }

  function showTerminal(d) {
    currentDb = {
      id: d.id,
      endpoint: d.endpoint || "",
      token: d.token || (currentDb && currentDb.id === d.id && currentDb.token) || ""
    };
    term.hidden = false;
    termDbId.textContent = currentDb.id;
    termMeta.textContent = currentDb.endpoint
      ? "Control plane proxy to " + currentDb.endpoint
      : "Control plane proxy. Paste the instance token to send commands.";
    termTokenWrap.hidden = !!currentDb.token;
    if (currentDb.token) {
      termToken.value = currentDb.token;
    }
    transcript = [
      "asmdb browser CLI",
      "database " + currentDb.id,
      "",
      "Try HELP, COUNT, SELECT *, or INSERT 1 5 tag some text."
    ];
    paintTerminal();
  }

  function execRequest(command) {
    var ctl = new AbortController();
    var timer = setTimeout(function () { ctl.abort(); }, 60000);
    var token = currentDb && (currentDb.token || termToken.value.trim());
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
    if (!currentDb || !currentDb.id) {
      return;
    }
    if (/[\r\n]/.test(command)) {
      writeTerminal(["asmdb> " + command, "[ERR] command must be a single line", ""]);
      return;
    }
    command = command.trim();
    if (!command) {
      return;
    }
    var token = currentDb.token || termToken.value.trim();
    if (!token) {
      termTokenWrap.hidden = false;
      termToken.focus();
      writeTerminal(["[ERR] paste the instance token before running a command", ""]);
      return;
    }
    currentDb.token = token;
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
    var lines = [
      '<span class="ok">[ OK ]</span> database created\n',
      '<span class="k">id       </span> ' + esc(d.id),
      '<span class="k">name     </span> ' + esc(d.name),
      '<span class="k">tier     </span> ' + esc(d.tier),
      '<span class="k">state    </span> ' + esc(d.state),
      '<span class="k">endpoint </span> ' + esc(d.endpoint),
      "",
      '<span class="k">token    </span> ' + esc(d.token),
      '<span class="err">          shown once — copy it now, it is stored hashed</span>',
      "",
      '<span class="k">try it</span>',
      "  curl " + esc(d.endpoint) + "/health",
      "",
      '  curl -X POST ' + esc(d.endpoint) + '/v1/rows \\',
      '    -H "Authorization: Bearer ' + esc(d.token) + '" \\',
      "    -H \"content-type: application/json\" \\",
      "    -d '{\"id\":\"1\",\"value\":\"42\",\"tag\":\"hello\",\"content\":\"first row\"}'",
      "",
      '<span class="k">mcp endpoint</span> ' + esc(d.endpoint) + "/mcp"
    ];
    say(lines.join("\n"), "ok");
    showTerminal(d);
  }

  function renderList(d) {
    var dbs = (d && d.databases) || [];
    if (!dbs.length) {
      say('<span class="ok">[ OK ]</span> no databases yet', "ok");
      return;
    }
    var rows = dbs.map(function (x) {
      return "  " + esc(x.id) + "  " +
             esc((x.name + "                    ").slice(0, 20)) + "  " +
             esc((x.tier + "        ").slice(0, 9)) + "  " +
             esc(x.state) + "\n    " + esc(x.endpoint);
    });
    say('<span class="ok">[ OK ]</span> ' + dbs.length + " database(s)\n\n" + rows.join("\n\n"), "ok");
    showTerminal(dbs[0]);
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
    request("/databases", { method: "GET" })
      .then(renderList)
      .catch(fail)
      .then(function () { busy(false, listBtn); });
  });

  authSignIn.addEventListener("click", signIn);
  authSignOut.addEventListener("click", signOut);

  termForm.addEventListener("submit", function (e) {
    e.preventDefault();
    runTerminalCommand(termCommand.value);
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

  // Tier buttons scroll to the console and preselect.
  Array.prototype.forEach.call(document.querySelectorAll("[data-tier]"), function (b) {
    b.addEventListener("click", function () {
      tierEl.value = b.getAttribute("data-tier");
      document.getElementById("create").scrollIntoView({ behavior: "smooth", block: "start" });
      nameEl.focus();
    });
  });

  showSignedOut("Loading sign-in configuration…", "The public site remains available while the console checks Entra configuration.", "");
  fetchConfig().then(initAuth).catch(authInitFailed);
})();
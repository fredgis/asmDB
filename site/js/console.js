// asmdb Cloud — provisioning console.
//
// Talks to the control plane at the same origin. Every identifier and value
// stays a string end to end: a u64 key and an i64 value do not survive a
// JavaScript number, and rounding someone's primary key is not a trade-off.

(function () {
  "use strict";

  var API = "/api/v1";
  var out = document.getElementById("db-out");
  var nameEl = document.getElementById("db-name");
  var tierEl = document.getElementById("db-tier");
  var createBtn = document.getElementById("db-create");
  var listBtn = document.getElementById("db-list");

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

  function busy(on, btn, label) {
    createBtn.disabled = on;
    listBtn.disabled = on;
    if (btn) { btn.textContent = on ? label : btn.dataset.label; }
  }

  [createBtn, listBtn].forEach(function (b) { b.dataset.label = b.textContent; });

  function request(path, options) {
    var ctl = new AbortController();
    var timer = setTimeout(function () { ctl.abort(); }, 30000);
    options = options || {};
    options.signal = ctl.signal;
    return fetch(API + path, options)
      .then(function (r) {
        clearTimeout(timer);
        return r.text().then(function (body) {
          var data = null;
          try { data = body ? JSON.parse(body) : null; } catch (e) { /* not json */ }
          if (!r.ok) {
            var msg = (data && data.error && data.error.message) || body || (r.status + " " + r.statusText);
            var err = new Error(msg);
            err.code = (data && data.error && data.error.code) || "http_" + r.status;
            throw err;
          }
          return data;
        });
      })
      .catch(function (e) {
        clearTimeout(timer);
        if (e.name === "AbortError") {
          var t = new Error("the control plane did not answer within 30 seconds");
          t.code = "timeout";
          throw t;
        }
        throw e;
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
  }

  function fail(e) {
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

  // Tier buttons scroll to the console and preselect.
  Array.prototype.forEach.call(document.querySelectorAll("[data-tier]"), function (b) {
    b.addEventListener("click", function () {
      tierEl.value = b.getAttribute("data-tier");
      document.getElementById("create").scrollIntoView({ behavior: "smooth", block: "start" });
      nameEl.focus();
    });
  });
})();

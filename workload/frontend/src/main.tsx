import { bootstrap } from "@ms-fabric/workload-client";
import { CLOSE_REDIRECT_PATH, SYNC_HUB_EDITOR_PATH, isKnownFrontendPath } from "./workload-constants";

console.log(`[asmDB Analytical Capabilities] Build: ${__BUILD_TIMESTAMP__}`);

function renderCloseFallback() {
  const root = document.getElementById("root");
  const message = "Authentication completed. You can close this window.";
  if (root) {
    root.innerHTML = `<main role="status" style="padding:20px;font-family:system-ui,sans-serif">${message}</main>`;
  } else {
    document.body.textContent = message;
  }
}

function start() {
  const url = new URL(window.location.href);

  if (!isKnownFrontendPath(url.pathname)) {
    console.warn(
      `Unexpected asmDB workload path "${url.pathname}". Expected /, ${SYNC_HUB_EDITOR_PATH}, or ${CLOSE_REDIRECT_PATH}. ` +
        "If Fabric opens a blank editor, verify SyncHubItem.json editor.path and the static host fallback."
    );
  }

  if (url.pathname.startsWith(CLOSE_REDIRECT_PATH)) {
    if (url.hash?.includes("error")) {
      console.error("Authentication error:", url.hash);
    }
    renderCloseFallback();
    window.close();
    return;
  }

  if (window.top === window.self && import.meta.env.DEV) {
    void import("./standalone").then(({ renderStandalone }) => renderStandalone());
    return;
  }

  bootstrap({
    initializeWorker: (params) =>
      import("./index.worker")
        .then(({ initialize }) => initialize(params))
        .catch((error) => console.error("Worker init failed:", error)),
    initializeUI: (params) =>
      import("./index.ui")
        .then(({ initialize }) => initialize(params))
        .catch((error) => {
          console.error("UI init failed:", error);
          const root = document.getElementById("root");
          if (root) {
            root.innerHTML = `<div role="alert" style="padding:20px;font-family:monospace"><h2>asmDB UI init error</h2><pre>${error.message}\n${error.stack}</pre></div>`;
          }
        }),
  });
}

start();



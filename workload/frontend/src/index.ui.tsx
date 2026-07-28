import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserHistory } from "history";
import { FluentProvider, RendererProvider, createDOMRenderer } from "@fluentui/react-components";
import { createWorkloadClient, InitParams } from "@ms-fabric/workload-client";
import App from "./App";
import { WorkloadProvider } from "./context/WorkloadContext";
import { ThemePreferenceProvider, type ThemePreference } from "./context/ThemePreferenceContext";
import { readHostTheme, subscribeHostTheme } from "./theme/hostTheme";
import { HostThemeName, themeForHost } from "./theme/asmdbTheme";

const renderer = createDOMRenderer();
const THEME_PREFERENCE_KEY = "asmdb.themePreference";

function readStoredThemePreference(): ThemePreference {
  try {
    const value = window.localStorage.getItem(THEME_PREFERENCE_KEY);
    return value === "light" || value === "dark" || value === "auto" ? value : "dark";
  } catch {
    return "dark";
  }
}

function writeStoredThemePreference(preference: ThemePreference) {
  try {
    window.localStorage.setItem(THEME_PREFERENCE_KEY, preference);
  } catch {
    // Cross-origin Fabric iframes may have storage blocked; the in-memory state is enough for this session.
  }
}

export function ThemedRoot({ workloadClient }: { workloadClient: ReturnType<typeof createWorkloadClient> | null }) {
  const [hostTheme, setHostTheme] = useState<HostThemeName>("light");
  const [preference, setPreferenceState] = useState<ThemePreference>(() => readStoredThemePreference());
  const effectiveTheme = preference === "auto" ? hostTheme : preference;

  function setPreference(preference: ThemePreference) {
    setPreferenceState(preference);
    writeStoredThemePreference(preference);
  }

  useEffect(() => {
    let cancelled = false;
    void readHostTheme(workloadClient).then((theme) => {
      if (!cancelled) setHostTheme(theme);
    });
    const unsubscribe = subscribeHostTheme(workloadClient, (theme) => setHostTheme(theme));
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [workloadClient]);

  return (
    <RendererProvider renderer={renderer}>
      <FluentProvider theme={themeForHost(effectiveTheme)} className={`fabricTheme fabricTheme-${effectiveTheme}`}>
        <ThemePreferenceProvider value={{ preference, hostTheme, effectiveTheme, setPreference }}>
          <WorkloadProvider workloadClient={workloadClient}>
            <App />
          </WorkloadProvider>
        </ThemePreferenceProvider>
      </FluentProvider>
    </RendererProvider>
  );
}

export async function initialize(params: InitParams) {
  console.log("asmDB UI initialization", params);
  const workloadClient = createWorkloadClient();
  const history = createBrowserHistory();

  workloadClient.navigation.onNavigate((route) => {
    if (route.workspaceObjectIdHint) {
      try {
        window.sessionStorage.setItem("asmdb.workspaceObjectIdHint", route.workspaceObjectIdHint);
      } catch {
        // Storage can be refused in cross-origin iframes; route parsing still works without this hint.
      }
    }
    history.replace(route.targetUrl);
  });

  workloadClient.action.onAction(async ({ action }) => {
    switch (action) {
      case "item.tab.onInit":
        return { title: "asmDB Analytical Capabilities" };
      case "item.tab.canDeactivate":
        return { canDeactivate: true };
      case "item.tab.onDeactivate":
      case "item.tab.onDestroy":
      case "item.tab.onDelete":
        return {};
      case "item.tab.canDestroy":
        return { canDestroy: true };
      default:
        return {};
    }
  });

  const rootElement = document.getElementById("root");
  if (!rootElement) {
    document.body.innerHTML = "<div role='alert'>Root element not found.</div>";
    return;
  }

  createRoot(rootElement).render(<ThemedRoot workloadClient={workloadClient} />);
}

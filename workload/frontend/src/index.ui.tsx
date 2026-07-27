import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserHistory } from "history";
import { FluentProvider, RendererProvider, createDOMRenderer } from "@fluentui/react-components";
import { createWorkloadClient, InitParams } from "@ms-fabric/workload-client";
import App from "./App";
import { WorkloadProvider } from "./context/WorkloadContext";
import { readHostTheme, subscribeHostTheme } from "./theme/hostTheme";
import { HostThemeName, themeForHost } from "./theme/asmdbTheme";

const renderer = createDOMRenderer();

export function ThemedRoot({ workloadClient }: { workloadClient: ReturnType<typeof createWorkloadClient> | null }) {
  const [hostTheme, setHostTheme] = useState<HostThemeName>("light");

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
      <FluentProvider theme={themeForHost(hostTheme)} className={`fabricTheme fabricTheme-${hostTheme}`}>
        <WorkloadProvider workloadClient={workloadClient}>
          <App />
        </WorkloadProvider>
      </FluentProvider>
    </RendererProvider>
  );
}

export async function initialize(params: InitParams) {
  console.log("asmDB UI initialization", params);
  const workloadClient = createWorkloadClient();
  const history = createBrowserHistory();

  workloadClient.navigation.onNavigate((route) => {
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


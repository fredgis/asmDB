import type { ThemeConfiguration, WorkloadClientAPI } from "@ms-fabric/workload-client";
import type { HostThemeName } from "./asmdbTheme";
import { hostThemeToName } from "./asmdbTheme";

type ThemeListener = (theme: HostThemeName) => void;

type HostThemeApi = {
  get?: () => Promise<ThemeConfiguration> | ThemeConfiguration;
  onChange?: (handler: (theme: ThemeConfiguration) => void) => (() => void) | { dispose?: () => void } | void;
};

function getThemeApi(workloadClient: WorkloadClientAPI | null): HostThemeApi | null {
  const candidate = (workloadClient as unknown as { theme?: HostThemeApi } | null)?.theme;
  return candidate ?? null;
}

export async function readHostTheme(
  workloadClient: WorkloadClientAPI | null
): Promise<HostThemeName> {
  const api = getThemeApi(workloadClient);
  if (!api?.get) return "light";

  try {
    return hostThemeToName(await api.get());
  } catch (error) {
    console.warn("Failed to read Fabric host theme", error);
    return "light";
  }
}

export function subscribeHostTheme(
  workloadClient: WorkloadClientAPI | null,
  listener: ThemeListener
): () => void {
  const api = getThemeApi(workloadClient);
  if (!api?.onChange) return () => undefined;

  try {
    const disposable = api.onChange((value) => listener(hostThemeToName(value)));
    if (typeof disposable === "function") return disposable;
    if (disposable?.dispose) return () => disposable.dispose?.();
  } catch (error) {
    console.warn("Failed to subscribe to Fabric host theme", error);
  }
  return () => undefined;
}

import { createRoot } from "react-dom/client";
import { ThemedRoot } from "./index.ui";

export function renderStandalone() {
  const root = document.getElementById("root");
  if (!root) return;

  const fakeWorkloadClient = {
    auth: { acquireAccessToken: async () => ({ token: undefined }) },
    theme: {
      get: async () => ({ theme: "light" }),
      onChange: (handler: (theme: unknown) => void) => {
        const listener = (event: Event) => handler((event as CustomEvent).detail);
        window.addEventListener("fabric-theme-change", listener);
        return () => window.removeEventListener("fabric-theme-change", listener);
      },
    },
  };

  createRoot(root).render(<ThemedRoot workloadClient={fakeWorkloadClient as never} />);
}

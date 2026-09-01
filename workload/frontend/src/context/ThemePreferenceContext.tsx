import { createContext, useContext } from "react";
import type { HostThemeName } from "../theme/asmdbTheme";

export type ThemePreference = "auto" | HostThemeName;

interface ThemePreferenceContextType {
  preference: ThemePreference;
  hostTheme: HostThemeName;
  effectiveTheme: HostThemeName;
  setPreference: (preference: ThemePreference) => void;
}

const ThemePreferenceContext = createContext<ThemePreferenceContextType>({
  preference: "light",
  hostTheme: "light",
  effectiveTheme: "light",
  setPreference: () => undefined,
});

export const ThemePreferenceProvider = ThemePreferenceContext.Provider;

export function useThemePreference() {
  return useContext(ThemePreferenceContext);
}

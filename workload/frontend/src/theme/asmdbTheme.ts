import {
  fabricDarkTheme,
  fabricLightTheme,
  type FabricTheme,
} from "@fabric-msft/theme";

export type HostThemeName = "light" | "dark";

export function hostThemeToName(value: { colorScheme?: string; name?: string } | unknown): HostThemeName {
  const theme = value as { colorScheme?: string; name?: string } | null;
  const colorScheme = theme?.colorScheme?.toLowerCase();
  if (colorScheme === "dark") return "dark";
  if (colorScheme === "light") return "light";

  const name = theme?.name?.toLowerCase() ?? "";
  return name.includes("dark") ? "dark" : "light";
}

export function themeForHost(name: HostThemeName): FabricTheme {
  return name === "dark" ? fabricDarkTheme : fabricLightTheme;
}

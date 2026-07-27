import {
  BrandVariants,
  createDarkTheme,
  createLightTheme,
  Theme,
} from "@fluentui/react-components";

export const asmdbBrand: BrandVariants = {
  10: "oklch(13% 0.028 265)",
  20: "oklch(18% 0.04 257)",
  30: "oklch(24% 0.055 249)",
  40: "oklch(31% 0.07 241)",
  50: "oklch(39% 0.085 233)",
  60: "oklch(47% 0.10 225)",
  70: "oklch(55% 0.115 217)",
  80: "oklch(63% 0.13 211)",
  90: "oklch(70% 0.14 207)",
  100: "oklch(82% 0.145 205)",
  110: "oklch(78% 0.155 222)",
  120: "oklch(75% 0.165 239)",
  130: "oklch(73% 0.175 257)",
  140: "oklch(71% 0.185 275)",
  150: "oklch(70% 0.19 292)",
  160: "oklch(62% 0.18 292)",
};

export const asmdbLightTheme: Theme = {
  ...createLightTheme(asmdbBrand),
  fontFamilyBase: "var(--asmdb-font-body)",
  fontFamilyMonospace: "var(--asmdb-font-mono)",
  fontFamilyNumeric: "var(--asmdb-font-mono)",
};

export const asmdbDarkTheme: Theme = {
  ...createDarkTheme(asmdbBrand),
  fontFamilyBase: "var(--asmdb-font-body)",
  fontFamilyMonospace: "var(--asmdb-font-mono)",
  fontFamilyNumeric: "var(--asmdb-font-mono)",
};

export type HostThemeName = "light" | "dark";

export function hostThemeToName(value: { colorScheme?: string; name?: string } | unknown): HostThemeName {
  const theme = value as { colorScheme?: string; name?: string } | null;
  const colorScheme = theme?.colorScheme?.toLowerCase();
  if (colorScheme === "dark") return "dark";
  if (colorScheme === "light") return "light";

  const name = theme?.name?.toLowerCase() ?? "";
  return name.includes("dark") ? "dark" : "light";
}

export function themeForHost(name: HostThemeName): Theme {
  return name === "dark" ? asmdbDarkTheme : asmdbLightTheme;
}


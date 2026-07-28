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

const paper = "oklch(13% 0.028 265)";
const paper2 = "oklch(16.5% 0.032 265)";
const paper3 = "oklch(21% 0.038 265)";
const paper4 = "oklch(26% 0.042 265)";
const ink = "oklch(96% 0.008 265)";
const ink2 = "oklch(74% 0.018 265)";
const ink3 = "oklch(58% 0.022 265)";
const rule = "oklch(26% 0.03 265)";
const rule2 = "oklch(34% 0.035 265)";
const accent = "oklch(82% 0.145 205)";

export const asmdbDarkTheme: Theme = {
  ...createDarkTheme(asmdbBrand),
  fontFamilyBase: "var(--asmdb-font-body)",
  fontFamilyMonospace: "var(--asmdb-font-mono)",
  fontFamilyNumeric: "var(--asmdb-font-mono)",
  colorNeutralBackground1: paper,
  colorNeutralBackground1Hover: paper2,
  colorNeutralBackground1Pressed: paper3,
  colorNeutralBackground1Selected: paper2,
  colorNeutralBackground2: paper2,
  colorNeutralBackground2Hover: paper3,
  colorNeutralBackground2Pressed: paper4,
  colorNeutralBackground2Selected: paper3,
  colorNeutralBackground3: paper3,
  colorNeutralBackground3Hover: paper4,
  colorNeutralBackground3Pressed: paper4,
  colorNeutralBackground3Selected: paper4,
  colorNeutralBackground4: paper4,
  colorNeutralBackground4Hover: paper3,
  colorNeutralBackground4Pressed: paper2,
  colorNeutralBackground4Selected: paper3,
  colorNeutralBackground5: paper4,
  colorNeutralBackground5Hover: paper3,
  colorNeutralBackground5Pressed: paper2,
  colorNeutralBackground5Selected: paper3,
  colorNeutralBackground6: paper3,
  colorNeutralBackgroundDisabled: paper3,
  colorNeutralCardBackground: paper2,
  colorNeutralCardBackgroundHover: paper3,
  colorNeutralCardBackgroundPressed: paper4,
  colorNeutralCardBackgroundSelected: paper3,
  colorNeutralForeground1: ink,
  colorNeutralForeground1Hover: ink,
  colorNeutralForeground1Pressed: ink,
  colorNeutralForeground1Selected: ink,
  colorNeutralForeground2: ink2,
  colorNeutralForeground2Hover: ink,
  colorNeutralForeground2Pressed: ink,
  colorNeutralForeground2Selected: ink,
  colorNeutralForeground3: ink3,
  colorNeutralForeground3Hover: ink2,
  colorNeutralForeground3Pressed: ink2,
  colorNeutralForeground3Selected: ink2,
  colorNeutralForeground4: ink3,
  colorNeutralForeground5: ink3,
  colorNeutralForegroundDisabled: "oklch(45% 0.018 265)",
  colorNeutralStroke1: rule2,
  colorNeutralStroke1Hover: "oklch(42% 0.04 265)",
  colorNeutralStroke1Pressed: rule,
  colorNeutralStroke1Selected: rule2,
  colorNeutralStroke2: rule,
  colorNeutralStroke3: paper4,
  colorNeutralStroke4: rule2,
  colorNeutralStrokeDisabled: rule,
  colorBrandBackground: accent,
  colorBrandBackgroundHover: "oklch(86% 0.14 205)",
  colorBrandBackgroundPressed: "oklch(74% 0.145 205)",
  colorBrandBackgroundSelected: "oklch(78% 0.145 205)",
  colorNeutralForegroundOnBrand: paper,
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

import type { DesignToken, TokenKind } from "./schema.js";

export type { DesignToken, TokenKind } from "./schema.js";
export type Source = { path: string; kind: "tailwind" | "css" | "dtcg" };
export type ExtractedToken = DesignToken & {
  cascade?: string | undefined;
  context?: string | undefined;
  formatType?: string | undefined;
  resolved?: string | undefined;
  reason?: string | undefined;
  notes?: string[] | undefined;
  default?: boolean | undefined;
  base?: boolean | undefined;
  environment?: Record<string, string> | undefined;
};
export type Extraction = {
  sources: Source[];
  tokens: ExtractedToken[];
  diagnostics: string[];
};
export type NormalizedValue = {
  value?: string | undefined;
  px?: number | undefined;
  reason?: string | undefined;
};
export type NormalizationInput = {
  value: string;
  kind: TokenKind;
  environment?: Record<string, string> | undefined;
  rootFontSize?: number | undefined;
  scheme?: "light" | "dark" | undefined;
};

import {
  type CopyConfig,
  type CopyPolicy,
  copyConfigSchema,
} from "./schemas/project.js";

export function normalizeCopyTerm(term: string): string {
  return term.replace(/\s+/gu, " ").trim();
}

export function copyTermKey(term: string): string {
  return normalizeCopyTerm(term).toLowerCase();
}

/** Later declarations win, including project entries after file entries. */
export function mergeCopyTerms<T extends { term: string }>(
  ...sources: (readonly T[] | undefined)[]
): T[] {
  const entries = new Map<string, T>();
  for (const source of sources)
    for (const entry of source ?? [])
      entries.set(copyTermKey(entry.term), {
        ...entry,
        term: normalizeCopyTerm(entry.term),
      });
  return [...entries.values()];
}

export function mergeCopyPolicy(
  file: CopyPolicy = {},
  project: CopyPolicy = {},
): CopyConfig {
  return copyConfigSchema.parse({
    locale: project.locale ?? file.locale,
    glossary: mergeCopyTerms(file.glossary, project.glossary),
    retired: mergeCopyTerms(file.retired, project.retired),
    jargon: mergeCopyTerms(file.jargon, project.jargon),
    schemaWords: [
      ...new Set([...(file.schemaWords ?? []), ...(project.schemaWords ?? [])]),
    ],
    properNouns: [
      ...new Set([...(file.properNouns ?? []), ...(project.properNouns ?? [])]),
    ],
  });
}

/**
 * Action names the automated interaction probe never clicks, because the
 * click would destroy, publish, pay or end a session rather than reveal
 * behaviour. Quick review counts these skips in its report.
 */
export const DESTRUCTIVE_ACTION_PATTERN =
  /\b(delete|remove|sign ?out|log ?out|publish|unpublish|reset|discard|clear all|archive|deactivate|unsubscribe|pay|purchase|buy|checkout|send|submit order)\b/i;

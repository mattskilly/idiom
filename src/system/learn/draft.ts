import { randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { fileDiff } from "../../learn/diff.js";
import { appendJsonArrayItem } from "../../learn/json-edit.js";
import type { BrowserLaunch } from "../../learn/target.js";
import { projectSchema } from "../../schemas/project.js";
import { normalizeInBrowser } from "./normalize.js";
import { type DesignToken, tokenIdentity } from "./schema.js";
import type {
  Extraction,
  NormalizationInput,
  NormalizedValue,
} from "./types.js";

export type SystemDraft = {
  before: string;
  after: string;
  diff: string;
  summary: string[];
  extraction: Extraction;
};
export async function draftSystemLearning(
  before: string,
  extraction: Extraction,
  options: {
    rootFontSizes?: number[] | undefined;
    launch?: BrowserLaunch | undefined;
  } = {},
): Promise<SystemDraft> {
  const raw = JSON.parse(before);
  projectSchema.parse(raw);
  const summary = extraction.sources.map((s) => `${s.kind}: ${s.path}`);
  const candidates = extraction.tokens.filter((token) => !token.default);
  for (const path of new Set(
    extraction.tokens
      .filter((token) => token.default)
      .map((token) => token.source.path),
  )) {
    const count = extraction.tokens.filter(
      (token) => token.default && token.source.path === path,
    ).length;
    summary.push(
      `${path}: omitted ${count} inherited Tailwind defaults; only project-declared theme entries are proposed.`,
    );
  }
  const roots = [...new Set(options.rootFontSizes ?? [])];
  if (roots.length === 0)
    summary.push(
      "No recorded root font size: numeric rem scales assume 16px. Legacy captures have no rem drift coverage.",
    );
  if (roots.length > 1)
    summary.push(
      `Captured root sizes differ (${roots.join(", ")}px); incompatible rem values are retained as tokens and excluded from numeric scales.`,
    );
  if (candidates.some((t) => t.theme !== undefined))
    summary.push(
      "Global scales union theme variants; token drift compares only applicable themes.",
    );
  const inputs: NormalizationInput[] = [];
  for (const token of candidates)
    for (const rootFontSize of roots.length ? roots : [16])
      inputs.push({
        value: token.resolved ?? token.value,
        kind: token.kind,
        environment: token.environment,
        rootFontSize,
        scheme: token.theme === "dark" ? "dark" : "light",
      });
  const normalized = inputs.length
    ? await normalizeInBrowser(inputs, options.launch)
    : [];
  let after = before;
  const append = (path: string[], value: unknown) => {
    const current = path.reduce<unknown>(
      (object, key) => (object as Record<string, unknown> | undefined)?.[key],
      JSON.parse(after),
    );
    if (
      Array.isArray(current) &&
      current.some((v) => JSON.stringify(v) === JSON.stringify(value))
    )
      return;
    const edited = appendJsonArrayItem(after, path, value);
    if (edited === undefined)
      throw new Error(`Cannot preserve JSON formatting at ${path.join(".")}`);
    after = edited;
  };
  const existing: DesignToken[] = raw.design?.tokens ?? [];
  for (const [index, token] of candidates.entries()) {
    const prior = existing.find(
      (t) => tokenIdentity(t) === tokenIdentity(token),
    );
    if (prior && (prior.value !== token.value || prior.kind !== token.kind)) {
      summary.push(`Preserved existing token ${token.name}: ${prior.value}`);
      continue;
    }
    const persisted: DesignToken = {
      name: token.name,
      value: token.value,
      kind: token.reason ? "other" : token.kind,
      source: token.source,
      ...(token.theme === undefined ? {} : { theme: token.theme }),
    };
    if (!prior) append(["design", "tokens"], persisted);
    const count = roots.length || 1;
    const values = normalized.slice(index * count, index * count + count);
    const value: NormalizedValue | undefined = values[0];
    if (
      token.reason ||
      !value?.value ||
      values.some((v) => v.value !== value.value)
    ) {
      summary.push(
        `${token.source.path}:${token.name}: ${token.reason ?? value?.reason ?? "Incompatible root-size conversions"}`,
      );
      continue;
    }
    if (token.kind === "spacing" && value.px !== undefined)
      append(
        ["checks", "scales", "spacing"],
        token.base && value.px > 0 ? { multipleOf: value.px } : value.px,
      );
    else if (
      token.kind === "control-height" &&
      value.px !== undefined &&
      value.px > 0
    )
      append(["checks", "scales", "controlHeights"], value.px);
    else if (token.kind === "radius") {
      const role =
        /(?:^|[.\-_])(control|button|input|card|panel|chip)(?:$|[.\-_])/i
          .exec(token.name)?.[1]
          ?.toLowerCase();
      const roles = role
        ? [role === "button" || role === "input" ? "control" : role]
        : ["control", "card", "panel", "chip"];
      for (const role of roles)
        append(
          ["checks", "scales", "radius", role],
          value.value === "full" ? "full" : value.px,
        );
    } else if (token.kind === "color")
      for (const role of ["control", "divider"])
        append(["checks", "scales", "border", role], value.value);
    if (token.notes?.length)
      summary.push(`${token.name}: ${token.notes.join("; ")}`);
  }
  for (const kind of ["spacing", "radius", "control-height", "color"])
    if (!candidates.some((t) => t.kind === kind && !t.reason))
      summary.push(`${kind}: no supported declarations; scale unchanged.`);
  projectSchema.parse(JSON.parse(after));
  return {
    before,
    after,
    diff:
      before === after ? "" : fileDiff(".idiom/project.json", before, after),
    summary,
    extraction,
  };
}

export async function applySystemDraft(
  path: string,
  draft: SystemDraft,
  publish: typeof rename = rename,
): Promise<void> {
  if ((await readFile(path, "utf8")) !== draft.before)
    throw new Error(
      "Project configuration changed after preview; rerun idiom system --learn.",
    );
  const entry = await lstat(path);
  if (!entry.isFile() || entry.isSymbolicLink())
    throw new Error("Project configuration must be a regular file");
  const temporary = `${path}.idiom-${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, draft.after, { encoding: "utf8", flag: "wx" });
    await chmod(temporary, entry.mode);
    if ((await readFile(path, "utf8")) !== draft.before)
      throw new Error(
        "Project configuration changed after preview; rerun idiom system --learn.",
      );
    await publish(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

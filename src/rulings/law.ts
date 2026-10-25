import { IdiomError } from "../errors.js";
import type { RulingResolution } from "../schemas/ruling.js";
import { rulingResolutionSchema } from "../schemas/ruling.js";

export const RULING_START = "<!-- idiom:ruling:start -->";
export const RULING_END = "<!-- idiom:ruling:end -->";
const METADATA_PREFIX = "<!-- idiom:ruling:metadata ";

export type ParsedDesignLaw = {
  prose: string;
  resolutions: RulingResolution[];
};

function corrupt(message: string): never {
  throw new IdiomError(`malformed recorded ruling block: ${message}`);
}

export function renderRulingBlock(
  resolution: RulingResolution,
  eol = "\n",
): string {
  const parsed = rulingResolutionSchema.parse(resolution);
  const human =
    parsed.outcome === "rule"
      ? (parsed.wording as string)
      : "No rule needed — this decision is deliberately left to the surface.";
  return [
    RULING_START,
    `${METADATA_PREFIX}${JSON.stringify(parsed)} -->`,
    `## Recorded ruling: ${parsed.id}`,
    "",
    human,
    ...(parsed.reason === undefined ? [] : ["", `Reason: ${parsed.reason}`]),
    RULING_END,
  ].join(eol);
}

export function parseRulingBlocks(source: string): ParsedDesignLaw {
  const first = source.indexOf(RULING_START);
  const anyMarker = source.indexOf("<!-- idiom:ruling:");
  if (first < 0) {
    if (anyMarker >= 0) corrupt("found a ruling marker without a start marker");
    return { prose: source, resolutions: [] };
  }
  if (anyMarker !== first)
    corrupt("found metadata or an end marker before the first start marker");

  const prefix = source.slice(0, first);
  const suffix = source.slice(first);
  const resolutions: RulingResolution[] = [];
  let cursor = 0;
  while (cursor < suffix.length) {
    if (!suffix.startsWith(RULING_START, cursor))
      corrupt("unexpected content between ruling blocks");
    const end = suffix.indexOf(RULING_END, cursor + RULING_START.length);
    if (end < 0) corrupt("missing end marker");
    const block = suffix.slice(cursor, end + RULING_END.length);
    const normalized = block.replace(/\r\n/g, "\n");
    const lines = normalized.split("\n");
    const metadata = lines[1];
    if (
      metadata === undefined ||
      !metadata.startsWith(METADATA_PREFIX) ||
      !metadata.endsWith(" -->")
    )
      corrupt("missing canonical metadata line");
    const raw = metadata.slice(METADATA_PREFIX.length, -4);
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch (error) {
      corrupt(
        `invalid metadata JSON: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const parsed = rulingResolutionSchema.safeParse(value);
    if (!parsed.success)
      corrupt(
        parsed.error.issues
          .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
          .join("; "),
      );
    if (
      normalized.slice(RULING_START.length).includes(RULING_START) ||
      normalized.slice(0, -RULING_END.length).includes(RULING_END) ||
      lines.slice(2).some((line) => line.startsWith(METADATA_PREFIX)) ||
      (normalized.match(/<!-- idiom:ruling:/g)?.length ?? 0) !== 3
    )
      corrupt("nested or duplicate markers inside a block");
    resolutions.push(parsed.data);
    cursor = end + RULING_END.length;
    const whitespace = /^\s*/.exec(suffix.slice(cursor))?.[0] ?? "";
    cursor += whitespace.length;
  }

  const ids = new Set<string>();
  const fingerprints = new Set<string>();
  for (const resolution of resolutions) {
    if (ids.has(resolution.id)) corrupt(`duplicate id ${resolution.id}`);
    if (fingerprints.has(resolution.fingerprint))
      corrupt(`duplicate fingerprint ${resolution.fingerprint}`);
    ids.add(resolution.id);
    fingerprints.add(resolution.fingerprint);
  }
  return {
    prose: prefix.replace(/(?:\r?\n){2}$/, ""),
    resolutions,
  };
}

export function appendRuling(
  source: string,
  resolution: RulingResolution,
): string {
  const parsed = parseRulingBlocks(source);
  if (
    parsed.resolutions.some(
      (item) =>
        item.id === resolution.id ||
        item.fingerprint === resolution.fingerprint,
    )
  )
    throw new IdiomError(
      `ruling ${resolution.id} has already been recorded in the design law`,
    );
  const eol = source.includes("\r\n") ? "\r\n" : "\n";
  const separator = source.endsWith(eol) ? eol : `${eol}${eol}`;
  const completed = `${source}${separator}${renderRulingBlock(resolution, eol)}${eol}`;
  parseRulingBlocks(completed);
  return completed;
}

export function rulingDiff(
  file: string,
  before: string,
  after: string,
): string {
  const added = after.slice(before.length).replace(/\r\n/g, "\n");
  return [
    `--- a/${file}`,
    `+++ b/${file}`,
    `@@ -${before.split(/\r?\n/).length},0 +${before.split(/\r?\n/).length + 1},${added.split("\n").length - 1} @@`,
    ...added
      .split("\n")
      .slice(0, -1)
      .map((line) => `+${line}`),
    "",
  ].join("\n");
}

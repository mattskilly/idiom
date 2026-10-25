import postcss from "postcss";
import type { ObservationArtifactV2 } from "../checks/types.js";
import { IdiomError } from "../errors.js";
import type { ExplorationEdit } from "../schemas/exploration.js";
import { NON_CONTENT_TAGS, normalizedText } from "../verify/profile.js";

export function normalizeCopy(value: string): string {
  return value.normalize("NFKC").replace(/\s+/gu, " ").trim();
}

function decodeHtml(value: string): string {
  return value.replace(
    /&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi,
    (match, entity: string) => {
      if (entity.toLowerCase() === "amp") return "&";
      if (entity.toLowerCase() === "lt") return "<";
      if (entity.toLowerCase() === "gt") return ">";
      if (entity.toLowerCase() === "quot") return '"';
      if (entity.toLowerCase() === "apos") return "'";
      const number = entity.toLowerCase().startsWith("#x")
        ? Number.parseInt(entity.slice(2), 16)
        : Number.parseInt(entity.slice(1), 10);
      return Number.isFinite(number) ? String.fromCodePoint(number) : match;
    },
  );
}

export function domCopyValues(source: string): string[] {
  const values: string[] = [];
  const rawTextTags = new Set(["script", "style", "textarea", "title"]);
  let cursor = 0;
  while (cursor < source.length) {
    const start = source.indexOf("<", cursor);
    if (start < 0) break;
    if (source.startsWith("<!--", start)) {
      const commentEnd = source.indexOf("-->", start + 4);
      cursor = commentEnd < 0 ? source.length : commentEnd + 3;
      continue;
    }
    const opening = /^<([A-Za-z][A-Za-z0-9:-]*)/.exec(source.slice(start));
    if (opening === null) {
      cursor = start + 1;
      continue;
    }
    let end = start + opening[0].length;
    let quote: '"' | "'" | undefined;
    while (end < source.length) {
      const character = source[end];
      if (quote !== undefined) {
        if (character === quote) quote = undefined;
      } else if (character === '"' || character === "'") quote = character;
      else if (character === ">") break;
      end += 1;
    }
    const tag = (opening[1] ?? "").toLowerCase();
    const tail = source.slice(start + opening[0].length, end);
    cursor = end < source.length ? end + 1 : source.length;
    const attributes = new Map<string, string>();
    let consumed = "";
    for (const attribute of tail.matchAll(
      /\s+([^\s"'/>=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g,
    )) {
      consumed += attribute[0];
      attributes.set(
        (attribute[1] ?? "").toLowerCase(),
        decodeHtml(attribute[2] ?? attribute[3] ?? attribute[4] ?? ""),
      );
    }
    if (
      (end >= source.length ||
        quote !== undefined ||
        tail.trim() !== consumed.trim()) &&
      /(?:placeholder|aria-placeholder|\bvalue\s*=)/i.test(tail)
    )
      throw new IdiomError(
        `malformed relevant HTML attribute in captured <${tag}>`,
      );
    for (const name of ["placeholder", "aria-placeholder"]) {
      const value = attributes.get(name);
      if (value !== undefined && normalizeCopy(value) !== "")
        values.push(value);
    }
    const type = (attributes.get("type") ?? "").toLowerCase();
    const value = attributes.get("value");
    if (
      value !== undefined &&
      (tag === "button" ||
        (tag === "input" && (type === "button" || type === "submit")))
    )
      values.push(value);
    if (rawTextTags.has(tag)) {
      const close = new RegExp(`</${tag}\\s*>`, "gi");
      close.lastIndex = cursor;
      const closing = close.exec(source);
      cursor =
        closing === null ? source.length : closing.index + closing[0].length;
    }
  }
  return values;
}

export function observationCopyValues(
  observations: ObservationArtifactV2,
): string[] {
  return observations.elements
    .filter((element) => !NON_CONTENT_TAGS.has(element.tag.toLowerCase()))
    .flatMap((element) => [
      element.directText,
      element.attributes.title ?? "",
      element.attributes.alt ?? "",
      element.attributes["aria-label"] ?? "",
    ])
    .filter((value) => normalizeCopy(value) !== "");
}

export function copyCorpus(
  observations: ObservationArtifactV2,
  dom: string,
): string {
  return normalizeCopy(
    [...observationCopyValues(observations), ...domCopyValues(dom)].join(" "),
  );
}

export function assertCandidateCopy(options: {
  baselineCorpus: string;
  observations: ObservationArtifactV2;
  dom: string;
  coordinate: string;
}): void {
  const baseline = normalizedText(options.baselineCorpus);
  for (const raw of [
    ...observationCopyValues(options.observations),
    ...domCopyValues(options.dom),
  ]) {
    const value = normalizeCopy(raw);
    if (value === "") continue;
    if (!baseline.includes(normalizedText(value)))
      throw new IdiomError(
        `candidate ${options.coordinate} introduces copy not present in the baseline: ${JSON.stringify(value)}`,
      );
  }
}

function cssContentValues(source: string): string[] {
  const root = postcss.parse(source);
  const values: string[] = [];
  root.walkDecls(/^content$/i, (declaration) => {
    values.push(declaration.value.trim());
  });
  return values;
}

function conservativeContentValues(source: string): string[] {
  return [
    ...source.matchAll(/(?:^|[,{;])\s*["']?content["']?\s*:\s*([^,;}\n]+)/gm),
  ].map((match) => (match[1] ?? "").trim());
}

function decodeQuotedValue(value: string): string | undefined {
  const match =
    /^(?:"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'|`((?:\\.|[^`\\])*)`)$/.exec(
      value,
    );
  if (match === null) return undefined;
  return (match[1] ?? match[2] ?? match[3] ?? "").replace(
    /\\([0-9a-f]{1,6})\s?|\\(.)/gi,
    (_all, hex: string | undefined, escaped: string | undefined) =>
      hex === undefined
        ? (escaped ?? "")
        : String.fromCodePoint(Number.parseInt(hex, 16)),
  );
}

function javascriptLiterals(source: string): string[] {
  const literals: string[] = [];
  let cursor = 0;
  while (cursor < source.length) {
    const character = source[cursor];
    if (character === "/" && source[cursor + 1] === "/") {
      const end = source.indexOf("\n", cursor + 2);
      cursor = end < 0 ? source.length : end + 1;
      continue;
    }
    if (character === "/" && source[cursor + 1] === "*") {
      const end = source.indexOf("*/", cursor + 2);
      cursor = end < 0 ? source.length : end + 2;
      continue;
    }
    if (character !== '"' && character !== "'" && character !== "`") {
      cursor += 1;
      continue;
    }
    const start = cursor;
    cursor += 1;
    while (cursor < source.length) {
      if (source[cursor] === "\\") {
        cursor += 2;
        continue;
      }
      if (source[cursor] === character) {
        cursor += 1;
        literals.push(source.slice(start, cursor));
        break;
      }
      cursor += 1;
    }
  }
  return literals;
}

function javascriptCssLiteralContentValues(source: string): string[] {
  return javascriptLiterals(source).flatMap((literal) => {
    const decoded = decodeQuotedValue(literal);
    if (decoded === undefined || !/[^{}]+\{[\s\S]*\bcontent\s*:/i.test(decoded))
      return [];
    return conservativeContentValues(decoded);
  });
}

function javascriptContentValues(source: string): string[] {
  const objectValues = conservativeContentValues(source).flatMap((value) => {
    const decoded = decodeQuotedValue(value);
    if (decoded === undefined) return [];
    const cssValue = decoded.trim();
    return /^(?:none|normal)$/i.test(cssValue) ||
      /^(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')$/.test(cssValue) ||
      /\b(?:attr|counter|counters|url|var)\s*\(|[`$]/i.test(cssValue)
      ? [cssValue]
      : [];
  });
  const templateValues = [
    ...source.matchAll(
      /(?:\bcss|\bstyled(?:\.[A-Za-z_$][\w$]*|\((?:\\.|[^`)])*\))(?:\.[A-Za-z_$][\w$]*(?:\((?:\\.|[^`)])*\))?)*)\s*`((?:\\.|[^`])*)`/g,
    ),
  ].flatMap((match) =>
    conservativeContentValues(match[1] ?? "").map((value) => {
      const inert = /^(?:"(none|normal)"|'(none|normal)')$/i.exec(value);
      if (inert !== null) return inert[1] ?? inert[2] ?? value;
      const empty = /^(?:"('')"|'("")')$/.exec(value);
      return empty === null ? value : (empty[1] ?? empty[2] ?? value);
    }),
  );
  return [
    ...new Set([
      ...objectValues,
      ...templateValues,
      ...javascriptCssLiteralContentValues(source),
    ]),
  ];
}

function embeddedStyleContentValues(source: string): string[] {
  const blocks = [
    ...source.matchAll(/<style(?:\s[^>]*)?>([\s\S]*?)<\/style\s*>/gi),
  ];
  if (blocks.length === 0) return conservativeContentValues(source);
  return blocks.flatMap((match) => conservativeContentValues(match[1] ?? ""));
}

function contentValues(
  path: string,
  source: string,
  fragment: boolean,
): string[] {
  if (/\.(?:css|pcss)$/i.test(path)) {
    try {
      return cssContentValues(source);
    } catch (error) {
      if (fragment) return conservativeContentValues(source);
      throw new IdiomError(
        `cannot safely parse CSS content declarations in ${path}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  if (/\.(?:vue|svelte|html?)$/i.test(path))
    return embeddedStyleContentValues(source);
  if (/\.(?:[cm]?[jt]sx?)$/i.test(path)) return javascriptContentValues(source);
  // Sass/Less/Stylus cannot all be parsed by PostCSS's base parser. Scan their
  // replacement deltas conservatively and fail closed on any new value that is
  // dynamic, unparseable, or absent from baseline.
  return conservativeContentValues(source);
}

function decodeCssLiteral(value: string): string | undefined {
  if (/^(?:none|normal)$/i.test(value) || /^(?:""|'')$/.test(value)) return "";
  return decodeQuotedValue(value);
}

export function assertSafeGeneratedContent(
  edits: ExplorationEdit[],
  baselineCorpus: string,
  sources?: Array<{
    path: string;
    before: string;
    after: string;
  }>,
): void {
  for (const edit of edits) {
    const fullSource = sources?.find((source) => source.path === edit.path);
    const before = contentValues(
      edit.path,
      fullSource?.before ?? edit.oldText,
      fullSource === undefined,
    );
    const after = contentValues(
      edit.path,
      fullSource?.after ?? edit.newText,
      fullSource === undefined,
    );
    for (const value of after) {
      if (before.includes(value)) continue;
      if (/\b(?:attr|counter|counters|url|var)\s*\(|[`$]/i.test(value))
        throw new IdiomError(
          `dynamic CSS content is not allowed in ${edit.path}`,
        );
      const literal = decodeCssLiteral(value);
      if (literal === undefined)
        throw new IdiomError(
          `unparseable CSS content is not allowed in ${edit.path}`,
        );
      const normalized = normalizeCopy(literal);
      if (normalized !== "" && !baselineCorpus.includes(normalized))
        throw new IdiomError(
          `CSS content in ${edit.path} introduces copy not present in the baseline`,
        );
    }
  }
}

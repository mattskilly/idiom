import type { Page } from "playwright";

export type AuthoredRuleLike = { selector: string; order: number };

/**
 * The element facts the index reads. Callers pass plain values rather than
 * the element: a form's named controls can shadow `id`, `classList` and
 * `localName` on the element itself.
 */
export type IndexedElement = {
  id: string;
  classes: Iterable<string>;
  localName: string;
};

export type AuthoredRuleIndex<R extends AuthoredRuleLike> = {
  /**
   * Rules that could match the element, in ascending `order`. A superset of
   * the rules the element matches; `element.matches` stays the authority.
   */
  candidates(element: IndexedElement): R[];
  stats: { rules: number; universal: number; candidateChecks: number };
};

export type AuthoredRuleIndexFactory = <R extends AuthoredRuleLike>(
  rules: readonly R[],
) => AuthoredRuleIndex<R>;

declare global {
  var __idiomAuthoredRuleIndex: AuthoredRuleIndexFactory | undefined;
}

/**
 * Install a rightmost-compound rule index, the bucketing browsers use for
 * style resolution: each selector alternative is filed under one key from
 * its rightmost compound (id, else first class, else type), or a universal
 * bucket when no key can be read with confidence. Self-contained so
 * Playwright can serialize it; uses only `globalThis` so it also runs in
 * Node for unit tests.
 */
export function installAuthoredRuleIndex(): void {
  const scope = globalThis as { __idiomAuthoredRuleIndex?: unknown };
  if (typeof scope.__idiomAuthoredRuleIndex === "function") return;
  const isHex = (character: string) => /^[0-9a-fA-F]$/.test(character);
  const isSpace = (character: string) =>
    character === " " ||
    character === "\t" ||
    character === "\n" ||
    character === "\r" ||
    character === "\f";
  // Index just past the escape that starts with the backslash at `index`.
  const skipEscape = (text: string, index: number): number => {
    let cursor = index + 1;
    if (cursor >= text.length) return cursor;
    if (!isHex(text[cursor] ?? "")) return cursor + 1;
    const end = Math.min(text.length, cursor + 6);
    while (cursor < end && isHex(text[cursor] ?? "")) cursor += 1;
    if (text[cursor] === "\r" && text[cursor + 1] === "\n") return cursor + 2;
    if (isSpace(text[cursor] ?? "")) return cursor + 1;
    return cursor;
  };
  const splitSelectorList = (selector: string): string[] => {
    const parts: string[] = [];
    let start = 0;
    let depth = 0;
    let quote = "";
    for (let index = 0; index < selector.length; index += 1) {
      const character = selector[index] ?? "";
      if (character === "\\") {
        index = skipEscape(selector, index) - 1;
        continue;
      }
      if (quote !== "") {
        if (character === quote) quote = "";
        continue;
      }
      if (character === '"' || character === "'") quote = character;
      else if (character === "(" || character === "[" || character === "{")
        depth += 1;
      else if (character === ")" || character === "]" || character === "}")
        depth -= 1;
      else if (character === "," && depth === 0) {
        parts.push(selector.slice(start, index).trim());
        start = index + 1;
      }
    }
    parts.push(selector.slice(start).trim());
    return parts.filter(Boolean);
  };
  // The compound after the last top-level combinator.
  const rightmostCompound = (alternative: string): string => {
    let start = 0;
    let depth = 0;
    let quote = "";
    for (let index = 0; index < alternative.length; index += 1) {
      const character = alternative[index] ?? "";
      if (character === "\\") {
        index = skipEscape(alternative, index) - 1;
        continue;
      }
      if (quote !== "") {
        if (character === quote) quote = "";
        continue;
      }
      if (character === '"' || character === "'") quote = character;
      else if (character === "(" || character === "[") depth += 1;
      else if (character === ")" || character === "]") depth -= 1;
      else if (
        depth === 0 &&
        (isSpace(character) ||
          character === ">" ||
          character === "+" ||
          character === "~")
      )
        start = index + 1;
    }
    return alternative.slice(start).trim();
  };
  const isIdentCharacter = (character: string) =>
    /^[a-zA-Z0-9_-]$/.test(character) || character.charCodeAt(0) >= 0x80;
  // Reads an identifier at `index`, decoding CSS escapes.
  const readIdent = (
    text: string,
    index: number,
  ): { value: string; end: number } => {
    let value = "";
    let cursor = index;
    while (cursor < text.length) {
      const character = text[cursor] ?? "";
      if (character === "\\") {
        const next = text[cursor + 1];
        if (
          next === undefined ||
          next === "\n" ||
          next === "\r" ||
          next === "\f"
        )
          throw new Error("invalid escape");
        const end = skipEscape(text, cursor);
        if (isHex(next)) {
          const hex = text.slice(cursor + 1, end).trim();
          const code = Number.parseInt(hex, 16);
          value +=
            code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)
              ? "�"
              : String.fromCodePoint(code);
        } else value += next;
        cursor = end;
      } else if (isIdentCharacter(character)) {
        value += character;
        cursor += 1;
      } else break;
    }
    return { value, end: cursor };
  };
  // Index just past the bracket group opened at `index`.
  const skipGroup = (text: string, index: number): number => {
    const open = text[index];
    const close = open === "(" ? ")" : "]";
    let depth = 0;
    let quote = "";
    for (let cursor = index; cursor < text.length; cursor += 1) {
      const character = text[cursor] ?? "";
      if (character === "\\") {
        cursor = skipEscape(text, cursor) - 1;
        continue;
      }
      if (quote !== "") {
        if (character === quote) quote = "";
        continue;
      }
      if (character === '"' || character === "'") quote = character;
      else if (character === open) depth += 1;
      else if (character === close) {
        depth -= 1;
        if (depth === 0) return cursor + 1;
      }
    }
    throw new Error("unbalanced selector");
  };
  const lower = (value: string) =>
    value.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
  type Key = { kind: "id" | "class" | "tag"; value: string };
  const keyOf = (compound: string): Key | undefined => {
    let id: string | undefined;
    let className: string | undefined;
    let tag: string | undefined;
    let index = 0;
    while (index < compound.length) {
      const character = compound[index] ?? "";
      if (character === "*") index += 1;
      else if (character === "#" || character === ".") {
        const ident = readIdent(compound, index + 1);
        if (ident.value === "") return undefined;
        if (character === "#") id ??= ident.value;
        else className ??= ident.value;
        index = ident.end;
      } else if (character === "[") index = skipGroup(compound, index);
      else if (character === ":") {
        index += compound[index + 1] === ":" ? 2 : 1;
        const name = readIdent(compound, index);
        if (name.value === "") return undefined;
        index = name.end;
        if (compound[index] === "(") index = skipGroup(compound, index);
      } else if (
        index === 0 &&
        (isIdentCharacter(character) || character === "\\")
      ) {
        const ident = readIdent(compound, index);
        if (ident.value === "") return undefined;
        tag = ident.value;
        index = ident.end;
      } else return undefined;
    }
    if (id !== undefined) return { kind: "id", value: lower(id) };
    if (className !== undefined)
      return { kind: "class", value: lower(className) };
    if (tag !== undefined) return { kind: "tag", value: lower(tag) };
    return undefined;
  };
  const safeKeyOf = (alternative: string): Key | undefined => {
    try {
      return keyOf(rightmostCompound(alternative));
    } catch {
      return undefined;
    }
  };
  const createIndex = <R extends { selector: string; order: number }>(
    rules: readonly R[],
  ) => {
    const buckets = {
      id: new Map<string, R[]>(),
      class: new Map<string, R[]>(),
      tag: new Map<string, R[]>(),
    };
    const universal: R[] = [];
    const file = (list: R[], rule: R) => {
      if (list[list.length - 1] !== rule) list.push(rule);
    };
    for (const rule of rules) {
      const alternatives = splitSelectorList(rule.selector);
      if (alternatives.length === 0) file(universal, rule);
      for (const alternative of alternatives) {
        const key = safeKeyOf(alternative);
        if (key === undefined) {
          file(universal, rule);
          continue;
        }
        const map = buckets[key.kind];
        let list = map.get(key.value);
        if (list === undefined) {
          list = [];
          map.set(key.value, list);
        }
        file(list, rule);
      }
    }
    const stats = {
      rules: rules.length,
      universal: universal.length,
      candidateChecks: 0,
    };
    const candidates = (element: {
      id: string;
      classes: Iterable<string>;
      localName: string;
    }): R[] => {
      const lists: R[][] = [];
      const add = (list: R[] | undefined) => {
        if (list !== undefined && list.length > 0) lists.push(list);
      };
      if (element.id !== "") add(buckets.id.get(lower(element.id)));
      for (const className of element.classes)
        add(buckets.class.get(lower(className)));
      add(buckets.tag.get(lower(element.localName)));
      add(universal);
      let result: R[];
      if (lists.length === 0) result = [];
      else if (lists.length === 1) result = (lists[0] ?? []).slice();
      else {
        const seen = new Set<R>();
        result = [];
        for (const list of lists)
          for (const rule of list)
            if (!seen.has(rule)) {
              seen.add(rule);
              result.push(rule);
            }
        result.sort((a, b) => a.order - b.order);
      }
      stats.candidateChecks += result.length;
      return result;
    };
    return { candidates, stats };
  };
  scope.__idiomAuthoredRuleIndex = createIndex;
}

export async function ensureAuthoredRuleIndex(page: Page): Promise<void> {
  await page.evaluate(installAuthoredRuleIndex);
}

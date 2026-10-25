import { readdir, readFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import type { Page } from "playwright";
import postcss from "postcss";
import { IdiomError } from "../errors.js";
import {
  type EffectiveInvariant,
  invariantLabel,
  invariantSelectors,
} from "../schemas/invariant.js";
import { extractCss } from "../system/learn/css.js";
import { inlineDeclarations } from "../system/learn/inline.js";
import { normalizeCssValues } from "../system/learn/normalize.js";
import { type DesignToken, tokenIdentity } from "../system/learn/schema.js";
import type { ExtractedToken } from "../system/learn/types.js";
import { menuTriggerPattern } from "./collection-actions.js";
import type { InferredComponentInput } from "./design-components.js";
import {
  type ExplanationDomWindow,
  ensureExplanationDom,
} from "./explanation-dom.js";
import { sampleLiveness } from "./liveness-dom.js";
import type {
  BandEdgeObservation,
  ChecksConfig,
  CollectionObservation,
  ComponentObservation,
  ElementSignals,
  EmptyRegionObservation,
  FrameBorder,
  FrameEdgeSample,
  GeometryScan,
  InvariantObservation,
  MediaFrameObservation,
  ObservationArtifact,
  Rect,
  SelectorMark,
  TokenObservation,
  WordBreakObservation,
  WordFragment,
} from "./types.js";
import { ensureVisibilityDom } from "./visibility-dom.js";

export type TokenDeclarations =
  | { status: "not-configured" }
  | {
      status: "configured";
      source: string;
      declarations: Record<string, string>;
      values: string[];
      inline?: ExtractedToken[] | undefined;
      fileTokens?: ExtractedToken[] | undefined;
    };

export async function loadTokenDeclarations(
  projectDirectory: string,
  tokensFile?: string,
  inlineTokens: DesignToken[] = [],
): Promise<TokenDeclarations> {
  if (tokensFile === undefined)
    return inlineTokens.length === 0
      ? { status: "not-configured" }
      : {
          status: "configured",
          source: "design.tokens",
          declarations: Object.fromEntries(
            inlineTokens.map((t, i) => [`--idiom-probe-${i}`, t.value]),
          ),
          values: [],
          inline: inlineDeclarations(inlineTokens),
        };
  if (isAbsolute(tokensFile)) {
    throw new IdiomError("design.tokensFile must be project-relative");
  }
  const path = resolve(projectDirectory, tokensFile);
  const escaped = relative(projectDirectory, path);
  if (escaped.startsWith("..") || isAbsolute(escaped)) {
    throw new IdiomError("design.tokensFile must remain inside the project");
  }
  let source: string;
  try {
    source = await readFile(path, "utf8");
  } catch (error) {
    throw new IdiomError(
      `cannot read design.tokensFile ${JSON.stringify(tokensFile)}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  let root: postcss.Root;
  try {
    root = postcss.parse(source, { from: path });
  } catch (error) {
    throw new IdiomError(
      `cannot parse design.tokensFile ${JSON.stringify(tokensFile)}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const declarations: Record<string, string> = {};
  const values: string[] = [];
  root.walkDecls((declaration) => {
    if (declaration.prop.startsWith("--") && declaration.value.trim() !== "") {
      declarations[declaration.prop] = declaration.value.trim();
      values.push(declaration.value.trim());
    }
  });
  if (Object.keys(declarations).length === 0) {
    throw new IdiomError(
      `design.tokensFile ${JSON.stringify(tokensFile)} contains no custom-property declarations`,
    );
  }
  const siblings = (await readdir(dirname(path), { withFileTypes: true }))
    .filter((e) => e.isFile() && e.name.endsWith(".css"))
    .map((e) => relative(projectDirectory, resolve(dirname(path), e.name)));
  const fileTokens = (
    await extractCss(projectDirectory, siblings, { ignoreOutsideImports: true })
  ).filter((t) => t.source.path === relative(projectDirectory, path));
  return {
    status: "configured",
    fileTokens,
    source: tokensFile,
    declarations,
    values,
    ...(inlineTokens.length
      ? { inline: inlineDeclarations(inlineTokens) }
      : {}),
  };
}

export function extractAxeHeadingTargets(value: unknown): string[] {
  if (value === null || typeof value !== "object") return [];
  const violations = (value as { violations?: unknown }).violations;
  if (!Array.isArray(violations)) return [];
  const targets = new Set<string>();
  for (const violation of violations) {
    if (violation === null || typeof violation !== "object") continue;
    const record = violation as { id?: unknown; nodes?: unknown };
    if (
      !["heading-order", "page-has-heading-one"].includes(String(record.id)) ||
      !Array.isArray(record.nodes)
    )
      continue;
    for (const node of record.nodes) {
      if (node === null || typeof node !== "object") continue;
      const target = (node as { target?: unknown }).target;
      if (
        Array.isArray(target) &&
        target.length === 1 &&
        typeof target[0] === "string"
      )
        targets.add(target[0]);
      else if (typeof target === "string") targets.add(target);
    }
  }
  return [...targets].sort();
}

async function normalizeInlineTokens(
  page: Page,
  tokens: Extract<TokenDeclarations, { status: "configured" }>,
) {
  const context = await page.evaluate(() => ({
    rootFontSize: Number.parseFloat(
      getComputedStyle(document.documentElement).fontSize,
    ),
    theme: document.documentElement.getAttribute("data-theme"),
    scheme: matchMedia("(prefers-color-scheme: dark)").matches
      ? ("dark" as const)
      : ("light" as const),
  }));
  const inlineIds = new Set((tokens.inline ?? []).map(tokenIdentity));
  const allTokens = [
    ...(tokens.fileTokens ?? []).filter(
      (t) => !inlineIds.has(tokenIdentity(t)),
    ),
    ...(tokens.inline ?? []),
  ];
  const applicable = allTokens.filter(
    (t) =>
      !t.reason &&
      (t.theme === undefined ||
        t.theme === (context.theme ?? context.scheme)) &&
      !(
        t.theme === undefined &&
        allTokens.some(
          (other) =>
            other.name === t.name &&
            other.source.path === t.source.path &&
            other.theme === (context.theme ?? context.scheme),
        )
      ),
  );
  const contextEnvironment: Record<string, string> = {};
  for (const theme of [undefined, context.theme ?? context.scheme])
    for (const t of allTokens)
      if (t.theme === theme && !t.reason && t.name.startsWith("--"))
        contextEnvironment[t.name] = t.resolved ?? t.value;
  const normalized = await page.evaluate(
    normalizeCssValues,
    applicable.map((t) => ({
      value: t.resolved ?? t.value,
      kind: t.kind,
      environment: { ...t.environment, ...contextEnvironment },
      rootFontSize: context.rootFontSize,
      scheme: context.scheme,
    })),
  );
  return applicable.flatMap((token, index) =>
    normalized[index]?.value
      ? [
          {
            kind: token.kind,
            value: normalized[index]?.value as string,
            name: token.name,
            ...(token.theme === undefined ? {} : { theme: token.theme }),
          },
        ]
      : [],
  );
}

export async function normalizeTokenDeclarations(
  page: Page,
  tokens: TokenDeclarations,
): Promise<TokenObservation> {
  if (tokens.status === "not-configured") return tokens;
  const normalizedValues = await page.evaluate((tokenInput) => {
    const createProbe = (parentColor: string) => {
      const parent = document.createElement("span");
      parent.style.color = parentColor;
      const probe = document.createElement("span");
      for (const [name, value] of Object.entries(tokenInput.declarations))
        probe.style.setProperty(name, value);
      parent.append(probe);
      document.body.append(parent);
      return { parent, probe };
    };
    const first = createProbe("rgb(1, 2, 3)");
    const second = createProbe("rgb(4, 5, 6)");
    const normalized = new Set<string>();
    for (const value of tokenInput.values) {
      first.probe.style.color = "";
      second.probe.style.color = "";
      first.probe.style.color = value;
      second.probe.style.color = value;
      if (first.probe.style.color !== "" && second.probe.style.color !== "") {
        const firstColor = getComputedStyle(first.probe).color;
        const secondColor = getComputedStyle(second.probe).color;
        if (firstColor === secondColor) normalized.add(firstColor);
      }
      first.probe.style.borderTopLeftRadius = "";
      first.probe.style.borderTopLeftRadius = value;
      if (first.probe.style.borderTopLeftRadius !== "") {
        const radius = getComputedStyle(first.probe).borderTopLeftRadius;
        if (radius !== "0px") normalized.add(radius);
      }
    }
    first.parent.remove();
    second.parent.remove();
    return [...normalized].sort();
  }, tokens);
  if (
    normalizedValues.length === 0 &&
    tokens.inline === undefined &&
    !tokens.fileTokens?.some((t) => t.kind !== "other")
  ) {
    throw new IdiomError(
      `design.tokensFile ${JSON.stringify(tokens.source)} contains no usable custom-property color or radius values`,
    );
  }
  return {
    status: "configured",
    source: tokens.source,
    declarations: tokens.declarations,
    normalizedValues,
    // Typed coverage is opt-in through confirmed inline declarations. File-only
    // projects retain the full legacy declaration surface, including media and
    // arbitrary selectors that source learning cannot resolve unconditionally.
    ...(tokens.inline?.length
      ? { typedValues: await normalizeInlineTokens(page, tokens) }
      : {}),
  };
}

export type ObserveOptions = {
  /** Gallery frames are recorded for screenshot band sampling when auto. */
  mediaFill?:
    | { auto: boolean; ignore: string[]; tolerance?: number | undefined }
    | undefined;
  /** Declared collections of user-created objects (checks.collections). */
  collections?: Array<{ selector: string }> | undefined;
  bandEdges?: boolean | undefined;
  wordBreak?: boolean | undefined;
  touchReachability?: ChecksConfig["touchReachability"];
  liveness?: ChecksConfig["liveness"];
  shell?: string | undefined;
  floatingOverlays?: string[] | undefined;
  invariants?: EffectiveInvariant[] | undefined;
  components?: Array<{
    name: string;
    selector: string;
    width: number;
    height: number;
    tolerance: {
      ratio: number;
      px: number;
      mode?: "tighter" | "looser" | undefined;
    };
  }>;
  /**
   * Component sizes inferred from DESIGN.md; each selector is resolved here
   * from class or aria-label words. Explicit `components` selectors win.
   */
  inferredComponents?: InferredComponentInput[] | undefined;
  /** The flow declared this state fresh (first load, no prior interaction). */
  fresh?: boolean | undefined;
  marks?: Array<{ purpose: SelectorMark["purpose"]; selector: string }>;
  /** Record every `<img>` (published flows only). */
  images?: boolean | undefined;
  /** Regions judged by the empty-state check (resolved at capture time). */
  emptyState?:
    | {
        regions: Array<{ selector: string; items: string }>;
        auto: boolean;
        ignore: string[];
      }
    | undefined;
};

export async function observePage(
  page: Page,
  tokens: TokenDeclarations | TokenObservation,
  axe?: unknown,
  masks: string[] = [],
  observeOptions: ObserveOptions = {},
): Promise<ObservationArtifact> {
  const liveness = observeOptions.liveness
    ? await sampleLiveness(page, observeOptions.liveness)
    : undefined;
  const normalizedTokens =
    tokens.status === "not-configured" || "normalizedValues" in tokens
      ? tokens
      : await normalizeTokenDeclarations(page, tokens);
  const axeHeadingTargets = extractAxeHeadingTargets(axe);
  await ensureExplanationDom(page);
  await ensureVisibilityDom(page);
  const artifact: ObservationArtifact = await page.evaluate(
    async ({
      tokenInput,
      axeTargets,
      maskSelectors,
      componentInput,
      inferredInput,
      invariantInput,
      markInput,
      imagesInput,
      emptyInput,
      bandEdgesInput,
      wordBreakInput,
      shellInput,
      overlayInput,
      mediaInput,
      collectionInput,
      menuTriggerSource,
    }) => {
      const generatedClass = (value: string): boolean =>
        /__[A-Za-z0-9_-]{5,}$/.test(value) ||
        /^(?:css|jsx|sc|emotion|styled)[-_][A-Za-z0-9_-]{5,}$/i.test(value) ||
        /^[a-f0-9]{8,}$/i.test(value);
      const stableAttributes = [
        "data-testid",
        "data-test",
        "data-id",
        "name",
        "aria-label",
        "role",
      ];
      const selectorFor = (element: Element): string => {
        if (element === document.documentElement) return "html";
        if (element === document.body) return "body";
        // Framework-generated ids (React useId, Radix, Headless UI) change
        // between renders and builds, so they never anchor a selector.
        const generatedId =
          /(?:^|[-_])(?::r[0-9a-z]+:|«r[0-9a-z]+»|_r_[0-9a-z]+_)|^radix-|^headlessui-/.test(
            element.id,
          );
        if (element.id && !generatedId) {
          const candidate = `#${CSS.escape(element.id)}`;
          if (document.querySelectorAll(candidate).length === 1)
            return candidate;
        }
        for (const name of stableAttributes) {
          const value = element.getAttribute(name);
          if (value) {
            const candidate = `${element.tagName.toLowerCase()}[${name}=${JSON.stringify(value)}]`;
            if (document.querySelectorAll(candidate).length === 1)
              return candidate;
          }
        }
        const classes = [...element.classList]
          .filter((value) => !generatedClass(value))
          .sort()
          .slice(0, 3);
        if (classes.length > 0) {
          const candidate = `${element.tagName.toLowerCase()}${classes.map((value) => `.${CSS.escape(value)}`).join("")}`;
          if (document.querySelectorAll(candidate).length === 1)
            return candidate;
        }
        const parts: string[] = [];
        let current: Element | null = element;
        while (current !== null && current !== document.body) {
          const tag = current.tagName.toLowerCase();
          const siblings = current.parentElement
            ? [...current.parentElement.children].filter(
                (candidate) => candidate.tagName === current?.tagName,
              )
            : [];
          parts.unshift(
            siblings.length > 1
              ? `${tag}:nth-of-type(${siblings.indexOf(current) + 1})`
              : tag,
          );
          current = current.parentElement;
        }
        return `body > ${parts.join(" > ")}`;
      };
      const splitSelectorList = (selector: string): string[] => {
        const parts: string[] = [];
        let start = 0;
        let depth = 0;
        let quote = "";
        let escaped = false;
        for (let index = 0; index < selector.length; index += 1) {
          const character = selector[index] ?? "";
          if (escaped) {
            escaped = false;
            continue;
          }
          if (character === "\\") {
            escaped = true;
            continue;
          }
          if (quote !== "") {
            if (character === quote) quote = "";
            continue;
          }
          if (character === '"' || character === "'") {
            quote = character;
            continue;
          }
          if (["(", "[", "{"].includes(character)) depth += 1;
          else if ([")", "]", "}"].includes(character)) depth -= 1;
          else if (character === "," && depth === 0) {
            parts.push(selector.slice(start, index).trim());
            start = index + 1;
          }
        }
        parts.push(selector.slice(start).trim());
        return parts.filter(Boolean);
      };
      const resolveNestedSelector = (parent: string, child: string): string =>
        splitSelectorList(parent)
          .flatMap((parentPart) =>
            splitSelectorList(child).map((childPart) =>
              childPart.includes("&")
                ? childPart.replaceAll("&", parentPart)
                : `${parentPart} ${childPart}`,
            ),
          )
          .join(", ");
      const authoredRules: Array<{
        selector: string;
        style: CSSStyleDeclaration;
      }> = [];
      const collectRules = (rules: CSSRuleList, parentSelector?: string) => {
        for (const rule of rules) {
          let nestedParent = parentSelector;
          if (rule instanceof CSSStyleRule) {
            nestedParent =
              parentSelector === undefined
                ? rule.selectorText
                : resolveNestedSelector(parentSelector, rule.selectorText);
            authoredRules.push({ selector: nestedParent, style: rule.style });
          }
          if (
            parentSelector !== undefined &&
            typeof CSSNestedDeclarations !== "undefined" &&
            rule instanceof CSSNestedDeclarations
          ) {
            authoredRules.push({ selector: parentSelector, style: rule.style });
          }
          const canDescend =
            rule instanceof CSSStyleRule ||
            (typeof CSSLayerBlockRule !== "undefined" &&
              rule instanceof CSSLayerBlockRule) ||
            (rule instanceof CSSMediaRule &&
              matchMedia(rule.conditionText).matches) ||
            (rule instanceof CSSSupportsRule &&
              CSS.supports(rule.conditionText));
          if (canDescend) {
            try {
              collectRules(rule.cssRules, nestedParent);
            } catch {
              // Cross-origin and unsupported rule lists are not observable.
            }
          }
        }
      };
      for (const sheet of document.styleSheets) {
        try {
          collectRules(sheet.cssRules);
        } catch {
          // Cross-origin stylesheets cannot be inspected safely.
        }
      }
      const camelCase = (property: string) =>
        property.replace(/-([a-z])/g, (_match, letter: string) =>
          letter.toUpperCase(),
        );
      const isInteractive = (element: Element) => {
        const tag = element.tagName.toLowerCase();
        const html = element as HTMLElement;
        return (
          ["button", "input", "select", "textarea", "summary"].includes(tag) ||
          (tag === "a" && element.hasAttribute("href")) ||
          element.hasAttribute("onclick") ||
          element.getAttribute("role") === "button" ||
          element.getAttribute("role") === "link" ||
          (element.hasAttribute("tabindex") && html.tabIndex >= 0)
        );
      };
      const forbiddenRenderedTags = new Set([
        "script",
        "style",
        "template",
        "noscript",
      ]);
      const isRendered = (element: Element) => {
        if (forbiddenRenderedTags.has(element.tagName.toLowerCase()))
          return false;
        const rect = element.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return false;
        let current: Element | null = element;
        while (current !== null) {
          const style = getComputedStyle(current);
          if (
            style.display === "none" ||
            style.visibility === "hidden" ||
            style.visibility === "collapse" ||
            Number(style.opacity) <= 0
          )
            return false;
          current = current.parentElement;
        }
        return true;
      };
      const elementPaths = (elements: Element[]): Map<Element, string> => {
        const included = new Set(elements);
        const paths = new Map<Element, string>();
        const siblingCounts = new Map<Element | null, Map<string, number>>();
        for (const element of elements) {
          // A rendered-only tree flattens excluded wrappers onto the nearest
          // included ancestor while preserving document-order sibling indices.
          let parent = element.parentElement;
          while (parent !== null && !included.has(parent))
            parent = parent.parentElement;
          const tag = element.tagName.toLowerCase();
          const counts = siblingCounts.get(parent) ?? new Map<string, number>();
          const sibling = counts.get(tag) ?? 0;
          counts.set(tag, sibling + 1);
          siblingCounts.set(parent, counts);
          const parentPath = parent === null ? undefined : paths.get(parent);
          if (parent !== null && parentPath === undefined)
            throw new Error("observation elements are not in document order");
          paths.set(
            element,
            `${parentPath === undefined ? "" : `${parentPath}/`}${tag}[${sibling}]`,
          );
        }
        return paths;
      };
      const allowedAttributes = new Set([
        "class",
        "style",
        "role",
        "title",
        "alt",
        "aria-label",
        "aria-checked",
        "aria-current",
        "aria-disabled",
        "aria-expanded",
        "aria-hidden",
        "aria-level",
        "aria-live",
        "aria-pressed",
        "aria-selected",
        "aria-valuemax",
        "aria-valuemin",
        "aria-valuenow",
        "checked",
        "data-idiom-crop",
        "data-idiom-name",
        "translate",
        "disabled",
        "hidden",
        "open",
        "readonly",
        "required",
        "selected",
      ]);
      const temporalPattern =
        /\b(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)(?:day)?\b|\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)(?:uary|ruary|ch|il|e|y|ust|tember|ober|ember)?\b|\b\d{1,4}[/-]\d{1,2}[/-]\d{1,4}\b|\b\d{1,2}:\d{2}(?::\d{2})?\s*(?:[ap]m)?\b|\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/i;
      const implicitRole = (element: Element): string => {
        const explicit = element.getAttribute("role");
        if (explicit) return explicit;
        const tag = element.tagName.toLowerCase();
        if (tag === "button" || tag === "summary") return "button";
        if (tag === "a" && element.hasAttribute("href")) return "link";
        if (tag === "select") return "combobox";
        if (tag === "textarea") return "textbox";
        if (/^h[1-6]$/.test(tag)) return "heading";
        if (tag === "input") {
          const type = (element.getAttribute("type") ?? "text").toLowerCase();
          if (["button", "submit", "reset", "image"].includes(type))
            return "button";
          if (type === "checkbox") return "checkbox";
          if (type === "radio") return "radio";
          if (type === "range") return "slider";
          return "textbox";
        }
        if (tag === "dialog") return "dialog";
        return "";
      };
      const textOf = (id: string) =>
        (document.getElementById(id)?.textContent ?? "")
          .replace(/\s+/g, " ")
          .trim();
      const accessibleName = (element: Element): string => {
        const label = element.getAttribute("aria-label")?.trim();
        if (label) return label;
        const labelledBy = element.getAttribute("aria-labelledby");
        if (labelledBy) {
          const text = labelledBy.split(/\s+/).map(textOf).join(" ").trim();
          if (text) return text;
        }
        const tag = element.tagName.toLowerCase();
        if (["input", "select", "textarea"].includes(tag)) {
          const id = element.getAttribute("id");
          const labelled =
            (id
              ? document.querySelector(`label[for="${CSS.escape(id)}"]`)
              : null) ?? element.closest("label");
          const text = (labelled?.textContent ?? "")
            .replace(/\s+/g, " ")
            .trim();
          if (text) return text;
          const input = element as HTMLInputElement;
          if (["button", "submit", "reset"].includes(input.type ?? ""))
            return input.value ?? "";
          return element.getAttribute("placeholder")?.trim() ?? "";
        }
        if (tag === "img") return element.getAttribute("alt")?.trim() ?? "";
        const text = (
          (element as HTMLElement).innerText ??
          element.textContent ??
          ""
        )
          .replace(/\s+/g, " ")
          .trim();
        if (text) return text.slice(0, 200);
        for (const graphic of element.querySelectorAll(
          "img[alt], svg [aria-label], svg title, [aria-label]",
        )) {
          const value =
            graphic.getAttribute("alt") ??
            graphic.getAttribute("aria-label") ??
            graphic.textContent ??
            "";
          if (value.trim()) return value.trim();
        }
        return "";
      };
      const describedElsewhere = (element: Element): boolean => {
        const describedBy = element.getAttribute("aria-describedby");
        if (describedBy?.split(/\s+/).some((id) => textOf(id) !== ""))
          return true;
        return [
          "aria-description",
          "data-tooltip",
          "data-tip",
          "data-tooltip-content",
          "data-title",
        ].some((name) => (element.getAttribute(name) ?? "").trim() !== "");
      };
      const repeatedSignature = (element: Element) =>
        `${element.tagName}|${[...element.classList]
          .filter((value) => !generatedClass(value))
          .sort()
          .join(".")}`;
      const isRepeatedItem = (element: Element): boolean => {
        let current: Element | null = element;
        for (let depth = 0; current !== null && depth < 5; depth += 1) {
          const parent: Element | null = current.parentElement;
          if (parent === null) break;
          const signature = repeatedSignature(current);
          const peers = [...parent.children].filter(
            (child) => repeatedSignature(child) === signature,
          );
          if (peers.length >= 3) return true;
          current = parent;
        }
        return false;
      };
      const measureCanvas = document.createElement("canvas").getContext("2d");
      const measureLines = (
        element: Element,
        accept: (parent: Element) => boolean,
      ) => {
        const rects: DOMRect[] = [];
        const texts: string[] = [];
        let firstText: Text | undefined;
        const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
        for (
          let node = walker.nextNode();
          node !== null;
          node = walker.nextNode()
        ) {
          if ((node.textContent ?? "").trim() === "") continue;
          const parent = node.parentElement;
          if (parent === null || !renderedPaths.has(parent)) continue;
          if (!accept(parent)) continue;
          firstText ??= node as Text;
          texts.push(node.textContent ?? "");
          const range = document.createRange();
          range.selectNodeContents(node);
          for (const rect of range.getClientRects())
            if (rect.width > 0 && rect.height > 0) rects.push(rect);
        }
        if (rects.length === 0) return { texts, lineCount: 0 };
        const tops: number[] = [];
        for (const rect of rects) {
          const centre = rect.top + rect.height / 2;
          if (!tops.some((top) => Math.abs(top - centre) < rect.height / 2))
            tops.push(centre);
        }
        const left = Math.min(...rects.map((rect) => rect.left));
        const top = Math.min(...rects.map((rect) => rect.top));
        const right = Math.max(...rects.map((rect) => rect.right));
        const bottom = Math.max(...rects.map((rect) => rect.bottom));
        const textRect = {
          x: left,
          y: top,
          width: right - left,
          height: bottom - top,
        };
        return {
          texts,
          lineCount: tops.length,
          textRect,
          firstText,
          firstRect: rects[0] as DOMRect,
        };
      };
      const measureInk = (
        firstText: Text,
        firstRect: DOMRect,
        content: string,
        glyph: boolean,
      ) => {
        if (measureCanvas === null) return undefined;
        const parent = firstText.parentElement as Element;
        const style = getComputedStyle(parent);
        measureCanvas.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
        const metrics = measureCanvas.measureText(content);
        const fontHeight =
          metrics.fontBoundingBoxAscent + metrics.fontBoundingBoxDescent;
        if (!Number.isFinite(fontHeight) || fontHeight <= 0) return undefined;
        const baseline =
          firstRect.top +
          (firstRect.height - fontHeight) / 2 +
          metrics.fontBoundingBoxAscent;
        // A lone glyph such as + − × floats on the math axis, not the
        // baseline, so its own ink box is what the reader centres.
        const centre = glyph
          ? baseline -
            (metrics.actualBoundingBoxAscent -
              metrics.actualBoundingBoxDescent) /
              2
          : // Perceived centring ignores descenders: the reader centres on
            // the cap/x-height band between the ink top and the baseline.
            baseline - metrics.actualBoundingBoxAscent / 2;
        return Number.isFinite(centre) ? centre : undefined;
      };
      const textGeometry = (element: Element) => {
        const lines = measureLines(element, () => true);
        if (lines.textRect === undefined) return { lineCount: 0 };
        let inkCenterY: number | undefined;
        if (lines.lineCount === 1 && lines.firstText !== undefined) {
          const content = (element.textContent ?? "")
            .replace(/\s+/g, " ")
            .trim();
          inkCenterY = measureInk(
            lines.firstText,
            lines.firstRect,
            content,
            false,
          );
        }
        return {
          lineCount: lines.lineCount,
          textRect: lines.textRect,
          inkCenterY,
        };
      };
      const visibleParents = new Map<Element, boolean>();
      const visibleTextParent = (parent: Element) => {
        let visible = visibleParents.get(parent);
        if (visible === undefined) {
          visible = isVisibleContent(parent, false);
          visibleParents.set(parent, visible);
        }
        return visible;
      };
      const graphemes =
        typeof Intl.Segmenter === "function"
          ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
          : undefined;
      // Only painted text: a visible button whose sole text is a
      // screen-reader label has no label to centre.
      const labelInk = (element: Element) => {
        const lines = measureLines(element, visibleTextParent);
        const text = lines.texts.join("").replace(/\s+/g, " ").trim();
        if (lines.textRect === undefined || text === "")
          return { text: text.slice(0, 120), lineCount: 0 };
        const glyph =
          graphemes !== undefined &&
          [...graphemes.segment(text)].length === 1 &&
          !/[\p{L}\p{N}]/u.test(text);
        const inkCenterY =
          lines.lineCount === 1 && lines.firstText !== undefined
            ? measureInk(lines.firstText, lines.firstRect, text, glyph)
            : undefined;
        return {
          text: text.slice(0, 120),
          lineCount: lines.lineCount,
          textRect: lines.textRect,
          ...(inkCenterY === undefined ? {} : { inkCenterY }),
          ...(glyph ? { glyph: true as const } : {}),
        };
      };
      // Screen-reader labels can pass layout visibility while being clipped
      // into a 1px box. Their text and icons do not contribute to appearance.
      const isVisibleContent = (element: Element, requireBox = true) => {
        if (forbiddenRenderedTags.has(element.tagName.toLowerCase()))
          return false;
        if (requireBox && !isRendered(element)) return false;
        let current: Element | null = element;
        while (current !== null) {
          const style = getComputedStyle(current);
          if (
            style.display === "none" ||
            style.visibility === "hidden" ||
            style.visibility === "collapse" ||
            Number(style.opacity) <= 0
          )
            return false;
          const rect = current.getBoundingClientRect();
          // A display:contents element has no clipping box of its own.
          if (
            style.display !== "contents" &&
            rect.width <= 1 &&
            rect.height <= 1 &&
            (["hidden", "clip"].includes(style.overflowX) ||
              ["hidden", "clip"].includes(style.overflowY) ||
              style.clip !== "auto" ||
              style.clipPath !== "none")
          )
            return false;
          current = current.parentElement;
        }
        return true;
      };
      const explanationDom = (window as ExplanationDomWindow)
        .__idiomExplanationDom;
      if (!explanationDom)
        throw new Error("explanation DOM helpers unavailable");
      const explanationFor = (element: Element) => ({
        controlId: explanationDom.identity(element),
        inViewport: explanationDom.visible(element),
        nativeDisabled: element.matches(":disabled"),
        visibleText: explanationDom.text(element, true),
        descriptions: (element.getAttribute("aria-describedby") ?? "")
          .split(/\s+/)
          .filter(Boolean)
          .flatMap((id) => {
            const target = document.getElementById(id);
            if (target === null) return [];
            // Associated tooltip text counts when it is actually painted.
            const text = explanationDom.text(target);
            return text === "" ? [] : [{ selector: selectorFor(target), text }];
          }),
      });
      const renderedContent = (element: Element) => {
        let directText = false;
        let font: { fontSize: string; fontWeight: string } | null = null;
        let unavailable: string | undefined;
        const rememberFont = (style: CSSStyleDeclaration) => {
          font ??= { fontSize: style.fontSize, fontWeight: style.fontWeight };
        };
        const generatedText = (
          owner: Element,
          pseudo: "::before" | "::after",
        ) => {
          const style = getComputedStyle(owner, pseudo);
          const content = style.content;
          if (
            style.display === "none" ||
            style.visibility !== "visible" ||
            Number(style.opacity) <= 0 ||
            content === "none" ||
            content === "normal"
          )
            return;
          // Computed literal strings (including resolved attr()) can be read
          // directly. Counters, images and other content forms need evidence
          // we do not have, so disclose that instead of calling them empty.
          const literal =
            /^("(?:[^"\\]|\\[\s\S])*"|'(?:[^'\\]|\\[\s\S])*')(?:\s*\/.*)?$/.exec(
              content,
            );
          if (literal === null) {
            unavailable = `unsupported generated content in ${pseudo}`;
            return;
          }
          const text = (literal[1] ?? "")
            .slice(1, -1)
            .replace(
              /\\(?:([0-9a-f]{1,6})\s?|([\s\S]))/gi,
              (_match, hex: string | undefined, escaped: string | undefined) =>
                hex === undefined
                  ? (escaped ?? "")
                  : String.fromCodePoint(
                      Math.min(Number.parseInt(hex, 16), 0x10ffff),
                    ),
            );
          if (text.trim()) rememberFont(style);
        };
        const visit = (owner: Element) => {
          // Text paint visibility differs from owning a layout box: range
          // geometry still exists inside display:contents wrappers.
          if (!isVisibleContent(owner, false)) return;
          generatedText(owner, "::before");
          for (const node of owner.childNodes) {
            if (node instanceof Element) visit(node);
            else if (
              node.nodeType === Node.TEXT_NODE &&
              node.textContent?.trim()
            ) {
              const range = document.createRange();
              range.selectNodeContents(node);
              if (
                ![...range.getClientRects()].some(
                  (rect) => rect.width > 0 && rect.height > 0,
                )
              )
                continue;
              rememberFont(getComputedStyle(owner));
              if (owner === element) directText = true;
            }
          }
          generatedText(owner, "::after");
        };
        visit(element);
        const graphicSelector = "svg, img, i, [class*='icon'], [data-icon]";
        const graphic = [
          element,
          ...element.querySelectorAll(graphicSelector),
        ].some(
          (node) => node.matches(graphicSelector) && isVisibleContent(node),
        );
        const textEvidence =
          unavailable === undefined
            ? { status: "available" as const, font }
            : { status: "unavailable" as const, reason: unavailable };
        return { text: font !== null, directText, graphic, textEvidence };
      };
      // Paint evidence for luminance parity and frame separation. Colours are
      // composited over their real backdrop (alpha and opacity groups) and
      // anything this solid-paint model cannot resolve says why.
      type Rgba = { r: number; g: number; b: number; a: number };
      type PaintStyle = {
        background: string;
        image: string;
        clip: string;
        shadow: string;
        borders: { top: number; right: number; bottom: number; left: number };
        rounded: boolean;
        transform: string;
        position: string;
        zIndex: string;
        order: string;
        opacity: number;
        effect: string | undefined;
        pointerEvents: string;
        overflowX: string;
        overflowY: string;
        visibility: string;
        masked: boolean;
      };
      const parseRgba = (value: string): Rgba | undefined => {
        if (value === "transparent") return { r: 0, g: 0, b: 0, a: 0 };
        const match = value
          .trim()
          .match(
            /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/i,
          );
        if (match === null) return undefined;
        const alpha = match[4];
        return {
          r: Number(match[1]),
          g: Number(match[2]),
          b: Number(match[3]),
          a:
            alpha === undefined
              ? 1
              : alpha.endsWith("%")
                ? Number(alpha.slice(0, -1)) / 100
                : Number(alpha),
        };
      };
      const shadowLayers = (value: string) => {
        if (value === "none") return [];
        return topLevelLayers(value).map((layer) => {
          const match = layer.match(
            /^(rgba?\([^)]*\)|transparent)\s+(-?[\d.]+)px\s+(-?[\d.]+)px(?:\s+([\d.]+)px)?(?:\s+(-?[\d.]+)px)?(\s+inset)?$/,
          );
          const color = match === null ? undefined : parseRgba(match[1] ?? "");
          if (match === null || color === undefined) return undefined;
          return {
            color,
            x: Number(match[2]),
            y: Number(match[3]),
            blur: Number(match[4] ?? 0),
            spread: Number(match[5] ?? 0),
            inset: match[6] !== undefined,
          };
        });
      };
      const shadowRects = new Map<Element, DOMRect>();
      const paintStyles = new Map<Element, PaintStyle>();
      const paintStyle = (element: Element): PaintStyle => {
        const cached = paintStyles.get(element);
        if (cached !== undefined) return cached;
        const style = getComputedStyle(element);
        const effect =
          style.filter !== "none"
            ? "filter"
            : style.mixBlendMode !== "normal"
              ? "mix-blend-mode"
              : (style.backdropFilter ?? "none") !== "none"
                ? "backdrop-filter"
                : undefined;
        const value = {
          background: style.backgroundColor,
          image: style.backgroundImage,
          clip: style.backgroundClip,
          shadow: style.boxShadow,
          borders: {
            top: parseFloat(style.borderTopWidth),
            right: parseFloat(style.borderRightWidth),
            bottom: parseFloat(style.borderBottomWidth),
            left: parseFloat(style.borderLeftWidth),
          },
          rounded: style.borderRadius
            .split(/[\s/]+/)
            .some((value) => parseFloat(value) !== 0),
          transform: style.transform,
          position: style.position,
          zIndex: style.zIndex,
          order: style.order,
          opacity: Number(style.opacity),
          effect,
          pointerEvents: style.pointerEvents,
          overflowX: style.overflowX,
          overflowY: style.overflowY,
          visibility: style.visibility,
          masked: (style.maskImage ?? "none") !== "none",
        };
        paintStyles.set(element, value);
        if (value.shadow !== "none")
          shadowRects.set(element, element.getBoundingClientRect());
        return value;
      };
      const selectorCache = new Map<Element, string>();
      const sourceSelector = (element: Element): string => {
        let selector = selectorCache.get(element);
        if (selector === undefined) {
          selector = selectorFor(element);
          selectorCache.set(element, selector);
        }
        return selector;
      };
      // The browser canvas behind a transparent root follows the root's used
      // color-scheme, which a Canvas-coloured probe resolves exactly.
      const canvasColor = (() => {
        const probe = document.createElement("div");
        probe.style.cssText =
          "position:absolute;width:0;height:0;background-color:Canvas";
        document.documentElement.append(probe);
        const color = parseRgba(getComputedStyle(probe).backgroundColor);
        probe.remove();
        return color === undefined || color.a < 1
          ? { r: 255, g: 255, b: 255, a: 1 }
          : color;
      })();
      // CSS propagates the body background to the canvas when the root has
      // none; the body box itself then paints nothing.
      const htmlStyle = paintStyle(document.documentElement);
      const bodyPropagated =
        (parseRgba(htmlStyle.background)?.a ?? 1) === 0 &&
        htmlStyle.image === "none";
      const ownFill = (
        element: Element,
      ): { color: Rgba | undefined; image: string; reason?: string } => {
        if (element === document.body && bodyPropagated)
          return { color: { r: 0, g: 0, b: 0, a: 0 }, image: "none" };
        const style =
          element === document.documentElement && bodyPropagated
            ? paintStyle(document.body)
            : paintStyle(element);
        const color = parseRgba(style.background);
        // Hit testing includes the padding/border boxes even when a solid
        // background is clipped to content (or text). Its declaration alone
        // cannot establish paint at a sample outside that area.
        if (
          style.clip !== "border-box" &&
          (style.image !== "none" || (color?.a ?? 1) > 0)
        )
          return {
            color: undefined,
            image: style.image,
            reason: `unsupported background-clip ${JSON.stringify(style.clip)} on ${sourceSelector(element)}`,
          };
        return { color, image: style.image };
      };
      // A premultiplied layer, the elements whose paint reached it, and why
      // it cannot be trusted when a non-solid layer contributes.
      type Layer = {
        r: number;
        g: number;
        b: number;
        a: number;
        sources: Element[];
        unknown?: string | undefined;
      };
      const clear: Layer = { r: 0, g: 0, b: 0, a: 0, sources: [] };
      const over = (color: Rgba, below: Layer, source: Element): Layer => {
        const a = Math.min(1, Math.max(0, color.a));
        if (a <= 0) return below;
        return {
          r: color.r * a + below.r * (1 - a),
          g: color.g * a + below.g * (1 - a),
          b: color.b * a + below.b * (1 - a),
          a: a + below.a * (1 - a),
          sources: a >= 1 ? [source] : [...below.sources, source],
          unknown: a >= 1 ? undefined : below.unknown,
        };
      };
      type PaintState = {
        groups: Array<{ layer: Layer; opacity: number }>;
        effect?: string | undefined;
      };
      const paintStates = new Map<Element, PaintState>();
      const canvasState: PaintState = {
        groups: [
          {
            layer: {
              r: canvasColor.r,
              g: canvasColor.g,
              b: canvasColor.b,
              a: 1,
              sources: [],
            },
            opacity: 1,
          },
        ],
      };
      const withTop = (state: PaintState, layer: Layer): PaintState => {
        const groups = [...state.groups];
        const top = groups[groups.length - 1] as PaintState["groups"][number];
        groups[groups.length - 1] = { ...top, layer };
        return { ...state, groups };
      };
      const topLayer = (state: PaintState): Layer =>
        (state.groups[state.groups.length - 1] as PaintState["groups"][number])
          .layer;
      // Bitmap/replaced and vector content paints above its CSS background.
      // Hit testing exposes its box, not the pixels; an opaque later layer
      // can still hide this unknown contribution through normal compositing.
      const replacedPaint = (element: Element): string | undefined =>
        element instanceof SVGElement ||
        ["canvas", "img", "video", "object", "embed", "iframe"].includes(
          element.localName,
        ) ||
        (element instanceof HTMLInputElement && element.type === "image")
          ? `unsupported replaced-content paint on ${sourceSelector(element)} (${element.localName})`
          : undefined;
      // Memoised down the DOM ancestor chain, so each element's style is read
      // and composited once per observation.
      const stateFor = (element: Element): PaintState => {
        const cached = paintStates.get(element);
        if (cached !== undefined) return cached;
        const parent = element.parentElement;
        const base = parent === null ? canvasState : stateFor(parent);
        const style = paintStyle(element);
        let state: PaintState = {
          groups:
            style.opacity < 1
              ? [...base.groups, { layer: clear, opacity: style.opacity }]
              : base.groups,
          effect:
            base.effect ??
            (style.effect === undefined
              ? undefined
              : `${style.effect} on ${sourceSelector(element)}`),
        };
        const fill = ownFill(element);
        let layer = topLayer(state);
        if (fill.color === undefined)
          layer = {
            ...layer,
            unknown:
              fill.reason ??
              `unsupported background colour on ${sourceSelector(element)}`,
          };
        else layer = over(fill.color, layer, element);
        if (fill.image !== "none")
          layer = {
            ...layer,
            unknown: `background image on ${sourceSelector(element)}`,
          };
        const replaced = replacedPaint(element);
        if (replaced !== undefined) layer = { ...layer, unknown: replaced };
        state = withTop(state, layer);
        paintStates.set(element, state);
        return state;
      };
      const resolveState = (
        state: PaintState,
      ): { color: Rgba; sources: Element[] } | { reason: string } => {
        const groups = [...state.groups];
        while (groups.length > 1) {
          const group = groups.pop() as PaintState["groups"][number];
          const below = groups[
            groups.length - 1
          ] as PaintState["groups"][number];
          const o = group.opacity;
          const src = group.layer;
          const a = src.a * o;
          groups[groups.length - 1] = {
            ...below,
            layer: {
              r: src.r * o + below.layer.r * (1 - a),
              g: src.g * o + below.layer.g * (1 - a),
              b: src.b * o + below.layer.b * (1 - a),
              a: a + below.layer.a * (1 - a),
              sources: [...below.layer.sources, ...src.sources],
              unknown: src.unknown ?? below.layer.unknown,
            },
          };
        }
        const layer = topLayer({ groups });
        if (state.effect !== undefined) return { reason: state.effect };
        if (layer.unknown !== undefined) return { reason: layer.unknown };
        const a = layer.a > 0 ? layer.a : 1;
        return {
          color: { r: layer.r / a, g: layer.g / a, b: layer.b / a, a: 1 },
          sources: layer.sources,
        };
      };
      // Flatten hit-test paint in browser order, but close an opacity group
      // only after all its contributing descendants have painted. Applying a
      // cumulative alpha to each fill would count a shared group twice.
      const mergeLayer = (src: Layer, opacity: number, below: Layer): Layer => {
        const a = src.a * opacity;
        if (opacity === 0) return below;
        return {
          r: src.r * opacity + below.r * (1 - a),
          g: src.g * opacity + below.g * (1 - a),
          b: src.b * opacity + below.b * (1 - a),
          a: a + below.a * (1 - a),
          sources: a >= 1 ? src.sources : [...below.sources, ...src.sources],
          unknown: src.unknown ?? (a >= 1 ? undefined : below.unknown),
        };
      };
      const opacityPaths = new Map<Element, Element[]>();
      const opacityPath = (element: Element): Element[] => {
        const cached = opacityPaths.get(element);
        if (cached !== undefined) return cached;
        const parent = element.parentElement;
        const path = parent === null ? [] : opacityPath(parent);
        const result =
          paintStyle(element).opacity < 1 ? [...path, element] : path;
        opacityPaths.set(element, result);
        return result;
      };
      const pseudoPaintCache = new Map<Element, string | undefined>();
      const pseudoPaint = (element: Element): string | undefined => {
        if (pseudoPaintCache.has(element)) return pseudoPaintCache.get(element);
        let reason: string | undefined;
        for (const pseudo of ["::before", "::after"]) {
          const style = getComputedStyle(element, pseudo);
          if (
            ["none", "normal"].includes(style.content) ||
            style.display === "none" ||
            style.visibility !== "visible" ||
            Number(style.opacity) === 0
          )
            continue;
          const border = ["top", "right", "bottom", "left"].some(
            (side) =>
              Number.parseFloat(
                style.getPropertyValue(`border-${side}-width`),
              ) > 0 &&
              !["none", "hidden"].includes(
                style.getPropertyValue(`border-${side}-style`),
              ) &&
              (parseRgba(style.getPropertyValue(`border-${side}-color`))?.a ??
                1) > 0,
          );
          if (
            (parseRgba(style.backgroundColor)?.a ?? 1) > 0 ||
            style.backgroundImage !== "none" ||
            border ||
            style.boxShadow !== "none" ||
            style.filter !== "none" ||
            (Number.parseFloat(style.outlineWidth) > 0 &&
              !["none", "hidden"].includes(style.outlineStyle))
          ) {
            reason = `unsupported pseudo-element paint on ${sourceSelector(element)}${pseudo}`;
            break;
          }
        }
        pseudoPaintCache.set(element, reason);
        return reason;
      };
      const insetCache = new Map<Element, ReturnType<typeof shadowLayers>>();
      const insetLayers = (element: Element) => {
        const cached = insetCache.get(element);
        if (cached !== undefined) return cached;
        const value = paintStyle(element).shadow;
        const raw = topLevelLayers(value);
        const layers = value.includes("inset")
          ? shadowLayers(value).filter((_layer, index) =>
              raw[index]?.includes("inset"),
            )
          : [];
        insetCache.set(element, layers);
        return layers;
      };
      const insetPaint = (
        element: Element,
        below: Layer,
        point?: { x: number; y: number },
      ): Layer => {
        const layers = insetLayers(element);
        if (layers.length === 0) return below;
        const style = paintStyle(element);
        const box = shadowRects.get(element);
        if (point === undefined || box === undefined)
          return {
            ...below,
            unknown: `inset shadow sample has no geometry on ${sourceSelector(element)}`,
          };
        const left = box.left + style.borders.left,
          right = box.right - style.borders.right;
        const top = box.top + style.borders.top,
          bottom = box.bottom - style.borders.bottom;
        if (
          point.x < left ||
          point.x >= right ||
          point.y < top ||
          point.y >= bottom
        )
          return below;
        let transformed = false;
        for (
          let ancestor: Element | null = element;
          ancestor !== null;
          ancestor = ancestor.parentElement
        ) {
          if (paintStyle(ancestor).transform !== "none") {
            transformed = true;
            break;
          }
        }
        let layer = below;
        // Inset shadows paint above backgrounds and below text/content. The
        // first CSS layer is uppermost, within the element's opacity group.
        for (const shadow of [...layers].reverse()) {
          if (shadow === undefined) {
            layer = {
              ...layer,
              unknown: `unparsed inset shadow on ${sourceSelector(element)}`,
            };
            continue;
          }
          if (shadow.color.a <= 0) continue;
          if (shadow.blur > 0 || style.rounded || transformed) {
            layer = {
              ...layer,
              unknown: `unsupported blurred, rounded or transformed inset shadow on ${sourceSelector(element)}`,
            };
            continue;
          }
          const holeLeft = left + shadow.spread + shadow.x,
            holeRight = right - shadow.spread + shadow.x;
          const holeTop = top + shadow.spread + shadow.y,
            holeBottom = bottom - shadow.spread + shadow.y;
          if (
            holeRight <= holeLeft ||
            holeBottom <= holeTop ||
            point.x < holeLeft ||
            point.x >= holeRight ||
            point.y < holeTop ||
            point.y >= holeBottom
          )
            layer = over(shadow.color, layer, element);
        }
        return layer;
      };
      const outerCache = new Map<Element, ReturnType<typeof shadowLayers>>();
      const outerLayers = (element: Element) => {
        const cached = outerCache.get(element);
        if (cached !== undefined) return cached;
        const value = paintStyle(element).shadow,
          raw = topLevelLayers(value);
        const layers = shadowLayers(value).filter(
          (_layer, index) => !raw[index]?.includes("inset"),
        );
        outerCache.set(element, layers);
        return layers;
      };
      let outerOwners: Element[] = [];
      const opaqueCoverAbove = (cover: Element, owner: Element): boolean => {
        const style = paintStyle(cover),
          fill = ownFill(cover);
        if (
          fill.color?.a !== 1 ||
          fill.image !== "none" ||
          style.masked ||
          style.effect !== undefined ||
          opacityPath(cover).length > 0
        )
          return false;
        if (owner.contains(cover))
          return !(style.position !== "static" && Number(style.zIndex) < 0);
        const source = paintStyle(owner);
        if (
          owner.parentElement !== cover.parentElement ||
          source.position === "static" ||
          style.position === "static" ||
          source.order !== style.order
        )
          return false;
        const sourceZ = source.zIndex === "auto" ? 0 : Number(source.zIndex);
        const coverZ = style.zIndex === "auto" ? 0 : Number(style.zIndex);
        return (
          coverZ > sourceZ ||
          (coverZ === sourceZ &&
            (owner.compareDocumentPosition(cover) &
              Node.DOCUMENT_POSITION_FOLLOWING) !==
              0)
        );
      };
      const offBoxShadow = (
        stack: Element[],
        point: { x: number; y: number },
        ignored: { owners?: Element[]; subtree?: Element },
      ): string | undefined => {
        for (const owner of outerOwners) {
          if (
            stack.includes(owner) ||
            ignored.owners?.includes(owner) ||
            ignored.subtree?.contains(owner)
          )
            continue;
          const box = shadowRects.get(owner);
          if (box === undefined) continue;
          // Compose the 2D chain's linear part (owner first, then each
          // ancestor) so local shadow offsets and blur map exactly; pure
          // translations stay identity. 3D or unparseable chains reach
          // everywhere.
          let transformed = false,
            unbounded = false;
          let linear = [1, 0, 0, 1];
          for (
            let ancestor: Element | null = owner;
            ancestor !== null;
            ancestor = ancestor.parentElement
          ) {
            const transform = paintStyle(ancestor).transform;
            if (transform === "none") continue;
            transformed = true;
            const entries = /^matrix\(([^)]*)\)$/
              .exec(transform)?.[1]
              ?.split(",")
              .map(Number);
            if (
              entries === undefined ||
              entries.length !== 6 ||
              !entries.every(Number.isFinite)
            ) {
              unbounded = true;
              break;
            }
            const [a, b, c, d] = entries as [number, number, number, number];
            const [p, q, r, s] = linear as [number, number, number, number];
            linear = [
              a * p + c * q,
              b * p + d * q,
              a * r + c * s,
              b * r + d * s,
            ];
          }
          // Rectangular outer shadows are knocked out of their owner's box.
          // Rounded/transformed geometry is retained as uncertain paint.
          if (
            !transformed &&
            !paintStyle(owner).rounded &&
            point.x >= box.left &&
            point.x < box.right &&
            point.y >= box.top &&
            point.y < box.bottom
          )
            continue;
          const contributes =
            unbounded ||
            outerLayers(owner).some((shadow) => {
              if (shadow === undefined) return true;
              if (shadow.color.a <= 0) return false;
              const blur = shadow.blur * 2;
              if (transformed) {
                const [a, b, c, d] = linear as [number, number, number, number];
                const extent = Math.max(0, shadow.spread + blur);
                const dx = a * shadow.x + c * shadow.y,
                  dy = b * shadow.x + d * shadow.y;
                const ex = (Math.abs(a) + Math.abs(c)) * extent,
                  ey = (Math.abs(b) + Math.abs(d)) * extent;
                return (
                  point.x >= box.left + dx - ex &&
                  point.x < box.right + dx + ex &&
                  point.y >= box.top + dy - ey &&
                  point.y < box.bottom + dy + ey
                );
              }
              const left = box.left + shadow.x - shadow.spread - blur,
                right = box.right + shadow.x + shadow.spread + blur;
              const top = box.top + shadow.y - shadow.spread - blur,
                bottom = box.bottom + shadow.y + shadow.spread + blur;
              return (
                right > left &&
                bottom > top &&
                point.x >= left &&
                point.x < right &&
                point.y >= top &&
                point.y < bottom
              );
            });
          if (
            !contributes ||
            stack.some((cover) => opaqueCoverAbove(cover, owner))
          )
            continue;
          return `off-box shadow paint from ${sourceSelector(owner)} cannot be resolved from the hit stack`;
        }
        return undefined;
      };
      const stackPaint = (
        stack: Element[],
        ink?: {
          owner: Element;
          color: Rgba;
          skipFill?: boolean;
          skipInset?: boolean;
        },
        point?: { x: number; y: number },
        ignoredOuter: { owners?: Element[]; subtree?: Element } = {},
      ): { color: Rgba; sources: Element[] } | { reason: string } => {
        if (point !== undefined) {
          const reason = offBoxShadow(stack, point, ignoredOuter);
          if (reason !== undefined) return { reason };
        }
        const groups: Array<{ owner?: Element; layer: Layer }> = [
          { layer: topLayer(canvasState) },
        ];
        const close = () => {
          const group = groups.pop() as (typeof groups)[number];
          const below = groups[groups.length - 1] as (typeof groups)[number];
          below.layer = mergeLayer(
            group.layer,
            paintStyle(group.owner as Element).opacity,
            below.layer,
          );
        };
        let effect: string | undefined;
        for (const element of [...stack].reverse()) {
          const path = opacityPath(element);
          let common = 0;
          while (
            common < path.length &&
            groups[common + 1]?.owner === path[common]
          )
            common++;
          while (groups.length > common + 1) close();
          for (const owner of path.slice(common))
            groups.push({ owner, layer: clear });
          const group = groups[groups.length - 1] as (typeof groups)[number];
          effect ??= stateFor(element).effect;
          const fill = ownFill(element);
          if (!(ink?.owner === element && ink.skipFill)) {
            if (fill.color === undefined)
              group.layer = {
                ...group.layer,
                unknown:
                  fill.reason ??
                  `unsupported background colour on ${sourceSelector(element)}`,
              };
            else group.layer = over(fill.color, group.layer, element);
            if (fill.image !== "none")
              group.layer = {
                ...group.layer,
                unknown: `background image on ${sourceSelector(element)}`,
              };
          }
          if (!(ink?.owner === element && ink.skipFill)) {
            const replaced = replacedPaint(element);
            if (replaced !== undefined)
              group.layer = { ...group.layer, unknown: replaced };
          }
          if (!(ink?.owner === element && (ink.skipInset || ink.skipFill)))
            group.layer = insetPaint(element, group.layer, point);
          if (ink?.owner === element)
            group.layer = over(ink.color, group.layer, element);
          const generated = pseudoPaint(element);
          if (generated !== undefined)
            group.layer = { ...group.layer, unknown: generated };
        }
        while (groups.length > 1) close();
        const layer = (groups[0] as (typeof groups)[number]).layer;
        const reason = effect ?? layer.unknown;
        if (reason !== undefined) return { reason };
        const a = layer.a > 0 ? layer.a : 1;
        return {
          color: { r: layer.r / a, g: layer.g / a, b: layer.b / a, a: 1 },
          sources: layer.sources,
        };
      };
      const rgbOf = (color: Rgba) => ({
        r: Math.min(255, Math.max(0, Math.round(color.r * 100) / 100)),
        g: Math.min(255, Math.max(0, Math.round(color.g * 100) / 100)),
        b: Math.min(255, Math.max(0, Math.round(color.b * 100) / 100)),
      });
      const sourceList = (sources: Element[]) => [
        ...new Set(
          sources.length === 0 ? ["canvas"] : sources.map(sourceSelector),
        ),
      ];
      const backgroundPaint = (element: Element) => {
        const resolved = resolveState(stateFor(element));
        return "reason" in resolved
          ? { status: "unavailable" as const, reason: resolved.reason }
          : {
              status: "measured" as const,
              color: rgbOf(resolved.color),
              sources: sourceList(resolved.sources),
            };
      };
      const primaryMarked = new Set<Element>();
      const isPrimaryAction = (element: Element): boolean => {
        const html = element as HTMLButtonElement;
        if (html.disabled === true || element.matches(":disabled"))
          return false;
        if (element.getAttribute("aria-disabled") === "true") return false;
        if (primaryMarked.has(element)) return true;
        if (
          (element instanceof HTMLButtonElement ||
            element instanceof HTMLInputElement) &&
          element.type === "submit" &&
          element.form !== null
        )
          return true;
        if (!["button", "link"].includes(implicitRole(element))) return false;
        return (
          element.getAttribute("data-primary") === "true" ||
          element.getAttribute("data-variant") === "primary"
        );
      };
      const textFill = (style: CSSStyleDeclaration) =>
        style.getPropertyValue("-webkit-text-fill-color") || style.color;
      // Label paint at each rendered text owner (child spans, literal
      // generated text, a submit input's value), over that owner's backdrop.
      const textPaint = (
        element: Element,
      ): NonNullable<NonNullable<ElementSignals["paint"]>["text"]> => {
        const samples: Array<{
          foreground: { r: number; g: number; b: number };
          background: { r: number; g: number; b: number };
          sources: string[];
        }> = [];
        const reasons: string[] = [];
        const sample = (
          owner: Element,
          color: string,
          opacity = 1,
          rects = [owner.getBoundingClientRect()],
        ) => {
          const ink = parseRgba(color);
          if (ink === undefined) {
            reasons.push(`unsupported text colour on ${sourceSelector(owner)}`);
            return;
          }
          let sampled = false;
          for (const rect of rects) {
            if (rect.width <= 0 || rect.height <= 0) continue;
            const x = rect.x + rect.width / 2;
            const y = rect.y + rect.height / 2;
            if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) continue;
            const stack = document.elementsFromPoint(x, y);
            const index = stack.indexOf(owner);
            if (index < 0) {
              reasons.push(
                `text owner is clipped or not hit-testable: ${sourceSelector(owner)}`,
              );
              continue;
            }
            // Descendants/siblings above this text may paint over it. We
            // cannot infer which glyphs they cover from a box hit test.
            if (
              stack.slice(0, index).some((node) => {
                const fill = ownFill(node);
                return (
                  replacedPaint(node) !== undefined ||
                  insetLayers(node).some(
                    (layer) => layer === undefined || layer.color.a > 0,
                  ) ||
                  fill.image !== "none" ||
                  (fill.color?.a ?? 1) > 0
                );
              })
            ) {
              reasons.push(
                `overlapping paint above text on ${sourceSelector(owner)}`,
              );
              continue;
            }
            const labelStack = stack.slice(index);
            const background = stackPaint(labelStack, undefined, { x, y });
            const foreground = stackPaint(
              labelStack,
              {
                owner,
                color: { ...ink, a: ink.a * opacity },
              },
              { x, y },
            );
            if ("reason" in background) reasons.push(background.reason);
            else if ("reason" in foreground) reasons.push(foreground.reason);
            else {
              sampled = true;
              samples.push({
                foreground: rgbOf(foreground.color),
                background: rgbOf(background.color),
                sources: sourceList([owner, ...background.sources]),
              });
            }
          }
          if (!sampled && reasons.length === 0)
            reasons.push(`no exposed text sample on ${sourceSelector(owner)}`);
        };
        if (element instanceof HTMLInputElement) {
          // A submit input without a value attribute renders a localized
          // browser label even though its IDL value is the empty string.
          if (
            element.value.trim() !== "" ||
            (element.type === "submit" && !element.hasAttribute("value"))
          )
            sample(element, textFill(getComputedStyle(element)));
        } else {
          const owners = new Set<Element>();
          const generated = (
            owner: Element,
            pseudo: "::before" | "::after",
          ) => {
            const style = getComputedStyle(owner, pseudo);
            const content = style.content;
            if (
              content === "none" ||
              content === "normal" ||
              style.display === "none" ||
              style.visibility !== "visible" ||
              Number(style.opacity) <= 0
            )
              return;
            const literal =
              /^("(?:[^"\\]|\\[\s\S])*"|'(?:[^'\\]|\\[\s\S])*')/.exec(content);
            if (literal === null) {
              reasons.push(
                `unsupported generated content in ${sourceSelector(owner)}${pseudo}`,
              );
              return;
            }
            if ((literal[1] ?? "").slice(1, -1).trim() === "") return;
            if ((parseRgba(style.backgroundColor)?.a ?? 1) > 0) {
              reasons.push(
                `generated content paints its own background in ${sourceSelector(owner)}${pseudo}`,
              );
              return;
            }
            sample(owner, textFill(style), Number(style.opacity));
          };
          const visit = (owner: Element) => {
            if (!isVisibleContent(owner, false)) return;
            generated(owner, "::before");
            for (const node of owner.childNodes) {
              if (node instanceof Element) visit(node);
              else if (
                node.nodeType === Node.TEXT_NODE &&
                node.textContent?.trim() &&
                !owners.has(owner)
              ) {
                const range = document.createRange();
                range.selectNodeContents(node);
                if (
                  [...range.getClientRects()].some(
                    (rect) => rect.width > 0 && rect.height > 0,
                  )
                ) {
                  owners.add(owner);
                  sample(owner, textFill(getComputedStyle(owner)), 1, [
                    ...range.getClientRects(),
                  ]);
                }
              }
            }
            generated(owner, "::after");
          };
          visit(element);
        }
        if (reasons.length > 0)
          return {
            status: "unavailable",
            reason: [...new Set(reasons)].slice(0, 3).join("; "),
          };
        return samples.length === 0
          ? { status: "none" }
          : { status: "measured", samples };
      };
      const paintSignals = (
        element: Element,
      ): NonNullable<ElementSignals["paint"]> => {
        const style = paintStyle(element);
        const fill = parseRgba(style.background);
        const primaryAction = isPrimaryAction(element);
        return {
          background: backgroundPaint(element),
          surface:
            style.image !== "none" || fill === undefined || fill.a > 0.05,
          primaryAction,
          ...(primaryAction
            ? {
                text: {
                  status: "unavailable" as const,
                  reason: "text paint sampling pending",
                },
              }
            : {}),
        };
      };
      // Icon-like ink: a top-level svg, <i>, an icon class or data-icon, or
      // an element whose own text is only symbols. Mirrors alarm-at-rest.
      const isIconLike = (element: Element): boolean => {
        const tag = element.tagName.toLowerCase();
        if (tag === "svg") return element.parentElement?.closest("svg") == null;
        if (element.closest("svg") !== null) return false;
        if (tag === "i" || element.hasAttribute("data-icon")) return true;
        const className = element.getAttribute("class") ?? "";
        if (/icon/i.test(className)) return true;
        const direct = [...element.childNodes]
          .filter((node) => node.nodeType === Node.TEXT_NODE)
          .map((node) => node.textContent ?? "")
          .join("")
          .replace(/\s|\uFE0E|\uFE0F/g, "");
        return (
          direct !== "" &&
          [...direct].length <= 3 &&
          !/[\p{L}\p{N}]/u.test(direct)
        );
      };
      const alarmContext = (element: Element): boolean => {
        if (
          element.closest(
            '[aria-invalid="true"], [role="alert"], [role="alertdialog"], [aria-live="assertive"]',
          ) !== null
        )
          return true;
        const messages = new Set<string>();
        for (const invalid of document.querySelectorAll(
          '[aria-invalid="true"]',
        ))
          for (const name of ["aria-describedby", "aria-errormessage"])
            for (const id of (invalid.getAttribute(name) ?? "").split(/\s+/))
              if (id) messages.add(id);
        let current: Element | null = element;
        for (let depth = 0; current !== null && depth <= 3; depth += 1) {
          if (current.id && messages.has(current.id)) return true;
          current = current.parentElement;
        }
        return false;
      };
      const iconHint = (element: Element): string => {
        const use = element.querySelector("use");
        const href =
          use?.getAttribute("href") ?? use?.getAttribute("xlink:href") ?? "";
        return [
          element.getAttribute("data-icon"),
          element.getAttribute("data-lucide"),
          element.getAttribute("class"),
          element.getAttribute("aria-label"),
          element.getAttribute("title"),
          href.includes("#") ? href.slice(href.indexOf("#") + 1) : "",
        ]
          .filter((value): value is string => !!value?.trim())
          .join(" ")
          .replace(/\s+/g, " ")
          .trim()
          .toLowerCase()
          .slice(0, 120);
      };
      const signalsFor = (element: Element, rect: DOMRect) => {
        const styles = getComputedStyle(element);
        const px = (value: string) => Number.parseFloat(value) || 0;
        const geometry = textGeometry(element);
        const title = element.getAttribute("title")?.trim();
        const href = element.getAttribute("href") ?? undefined;
        const controls = element.getAttribute("aria-controls") ?? undefined;
        const haspopup = element.getAttribute("aria-haspopup") ?? undefined;
        const nodeId = element.getAttribute("data-node-id") ?? undefined;
        return {
          role: implicitRole(element),
          name: accessibleName(element),
          described: describedElsewhere(element),
          explanation: explanationFor(element),
          ...(title ? { title } : {}),
          ...(href === undefined ? {} : { href }),
          ...(controls === undefined ? {} : { controls }),
          ...(haspopup === undefined ? {} : { haspopup }),
          appearance: styles.appearance,
          cursor: styles.cursor,
          hasGraphic:
            element.querySelector(
              "svg, img, i, [class*='icon'], [data-icon]",
            ) !== null ||
            ["svg", "img"].includes(element.tagName.toLowerCase()),
          renderedContent: renderedContent(element),
          lineCount: geometry.lineCount,
          ...(geometry.textRect === undefined
            ? {}
            : { textRect: geometry.textRect }),
          ...(geometry.inkCenterY === undefined
            ? {}
            : { inkCenterY: geometry.inkCenterY }),
          labelInk: labelInk(element),
          contentBox: {
            x: rect.x + px(styles.borderLeftWidth) + px(styles.paddingLeft),
            y: rect.y + px(styles.borderTopWidth) + px(styles.paddingTop),
            width: Math.max(
              0,
              rect.width -
                px(styles.borderLeftWidth) -
                px(styles.borderRightWidth) -
                px(styles.paddingLeft) -
                px(styles.paddingRight),
            ),
            height: Math.max(
              0,
              rect.height -
                px(styles.borderTopWidth) -
                px(styles.borderBottomWidth) -
                px(styles.paddingTop) -
                px(styles.paddingBottom),
            ),
          },
          transition: `${styles.transitionProperty} ${styles.transitionDuration}`,
          animation: `${styles.animationName} ${styles.animationDuration}`,
          motion: {
            transitionProperty: styles.transitionProperty,
            transitionDuration: styles.transitionDuration,
            transitionDelay: styles.transitionDelay,
            animationName: styles.animationName,
            animationDuration: styles.animationDuration,
            animationDelay: styles.animationDelay,
            animationIterationCount: styles.animationIterationCount,
            animationPlayState: styles.animationPlayState,
          },
          ...(nodeId === undefined ? {} : { nodeId }),
          focused: document.activeElement === element,
          repeatedItem: isRepeatedItem(element),
          ...(adornments.has(element)
            ? { adornment: adornments.get(element) }
            : {}),
          ...(isSelectLike(element) ? { value: displayValue(element) } : {}),
          paint: paintSignals(element),
          ...(isIconLike(element)
            ? (() => {
                const hint = iconHint(element);
                return {
                  alarm: {
                    context: alarmContext(element),
                    ...(hint === "" ? {} : { iconHint: hint }),
                  },
                };
              })()
            : {}),
        };
      };
      type Adornment = NonNullable<ElementSignals["adornment"]>;
      const isSelectLike = (element: Element): boolean => {
        const tag = element.tagName.toLowerCase();
        const role = implicitRole(element);
        if (tag === "select" || role === "combobox") return true;
        return (
          (tag === "button" || role === "button") &&
          ["listbox", "menu", "true"].includes(
            (element.getAttribute("aria-haspopup") ?? "").toLowerCase(),
          )
        );
      };
      // What a select-like control shows: the selected option of a native
      // select, an input combobox's value, otherwise its rendered text.
      const displayValue = (element: Element): string => {
        const raw =
          element instanceof HTMLSelectElement
            ? (element.selectedOptions[0]?.text ?? "")
            : element instanceof HTMLInputElement
              ? element.value
              : element instanceof HTMLElement
                ? element.innerText
                : (element.textContent ?? "");
        return raw.replace(/\s+/g, " ").trim().slice(0, 40);
      };
      const topLevelLayers = (value: string): string[] => {
        const layers: string[] = [];
        let depth = 0;
        let start = 0;
        for (let index = 0; index < value.length; index += 1) {
          const character = value[index];
          if (character === "(") depth += 1;
          else if (character === ")") depth -= 1;
          else if (character === "," && depth === 0) {
            layers.push(value.slice(start, index).trim());
            start = index + 1;
          }
        }
        layers.push(value.slice(start).trim());
        return layers;
      };
      const layerOf = (value: string, index: number): string => {
        const layers = topLevelLayers(value);
        return layers[index % layers.length] ?? "";
      };
      // One axis of a computed background-position layer, as an offset from
      // the positioning area's start edge. Undefined when the form is unknown.
      const positionOffset = (
        value: string,
        area: number,
        image: number,
        start: string,
        end: string,
      ): number | undefined => {
        const free = area - image;
        const length = (amount: string, unit: string) =>
          unit === "%" ? (free * Number(amount)) / 100 : Number(amount);
        const plain = value.match(/^(-?[\d.]+)(px|%)$/);
        if (plain !== null) return length(plain[1] ?? "", plain[2] ?? "");
        const calc = value.match(/^calc\((-?[\d.]+)% ([+-]) ([\d.]+)px\)$/);
        if (calc !== null) {
          const [, percent, sign, pixels] = calc;
          return (
            (free * Number(percent)) / 100 +
            (sign === "-" ? -1 : 1) * Number(pixels)
          );
        }
        const keyword = value.match(
          /^(left|right|top|bottom|center)(?:\s+(-?[\d.]+)(px|%))?$/,
        );
        if (keyword === null) return undefined;
        const [, edge, amount, unit] = keyword;
        const offset = amount === undefined ? 0 : length(amount, unit ?? "px");
        if (edge === "center")
          return amount === undefined ? free / 2 : undefined;
        if (edge === start) return offset;
        if (edge === end) return free - offset;
        return undefined;
      };
      const imageSize = async (
        url: string,
      ): Promise<{ width: number; height: number }> => {
        const image = new Image();
        image.src = url;
        await Promise.race([
          image.decode().catch(() => undefined),
          new Promise((resolve) => setTimeout(resolve, 500)),
        ]);
        return { width: image.naturalWidth, height: image.naturalHeight };
      };
      // A select chevron painted as a background image is not an element;
      // measure its rect from computed background geometry, or say why not.
      const measureAdornment = async (element: Element): Promise<Adornment> => {
        const styles = getComputedStyle(element);
        const unmeasured = (reason: string): Adornment => ({
          status: "unmeasured",
          reason,
        });
        if (styles.backgroundImage && styles.backgroundImage !== "none") {
          const layers = topLevelLayers(styles.backgroundImage);
          const urls = layers.flatMap((layer, index) =>
            /^url\(/i.test(layer) ? [index] : [],
          );
          const others = layers.filter(
            (layer) => !/^url\(/i.test(layer) && !/gradient\(/i.test(layer),
          );
          const index = urls[0];
          if (urls.length !== 1 || others.length > 0 || index === undefined)
            return unmeasured("multiple or gradient-drawn background layers");
          const repeat = layerOf(styles.backgroundRepeat, index);
          if (!repeat.split(/\s+/).every((part) => part === "no-repeat"))
            return unmeasured("repeating background image");
          if (layerOf(styles.backgroundOrigin, index) !== "padding-box")
            return unmeasured("background-origin is not padding-box");
          const rect = element.getBoundingClientRect();
          const px = (value: string) => Number.parseFloat(value) || 0;
          const area = {
            x: rect.left + px(styles.borderLeftWidth),
            y: rect.top + px(styles.borderTopWidth),
            width:
              rect.width -
              px(styles.borderLeftWidth) -
              px(styles.borderRightWidth),
            height:
              rect.height -
              px(styles.borderTopWidth) -
              px(styles.borderBottomWidth),
          };
          const url = (layers[index] ?? "")
            .replace(/^url\(\s*(['"]?)/i, "")
            .replace(/(['"]?)\s*\)$/, "");
          const size = layerOf(styles.backgroundSize, index)
            .split(/\s+/)
            .filter((part) => part !== "");
          const dimension = (part: string | undefined, total: number) => {
            if (part === undefined || part === "auto") return undefined;
            const match = part.match(/^([\d.]+)(px|%)$/);
            if (match === null) return Number.NaN;
            return match[2] === "%"
              ? (total * Number(match[1])) / 100
              : Number(match[1]);
          };
          let width: number | undefined;
          let height: number | undefined;
          const [first, second] = size;
          if (first === "contain" || first === "cover") {
            const natural = await imageSize(url);
            if (natural.width <= 0 || natural.height <= 0)
              return unmeasured("background image has no intrinsic size");
            const scale = (first === "contain" ? Math.min : Math.max)(
              area.width / natural.width,
              area.height / natural.height,
            );
            width = natural.width * scale;
            height = natural.height * scale;
          } else {
            width = dimension(first, area.width);
            height = dimension(second, area.height);
            if (Number.isNaN(width) || Number.isNaN(height))
              return unmeasured("unparsed background-size");
            if (width === undefined || height === undefined) {
              const natural = await imageSize(url);
              if (natural.width <= 0 || natural.height <= 0)
                return unmeasured("background image has no intrinsic size");
              if (width === undefined && height === undefined) {
                width = natural.width;
                height = natural.height;
              } else if (width === undefined)
                width = ((height as number) * natural.width) / natural.height;
              else height = (width * natural.height) / natural.width;
            }
          }
          const x = positionOffset(
            layerOf(styles.backgroundPositionX, index),
            area.width,
            width as number,
            "left",
            "right",
          );
          const y = positionOffset(
            layerOf(styles.backgroundPositionY, index),
            area.height,
            height as number,
            "top",
            "bottom",
          );
          if (x === undefined || y === undefined)
            return unmeasured("unparsed background-position");
          return {
            status: "measured",
            source: "background",
            rect: {
              x: area.x + x,
              y: area.y + y,
              width: width as number,
              height: height as number,
            },
          };
        }
        for (const pseudo of ["::before", "::after"]) {
          const content = getComputedStyle(element, pseudo).content;
          if (content !== "none" && content !== "normal")
            return unmeasured("pseudo-element chevron");
        }
        return { status: "none" };
      };
      const all = [
        document.documentElement,
        document.body,
        ...document.body.querySelectorAll("*"),
      ];
      const structuralPaths = elementPaths(all);
      const renderedPaths = elementPaths(all.filter(isRendered));
      const adornments = new Map<Element, Adornment>();
      for (const element of all)
        if (renderedPaths.has(element) && isSelectLike(element))
          adornments.set(element, await measureAdornment(element));
      const markMatches = markInput.map((mark) => {
        try {
          return {
            mark,
            elements: [...document.querySelectorAll(mark.selector)],
          };
        } catch {
          return { mark, elements: [], invalid: true as const };
        }
      });
      for (const { mark, elements } of markMatches)
        if (mark.purpose === "primary-action")
          for (const element of elements) primaryMarked.add(element);
      const observed = all.map((element) => {
        const html = element as HTMLElement;
        const styles = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        const visible = renderedPaths.has(element);
        const tag = element.tagName.toLowerCase();
        const interactive = isInteractive(element);
        let outOfFlow = false;
        const ancestors: string[] = [];
        let current: Element | null = element;
        while (current !== null && current !== document.body) {
          const position = getComputedStyle(current).position;
          if (["absolute", "fixed", "sticky"].includes(position))
            outOfFlow = true;
          const currentRect = current.getBoundingClientRect();
          if (
            currentRect.right <= 0 ||
            currentRect.bottom <= 0 ||
            currentRect.left >= innerWidth ||
            currentRect.top >= innerHeight
          )
            outOfFlow = true;
          if (current !== element) ancestors.push(selectorFor(current));
          current = current.parentElement;
        }
        const heading = /^h[1-6]$/.test(tag) ? Number(tag.slice(1)) : undefined;
        const authoredProperties = new Set<string>();
        for (const property of html.style)
          authoredProperties.add(camelCase(property));
        for (const rule of authoredRules) {
          try {
            if (!element.matches(rule.selector)) continue;
            for (const property of rule.style)
              authoredProperties.add(camelCase(property));
          } catch {
            // Invalid vendor selectors are ignored by the observation probe.
          }
        }
        for (const property of ["fill", "stroke"])
          if (element.hasAttribute(property)) authoredProperties.add(property);
        const structuralPath = structuralPaths.get(element);
        if (structuralPath === undefined)
          throw new Error("element is missing its structural path");
        const legacyRenderedPath = renderedPaths.get(element);
        const directText = [...element.childNodes]
          .filter((node) => node.nodeType === Node.TEXT_NODE)
          .map((node) => node.textContent ?? "")
          .join(" ")
          .replace(/\s+/g, " ")
          .trim();
        const attributes = Object.fromEntries(
          [...element.attributes]
            .filter((attribute) => allowedAttributes.has(attribute.name))
            .sort((left, right) => left.name.localeCompare(right.name))
            .map((attribute) => [attribute.name, attribute.value]),
        );
        let stableIsland: Element = document.body;
        let islandCandidate: Element | null = element;
        while (islandCandidate !== null) {
          if (
            [
              "main",
              "section",
              "article",
              "nav",
              "header",
              "footer",
              "form",
            ].includes(islandCandidate.tagName.toLowerCase()) ||
            islandCandidate.hasAttribute("role") ||
            islandCandidate.hasAttribute("data-testid") ||
            islandCandidate.hasAttribute("data-test")
          ) {
            stableIsland = islandCandidate;
            break;
          }
          islandCandidate = islandCandidate.parentElement;
        }
        const islandRect = stableIsland.getBoundingClientRect();
        return {
          element,
          value: {
            selector: selectorFor(element),
            tag,
            text: (html.innerText ?? element.textContent ?? "")
              .trim()
              .slice(0, 500),
            visible,
            interactive,
            enabled:
              !(html as HTMLButtonElement).disabled &&
              element.getAttribute("aria-disabled") !== "true",
            ...(heading === undefined ? {} : { headingLevel: heading }),
            rect: {
              x: rect.x,
              y: rect.y,
              width: rect.width,
              height: rect.height,
            },
            scrollWidth: html.scrollWidth,
            scrollHeight: html.scrollHeight,
            clientWidth: html.clientWidth,
            clientHeight: html.clientHeight,
            outOfFlow,
            inlineTextTarget:
              tag === "a" &&
              styles.display === "inline" &&
              [
                styles.paddingTop,
                styles.paddingRight,
                styles.paddingBottom,
                styles.paddingLeft,
              ].every((padding) => Number.parseFloat(padding) === 0),
            ancestorSelectors: ancestors,
            authoredProperties: [...authoredProperties].sort(),
            structuralPath,
            ...(legacyRenderedPath === undefined ? {} : { legacyRenderedPath }),
            directText,
            attributes,
            temporal: temporalPattern.test(
              `${directText} ${(html.innerText ?? "").slice(0, 500)}`,
            ),
            stableIslandPath:
              structuralPaths.get(stableIsland) ?? structuralPath,
            relativeRect: {
              x: rect.x - islandRect.x,
              y: rect.y - islandRect.y,
              width: rect.width,
              height: rect.height,
            },
            styles: {
              color: styles.color,
              backgroundColor: styles.backgroundColor,
              borderTopColor: styles.borderTopColor,
              borderRightColor: styles.borderRightColor,
              borderBottomColor: styles.borderBottomColor,
              borderLeftColor: styles.borderLeftColor,
              borderTopWidth: styles.borderTopWidth,
              borderRightWidth: styles.borderRightWidth,
              borderBottomWidth: styles.borderBottomWidth,
              borderLeftWidth: styles.borderLeftWidth,
              outlineColor: styles.outlineColor,
              outlineWidth: styles.outlineWidth,
              outlineStyle: styles.outlineStyle,
              outlineOffset: styles.outlineOffset,
              textOverflow: styles.textOverflow,
              fill: styles.fill,
              stroke: styles.stroke,
              borderTopLeftRadius: styles.borderTopLeftRadius,
              borderTopRightRadius: styles.borderTopRightRadius,
              borderBottomRightRadius: styles.borderBottomRightRadius,
              borderBottomLeftRadius: styles.borderBottomLeftRadius,
              overflowX: styles.overflowX,
              overflowY: styles.overflowY,
              position: styles.position,
              display: styles.display,
              visibility: styles.visibility,
              opacity: styles.opacity,
              fontFamily: styles.fontFamily,
              fontSize: styles.fontSize,
              fontWeight: styles.fontWeight,
              lineHeight: styles.lineHeight,
              letterSpacing: styles.letterSpacing,
              textAlign: styles.textAlign,
              textDecorationLine: styles.textDecorationLine,
              textTransform: styles.textTransform,
              whiteSpace: styles.whiteSpace,
              wordBreak: styles.wordBreak,
              paddingTop: styles.paddingTop,
              paddingRight: styles.paddingRight,
              paddingBottom: styles.paddingBottom,
              paddingLeft: styles.paddingLeft,
              marginTop: styles.marginTop,
              marginRight: styles.marginRight,
              marginBottom: styles.marginBottom,
              marginLeft: styles.marginLeft,
              gap: styles.gap,
              flexDirection: styles.flexDirection,
              justifyContent: styles.justifyContent,
              alignItems: styles.alignItems,
              gridTemplateColumns: styles.gridTemplateColumns,
              boxShadow: styles.boxShadow,
              transform: styles.transform,
              zIndex: styles.zIndex,
            },
            hitTestWith: [] as string[],
            ...(visible && element !== document.documentElement
              ? { signals: signalsFor(element, rect) }
              : {}),
          },
        };
      });
      const interactive = observed.filter(
        (entry) => entry.value.visible && entry.value.interactive,
      );
      for (let leftIndex = 0; leftIndex < interactive.length; leftIndex += 1) {
        const left = interactive[leftIndex];
        if (left === undefined) continue;
        for (
          let rightIndex = leftIndex + 1;
          rightIndex < interactive.length;
          rightIndex += 1
        ) {
          const right = interactive[rightIndex];
          if (
            right === undefined ||
            left.element.contains(right.element) ||
            right.element.contains(left.element)
          )
            continue;
          const a = left.value.rect;
          const b = right.value.rect;
          const x1 = Math.max(a.x, b.x);
          const y1 = Math.max(a.y, b.y);
          const x2 = Math.min(a.x + a.width, b.x + b.width);
          const y2 = Math.min(a.y + a.height, b.y + b.height);
          if (x2 <= x1 || y2 <= y1) continue;
          const x = Math.max(0, Math.min(innerWidth - 1, (x1 + x2) / 2));
          const y = Math.max(0, Math.min(innerHeight - 1, (y1 + y2) / 2));
          const hits = document.elementsFromPoint(x, y);
          if (
            hits.some(
              (hit) => hit === left.element || left.element.contains(hit),
            ) &&
            hits.some(
              (hit) => hit === right.element || right.element.contains(hit),
            )
          ) {
            left.value.hitTestWith.push(right.value.selector);
            right.value.hitTestWith.push(left.value.selector);
          }
        }
      }
      const pxOf = (value: string) => Number.parseFloat(value) || 0;
      type Edges = { left: number; top: number; right: number; bottom: number };
      const edgesOf = (rect: {
        x: number;
        y: number;
        width: number;
        height: number;
      }): Edges => ({
        left: rect.x,
        top: rect.y,
        right: rect.x + rect.width,
        bottom: rect.y + rect.height,
      });
      const intersectEdges = (a: Edges, b: Edges): Edges => ({
        left: Math.max(a.left, b.left),
        top: Math.max(a.top, b.top),
        right: Math.min(a.right, b.right),
        bottom: Math.min(a.bottom, b.bottom),
      });
      const areaOf = (edges: Edges) =>
        Math.max(0, edges.right - edges.left) *
        Math.max(0, edges.bottom - edges.top);
      const rectOf = (edges: Edges) => ({
        x: edges.left,
        y: edges.top,
        width: Math.max(0, edges.right - edges.left),
        height: Math.max(0, edges.bottom - edges.top),
      });
      /**
       * The clip boxes around an element. `paint` is what a reader can see:
       * every hidden, clipped, scrolling or paint-contained box intersected.
       * `hidden` counts only boxes that cut content off for good, and ends on
       * an axis at a scroll container (content past it scrolls into view).
       * Absolutely positioned content escapes overflow boxes below its
       * containing block; fixed content escapes up to its fixed containing
       * block (or the viewport). The root and body
       * propagate overflow to the viewport, so they never clip here.
       */
      const clipFor = (element: Element, includeSelf: boolean) => {
        const unbounded = (): Edges => ({
          left: Number.NEGATIVE_INFINITY,
          top: Number.NEGATIVE_INFINITY,
          right: Number.POSITIVE_INFINITY,
          bottom: Number.POSITIVE_INFINITY,
        });
        const paint = unbounded();
        const hidden = unbounded();
        const hiddenOwners: Partial<Record<keyof Edges, Element>> = {};
        let ownerX: Element | undefined;
        let ownerY: Element | undefined;
        let scrollsX = false;
        let scrollsY = false;
        let escaping: "absolute" | "fixed" | undefined;
        for (
          let current: Element | null = element;
          current !== null &&
          current !== document.body &&
          current !== document.documentElement;
          current = current.parentElement
        ) {
          const style = getComputedStyle(current);
          // Transforms and layout/paint containment establish containing
          // blocks even without position:relative. Fixed descendants skip
          // ordinary positioned ancestors, but not these boundaries.
          const fixedContainingBlock =
            style.transform !== "none" ||
            style.perspective !== "none" ||
            [style.translate, style.rotate, style.scale].some(
              (value) => value && value !== "none",
            ) ||
            style.filter !== "none" ||
            (style.backdropFilter !== "" && style.backdropFilter !== "none") ||
            /\b(?:layout|paint|strict|content)\b/.test(style.contain) ||
            /\b(?:transform|translate|rotate|scale|perspective|filter|backdrop-filter|contain)\b/.test(
              style.willChange,
            ) ||
            ["auto", "hidden"].includes(style.contentVisibility);
          if (
            escaping !== undefined &&
            (fixedContainingBlock ||
              (escaping === "absolute" && style.position !== "static"))
          )
            escaping = undefined;
          if (escaping === undefined && (current !== element || includeSelf)) {
            const contained = /\b(?:paint|strict|content)\b/.test(
              style.contain,
            );
            const rect = current.getBoundingClientRect();
            const box: Edges = {
              left: rect.left + pxOf(style.borderLeftWidth),
              top: rect.top + pxOf(style.borderTopWidth),
              right: rect.right - pxOf(style.borderRightWidth),
              bottom: rect.bottom - pxOf(style.borderBottomWidth),
            };
            const cutsX =
              contained || ["hidden", "clip"].includes(style.overflowX);
            const cutsY =
              contained || ["hidden", "clip"].includes(style.overflowY);
            const scrollX = ["auto", "scroll"].includes(style.overflowX);
            const scrollY = ["auto", "scroll"].includes(style.overflowY);
            if (cutsX || scrollX) {
              paint.left = Math.max(paint.left, box.left);
              paint.right = Math.min(paint.right, box.right);
            }
            if (cutsY || scrollY) {
              paint.top = Math.max(paint.top, box.top);
              paint.bottom = Math.min(paint.bottom, box.bottom);
            }
            if (cutsX && !scrollsX) {
              if (box.left > hidden.left) {
                hidden.left = box.left;
                hiddenOwners.left = current;
              }
              if (box.right < hidden.right) {
                hidden.right = box.right;
                hiddenOwners.right = current;
              }
              ownerX ??= current;
            }
            if (cutsY && !scrollsY) {
              if (box.top > hidden.top) {
                hidden.top = box.top;
                hiddenOwners.top = current;
              }
              if (box.bottom < hidden.bottom) {
                hidden.bottom = box.bottom;
                hiddenOwners.bottom = current;
              }
              ownerY ??= current;
            }
            if (scrollX) scrollsX = true;
            if (scrollY) scrollsY = true;
          }
          if (
            escaping === undefined &&
            (style.position === "absolute" || style.position === "fixed")
          )
            escaping = style.position;
        }
        return { paint, hidden, hiddenOwners, ownerX, ownerY };
      };
      const viewportEdges: Edges = {
        left: 0,
        top: 0,
        right: innerWidth,
        bottom: innerHeight,
      };
      const textFragments = (element: Element): DOMRect[] => {
        const fragments: DOMRect[] = [];
        for (const node of element.childNodes) {
          if (node.nodeType !== Node.TEXT_NODE || !node.textContent?.trim())
            continue;
          const range = document.createRange();
          range.selectNodeContents(node);
          for (const rect of range.getClientRects())
            if (rect.width > 0 && rect.height > 0) fragments.push(rect);
        }
        return fragments;
      };
      // A font's content area runs well past its glyphs (ascender and
      // descender space). Tight leading overlaps neighbouring content areas
      // and a box may trim them without cutting ink, so text geometry is
      // measured on the band between, inset a fifth of the height each side.
      const inkBand = (rect: DOMRect): Edges => ({
        left: rect.left,
        right: rect.right,
        top: rect.top + rect.height * 0.2,
        bottom: rect.bottom - rect.height * 0.2,
      });
      const layerRoot = (element: Element): Element => {
        for (
          let current: Element | null = element;
          current !== null;
          current = current.parentElement
        ) {
          const role = current.getAttribute("role") ?? "";
          const position = getComputedStyle(current).position;
          const box = current.getBoundingClientRect();
          // Large absolute panels are commonly stacked illustration cards or
          // overlay sheets. Keep their contents together, while small pinned
          // clusters and interactive elements still participate in collisions.
          const absolutePanel =
            position === "absolute" &&
            !isInteractive(current) &&
            current.children.length > 0 &&
            box.width >= 120 &&
            box.height >= 120;
          if (
            ["dialog", "alertdialog", "menu", "listbox", "tooltip"].includes(
              role,
            ) ||
            current.tagName.toLowerCase() === "dialog" ||
            position === "fixed" ||
            absolutePanel
          )
            return current;
          try {
            if (current.matches(":popover-open")) return current;
          } catch {
            // :popover-open is unsupported; popovers fall back to role.
          }
        }
        return document.documentElement;
      };
      // Overlaps: the interactive hit test above, widened to text, sampled
      // across the intersection and bounded by what is actually visible.
      // pointer-events:none text never hit-tests, so its overlaps go
      // unreported (a deliberate false-negative bias).
      const interactiveElements = new Set(
        interactive.map((entry) => entry.element),
      );
      const insideInteractive = (element: Element) => {
        for (
          let current = element.parentElement;
          current !== null;
          current = current.parentElement
        )
          if (interactiveElements.has(current)) return true;
        return false;
      };
      type OverlapCandidate = {
        element: Element;
        selector: string;
        kind: "interactive" | "text";
        boxes: Edges[];
        bounds: Edges;
        partial: boolean;
        layer: Element;
        text: string;
      };
      const overlapCandidates: OverlapCandidate[] = [];
      for (const { element, value } of observed) {
        if (!value.visible || element === document.body) continue;
        const kind = value.interactive
          ? ("interactive" as const)
          : value.directText !== "" &&
              !["option", "input", "textarea", "select"].includes(value.tag) &&
              value.styles.display !== "contents" &&
              !insideInteractive(element)
            ? ("text" as const)
            : undefined;
        if (kind === undefined || !isVisibleContent(element)) continue;
        const clip = clipFor(element, kind === "text");
        const raw =
          kind === "interactive"
            ? [...element.getClientRects()].map(edgesOf)
            : textFragments(element).map(inkBand);
        const boxes = raw
          .map((box) => intersectEdges(box, clip.paint))
          .filter(
            (box) => box.right - box.left > 0 && box.bottom - box.top > 0,
          );
        if (boxes.length === 0) continue;
        const clipped = intersectEdges(edgesOf(value.rect), clip.paint);
        const onScreen = intersectEdges(clipped, viewportEdges);
        // Preserve below-fold geometry, but mark a box crossing the viewport
        // edge as partial when some of it is actually on screen.
        const own = areaOf(onScreen) > 0 ? onScreen : clipped;
        const outer = edgesOf(value.rect);
        overlapCandidates.push({
          element,
          selector: value.selector,
          kind,
          boxes,
          bounds: {
            left: Math.min(...boxes.map((box) => box.left)),
            top: Math.min(...boxes.map((box) => box.top)),
            right: Math.max(...boxes.map((box) => box.right)),
            bottom: Math.max(...boxes.map((box) => box.bottom)),
          },
          partial:
            own.left - outer.left > 1 ||
            own.top - outer.top > 1 ||
            outer.right - own.right > 1 ||
            outer.bottom - own.bottom > 1,
          layer: layerRoot(element),
          text: kind === "text" ? value.directText : "",
        });
      }
      overlapCandidates.sort((a, b) => a.bounds.left - b.bounds.left);
      const holds = (owner: Element, hits: Element[]) =>
        hits.some((hit) => hit === owner || owner.contains(hit));
      const overlaps: Array<{
        a: string;
        b: string;
        kinds: ["interactive" | "text", "interactive" | "text"];
        rect: Rect;
        partial: string[];
        samples: number;
        hits: number;
      }> = [];
      for (let index = 0; index < overlapCandidates.length; index += 1) {
        const left = overlapCandidates[index] as OverlapCandidate;
        for (let next = index + 1; next < overlapCandidates.length; next += 1) {
          const right = overlapCandidates[next] as OverlapCandidate;
          if (right.bounds.left >= left.bounds.right) break;
          if (
            right.bounds.top >= left.bounds.bottom ||
            left.bounds.top >= right.bounds.bottom ||
            left.element.contains(right.element) ||
            right.element.contains(left.element) ||
            left.layer !== right.layer ||
            (left.element instanceof HTMLLabelElement &&
              left.element.control === right.element) ||
            (right.element instanceof HTMLLabelElement &&
              right.element.control === left.element)
          )
            continue;
          let best: Edges | undefined;
          for (const first of left.boxes)
            for (const second of right.boxes) {
              const shared = intersectEdges(first, second);
              if (
                shared.right - shared.left >= 1 &&
                shared.bottom - shared.top >= 1 &&
                (best === undefined || areaOf(shared) > areaOf(best))
              )
                best = shared;
            }
          if (best === undefined) continue;
          // Text laid exactly over a copy of itself is a decorative double
          // (gradient or shimmer layers), not a collision.
          if (
            left.text !== "" &&
            left.text === right.text &&
            areaOf(intersectEdges(left.bounds, right.bounds)) >=
              0.9 * Math.min(areaOf(left.bounds), areaOf(right.bounds))
          )
            continue;
          const sampled = intersectEdges(best, viewportEdges);
          const axis = (from: number, to: number) => {
            const span = to - from - 1;
            if (span < 0) return [];
            const count = Math.min(5, Math.floor(span / 2) + 1);
            return count <= 1
              ? [(from + to) / 2]
              : Array.from(
                  { length: count },
                  (_, step) => from + 0.5 + (span * step) / (count - 1),
                );
          };
          let samples = 0;
          let hits = 0;
          for (const x of axis(sampled.left, sampled.right))
            for (const y of axis(sampled.top, sampled.bottom)) {
              samples += 1;
              const stack = document.elementsFromPoint(x, y);
              if (holds(left.element, stack) && holds(right.element, stack))
                hits += 1;
            }
          if (samples > 0 && hits === 0) continue;
          const [a, b] =
            left.selector < right.selector ? [left, right] : [right, left];
          overlaps.push({
            a: a.selector,
            b: b.selector,
            kinds: [a.kind, b.kind],
            rect: rectOf(best),
            partial: [a, b]
              .filter((member) => member.partial)
              .map((member) => member.selector),
            samples,
            hits,
          });
        }
      }
      overlaps.sort((x, y) =>
        x.a === y.a ? (x.b < y.b ? -1 : 1) : x.a < y.a ? -1 : 1,
      );
      // Clipped text: painted lines that run past a box which hides them for
      // good, with no ellipsis or line clamp to say so.
      const wordCharacter = /[\p{L}\p{N}]/u;
      const activeClamps = new WeakMap<Element, boolean>();
      const hasActiveLineClamp = (element: Element) => {
        const cached = activeClamps.get(element);
        if (cached !== undefined) return cached;
        const style = getComputedStyle(element);
        let active = false;
        if (
          Number.parseInt(style.webkitLineClamp, 10) > 0 &&
          style.webkitBoxOrient === "vertical"
        ) {
          const isLegacyBox = (display: string) =>
            ["-webkit-box", "-webkit-inline-box"].includes(display);
          active = isLegacyBox(style.display);
          if (
            !active &&
            element instanceof HTMLElement &&
            ["flow-root", "inline-block"].includes(style.display)
          ) {
            // Chromium serializes an active legacy clamp as flow-root or
            // inline-block. Briefly removing only the clamp reveals whether
            // its underlying display is actually a WebKit box. Restore the
            // exact attribute synchronously, before yielding or measuring.
            const original = element.getAttribute("style");
            try {
              element.style.setProperty(
                "-webkit-line-clamp",
                "none",
                "important",
              );
              active = isLegacyBox(getComputedStyle(element).display);
            } finally {
              if (original === null) {
                const attribute = element.getAttributeNode("style");
                if (attribute !== null) element.removeAttributeNode(attribute);
              } else element.setAttribute("style", original);
            }
          }
        }
        activeClamps.set(element, active);
        return active;
      };
      type ClampLine = { centre: number; edges: Edges; retained?: Edges };
      const clampLines = new WeakMap<Element, ClampLine[]>();
      const hasVisibleClampMarker = (element: Element, box: Edges) => {
        if (!hasActiveLineClamp(element)) return false;
        let lines = clampLines.get(element);
        if (lines === undefined) {
          const measured: ClampLine[] = [];
          const walker = document.createTreeWalker(
            element,
            NodeFilter.SHOW_TEXT,
          );
          for (
            let node = walker.nextNode();
            node !== null;
            node = walker.nextNode()
          ) {
            if (
              !node.textContent?.trim() ||
              node.parentElement === null ||
              !isVisibleContent(node.parentElement, false)
            )
              continue;
            const range = document.createRange();
            range.selectNodeContents(node);
            const rects = [...range.getClientRects()].filter(
              (rect) => rect.width > 0 && rect.height > 0,
            );
            for (const rect of rects) {
              const centre = rect.top + rect.height / 2;
              const band = inkBand(rect);
              let line = measured.find(
                (entry) => Math.abs(entry.centre - centre) < rect.height / 2,
              );
              if (line === undefined) {
                line = { centre, edges: { ...band } };
                measured.push(line);
              } else {
                line.edges.left = Math.min(line.edges.left, band.left);
                line.edges.right = Math.max(line.edges.right, band.right);
                line.edges.top = Math.min(line.edges.top, band.top);
                line.edges.bottom = Math.max(line.edges.bottom, band.bottom);
              }
              // Chromium exposes both the original text fragment and the
              // retained prefix on the clamped line. The contained duplicate
              // identifies painted text; its inline end is where the marker
              // starts, including when markup splits that text across nodes.
              const retained = rects.some(
                (other) =>
                  other !== rect &&
                  Math.abs(other.top - rect.top) < 0.5 &&
                  Math.abs(other.bottom - rect.bottom) < 0.5 &&
                  rect.left >= other.left - 0.5 &&
                  rect.right <= other.right + 0.5,
              );
              if (retained) {
                if (line.retained === undefined) line.retained = { ...band };
                else {
                  line.retained.left = Math.min(line.retained.left, band.left);
                  line.retained.right = Math.max(
                    line.retained.right,
                    band.right,
                  );
                }
              }
            }
          }
          lines = measured.sort((a, b) => a.centre - b.centre);
          clampLines.set(element, lines);
        }
        const style = getComputedStyle(element);
        const count = Number.parseInt(style.webkitLineClamp, 10);
        // A clamp paints its marker on the last permitted line, only when
        // more lines follow. Explicit heights and outer clips can hide that
        // line even though the clamp itself is active.
        if (lines.length <= count) return false;
        const lastLine = lines[count - 1];
        if (lastLine === undefined) return false;
        const inside = (edges: Edges) =>
          edges.left >= box.left - 1 &&
          edges.right <= box.right + 1 &&
          edges.top >= box.top - 1 &&
          edges.bottom <= box.bottom + 1;
        let markerAdvance = pxOf(style.fontSize);
        let inkLeft = 0;
        let inkRight = markerAdvance;
        if (measureCanvas !== null) {
          measureCanvas.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
          const metrics = measureCanvas.measureText("…");
          markerAdvance = metrics.width;
          inkLeft = -metrics.actualBoundingBoxLeft;
          inkRight = metrics.actualBoundingBoxRight;
        }
        const rtl = style.direction === "rtl";
        // Without a truncated prefix the line broke naturally, and the marker
        // follows that line's own text rather than the content-box edge.
        const painted = lastLine.retained ?? lastLine.edges;
        // The marker only accounts for the hidden lines; retained text the
        // clip still cuts is a real clip.
        if (
          lines.slice(0, count - 1).some((line) => !inside(line.edges)) ||
          !inside({
            ...lastLine.edges,
            left: painted.left,
            right: painted.right,
          })
        )
          return false;
        const origin = rtl ? painted.left - markerAdvance : painted.right;
        // Compare the painted dots, not the glyph's trailing advance space.
        const marker = {
          left: origin + inkLeft,
          right: origin + inkRight,
          top: lastLine.edges.top,
          bottom: lastLine.edges.bottom,
        };
        return inside(marker);
      };
      const clippedText: Array<{
        selector: string;
        owner: string;
        axis: "x" | "y" | "both";
        overflow: { x: number; y: number };
        lines: number;
        visibleLines: number;
        cut: "mid-word" | "word-boundary" | "sliced-line" | "hidden-lines";
        visibleText: string;
        text: string;
      }> = [];
      for (const { element, value } of observed) {
        if (
          !value.visible ||
          value.directText === "" ||
          element === document.body ||
          ["input", "textarea", "select", "option"].includes(value.tag)
        )
          continue;
        const clip = clipFor(element, true);
        if (clip.ownerX === undefined && clip.ownerY === undefined) continue;
        if (!isVisibleContent(element)) continue;
        const owners = Object.values(clip.hiddenOwners);
        // Exempt a clamp only when its marker survives the effective clip.
        // Look through ancestors up to the outermost clipping owner.
        const outermost = owners.find((owner) =>
          owners.every((other) => owner.contains(other)),
        );
        let clamped = false;
        for (
          let current: Element | null = element;
          current !== null && !clamped;
          current = current === outermost ? null : current.parentElement
        ) {
          clamped = hasVisibleClampMarker(current, clip.hidden);
        }
        if (clamped) continue;
        const fragments = textFragments(element);
        if (fragments.length === 0) continue;
        const box = clip.hidden;
        const ellipsisAt = (edge: "left" | "right") => {
          const owner = clip.hiddenOwners[edge];
          if (owner === undefined) return false;
          const style = getComputedStyle(owner);
          if (
            style.textOverflow === "clip" ||
            ![
              "block",
              "inline-block",
              "flow-root",
              "list-item",
              "table-cell",
              "table-caption",
            ].includes(style.display)
          )
            return false;
          // A text-overflow marker applies to the owner's line boxes. A
          // descendant block or atomic inline owns separate lines, so a
          // declaration on its ancestor cannot ellipsize this text.
          for (
            let current: Element | null = element;
            current !== owner;
            current = current.parentElement
          ) {
            if (current === null) return false;
            const descendant = getComputedStyle(current);
            if (
              !["inline", "contents"].includes(descendant.display) ||
              ["absolute", "fixed"].includes(descendant.position)
            )
              return false;
          }
          // A single marker is painted at the inline end. Checking the
          // effective edge owner also rules out an inner marker hidden behind
          // a narrower outer clip, even when the inner owns these line boxes.
          return edge === (style.direction === "rtl" ? "left" : "right");
        };
        const minLeft = Math.min(...fragments.map((rect) => rect.left));
        const maxRight = Math.max(...fragments.map((rect) => rect.right));
        const bands = fragments.map(inkBand);
        const minTop = Math.min(...bands.map((band) => band.top));
        const maxBottom = Math.max(...bands.map((band) => band.bottom));
        const xClip = (
          [
            { edge: "left", pixels: box.left - minLeft },
            { edge: "right", pixels: maxRight - box.right },
          ] as const
        )
          .filter((cut) => cut.pixels > 1 && !ellipsisAt(cut.edge))
          .sort((a, b) => b.pixels - a.pixels)[0];
        const yClip = (
          [
            { edge: "top", pixels: box.top - minTop },
            { edge: "bottom", pixels: maxBottom - box.bottom },
          ] as const
        )
          .filter((cut) => cut.pixels > 1)
          .sort((a, b) => b.pixels - a.pixels)[0];
        let overflowX = xClip?.pixels ?? 0;
        const overflowY = yClip?.pixels ?? 0;
        if (overflowX <= 1 && overflowY <= 1) continue;
        // Per-character evidence: a horizontal cut counts only when a glyph's
        // centre lies past the edge (side bearings overhang harmlessly).
        const characters: Array<{
          character: string;
          inside: boolean;
          outsideX: boolean;
        }> = [];
        let walked = 0;
        for (const node of element.childNodes) {
          if (node.nodeType !== Node.TEXT_NODE) continue;
          const content = node.textContent ?? "";
          for (
            let offset = 0;
            offset < content.length && walked < 500;
            offset += 1
          ) {
            walked += 1;
            const character = content[offset] ?? "";
            const range = document.createRange();
            range.setStart(node, offset);
            range.setEnd(node, offset + 1);
            const rect = range.getBoundingClientRect();
            if (rect.width === 0 && rect.height === 0) {
              if (/\s/.test(character))
                characters.push({
                  character: " ",
                  inside: true,
                  outsideX: false,
                });
              continue;
            }
            const cx = rect.left + rect.width / 2;
            const cy = rect.top + rect.height / 2;
            const outsideX = cx < box.left || cx > box.right;
            characters.push({
              character,
              inside: !outsideX && cy >= box.top && cy <= box.bottom,
              outsideX,
            });
          }
        }
        const firstOutX = characters.findIndex((entry) => entry.outsideX);
        if (firstOutX < 0) overflowX = 0;
        const lineCentres: Array<{
          centre: number;
          top: number;
          bottom: number;
          left: number;
          right: number;
        }> = [];
        for (const [index, rect] of fragments.entries()) {
          const band = bands[index] as Edges;
          const centre = rect.top + rect.height / 2;
          const line = lineCentres.find(
            (entry) => Math.abs(entry.centre - centre) < rect.height / 2,
          );
          if (line === undefined)
            lineCentres.push({
              centre,
              top: band.top,
              bottom: band.bottom,
              left: rect.left,
              right: rect.right,
            });
          else {
            line.top = Math.min(line.top, band.top);
            line.bottom = Math.max(line.bottom, band.bottom);
            line.left = Math.min(line.left, rect.left);
            line.right = Math.max(line.right, rect.right);
          }
        }
        const fractionY = (line: { top: number; bottom: number }) =>
          Math.max(
            0,
            Math.min(line.bottom, box.bottom) - Math.max(line.top, box.top),
          ) / Math.max(1, line.bottom - line.top);
        const visibleWidth = (line: { left: number; right: number }) =>
          Math.max(
            0,
            Math.min(line.right, box.right) - Math.max(line.left, box.left),
          );
        // A long single-line label can have less than half its width visible
        // and still be readable evidence. Require half the height and either
        // half the width or a 32px readable prefix, excluding tiny peeks.
        const shown = lineCentres.filter(
          (line) =>
            fractionY(line) >= 0.5 &&
            (visibleWidth(line) >= 32 ||
              visibleWidth(line) >= (line.right - line.left) * 0.5),
        );
        const yCut =
          overflowY > 1 && lineCentres.some((line) => fractionY(line) < 0.85);
        const xCut = overflowX > 1;
        if (!xCut && !yCut) continue;
        if (shown.length === 0) continue;
        const ownerFor = (
          xCut && xClip !== undefined
            ? clip.hiddenOwners[xClip.edge]
            : yClip === undefined
              ? undefined
              : clip.hiddenOwners[yClip.edge]
        ) as Element;
        // A carousel card crosses the clip alongside peer cards in a track.
        // An overflowing icon/label row alone is not evidence of a peek.
        let peeking = false;
        for (
          let current = element.parentElement;
          current !== null && current !== ownerFor && !peeking;
          current = current.parentElement
        ) {
          const others = [...current.children].filter(
            (child) => !child.contains(element) && renderedPaths.has(child),
          );
          if (others.length === 0) continue;
          const rect = current.getBoundingClientRect();
          const crossesX =
            xCut && (rect.left < box.left - 1 || rect.right > box.right + 1);
          const crossesY =
            yCut && (rect.top < box.top - 1 || rect.bottom > box.bottom + 1);
          if (!crossesX && !crossesY) continue;
          const peers = [...(current.parentElement?.children ?? [])].filter(
            (peer) =>
              peer !== current &&
              renderedPaths.has(peer) &&
              peer.tagName === current.tagName,
          );
          peeking = peers.some((peer) => {
            const other = peer.getBoundingClientRect();
            const similarSize =
              Math.min(rect.width, other.width) >=
                Math.max(rect.width, other.width) * 0.5 &&
              Math.min(rect.height, other.height) >=
                Math.max(rect.height, other.height) * 0.5;
            return (
              similarSize &&
              ((crossesX &&
                Math.abs(other.top - rect.top) < rect.height * 0.5 &&
                (other.right <= rect.left + 1 ||
                  other.left >= rect.right - 1)) ||
                (crossesY &&
                  Math.abs(other.left - rect.left) < rect.width * 0.5 &&
                  (other.bottom <= rect.top + 1 ||
                    other.top >= rect.bottom - 1)))
            );
          });
        }
        if (peeking) continue;
        const sliced = lineCentres.some((line) => {
          const fraction = fractionY(line);
          return fraction >= 0.15 && fraction <= 0.85;
        });
        const midWord =
          xCut &&
          firstOutX > 0 &&
          wordCharacter.test(characters[firstOutX]?.character ?? "") &&
          wordCharacter.test(characters[firstOutX - 1]?.character ?? "");
        const cut = midWord
          ? ("mid-word" as const)
          : yCut && sliced
            ? ("sliced-line" as const)
            : yCut
              ? ("hidden-lines" as const)
              : ("word-boundary" as const);
        const visibleText = characters
          .filter((entry) => entry.inside)
          .map((entry) => entry.character)
          .join("")
          .replace(/\s+/g, " ")
          .trim();
        clippedText.push({
          selector: value.selector,
          owner: selectorFor(ownerFor),
          axis: xCut && yCut ? "both" : xCut ? "x" : "y",
          overflow: {
            x: Math.round((xCut ? overflowX : 0) * 10) / 10,
            y: Math.round((yCut ? overflowY : 0) * 10) / 10,
          },
          lines: lineCentres.length,
          visibleLines: shown.length,
          cut,
          visibleText: visibleText.slice(-80),
          text: value.directText.slice(0, 160),
        });
      }
      // Field groups: a label, its control and the helper or status
      // elements after it. Choice controls sit inline with their caption and
      // are measured by adjacent-gap instead.
      const fieldGroups: Array<{
        container: string;
        region: string;
        members: Array<{
          selector: string;
          role: "label" | "control" | "helper";
          rect: Rect;
        }>;
      }> = [];
      const labelElements = all.filter(
        (element) =>
          renderedPaths.has(element) &&
          (element instanceof HTMLLabelElement || element.hasAttribute("for")),
      );
      const isLabelLike = (element: Element) =>
        element instanceof HTMLLabelElement ||
        element.hasAttribute("for") ||
        element.querySelector("label, [for]") !== null ||
        [element, ...element.querySelectorAll("input, select, textarea")].some(
          (candidate) =>
            (candidate instanceof HTMLInputElement ||
              candidate instanceof HTMLSelectElement ||
              candidate instanceof HTMLTextAreaElement) &&
            (candidate.labels?.length ?? 0) > 0,
        );
      const claimed = new Set<Element>();
      for (const label of labelElements) {
        if (fieldGroups.length >= 200) break;
        const forId = label.getAttribute("for");
        const control =
          (label instanceof HTMLLabelElement ? label.control : null) ??
          (forId ? document.getElementById(forId) : null);
        if (
          control === null ||
          claimed.has(control) ||
          !renderedPaths.has(control) ||
          !isVisibleContent(control) ||
          !isVisibleContent(label) ||
          ["checkbox", "radio", "switch"].includes(implicitRole(control)) ||
          (control instanceof HTMLInputElement &&
            ["checkbox", "radio", "hidden"].includes(control.type))
        )
          continue;
        claimed.add(control);
        let container: Element | null = label;
        while (container !== null && !container.contains(control))
          container = container.parentElement;
        if (container === null) continue;
        const helpers: Element[] = [];
        const addHelper = (target: Element) => {
          if (
            target !== label &&
            !target.contains(control) &&
            renderedPaths.has(target) &&
            isVisibleContent(target) &&
            !helpers.some(
              (helper) => helper.contains(target) || target.contains(helper),
            )
          )
            helpers.push(target);
        };
        for (const id of (control.getAttribute("aria-describedby") ?? "")
          .split(/\s+/)
          .filter(Boolean)) {
          const target = document.getElementById(id);
          if (target !== null && container.contains(target)) addHelper(target);
        }
        // Helpers may follow the input inside a control wrapper, or follow
        // that wrapper. Walk outwards without crossing the next field.
        let branch: Element = control;
        let walkedSiblings = 0;
        let nextField = false;
        while (branch !== container && walkedSiblings < 3 && !nextField) {
          for (
            let sibling = branch.nextElementSibling;
            sibling !== null && walkedSiblings < 3;
            sibling = sibling.nextElementSibling
          ) {
            if (!renderedPaths.has(sibling)) continue;
            if (isLabelLike(sibling)) {
              nextField = true;
              break;
            }
            walkedSiblings += 1;
            addHelper(sibling);
          }
          if (branch.parentElement === null) break;
          branch = branch.parentElement;
        }
        let labelRect: Rect;
        if (label.contains(control)) {
          // Captions are often nested in spans/strong tags. Measure their
          // text, excluding the input and helper subtrees from the label box.
          const texts: DOMRect[] = [];
          const captionBoxes = new Set<Element>();
          const containsFieldPart = (candidate: Element) =>
            candidate.contains(control) ||
            helpers.some((helper) => candidate.contains(helper));
          const walker = document.createTreeWalker(label, NodeFilter.SHOW_TEXT);
          for (
            let node = walker.nextNode();
            node !== null;
            node = walker.nextNode()
          ) {
            if (
              !node.textContent?.trim() ||
              control.contains(node) ||
              helpers.some((helper) => helper.contains(node)) ||
              node.parentElement === null ||
              !isVisibleContent(node.parentElement, false)
            )
              continue;
            let caption = node.parentElement;
            while (
              caption.parentElement !== null &&
              caption.parentElement !== label &&
              !containsFieldPart(caption.parentElement)
            )
              caption = caption.parentElement;
            if (
              caption !== label &&
              !containsFieldPart(caption) &&
              renderedPaths.has(caption)
            ) {
              // Use the caption's box, including its line height, so a span
              // touching the input measures zero rather than a glyph inset.
              if (!captionBoxes.has(caption))
                texts.push(...caption.getClientRects());
              captionBoxes.add(caption);
            } else {
              const range = document.createRange();
              range.selectNodeContents(node);
              texts.push(
                ...[...range.getClientRects()].filter(
                  (rect) => rect.width > 0 && rect.height > 0,
                ),
              );
            }
          }
          if (texts.length === 0) continue;
          labelRect = rectOf({
            left: Math.min(...texts.map((rect) => rect.left)),
            top: Math.min(...texts.map((rect) => rect.top)),
            right: Math.max(...texts.map((rect) => rect.right)),
            bottom: Math.max(...texts.map((rect) => rect.bottom)),
          });
        } else labelRect = rectOf(edgesOf(label.getBoundingClientRect()));
        let region: Element | null = container;
        while (region !== null && region !== document.body) {
          const style = getComputedStyle(region);
          if (
            ["dialog", "alertdialog"].includes(implicitRole(region)) ||
            ["auto", "scroll"].includes(style.overflowY) ||
            ["auto", "scroll"].includes(style.overflowX)
          )
            break;
          region = region.parentElement;
        }
        const members = [
          { element: label, role: "label" as const, rect: labelRect },
          {
            element: control,
            role: "control" as const,
            rect: rectOf(edgesOf(control.getBoundingClientRect())),
          },
          ...helpers.map((helper) => ({
            element: helper,
            role: "helper" as const,
            rect: rectOf(edgesOf(helper.getBoundingClientRect())),
          })),
        ].sort((first, second) =>
          first.element === second.element
            ? 0
            : first.element.compareDocumentPosition(second.element) &
                Node.DOCUMENT_POSITION_FOLLOWING
              ? -1
              : 1,
        );
        fieldGroups.push({
          container: selectorFor(container),
          region:
            region === null || region === document.body
              ? "document"
              : selectorFor(region),
          members: members.map(({ element, role, rect }) => ({
            selector: selectorFor(element),
            role,
            rect,
          })),
        });
      }
      const alphaOf = (color: string): number => {
        const match = color.match(/^rgba?\(([^)]*)\)$/);
        if (match === null) return color === "transparent" ? 0 : 1;
        const parts = (match[1] ?? "").split(/[\s,/]+/).filter(Boolean);
        const alpha = parts[3];
        if (alpha === undefined) return 1;
        return alpha.endsWith("%")
          ? Number.parseFloat(alpha) / 100
          : Number.parseFloat(alpha);
      };
      const decorationOf = (representative: Element) => {
        const decoration: Record<string, string> = {};
        const svgPaints = (element: Element, style: CSSStyleDeclaration) =>
          element instanceof SVGGraphicsElement &&
          ![
            "svg",
            "g",
            "defs",
            "symbol",
            "clipPath",
            "mask",
            "pattern",
            "marker",
          ].includes(element.localName) &&
          ((style.fill !== "none" &&
            alphaOf(style.fill) > 0.05 &&
            Number(style.fillOpacity) > 0) ||
            (style.stroke !== "none" &&
              Number.parseFloat(style.strokeWidth) > 0 &&
              alphaOf(style.stroke) > 0.05 &&
              Number(style.strokeOpacity) > 0));
        const record = (
          part: string,
          style: CSSStyleDeclaration,
          hasText: boolean,
          svg = false,
        ) => {
          for (const side of ["Top", "Right", "Bottom", "Left"] as const) {
            const width =
              Number.parseFloat(
                style.getPropertyValue(`border-${side.toLowerCase()}-width`),
              ) || 0;
            const sideStyle = style.getPropertyValue(
              `border-${side.toLowerCase()}-style`,
            );
            const color = style.getPropertyValue(
              `border-${side.toLowerCase()}-color`,
            );
            // A selected underline can be thinner than another edge, so each
            // painted side must retain its own width and colour evidence.
            decoration[`${part}.${side.toLowerCase()}.border`] =
              width <= 0 ||
              sideStyle === "none" ||
              sideStyle === "hidden" ||
              alphaOf(color) <= 0.05
                ? "none"
                : `${width}px ${color}`;
          }
          const outlineWidth = Number.parseFloat(style.outlineWidth) || 0;
          decoration[`${part}.bg`] = style.backgroundColor;
          decoration[`${part}.bgImage`] = style.backgroundImage;
          decoration[`${part}.outline`] =
            style.outlineStyle === "none" ||
            outlineWidth <= 0 ||
            alphaOf(style.outlineColor) <= 0.05
              ? "none"
              : `${outlineWidth}px ${style.outlineColor}`;
          decoration[`${part}.shadow`] = style.boxShadow;
          if (hasText) decoration[`${part}.color`] = style.color;
          decoration[`${part}.weight`] = style.fontWeight;
          decoration[`${part}.underline`] = style.textDecorationLine;
          decoration[`${part}.opacity`] = style.opacity;
          // Existing SVG indicators can change paint without changing
          // structure, text colour, or their painted-descendant count.
          if (svg) {
            const fill =
              style.fill !== "none" &&
              alphaOf(style.fill) > 0.05 &&
              Number(style.fillOpacity) > 0;
            const stroke =
              style.stroke !== "none" &&
              Number.parseFloat(style.strokeWidth) > 0 &&
              alphaOf(style.stroke) > 0.05 &&
              Number(style.strokeOpacity) > 0;
            decoration[`${part}.fill`] = fill ? style.fill : "none";
            decoration[`${part}.stroke`] = stroke
              ? `${Number.parseFloat(style.strokeWidth)}px ${style.stroke}`
              : "none";
            if (fill) decoration[`${part}.fill.opacity`] = style.fillOpacity;
            if (stroke)
              decoration[`${part}.stroke.opacity`] = style.strokeOpacity;
          }
        };
        record(
          "self",
          getComputedStyle(representative),
          ((representative as HTMLElement).innerText ?? "").trim() !== "",
          svgPaints(representative, getComputedStyle(representative)),
        );
        const size = (value: string) => Number.parseFloat(value) || 0;
        const boxPaints = (style: CSSStyleDeclaration): boolean =>
          alphaOf(style.backgroundColor) > 0.05 ||
          style.backgroundImage !== "none" ||
          (["Top", "Right", "Bottom", "Left"] as const).some(
            (side) =>
              size(
                style.getPropertyValue(`border-${side.toLowerCase()}-width`),
              ) > 0 &&
              alphaOf(
                style.getPropertyValue(`border-${side.toLowerCase()}-color`),
              ) > 0.05,
          ) ||
          (style.outlineStyle !== "none" &&
            size(style.outlineWidth) > 0 &&
            alphaOf(style.outlineColor) > 0.05) ||
          style.boxShadow !== "none";
        const recordPseudos = (
          element: Element,
          prefix: string,
          emit = true,
        ): boolean => {
          let paints = false;
          for (const pseudo of ["before", "after"] as const) {
            const style = getComputedStyle(element, `::${pseudo}`);
            if (
              style.content === "none" ||
              style.content === "normal" ||
              style.display === "none" ||
              style.display === "contents" ||
              style.visibility === "hidden" ||
              style.visibility === "collapse" ||
              Number(style.opacity) <= 0
            )
              continue;
            const content = style.content.replace(/^["']|["']$/g, "").trim();
            const hasText = content !== "";
            const edgesX =
              size(style.paddingLeft) +
              size(style.paddingRight) +
              size(style.borderLeftWidth) +
              size(style.borderRightWidth);
            const edgesY =
              size(style.paddingTop) +
              size(style.paddingBottom) +
              size(style.borderTopWidth) +
              size(style.borderBottomWidth);
            // Width/height do not apply to inline generated content. An empty
            // inline ::after with only a background has no painted area.
            let width = size(style.width);
            let height = size(style.height);
            if (style.display === "inline") {
              if (measureCanvas !== null) {
                measureCanvas.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
                width = hasText ? measureCanvas.measureText(content).width : 0;
              } else width = hasText ? size(style.fontSize) : 0;
              height = size(style.fontSize);
            }
            if (
              style.display === "inline" ||
              style.boxSizing !== "border-box"
            ) {
              width += edgesX;
              height += edgesY;
            } else {
              width = Math.max(width, edgesX);
              height = Math.max(height, edgesY);
            }
            const area = width > 0 && height > 0;
            const paintedText =
              hasText &&
              size(style.fontSize) > 0 &&
              alphaOf(style.color) > 0.05 &&
              (area ||
                (style.overflowX === "visible" &&
                  style.overflowY === "visible"));
            const paintedBox = area && boxPaints(style);
            // Presence and inherited defaults are not evidence: retain a pseudo
            // fingerprint only when its generated text or box actually paints.
            if (!paintedText && !paintedBox) continue;
            paints = true;
            if (emit) record(`${prefix}${pseudo}`, style, hasText);
          }
          return paints;
        };
        recordPseudos(representative, "");
        const descendants = [...representative.querySelectorAll("*")].filter(
          (element) => renderedPaths.has(element),
        );
        let paintedDescendants = 0;
        for (const element of descendants) {
          const style = getComputedStyle(element);
          const hasText = [...element.childNodes].some(
            (node) =>
              node.nodeType === Node.TEXT_NODE &&
              (node.textContent ?? "").trim() !== "",
          );
          const rect = element.getBoundingClientRect();
          const area = rect.width > 0 && rect.height > 0;
          const graphic =
            (element instanceof HTMLImageElement &&
              element.complete &&
              element.naturalWidth > 0) ||
            svgPaints(element, style);
          const paints =
            area &&
            ((hasText &&
              Number.parseFloat(style.fontSize) > 0 &&
              alphaOf(style.color) > 0.05) ||
              graphic ||
              boxPaints(style));
          const prefix = `d${paintedDescendants}`;
          const emit = paintedDescendants < 6;
          const pseudoPaints = recordPseudos(element, `${prefix}.`, emit);
          if (!paints && !pseudoPaints) continue;
          // Unpainted wrappers neither establish a cue nor consume a slot
          // that could hide a later painted indicator from the fingerprint.
          if (paints && emit)
            record(prefix, style, hasText, svgPaints(element, style));
          paintedDescendants += 1;
        }
        decoration.descendants = String(paintedDescendants);
        return decoration;
      };
      const groupContainers =
        "[role=radiogroup],[role=tablist],[role=listbox],[role=toolbar],[role=group],[role=menu],[role=grid]";
      const selectionGroupMap = new Map<
        Element | HTMLInputElement[],
        {
          container: Element;
          role: string;
          memberRole: string;
          native: boolean;
          members: Array<{
            selector: string;
            control: string;
            selected: boolean;
            source:
              | "aria-selected"
              | "aria-checked"
              | "aria-pressed"
              | "checked";
            nativeIndicator: boolean;
            decoration: Record<string, string>;
          }>;
        }
      >();
      const nativeRadioGroups = new Map<
        HTMLFormElement | null,
        Map<string, HTMLInputElement[]>
      >();
      for (const element of all) {
        const role = implicitRole(element);
        const stateAttribute = (
          ["aria-selected", "aria-checked", "aria-pressed"] as const
        ).find((name) => element.hasAttribute(name));
        const nativeRadio =
          element instanceof HTMLInputElement && element.type === "radio";
        if (
          !nativeRadio &&
          !["radio", "tab", "option", "menuitemradio"].includes(role) &&
          (stateAttribute === undefined ||
            ["checkbox", "switch", "menuitemcheckbox"].includes(role))
        )
          continue;
        // Hidden mirrors (Radix/Base UI form inputs) are not part of the
        // control a reader or assistive technology sees.
        if (element.closest("[aria-hidden=true],[inert]") !== null) continue;
        let representative: Element | undefined;
        const rect = element.getBoundingClientRect();
        if (renderedPaths.has(element) && rect.width > 1 && rect.height > 1)
          representative = element;
        else if (nativeRadio)
          representative = [...(element.labels ?? [])].find((label) =>
            renderedPaths.has(label),
          );
        if (representative === undefined) continue;
        const source = nativeRadio
          ? "checked"
          : (stateAttribute ??
            (["tab", "option"].includes(role)
              ? "aria-selected"
              : "aria-checked"));
        const selected = nativeRadio
          ? element.checked
          : stateAttribute !== undefined &&
            element.getAttribute(stateAttribute) === "true";
        let container = element.parentElement?.closest(groupContainers) ?? null;
        // A group section inside a listbox, menu or tab list shares its
        // parent's selection (cmdk, grouped menus).
        if (container?.getAttribute("role") === "group")
          container =
            container.parentElement?.closest(
              "[role=listbox],[role=menu],[role=tablist],[role=radiogroup],[role=grid]",
            ) ?? container;
        let nativePeers: HTMLInputElement[] | undefined;
        if (nativeRadio) {
          // Unnamed native radios are independent controls in HTML.
          if (element.name === "") continue;
          // Generic ARIA wrappers do not change HTML's form/name identity.
          const formGroups =
            nativeRadioGroups.get(element.form) ??
            new Map<string, HTMLInputElement[]>();
          nativeRadioGroups.set(element.form, formGroups);
          const peers = formGroups.get(element.name) ?? [];
          if (peers.length === 0) {
            for (const candidate of document.querySelectorAll<HTMLInputElement>(
              `input[type=radio][name="${CSS.escape(element.name)}"]`,
            ))
              if (candidate.form === element.form) peers.push(candidate);
            formGroups.set(element.name, peers);
          }
          nativePeers = peers;
          let ancestor: Element | null = element.parentElement;
          while (
            ancestor !== null &&
            !peers.every((peer) => ancestor?.contains(peer))
          )
            ancestor = ancestor.parentElement;
          container ??= ancestor;
        }
        container ??= element.parentElement;
        if (container === null) continue;
        // Names identify native groups even when several groups share the
        // same common ancestor (for example, two choices in one form).
        const groupKey = nativePeers ?? container;
        const group = selectionGroupMap.get(groupKey) ?? {
          container,
          role: container.getAttribute("role") ?? "",
          memberRole: role,
          native: nativeRadio,
          members: [],
        };
        group.members.push({
          selector: selectorFor(representative),
          control: selectorFor(element),
          selected,
          source,
          nativeIndicator:
            representative === element &&
            nativeRadio &&
            getComputedStyle(element).appearance !== "none",
          decoration: decorationOf(representative),
        });
        selectionGroupMap.set(groupKey, group);
      }
      const selectionGroups = [...selectionGroupMap.values()]
        .filter((group) => group.members.length >= 2)
        .map(({ container, native, ...group }) => ({
          container: selectorFor(container),
          ...group,
          single:
            native ||
            group.role === "radiogroup" ||
            group.memberRole === "radio" ||
            (["grid", "listbox", "tablist"].includes(group.role)
              ? container.getAttribute("aria-multiselectable") !== "true"
              : group.memberRole === "tab"),
        }));
      const dialogs = all
        .filter(
          (element) =>
            renderedPaths.has(element) &&
            ["dialog", "alertdialog"].includes(implicitRole(element)),
        )
        .map((dialog) => {
          let modal = dialog.getAttribute("aria-modal") === "true";
          try {
            modal ||= dialog.matches(":modal");
          } catch {
            // :modal is unsupported; aria-modal decides.
          }
          const labelledBy = (dialog.getAttribute("aria-labelledby") ?? "")
            .split(/\s+/)
            .filter(Boolean)
            .flatMap((id) => {
              const target = document.getElementById(id);
              return target !== null && renderedPaths.has(target)
                ? [selectorFor(target)]
                : [];
            });
          const submit = [
            ...dialog.querySelectorAll<HTMLButtonElement | HTMLInputElement>(
              "button, input[type=submit]",
            ),
          ]
            .filter(
              (button) =>
                renderedPaths.has(button) &&
                button.type === "submit" &&
                button.form !== null &&
                dialog.contains(button.form),
            )
            .map((button) => selectorFor(button));
          return { selector: selectorFor(dialog), modal, labelledBy, submit };
        });
      const root = document.documentElement;
      const maskMembership = maskSelectors.map((selector) => {
        let matches: Element[];
        try {
          matches = [...document.querySelectorAll(selector)];
        } catch (error) {
          throw new Error(
            `invalid mask selector ${JSON.stringify(selector)}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        return {
          selector,
          paths: matches.flatMap((element) => {
            const path = renderedPaths.get(element);
            return path === undefined ? [] : [path];
          }),
        };
      });
      const components: ComponentObservation[] = componentInput.map(
        (component) => {
          let matches: Element[] = [];
          try {
            matches = [...document.querySelectorAll(component.selector)];
          } catch {
            matches = [];
          }
          return {
            ...component,
            rects: matches
              .filter((element) => renderedPaths.has(element))
              .map((element) => {
                const rect = element.getBoundingClientRect();
                return {
                  selector: selectorFor(element),
                  x: rect.x,
                  y: rect.y,
                  width: rect.width,
                  height: rect.height,
                };
              }),
          };
        },
      );
      // Inferred sizes resolve to the class token (or aria-label) whose words
      // contain the stated name in order: `bp-override-dot` ⊇ "override dot".
      const singularWord = (word: string) =>
        word.length > 4 && word.endsWith("ies")
          ? `${word.slice(0, -3)}y`
          : word.length > 3 && word.endsWith("s") && !/(?:ss|us|is)$/.test(word)
            ? word.slice(0, -1)
            : word;
      const wordsOf = (value: string) =>
        value
          .split(/[-_\s]+|(?<=[a-z])(?=[A-Z])/)
          .map((word) => word.toLowerCase())
          .filter((word) => /^[a-z]+$/.test(word))
          .map(singularWord);
      const containsRun = (haystack: string[], needle: string[]) =>
        haystack.some((_, start) =>
          needle.every((word, offset) => haystack[start + offset] === word),
        );
      const rendered = [...renderedPaths.keys()];
      const explicitSelectors = new Set(
        componentInput.map((component) => component.selector),
      );
      const rectsOf = (matches: Element[]) =>
        matches.map((element) => {
          const rect = element.getBoundingClientRect();
          return {
            selector: selectorFor(element),
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height,
          };
        });
      for (const spec of inferredInput) {
        const counts = new Map<string, number>();
        for (const element of rendered)
          for (const token of element.classList)
            if (containsRun(wordsOf(token), spec.words))
              counts.set(token, (counts.get(token) ?? 0) + 1);
        const token = [...counts].sort(
          ([left, a], [right, b]) =>
            b - a || left.length - right.length || left.localeCompare(right),
        )[0]?.[0];
        let selector = "";
        let matches: Element[] = [];
        if (token !== undefined) {
          selector = `.${CSS.escape(token)}`;
          matches = rendered.filter((element) =>
            element.classList.contains(token),
          );
        } else {
          const labels = [
            ...new Set(
              rendered.flatMap((element) => {
                const label = element.getAttribute("aria-label");
                return label !== null && containsRun(wordsOf(label), spec.words)
                  ? [label]
                  : [];
              }),
            ),
          ].slice(0, 5);
          selector = labels
            .map((label) => `[aria-label=${JSON.stringify(label)}]`)
            .join(", ");
          matches = rendered.filter((element) =>
            labels.includes(element.getAttribute("aria-label") ?? ""),
          );
        }
        if (explicitSelectors.has(selector)) continue;
        const rects = rectsOf(matches);
        const axis =
          spec.width === undefined
            ? ("height" as const)
            : spec.height === undefined
              ? ("width" as const)
              : undefined;
        const first = rects[0];
        components.push({
          name: spec.name,
          selector,
          width: spec.width ?? (first?.width || spec.height || 1),
          height: spec.height ?? (first?.height || spec.width || 1),
          tolerance: spec.tolerance,
          rects,
          inferred: {
            source: spec.source,
            words: spec.words,
            ...(axis === undefined ? {} : { axis }),
          },
          ...(rects.length === 0 ? { unresolved: true as const } : {}),
        });
      }
      const selectorMarks = markMatches.map(({ mark, elements, invalid }) => ({
        ...mark,
        matches: elements
          .filter((element) => renderedPaths.has(element))
          .map((element) => selectorFor(element)),
        ...(invalid ? { invalid } : {}),
      }));
      const emptyRegions = (() => {
        const matchesSafely = (element: Element, selector: string) => {
          try {
            return element.matches(selector);
          } catch {
            return false;
          }
        };
        const queryAll = (root: ParentNode, selector: string) => {
          try {
            return [...root.querySelectorAll(selector)];
          } catch {
            return undefined;
          }
        };
        const ignored = (element: Element) =>
          emptyInput.ignore.some((selector) => {
            try {
              return element.closest(selector) !== null;
            } catch {
              return false;
            }
          });
        const ctaSelector =
          "a[href], button, [role=button], [role=link], input[type=submit], input[type=button]";
        // An explanation can be a heading. Exclude utility and CTA text,
        // rather than requiring a particular typographic element.
        const quietText =
          "th, [role=columnheader], caption, label, script, style";
        const within = (root: Element, element: Element, selector: string) => {
          const match = element.closest(selector);
          return match !== null && root.contains(match);
        };
        const evidenceIn = (roots: Element[]) => {
          const cta: string[] = [];
          const words: string[] = [];
          for (const root of roots) {
            for (const element of [root, ...root.querySelectorAll("*")]) {
              if (cta.length >= 5) break;
              if (
                element.matches(ctaSelector) &&
                renderedPaths.has(element) &&
                !element.matches(":disabled") &&
                element.getAttribute("aria-disabled") !== "true"
              )
                cta.push(selectorFor(element));
            }
            const walker = document.createTreeWalker(
              root,
              NodeFilter.SHOW_TEXT,
            );
            for (
              let node = walker.nextNode();
              node !== null;
              node = walker.nextNode()
            ) {
              const parent = node.parentElement;
              if (
                parent === null ||
                !isVisibleContent(parent, false) ||
                within(root, parent, quietText) ||
                within(root, parent, ctaSelector)
              )
                continue;
              const range = document.createRange();
              range.selectNodeContents(node);
              if (
                ![...range.getClientRects()].some(
                  (rect) => rect.width > 0 && rect.height > 0,
                )
              )
                continue;
              const text = (node.textContent ?? "").replace(/\s+/g, " ").trim();
              if (text) words.push(text);
            }
          }
          return { cta, text: words.join(" ").slice(0, 160) };
        };
        const rectOf = (element: Element): Rect => {
          const rect = element.getBoundingClientRect();
          return {
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height,
          };
        };
        const regions: EmptyRegionObservation[] = [];
        // Explicit regions can be a genuine zero-height void. Utility size
        // floors apply only to automatic candidates.
        const configuredRendered = (element: Element) => {
          if (element.getClientRects().length === 0) return false;
          for (
            let current: Element | null = element;
            current;
            current = current.parentElement
          ) {
            const style = getComputedStyle(current);
            if (
              style.display === "none" ||
              style.visibility !== "visible" ||
              Number(style.opacity) <= 0
            )
              return false;
          }
          return true;
        };
        const renderedItem = (item: Element): boolean => {
          if (!isVisibleContent(item, false)) return false;
          if (renderedPaths.has(item)) return true;
          // Boxless items still populate a region when they paint descendants
          // or text. A hidden/empty contents wrapper is not an item on screen.
          if (getComputedStyle(item).display !== "contents") return false;
          if (
            [...item.querySelectorAll("*")].some(
              (child) => renderedPaths.has(child) && isVisibleContent(child),
            )
          )
            return true;
          const walker = document.createTreeWalker(item, NodeFilter.SHOW_TEXT);
          for (
            let node = walker.nextNode();
            node !== null;
            node = walker.nextNode()
          ) {
            if (
              !node.textContent?.trim() ||
              node.parentElement === null ||
              !isVisibleContent(node.parentElement, false)
            )
              continue;
            const range = document.createRange();
            range.selectNodeContents(node);
            if (
              [...range.getClientRects()].some(
                (rect) => rect.width > 0 && rect.height > 0,
              )
            )
              return true;
          }
          return false;
        };
        const configured = emptyInput.regions.map(({ selector, items }) => {
          const matches = (queryAll(document, selector) ?? []).filter(
            configuredRendered,
          );
          for (const region of matches) {
            if (ignored(region)) continue;
            const found = queryAll(region, items);
            if (found === undefined) continue;
            if (found.some(renderedItem)) continue;
            regions.push({
              selector: selectorFor(region),
              source: "configured",
              configured: selector,
              rect: rectOf(region),
              scope: "region",
              ...evidenceIn([region]),
            });
          }
          return { selector, matched: matches.length };
        });
        if (emptyInput.auto) {
          const excluded =
            "nav, menu, header, footer, dialog:not([open]), [hidden], [aria-hidden=true], [aria-live]:not([aria-live=off]), [role=status], [role=log], [role=alert], [role=menu], [role=menubar], [role=tablist], [role=listbox], [role=tree], [role=toolbar], [role=navigation]";
          const kinds: Array<{
            source: "list" | "table" | "feed";
            selector: string;
            hasItems: (region: Element) => boolean;
          }> = [
            {
              source: "list",
              selector: "ul, ol, [role=list]",
              hasItems: (region) =>
                [...region.querySelectorAll("li, [role=listitem]")].some(
                  (item) =>
                    renderedItem(item) &&
                    item.parentElement?.closest("ul, ol, [role=list]") ===
                      region,
                ),
            },
            {
              source: "table",
              selector: "table, [role=table], [role=grid], [role=treegrid]",
              hasItems: (region) =>
                [...region.querySelectorAll("tr, [role=row]")].some(
                  (row) =>
                    renderedItem(row) &&
                    row.closest("thead") === null &&
                    [...row.children].some((cell) =>
                      cell.matches(
                        "td, [role=cell], [role=gridcell], [role=rowheader]",
                      ),
                    ),
                ),
            },
            {
              source: "feed",
              selector: "[role=feed]",
              hasItems: (region) =>
                [...region.querySelectorAll("article, [role=article]")].some(
                  renderedItem,
                ),
            },
          ];
          for (const kind of kinds) {
            for (const region of document.querySelectorAll(kind.selector)) {
              if (regions.length >= 50) break;
              if (!renderedPaths.has(region)) continue;
              const rect = region.getBoundingClientRect();
              if (rect.height < 16 || rect.width < 32) continue;
              if (region.closest(excluded) !== null) continue;
              if (
                region.parentElement?.closest(
                  "li, [role=listitem], tr, [role=row]",
                )
              )
                continue;
              if (
                emptyInput.regions.some(({ selector }) =>
                  matchesSafely(region, selector),
                ) ||
                ignored(region) ||
                kind.hasItems(region)
              )
                continue;
              const siblings = (step: "previous" | "next") => {
                const found: Element[] = [];
                let current =
                  step === "previous"
                    ? region.previousElementSibling
                    : region.nextElementSibling;
                while (current !== null && found.length < 2) {
                  if (renderedPaths.has(current)) found.push(current);
                  current =
                    step === "previous"
                      ? current.previousElementSibling
                      : current.nextElementSibling;
                }
                return found;
              };
              regions.push({
                selector: selectorFor(region),
                source: kind.source,
                rect: rectOf(region),
                scope: "adjacent",
                ...evidenceIn([
                  region,
                  ...siblings("previous"),
                  ...siblings("next"),
                ]),
              });
            }
          }
        }
        return { configured, auto: emptyInput.auto, regions };
      })();
      // Gallery frames: the visible box of media inside a repeated card. Pixels
      // are sampled later from the screenshot; only geometry is read here.
      const mediaFrames = ((): MediaFrameObservation[] | undefined => {
        if (!mediaInput.auto) return undefined;
        const ignored = (element: Element) =>
          mediaInput.ignore.some((selector) => {
            try {
              return element.closest(selector) !== null;
            } catch {
              return false;
            }
          });
        const repeatedAncestor = (element: Element): Element | undefined => {
          let current: Element | null = element;
          for (let depth = 0; current !== null && depth < 5; depth += 1) {
            const parent: Element | null = current.parentElement;
            if (parent === null) break;
            const signature = repeatedSignature(current);
            if (
              [...parent.children].filter(
                (child) => repeatedSignature(child) === signature,
              ).length >= 3
            )
              return current;
            current = parent;
          }
          return undefined;
        };
        const clips = (element: Element) => {
          const style = getComputedStyle(element);
          return [style.overflowX, style.overflowY].some((value) =>
            ["hidden", "clip", "auto", "scroll"].includes(value),
          );
        };
        // What shows through around the content: the media's own background
        // and the first opaque background behind it (the canvas is white).
        const backdropOf = (media: Element) => {
          const colors: Array<{ r: number; g: number; b: number }> = [];
          const own = parseRgba(getComputedStyle(media).backgroundColor);
          if (own !== undefined && own.a >= 0.99)
            colors.push({ r: own.r, g: own.g, b: own.b });
          for (
            let current = media.parentElement;
            current !== null;
            current = current.parentElement
          ) {
            const color = parseRgba(getComputedStyle(current).backgroundColor);
            if (color !== undefined && color.a >= 0.99) {
              colors.push({ r: color.r, g: color.g, b: color.b });
              return colors;
            }
          }
          colors.push({ r: 255, g: 255, b: 255 });
          return colors;
        };
        const frames: MediaFrameObservation[] = [];
        for (const media of document.querySelectorAll(
          "img, iframe, video, canvas",
        )) {
          if (frames.length >= 120) break;
          if (!renderedPaths.has(media) || ignored(media)) continue;
          const rect = media.getBoundingClientRect();
          if (rect.width < 48 || rect.height < 48) continue;
          const item = repeatedAncestor(media);
          const gallery = item?.parentElement;
          if (item === undefined || gallery === null || gallery === undefined)
            continue;
          let clipper: Element | undefined;
          for (
            let current = media.parentElement;
            current !== null && current !== gallery;
            current = current.parentElement
          )
            if (clips(current)) {
              clipper = current;
              break;
            }
          const box = clipper?.getBoundingClientRect() ?? rect;
          const left = Math.max(rect.left, box.left);
          const top = Math.max(rect.top, box.top);
          const right = Math.min(rect.right, box.right);
          const bottom = Math.min(rect.bottom, box.bottom);
          if (right - left < 48 || bottom - top < 48) continue;
          const kind =
            media.tagName.toLowerCase() as MediaFrameObservation["kind"];
          frames.push({
            selector: selectorFor(clipper ?? media),
            kind,
            frame: {
              x: left,
              y: top,
              width: right - left,
              height: bottom - top,
            },
            group: selectorFor(gallery),
            backdrop: backdropOf(media),
            loaded:
              !(media instanceof HTMLImageElement) ||
              (media.complete && media.naturalWidth > 0),
          });
        }
        const sizes = new Map<string, number>();
        for (const { group } of frames)
          sizes.set(group, (sizes.get(group) ?? 0) + 1);
        return frames.filter(({ group }) => (sizes.get(group) ?? 0) >= 3);
      })();
      // Declared collections: what each item offers statically, hidden
      // (hover-revealed) controls included, since they are reachable.
      const collections = ((): CollectionObservation[] | undefined => {
        if (collectionInput.length === 0) return undefined;
        const menuTrigger = new RegExp(menuTriggerSource, "i");
        const controlSelector =
          "a, button, [role=button], [role=link], [role=menuitem], input[type=button], input[type=submit]";
        const nameOf = (element: Element) =>
          (
            element.getAttribute("aria-label")?.trim() ||
            (element instanceof HTMLElement ? element.innerText : "")
              .replace(/\s+/g, " ")
              .trim() ||
            (element instanceof HTMLInputElement ? element.value.trim() : "") ||
            element.getAttribute("title")?.trim() ||
            ""
          ).slice(0, 80);
        return collectionInput.map(({ selector }): CollectionObservation => {
          let matches: Element[];
          try {
            matches = [...document.querySelectorAll(selector)];
          } catch {
            return { selector, matched: 0, invalid: true, items: [] };
          }
          const rendered = matches.filter((element) =>
            renderedPaths.has(element),
          );
          const items = rendered.slice(0, 5).map((item) => {
            const tabindex = item.getAttribute("tabindex");
            const open =
              item.matches("a[href], [role=link], button, [role=button]") ||
              item.querySelector("a[href], [role=link]") !== null ||
              (tabindex !== null && Number(tabindex) >= 0) ||
              getComputedStyle(item).cursor === "pointer";
            const descendants = [...item.querySelectorAll(controlSelector)];
            const controls = [
              ...new Set(descendants.map(nameOf).filter((name) => name)),
            ].slice(0, 30);
            const menuTriggers = descendants
              .filter((element) => {
                if (
                  !element.matches("button, [role=button], input[type=button]")
                )
                  return false;
                const popup = element.getAttribute("aria-haspopup");
                return (
                  popup === "menu" ||
                  popup === "true" ||
                  menuTrigger.test(nameOf(element))
                );
              })
              .slice(0, 3)
              .map((element) => ({
                selector: selectorFor(element),
                name: nameOf(element),
              }));
            const rect = item.getBoundingClientRect();
            return {
              selector: selectorFor(item),
              rect: {
                x: rect.x,
                y: rect.y,
                width: rect.width,
                height: rect.height,
              },
              open,
              controls,
              menuTriggers,
            };
          });
          return { selector, matched: rendered.length, items };
        });
      })();
      // Raw membership values only; the check owns the regex and comparison,
      // so a stored capture re-judges offline.
      const groupEvidence = (
        declaration: {
          group: string;
          items: string;
          owner?: string | undefined;
          attribute?: string | undefined;
        },
        label: string,
      ): NonNullable<InvariantObservation["groups"]> => {
        const query = (root: ParentNode, selector: string): Element[] => {
          try {
            return [...root.querySelectorAll(selector)];
          } catch (error) {
            throw new Error(
              `invalid invariant selector ${JSON.stringify(selector)} in ${label}: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        };
        const collapsed = (element: Element) =>
          (element.textContent ?? "").replace(/\s+/g, " ").trim();
        const read = (element: Element): string | null =>
          declaration.attribute === undefined
            ? collapsed(element).slice(0, 1000)
            : element.getAttribute(declaration.attribute);
        const owners =
          declaration.owner === undefined
            ? undefined
            : query(document, declaration.owner);
        return query(document, declaration.group).map((list) => {
          const owner =
            owners === undefined
              ? list
              : owners.length === 1
                ? owners[0]
                : undefined;
          return {
            list: selectorFor(list),
            owner:
              owner === undefined
                ? null
                : { selector: selectorFor(owner), value: read(owner) },
            items: query(list, declaration.items).map((item) => {
              const label =
                collapsed(item) ||
                item.getAttribute("aria-label")?.trim() ||
                item.getAttribute("title")?.trim() ||
                selectorFor(item);
              return {
                selector: selectorFor(item),
                label: label.length > 80 ? `${label.slice(0, 79)}…` : label,
                value: read(item),
              };
            }),
          };
        });
      };
      const invariantMatches = new Map<
        string,
        InvariantObservation["selectors"][number]["matches"]
      >();
      const invariants = invariantInput.map(
        ({ requiredSelectors, label, ...assertion }) => ({
          ...assertion,
          selectors: requiredSelectors.map((selector) => {
            let matches = invariantMatches.get(selector);
            if (matches === undefined) {
              let elements: Element[];
              try {
                elements = [...document.querySelectorAll(selector)];
              } catch (error) {
                throw new Error(
                  `invalid invariant selector ${JSON.stringify(selector)} in ${label}: ${error instanceof Error ? error.message : String(error)}`,
                );
              }
              matches = elements.map((element) => {
                const rect = element.getBoundingClientRect();
                return {
                  selector: selectorFor(element),
                  rect: {
                    x: rect.x,
                    y: rect.y,
                    width: rect.width,
                    height: rect.height,
                  },
                };
              });
              invariantMatches.set(selector, matches);
            }
            return { selector, matches };
          }),
          ...("group" in assertion.declaration
            ? { groups: groupEvidence(assertion.declaration, label) }
            : {}),
        }),
      );
      // Let the layout engine apply containing-block and overflow clipping,
      // including fixed controls that escape intermediate scroll containers.
      const dialogSelectors = new Set(dialogs.map((dialog) => dialog.selector));
      const dialogControls = observed.filter(
        ({ value }) =>
          value.visible &&
          value.interactive &&
          value.ancestorSelectors.some((selector) =>
            dialogSelectors.has(selector),
          ),
      );
      // Background, frame and primary-label samples. Hit testing skips pointer-events:none
      // layers (a painted canvas sibling, an overlay), so the stacks are read
      // with every such layer briefly made hit-testable, then the exact
      // original inline styles are restored before anything else runs. Paint
      // comes from the styles frozen before the override.
      const frameEdges = new Map<Element, FrameEdgeSample[]>();
      const frames = [
        ...new Set(
          markMatches
            .filter(({ mark }) => mark.purpose === "frame")
            .flatMap(({ elements }) => elements),
        ),
      ];
      const primaryActions = observed.filter(
        ({ value }) => value.signals?.paint?.primaryAction,
      );
      const backgroundActions = observed.filter(
        ({ value }) => value.signals?.paint !== undefined,
      );
      if (frames.length > 0 || backgroundActions.length > 0) {
        for (const element of all) {
          paintStyle(element);
          pseudoPaint(element);
        }
        outerOwners = all.filter(
          (element) =>
            paintStyle(element).visibility === "visible" &&
            element.getClientRects().length > 0 &&
            opacityPath(element).every(
              (owner) => paintStyle(owner).opacity > 0,
            ) &&
            outerLayers(element).some(
              (layer) => layer === undefined || layer.color.a > 0,
            ),
        );
        const cumulativeOpacity = (element: Element) =>
          opacityPath(element).reduce(
            (opacity, owner) => opacity * paintStyle(owner).opacity,
            1,
          );
        const paints = (element: Element) => {
          const fill = ownFill(element);
          if (cumulativeOpacity(element) <= 0) return false;
          return (
            replacedPaint(element) !== undefined ||
            insetLayers(element).some(
              (layer) => layer === undefined || layer.color.a > 0,
            ) ||
            fill.image !== "none" ||
            fill.color === undefined ||
            fill.color.a * cumulativeOpacity(element) > 0.002
          );
        };
        const outerShadowOcclusion = (
          frame: Element,
          stack: Element[],
        ): string | undefined => {
          for (const element of stack) {
            if (element.contains(frame) || !paints(element)) continue;
            const a = paintStyle(frame),
              b = paintStyle(element);
            if (
              frame.parentElement !== element.parentElement ||
              a.position === "static" ||
              b.position === "static" ||
              a.order !== b.order
            )
              return `outer shadow stacking is unresolved against ${sourceSelector(element)}`;
            const frameZ = a.zIndex === "auto" ? 0 : Number(a.zIndex);
            const elementZ = b.zIndex === "auto" ? 0 : Number(b.zIndex);
            if (
              elementZ > frameZ ||
              (elementZ === frameZ &&
                (frame.compareDocumentPosition(element) &
                  Node.DOCUMENT_POSITION_FOLLOWING) !==
                  0)
            )
              return `another layer paints above the outer shadow: ${sourceSelector(element)}`;
          }
          return undefined;
        };
        const sides = ["top", "right", "bottom", "left"] as const;
        const plan = frames.map((frame) => {
          const style = getComputedStyle(frame);
          const rect = frame.getBoundingClientRect();
          const width = (side: string) =>
            Number.parseFloat(style.getPropertyValue(`border-${side}-width`)) ||
            0;
          const points = sides.flatMap((side) =>
            [0.25, 0.5, 0.75].map((t) => {
              const x = rect.left + rect.width * t;
              const y = rect.top + rect.height * t;
              const inset = width(side) + 1;
              const [inside, outside] =
                side === "top"
                  ? [
                      { x, y: rect.top + inset },
                      { x, y: rect.top - 1 },
                    ]
                  : side === "bottom"
                    ? [
                        { x, y: rect.bottom - inset },
                        { x, y: rect.bottom + 1 },
                      ]
                    : side === "left"
                      ? [
                          { x: rect.left + inset, y },
                          { x: rect.left - 1, y },
                        ]
                      : [
                          { x: rect.right - inset, y },
                          { x: rect.right + 1, y },
                        ];
              return { side, inside, outside };
            }),
          );
          const borderImage = style.borderImageSource !== "none";
          const border = Object.fromEntries(
            sides.map((side): [typeof side, FrameBorder] => {
              const value = style.getPropertyValue(`border-${side}-color`);
              const color = parseRgba(value);
              const base = {
                width: width(side),
                style: style.getPropertyValue(`border-${side}-style`),
              };
              const contributes =
                base.width > 0 && !["none", "hidden"].includes(base.style);
              if (borderImage)
                return [
                  side,
                  {
                    ...base,
                    status: "unavailable",
                    reason: `unsupported border image on ${sourceSelector(frame)}`,
                  },
                ];
              if (
                contributes &&
                ["inset", "outset", "groove", "ridge"].includes(base.style)
              )
                return [
                  side,
                  {
                    ...base,
                    status: "unavailable",
                    reason: `unsupported shaded border style ${base.style} on ${sourceSelector(frame)}`,
                  },
                ];
              if (contributes && color === undefined)
                return [
                  side,
                  {
                    ...base,
                    status: "unavailable",
                    reason: `unsupported border colour ${JSON.stringify(value)} on ${sourceSelector(frame)}`,
                  },
                ];
              return [
                side,
                {
                  ...base,
                  color: rgbOf(color ?? { r: 0, g: 0, b: 0, a: 0 }),
                  alpha: color?.a ?? 0,
                },
              ];
            }),
          ) as Record<(typeof sides)[number], FrameBorder>;
          // A filled/outset border image also reaches the sampled fills or
          // shadow bands, so those cannot independently prove separation.
          const borderImageOverlap =
            borderImage &&
            (style.borderImageSlice.includes("fill") ||
              style.borderImageOutset
                .split(/\s+/)
                .some((value) => Number.parseFloat(value) > 0));
          return {
            frame,
            rect,
            points,
            border,
            boxShadow: style.boxShadow,
            borderImageOverlap,
          };
        });
        const clipAncestors = (frame: Element) => {
          const clips: Element[] = [];
          for (
            let current = frame.parentElement;
            current !== null && current !== document.documentElement;
            current = current.parentElement
          ) {
            const style = paintStyle(current);
            if (style.overflowX !== "visible" || style.overflowY !== "visible")
              clips.push(current);
          }
          return clips;
        };
        const within = (point: { x: number; y: number }) =>
          point.x >= 0 &&
          point.y >= 0 &&
          point.x < innerWidth &&
          point.y < innerHeight;
        const changed = all.filter(
          (element) =>
            paintStyle(element).pointerEvents === "none" &&
            (element instanceof HTMLElement || element instanceof SVGElement),
        ) as Array<HTMLElement | SVGElement>;
        const originals = changed.map((element) => ({
          element,
          style: element.getAttribute("style"),
          rect: element.getBoundingClientRect(),
        }));
        let failure: string | undefined;
        try {
          for (const element of changed)
            element.style.setProperty("pointer-events", "auto", "important");
          const disturbed = originals.find(({ element, rect }) => {
            const style = getComputedStyle(element);
            const after = element.getBoundingClientRect();
            const before = paintStyle(element);
            return (
              style.pointerEvents === "none" ||
              style.backgroundColor !== before.background ||
              style.backgroundClip !== before.clip ||
              style.boxShadow !== before.shadow ||
              style.transform !== before.transform ||
              style.position !== before.position ||
              style.zIndex !== before.zIndex ||
              style.order !== before.order ||
              Number(style.opacity) !== before.opacity ||
              style.visibility !== before.visibility ||
              after.x !== rect.x ||
              after.y !== rect.y ||
              after.width !== rect.width ||
              after.height !== rect.height
            );
          });
          if (disturbed !== undefined)
            throw new Error(
              `making ${sourceSelector(disturbed.element)} hit-testable changed its paint or geometry`,
            );
          for (const { element, value } of backgroundActions) {
            const paint = value.signals?.paint;
            if (paint === undefined) continue;
            const rect = element.getBoundingClientRect();
            const left = Math.max(0, rect.left),
              right = Math.min(innerWidth, rect.right);
            const top = Math.max(0, rect.top),
              bottom = Math.min(innerHeight, rect.bottom);
            if (right <= left || bottom <= top) {
              paint.background = {
                status: "unavailable",
                reason: "background is outside the viewport",
              };
              continue;
            }
            const point = { x: (left + right) / 2, y: (top + bottom) / 2 };
            const stack = document
              .elementsFromPoint(point.x, point.y)
              // The signal describes this element's background, before its
              // descendants paint. Keep unrelated sibling layers as backdrops.
              .filter((node) => node === element || !element.contains(node));
            const index = stack.indexOf(element);
            if (index < 0) {
              paint.background = {
                status: "unavailable",
                reason: "background sample is clipped or not hit-testable",
              };
              continue;
            }
            const occluder = stack.slice(0, index).find(paints);
            if (occluder !== undefined) {
              paint.background = {
                status: "unavailable",
                reason: `another layer paints above the background: ${sourceSelector(occluder)}`,
              };
              continue;
            }
            const resolved = stackPaint(stack.slice(index), undefined, point, {
              subtree: element,
            });
            paint.background =
              "reason" in resolved
                ? { status: "unavailable", reason: resolved.reason }
                : {
                    status: "measured",
                    color: rgbOf(resolved.color),
                    sources: sourceList(resolved.sources),
                  };
          }
          for (const { element, value } of primaryActions) {
            const paint = value.signals?.paint;
            if (paint !== undefined) paint.text = textPaint(element);
          }
          for (const {
            frame,
            rect,
            points,
            border,
            boxShadow,
            borderImageOverlap,
          } of plan) {
            const generatedPaint = [frame, ...frame.querySelectorAll("*")]
              .map(pseudoPaint)
              .find((reason) => reason !== undefined);
            const shadows = shadowLayers(boxShadow);
            const clips = clipAncestors(frame);
            frameEdges.set(
              frame,
              points.map(({ side, inside, outside }): FrameEdgeSample => {
                const base = {
                  side,
                  insidePoint: inside,
                  outsidePoint: outside,
                };
                if (!within(inside) || !within(outside))
                  return { ...base, status: "offscreen" };
                if (borderImageOverlap)
                  return {
                    ...base,
                    status: "unavailable",
                    reason:
                      "unsupported border image fill or outset reaches the sampled boundary",
                  };
                if (generatedPaint !== undefined)
                  return {
                    ...base,
                    status: "unavailable",
                    reason: generatedPaint,
                  };
                const insideStack = document.elementsFromPoint(
                  inside.x,
                  inside.y,
                );
                const index = insideStack.indexOf(frame);
                if (index < 0)
                  return {
                    ...base,
                    status: "unavailable",
                    reason: "the frame edge is clipped or not hit-testable",
                  };
                const occluder = insideStack
                  .slice(0, index)
                  .find(
                    (element) => !frame.contains(element) && paints(element),
                  );
                if (occluder !== undefined)
                  return {
                    ...base,
                    status: "unavailable",
                    reason: "another layer paints over the frame edge",
                    occluder: sourceSelector(occluder),
                  };
                const insidePaint = stackPaint(insideStack, undefined, inside);
                const outsideStack = document
                  .elementsFromPoint(outside.x, outside.y)
                  .filter((element) => !frame.contains(element));
                const outsidePaint = stackPaint(
                  outsideStack,
                  undefined,
                  outside,
                  { owners: [frame] },
                );
                if ("reason" in insidePaint)
                  return {
                    ...base,
                    status: "unavailable",
                    reason: `inside: ${insidePaint.reason}`,
                  };
                if ("reason" in outsidePaint)
                  return {
                    ...base,
                    status: "unavailable",
                    reason: `surround: ${outsidePaint.reason}`,
                  };
                const sideBorder = border[side];
                const clipped = clips.some((clip) => {
                  const rect = clip.getBoundingClientRect();
                  return !(
                    outside.x >= rect.left &&
                    outside.x <= rect.right &&
                    outside.y >= rect.top &&
                    outside.y <= rect.bottom
                  );
                });
                const direction = {
                  top: { x: 0, y: -1 },
                  bottom: { x: 0, y: 1 },
                  left: { x: -1, y: 0 },
                  right: { x: 1, y: 0 },
                }[side];
                const decorationStack = insideStack.filter(
                  (element) => element === frame || !frame.contains(element),
                );
                let sampledBorder: FrameBorder = sideBorder;
                if (
                  sideBorder.status !== "unavailable" &&
                  sideBorder.width > 0 &&
                  sideBorder.alpha > 0 &&
                  !["none", "hidden"].includes(sideBorder.style)
                ) {
                  const point = {
                    x: inside.x + direction.x * (sideBorder.width / 2 + 1),
                    y: inside.y + direction.y * (sideBorder.width / 2 + 1),
                  };
                  const stack = within(point)
                    ? document.elementsFromPoint(point.x, point.y)
                    : [];
                  const index = stack.indexOf(frame);
                  const occluder =
                    index < 0 ? undefined : stack.slice(0, index).find(paints);
                  let paint: ReturnType<typeof stackPaint>;
                  if (index < 0)
                    paint = {
                      reason: "border sample is clipped or not hit-testable",
                    };
                  else if (occluder !== undefined)
                    paint = {
                      reason: `another layer paints above the border: ${sourceSelector(occluder)}`,
                    };
                  else
                    paint = stackPaint(
                      stack.slice(index),
                      {
                        owner: frame,
                        color: { ...sideBorder.color, a: sideBorder.alpha },
                        skipInset: true,
                      },
                      point,
                    );
                  sampledBorder =
                    "reason" in paint
                      ? {
                          width: sideBorder.width,
                          style: sideBorder.style,
                          status: "unavailable",
                          reason: paint.reason,
                        }
                      : {
                          ...sideBorder,
                          paint: {
                            color: rgbOf(paint.color),
                            sources: sourceList(paint.sources),
                          },
                        };
                }
                let shadowFailure: string | undefined;
                const layers = shadows.flatMap((shadow) => {
                  if (shadow === undefined) return [];
                  // Offsets towards this edge widen an outer shadow
                  // past it and narrow an inset one inside it.
                  const offset =
                    shadow.x * direction.x + shadow.y * direction.y;
                  const solid =
                    shadow.spread + (shadow.inset ? -offset : offset);
                  const extent = solid + shadow.blur / 2;
                  const alpha =
                    solid >= 1 ? shadow.color.a : shadow.color.a / 2;
                  const shadowStack = shadow.inset
                    ? decorationStack
                    : [frame, ...outsideStack];
                  const paint = stackPaint(
                    shadowStack,
                    {
                      owner: frame,
                      color: { ...shadow.color, a: alpha },
                      skipFill: !shadow.inset,
                      skipInset: true,
                    },
                    shadow.inset ? inside : outside,
                  );
                  if ("reason" in paint) {
                    shadowFailure = paint.reason;
                    return [];
                  }
                  return [
                    {
                      color: rgbOf(shadow.color),
                      paint: {
                        color: rgbOf(paint.color),
                        sources: sourceList(paint.sources),
                      },
                      // A blur-only edge paints at about half strength.
                      alpha,
                      extent,
                      inset: shadow.inset,
                      clipped: !shadow.inset && clipped,
                    },
                  ];
                });
                const shadowSamples: Array<{
                  color: { r: number; g: number; b: number };
                  sources: string[];
                  inset: boolean;
                  distance: number;
                  backdrop: { r: number; g: number; b: number };
                }> = [];
                for (const inset of [false, true]) {
                  const activeLayers = layers.filter(
                    (layer) =>
                      layer.inset === inset &&
                      layer.extent > 0 &&
                      layer.alpha > 0 &&
                      !layer.clipped,
                  );
                  if (
                    activeLayers.length > 1 &&
                    shadows.some(
                      (shadow) => shadow?.inset === inset && shadow.blur > 0,
                    )
                  ) {
                    shadowFailure =
                      "overlapping blurred shadows cannot be resolved by solid-paint sampling";
                    continue;
                  }
                  const extents = [
                    ...new Set(activeLayers.map((layer) => layer.extent)),
                  ].sort((a, b) => a - b);
                  let previous = 0;
                  for (const extent of extents) {
                    const distance = (previous + extent) / 2;
                    previous = extent;
                    let combined = clear;
                    // CSS lists the uppermost shadow first. Sample every
                    // extent band so a lower layer can remain visible past
                    // its cover, without accepting a fully covered layer.
                    for (const layer of [...activeLayers].reverse()) {
                      if (layer.extent > distance)
                        combined = over(
                          { ...layer.color, a: layer.alpha },
                          combined,
                          frame,
                        );
                    }
                    if (combined.a <= 0) continue;
                    const origin = inset ? inside : outside;
                    const shift = (distance - 1) * (inset ? -1 : 1);
                    const point = {
                      x: origin.x + direction.x * shift,
                      y: origin.y + direction.y * shift,
                    };
                    if (!within(point)) {
                      shadowFailure = "shadow band is outside the viewport";
                      continue;
                    }
                    const bandStack = document
                      .elementsFromPoint(point.x, point.y)
                      .filter((element) => inset || !frame.contains(element));
                    if (
                      (inset && !bandStack.includes(frame)) ||
                      (!inset &&
                        bandStack.some(
                          (element) => !outsideStack.includes(element),
                        ))
                    ) {
                      shadowFailure =
                        "shadow band is clipped or its surrounding paint stack changes";
                      continue;
                    }
                    if (!inset) {
                      const occlusion = outerShadowOcclusion(frame, bandStack);
                      if (occlusion !== undefined) {
                        shadowFailure = occlusion;
                        continue;
                      }
                    }
                    // For an inset cue compare with actual interior paint,
                    // rather than a CSS fill that the shadow may fully hide.
                    const interiorPoint = {
                      x: rect.left + rect.width / 2,
                      y: rect.top + rect.height / 2,
                    };
                    const interiorStack =
                      inset && within(interiorPoint)
                        ? document.elementsFromPoint(
                            interiorPoint.x,
                            interiorPoint.y,
                          )
                        : [];
                    if (
                      inset &&
                      (!interiorStack.includes(frame) ||
                        interiorStack
                          .slice(0, interiorStack.indexOf(frame))
                          .some(
                            (element) =>
                              !frame.contains(element) && paints(element),
                          ))
                    ) {
                      shadowFailure =
                        "inset shadow interior reference is offscreen, clipped or occluded";
                      continue;
                    }
                    const backdrop = inset
                      ? stackPaint(interiorStack, undefined, interiorPoint)
                      : stackPaint(bandStack, undefined, point, {
                          owners: [frame],
                        });
                    if ("reason" in backdrop) {
                      shadowFailure = backdrop.reason;
                      continue;
                    }
                    const paint = stackPaint(
                      inset ? bandStack : [frame, ...bandStack],
                      {
                        owner: frame,
                        skipFill: !inset,
                        skipInset: true,
                        color: {
                          r: combined.r / combined.a,
                          g: combined.g / combined.a,
                          b: combined.b / combined.a,
                          a: combined.a,
                        },
                      },
                      point,
                    );
                    if ("reason" in paint) shadowFailure = paint.reason;
                    else
                      shadowSamples.push({
                        color: rgbOf(paint.color),
                        sources: sourceList(paint.sources),
                        inset,
                        distance,
                        backdrop: rgbOf(backdrop.color),
                      });
                  }
                }
                return {
                  ...base,
                  status: "measured",
                  inside: {
                    color: rgbOf(insidePaint.color),
                    sources: sourceList(insidePaint.sources),
                  },
                  surround: {
                    color: rgbOf(outsidePaint.color),
                    sources: sourceList(outsidePaint.sources),
                  },
                  border: sampledBorder,
                  shadows:
                    shadows.some((shadow) => shadow === undefined) ||
                    shadowFailure !== undefined
                      ? {
                          status: "unavailable",
                          reason:
                            shadowFailure ??
                            `unparsed box-shadow ${JSON.stringify(boxShadow.slice(0, 80))}`,
                        }
                      : { status: "measured", layers, samples: shadowSamples },
                };
              }),
            );
          }
        } catch (error) {
          failure = error instanceof Error ? error.message : String(error);
        } finally {
          const unrestored: string[] = [];
          for (const { element, style } of originals) {
            try {
              // Chromium re-serialises a CSSOM-modified inline style after
              // removeAttribute unless the attribute is replaced first.
              element.setAttribute("style", style ?? "");
              if (style === null) element.removeAttribute("style");
            } catch {
              // Checked below.
            }
            if (element.getAttribute("style") !== style)
              unrestored.push(sourceSelector(element));
          }
          if (unrestored.length > 0)
            // biome-ignore lint/correctness/noUnsafeFinally: a page left modified must fail observation.
            throw new Error(
              `could not restore inline styles after frame sampling: ${unrestored.slice(0, 5).join(", ")}`,
            );
        }
        if (failure !== undefined) {
          for (const { value } of backgroundActions) {
            const paint = value.signals?.paint;
            if (paint !== undefined)
              paint.background = {
                status: "unavailable",
                reason: `background sampling failed: ${failure}`,
              };
          }
          for (const { value } of primaryActions) {
            const paint = value.signals?.paint;
            if (paint !== undefined)
              paint.text = {
                status: "unavailable",
                reason: `text sampling failed: ${failure}`,
              };
          }
          for (const { frame, points } of plan)
            frameEdges.set(
              frame,
              points.map(({ side, inside, outside }) => ({
                side,
                insidePoint: inside,
                outsidePoint: outside,
                status: "unavailable",
                reason: `frame sampling failed: ${failure}`,
              })),
            );
        }
      }
      const viewportIntersections = new Map<Element, Rect>();
      if (dialogControls.length > 0)
        await new Promise<void>((resolve) => {
          const pending = new Set(dialogControls.map(({ element }) => element));
          const observer = new IntersectionObserver((entries) => {
            for (const entry of entries) {
              const { x, y, width, height } = entry.intersectionRect;
              viewportIntersections.set(entry.target, { x, y, width, height });
              pending.delete(entry.target);
            }
            if (pending.size === 0) {
              clearTimeout(timeout);
              observer.disconnect();
              resolve();
            }
          });
          // A suspended renderer may not deliver layout notifications. Leave
          // its signal absent (unavailable coverage) rather than hang capture.
          const timeout = setTimeout(() => {
            observer.disconnect();
            resolve();
          }, 1000);
          for (const element of pending) observer.observe(element);
        });
      const images = imagesInput
        ? await Promise.all(
            [...document.querySelectorAll("img")].map(async (image) => {
              await Promise.race([
                image.decode().catch(() => undefined),
                new Promise((resolve) => setTimeout(resolve, 500)),
              ]);
              const rect = image.getBoundingClientRect();
              const styles = getComputedStyle(image);
              return {
                selector: selectorFor(image),
                src: image.getAttribute("src") ?? "",
                currentSrc: image.currentSrc,
                complete: image.complete,
                naturalWidth: image.naturalWidth,
                naturalHeight: image.naturalHeight,
                visible:
                  rect.width > 0 &&
                  rect.height > 0 &&
                  styles.visibility !== "hidden" &&
                  styles.display !== "none",
              };
            }),
          )
        : undefined;
      // Optional page geometry: retain only evidence needed by offline checks.
      const geometryRect = (element: Element): Rect => {
        const r = element.getBoundingClientRect();
        return { x: r.x, y: r.y, width: r.width, height: r.height };
      };
      const observedDom = new Map(
        observed.map((entry) => [entry.element, entry.value]),
      );
      const geometrySelector = (element: Element) =>
        observedDom.get(element)?.selector ?? selectorFor(element);
      const bandEdges: GeometryScan<BandEdgeObservation> | undefined =
        bandEdgesInput
          ? (() => {
              // A fixed bar spanning the viewport width at its top or bottom
              // edge is page chrome (a header or footer band), not floating
              // decoration or an overlay.
              const chrome = (element: Element) => {
                if (getComputedStyle(element).position !== "fixed")
                  return false;
                const r = element.getBoundingClientRect();
                return (
                  Math.abs(r.left) <= 1 &&
                  Math.abs(r.right - document.documentElement.clientWidth) <=
                    1 &&
                  r.height < window.innerHeight / 2 &&
                  (Math.abs(r.top) <= 1 ||
                    Math.abs(r.bottom - window.innerHeight) <= 1)
                );
              };
              const excluded = (element: Element) =>
                !isVisibleContent(element, false) ||
                element.matches(
                  'dialog,[role="dialog"],[role="alertdialog"],[popover]',
                ) ||
                (["absolute", "fixed"].includes(
                  getComputedStyle(element).position,
                ) &&
                  !chrome(element));
              const children = (element: Element) =>
                [...element.children].filter(
                  (child) =>
                    !excluded(child) &&
                    (isRendered(child) ||
                      getComputedStyle(child).display === "contents"),
                );
              const media = (element: Element) =>
                element.matches("img,video,canvas,iframe,svg") &&
                !(
                  element instanceof SVGElement &&
                  element.parentElement?.closest("svg")
                );
              const directText = (element: Element) =>
                observedDom.get(element)?.signals?.renderedContent
                  ?.directText ??
                [...element.childNodes].some(
                  (node) =>
                    node.nodeType === Node.TEXT_NODE &&
                    node.textContent?.trim(),
                );
              const foregroundCache = new Map<Element, boolean>();
              const foreground = (element: Element): boolean => {
                const cached = foregroundCache.get(element);
                if (cached !== undefined) return cached;
                const result =
                  !excluded(element) &&
                  (media(element) ||
                    directText(element) ||
                    children(element).some(foreground));
                foregroundCache.set(element, result);
                return result;
              };
              const transparent = (element: Element) => {
                const style = getComputedStyle(element);
                return (
                  !directText(element) &&
                  !media(element) &&
                  style.backgroundImage === "none" &&
                  (style.backgroundColor === "transparent" ||
                    style.backgroundColor === "rgba(0, 0, 0, 0)") &&
                  [
                    style.borderLeftWidth,
                    style.borderRightWidth,
                    style.borderTopWidth,
                    style.borderBottomWidth,
                  ].every((v) => pxOf(v) === 0)
                );
              };
              const semanticBand = (element: Element) =>
                element.matches(
                  'header,nav,section,footer,article,aside,[role="banner"],[role="contentinfo"]',
                );
              const vertical = (items: Element[]) =>
                items.every((item, i) => {
                  if (i === 0) return true;
                  const a = items[i - 1]?.getBoundingClientRect();
                  const b = item.getBoundingClientRect();
                  return (
                    a !== undefined &&
                    b.top >= a.bottom - 1 &&
                    Math.min(a.right, b.right) - Math.max(a.left, b.left) >
                      Math.min(a.width, b.width) / 2
                  );
                });
              const expand = (element: Element, root = false): Element[] => {
                const items = children(element).filter(
                  (child) => foreground(child) || semanticBand(child),
                );
                const main = element.matches('main,[role="main"]');
                const layoutChildren = items.every(
                  (child) =>
                    !child.matches(
                      "h1,h2,h3,h4,h5,h6,p,button,a,span,img,video,canvas,iframe,svg",
                    ),
                );
                if (
                  (root ||
                    main ||
                    (!semanticBand(element) &&
                      transparent(element) &&
                      layoutChildren)) &&
                  items.length > 0 &&
                  // Fixed chrome overlaps the flow it floats over.
                  vertical(items.filter((child) => !chrome(child)))
                )
                  return items.flatMap((child) => expand(child));
                return foreground(element) || semanticBand(element)
                  ? [element]
                  : [];
              };
              const bands = expand(document.body, true);
              const records = bands.map((band) => {
                const allMedia: Element[] = [];
                let text = false;
                const inspect = (element: Element) => {
                  if (excluded(element)) return;
                  if (directText(element)) text = true;
                  if (media(element)) {
                    allMedia.push(element);
                    return;
                  }
                  for (const child of children(element)) inspect(child);
                };
                inspect(band);
                const fullWidth = (element: Element) => {
                  const r = element.getBoundingClientRect();
                  return (
                    Math.abs(r.left) <= 1 &&
                    Math.abs(r.right - document.documentElement.clientWidth) <=
                      1
                  );
                };
                const fullBleedMedia = !text && allMedia.some(fullWidth);
                const frontier: Array<{
                  selector: string;
                  left: number;
                  right: number;
                }> = [];
                const descend = (element: Element, parent: Element | null) => {
                  if (excluded(element) || !foreground(element)) return;
                  if (text && media(element) && fullWidth(element)) return;
                  const r = element.getBoundingClientRect();
                  const style = getComputedStyle(element);
                  if (style.display === "contents") {
                    for (const child of children(element))
                      descend(child, parent);
                    return;
                  }
                  let left =
                    r.left +
                    pxOf(style.borderLeftWidth) +
                    pxOf(style.paddingLeft);
                  let right =
                    r.right -
                    pxOf(style.borderRightWidth) -
                    pxOf(style.paddingRight);
                  const p = parent?.getBoundingClientRect();
                  // A start-flush box that stops short is a text measure, not a gutter.
                  const parentStyle = parent && getComputedStyle(parent);
                  if (p && parentStyle) {
                    const parentLeft =
                      p.left +
                      pxOf(parentStyle.borderLeftWidth) +
                      pxOf(parentStyle.paddingLeft);
                    const parentRight =
                      p.right -
                      pxOf(parentStyle.borderRightWidth) -
                      pxOf(parentStyle.paddingRight);
                    if (style.direction === "rtl") {
                      if (
                        Math.abs(r.right - parentRight) <= 1 &&
                        r.left > p.left + 1
                      )
                        left = Math.min(left, parentLeft);
                    } else if (
                      Math.abs(r.left - parentLeft) <= 1 &&
                      r.right < p.right - 1
                    )
                      right = Math.max(right, parentRight);
                  }
                  const inset =
                    p !== undefined &&
                    (r.left > p.left + 1 || r.right < p.right - 1) &&
                    !["inline", "inline-block", "inline-flex"].includes(
                      style.display,
                    );
                  const padded =
                    pxOf(style.paddingLeft) > 0 || pxOf(style.paddingRight) > 0;
                  // A shell around full-bleed media must not hide an independent text gutter.
                  const mixedMedia =
                    text &&
                    allMedia.some(
                      (image) => element.contains(image) && fullWidth(image),
                    );
                  if (
                    !mixedMedia &&
                    (inset || padded || directText(element) || media(element))
                  ) {
                    if (right >= left)
                      frontier.push({
                        selector: geometrySelector(element),
                        left,
                        right,
                      });
                    return;
                  }
                  for (const child of children(element))
                    descend(child, element);
                };
                descend(band, null);
                return {
                  selector: geometrySelector(band),
                  rect: geometryRect(band),
                  fullBleedMedia,
                  content:
                    frontier.length === 0
                      ? null
                      : {
                          left: Math.min(...frontier.map((f) => f.left)),
                          right: Math.max(...frontier.map((f) => f.right)),
                          selectors: frontier.map((f) => f.selector),
                        },
                };
              });
              return { status: "ran", records };
            })()
          : undefined;

      const wordBreaks: GeometryScan<WordBreakObservation> | undefined =
        wordBreakInput
          ? (() => {
              const records: WordBreakObservation[] = [];
              const reasons = new Set<string>();
              const ownerSelector =
                'h1,h2,h3,h4,h5,h6,[role="heading"][aria-level],button,[role="button"]';
              const owners = [
                ...document.querySelectorAll(ownerSelector),
              ].filter(
                (el) =>
                  isVisibleContent(el) &&
                  (/^H[1-6]$/.test(el.tagName) ||
                    el.getAttribute("role") !== "heading" ||
                    /^[1-9]\d*$/.test(el.getAttribute("aria-level") ?? "")),
              );
              const ownerSet = new Set(owners);
              const nearestOwner = (element: Element) => {
                for (
                  let current: Element | null = element;
                  current;
                  current = current.parentElement
                )
                  if (ownerSet.has(current)) return current;
                return null;
              };
              let wordSegmenter: Intl.Segmenter;
              try {
                wordSegmenter = new Intl.Segmenter(
                  document.documentElement.lang || undefined,
                  { granularity: "word" },
                );
              } catch {
                return {
                  status: "unavailable",
                  reason:
                    "Document language cannot be used for word segmentation",
                  records,
                };
              }
              const graphemes = new Intl.Segmenter(undefined, {
                granularity: "grapheme",
              });
              let work = 0;
              for (const owner of owners) {
                if (work > 30000) {
                  reasons.add("Text range work limit reached");
                  break;
                }
                if (getComputedStyle(owner).writingMode !== "horizontal-tb") {
                  reasons.add("Vertical writing mode is unsupported");
                  continue;
                }
                type TextPiece = {
                  node: Text;
                  index: number;
                  start: number;
                  end: number;
                };
                const pieces: TextPiece[] = [];
                let text = "";
                let nodeIndex = 0;
                let truncated = false;
                const boundary = () => {
                  text += "\n";
                };
                const walk = (node: Node) => {
                  if (text.length > 20000 || nodeIndex > 2000) {
                    truncated = true;
                    return;
                  }
                  if (node.nodeType === Node.TEXT_NODE) {
                    const parent = node.parentElement;
                    const index = nodeIndex++;
                    if (
                      !parent ||
                      nearestOwner(parent) !== owner ||
                      !isVisibleContent(parent, false)
                    ) {
                      boundary();
                      return;
                    }
                    const original = node.textContent ?? "";
                    const value = original.slice(
                      0,
                      Math.max(0, 20000 - text.length),
                    );
                    if (value.length < original.length) truncated = true;
                    pieces.push({
                      node: node as Text,
                      index,
                      start: text.length,
                      end: text.length + value.length,
                    });
                    text += value;
                    return;
                  }
                  if (!(node instanceof Element)) return;
                  if (
                    node !== owner &&
                    (!isVisibleContent(node, false) || ownerSet.has(node))
                  ) {
                    boundary();
                    return;
                  }
                  if (node.tagName === "BR") {
                    boundary();
                    return;
                  }
                  const block =
                    node !== owner &&
                    !["inline", "contents"].includes(
                      getComputedStyle(node).display,
                    );
                  if (block) boundary();
                  for (const child of node.childNodes) {
                    walk(child);
                    if (truncated) break;
                  }
                  if (block) boundary();
                };
                walk(owner);
                if (truncated) reasons.add("Owner text size limit reached");
                const rectCache = new Map<string, WordFragment | null>();
                const fragment = (
                  start: number,
                  end: number,
                ): WordFragment | null => {
                  const key = `${start}:${end}`;
                  if (rectCache.has(key)) return rectCache.get(key) ?? null;
                  const piece = pieces.find(
                    (p) => p.start <= start && p.end >= end,
                  );
                  if (!piece?.node.parentElement) return null;
                  const parent = piece.node.parentElement;
                  if (
                    getComputedStyle(parent).writingMode !== "horizontal-tb"
                  ) {
                    reasons.add("Vertical writing mode is unsupported");
                    return null;
                  }
                  const range = document.createRange();
                  range.setStart(piece.node, start - piece.start);
                  range.setEnd(piece.node, end - piece.start);
                  work++;
                  const clip = clipFor(parent, true).paint;
                  const boxes = [...range.getClientRects()].filter(
                    (r) =>
                      r.width > 0 &&
                      r.height > 0 &&
                      r.left >= clip.left - 0.5 &&
                      r.right <= clip.right + 0.5 &&
                      r.top >= clip.top - 0.5 &&
                      r.bottom <= clip.bottom + 0.5,
                  );
                  const box = boxes.length === 1 ? boxes[0] : undefined;
                  const result = box
                    ? {
                        selector: geometrySelector(parent),
                        node: piece.index,
                        start: start - piece.start,
                        end: end - piece.start,
                        text: text.slice(start, end),
                        rect: {
                          x: box.x,
                          y: box.y,
                          width: box.width,
                          height: box.height,
                        },
                      }
                    : null;
                  rectCache.set(key, result);
                  return result;
                };
                const sameLine = (a: Rect, b: Rect) =>
                  Math.min(a.y + a.height, b.y + b.height) >
                  Math.max(a.y, b.y) + 0.5;
                for (const segment of wordSegmenter.segment(text)) {
                  if (work > 30000) {
                    reasons.add("Text range work limit reached");
                    break;
                  }
                  if (!segment.isWordLike || segment.segment.length < 2)
                    continue;
                  // These scripts permit native intra-word wrapping. Latin/RTL words still require proof.
                  if (
                    /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u.test(
                      segment.segment,
                    )
                  )
                    continue;
                  const start = segment.index,
                    end = start + segment.segment.length;
                  if (segment.segment.length > 160) {
                    reasons.add("Word size limit reached");
                    continue;
                  }
                  // Check whole text-node ranges before spending work on graphemes.
                  const rects: DOMRect[] = [];
                  for (const piece of pieces.filter(
                    (p) => p.start < end && p.end > start,
                  )) {
                    const range = document.createRange();
                    range.setStart(
                      piece.node,
                      Math.max(start, piece.start) - piece.start,
                    );
                    range.setEnd(
                      piece.node,
                      Math.min(end, piece.end) - piece.start,
                    );
                    rects.push(
                      ...[...range.getClientRects()].filter(
                        (r) => r.width > 0 && r.height > 0,
                      ),
                    );
                    work++;
                  }
                  const first = rects[0];
                  if (!first || rects.every((r) => sameLine(first, r)))
                    continue;
                  if (work + segment.segment.length > 30000) {
                    reasons.add("Text range work limit reached");
                    break;
                  }
                  let clipped = false;
                  for (
                    let el: Element | null = owner;
                    el && el !== document.body;
                    el = el.parentElement
                  )
                    if (hasActiveLineClamp(el)) clipped = true;
                  if (clipped) {
                    reasons.add("Line-clamped word measurement is incomplete");
                    continue;
                  }
                  const chars = [...graphemes.segment(segment.segment)];
                  for (let i = 1; i < chars.length; i++) {
                    const a = chars[i - 1],
                      b = chars[i];
                    if (
                      !a ||
                      !b ||
                      /[\u00ad\-\u2010\u2011]/u.test(a.segment + b.segment)
                    )
                      continue;
                    const before = fragment(
                      start + a.index,
                      start + a.index + a.segment.length,
                    );
                    const after = fragment(
                      start + b.index,
                      start + b.index + b.segment.length,
                    );
                    if (!before || !after || sameLine(before.rect, after.rect))
                      continue;
                    const parents = [
                      pieces.find(
                        (p) =>
                          p.start <= start + a.index && p.end > start + a.index,
                      )?.node.parentElement,
                      pieces.find(
                        (p) =>
                          p.start <= start + b.index && p.end > start + b.index,
                      )?.node.parentElement,
                    ];
                    if (
                      parents.some(
                        (parent) =>
                          parent &&
                          getComputedStyle(parent).hyphens === "auto" &&
                          getComputedStyle(parent).wordBreak !== "break-all",
                      )
                    ) {
                      reasons.add(
                        "Automatically generated hyphen boundary cannot be resolved",
                      );
                      continue;
                    }
                    records.push({
                      selector: geometrySelector(owner),
                      word: segment.segment,
                      text: text.slice(Math.max(0, start - 30), start + 130),
                      start,
                      end,
                      before,
                      after,
                    });
                  }
                }
              }
              return reasons.size
                ? {
                    status: "partial",
                    reason: [...reasons].join("; "),
                    records,
                  }
                : { status: "ran", records };
            })()
          : undefined;

      const geometry = window.__idiomVisibility;
      const shellVisibility: import("./types.js").ShellVisibilityObservation = {
        shell: { status: "not-configured" },
        overlays: overlayInput.map((selector) => {
          try {
            return {
              selector,
              status: "measured" as const,
              matches: [...document.querySelectorAll(selector)].map(
                (element) => {
                  const ancestors: string[] = [];
                  for (
                    let parent = element.parentElement;
                    parent;
                    parent = parent.parentElement
                  )
                    ancestors.push(selectorFor(parent));
                  return {
                    ...geometry.measure(element),
                    selector: selectorFor(element),
                    ancestors,
                  };
                },
              ),
            };
          } catch {
            return { selector, status: "invalid" as const, matches: [] };
          }
        }),
      };
      if (shellInput !== undefined) {
        try {
          const matches = document.querySelectorAll(shellInput);
          const shell = matches[0];
          if (matches.length !== 1 || shell === undefined)
            shellVisibility.shell = {
              status: matches.length === 0 ? "missing" : "ambiguous",
              selector: shellInput,
              count: matches.length,
            };
          else {
            const raw = shell.getBoundingClientRect();
            const rect = {
              x: raw.x,
              y: raw.y,
              width: raw.width,
              height: raw.height,
            };
            const client = geometry.client(shell);
            const viewport = {
              x: 0,
              y: 0,
              width: innerWidth,
              height: innerHeight,
            };
            const limit = Math.min(client.y + client.height, viewport.height);
            const extending = [...shell.querySelectorAll("*")].flatMap(
              (element) => {
                const extent = geometry.extent(element, shell);
                return extent &&
                  (extent.y + shell.scrollTop < client.y ||
                    extent.y + extent.height + shell.scrollTop >
                      client.y + client.height ||
                    ((rect.y < 0 || rect.y + rect.height > viewport.height) &&
                      (extent.y < 0 || extent.y + extent.height > limit)))
                  ? [{ element, rect: extent }]
                  : [];
              },
            );
            shellVisibility.shell = {
              status: "measured",
              selector: shellInput,
              rect,
              client,
              viewport,
              scrollHeight: shell.scrollHeight,
              clientHeight: shell.clientHeight,
              extending: extending
                .filter(
                  (entry) =>
                    !extending.some(
                      (other) =>
                        entry.element !== other.element &&
                        entry.element.contains(other.element) &&
                        other.rect.y + other.rect.height >=
                          entry.rect.y + entry.rect.height &&
                        other.rect.y <= Math.max(client.y, entry.rect.y),
                    ),
                )
                .map(({ element, rect }) => ({
                  selector: selectorFor(element),
                  rect,
                  description: `${element.tagName.toLowerCase()}${[...element.classList].map((value) => `.${value}`).join("")}`,
                })),
            };
          }
        } catch {
          shellVisibility.shell = {
            status: "invalid",
            selector: shellInput,
            count: 0,
          };
        }
      }
      return {
        version: 2,
        ...(Number.parseFloat(getComputedStyle(root).fontSize) > 0
          ? { rootFontSize: Number.parseFloat(getComputedStyle(root).fontSize) }
          : {}),
        ...(root.hasAttribute("data-theme")
          ? { theme: root.getAttribute("data-theme") as string }
          : {}),
        shellVisibility,
        viewport: { width: innerWidth, height: innerHeight },
        input: {
          pointer: matchMedia("(pointer: coarse)").matches
            ? "coarse"
            : matchMedia("(pointer: none)").matches
              ? "none"
              : "fine",
          hover: matchMedia("(hover: none)").matches ? "none" : "hover",
          maxTouchPoints: navigator.maxTouchPoints,
        },
        document: {
          scrollWidth: root.scrollWidth,
          scrollHeight: root.scrollHeight,
          clientWidth: root.clientWidth,
          clientHeight: root.clientHeight,
        },
        elements: observed.map(({ element, value }) => {
          const viewportIntersection = viewportIntersections.get(element);
          const edges = frameEdges.get(element);
          return value.signals === undefined ||
            (viewportIntersection === undefined && edges === undefined)
            ? value
            : {
                ...value,
                signals: {
                  ...value.signals,
                  ...(viewportIntersection === undefined
                    ? {}
                    : { viewportIntersection }),
                  ...(edges === undefined ? {} : { frameEdges: edges }),
                },
              };
        }),
        headings: observed.flatMap((entry) =>
          entry.value.headingLevel === undefined || !entry.value.visible
            ? []
            : [
                {
                  selector: entry.value.selector,
                  level: entry.value.headingLevel,
                  text: entry.value.text,
                  axeTargets: axeTargets.filter((target) => {
                    try {
                      return entry.element.matches(target);
                    } catch {
                      return false;
                    }
                  }),
                },
              ],
        ),
        tokens: tokenInput,
        maskMembership,
        invariants,
        selectionGroups,
        dialogs,
        overlaps,
        clippedText,
        ...(bandEdges === undefined ? {} : { bandEdges }),
        ...(wordBreaks === undefined ? {} : { wordBreaks }),
        fieldGroups,
        emptyRegions,
        ...(components.length === 0 ? {} : { components }),
        ...(mediaFrames === undefined ? {} : { mediaFrames }),
        ...(collections === undefined ? {} : { collections }),
        ...(selectorMarks.length === 0 ? {} : { selectorMarks }),
        ...(images === undefined ? {} : { images }),
      };
    },
    {
      shellInput: observeOptions.shell,
      overlayInput: observeOptions.floatingOverlays ?? [],
      tokenInput: normalizedTokens,
      axeTargets: axeHeadingTargets,
      maskSelectors: masks,
      componentInput: observeOptions.components ?? [],
      inferredInput: observeOptions.inferredComponents ?? [],
      invariantInput: (observeOptions.invariants ?? []).map((assertion) => ({
        ...assertion,
        requiredSelectors: invariantSelectors(assertion.declaration),
        label: invariantLabel(assertion),
      })),
      markInput: observeOptions.marks ?? [],
      imagesInput: observeOptions.images === true,
      bandEdgesInput: observeOptions.bandEdges === true,
      wordBreakInput: observeOptions.wordBreak === true,
      emptyInput: observeOptions.emptyState ?? {
        regions: [],
        auto: true,
        ignore: [],
      },
      mediaInput: {
        auto: observeOptions.mediaFill?.auto ?? false,
        ignore: observeOptions.mediaFill?.ignore ?? [],
      },
      collectionInput: observeOptions.collections ?? [],
      menuTriggerSource: menuTriggerPattern.source,
    },
  );
  if (
    artifact.tokens.status === "configured" &&
    artifact.tokens.typedValues !== undefined
  ) {
    const properties = [
      "color",
      "backgroundColor",
      "borderTopColor",
      "borderRightColor",
      "borderBottomColor",
      "borderLeftColor",
      "outlineColor",
      "fill",
      "stroke",
    ] as const;
    const values = [
      ...new Set(
        artifact.elements
          .flatMap((e) => properties.map((p) => e.styles[p]))
          .filter(
            (value) =>
              value !== "none" && value !== "" && !/^rgba?\(/.test(value),
          ),
      ),
    ];
    if (values.length) {
      const converted = await page.evaluate(
        normalizeCssValues,
        values.map((value) => ({ value, kind: "color" as const })),
      );
      const replacements = new Map(
        values.map((v, i) => [v, converted[i]?.value]),
      );
      for (const element of artifact.elements)
        for (const property of properties) {
          const value = replacements.get(element.styles[property]);
          if (value) element.styles[property] = value;
        }
    }
  }
  if (artifact.version === 2 && liveness) artifact.liveness = liveness;
  return observeOptions.fresh === true
    ? { ...artifact, fresh: true }
    : artifact;
}

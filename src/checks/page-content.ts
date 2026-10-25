import {
  axeSelector,
  axeSeverity,
  axeViolations,
  codeTags,
  isBounded,
  isVisuallyHidden,
  px,
  unavailable,
  verify,
} from "./shared.js";
import type {
  ChecksConfig,
  DeterministicCheck,
  FindingCandidate,
  ObservationArtifactV2,
  ObservedElementV2,
  Rect,
} from "./types.js";

export type PageSectionRole = "hero" | "body" | "final" | "footer";

export type PageSection = {
  id: string;
  selector: string;
  structuralPath: string;
  rect: Rect;
  heading?: string | undefined;
  role: PageSectionRole;
};

const MIN_SECTION_HEIGHT = 80;

const within = (path: string, ancestor: string) =>
  path.startsWith(`${ancestor}/`);

const pathHas = (path: string, tag: string) =>
  path.split("/").some((segment) => segment.startsWith(`${tag}[`));

/**
 * The page's top-level content sections in reading order: section, article
 * and footer elements, a header that carries the h1, and the direct children
 * of main. A nested candidate belongs to its outer section; a main child that
 * only wraps semantic sections is a wrapper, not a section.
 */
export function pageSections(
  observation: ObservationArtifactV2,
  viewportHeight: number,
): PageSection[] {
  const elements = observation.elements;
  const visible = elements.filter(
    (element) => element.visible && !isVisuallyHidden(element),
  );
  const mains = visible
    .filter((element) => element.tag === "main")
    .map((element) => element.structuralPath);
  const semantic = visible.filter(
    (element) =>
      ["section", "article", "footer"].includes(element.tag) ||
      (element.tag === "header" &&
        visible.some(
          (inner) =>
            inner.tag === "h1" &&
            within(inner.structuralPath, element.structuralPath),
        )),
  );
  const mainChildren = visible.filter((element) =>
    mains.some(
      (main) =>
        within(element.structuralPath, main) &&
        !element.structuralPath.slice(main.length + 1).includes("/"),
    ),
  );
  const candidates = [
    ...semantic,
    ...mainChildren.filter(
      (element) =>
        !semantic.includes(element) &&
        !semantic.some((inner) =>
          within(inner.structuralPath, element.structuralPath),
        ),
    ),
  ];
  const sections = candidates
    .filter(
      (element) =>
        element.rect.height >= MIN_SECTION_HEIGHT &&
        !candidates.some((outer) =>
          within(element.structuralPath, outer.structuralPath),
        ),
    )
    .sort(
      (a, b) =>
        a.rect.y - b.rect.y || a.structuralPath.localeCompare(b.structuralPath),
    );
  const isFooter = (element: ObservedElementV2) =>
    element.tag === "footer" || pathHas(element.structuralPath, "footer");
  const content = sections.filter((element) => !isFooter(element));
  const hero = content.find((element) => element.rect.y < viewportHeight);
  const final = content.length >= 2 ? content.at(-1) : undefined;
  return sections.map((element, index) => {
    const heading = visible.find(
      (inner) =>
        inner.headingLevel !== undefined &&
        within(inner.structuralPath, element.structuralPath),
    );
    const text = heading?.text.replace(/\s+/g, " ").trim() ?? "";
    return {
      id: `s${index + 1}`,
      selector: element.selector,
      structuralPath: element.structuralPath,
      rect: element.rect,
      ...(text === "" ? {} : { heading: text.slice(0, 80) }),
      role: isFooter(element)
        ? "footer"
        : element === hero && content.length >= 2
          ? "hero"
          : element === final
            ? "final"
            : "body",
    };
  });
}

const placeholderPatterns: RegExp[] = [
  /lorem ipsum/i,
  /dolor sit amet/i,
  /consectetur adipiscing/i,
  /\{\{[^}]*\}\}/,
  /\[(?:insert|your|add|placeholder)[^\]]*\]/i,
  // Upper case only: "todo" is ordinary product copy ("Your todo list").
  /\b(?:TODO|TBD|FIXME|XXX)\b/,
];

const placeholderTexts = new Set([
  "placeholder",
  "headline goes here",
  "your headline",
  "sample text",
]);

const altRules = new Set([
  "image-alt",
  "role-img-alt",
  "input-image-alt",
  "svg-img-alt",
  "area-alt",
]);

const claimPatterns: RegExp[] = [
  /\d+(?:[.,]\d+)?\s?%/g,
  // "3x faster", not the product "15 × 2 × 2".
  /\d+(?:\.\d+)?\s?[x×](?![\p{L}\p{N}])(?!\s*\d)/gu,
  /[$€£]\s?\d[\d,.]*(?:\s?(?:k|m|bn|million|billion)\b)?/gi,
  /\d[\d,.]*\s?(?:k|m|million|billion)\b\+?/gi,
  /\d[\d,]*\+/g,
  /\d(?:\.\d)?\s?(?:\/|out of)\s?5\b/gi,
  /\d[\d,]*\+?\s+(?:customers|users|teams|companies|businesses|reviews|countries|people|downloads|members)\b/gi,
];

const populationNoun =
  /(?:customers|users|teams|companies|businesses|reviews|countries|people|downloads|members)$/;

/** Words that spell a unit, rewritten before tokens are extracted. */
function spellUnits(text: string): string {
  return text.replace(/(\d)\s?percent\b/gi, "$1%").replaceAll("×", "x");
}

/** Lowercase, no spaces or thousands separators, short magnitude units. */
export function normalizeClaim(token: string): string {
  return spellUnits(token)
    .toLowerCase()
    .replace(/(\d),(?=\d{3}\b)/g, "$1")
    .replace(/\s+/g, "")
    .replace(/million/g, "m")
    .replace(/billion/g, "bn")
    .replace(/[.,]+$/, "");
}

/** A token without its population noun: "12000+teams" → "12000+". */
function claimCore(normalized: string): string {
  return normalized.replace(populationNoun, "");
}

/** Statistic-like tokens in text, longest match first where they overlap. */
export function claimTokens(text: string): string[] {
  const source = spellUnits(text);
  const spans = claimPatterns
    .flatMap((pattern) =>
      [...source.matchAll(pattern)].map((match) => ({
        start: match.index,
        end: match.index + match[0].length,
        text: match[0],
      })),
    )
    .filter(
      (span) =>
        // A digit run that starts mid-number or mid-word is not a claim.
        !/[\p{L}\p{N}.,]/u.test(source[span.start - 1] ?? ""),
    )
    .sort((a, b) => b.end - b.start - (a.end - a.start) || a.start - b.start);
  const kept: typeof spans = [];
  for (const span of spans)
    if (!kept.some((other) => span.start < other.end && other.start < span.end))
      kept.push(span);
  return kept
    .sort((a, b) => a.start - b.start)
    .map((span) => span.text.trim().replace(/[.,]+$/, ""));
}

const isYear = (core: string) => /^(?:19|20)\d{2}\+?$/.test(core);

/**
 * Text more than two levels inside a button or link is an embedded
 * illustration (a clickable product mockup), not the control's label.
 */
function insideControlIllustration(path: string): boolean {
  const segments = path.split("/");
  const depth = [...segments]
    .reverse()
    .findIndex((segment) => /^(?:a|button)\[\d+\]$/.test(segment));
  return depth > 2;
}

/** Normalized tokens and cores a brief (or claimsAllow) supports. */
function supportedClaims(texts: string[]): Set<string> {
  const supported = new Set<string>();
  for (const text of texts) {
    supported.add(normalizeClaim(text));
    for (const token of claimTokens(text)) {
      const normalized = normalizeClaim(token);
      supported.add(normalized);
      supported.add(claimCore(normalized));
    }
  }
  return supported;
}

const ctaTags = new Set(["a", "button"]);

function roleOf(element: ObservedElementV2): string {
  return element.signals?.role ?? element.attributes.role ?? "";
}

function looksLikeButton(element: ObservedElementV2): boolean {
  if (element.tag === "button" || roleOf(element) === "button") return true;
  if (element.tag === "input") return true;
  if (isBounded(element)) return true;
  return (
    element.inlineTextTarget !== true &&
    Math.min(px(element.styles.paddingLeft), px(element.styles.paddingRight)) >=
      8
  );
}

function isCtaCandidate(element: ObservedElementV2): boolean {
  if (!element.visible || !element.enabled || !element.interactive)
    return false;
  const role = roleOf(element);
  const kind =
    ctaTags.has(element.tag) ||
    (element.tag === "input" &&
      ["submit", "button"].includes(element.attributes.type ?? "")) ||
    role === "button" ||
    role === "link";
  if (!kind) return false;
  return (element.signals?.name ?? element.text).trim() !== "";
}

/**
 * Page review content rules: placeholder copy, a call to action in the hero
 * and the final section, image alternative text, and (with a brief) numeric
 * claims the brief does not state. Off unless page review is enabled.
 */
export const pageContentCheck: DeterministicCheck = {
  id: "page-content",
  run({ tuple, config }) {
    const page = config.page;
    if (page === undefined)
      return {
        coverage: {
          check: this.id,
          status: "skipped",
          reason:
            "page review not enabled (idiom review --page or checks.page)",
        },
        candidates: [],
      };
    const observation = tuple.observations;
    if (observation === undefined)
      return unavailable(this.id, "observations.json is unavailable");
    if (observation.version !== 2)
      return unavailable(
        this.id,
        "observations predate selector marks (recapture)",
      );
    const notes: string[] = [];
    const ctaMatches = configuredCtas(observation, page);
    if ("unavailable" in ctaMatches)
      return unavailable(this.id, ctaMatches.unavailable);
    notes.push(...ctaMatches.notes);

    const candidates: FindingCandidate[] = [];
    const sections = pageSections(observation, tuple.height);
    const footers = sections.filter((section) => section.role === "footer");
    const inFooter = (element: ObservedElementV2) =>
      element.tag === "footer" ||
      pathHas(element.structuralPath, "footer") ||
      footers.some(
        (footer) =>
          element.structuralPath === footer.structuralPath ||
          within(element.structuralPath, footer.structuralPath),
      );
    const copy = observation.elements.filter(
      (element) =>
        element.visible &&
        !isVisuallyHidden(element) &&
        !codeTags.has(element.tag) &&
        !/(?:^|\/)(?:pre|code|kbd|samp|textarea)\[/.test(
          element.structuralPath,
        ) &&
        element.directText.trim() !== "",
    );

    const configuredPlaceholders = page.placeholderPatterns.map(
      (pattern) => new RegExp(pattern, "i"),
    );
    for (const element of copy) {
      const text = element.directText.replace(/\s+/g, " ").trim();
      const matched = placeholderTexts.has(text.toLowerCase())
        ? text
        : [...placeholderPatterns, ...configuredPlaceholders]
            .map((pattern) => pattern.exec(text)?.[0])
            .find((value) => value !== undefined && value !== "");
      if (matched === undefined) continue;
      candidates.push({
        category: this.id,
        severity: "major",
        rule: "idiom:placeholder-text",
        selectorHint: element.selector,
        fingerprintHint: matched,
        explanation: `${element.selector} shows placeholder text "${matched}" instead of real copy.`,
        acceptance: [
          `${element.selector} shows final copy, not placeholder text.`,
        ],
        verification: verify(this.id, { selector: element.selector, matched }),
      });
    }

    const content = sections.filter((section) => section.role !== "footer");
    if (content.length < 2)
      notes.push(
        `CTA rules not evaluated: ${content.length === 0 ? "no content sections found" : "only one content section found"} (use section, article or main children)`,
      );
    else {
      const navs = new Set(
        observation.elements
          .filter(
            (element) =>
              element.tag === "nav" || element.attributes.role === "navigation",
          )
          .map((element) => element.selector),
      );
      // A nav inside a hero is an action group ("Start here"); only the
      // site navigation of a header-as-hero is not a call to action.
      const siteNavigation = (
        element: ObservedElementV2,
        section: PageSection,
      ) =>
        /(?:^|\/)header\[\d+\]$/.test(section.structuralPath) &&
        (pathHas(
          element.structuralPath.slice(section.structuralPath.length),
          "nav",
        ) ||
          element.ancestorSelectors.some((selector) => navs.has(selector)));
      const ctaIn = (section: PageSection) =>
        observation.elements.filter(
          (element) =>
            within(element.structuralPath, section.structuralPath) &&
            element.visible &&
            element.enabled &&
            (ctaMatches.selectors === undefined
              ? isCtaCandidate(element) &&
                !siteNavigation(element, section) &&
                looksLikeButton(element)
              : ctaMatches.selectors.has(element.selector)),
        );
      for (const [role, rule, label] of [
        ["hero", "idiom:missing-hero-cta", "hero"],
        ["final", "idiom:missing-final-cta", "final section"],
      ] as const) {
        const section = sections.find((entry) => entry.role === role);
        if (section === undefined) {
          notes.push(`no ${label} section identified`);
          continue;
        }
        if (ctaIn(section).length > 0) continue;
        const named =
          section.heading === undefined ? "" : ` ("${section.heading}")`;
        candidates.push({
          category: this.id,
          severity: "major",
          rule,
          selectorHint: section.selector,
          explanation: `The ${label} ${section.selector}${named} has no call to action: no visible button or button-styled link.`,
          acceptance: [
            `The ${label} offers one clear call to action styled as a button.`,
          ],
          verification: verify(this.id, {
            selector: section.selector,
            section: section.id,
          }),
        });
      }
    }

    if (tuple.axe === undefined)
      notes.push("axe.json is unavailable; alt text not checked");
    for (const violation of axeViolations(tuple.axe).filter((entry) =>
      altRules.has(entry.id),
    ))
      for (const node of violation.nodes) {
        const selector = axeSelector(node);
        candidates.push({
          category: this.id,
          severity: axeSeverity(violation.impact),
          rule: `axe:${violation.id}`,
          selectorHint: selector,
          explanation: `${selector} has no text alternative according to axe rule ${violation.id}.`,
          acceptance: [
            `${selector} has alt text that says what the image shows, or is marked decorative.`,
          ],
          verification: verify(this.id, { selector, axeRule: violation.id }),
          axeNodes: [node],
          ...(typeof node.html === "string" ? { domSnippet: node.html } : {}),
        });
      }

    if (page.brief === undefined) notes.push("no brief; claims not checked");
    else {
      const supported = supportedClaims([page.brief.text, ...page.claimsAllow]);
      const seen = new Set<string>();
      for (const element of copy) {
        if (
          inFooter(element) ||
          insideControlIllustration(element.structuralPath)
        )
          continue;
        for (const claim of claimTokens(element.directText)) {
          const normalized = normalizeClaim(claim);
          const core = claimCore(normalized);
          if (
            isYear(core) ||
            seen.has(normalized) ||
            supported.has(normalized) ||
            supported.has(core)
          )
            continue;
          seen.add(normalized);
          candidates.push({
            category: this.id,
            severity: "major",
            rule: "idiom:unsupported-claim",
            selectorHint: element.selector,
            fingerprintHint: normalized,
            explanation: `${element.selector} claims "${claim}", but the brief contains no such figure.`,
            acceptance: [
              `Every statistic on the page appears in the brief; "${claim}" is removed or added to the brief.`,
            ],
            verification: verify(this.id, { claim }),
          });
        }
      }
    }

    return {
      coverage: {
        check: this.id,
        status: "ran",
        ...(notes.length === 0 ? {} : { reason: notes.join("; ") }),
      },
      candidates,
    };
  },
};

/**
 * Selectors from checks.page.ctaSelectors resolved at capture. Undefined
 * selectors means the heuristic applies.
 */
function configuredCtas(
  observation: ObservationArtifactV2,
  page: NonNullable<ChecksConfig["page"]>,
):
  | { selectors?: Set<string> | undefined; notes: string[] }
  | { unavailable: string } {
  if (page.ctaSelectors.length === 0) return { notes: [] };
  const selectors = new Set<string>();
  const notes: string[] = [];
  for (const selector of page.ctaSelectors) {
    const mark = (observation.selectorMarks ?? []).find(
      (entry) => entry.purpose === "cta" && entry.selector === selector,
    );
    if (mark === undefined)
      return {
        unavailable: `${selector} was not resolved at capture (recapture after adding checks.page.ctaSelectors)`,
      };
    if (mark.invalid === true)
      notes.push(`${selector} is not a valid selector`);
    for (const match of mark.matches) selectors.add(match);
  }
  return { selectors, notes };
}

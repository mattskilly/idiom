import type { Page } from "playwright";
import type { Measurement } from "./comparables.js";

/**
 * Measures a comparable's public page for `idiom brief research`: the first
 * visible element each request word names (by class, id, role, aria-label or
 * data-testid), its size, radius, type size, item gap and motion duration,
 * and the edge-to-edge gap between every pair of named elements. Read-only:
 * nothing is clicked, typed or submitted.
 */

export type Box = { x: number; y: number; width: number; height: number };

export type MeasuredSubject = {
  /** The request words that named it, in request order: "selection toolbar". */
  name: string;
  selector: string;
  box: Box;
  radius?: number | undefined;
  fontSize?: number | undefined;
  itemGap?: number | undefined;
  duration?: number | undefined;
};

export type PageMeasurement = {
  subjects: MeasuredSubject[];
  measurements: Measurement[];
  /** Request words no visible element on the page carried. */
  unmatched: string[];
};

/** Half-pixel precision, as layout reports it. */
export function half(value: number): number {
  return Math.round(value * 2) / 2;
}

/**
 * The shortest edge-to-edge distance between two boxes; when they overlap,
 * the smallest inset of the contained box (0 when neither contains the other).
 */
export function edgeGap(a: Box, b: Box): number {
  const dx = Math.max(0, b.x - (a.x + a.width), a.x - (b.x + b.width));
  const dy = Math.max(0, b.y - (a.y + a.height), a.y - (b.y + b.height));
  if (dx > 0 || dy > 0) return half(Math.hypot(dx, dy));
  const contains = (outer: Box, inner: Box) =>
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.width <= outer.x + outer.width &&
    inner.y + inner.height <= outer.y + outer.height;
  const inset = (outer: Box, inner: Box) =>
    Math.min(
      inner.x - outer.x,
      inner.y - outer.y,
      outer.x + outer.width - (inner.x + inner.width),
      outer.y + outer.height - (inner.y + inner.height),
    );
  if (contains(a, b)) return half(inset(a, b));
  if (contains(b, a)) return half(inset(b, a));
  return 0;
}

/** Turns measured subjects into per-property and pairwise measurements. */
export function subjectMeasurements(
  subjects: MeasuredSubject[],
  where: { url: string; viewport: string },
): Measurement[] {
  const measurements: Measurement[] = [];
  const add = (
    subject: string,
    property: Measurement["property"],
    value: number | undefined,
    selector: string,
    unit: "px" | "ms" = "px",
  ) => {
    if (value === undefined || !Number.isFinite(value) || value <= 0) return;
    measurements.push({
      subject,
      property,
      value: unit === "px" ? half(value) : Math.round(value),
      unit,
      selector,
      ...where,
    });
  };
  for (const [index, left] of subjects.entries())
    for (const right of subjects.slice(index + 1)) {
      // The smaller element is the one placed against the larger.
      const [first, second] =
        right.box.width * right.box.height < left.box.width * left.box.height
          ? [right, left]
          : [left, right];
      measurements.push({
        subject: `${first.name} to ${second.name}`,
        property: "gap",
        value: edgeGap(first.box, second.box),
        unit: "px",
        selector: `${first.selector} → ${second.selector}`,
        ...where,
      });
    }
  for (const subject of subjects) {
    add(subject.name, "width", subject.box.width, subject.selector);
    add(subject.name, "height", subject.box.height, subject.selector);
    add(subject.name, "radius", subject.radius, subject.selector);
    add(subject.name, "font size", subject.fontSize, subject.selector);
    add(subject.name, "item gap", subject.itemGap, subject.selector);
    add(subject.name, "duration", subject.duration, subject.selector, "ms");
  }
  return measurements;
}

type InPageResult = { subjects: MeasuredSubject[]; unmatched: string[] };

/** Runs in the page: self-contained, returns plain JSON. */
function measureInPage(terms: string[]): InPageResult {
  const singular = (word: string): string => {
    if (word.length > 4 && word.endsWith("ies")) return `${word.slice(0, -3)}y`;
    if (word.length > 4 && /(?:ches|shes|sses|xes)$/.test(word))
      return word.slice(0, -2);
    if (word.length > 3 && word.endsWith("s") && !word.endsWith("ss"))
      return word.slice(0, -1);
    return word;
  };
  const skipped = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "META"]);
  const tokensOf = (element: Element): Set<string> => {
    const text = [
      element.id,
      element.getAttribute("class") ?? "",
      element.getAttribute("role") ?? "",
      element.getAttribute("aria-label") ?? "",
      element.getAttribute("data-testid") ?? "",
    ]
      .join(" ")
      .toLowerCase();
    return new Set((text.match(/[a-z0-9]+/g) ?? []).map(singular));
  };
  const visible = (element: Element): boolean => {
    const rect = element.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return false;
    const style = getComputedStyle(element);
    return (
      style.display !== "none" &&
      style.visibility !== "hidden" &&
      style.visibility !== "collapse" &&
      style.opacity !== "0"
    );
  };
  const candidates: { element: Element; matches: string[] }[] = [];
  for (const element of Array.from(
    document.body?.querySelectorAll("*") ?? [],
  )) {
    if (skipped.has(element.tagName)) continue;
    const words = tokensOf(element);
    const matches = terms.filter((term) => words.has(term));
    if (matches.length > 0 && visible(element))
      candidates.push({ element, matches });
  }
  const chosen = new Map<Element, string[]>();
  const unmatched: string[] = [];
  for (const term of terms) {
    let best: { element: Element; matches: string[] } | undefined;
    for (const candidate of candidates)
      if (
        candidate.matches.includes(term) &&
        (best === undefined || candidate.matches.length > best.matches.length)
      )
        best = candidate;
    if (best === undefined) {
      unmatched.push(term);
      continue;
    }
    chosen.set(best.element, [...(chosen.get(best.element) ?? []), term]);
  }
  const unique = (selector: string) =>
    document.querySelectorAll(selector).length === 1;
  const ownSelector = (element: Element): string => {
    if (element.id !== "") return `#${CSS.escape(element.id)}`;
    const classes = Array.from(element.classList)
      .slice(0, 2)
      .map((name) => `.${CSS.escape(name)}`)
      .join("");
    let selector = `${element.tagName.toLowerCase()}${classes}`;
    const role = element.getAttribute("role");
    if (classes === "" && role !== null)
      selector += `[role="${CSS.escape(role)}"]`;
    return selector;
  };
  const selectorFor = (element: Element): string => {
    let selector = ownSelector(element);
    if (selector.startsWith("#") || unique(selector)) return selector;
    const parent = element.parentElement;
    if (parent !== null) {
      const index =
        Array.from(parent.children)
          .filter((child) => child.tagName === element.tagName)
          .indexOf(element) + 1;
      selector += `:nth-of-type(${index})`;
      if (unique(selector)) return selector;
      let ancestor: Element | null = parent;
      for (let depth = 0; ancestor !== null && depth < 4; depth++) {
        const scoped = `${ownSelector(ancestor)} > ${selector}`;
        if (unique(scoped)) return scoped;
        selector = scoped;
        ancestor = ancestor.parentElement;
      }
    }
    return selector;
  };
  const px = (value: string): number | undefined => {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
  };
  const longest = (list: string): number | undefined => {
    const values = list
      .split(",")
      .map((entry) => entry.trim())
      .map((entry) =>
        entry.endsWith("ms")
          ? Number.parseFloat(entry)
          : Number.parseFloat(entry) * 1000,
      )
      .filter((value) => Number.isFinite(value) && value > 0);
    return values.length === 0 ? undefined : Math.max(...values);
  };
  const subjects: MeasuredSubject[] = [];
  for (const [element, words] of chosen) {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    const gaps = [px(style.columnGap), px(style.rowGap)].filter(
      (value): value is number => value !== undefined,
    );
    const durations = [
      longest(style.transitionDuration),
      longest(style.animationDuration),
    ].filter((value): value is number => value !== undefined);
    subjects.push({
      name: words.join(" "),
      selector: selectorFor(element),
      box: {
        x: rect.x + window.scrollX,
        y: rect.y + window.scrollY,
        width: rect.width,
        height: rect.height,
      },
      radius: px(style.borderTopLeftRadius),
      fontSize: px(style.fontSize),
      itemGap: gaps.length === 0 ? undefined : Math.max(...gaps),
      duration: durations.length === 0 ? undefined : Math.max(...durations),
    });
  }
  // Request order: the subject holding the earliest word first.
  subjects.sort(
    (left, right) =>
      terms.indexOf(left.name.split(" ")[0] ?? "") -
      terms.indexOf(right.name.split(" ")[0] ?? ""),
  );
  return { subjects, unmatched };
}

export async function measureComparablePage(
  page: Page,
  terms: string[],
  where: { url: string; viewport: string },
): Promise<PageMeasurement> {
  const result = await page.evaluate(measureInPage, terms);
  return {
    subjects: result.subjects,
    unmatched: result.unmatched,
    measurements: subjectMeasurements(result.subjects, where),
  };
}

/** A page that asks for a sign-in; it is reported, never logged into. */
export class SignInWallError extends Error {
  constructor(message = "sign-in required; not logged into") {
    super(message);
    this.name = "SignInWallError";
  }
}

const SIGN_IN_URL =
  /(^|[/.-])(log-?in|sign-?in|signin|auth|sso|oauth|session)([/.?-]|$)/i;

/** True when a URL's host or path names a sign-in screen. */
export function isSignInUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      SIGN_IN_URL.test(parsed.hostname) ||
      parsed.pathname.split("/").some((part) => SIGN_IN_URL.test(part))
    );
  } catch {
    return false;
  }
}

function sameUrl(left: string, right: string): boolean {
  try {
    const a = new URL(left);
    const b = new URL(right);
    return a.origin === b.origin && a.pathname === b.pathname;
  } catch {
    return left === right;
  }
}

/**
 * Throws SignInWallError when the listed page redirected to a sign-in URL or
 * shows a visible password field.
 */
export async function detectSignIn(
  page: Page,
  requestedUrl: string,
): Promise<void> {
  const finalUrl = page.url();
  if (!sameUrl(finalUrl, requestedUrl) && isSignInUrl(finalUrl))
    throw new SignInWallError(
      `sign-in required (redirected to ${finalUrl}); not logged into`,
    );
  const password = await page.evaluate(() =>
    Array.from(document.querySelectorAll('input[type="password"]')).some(
      (input) => {
        const rect = input.getBoundingClientRect();
        const style = getComputedStyle(input);
        return (
          rect.width > 0 &&
          rect.height > 0 &&
          style.display !== "none" &&
          style.visibility !== "hidden"
        );
      },
    ),
  );
  if (password)
    throw new SignInWallError(
      "sign-in required (password field); not logged into",
    );
}

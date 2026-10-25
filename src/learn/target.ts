import { type Browser, chromium } from "playwright";
import { IdiomError } from "../errors.js";
import { subjectTokens } from "./interpret.js";

export type BrowserLaunch = () => Promise<Browser>;

type Candidate = {
  /** A selector for this match: `.class` or a unique element selector. */
  selector: string;
  count: number;
  /** Class tokens beyond the subject's, for class matches. */
  extra: number;
  via: "class" | "name";
  sample: string;
};

/**
 * Resolve a human's subject phrase ("override dots") to a selector by reading
 * the captured DOM: first a class whose words cover the subject's (fewest
 * extra words, then most elements), else a single element whose accessible
 * name, title or short text names it. Ambiguity is an error naming the
 * candidates; the human passes --selector instead of the tool guessing.
 */
export async function resolveSubject(options: {
  html: string;
  subject: string;
  launch?: BrowserLaunch | undefined;
}): Promise<{ selector: string; count: number }> {
  const tokens = subjectTokens(options.subject);
  if (tokens.length === 0)
    throw new IdiomError(
      `cannot resolve ${JSON.stringify(options.subject)} to an element; pass --selector`,
    );
  const browser = await (
    options.launch ?? (() => chromium.launch({ headless: true }))
  )();
  let candidates: Candidate[];
  try {
    const context = await browser.newContext({ javaScriptEnabled: false });
    const page = await context.newPage();
    await page.setContent(options.html, { waitUntil: "domcontentloaded" });
    candidates = await page.evaluate((tokens: string[]): Candidate[] => {
      const generated = (value: string) =>
        /__[A-Za-z0-9_-]{5,}$/.test(value) ||
        /^(?:css|jsx|sc|emotion|styled)[-_][A-Za-z0-9_-]{5,}$/i.test(value) ||
        /^[a-f0-9]{8,}$/i.test(value);
      const singular = (word: string) =>
        /ies$/.test(word) && word.length > 3
          ? `${word.slice(0, -3)}y`
          : /sses$/.test(word)
            ? word.slice(0, -2)
            : /[^siu]s$/.test(word)
              ? word.slice(0, -1)
              : word;
      const words = (value: string) =>
        value
          .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
          .toLowerCase()
          .split(/[^a-z0-9]+/)
          .filter((word) => word !== "")
          .map(singular);
      const covers = (value: string) => {
        const have = new Set(words(value));
        return tokens.every((token) => have.has(token));
      };
      const elements = [...document.body.querySelectorAll("*")];
      const classes = new Map<string, number>();
      for (const element of elements)
        for (const name of element.classList)
          if (!generated(name) && covers(name))
            classes.set(name, (classes.get(name) ?? 0) + 1);
      const byClass = [...classes].map(([name, count]) => ({
        selector: `.${CSS.escape(name)}`,
        count,
        extra: words(name).length - tokens.length,
        via: "class" as const,
        sample: name,
      }));
      if (byClass.length > 0) return byClass;
      const unique = (element: Element): string | undefined => {
        const tag = element.tagName.toLowerCase();
        const options = [
          element.id === "" ? undefined : `#${CSS.escape(element.id)}`,
          ...["aria-label", "title", "alt", "data-testid", "name"].map(
            (attribute) => {
              const value = element.getAttribute(attribute);
              return value === null
                ? undefined
                : `${tag}[${attribute}=${JSON.stringify(value)}]`;
            },
          ),
        ];
        return options.find(
          (selector) =>
            selector !== undefined &&
            document.querySelectorAll(selector).length === 1,
        );
      };
      return elements.flatMap((element) => {
        const own = [...element.childNodes]
          .filter((node) => node.nodeType === Node.TEXT_NODE)
          .map((node) => node.textContent ?? "")
          .join(" ")
          .trim();
        const names = [
          element.getAttribute("aria-label"),
          element.getAttribute("title"),
          element.getAttribute("alt"),
          own.length <= 60 ? own : null,
        ].filter((value): value is string => value !== null && value !== "");
        const named = names.find(covers);
        if (named === undefined) return [];
        return [
          {
            selector: unique(element) ?? element.tagName.toLowerCase(),
            count: 1,
            extra: 0,
            via: "name" as const,
            sample: named,
          },
        ];
      });
    }, tokens);
    await context.close();
  } finally {
    await browser.close();
  }
  const describe = (list: Candidate[]) =>
    list
      .slice(0, 5)
      .map((candidate) => `${candidate.selector} (${candidate.count})`)
      .join(", ");
  const byClass = candidates
    .filter((candidate) => candidate.via === "class")
    .sort(
      (left, right) =>
        left.extra - right.extra ||
        right.count - left.count ||
        left.selector.localeCompare(right.selector),
    );
  const best = byClass[0];
  if (best !== undefined) {
    const tied = byClass.filter(
      (candidate) =>
        candidate.extra === best.extra && candidate.count === best.count,
    );
    if (tied.length > 1)
      throw new IdiomError(
        `${JSON.stringify(options.subject)} matches several classes: ${describe(tied)}; pass --selector`,
      );
    return { selector: best.selector, count: best.count };
  }
  const byName = candidates.filter((candidate) => candidate.via === "name");
  const [only, ...rest] = byName;
  if (only === undefined)
    throw new IdiomError(
      `nothing in the captured DOM matches ${JSON.stringify(options.subject)}; pass --selector`,
    );
  if (rest.length > 0)
    throw new IdiomError(
      `${JSON.stringify(options.subject)} matches several elements: ${describe(byName)}; pass --selector`,
    );
  if (!/[#[]/.test(only.selector))
    throw new IdiomError(
      `${JSON.stringify(options.subject)} matches an element with no unique selector; pass --selector`,
    );
  return { selector: only.selector, count: 1 };
}

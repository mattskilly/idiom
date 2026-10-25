import type { Page } from "playwright";
import type { LivenessArtifact } from "./dynamic-schema.js";
import type { ChecksConfig } from "./types.js";

/** All targets share one window; original node references detect replacement. */
export async function sampleLiveness(
  page: Page,
  declaration: NonNullable<ChecksConfig["liveness"]>,
): Promise<LivenessArtifact> {
  try {
    return await page.evaluate(async (declaration) => {
      const diagnostics: string[] = [];
      const entries: LivenessArtifact["entries"] = [];
      const path = (el: Element): string => {
        const parts: string[] = [];
        for (let node: Element | null = el; node; node = node.parentElement) {
          const tag = node.tagName.toLowerCase();
          const tagName = node.tagName;
          const siblings = node.parentElement
            ? [...node.parentElement.children].filter(
                (n) => n.tagName === tagName,
              )
            : [node];
          parts.unshift(`${tag}:nth-of-type(${siblings.indexOf(node) + 1})`);
        }
        return parts.join(" > ");
      };
      const painted = (el: Element) => {
        if (
          el.closest(
            'script,style,template,noscript,[hidden],[inert],[aria-hidden="true"]',
          )
        )
          return false;
        const r = el.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) return false;
        if (getComputedStyle(el).visibility !== "visible") return false;
        for (let n: Element | null = el; n; n = n.parentElement)
          if (
            getComputedStyle(n).display === "none" ||
            Number(getComputedStyle(n).opacity) === 0
          )
            return false;
        return true;
      };
      const text = (el: Element) =>
        (el as HTMLElement).innerText?.replace(/\s+/g, " ").trim() ?? "";
      const query = (selector: string, kind: string): Element[] => {
        try {
          return [...document.querySelectorAll(selector)];
        } catch {
          diagnostics.push(`${kind} ${selector}: invalid CSS selector`);
          return [];
        }
      };
      const ignored = declaration.ignore.flatMap((s) => query(s, "ignore"));
      // Invalid ignores make inclusion uncertain: preserve a diagnostic without judging targets.
      if (diagnostics.length)
        return {
          version: 1,
          status: "unavailable",
          declaration,
          diagnostics,
          entries,
        } as LivenessArtifact;
      const ignore = (el: Element) =>
        ignored.some((n) => n === el || n.contains(el));
      const targets = new Map<
        Element,
        { source: "declared" | "automatic"; declaration?: string }
      >();
      for (const selector of declaration.selectors) {
        const matches = query(selector, "declared");
        if (
          !matches.length &&
          !diagnostics.some((d) => d.startsWith(`declared ${selector}:`))
        )
          diagnostics.push(`declared ${selector}: no matches`);
        for (const el of matches)
          if (!ignore(el) && !targets.has(el))
            targets.set(el, { source: "declared", declaration: selector });
      }
      if (declaration.auto) {
        const numeric = (el: Element) =>
          /^\d+(?:\s*:\s*\d+){2,}$/.test(text(el));
        const semantic = [
          ...document.querySelectorAll('[role="timer"]'),
        ].filter((el) => painted(el) && !ignore(el));
        const automatic = [...document.querySelectorAll("body *")].filter(
          (el) => painted(el) && !ignore(el) && numeric(el),
        );
        for (const el of [
          ...semantic,
          ...automatic.filter(
            (el) =>
              !semantic.some(
                (n) => n === el || n.contains(el) || el.contains(n),
              ) && !automatic.some((n) => n !== el && el.contains(n)),
          ),
        ]) {
          if (
            [...targets.keys()].some(
              (n) => n === el || n.contains(el) || el.contains(n),
            )
          )
            continue;
          targets.set(el, { source: "automatic" });
        }
      }
      const started = performance.now();
      const pending = [...targets].map(([el, meta]) => ({
        el,
        ...meta,
        selector: el.id ? `#${CSS.escape(el.id)}` : path(el),
        identity: path(el),
        before: painted(el) ? text(el) : "",
      }));
      if (pending.length)
        await new Promise((resolve) => setTimeout(resolve, 1500));
      const elapsedMs = performance.now() - started;
      for (const { el, before, ...meta } of pending) {
        const reason = !el.isConnected
          ? "target detached or replaced"
          : !painted(el)
            ? "target hidden or unmeasurable"
            : !before
              ? "first sample empty or hidden"
              : !text(el)
                ? "second sample empty"
                : undefined;
        if (reason) entries.push({ ...meta, status: "unavailable", reason });
        else
          entries.push({
            ...meta,
            status: "measured",
            before,
            after: text(el),
            elapsedMs,
          });
      }
      for (const entry of entries)
        if (entry.status === "unavailable")
          diagnostics.push(`${entry.selector}: ${entry.reason}`);
      return {
        version: 1,
        status: diagnostics.length ? "partial" : "ran",
        declaration,
        diagnostics,
        entries,
      } as LivenessArtifact;
    }, declaration);
  } catch (error) {
    return {
      version: 1,
      status: "unavailable",
      declaration,
      diagnostics: [
        `liveness sampling unavailable: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`,
      ],
      entries: [],
    };
  }
}

import type { Page } from "playwright";
import type { LoadingStuckEvidence } from "../checks/blank-schema.js";
import { installSurfaceDom } from "../checks/surface-dom.js";

type LoadingWindow = {
  read(stop: boolean): LoadingStuckEvidence;
  dispose(): void;
};
declare global {
  interface Window {
    __idiomLoadingStuck?: LoadingWindow;
  }
}

/** Starts at successful reach, before visual settling. All intervals use performance.now(). */
export async function startLoadingObservation(
  page: Page,
  windowMs: number,
  masks: string[],
): Promise<void> {
  await page.evaluate(installSurfaceDom);
  await page.evaluate(
    ({ windowMs, masks }) => {
      window.__idiomLoadingStuck?.dispose();
      const h = window.__idiomSurface,
        start = performance.now();
      const records: LoadingStuckEvidence["records"] = [];
      const targets = new Map<
        LoadingStuckEvidence["records"][number],
        Element
      >();
      const active = new Map<
        Element,
        { record: LoadingStuckEvidence["records"][number]; since: number }
      >();
      let identity = 0;
      const nodeIds = new WeakMap<Element, number>();
      const kind = (
        el: Element,
      ): LoadingStuckEvidence["records"][number]["kind"] | undefined => {
        if (el.getAttribute("aria-busy") === "true") return "busy";
        if (el.getAttribute("role") === "progressbar")
          return el.getAttribute("aria-valuenow")?.trim()
            ? undefined
            : "progress";
        if (el instanceof HTMLProgressElement)
          return el.hasAttribute("value") ? undefined : "progress";
        const token = `${el.getAttribute("class") ?? ""} ${[...el.attributes]
          .filter(
            (a) =>
              a.name.startsWith("data-") &&
              !["false", "off", "0"].includes(a.value),
          )
          .map((a) => `${a.name} ${a.value}`)
          .join(" ")}`;
        // Libraries keep skeleton classes on wrappers after content loads;
        // only an empty surface (or one holding just a loading label) is
        // still a skeleton.
        const text = (el.textContent ?? "").trim();
        if (
          /(?:^|[\s_-])(?:skeleton|shimmer)(?:$|[\s_-])/i.test(token) &&
          (!text ||
            /^(?:loading|please wait|fetching)(?:\.{3}|…)?$/i.test(text)) &&
          !el.querySelector("img,picture,video,canvas,iframe,input,button,svg")
        )
          return "skeleton";
        const label = `${el.getAttribute("aria-label") ?? ""} ${(
          el.getAttribute("aria-labelledby") ?? ""
        )
          .split(/\s+/)
          .map((id) => document.getElementById(id)?.textContent ?? "")
          .join(" ")} ${el.getAttribute("title") ?? ""}`;
        if (
          /(?:^|[\s_-])(?:spinner|loading-indicator)(?:$|[\s_-])/i.test(
            token,
          ) ||
          (/\b(?:loading|please wait|fetching)\b/i.test(label) &&
            (el.getAttribute("role") === "status" ||
              /^(?:loading|please wait|fetching)(?:\.{3}|…)?$/i.test(
                label.trim(),
              )))
        )
          return "spinner";
        return;
      };
      const scan = () => {
        const now = performance.now();
        const found = new Map<Element, NonNullable<ReturnType<typeof kind>>>();
        for (const el of document.querySelectorAll(
          '[aria-busy="true"],[role="progressbar"],progress,[class],[data-skeleton],[data-loading],[data-spinner],[data-shimmer],[aria-label],[aria-labelledby],[title]',
        )) {
          const k = kind(el);
          // Most classed elements carry no loading semantics. Avoid forcing
          // layout for every element on each bounded visibility sample.
          if (k && h.visible(el) && h.opacity(el) > 0.01) found.set(el, k);
        }
        // A busy/skeleton wrapper and its spinner are one surface; siblings remain independent.
        for (const el of found.keys()) {
          for (
            let parent = el.parentElement;
            parent;
            parent = parent.parentElement
          )
            if (found.has(parent)) {
              found.delete(el);
              break;
            }
        }
        for (const [el, entry] of active) {
          if (found.get(el) !== entry.record.kind) {
            entry.record.ageMs = Math.max(0, now - entry.since);
            entry.record.active = false;
            entry.record.endedMs = now - start;
            active.delete(el);
          }
        }
        for (const [el, k] of found) {
          let entry = active.get(el);
          if (!entry) {
            const record = {
              selector: h.selector(el),
              identity: nodeIds.get(el) ?? identity++,
              kind: k,
              ageMs: 0,
              active: true,
              masked: h.matches(el, masks),
            };
            nodeIds.set(el, record.identity);
            records.push(record);
            targets.set(record, el);
            entry = { record, since: performance.now() };
            active.set(el, entry);
          }
          entry.record.ageMs = Math.max(0, now - entry.since);
          const r = h.visible(el);
          entry.record.masked =
            h.matches(el, masks) ||
            (r !== undefined &&
              masks.some((s) => {
                try {
                  return [...document.querySelectorAll(s)].some((m) => {
                    const overlap = h.intersect(h.box(m), r);
                    return overlap.width > 0 && overlap.height > 0;
                  });
                } catch {
                  return false;
                }
              }));
        }
      };
      scan();
      const observer = new MutationObserver((mutations) => {
        // A remove/reinsert inside one task still terminates the observed interval.
        const now = performance.now();
        for (const mutation of mutations)
          for (const removed of mutation.removedNodes)
            for (const [el, entry] of active) {
              if (removed === el || removed.contains(el)) {
                entry.record.ageMs = now - entry.since;
                entry.record.active = false;
                entry.record.endedMs = now - start;
                active.delete(el);
              }
            }
        // An attribute toggled twice before delivery must not join separate intervals.
        for (const mutation of mutations)
          if (
            mutation.type === "attributes" &&
            active.has(mutation.target as Element)
          ) {
            const el = mutation.target as Element;
            const changed = mutation.attributeName;
            const old = mutation.oldValue;
            if (
              (changed === "aria-busy" && old !== "true") ||
              (changed === "aria-valuenow" && old !== null) ||
              (changed === "value" && old !== null) ||
              (changed === "hidden" && old !== null) ||
              (changed === "style" &&
                /display:\s*none|visibility:\s*hidden|opacity:\s*0(?:[;\s]|$)/i.test(
                  old ?? "",
                ))
            ) {
              const entry = active.get(el);
              if (entry) {
                entry.record.ageMs = now - entry.since;
                entry.record.active = false;
                entry.record.endedMs = now - start;
                active.delete(el);
              }
            }
          }
        scan();
      });
      observer.observe(document.documentElement, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeOldValue: true,
      });
      const timer = setInterval(scan, 50);
      const dispose = () => {
        observer.disconnect();
        clearInterval(timer);
      };
      window.__idiomLoadingStuck = {
        read(stop) {
          scan();
          // Resolved intervals still need final mask membership: hiding a
          // target behind a newly matching mask cannot establish acceptance.
          const maskRects = masks.flatMap((s) => {
            try {
              return [...document.querySelectorAll(s)].map(h.box);
            } catch {
              return [];
            }
          });
          for (const record of records) {
            const el = targets.get(record);
            if (!el) continue;
            const r = h.box(el);
            record.masked ||=
              h.matches(el, masks) ||
              maskRects.some((m) => {
                const overlap = h.intersect(m, r);
                return overlap.width > 0 && overlap.height > 0;
              });
          }
          if (stop) dispose();
          return {
            status: "ran",
            windowMs,
            observedMs: performance.now() - start,
            intentional: false,
            records,
          };
        },
        dispose,
      };
    },
    { windowMs, masks },
  );
}
export async function readLoadingObservation(
  page: Page,
  stop = false,
): Promise<LoadingStuckEvidence | undefined> {
  return page.evaluate((stop) => window.__idiomLoadingStuck?.read(stop), stop);
}
export async function disposeLoadingObservation(page: Page): Promise<void> {
  await page
    .evaluate(() => {
      window.__idiomLoadingStuck?.dispose();
      delete window.__idiomLoadingStuck;
    })
    .catch(() => undefined);
}
export function loadingPersists(
  record: LoadingStuckEvidence["records"][number],
  windowMs: number,
): boolean {
  return record.active && !record.masked && record.ageMs >= windowMs;
}

import type { Page } from "playwright";
import {
  type ExplanationDomWindow,
  ensureExplanationDom,
} from "../checks/explanation-dom.js";
import { observePage } from "../checks/observe.js";
import { isVisuallyHidden } from "../checks/shared.js";
import type {
  ExplanationArtifact,
  ExplanationRecord,
} from "../checks/types.js";
import { isGlyphLabel } from "../checks/unexplained-control.js";
import { Deadline, deadlinePage } from "./deadline.js";

type ExplanationWindow = Window & {
  __idiomExplanations?: {
    token: string;
    finish(reason?: string): ExplanationRecord[];
    dispose(): void;
  };
};

export function mergeExplanations(
  ...artifacts: (ExplanationArtifact | undefined)[]
): ExplanationArtifact | undefined {
  const available = artifacts.filter(
    (value): value is ExplanationArtifact => value !== undefined,
  );
  if (available.length === 0) return undefined;
  const records = new Map<string, ExplanationRecord>();
  for (const artifact of available)
    for (const record of artifact.records)
      records.set(JSON.stringify(record), record);
  const reasons = [
    ...new Set(
      available.flatMap((value) => (value.reason ? [value.reason] : [])),
    ),
  ];
  return {
    version: 1,
    status: available.some((value) => value.status === "partial")
      ? "partial"
      : "ran",
    ...(reasons.length ? { reason: reasons.join("; ") } : {}),
    records: [...records.values()],
  };
}

/** Collects actual transitions in one action window; it never triggers an interaction. */
export class ExplanationCollector {
  private records: ExplanationRecord[] = [];
  private reasons: string[] = [];
  constructor(
    private page: Page,
    private source: "probe" | "capture" = "capture",
    private waitMs = 150,
  ) {}

  evidence(): ExplanationArtifact {
    return {
      version: 1,
      status: this.reasons.length ? "partial" : "ran",
      ...(this.reasons.length
        ? { reason: [...new Set(this.reasons)].join("; ") }
        : {}),
      records: [...this.records],
    };
  }

  partial(reason: string) {
    this.reasons.push(reason);
  }

  unavailable(selector: string, reason: string) {
    this.partial(reason);
    for (const trigger of ["hover", "focus"] as const)
      this.records.push({
        selector,
        trigger,
        source: this.source,
        status: "unavailable",
        reason,
        tooltips: [],
      });
  }

  async start(identity?: { selector: string; controlId: string }): Promise<{
    finish(reason?: string): Promise<void>;
    dispose(): Promise<void>;
  }> {
    const token = `${Date.now()}:${Math.random()}`;
    let finished = false;
    try {
      await ensureExplanationDom(this.page);
      await this.page.evaluate(
        ({ token, source, identity }) => {
          const scope = window as ExplanationWindow;
          scope.__idiomExplanations?.dispose();
          const generatedClass = (value: string): boolean =>
            /__[A-Za-z0-9_-]{5,}$/.test(value) ||
            /^(?:css|jsx|sc|emotion|styled)[-_][A-Za-z0-9_-]{5,}$/i.test(
              value,
            ) ||
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

          const dom = (window as ExplanationDomWindow).__idiomExplanationDom;
          if (!dom) throw new Error("explanation DOM helpers unavailable");
          // Aliasing is restricted to the exact node validated after probe replay.
          const replayed = identity
            ? document.querySelector(identity.selector)
            : null;
          const snapshot = () =>
            [...document.querySelectorAll('[role="tooltip"]')].flatMap(
              (element) => {
                const text = dom.text(element);
                return text
                  ? [{ selector: selectorFor(element), text, element }]
                  : [];
              },
            );
          const baseline = new Map(
            snapshot().map((tip) => [tip.selector, tip.text]),
          );
          const samples = new Map<
            string,
            {
              control: Element;
              record: ExplanationRecord;
              independent: boolean;
            }
          >();
          const controlFor = (target: EventTarget | null) =>
            target instanceof Element
              ? target.closest(
                  'button, summary, a[href], [role="button"], [role="link"]',
                )
              : null;
          const begin = (
            target: EventTarget | null,
            trigger: "hover" | "focus",
          ) => {
            const control = controlFor(target);
            if (!control || (trigger === "focus" && control !== target)) return;
            const selector = selectorFor(control);
            const controlId =
              control === replayed && identity
                ? identity.controlId
                : dom.identity(control);
            const key = `${controlId}:${trigger}`;
            if (!samples.has(key))
              samples.set(key, {
                control,
                independent: false,
                record: {
                  selector,
                  controlId,
                  trigger,
                  source,
                  status: "absent",
                  tooltips: [],
                },
              });
          };
          const hover = (event: Event) => begin(event.target, "hover");
          const focus = () => begin(document.activeElement, "focus");
          const tick = () => {
            const tips = snapshot();
            for (const sample of samples.values()) {
              const { control, record } = sample;
              if (!control.isConnected) continue;
              const focused = control === document.activeElement;
              const hovered = control.matches(":hover");
              const independent =
                record.trigger === "hover"
                  ? hovered && !focused
                  : focused && !hovered;
              if (!independent) continue;
              sample.independent = true;
              const ids = [
                control.getAttribute("aria-describedby"),
                control.getAttribute("aria-controls"),
              ]
                .filter(Boolean)
                .join(" ")
                .split(/\s+/)
                .filter(Boolean);
              const linked = tips.filter((tip) =>
                ids.some((id) => {
                  const target = document.getElementById(id);
                  return (
                    target === tip.element || target?.contains(tip.element)
                  );
                }),
              );
              const changed = tips.filter(
                (tip) => baseline.get(tip.selector) !== tip.text,
              );
              const associated = linked.length
                ? linked
                : changed.length === 1
                  ? changed
                  : [];
              if (associated.length) {
                record.status = "observed";
                record.tooltips = associated.map(({ selector, text }) => ({
                  selector,
                  text,
                }));
              }
            }
          };
          document.addEventListener("pointerover", hover, true);
          document.addEventListener("focusin", focus, true);
          const timer = setInterval(tick, 20);
          const dispose = () => {
            clearInterval(timer);
            document.removeEventListener("pointerover", hover, true);
            document.removeEventListener("focusin", focus, true);
          };
          scope.__idiomExplanations = {
            token,
            dispose,
            finish(reason) {
              tick();
              dispose();
              return [...samples.values()].map(({ record, independent }) =>
                reason || !independent
                  ? {
                      ...record,
                      status: "unavailable",
                      reason:
                        reason ??
                        "hover and focus were not observed independently",
                      tooltips: [],
                    }
                  : record,
              );
            },
          };
        },
        { token, source: this.source, identity },
      );
    } catch {
      this.reasons.push("explanation action window could not start");
    }
    return {
      finish: async (reason) => {
        if (finished) return;
        finished = true;
        if (reason) this.reasons.push(reason);
        try {
          if (!reason)
            await this.page.waitForTimeout(Math.max(150, this.waitMs));
          const records = await this.page.evaluate(
            ({ token, reason }) => {
              const active = (window as ExplanationWindow).__idiomExplanations;
              if (active?.token !== token) return null;
              return active.finish(reason);
            },
            { token, reason },
          );
          if (records) this.records.push(...records);
          else
            this.reasons.push(
              "explanation window unavailable after navigation",
            );
        } catch {
          this.reasons.push("explanation action window failed");
        }
      },
      dispose: async () => {
        await this.page
          .evaluate((token) => {
            const scope = window as ExplanationWindow;
            if (scope.__idiomExplanations?.token === token) {
              scope.__idiomExplanations.dispose();
              delete scope.__idiomExplanations;
            }
          }, token)
          .catch(() => undefined);
      },
    };
  }
}

/** Carries completed samples when replay fails, so callers can stop before clicking. */
export class ExplanationRestoreFailure extends Error {
  constructor(readonly evidence: ExplanationArtifact) {
    super("explanation sampling could not restore the captured state");
  }
}

export type ExplanationCandidate = {
  selector: string;
  controlId: string | undefined;
  fingerprint: string | null;
  url: string;
};

/**
 * Capture identity before any hover/focus can mutate the document.
 * `textGlyphsOnly` keeps enabled controls whose painted text is a glyph such
 * as "?" (the default-mode evidence); bare icon controls are left out.
 */
export async function explanationCandidates(
  page: Page,
  options: { textGlyphsOnly?: boolean } = {},
): Promise<ExplanationCandidate[]> {
  const observations = await observePage(page, { status: "not-configured" });
  if (observations.version !== 2) return [];
  const controls = observations.elements.filter(
    (element) =>
      element.visible &&
      !isVisuallyHidden(element) &&
      element.interactive &&
      (["button", "summary", "a"].includes(element.tag) ||
        ["button", "link"].includes(element.signals?.role ?? "")) &&
      isGlyphLabel(element.signals?.explanation?.visibleText ?? element.text) &&
      (options.textGlyphsOnly !== true ||
        (element.enabled &&
          element.signals?.explanation?.nativeDisabled !== true &&
          (element.signals?.explanation?.visibleText ?? element.text).trim() !==
            "")),
  );
  const fingerprints = await page.evaluate(
    (selectors) => {
      const dom = (window as ExplanationDomWindow).__idiomExplanationDom;
      return selectors.map((selector) => {
        const control = document.querySelector(selector);
        return control && dom ? dom.fingerprint(control) : null;
      });
    },
    controls.map((control) => control.selector),
  );
  return controls.map((control, index) => ({
    selector: control.selector,
    controlId: control.signals?.explanation?.controlId,
    fingerprint: fingerprints[index] ?? null,
    url: page.url(),
  }));
}

/** Hover and focus stay isolated, and neither can alias a different replayed node. */
export async function sampleExplanation(options: {
  page: Page;
  candidate: ExplanationCandidate;
  collector: ExplanationCollector;
  waitMs: number;
  restore(page: Page): Promise<void>;
}): Promise<void> {
  const { page, candidate, collector } = options;
  for (const trigger of ["hover", "focus"] as const) {
    await options.restore(page);
    await page.mouse.move(-1, -1);
    await page.evaluate(() =>
      (document.activeElement as HTMLElement | null)?.blur(),
    );
    await page.waitForTimeout(Math.max(150, options.waitMs));
    await ensureExplanationDom(page);
    // A control missing after replay fails fast instead of spending the
    // whole control budget waiting for it.
    const fingerprint = await page
      .locator(candidate.selector)
      .first()
      .evaluate(
        (element) =>
          (window as ExplanationDomWindow).__idiomExplanationDom?.fingerprint(
            element,
          ),
        undefined,
        { timeout: 1500 },
      )
      .catch(() => null);
    if (
      page.url() !== candidate.url ||
      fingerprint !== candidate.fingerprint ||
      !candidate.controlId
    ) {
      collector.unavailable(
        candidate.selector,
        "replayed control does not match the captured control",
      );
      continue;
    }
    const sampling = await collector.start({
      selector: candidate.selector,
      controlId: candidate.controlId,
    });
    let reason: string | undefined;
    try {
      const target = page.locator(candidate.selector).first();
      if (trigger === "hover") await target.hover({ timeout: 1500 });
      else {
        await target.focus({ timeout: 1500 });
        if (
          !(await target.evaluate(
            (element) => element === document.activeElement,
          ))
        )
          reason = "control did not receive focus";
      }
    } catch {
      reason = `${trigger} action failed`;
    } finally {
      await sampling.finish(reason);
      await sampling.dispose();
      if (reason) collector.unavailable(candidate.selector, reason);
    }
  }
}

/** Standalone bounded sampler retained for library callers and fixture tests. */
export async function probeExplanations(options: {
  page: Page;
  skip: string[];
  maxControls: number;
  waitMs: number;
  controlTimeoutMs?: number;
  stateTimeoutMs?: number;
  restore(page: Page): Promise<void>;
}): Promise<ExplanationArtifact> {
  const state = new Deadline(
    "state",
    options.stateTimeoutMs ?? 60000,
    () => "explanations",
  );
  const scoped = deadlinePage(options.page, state);
  const collector = new ExplanationCollector(
    scoped.page,
    "probe",
    options.waitMs,
  );
  let restoreFailed = false;
  try {
    const controls = await state.run(() => explanationCandidates(scoped.page));
    let count = 0;
    for (const candidate of controls) {
      state.check();
      const attempt = new Deadline(
        "control",
        options.controlTimeoutMs ?? 5000,
        () => candidate.selector,
        { signal: state.signal },
      );
      const bound = deadlinePage(options.page, attempt);
      try {
        await attempt.run(async () => {
          const skip = await bound.page
            .locator(candidate.selector)
            .first()
            .evaluate(
              (element, selectors) =>
                selectors.some((selector) => {
                  try {
                    return element.closest(selector) !== null;
                  } catch {
                    return false;
                  }
                }),
              options.skip,
            );
          if (skip || count >= options.maxControls) {
            collector.unavailable(
              candidate.selector,
              skip ? "checks.probe.skip" : "checks.probe.maxControls",
            );
            return;
          }
          count += 1;
          await sampleExplanation({
            ...options,
            page: bound.page,
            candidate,
            collector,
          });
        });
      } catch (error) {
        collector.unavailable(candidate.selector, String(error));
        if (state.signal.aborted) throw error;
      } finally {
        bound.dispose();
        attempt.dispose();
      }
    }
  } catch (error) {
    collector.partial(`explanation sampling stopped: ${String(error)}`);
  } finally {
    try {
      await state.run(async () => {
        await options.restore(scoped.page);
        await scoped.page.mouse.move(-1, -1);
        await scoped.page.evaluate(() =>
          (document.activeElement as HTMLElement | null)?.blur(),
        );
      });
    } catch {
      collector.partial(
        "explanation sampling could not restore the captured state",
      );
      restoreFailed = !state.signal.aborted;
    }
    scoped.dispose();
    state.dispose();
  }
  if (restoreFailed) throw new ExplanationRestoreFailure(collector.evidence());
  return collector.evidence();
}

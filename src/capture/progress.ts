import type { Page } from "playwright";
import type {
  ProgressAffordanceKind,
  ProgressArtifact,
  ProgressStep,
} from "../checks/types.js";

type StepIdentity = Pick<ProgressStep, "stepIndex" | "action" | "selector">;
type Hit = {
  kind: ProgressAffordanceKind;
  selector: string;
  text?: string | undefined;
};
type BrowserWindow = Window & {
  __idiomProgress?: {
    token: string;
    bindTarget(target: Element): void;
    read(): { elapsed: number | null; firstMs: number | null; hit: Hit | null };
    dispose(): void;
  };
};

/**
 * Watches one declared longRunning step for the first progress affordance
 * that appears after the action begins. Only the first hit is kept.
 */
export class ProgressCollector {
  private steps: ProgressStep[] = [];
  constructor(
    private page: Page,
    private withinMs: number,
  ) {}

  async start(
    identity: StepIdentity,
    options: { waitForAction?: boolean } = {},
  ): Promise<{
    markSettled(): Promise<void>;
    finish(options?: { settledMs?: number; reason?: string }): Promise<void>;
    dispose(): Promise<void>;
  }> {
    const token = `${Date.now()}:${Math.random()}`;
    let failure: string | undefined;
    const target = options.waitForAction
      ? this.page.locator(identity.selector)
      : undefined;
    try {
      await this.page.evaluate(
        ({ selector, token, action, waitForAction }) => {
          const scope = window as BrowserWindow;
          scope.__idiomProgress?.dispose();
          let startedAt: number | null = waitForAction
            ? null
            : performance.now();
          let firstMs: number | null = null;
          let hit: Hit | null = null;
          const rendered = (element: Element): boolean => {
            if (element.getClientRects().length === 0) return false;
            const style = getComputedStyle(element);
            if (style.visibility !== "visible") return false;
            for (
              let current: Element | null = element;
              current;
              current = current.parentElement
            ) {
              const ancestor = getComputedStyle(current);
              if (ancestor.display === "none" || Number(ancestor.opacity) <= 0)
                return false;
            }
            return true;
          };
          const selectorFor = (element: Element): string => {
            if (element === document.documentElement) return "html";
            if (element === document.body) return "body";
            if (
              element.id &&
              document.querySelectorAll(`#${CSS.escape(element.id)}`).length ===
                1
            )
              return `#${CSS.escape(element.id)}`;
            for (const attr of ["data-testid", "aria-label", "role"]) {
              const value = element.getAttribute(attr);
              if (!value) continue;
              const candidate = `${element.tagName.toLowerCase()}[${attr}=${JSON.stringify(value)}]`;
              if (document.querySelectorAll(candidate).length === 1)
                return candidate;
            }
            const classes = [...element.classList].sort().slice(0, 3);
            if (classes.length) {
              const candidate = `${element.tagName.toLowerCase()}${classes.map((value) => `.${CSS.escape(value)}`).join("")}`;
              if (document.querySelectorAll(candidate).length === 1)
                return candidate;
            }
            const parts: string[] = [];
            let current: Element | null = element;
            while (current !== null && current !== document.body) {
              const siblings: Element[] = current.parentElement
                ? [...current.parentElement.children].filter(
                    (child) => child.tagName === current?.tagName,
                  )
                : [];
              parts.unshift(
                siblings.length > 1
                  ? `${current.tagName.toLowerCase()}:nth-of-type(${siblings.indexOf(current) + 1})`
                  : current.tagName.toLowerCase(),
              );
              current = current.parentElement;
            }
            return `body > ${parts.join(" > ")}`;
          };
          const normalize = (value: string | null | undefined) =>
            (value ?? "").replace(/\s+/g, " ").trim();
          const textOf = (element: Element) =>
            normalize(
              element.getAttribute("aria-label") ||
                (element instanceof HTMLElement
                  ? element.innerText
                  : element.textContent),
            );
          const progressSelector =
            "[role=progressbar], progress, [aria-busy=true]";
          const statusSelector =
            "[role=status], [role=log], [aria-live]:not([aria-live=off]), output";
          const progressWords =
            /\b(loading|saving|generating|working|processing|thinking|uploading|sending|submitting|please wait)\b/i;
          let progressBaseline = new WeakSet<Element>(
            [...document.querySelectorAll(progressSelector)].filter(rendered),
          );
          const infinite = (animation: Animation) =>
            animation.effect?.getTiming().iterations === Infinity;
          const visibleInfinite = (animation: Animation): boolean => {
            if (!infinite(animation)) return false;
            const target = (animation.effect as KeyframeEffect | null)?.target;
            return target instanceof Element && rendered(target);
          };
          let animationBaseline = new WeakSet<Animation>(
            document.getAnimations().filter(visibleInfinite),
          );
          let statusBaseline = new WeakMap<Element, string>();
          for (const region of document.querySelectorAll(statusSelector))
            statusBaseline.set(region, rendered(region) ? textOf(region) : "");
          let trigger: Element | null = null;
          try {
            trigger ??= document.querySelector(selector);
          } catch {
            // Playwright-only targets are bound with the live locator below.
          }
          let triggerText = trigger === null ? "" : textOf(trigger);
          const actionEvents =
            action === "click"
              ? ["pointerdown", "click"]
              : action === "press"
                ? ["keydown"]
                : action === "select"
                  ? ["input", "change"]
                  : ["keydown", "beforeinput", "input"];
          const onAction = (event: Event) => {
            if (
              startedAt !== null ||
              ((action === "click" || action === "press") && !event.isTrusted)
            )
              return;
            // Fill and select can dispatch on a label's associated control.
            // Resolve the association now, so replacements during the wait
            // remain aligned with Playwright's live retargeting.
            let dispatchTarget = trigger;
            if (
              trigger !== null &&
              (action === "fill" || action === "select") &&
              !trigger.matches("input, textarea, select") &&
              !(trigger instanceof HTMLElement && trigger.isContentEditable)
            ) {
              dispatchTarget = trigger.closest("label")?.control ?? trigger;
            }
            const target = event
              .composedPath()
              .find((node): node is Element => {
                if (!(node instanceof Element)) return false;
                if (node === dispatchTarget) return true;
                try {
                  return node.matches(selector);
                } catch {
                  return false;
                }
              });
            if (!target) return;
            startedAt = performance.now();
            // Rebaseline at dispatch: changes while Playwright was waiting are
            // not feedback for this action. This capture-phase baseline precedes
            // the target and bubble-phase application handlers.
            trigger = target;
            progressBaseline = new WeakSet(
              [...document.querySelectorAll(progressSelector)].filter(rendered),
            );
            animationBaseline = new WeakSet(
              document.getAnimations().filter(visibleInfinite),
            );
            statusBaseline = new WeakMap();
            for (const region of document.querySelectorAll(statusSelector))
              statusBaseline.set(
                region,
                rendered(region) ? textOf(region) : "",
              );
            triggerText = textOf(trigger);
            observer.takeRecords();
            for (const type of actionEvents)
              window.removeEventListener(type, onAction, true);
          };

          const record = (kind: ProgressAffordanceKind, element: Element) => {
            if (hit !== null || startedAt === null) return;
            firstMs = performance.now() - startedAt;
            const text = textOf(element).slice(0, 80);
            hit = {
              kind,
              selector: selectorFor(element),
              ...(text ? { text } : {}),
            };
            stop();
          };
          const scan = (records: MutationRecord[] = []) => {
            if (hit !== null || startedAt === null) return;
            for (const element of document.querySelectorAll(progressSelector)) {
              const becameBusy =
                element.getAttribute("aria-busy") === "true" &&
                records.some(
                  (mutation) =>
                    mutation.target === element &&
                    mutation.attributeName === "aria-busy" &&
                    mutation.oldValue !== "true",
                );
              if (
                (progressBaseline.has(element) && !becameBusy) ||
                !rendered(element)
              )
                continue;
              return record(
                element.getAttribute("aria-busy") === "true" &&
                  !element.matches("[role=progressbar], progress")
                  ? "busy"
                  : "progressbar",
                element,
              );
            }
            for (const animation of document.getAnimations()) {
              if (!infinite(animation) || animationBaseline.has(animation))
                continue;
              const target = (animation.effect as KeyframeEffect | null)
                ?.target;
              if (target instanceof Element && rendered(target))
                return record("spinner", target);
            }
            for (const region of document.querySelectorAll(statusSelector)) {
              if (!rendered(region)) continue;
              const text = textOf(region);
              if (text !== "" && text !== (statusBaseline.get(region) ?? ""))
                return record("status-text", region);
            }
            if (trigger?.isConnected && rendered(trigger)) {
              const text = textOf(trigger);
              if (text !== "" && text !== triggerText)
                return record("control-text", trigger);
            }
            for (const mutation of records) {
              const nodes =
                mutation.type === "characterData"
                  ? [mutation.target]
                  : [...mutation.addedNodes];
              for (const node of nodes) {
                const element =
                  node instanceof Element ? node : node.parentElement;
                if (element === null || !rendered(element)) continue;
                const text = normalize(
                  node instanceof HTMLElement
                    ? node.innerText
                    : node.textContent,
                );
                if (
                  text !== "" &&
                  (progressWords.test(text) || /(?:…|\.\.\.)$/.test(text))
                )
                  return record("progress-text", element);
              }
            }
          };
          const observer = new MutationObserver((records) => scan(records));
          observer.observe(document, {
            subtree: true,
            childList: true,
            attributes: true,
            attributeOldValue: true,
            characterData: true,
          });
          const interval = setInterval(() => scan(), 50);
          function stop() {
            observer.disconnect();
            clearInterval(interval);
            for (const type of actionEvents)
              window.removeEventListener(type, onAction, true);
          }
          if (waitForAction)
            for (const type of actionEvents)
              window.addEventListener(type, onAction, true);
          scope.__idiomProgress = {
            token,
            bindTarget: (target) => {
              if (startedAt === null) trigger = target;
            },
            read: () => ({
              elapsed:
                startedAt === null ? null : performance.now() - startedAt,
              firstMs,
              hit,
            }),
            dispose: () => {
              stop();
              delete scope.__idiomProgress;
            },
          };
        },
        {
          selector: identity.selector,
          token,
          action: identity.action,
          waitForAction: options.waitForAction === true,
        },
      );
      if (target) {
        const bindTarget = async () => {
          await target.evaluate(
            (element, token) => {
              const active = (window as BrowserWindow).__idiomProgress;
              if (active?.token === token) active.bindTarget(element);
            },
            token,
            { timeout: 10_000 },
          );
        };
        // Initial binding covers actions such as press; the handler re-resolves
        // the locator before every actionability retry, including replacements.
        await bindTarget();
        await this.page.addLocatorHandler(target, bindTarget, {
          noWaitAfter: true,
        });
      }
    } catch (error) {
      failure = `progress instrumentation unavailable: ${String(error).split("\n")[0]}`;
    }
    const read = () =>
      this.page.evaluate((token) => {
        const active = (window as BrowserWindow).__idiomProgress;
        return active?.token === token ? active.read() : null;
      }, token);
    const dispose = async () => {
      if (target)
        await this.page.removeLocatorHandler(target).catch(() => undefined);
      await this.page
        .evaluate((token) => {
          const active = (window as BrowserWindow).__idiomProgress;
          if (active?.token === token) active.dispose();
        }, token)
        .catch(() => undefined);
    };
    const unavailable = (reason: string) => {
      this.steps.push({
        ...identity,
        status: "unavailable",
        reason,
        firstMs: null,
        observedMs: 0,
      });
    };
    let finishing: Promise<void> | undefined;
    let settledMs: number | undefined;
    return {
      markSettled: async () => {
        const state = await read().catch(() => null);
        settledMs = state?.elapsed ?? undefined;
      },
      finish: (options = {}) => {
        if (finishing) return finishing;
        finishing = (async () => {
          try {
            if (failure) return unavailable(failure);
            if (options.reason) return unavailable(options.reason);
            let state = await read();
            // Keep watching for the whole window, measured by the page clock.
            for (
              let attempt = 0;
              state !== null &&
              state.elapsed !== null &&
              state.elapsed < this.withinMs &&
              attempt < 3;
              attempt++
            ) {
              await this.page.waitForTimeout(
                Math.ceil(this.withinMs - state.elapsed) + 5,
              );
              state = await read();
            }
            if (state === null)
              return unavailable(
                "document navigation invalidated the progress window",
              );
            if (state.elapsed === null)
              return unavailable(
                "action dispatch was not observed; progress evidence unavailable",
              );
            const settled = options.settledMs ?? settledMs;
            this.steps.push({
              ...identity,
              status: "ran",
              firstMs: state.firstMs,
              ...(state.hit === null ? {} : { affordance: state.hit }),
              observedMs: state.elapsed,
              ...(settled === undefined
                ? {}
                : { settledMs: Math.round(settled) }),
            });
          } catch (error) {
            unavailable(String(error).split("\n")[0] ?? "progress read failed");
          } finally {
            await dispose();
          }
        })();
        return finishing;
      },
      dispose,
    };
  }

  evidence(): ProgressArtifact {
    return { version: 1, withinMs: this.withinMs, steps: [...this.steps] };
  }
}

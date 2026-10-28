import type { Page } from "playwright";
import type {
  ProgressAffordanceKind,
  ProgressArtifact,
  ProgressStep,
} from "../checks/types.js";
import { type FeedbackWindow, installFeedback } from "./feedback.js";

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
      await this.page.evaluate(installFeedback);
      await this.page.evaluate(
        ({ selector, token, action, waitForAction }) => {
          const scope = window as BrowserWindow;
          scope.__idiomProgress?.dispose();
          let startedAt: number | null = waitForAction
            ? null
            : performance.now();
          let firstMs: number | null = null;
          let hit: Hit | null = null;
          const {
            selectorFor,
            textOf,
            actionEvents: eventsFor,
            dispatchTarget,
            indicatorBaseline,
            scanIndicators,
            addedProgressText,
          } = (window as unknown as FeedbackWindow).__idiomFeedback;
          let baseline = indicatorBaseline({ visibleAnimationsOnly: true });
          let trigger: Element | null = null;
          try {
            trigger ??= document.querySelector(selector);
          } catch {
            // Playwright-only targets are bound with the live locator below.
          }
          let triggerText = trigger === null ? "" : textOf(trigger);
          const actionEvents = eventsFor(action);
          const onAction = (event: Event) => {
            if (
              startedAt !== null ||
              ((action === "click" || action === "press") && !event.isTrusted)
            )
              return;
            const target = dispatchTarget(event, trigger, selector, action);
            if (!target) return;
            startedAt = performance.now();
            // Rebaseline at dispatch: changes while Playwright was waiting are
            // not feedback for this action. This capture-phase baseline precedes
            // the target and bubble-phase application handlers.
            trigger = target;
            baseline = indicatorBaseline({ visibleAnimationsOnly: true });
            triggerText = textOf(trigger);
            observer.takeRecords();
            for (const type of actionEvents)
              window.removeEventListener(type, onAction, true);
          };

          const record = (kind: ProgressAffordanceKind, element: Element) => {
            if (hit !== null || startedAt === null) return true;
            firstMs = performance.now() - startedAt;
            const text = textOf(element).slice(0, 80);
            hit = {
              kind,
              selector: selectorFor(element),
              ...(text ? { text } : {}),
            };
            stop();
            return true;
          };
          const scan = (records: MutationRecord[] = []) => {
            if (hit !== null || startedAt === null) return;
            if (
              scanIndicators(baseline, {
                trigger,
                triggerText,
                records,
                skipTrigger: false,
                rebusyBaseline: true,
                visit: record,
              })
            )
              return;
            addedProgressText(records, record);
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

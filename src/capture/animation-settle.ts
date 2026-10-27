import type { Page } from "playwright";

/**
 * Natural completion under one deadline; never finishes or cancels page effects.
 * `unresolved` means a finite effect was still running at the deadline; an
 * infinite effect is never waited for, so it leaves the tuple settled.
 */
export async function settleAnimations(
  page: Page,
  milliseconds = 1500,
  signal?: AbortSignal,
  checkpoint?: () => Promise<void>,
): Promise<{ hadAnimations: boolean; unresolved: boolean }> {
  const deadline = performance.now() + milliseconds;
  let hadAnimations = false;
  for (;;) {
    signal?.throwIfAborted();
    const remaining = Math.max(0, deadline - performance.now());
    const round = await page.evaluate(
      async (waitMs) => {
        if (typeof document.getAnimations !== "function")
          return { had: false, active: false, finite: false };
        const active = () =>
          document
            .getAnimations()
            .filter(
              (animation) =>
                animation.pending ||
                !["finished", "idle"].includes(animation.playState),
            );
        const animations = active();
        const finite = animations.filter(
          (animation) =>
            animation.playState !== "paused" &&
            animation.playbackRate !== 0 &&
            Number.isFinite(animation.effect?.getComputedTiming().endTime),
        );
        if (finite.length === 0 || waitMs === 0)
          return {
            had: document.getAnimations().length > 0 || animations.length > 0,
            active: animations.length > 0,
            finite: finite.length > 0,
          };
        let timer: ReturnType<typeof setTimeout> | undefined;
        let frame: number | undefined;
        let disposed = false;
        try {
          await Promise.race([
            Promise.all(
              finite.map((animation) =>
                animation.finished.catch(() => undefined),
              ),
            ).then(
              () =>
                new Promise<void>((resolve) => {
                  if (disposed) return resolve();
                  frame = requestAnimationFrame(() => resolve());
                }),
            ),
            new Promise<void>((resolve) => {
              timer = setTimeout(resolve, waitMs);
            }),
          ]);
        } finally {
          disposed = true;
          clearTimeout(timer);
          if (frame !== undefined) cancelAnimationFrame(frame);
        }
        const current = active();
        return {
          had: document.getAnimations().length > 0 || animations.length > 0,
          active: current.length > 0,
          finite: current.some(
            (animation) =>
              animation.playState !== "paused" &&
              animation.playbackRate !== 0 &&
              Number.isFinite(animation.effect?.getComputedTiming().endTime),
          ),
        };
      },
      Math.min(50, remaining),
    );
    signal?.throwIfAborted();
    await checkpoint?.();
    hadAnimations ||= round?.had === true;
    if (!round?.finite || performance.now() >= deadline)
      return { hadAnimations, unresolved: round?.finite === true };
  }
}

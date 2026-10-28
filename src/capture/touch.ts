import type { CDPSession, Page } from "playwright";
import type { TouchReachabilityArtifact } from "../checks/dynamic-schema.js";
import type { ChecksConfig } from "../checks/types.js";

type Declaration = NonNullable<ChecksConfig["touchReachability"]>;
type Entry = TouchReachabilityArtifact["entries"][number];

/** Bounded scan; anything beyond is disclosed as partial coverage. */
export const touchCandidateLimit = 100;
const focusAlternativeLimit = 5;
const settleLimitMs = 1000;

type Candidate = {
  selector: string;
  name: string;
  rect: Entry["rect"];
  owner: string;
  /** Owner plus its ancestors, owner first. */
  ownerChain: string[];
  baseline: Entry["baseline"];
  cause: Entry["cause"];
  focusTargets: Array<{ selector: string; ancestors: string[] }>;
};

type Scan = {
  touch: boolean;
  eligible: number;
  diagnostics: string[];
  candidates: Candidate[];
};

/**
 * Finds enabled controls hidden at rest under a no-hover touch profile and
 * asks Chromium's cascade, through forced pseudo states, whether hovering a
 * painted owner or focusing a painted target reveals them. Never activates,
 * focuses, or hovers the hidden control itself.
 */
export async function diagnoseTouchReachability(
  page: Page,
  declaration: Declaration,
): Promise<TouchReachabilityArtifact> {
  const base = { version: 1 as const, declaration };
  let scan: Scan;
  try {
    scan = await scanCandidates(page, declaration);
  } catch (error) {
    return {
      ...base,
      status: "unavailable",
      diagnostics: [`touch scan unavailable: ${firstLine(error)}`],
      eligible: 0,
      restored: true,
      entries: [],
    };
  }
  if (!scan.touch || scan.candidates.length === 0)
    return {
      ...base,
      status: scan.diagnostics.length ? "partial" : "ran",
      diagnostics: scan.diagnostics,
      eligible: scan.eligible,
      restored: true,
      entries: [],
    };

  let session: CDPSession | undefined;
  const entries: Entry[] = [];
  const diagnostics = [...scan.diagnostics];
  let restored = true;
  try {
    const cdp = await page.context().newCDPSession(page);
    session = cdp;
    await cdp.send("DOM.enable");
    await cdp.send("CSS.enable");
    const { root } = await cdp.send("DOM.getDocument", { depth: 0 });
    const nodeId = async (selector: string) => {
      const { nodeId } = await cdp.send("DOM.querySelector", {
        nodeId: root.nodeId,
        selector,
      });
      if (!nodeId) throw new Error(`node not found: ${selector}`);
      return nodeId;
    };
    const force = async (selectors: string[], classes: string[]) => {
      for (const selector of selectors)
        await cdp.send("CSS.forcePseudoState", {
          nodeId: await nodeId(selector),
          forcedPseudoClasses: classes,
        });
    };
    const trial = async (
      forced: Array<{ selectors: string[]; classes: string[] }>,
      control: string,
    ): Promise<Entry["hover"]> => {
      try {
        for (const { selectors, classes } of forced)
          await force(selectors, classes);
        const measured = await measure(page, control, settleLimitMs);
        if (measured === undefined)
          return { status: "unavailable", reason: "reveal did not settle" };
        return {
          status:
            measured.visibility === "visible" && measured.opacity > 0
              ? "revealed"
              : "hidden",
        };
      } finally {
        for (const { selectors } of forced) await force(selectors, []);
      }
    };

    for (const candidate of scan.candidates) {
      const trialStarted = Date.now();
      let hover: Entry["hover"];
      let focus: Entry["focus"] = { status: "hidden" };
      try {
        hover = await trial(
          [{ selectors: candidate.ownerChain, classes: ["hover"] }],
          candidate.selector,
        );
      } catch (error) {
        hover = { status: "unavailable", reason: firstLine(error) };
      }
      if (hover.status === "revealed")
        for (const target of candidate.focusTargets) {
          try {
            const result = await trial(
              [
                {
                  selectors: [target.selector],
                  classes: ["focus", "focus-within"],
                },
                { selectors: target.ancestors, classes: ["focus-within"] },
              ],
              candidate.selector,
            );
            if (result.status === "revealed") {
              focus = { status: "revealed", target: target.selector };
              break;
            }
            if (result.status === "unavailable")
              focus = { ...result, target: target.selector };
          } catch (error) {
            focus = {
              status: "unavailable",
              reason: firstLine(error),
              target: target.selector,
            };
          }
        }
      entries.push({
        selector: candidate.selector,
        identity: candidate.selector,
        name: candidate.name,
        rect: candidate.rect,
        owner: candidate.owner,
        elapsedMs: Date.now() - trialStarted,
        baseline: candidate.baseline,
        cause: candidate.cause,
        hover,
        focus,
      });
    }
  } catch (error) {
    diagnostics.push(`touch diagnostic failed: ${firstLine(error)}`);
  } finally {
    await session?.detach().catch(() => undefined);
  }
  try {
    restored = await baselineRestored(page, scan.candidates);
  } catch {
    restored = false;
  }
  if (!restored)
    diagnostics.push("touch diagnostic could not restore the resting state");
  const measuredAll = entries.length === scan.candidates.length;
  return {
    ...base,
    status: !restored
      ? "unavailable"
      : !measuredAll
        ? entries.length
          ? "partial"
          : "unavailable"
        : diagnostics.length
          ? "partial"
          : "ran",
    diagnostics,
    eligible: scan.eligible,
    restored,
    entries,
  };
}

/** Moves a lingering mouse hover off the page so the resting state is no-hover. */
export async function parkPointer(page: Page): Promise<void> {
  const touch = await page.evaluate(
    () =>
      matchMedia("(hover: none)").matches &&
      (matchMedia("(pointer: coarse)").matches || navigator.maxTouchPoints > 0),
  );
  if (touch) await page.mouse.move(-1, -1);
}

function firstLine(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).split(
    "\n",
  )[0] as string;
}

/** Waits for induced transitions on the control and its ancestors, then reads paint. */
async function measure(page: Page, selector: string, limitMs: number) {
  return page.evaluate(
    async ({ selector, limitMs }) => {
      const el = document.querySelector(selector);
      if (!el) return undefined;
      const chain: Element[] = [];
      for (let n: Element | null = el; n; n = n.parentElement) chain.push(n);
      const started = performance.now();
      const frame = () => new Promise((r) => requestAnimationFrame(r));
      await frame();
      await frame();
      for (;;) {
        const running = chain.some((n) =>
          n
            .getAnimations()
            .some(
              (a) =>
                typeof CSSTransition !== "undefined" &&
                a instanceof CSSTransition &&
                a.playState === "running",
            ),
        );
        if (!running) break;
        if (performance.now() - started > limitMs) return undefined;
        await frame();
      }
      let opacity = 1;
      for (const n of chain) opacity *= Number(getComputedStyle(n).opacity);
      return { visibility: getComputedStyle(el).visibility, opacity };
    },
    { selector, limitMs },
  );
}

async function baselineRestored(
  page: Page,
  candidates: Candidate[],
): Promise<boolean> {
  for (const candidate of candidates) {
    const measured = await measure(page, candidate.selector, settleLimitMs);
    if (
      measured === undefined ||
      measured.visibility !== candidate.baseline.visibility ||
      Math.abs(measured.opacity - candidate.baseline.opacity) > 0.001
    )
      return false;
  }
  return true;
}

async function scanCandidates(
  page: Page,
  declaration: Declaration,
): Promise<Scan> {
  return page.evaluate(
    ({ ignore, limit, focusLimit }) => {
      const touch =
        matchMedia("(hover: none)").matches &&
        (matchMedia("(pointer: coarse)").matches ||
          navigator.maxTouchPoints > 0);
      const diagnostics: string[] = [];
      if (!touch) return { touch, eligible: 0, diagnostics, candidates: [] };
      const path = (el: Element): string => {
        const parts: string[] = [];
        for (let n: Element | null = el; n; n = n.parentElement) {
          const tag = n.tagName.toLowerCase();
          const same = n.parentElement
            ? [...n.parentElement.children].filter(
                (s) => s.tagName === n?.tagName,
              )
            : [n];
          parts.unshift(`${tag}:nth-of-type(${same.indexOf(n) + 1})`);
        }
        return parts.join(" > ");
      };
      const ignored = ignore.flatMap((selector) => {
        try {
          return [...document.querySelectorAll(selector)];
        } catch {
          diagnostics.push(`ignore ${selector}: invalid CSS selector`);
          return [];
        }
      });
      const interactive =
        'a[href],button,input:not([type="hidden"]),select,textarea,summary,[role="button"],[role="link"],[role="menuitem"],[role="tab"],[tabindex]:not([tabindex^="-"])';
      const inactive =
        '[hidden],[inert],[aria-hidden="true"],dialog:not([open]),[role="menu"],[role="listbox"],[role="tooltip"],[popover]:not(:popover-open)';
      const opacityOf = (el: Element) => {
        let value = 1;
        for (let n: Element | null = el; n; n = n.parentElement)
          value *= Number(getComputedStyle(n).opacity);
        return value;
      };
      const disabled = (el: Element) =>
        (el as HTMLButtonElement).disabled === true ||
        el.getAttribute("aria-disabled") === "true";
      const displayed = (el: Element) => {
        for (let n: Element | null = el; n; n = n.parentElement)
          if (getComputedStyle(n).display === "none") return false;
        return true;
      };
      const closedDetails = (el: Element) => {
        const details = el.closest("details:not([open])");
        return (
          details !== null && el.closest("summary")?.parentElement !== details
        );
      };
      const rectOf = (el: Element) => {
        const r = el.getBoundingClientRect();
        return { x: r.x, y: r.y, width: r.width, height: r.height };
      };
      const inViewport = (r: ReturnType<typeof rectOf>) =>
        r.width > 0 &&
        r.height > 0 &&
        r.x < innerWidth &&
        r.y < innerHeight &&
        r.x + r.width > 0 &&
        r.y + r.height > 0;
      const painted = (el: Element) =>
        getComputedStyle(el).visibility === "visible" &&
        opacityOf(el) > 0 &&
        inViewport(rectOf(el));
      const hidden: Element[] = [];
      for (const el of document.querySelectorAll(interactive)) {
        if (disabled(el) || el.closest(inactive) || closedDetails(el)) continue;
        if (!displayed(el)) continue;
        if (ignored.some((n) => n === el || n.contains(el))) continue;
        if (!inViewport(rectOf(el))) continue;
        const visibility = getComputedStyle(el).visibility;
        if (visibility === "visible" && opacityOf(el) > 0) continue;
        hidden.push(el);
      }
      const candidates = hidden.slice(0, limit).flatMap((el) => {
        let owner: Element | null = el.parentElement;
        while (owner && !painted(owner)) owner = owner.parentElement;
        if (!owner) return [];
        const ownerChain: string[] = [];
        for (let n: Element | null = owner; n; n = n.parentElement)
          ownerChain.push(path(n));
        const focusTargets = [owner, ...owner.querySelectorAll(interactive)]
          .filter(
            (t) =>
              t !== el &&
              !disabled(t) &&
              painted(t) &&
              (t as HTMLElement).tabIndex >= 0 &&
              !t.closest(inactive),
          )
          .slice(0, focusLimit)
          .map((t) => {
            const ancestors: string[] = [];
            for (let n = t.parentElement; n; n = n.parentElement)
              ancestors.push(path(n));
            return { selector: path(t), ancestors };
          });
        const visibility = getComputedStyle(el).visibility;
        const opacity = opacityOf(el);
        const byVisibility = visibility !== "visible";
        const byOpacity = opacity === 0;
        return [
          {
            selector: path(el),
            name: (
              el.getAttribute("aria-label") ||
              (el as HTMLElement).innerText ||
              el.getAttribute("title") ||
              ""
            )
              .replace(/\s+/g, " ")
              .trim(),
            rect: rectOf(el),
            owner: path(owner),
            ownerChain,
            baseline: { visibility, opacity },
            cause: (byVisibility && byOpacity
              ? "visibility and opacity"
              : byVisibility
                ? "visibility"
                : "opacity") as Candidate["cause"],
            focusTargets,
          },
        ];
      });
      if (hidden.length > limit)
        diagnostics.push(
          `touch scan capped at ${limit} of ${hidden.length} hidden controls`,
        );
      if (candidates.length < Math.min(hidden.length, limit))
        diagnostics.push(
          `${Math.min(hidden.length, limit) - candidates.length} hidden controls have no painted owner`,
        );
      return { touch, eligible: hidden.length, diagnostics, candidates };
    },
    {
      ignore: declaration.ignore,
      limit: touchCandidateLimit,
      focusLimit: focusAlternativeLimit,
    },
  );
}

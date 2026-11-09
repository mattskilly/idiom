import { createHash } from "node:crypto";
import type {
  Dialog,
  Download,
  FileChooser,
  Page,
  Request,
  Route,
} from "playwright";
import { menuTriggerPattern } from "../checks/collection-actions.js";
import { animatedKeys, snapCandidateKeys } from "../checks/motion-snap.js";
import type {
  ActionTimelineArtifact,
  ExplanationRecord,
  ObservationArtifact,
  ProbeArtifact,
  ProbeAttemptTimings,
  ProbeCollection,
  ProbeDismissal,
  ProbeEffect,
  ProbeReclick,
  ProbeResult,
  ProbeSafetyLedger,
  Rect,
  RevealedState,
  SelectionTrial,
  SelectsAncestor,
} from "../checks/types.js";
import { DESTRUCTIVE_ACTION_PATTERN } from "../copy-policy.js";
import { settleAnimations } from "./animation-settle.js";
import { Deadline, DeadlineExpired, deadlinePage } from "./deadline.js";
import {
  dismissalLimitReason,
  MAX_DISMISSALS,
  testDismissal,
} from "./dismissal.js";
import { beginEffectWindow, LATE_CONTENT_WINDOW_MS } from "./effect-window.js";
import {
  type ExplanationCandidate,
  ExplanationCollector,
  explanationCandidates,
  mergeExplanations,
  sampleExplanation,
} from "./explanations.js";
import {
  DEFAULT_FAILURE,
  eligibleFailureRequests,
  type FailureSettings,
  failureEligibility,
  failureKey,
  MAX_FAILURE_REPLAYS,
  replayFailure,
} from "./failure.js";
import { type ReplayRequest, replayRequests } from "./failure-identity.js";
import { readIndicator } from "./indicator.js";
import {
  type HeldItem,
  heldCandidate,
  installNoiseRecorder,
  MAX_HELD_REPLAYS,
  replayHeld,
} from "./loading.js";
import { menuInventory, triggerBox } from "./menu-inventory.js";
import { MotionCollector, mergeMotion } from "./motion.js";
import { FLOW_PROBE_EXHAUSTED } from "./probe-budget.js";
import {
  identityKeys,
  ORDINARY_PRIORITY,
  type ProbeLedger,
  type ProbeLedgerEntry,
} from "./probe-ledger.js";
import {
  backgroundRequestLabels,
  clickNetworkEffect,
  type InitiatedRequest,
} from "./probe-network.js";
import { MAX_RECLICKS, reclickLimitReason, testReclick } from "./reclick.js";
import type { ReplayLedger } from "./replay-ledger.js";
import {
  ignoredRequest,
  probeRequestAllowed,
  safeRequestMethod,
} from "./request-policy.js";
import { mergeTimelines, TimelineCollector } from "./timeline.js";
import type { CaptureHooks } from "./types.js";

/** Pages whose documents carry the held replay's noise recorder. */
const noiseRecorded = new WeakSet<Page>();

export { probeRequestAllowed };

export type ProbeOptions = CaptureHooks & {
  page: Page;
  filmstrips?: import("./filmstrips.js").FilmstripCapture | undefined;
  requestedActions?:
    | import("../checks/filmstrip-schema.js").FilmstripIdentity[]
    | undefined;
  enumerateOnly?: boolean | undefined;
  flowBudget?: import("./probe-budget.js").ProbeBudgetLease | undefined;
  /**
   * No flow target: per-state time fractions are off; only per-control
   * timeouts and the capture lifetime bound the state.
   */
  unbounded?: boolean | undefined;
  /** Replay on the supplied disposable page, including replacement pages. */
  restore: (page: Page) => Promise<void>;
  replacePage?: (() => Promise<Page>) | undefined;
  /** Prepare real pages before guarded replay; dispose after action recording. */
  preparePage?: ((page: Page) => Promise<() => Promise<void>>) | undefined;
  controlTimeoutMs?: number | undefined;
  stateTimeoutMs?: number | undefined;
  monotonicNow?: (() => number) | undefined;
  skip: string[];
  maxControls: number;
  waitMs: number;
  motionSelectors?: string[] | undefined;
  /** `checks.motion.minExtentPx`: the smallest change a snap must reach. */
  motionMinExtentPx?: number | undefined;
  /**
   * The project's reduced-motion preference (`capture.reducedMotion`),
   * restored after each normal-motion snap confirmation.
   */
  reducedMotion?: boolean | undefined;
  /** Receives the merged probe-click timelines once probing ends. */
  onTimelines?: ((timelines: ActionTimelineArtifact) => void) | undefined;
  respectControlIntent?: boolean;
  explanation?: "default" | "visible" | undefined;
  collections?: string[] | undefined;
  /**
   * Flow-scoped results of earlier states. A control whose identity already
   * has a completed result is not clicked again; its result is reused.
   */
  ledger?: ProbeLedger | undefined;
  /**
   * Flow-scoped held replays of web steps: a step another state owns this
   * round, or that already has a result, is not replayed here.
   */
  replayLedger?: ReplayLedger | undefined;
  /** This state's id, recorded as `reusedFrom` by later states. */
  stateId?: string | undefined;
  /** Ledger partition: the tuple's viewport and colour scheme. */
  ledgerPartition?: string | undefined;
  /**
   * The third-party policy (quick review on arbitrary URLs): no request
   * exemptions, no cross-origin top-level navigation, form submission and
   * permission prompts vetoed, everything counted in `ledger`, which is
   * published as `safety` on the artifact.
   */
  safety?: { policy: "third-party"; ledger: ProbeSafetyLedger } | undefined;
  /**
   * The held replay: after the clicks, actions that sent fetch/XHR/document
   * requests are replayed on a fresh copy with those requests held for
   * `delayMs`. `steps` are the state's web steps that sent requests; probe
   * clicks are queued as they run. Absent: no held replay.
   */
  failureReplay?: (FailureSettings & { completed?: string[] }) | undefined;
  heldReplay?:
    | { delayMs: number; withinMs: number; steps: HeldStep[] }
    | undefined;
  /**
   * Observe a disclosure the probe opened, in place, for the revealed-state
   * checks. Absent: nothing is observed (library callers are unchanged).
   */
  observeRevealed?:
    | ((
        page: Page,
        revealed: { root?: string | undefined; trigger: string },
      ) => Promise<ObservationArtifact>)
    | undefined;
  /** Revealed observations per state (default 12); 0 records none. */
  maxRevealed?: number | undefined;
  /**
   * Test how opened overlays close (Escape, an outside click, an iframe
   * click); `explicit` names modals exempt from the clicks. Absent: dismissal
   * is not tested (library callers are unchanged).
   */
  dismissal?: { explicit: string[] } | undefined;
  /**
   * The build gate's changed region: rendered fingerprints from a reference
   * run. An ordinary control whose fingerprint is unchanged is not clicked.
   */
  region?: ProbeRegion | undefined;
};

export type ProbeRegion = {
  reference: ReadonlyMap<string, string>;
  runId: string;
};

/** Why the gate left a control out: it renders exactly as in the reference. */
export const gateUnchangedReason = (runId: string) =>
  `gate: unchanged since ${runId}`;

/** Default `checks.probe.maxRevealed`. */
export const DEFAULT_MAX_REVEALED = 12;
/** Links and look-alike controls the selection pass clicks per state. */
export const SELECTION_TRIAL_LIMIT = 12;
/** The longest a revealed observation may take inside a control's budget. */
const REVEALED_OBSERVE_MS = 3000;

/** A web step whose action sent requests, replayable on a fresh page. */
export type HeldStep = {
  sourceAction?: import("../checks/types.js").ActionTimeline;
  requests?: ReplayRequest[];
  stepIndex: number;
  /** Identifies the replay across the flow's states (`replayKey`). */
  replayKey?: string | undefined;
  action: HeldItem["kind"];
  selector: string;
  /** Reach the state before this step (steps 1..n-1) on `page`. */
  reach(page: Page): Promise<void>;
  perform(page: Page): Promise<void>;
  repeat?: ((page: Page, timeoutMs: number) => Promise<void>) | undefined;
};

export type ProbeCandidate = {
  path: string;
  selector: string;
  name: string;
  repeated: boolean;
  repeatedGroup?: string | undefined;
  textLabel?: boolean | undefined;
  explanation?:
    | { selector: string; controlId?: string | undefined }
    | undefined;
  submit?: boolean | undefined;
  modal?: boolean | undefined;
  /** Declares a popup (`aria-haspopup`): its revealed items are nested work. */
  popup?: boolean | undefined;
  /** Opens something: a details summary, a popup or an expander. */
  disclosure?: "details" | "popup" | "expanded" | undefined;
  /** `aria-controls`: the ids of what the control opens. */
  controls?: string | undefined;
  region?: string | undefined;
  /** Explicit or implicit role, part of the control's identity. */
  role?: string | undefined;
  /** `#id`, or the control's and its parent's tag and sorted classes. */
  signature?: string | undefined;
  /** Enumeration position; results are published in this order. */
  order?: number | undefined;
  unavailable?: string | undefined;
  intentReason?: string | undefined;
  /** Rendered identity: rect, a fixed set of computed styles and text. */
  fingerprint?: string | undefined;
};

type Candidate = ProbeCandidate;

/**
 * One digest per candidate from its identity key, rounded rect, a fixed list
 * of computed styles and its trimmed text. Integer rects keep sub-pixel
 * layout noise from marking every control changed.
 */
async function renderedFingerprints(
  page: Page,
  candidates: Candidate[],
  keys: string[],
): Promise<string[]> {
  const rendered = await page.evaluate(
    (paths) => {
      const properties = [
        "display",
        "visibility",
        "opacity",
        "color",
        "background-color",
        "border-top-width",
        "border-right-width",
        "border-bottom-width",
        "border-left-width",
        "border-top-color",
        "border-right-color",
        "border-bottom-color",
        "border-left-color",
        "font-size",
        "font-weight",
        "padding",
        "gap",
      ];
      return paths.map((path) => {
        let element: Element | null = null;
        try {
          element = document.querySelector(path);
        } catch {
          element = null;
        }
        if (!element) return "absent";
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return JSON.stringify([
          [rect.x, rect.y, rect.width, rect.height].map(Math.round),
          properties.map((property) => style.getPropertyValue(property)),
          (element.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 200),
        ]);
      });
    },
    candidates.map((candidate) => candidate.path),
  );
  return rendered.map((value, index) =>
    createHash("sha1")
      .update(`${keys[index] ?? ""}\0${value}`)
      .digest("hex"),
  );
}

/** The probe's own check candidates, decided from one state's names. */
function checkCandidate(candidate: Candidate, names: Map<string, number>) {
  return (
    (names.get(candidate.name) ?? 0) > 1 ||
    Boolean(candidate.explanation) ||
    candidate.textLabel === false ||
    (candidate.popup === true && !candidate.submit) ||
    (candidate.textLabel === true &&
      !candidate.submit &&
      (candidate.role === "button" || candidate.role === "menuitem"))
  );
}

/** Landmarks whose controls are shared chrome, probed after a state's own. */
const chromeRegion = /^(?:banner|navigation|toolbar|menubar|contentinfo)\b/;

function individualsFirst(candidates: Candidate[]): Candidate[] {
  const action = (candidate: Candidate) =>
    `${candidate.role}|${candidate.name}|${candidate.region}`;
  const counts = new Map<string, number>();
  for (const candidate of candidates)
    counts.set(action(candidate), (counts.get(action(candidate)) ?? 0) + 1);
  const repeated = (candidate: Candidate) =>
    candidate.repeated || (counts.get(action(candidate)) ?? 0) >= 3;
  return [...candidates].sort(
    (a, b) => Number(repeated(a)) - Number(repeated(b)),
  );
}

type Snapshot = {
  url: string;
  revealed: string[];
  regions: Array<{ name: string; selector: string }>;
};

const menuItemSelector =
  "[role=menuitem], [role=menuitemradio], [role=menuitemcheckbox]";

async function visibleMenuItems(page: Page): Promise<string[]> {
  return await page
    .locator(menuItemSelector)
    .filter({ visible: true })
    .evaluateAll((elements) =>
      elements
        .map((element) =>
          (
            element.getAttribute("aria-label")?.trim() ||
            (element instanceof HTMLElement ? element.innerText : "")
              .replace(/\s+/g, " ")
              .trim() ||
            element.getAttribute("title")?.trim() ||
            ""
          ).slice(0, 80),
        )
        .filter((name) => name !== ""),
    );
}

/** Menu items that appeared since `before` (a persistent menubar does not count). */
function appeared(after: string[], before: string[]): string[] {
  const remaining = [...before];
  return after.filter((name) => {
    const index = remaining.indexOf(name);
    if (index === -1) return true;
    remaining.splice(index, 1);
    return false;
  });
}

/** Names that must never be clicked by an automated probe. */
const destructive = DESTRUCTIVE_ACTION_PATTERN;

export function createProbeSafetyLedger(origins: string[]): ProbeSafetyLedger {
  return {
    policy: "third-party",
    origins: [...new Set(origins)],
    requests: { sent: {}, blocked: {} },
    blocked: {
      crossOriginNavigation: 0,
      formSubmission: 0,
      download: 0,
      popup: 0,
      windowOpen: 0,
      beforeunload: 0,
      permission: 0,
    },
    skipped: { destructive: 0 },
  };
}

// Page and context routes can both see one request; count it once.
const recordedRequests = new WeakSet<object>();

/** Count a routed request as sent or blocked, once per request. */
export function recordProbeRequest(
  ledger: ProbeSafetyLedger,
  request: Pick<Request, "method">,
  allowed: boolean,
): void {
  if (recordedRequests.has(request)) return;
  recordedRequests.add(request);
  const method = request.method().toUpperCase();
  const counts = allowed ? ledger.requests.sent : ledger.requests.blocked;
  counts[method] = (counts[method] ?? 0) + 1;
}

/** A top-level navigation that would leave the ledger's origins. */
export function crossOriginNavigation(
  ledger: ProbeSafetyLedger,
  request: Request,
): boolean {
  let topLevel = false;
  try {
    topLevel =
      request.isNavigationRequest() && request.frame().parentFrame() === null;
  } catch {
    // Service-worker requests have no frame.
    return false;
  }
  if (!topLevel) return false;
  try {
    return !ledger.origins.includes(new URL(request.url()).origin);
  } catch {
    return true;
  }
}

async function installInstrumentation(
  page: Page,
  respectControlIntent: boolean,
): Promise<void> {
  // Normally already installed before the document's scripts; this late
  // copy covers a document loaded without it.
  await page.evaluate(recordClickRequests);
  await page.evaluate((respectControlIntent) => {
    const scope = window as unknown as {
      __idiomProbe?: {
        mutations: number;
        aria: number;
        clipboard: number;
        popups: number;
        initiated: InitiatedRequest[];
      };
      __idiomRequests?: ClickRequestRecorder;
      __idiomCleanup?: () => void;
      __idiomPickerCount?: () => number;
      __idiomObserver?: MutationObserver;
      __idiomRecords?: Array<{
        target: Node;
        type: MutationRecordType;
        attributeName: string | null;
        oldValue: string | null;
      }>;
    };
    scope.__idiomCleanup?.();
    scope.__idiomObserver?.disconnect();
    const restore: Array<() => void> = [];
    scope.__idiomCleanup = () => {
      scope.__idiomObserver?.disconnect();
      for (const cleanup of restore.splice(0)) cleanup();
      delete scope.__idiomPickerCount;
      delete scope.__idiomCleanup;
    };
    if (respectControlIntent) {
      let pickers = 0;
      const pending: Array<{
        event: Event;
        input: HTMLInputElement;
        eligible: boolean;
      }> = [];
      const onColorClick = (event: Event) => {
        const input = event
          .composedPath()
          .find(
            (node): node is HTMLInputElement =>
              node instanceof HTMLInputElement && node.type === "color",
          );
        if (!input) return;
        pending.push({
          event,
          input,
          eligible:
            input.isConnected &&
            !input.matches(":disabled") &&
            navigator.userActivation.isActive,
        });
      };
      document.addEventListener("click", onColorClick, true);
      restore.push(() => {
        document.removeEventListener("click", onColorClick, true);
        pending.length = 0;
      });
      // Read after dispatch: target and ancestor handlers can cancel activation.
      scope.__idiomPickerCount = () =>
        pickers +
        pending.filter(
          ({ event, input, eligible }) =>
            eligible &&
            !event.defaultPrevented &&
            input.isConnected &&
            input.type === "color" &&
            !input.matches(":disabled"),
        ).length;
      for (const prototype of [
        HTMLInputElement.prototype,
        HTMLSelectElement.prototype,
      ]) {
        const original = prototype.showPicker;
        if (typeof original !== "function") continue;
        const wrapped = function (this: HTMLInputElement | HTMLSelectElement) {
          const eligible =
            (this instanceof HTMLInputElement ||
              this instanceof HTMLSelectElement) &&
            this.isConnected &&
            !this.matches(":disabled") &&
            navigator.userActivation.isActive &&
            (this instanceof HTMLInputElement
              ? [
                  "file",
                  "color",
                  "date",
                  "datetime-local",
                  "month",
                  "week",
                  "time",
                ].includes(this.type) ||
                (["text", "search", "url", "tel", "email", "number"].includes(
                  this.type,
                ) &&
                  (this.list?.options.length ?? 0) > 0 &&
                  this.getClientRects().length > 0)
              : this instanceof HTMLSelectElement &&
                !this.multiple &&
                this.size <= 1 &&
                this.getClientRects().length > 0);
          const result = original.call(this);
          // A thrown native call must retain its exception and never count.
          if (eligible) pickers += 1;
          return result;
        };
        prototype.showPicker = wrapped;
        restore.push(() => {
          if (prototype.showPicker === wrapped) prototype.showPicker = original;
        });
      }
    }
    const state = {
      mutations: 0,
      aria: 0,
      clipboard: 0,
      popups: 0,
      initiated: [] as InitiatedRequest[],
    };
    scope.__idiomProbe = state;
    const counted: NonNullable<typeof scope.__idiomRecords> = [];
    scope.__idiomRecords = counted;
    const transient =
      /^(?:data-(?:focus|hover|press|active|focus-visible)[\w-]*|tabindex)$/;
    const tooltipish = (node: Node | null): boolean => {
      const element =
        node === null
          ? null
          : node.nodeType === Node.ELEMENT_NODE
            ? (node as Element)
            : node.parentElement;
      if (element === null) return false;
      if (element.closest("[role=tooltip]") !== null) return true;
      // Radix content renders visible children beside a visually hidden
      // role=tooltip copy. Its content parent owns both, but unrelated
      // menu/disclosure/status siblings in the popper must remain effects.
      const wrapper = element.closest("[data-radix-popper-content-wrapper]");
      if (!wrapper || element.hasAttribute("aria-expanded")) return false;
      const roots = [...wrapper.querySelectorAll("[role=tooltip]")].map(
        (tooltip) => {
          const content = tooltip.parentElement;
          return content &&
            content !== wrapper &&
            /^(?:closed|delayed-open|instant-open)$/.test(
              content.getAttribute("data-state") ?? "",
            ) &&
            !content.matches(
              "[role=menu], [role=listbox], [role=dialog], [role=alertdialog], [aria-expanded]",
            ) &&
            !content.querySelector(
              "button, a[href], input, select, textarea, [role=button], [role=menu], [role=listbox], [role=dialog], [role=alertdialog], [aria-expanded]",
            )
            ? content
            : tooltip;
        },
      );
      if (roots.length === 0) return false;
      const owned = (node: Node) => roots.some((root) => root.contains(node));
      if (owned(element)) return true;
      if (!roots.some((root) => element.contains(root))) return false;
      const walker = document.createTreeWalker(
        element,
        NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT,
      );
      for (let child = walker.nextNode(); child; child = walker.nextNode()) {
        if (owned(child)) continue;
        if (child.nodeType === Node.TEXT_NODE) {
          if (child.textContent?.trim()) return false;
        } else if (!roots.some((root) => child.contains(root))) {
          return false;
        }
      }
      return true;
    };
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        // Hover tooltips appear and vanish around any click; they are not
        // the control's effect.
        if (tooltipish(record.target)) continue;
        if (
          record.type === "childList" &&
          [...record.addedNodes, ...record.removedNodes].length > 0 &&
          [...record.addedNodes, ...record.removedNodes].every(
            (node) => node.nodeType !== Node.ELEMENT_NODE || tooltipish(node),
          ) &&
          [...record.addedNodes, ...record.removedNodes].some(
            (node) => node.nodeType === Node.ELEMENT_NODE,
          )
        )
          continue;
        if (record.type === "attributes") {
          const name = record.attributeName ?? "";
          if (transient.test(name)) continue;
          if (
            name === "data-state" &&
            [
              record.oldValue ?? "closed",
              (record.target as Element).getAttribute?.("data-state") ??
                "closed",
            ].every((value) =>
              /^(?:closed|delayed-open|instant-open)$/.test(value),
            ) &&
            (record.target as Element).getAttribute?.("aria-expanded") === null
          )
            continue;
          if (/^aria-(?:pressed|expanded|selected|checked|current)$/.test(name))
            state.aria += 1;
        }
        state.mutations += 1;
        counted.push({
          target: record.target,
          type: record.type,
          attributeName: record.attributeName,
          oldValue: record.oldValue,
        });
      }
    });
    observer.observe(document.documentElement, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeOldValue: true,
      characterData: true,
    });
    scope.__idiomObserver = observer;
    try {
      if (navigator.clipboard === undefined) {
        // Insecure origins have no clipboard API; give the page a recording
        // stand-in so "Copy" controls are judged by intent, not origin.
        Object.defineProperty(navigator, "clipboard", {
          configurable: true,
          value: { writeText: async () => undefined },
        });
      }
      const clipboard = navigator.clipboard;
      if (clipboard !== undefined) {
        const original = clipboard.writeText;
        const write = original?.bind(clipboard);
        const wrapped = async (text: string) => {
          state.clipboard += 1;
          return write === undefined
            ? undefined
            : write(text).catch(() => undefined);
        };
        clipboard.writeText = wrapped;
        restore.push(() => {
          if (clipboard.writeText === wrapped) clipboard.writeText = original;
        });
      }
    } catch {
      // A locked-down clipboard is simply not observed.
    }
    const exec = document.execCommand;
    const wrappedExec = (command: string, ...rest: unknown[]) => {
      if (/^(copy|cut)$/i.test(command)) state.clipboard += 1;
      return exec.call(document, command, ...(rest as [boolean?, string?]));
    };
    document.execCommand = wrappedExec;
    restore.push(() => {
      if (document.execCommand === wrappedExec) document.execCommand = exec;
    });
    const suppressed = (
      window as unknown as {
        __idiomSuppressed?: {
          print: number;
          popup: number;
          submit: number;
          permission: number;
        };
      }
    ).__idiomSuppressed;
    if (suppressed) {
      suppressed.print = 0;
      suppressed.popup = 0;
      suppressed.submit = 0;
      suppressed.permission = 0;
    }
    const open = window.open;
    const wrappedOpen = (...args: Parameters<typeof window.open>) => {
      state.popups += 1;
      void args;
      return null;
    };
    window.open = wrappedOpen;
    restore.push(() => {
      if (window.open === wrappedOpen) window.open = open;
    });
    // Requests the click starts are recorded by `recordClickRequests`,
    // armed only for this window.
    const requests = scope.__idiomRequests;
    if (requests) {
      requests.initiated = state.initiated;
      requests.armed = true;
      restore.push(() => {
        requests.armed = false;
      });
    }
  }, respectControlIntent);
}

async function cleanupInstrumentation(page: Page): Promise<void> {
  await page
    .evaluate(() => {
      (window as unknown as { __idiomCleanup?: () => void }).__idiomCleanup?.();
    })
    .catch(() => undefined);
}

async function readCounters(page: Page) {
  return await page.evaluate(() => {
    const scope = window as unknown as {
      __idiomPickerCount?: () => number;
      __idiomProbe?: {
        mutations: number;
        aria: number;
        clipboard: number;
        popups: number;
        initiated: InitiatedRequest[];
      };
    };
    return {
      ...(scope.__idiomProbe ?? {
        mutations: 0,
        aria: 0,
        clipboard: 0,
        popups: 0,
        initiated: [],
      }),
      pickers: scope.__idiomPickerCount?.() ?? 0,
      ...(() => {
        const suppressed = (
          window as unknown as {
            __idiomSuppressed?: {
              print: number;
              submit?: number;
              permission?: number;
            };
          }
        ).__idiomSuppressed;
        return {
          prints: suppressed?.print ?? 0,
          submits: suppressed?.submit ?? 0,
          permissions: suppressed?.permission ?? 0,
        };
      })(),
    };
  });
}

/**
 * Counted mutations that are not focus styling. Focus styling is a class,
 * style or data-* attribute change on the clicked control, the focused
 * element, or an ancestor of it (focus-within styling).
 */
async function primaryMutations(page: Page, clicked: string): Promise<number> {
  return await page
    .evaluate((path) => {
      const scope = window as unknown as {
        __idiomRecords?: Array<{
          target: Node;
          type: MutationRecordType;
          attributeName: string | null;
        }>;
      };
      const target = document.querySelector(path);
      const active = document.activeElement;
      return (scope.__idiomRecords ?? []).filter((record) => {
        if (record.type !== "attributes") return true;
        const name = record.attributeName ?? "";
        if (name !== "class" && name !== "style" && !name.startsWith("data-"))
          return true;
        const node = record.target;
        return !(
          node === target ||
          (active !== null && active !== document.body && node.contains(active))
        );
      }).length;
    }, clicked)
    .catch(() => 1);
}

/**
 * After a click: a strict ancestor of the clicked element newly became
 * selected, while neither selection nor focus moved to anything matching
 * the clicked element. Reads the click's own mutation records; never clicks.
 * `name` is the clicked element's accessible name, as `enumerate` reads it.
 */
async function ancestorSelection(
  page: Page,
  path: string,
  name: string,
): Promise<SelectsAncestor | undefined> {
  return await page.evaluate(
    ({ path, name }) => {
      const scope = window as unknown as {
        __idiomRecords?: Array<{
          target: Node;
          type: MutationRecordType;
          attributeName: string | null;
          oldValue?: string | null;
        }>;
      };
      const target = document.querySelector(path);
      if (target === null) return undefined;
      const role = target.getAttribute("role")?.trim().split(/\s+/)[0] ?? "";
      if (
        /^(?:option|tab|radio|checkbox|switch|menuitemradio|menuitemcheckbox|treeitem|gridcell|row)$/.test(
          role,
        ) ||
        target.matches("input[type=radio], input[type=checkbox]") ||
        target.closest("label") !== null
      )
        return undefined;
      const alpha = (color: string) => {
        if (color === "transparent") return 0;
        const slash = color.match(/\/\s*([\d.]+%?)\s*\)$/);
        if (slash?.[1] !== undefined)
          return slash[1].endsWith("%")
            ? Number.parseFloat(slash[1]) / 100
            : Number.parseFloat(slash[1]);
        const rgba = color.match(/^rgba\((.*)\)$/);
        if (rgba?.[1] !== undefined)
          return Number.parseFloat(rgba[1].split(",").at(-1) ?? "1");
        return 1;
      };
      const style = getComputedStyle(target);
      const parentStyle =
        target.parentElement === null
          ? undefined
          : getComputedStyle(target.parentElement);
      const ownFill =
        alpha(style.backgroundColor) > 0 &&
        style.backgroundColor !== parentStyle?.backgroundColor;
      const framed = (["Top", "Right", "Bottom", "Left"] as const).every(
        (side) =>
          (Number.parseFloat(style[`border${side}Width`]) || 0) >= 1 &&
          !["none", "hidden"].includes(style[`border${side}Style`]) &&
          alpha(style[`border${side}Color`]) > 0,
      );
      const affordance: "button" | "link" | "pointer" | undefined =
        ownFill || framed
          ? "button"
          : target.matches("a[href]") ||
              style.textDecorationLine.includes("underline") ||
              (parentStyle !== undefined &&
                style.color !== parentStyle.color &&
                alpha(style.backgroundColor) === 0)
            ? "link"
            : style.cursor === "pointer"
              ? "pointer"
              : undefined;
      if (affordance === undefined) return undefined;
      const selectedClass = /(?:^|[-_:])(?:selected|active|current)(?:$|[-_])/i;
      const absent = (value: string | null | undefined) =>
        value === null || value === undefined || value === "false";
      const markerOf = (
        element: Element,
        attribute: string,
        old: string | null,
      ): string | undefined => {
        const now = element.getAttribute(attribute);
        if (attribute === "aria-selected")
          return now === "true" && old !== "true" ? attribute : undefined;
        if (
          attribute === "aria-current" ||
          attribute === "data-selected" ||
          attribute === "data-active" ||
          attribute === "data-current"
        )
          return !absent(now) && absent(old) ? attribute : undefined;
        if (attribute === "data-state")
          return (now === "active" || now === "selected") && old !== now
            ? `data-state:${now}`
            : undefined;
        if (attribute === "class") {
          const before = new Set((old ?? "").split(/\s+/));
          const token = [...element.classList].find(
            (item) => selectedClass.test(item) && !before.has(item),
          );
          return token === undefined ? undefined : `class:${token}`;
        }
        return undefined;
      };
      // The first record per element and attribute holds the pre-click value.
      const firsts = new Map<
        string,
        { element: Element; old: string | null }
      >();
      const ids = new Map<Element, number>();
      for (const record of scope.__idiomRecords ?? []) {
        if (record.type !== "attributes" || record.attributeName === null)
          continue;
        if (!(record.target instanceof Element)) continue;
        const id = ids.get(record.target) ?? ids.size;
        ids.set(record.target, id);
        const key = `${id}|${record.attributeName}`;
        if (!firsts.has(key))
          firsts.set(key, {
            element: record.target,
            old: record.oldValue ?? null,
          });
      }
      const marked: Array<{ element: Element; marker: string }> = [];
      for (const [key, { element, old }] of firsts) {
        const marker = markerOf(element, key.slice(key.indexOf("|") + 1), old);
        if (marker !== undefined) marked.push({ element, marker });
      }
      if (marked.length === 0) return undefined;
      const normalized = (value: string) =>
        value.replace(/\s+/g, " ").trim().slice(0, 120);
      const nameOf = (element: Element) =>
        normalized(
          (element.getAttribute("aria-labelledby") ?? "")
            .split(/\s+/)
            .map((id) => document.getElementById(id)?.textContent ?? "")
            .join(" ")
            .trim() ||
            element.getAttribute("aria-label") ||
            (element as HTMLElement).innerText ||
            (element instanceof HTMLInputElement ? element.value : "") ||
            element.getAttribute("title") ||
            "",
        );
      const wanted = normalized(name);
      const references = (element: Element) =>
        target.id !== "" &&
        ([
          "aria-controls",
          "aria-labelledby",
          "aria-describedby",
          "aria-owns",
          "aria-activedescendant",
        ].some((attribute) =>
          (element.getAttribute(attribute) ?? "")
            .split(/\s+/)
            .includes(target.id),
        ) ||
          element.getAttribute("for") === target.id);
      const matches = (element: Element) =>
        (wanted !== "" && nameOf(element) === wanted) || references(element);
      // Selection that reached the clicked element, or anything standing for
      // it elsewhere, is the click working.
      for (const { element } of marked) {
        if (element === target || target.contains(element)) return undefined;
        if (!element.contains(target) && matches(element)) return undefined;
      }
      const active = document.activeElement;
      if (
        active !== null &&
        active !== document.body &&
        active !== target &&
        !target.contains(active) &&
        !active.contains(target) &&
        matches(active)
      )
        return undefined;
      const area = (element: Element) => {
        const rect = element.getBoundingClientRect();
        return rect.width * rect.height;
      };
      const visible = (element: Element) =>
        element.checkVisibility({
          checkOpacity: true,
          checkVisibilityCSS: true,
        }) && area(element) > 0;
      // ARIA states name the selection best, then data attributes, then classes.
      const rank = (marker: string) =>
        marker.startsWith("aria-") ? 0 : marker.startsWith("data-") ? 1 : 2;
      const ancestors = marked
        .filter(
          ({ element }) =>
            element !== target &&
            element.contains(target) &&
            element !== document.body &&
            element !== document.documentElement,
        )
        .sort((a, b) => rank(a.marker) - rank(b.marker));
      // The nearest selected ancestor speaks for the click.
      const nearest = ancestors.find(
        ({ element }) =>
          !ancestors.some(
            (other) =>
              other.element !== element && element.contains(other.element),
          ),
      );
      if (nearest === undefined) return undefined;
      const ancestor = nearest.element;
      // A wrapper that holds only the clicked element (`<li class=active><a>`)
      // is its route marker, not a separate block.
      const holdsOthers = [
        ...ancestor.querySelectorAll("a[href], button, [role=button], input"),
      ].some(
        (other) =>
          other !== target &&
          !target.contains(other) &&
          !other.contains(target) &&
          visible(other),
      );
      if (!holdsOthers && area(ancestor) < 2 * area(target)) return undefined;
      const pathFor = (element: Element): string => {
        const parts: string[] = [];
        let current: Element | null = element;
        while (current !== null && current !== document.documentElement) {
          const parent: Element | null = current.parentElement;
          const tag = current.tagName.toLowerCase();
          if (parent === null) {
            parts.unshift(tag);
            break;
          }
          const index =
            [...parent.children]
              .filter((child) => child.tagName === current?.tagName)
              .indexOf(current) + 1;
          parts.unshift(`${tag}:nth-of-type(${index})`);
          current = parent;
        }
        return `html > ${parts.join(" > ")}`;
      };
      const generatedId = /^[:_«]r|^radix-|^headlessui-|\d{3,}/;
      const label = normalized(
        ancestor.getAttribute("aria-label") ||
          (ancestor.getAttribute("aria-labelledby") ?? "")
            .split(/\s+/)
            .map((id) => document.getElementById(id)?.textContent ?? "")
            .join(" "),
      );
      const tag = ancestor.tagName.toLowerCase();
      const ancestorRole = ancestor
        .getAttribute("role")
        ?.trim()
        .split(/\s+/)[0];
      return {
        ancestor:
          ancestor.id !== "" && !generatedId.test(ancestor.id)
            ? `#${CSS.escape(ancestor.id)}`
            : pathFor(ancestor),
        ancestorName: (
          label || (ancestorRole ? `${ancestorRole} ${tag}` : tag)
        ).slice(0, 60),
        marker: nearest.marker,
        affordance,
      };
    },
    { path, name },
  );
}

type SelectionCandidate = {
  path: string;
  selector: string;
  name: string;
  affordance: "button" | "link" | "pointer";
  /** Same as `enumerate`'s: already selected or a drag handle, when opted in. */
  intentReason?: string | undefined;
};

/**
 * Links and look-alike controls the main pass never clicks, each inside a
 * selectable container (a block an editor canvas can select), in document
 * order. Innermost first: a candidate holding another is dropped.
 */
async function selectionCandidates(
  page: Page,
  skip: string[],
  already: string[],
  respectControlIntent: boolean,
): Promise<SelectionCandidate[]> {
  return await page.evaluate(
    ({ skipSelectors, already, respectControlIntent }) => {
      const pathFor = (element: Element): string => {
        const parts: string[] = [];
        let current: Element | null = element;
        while (current !== null && current !== document.documentElement) {
          const parent: Element | null = current.parentElement;
          const tag = current.tagName.toLowerCase();
          if (parent === null) {
            parts.unshift(tag);
            break;
          }
          const index =
            [...parent.children]
              .filter((child) => child.tagName === current?.tagName)
              .indexOf(current) + 1;
          parts.unshift(`${tag}:nth-of-type(${index})`);
          current = parent;
        }
        return `html > ${parts.join(" > ")}`;
      };
      const visible = (element: Element) => {
        if (!element.checkVisibility()) return false;
        const rect = element.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return false;
        let current: Element | null = element;
        while (current !== null) {
          const style = getComputedStyle(current);
          if (
            style.display === "none" ||
            style.visibility === "hidden" ||
            Number(style.opacity) <= 0
          )
            return false;
          current = current.parentElement;
        }
        return true;
      };
      const nameOf = (element: Element) =>
        (
          (element.getAttribute("aria-labelledby") ?? "")
            .split(/\s+/)
            .map((id) => document.getElementById(id)?.textContent ?? "")
            .join(" ")
            .trim() ||
          element.getAttribute("aria-label") ||
          (element as HTMLElement).innerText ||
          (element instanceof HTMLInputElement ? element.value : "") ||
          element.getAttribute("title") ||
          ""
        )
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 120);
      const alpha = (color: string) => {
        if (color === "transparent") return 0;
        const slash = color.match(/\/\s*([\d.]+%?)\s*\)$/);
        if (slash?.[1] !== undefined)
          return slash[1].endsWith("%")
            ? Number.parseFloat(slash[1]) / 100
            : Number.parseFloat(slash[1]);
        const rgba = color.match(/^rgba\((.*)\)$/);
        if (rgba?.[1] !== undefined)
          return Number.parseFloat(rgba[1].split(",").at(-1) ?? "1");
        return 1;
      };
      // Must match `enumerate`: these are the main pass's clicks.
      const controlSelector =
        "button, summary, [role=button], [role=menuitem], [role=menuitemradio], [role=menuitemcheckbox], input[type=button], input[type=submit], [aria-haspopup]:not([aria-haspopup=false]):not(input, textarea, select, [contenteditable]), [aria-expanded]:not(input, textarea, select, [contenteditable])";
      const area = (element: Element) => {
        const rect = element.getBoundingClientRect();
        return rect.width * rect.height;
      };
      const pointerOrigin = (element: Element, cursors: string[]) =>
        cursors.includes(getComputedStyle(element).cursor) &&
        (element.parentElement === null ||
          getComputedStyle(element.parentElement).cursor !==
            getComputedStyle(element).cursor);
      const buttonLook = (element: Element) => {
        const style = getComputedStyle(element);
        const parentStyle =
          element.parentElement === null
            ? undefined
            : getComputedStyle(element.parentElement);
        const ownFill =
          alpha(style.backgroundColor) > 0 &&
          style.backgroundColor !== parentStyle?.backgroundColor;
        const framed = (["Top", "Right", "Bottom", "Left"] as const).every(
          (side) =>
            (Number.parseFloat(style[`border${side}Width`]) || 0) >= 1 &&
            !["none", "hidden"].includes(style[`border${side}Style`]) &&
            alpha(style[`border${side}Color`]) > 0,
        );
        return ownFill || framed;
      };
      const directText = (element: Element) =>
        [...element.childNodes]
          .filter((node) => node.nodeType === Node.TEXT_NODE)
          .map((node) => node.textContent ?? "")
          .join("")
          .replace(/\s+/g, " ")
          .trim();
      const lookAlike = (element: Element) => {
        const text = directText(element);
        return (
          text.length >= 1 &&
          text.length <= 40 &&
          element.getBoundingClientRect().height <= 64 &&
          buttonLook(element)
        );
      };
      const affordanceOf = (element: Element) => {
        const style = getComputedStyle(element);
        const parentStyle =
          element.parentElement === null
            ? undefined
            : getComputedStyle(element.parentElement);
        if (buttonLook(element)) return "button" as const;
        if (
          element.matches("a[href]") ||
          style.textDecorationLine.includes("underline") ||
          (parentStyle !== undefined &&
            style.color !== parentStyle.color &&
            alpha(style.backgroundColor) === 0)
        )
          return "link" as const;
        return "pointer" as const;
      };
      const selectable = (element: Element) =>
        (element.matches("[tabindex]") &&
          !element.matches(
            "a[href], button, input, select, textarea, summary",
          )) ||
        element.matches(
          "[aria-selected], [data-selected], [data-active], [data-state], [draggable=true], [role=option], [role=gridcell], [role=treeitem], [role=row]",
        ) ||
        pointerOrigin(element, ["pointer", "move", "grab"]);
      const container = (element: Element) => {
        let current = element.parentElement;
        for (let depth = 0; current !== null && depth < 8; depth += 1) {
          if (current === document.body || current === document.documentElement)
            return false;
          if (area(current) > area(element) && selectable(current)) return true;
          current = current.parentElement;
        }
        return false;
      };
      const skipped = (element: Element) =>
        skipSelectors.some((selector) => {
          try {
            return element.closest(selector) !== null;
          } catch {
            return false;
          }
        });
      // Must match `enumerate`'s intentReason.
      const intentReason = (element: Element): string | undefined => {
        if (!respectControlIntent) return undefined;
        for (const attribute of [
          "aria-pressed",
          "aria-selected",
          "aria-checked",
        ])
          if (element.getAttribute(attribute) === "true")
            return `already selected: ${attribute}`;
        const current = element.getAttribute("aria-current")?.trim();
        if (current && current !== "false")
          return "already selected: aria-current";
        if (element.getAttribute("draggable")?.toLowerCase() === "true")
          return "drag handle: draggable";
        if (/drag/i.test(element.getAttribute("aria-roledescription") ?? ""))
          return "drag handle: aria-roledescription";
        if (/\b(move|drag|reorder)\b/i.test(nameOf(element)))
          return "drag handle: name";
        return undefined;
      };
      const done = new Set(already);
      const found: Element[] = [];
      for (const element of document.body?.querySelectorAll("*") ?? []) {
        if (element.closest(controlSelector) !== null) continue;
        const link = element.closest("a[href]");
        if (link !== null && link !== element) continue;
        if (
          !(
            element.matches("a[href]") ||
            pointerOrigin(element, ["pointer"]) ||
            lookAlike(element)
          )
        )
          continue;
        if (!visible(element) || skipped(element) || !container(element))
          continue;
        found.push(element);
      }
      return found
        .filter(
          (element) =>
            !found.some(
              (other) => other !== element && element.contains(other),
            ),
        )
        .map((element) => ({ element, path: pathFor(element) }))
        .filter(({ path }) => !done.has(path))
        .map(({ element, path }) => {
          const reason = intentReason(element);
          return {
            path,
            selector: element.id ? `#${CSS.escape(element.id)}` : path,
            name: nameOf(element),
            affordance: affordanceOf(element),
            ...(reason ? { intentReason: reason } : {}),
          };
        });
    },
    { skipSelectors: skip, already, respectControlIntent },
  );
}

/**
 * Click one selection candidate with link navigation suppressed. A
 * window-level bubble listener cancels a link's default action after every
 * page handler ran, so the app sees an ordinary click and the page stays.
 * No motion or timeline evidence is recorded.
 */
async function selectionTrial(
  page: Page,
  candidate: SelectionCandidate,
  waitMs: number,
  respectControlIntent: boolean,
): Promise<SelectionTrial> {
  const base = {
    selector: candidate.selector,
    name: candidate.name,
    affordance: candidate.affordance,
  };
  const before = page.url();
  let popups = 0;
  const onPopup = () => {
    popups += 1;
  };
  page.on("popup", onPopup);
  try {
    await installInstrumentation(page, respectControlIntent);
    await page.evaluate(() => {
      const scope = window as unknown as {
        __idiomLinkGuard?: (event: Event) => void;
      };
      if (scope.__idiomLinkGuard)
        window.removeEventListener("click", scope.__idiomLinkGuard);
      scope.__idiomLinkGuard = (event: Event) => {
        if (
          event.target instanceof Element &&
          event.target.closest("a[href]") !== null
        )
          event.preventDefault();
      };
      window.addEventListener("click", scope.__idiomLinkGuard);
    });
    const effectWindow = await beginEffectWindow(page, waitMs);
    try {
      try {
        await page
          .locator(candidate.path)
          .first()
          .click({ timeout: 1500, noWaitAfter: true });
      } catch (error) {
        return {
          ...base,
          status: "skipped",
          skipped: `not clickable: ${(error instanceof Error ? error.message : String(error)).split("\n")[0] ?? ""}`,
          effects: [],
        };
      }
      await effectWindow.wait();
    } finally {
      await effectWindow.dispose();
    }
    const effects = new Set<ProbeEffect>();
    if (page.url() !== before) effects.add("navigation");
    const counters = await readCounters(page).catch(() => undefined);
    if (counters === undefined || counters.mutations > 0) effects.add("dom");
    if ((counters?.aria ?? 0) > 0) effects.add("aria");
    if ((counters?.popups ?? 0) > 0 || popups > 0) effects.add("popup");
    const selectsAncestor =
      !effects.has("navigation") && !effects.has("popup")
        ? await ancestorSelection(page, candidate.path, candidate.name).catch(
            () => undefined,
          )
        : undefined;
    return {
      ...base,
      status: "completed",
      effects: [...effects],
      ...(selectsAncestor === undefined ? {} : { selectsAncestor }),
    };
  } finally {
    page.off("popup", onPopup);
    await page
      .evaluate(() => {
        const scope = window as unknown as {
          __idiomLinkGuard?: (event: Event) => void;
        };
        if (scope.__idiomLinkGuard)
          window.removeEventListener("click", scope.__idiomLinkGuard);
        delete scope.__idiomLinkGuard;
      })
      .catch(() => undefined);
    await cleanupInstrumentation(page);
  }
}

/** Visible named regions: what a click "opens" is the set that changes. */
async function snapshot(page: Page): Promise<Snapshot> {
  const regions = await page.evaluate(() => {
    const visible = (element: Element) => {
      const rect = element.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return false;
      const style = getComputedStyle(element);
      return (
        style.visibility !== "hidden" &&
        style.display !== "none" &&
        Number(style.opacity) > 0
      );
    };
    const text = (id: string | null) =>
      id === null
        ? ""
        : id
            .split(/\s+/)
            .map((part) => document.getElementById(part)?.textContent ?? "")
            .join(" ")
            .replace(/\s+/g, " ")
            .trim();
    const regions = document.querySelectorAll(
      "dialog[open], [role=dialog], [role=alertdialog], [role=menu], [role=listbox], [role=region], [role=tabpanel], aside, [aria-modal=true], [popover]",
    );
    const names: Array<{ name: string; selector: string }> = [];
    for (const region of regions) {
      if (!visible(region)) continue;
      const role = region.getAttribute("role") ?? region.tagName.toLowerCase();
      const heading = region.querySelector("h1, h2, h3, h4, [role=heading]");
      const name =
        region.getAttribute("aria-label") ??
        (text(region.getAttribute("aria-labelledby")) ||
          (heading?.textContent ?? "").replace(/\s+/g, " ").trim());
      const parts: string[] = [];
      for (
        let current: Element | null = region;
        current && current !== document.documentElement;
        current = current.parentElement
      ) {
        const tag = current.tagName.toLowerCase();
        const peers: Element[] = [
          ...(current.parentElement?.children ?? []),
        ].filter((element) => element.tagName === current?.tagName);
        parts.unshift(`${tag}:nth-of-type(${peers.indexOf(current) + 1})`);
      }
      names.push({
        name: `${role}:${name.slice(0, 80)}`,
        selector: `html > ${parts.join(" > ")}`,
      });
    }
    return names;
  });
  return {
    url: page.url(),
    revealed: regions.map((region) => region.name).sort(),
    regions,
  };
}

/**
 * A cheap summary of everything a click could leave behind: URL, scroll,
 * revealed regions, element count, text, attributes (including `class`
 * and `data-*`), form values, and which elements render. Hover tooltips are left
 * out. Equal fingerprints mean the next control can run without a replay.
 */
export async function stateFingerprint(page: Page): Promise<string> {
  const revealed = (await snapshot(page)).revealed;
  const summary = await page.evaluate(() => {
    const roots = "[role=tooltip], [data-radix-popper-content-wrapper]";
    const hash = () => {
      let value = 0x811c9dc5;
      return {
        add(text: string) {
          for (let index = 0; index < text.length; index += 1) {
            value ^= text.charCodeAt(index);
            value = Math.imul(value, 16777619);
          }
          value ^= 0x1f;
          value = Math.imul(value, 16777619);
        },
        get: () => (value >>> 0).toString(36),
      };
    };
    const text = hash();
    const attributes = hash();
    const visibility = hash();
    let shown = 0;
    const all = document.querySelectorAll("*");
    // Every attribute counts except inline style (animation frames; the
    // visibility signature covers what it reveals) and the pointer/focus
    // markers the instrumentation also ignores.
    const transient =
      /^(?:style|tabindex|data-(?:focus|hover|press|active|focus-visible)[\w-]*)$/;
    let index = 0;
    for (const element of all) {
      if (element.closest(roots) !== null) continue;
      index += 1;
      attributes.add(`${index}:${element.tagName}`);
      for (const attribute of element.attributes) {
        if (transient.test(attribute.name)) continue;
        // `class=""` left by a removed class equals no class at all.
        const value =
          attribute.name === "class"
            ? [...element.classList].sort().join(" ")
            : attribute.value;
        if (attribute.name !== "class" || value !== "")
          attributes.add(`${attribute.name}=${value}`);
      }
      if (
        element instanceof HTMLInputElement ||
        element instanceof HTMLTextAreaElement ||
        element instanceof HTMLSelectElement
      ) {
        attributes.add(`value=${element.value}`);
        if (element instanceof HTMLInputElement)
          attributes.add(`checked=${element.checked}`);
      }
      const rendered =
        typeof element.checkVisibility === "function"
          ? element.checkVisibility({
              checkOpacity: true,
              checkVisibilityCSS: true,
            })
          : true;
      if (rendered) {
        const rect = element.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          shown += 1;
          visibility.add(`${index}`);
        }
      }
    }
    if (document.body !== null) {
      const walker = document.createTreeWalker(
        document.body,
        NodeFilter.SHOW_TEXT,
      );
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (node.parentElement?.closest(roots)) continue;
        const value = node.nodeValue?.trim() ?? "";
        if (value !== "") text.add(value);
      }
    }
    return [
      Math.round(window.scrollX),
      Math.round(window.scrollY),
      index,
      text.get(),
      attributes.get(),
      shown,
      visibility.get(),
    ].join(":");
  });
  return JSON.stringify([page.url(), revealed, summary]);
}

/** A visible close control in a region the baseline did not show. */
async function closeControl(
  page: Page,
  baseline: string[],
): Promise<string | undefined> {
  return await page.evaluate(
    ({ baseline, destructiveSource }) => {
      const destructive = new RegExp(destructiveSource, "i");
      const close = /^(?:(?:close|cancel|done|dismiss)\b|[×✕]\s*$)/i;
      const visible = (element: Element) => {
        const rect = element.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return false;
        const style = getComputedStyle(element);
        return (
          style.visibility !== "hidden" &&
          style.display !== "none" &&
          Number(style.opacity) > 0
        );
      };
      const text = (id: string | null) =>
        id === null
          ? ""
          : id
              .split(/\s+/)
              .map((part) => document.getElementById(part)?.textContent ?? "")
              .join(" ")
              .replace(/\s+/g, " ")
              .trim();
      const pathFor = (element: Element): string => {
        const parts: string[] = [];
        let current: Element | null = element;
        while (current !== null && current !== document.documentElement) {
          const node: Element = current;
          const siblings = [...(node.parentElement?.children ?? [])].filter(
            (child) => child.tagName === node.tagName,
          );
          parts.unshift(
            `${node.tagName.toLowerCase()}:nth-of-type(${siblings.indexOf(node) + 1})`,
          );
          current = node.parentElement;
        }
        return `html > ${parts.join(" > ")}`;
      };
      for (const region of document.querySelectorAll(
        "dialog[open], [role=dialog], [role=alertdialog], [role=menu], [role=listbox], [role=region], aside, [aria-modal=true], [popover]",
      )) {
        if (!visible(region)) continue;
        const role =
          region.getAttribute("role") ?? region.tagName.toLowerCase();
        const heading = region.querySelector("h1, h2, h3, h4, [role=heading]");
        const name =
          region.getAttribute("aria-label") ??
          (text(region.getAttribute("aria-labelledby")) ||
            (heading?.textContent ?? "").replace(/\s+/g, " ").trim());
        if (baseline.includes(`${role}:${name.slice(0, 80)}`)) continue;
        for (const control of region.querySelectorAll(
          "button, [role=button], input[type=button]",
        )) {
          if (!visible(control)) continue;
          const label = (
            control.getAttribute("aria-label") ||
            (control as HTMLElement).innerText ||
            control.getAttribute("title") ||
            (control as HTMLInputElement).value ||
            ""
          )
            .replace(/\s+/g, " ")
            .trim();
          if (close.test(label) && !destructive.test(label))
            return pathFor(control);
        }
      }
      return undefined;
    },
    { baseline, destructiveSource: destructive.source },
  );
}

async function enumerate(
  page: Page,
  skip: string[],
  root?: string,
  respectControlIntent = false,
): Promise<Candidate[]> {
  return await page.evaluate(
    ({ skipSelectors, rootSelector, respectControlIntent }) => {
      const pathFor = (element: Element): string => {
        const parts: string[] = [];
        let current: Element | null = element;
        while (current !== null && current !== document.documentElement) {
          const parent: Element | null = current.parentElement;
          const tag = current.tagName.toLowerCase();
          if (parent === null) {
            parts.unshift(tag);
            break;
          }
          const index =
            [...parent.children]
              .filter((child) => child.tagName === current?.tagName)
              .indexOf(current) + 1;
          parts.unshift(`${tag}:nth-of-type(${index})`);
          current = parent;
        }
        return `html > ${parts.join(" > ")}`;
      };
      const visible = (element: Element) => {
        // Closed details can leave non-zero layout boxes on their descendants.
        // They are revealed controls, not work in the state's initial surface.
        if (!element.checkVisibility()) return false;
        const rect = element.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return false;
        let current: Element | null = element;
        while (current !== null) {
          const style = getComputedStyle(current);
          if (
            style.display === "none" ||
            style.visibility === "hidden" ||
            Number(style.opacity) <= 0
          )
            return false;
          current = current.parentElement;
        }
        return true;
      };
      const scopes =
        rootSelector === undefined
          ? [document]
          : [...document.querySelectorAll(rootSelector)];
      // Disclosures (popup triggers and expanders) are controls whatever
      // their element; text entry is left to its own role.
      const controlSelector =
        "button, summary, [role=button], [role=menuitem], [role=menuitemradio], [role=menuitemcheckbox], input[type=button], input[type=submit], [aria-haspopup]:not([aria-haspopup=false]):not(input, textarea, select, [contenteditable]), [aria-expanded]:not(input, textarea, select, [contenteditable])";
      const selectedSelector =
        "input[type=radio]:checked, [role=tab][aria-selected=true], [role=radio][aria-checked=true]";
      const controls = new Set(
        scopes.flatMap((scope) => [
          ...scope.querySelectorAll(
            respectControlIntent
              ? `${controlSelector}, ${selectedSelector}`
              : controlSelector,
          ),
        ]),
      );
      const nameOf = (element: Element) =>
        (
          (element.getAttribute("aria-labelledby") ?? "")
            .split(/\s+/)
            .map((id) => document.getElementById(id)?.textContent ?? "")
            .join(" ")
            .trim() ||
          element.getAttribute("aria-label") ||
          (element as HTMLElement).innerText ||
          (element instanceof HTMLInputElement ? element.value : "") ||
          element.getAttribute("title") ||
          ""
        )
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 120);
      const implicitRoles: Record<string, string> = {
        header: "banner",
        nav: "navigation",
        main: "main",
        aside: "complementary",
        footer: "contentinfo",
        section: "region",
        dialog: "dialog",
        form: "form",
      };
      const regionOf = (control: Element): string | undefined => {
        const region = control.parentElement?.closest(
          "header, nav, main, aside, footer, dialog, section[aria-label], section[aria-labelledby], form[aria-label], [role=banner], [role=navigation], [role=main], [role=complementary], [role=contentinfo], [role=region], [role=toolbar], [role=menu], [role=menubar], [role=dialog], [role=alertdialog], [role=tablist], [role=search], [role=form]",
        );
        if (region === null || region === undefined) return undefined;
        const role =
          region.getAttribute("role") ??
          implicitRoles[region.tagName.toLowerCase()] ??
          region.tagName.toLowerCase();
        const labelledBy = region.getAttribute("aria-labelledby");
        const label = (
          region.getAttribute("aria-label") ??
          (labelledBy === null
            ? ""
            : labelledBy
                .split(/\s+/)
                .map((id) => document.getElementById(id)?.textContent ?? "")
                .join(" "))
        )
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 60);
        return label === "" ? role : `${role} "${label}"`;
      };
      const result: Array<{
        path: string;
        selector: string;
        name: string;
        repeated: boolean;
        region?: string;
        role: string;
        signature: string;
        repeatedGroup?: string;
        textLabel: boolean;
        submit: boolean;
        modal: boolean;
        popup?: boolean;
        disclosure?: "details" | "popup" | "expanded";
        controls?: string;
        unavailable?: string;
        intentReason?: string;
      }> = [];
      const roleOf = (control: Element): string => {
        const explicit = control.getAttribute("role")?.trim().split(/\s+/)[0];
        if (explicit) return explicit;
        const tag = control.tagName.toLowerCase();
        if (tag === "input") {
          const type = (control as HTMLInputElement).type;
          return type === "radio" || type === "checkbox" ? type : "button";
        }
        return tag === "summary" ? "button" : tag;
      };
      const classes = (element: Element) =>
        `${element.tagName.toLowerCase()}.${[...element.classList].sort().join(".")}`;
      // Framework-generated ids change between renders, so they never identify.
      const generatedId = /^[:_«]r|^radix-|^headlessui-|\d{3,}/;
      const identitySignature = (control: Element): string =>
        control.id && !generatedId.test(control.id)
          ? `#${control.id}`
          : `${classes(control)}>${control.parentElement ? classes(control.parentElement) : ""}`;
      const intentReason = (control: Element): string | undefined => {
        if (!respectControlIntent) return undefined;
        for (const attribute of [
          "aria-pressed",
          "aria-selected",
          "aria-checked",
        ])
          if (control.getAttribute(attribute) === "true")
            return `already selected: ${attribute}`;
        const current = control.getAttribute("aria-current")?.trim();
        if (current && current !== "false")
          return "already selected: aria-current";
        if (
          control instanceof HTMLInputElement &&
          control.type === "radio" &&
          control.checked
        )
          return "already selected: checked radio";
        if (control.getAttribute("draggable")?.toLowerCase() === "true")
          return "drag handle: draggable";
        if (/drag/i.test(control.getAttribute("aria-roledescription") ?? ""))
          return "drag handle: aria-roledescription";
        if (/\b(move|drag|reorder)\b/i.test(nameOf(control)))
          return "drag handle: name";
        return undefined;
      };
      const modal = [...document.querySelectorAll("dialog, [aria-modal=true]")]
        .filter((element) =>
          element.matches("dialog")
            ? element.matches(":modal")
            : visible(element),
        )
        .at(-1);
      for (const control of controls) {
        if (!visible(control)) continue;
        const html = control as HTMLButtonElement;
        if (html.disabled || control.getAttribute("aria-disabled") === "true")
          continue;
        if (control.closest("a[href]") !== null) continue;
        if (
          skipSelectors.some((selector) => {
            try {
              return control.closest(selector) !== null;
            } catch {
              return false;
            }
          })
        )
          continue;
        const name = nameOf(control);
        const signatureOf = (element: Element) =>
          `${element.tagName}|${[...element.classList].sort().join(".")}`;
        // A wrapper that holds nothing but this control (a tooltip span).
        const transparent = (element: Element) =>
          element === control ||
          ([...element.querySelectorAll(controlSelector)].every(
            (inner) => inner === control,
          ) &&
            (element as HTMLElement).innerText.trim() ===
              html.innerText.trim());
        const controlIn = (element: Element) =>
          element.matches(controlSelector)
            ? element
            : element.querySelector(controlSelector);
        let repeated = false;
        let repeatedGroup: string | undefined;
        let current: Element | null = control;
        for (
          let depth = 0;
          current !== null && depth < 5 && !repeated;
          depth += 1
        ) {
          const parent: Element | null = current.parentElement;
          if (parent === null) break;
          const signature = signatureOf(current);
          const alike = [...parent.children].filter(
            (child) => signatureOf(child) === signature,
          );
          if (alike.length >= 3) {
            // Look-alike controls in a toolbar (Undo, Redo, a gear) are a
            // repeated list only when they repeat the same action. Anywhere
            // else, look-alikes are rows, even bare buttons in a layer list.
            const toolbar =
              parent.closest(
                "header, nav, footer, [role=toolbar], [role=menubar], [role=navigation], [role=banner], [role=contentinfo]",
              ) !== null ||
              (control.getAttribute("role") === "menuitem" &&
                parent.closest("[role=menu]") !== null);
            repeated =
              toolbar && transparent(current)
                ? alike.filter((member) => {
                    const inner = controlIn(member);
                    return inner !== null && nameOf(inner) === name;
                  }).length >= 3
                : true;
          }
          if (repeated)
            repeatedGroup = `${regionOf(control) ?? "document"}|${classes(parent)}>${signature}|${classes(control)}|${roleOf(control)}`;
          current = parent;
        }
        const region = regionOf(control);
        const reason = intentReason(control);
        const haspopup = control.getAttribute("aria-haspopup");
        const popup = haspopup !== null && haspopup !== "false";
        const disclosure =
          control.tagName.toLowerCase() === "summary" &&
          control.parentElement instanceof HTMLDetailsElement
            ? ("details" as const)
            : popup
              ? ("popup" as const)
              : control.hasAttribute("aria-expanded")
                ? ("expanded" as const)
                : undefined;
        const controls = control.getAttribute("aria-controls")?.trim();
        result.push({
          ...(disclosure === undefined ? {} : { disclosure }),
          ...(controls ? { controls } : {}),
          repeated,
          ...(repeatedGroup ? { repeatedGroup } : {}),
          textLabel: /\p{L}{2}/u.test(html.innerText ?? ""),
          modal: modal !== undefined,
          ...(popup ? { popup: true } : {}),
          submit:
            control instanceof HTMLButtonElement
              ? control.type === "submit" && control.form !== null
              : control instanceof HTMLInputElement &&
                control.type === "submit",
          role: roleOf(control),
          signature: identitySignature(control),
          path: pathFor(control),
          selector: control.id
            ? `#${CSS.escape(control.id)}`
            : pathFor(control),
          name,
          ...(reason ? { intentReason: reason } : {}),
          ...(modal && !modal.contains(control)
            ? { unavailable: "blocked by modal" }
            : {}),
          ...(region === undefined ? {} : { region }),
        });
      }
      return result;
    },
    { skipSelectors: skip, rootSelector: root, respectControlIntent },
  );
}

/** Probe paths of visible positioned elements: what a disclosure may reveal. */
async function positionedPaths(page: Page): Promise<string[]> {
  return await page.evaluate(() => {
    const paths: string[] = [];
    for (const element of document.body?.querySelectorAll("*") ?? []) {
      const style = getComputedStyle(element);
      if (!["absolute", "fixed"].includes(style.position)) continue;
      if (!element.checkVisibility({ checkOpacity: true })) continue;
      const rect = element.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) continue;
      const parts: string[] = [];
      for (
        let current: Element | null = element;
        current !== null && current !== document.documentElement;
        current = current.parentElement
      ) {
        const parent: Element | null = current.parentElement;
        const tag = current.tagName.toLowerCase();
        if (parent === null) {
          parts.unshift(tag);
          break;
        }
        const index =
          [...parent.children]
            .filter((child) => child.tagName === current?.tagName)
            .indexOf(current) + 1;
        parts.unshift(`${tag}:nth-of-type(${index})`);
      }
      paths.push(`html > ${parts.join(" > ")}`);
    }
    return paths;
  });
}

/**
 * What a disclosure click revealed: its `aria-controls` target, its open
 * `details`, a region the click opened, or the nearest newly visible
 * positioned element near the trigger. `opened` is false when nothing
 * opened and no open state flipped.
 */
async function openedDisclosureGeometry(
  page: Page,
  path: string,
  root: string | undefined,
  kind: "details" | "popup" | "expanded",
): Promise<ProbeResult["openedDisclosure"]> {
  if (root === undefined) return undefined;
  return await page.evaluate(
    ({ path, root, kind }) => {
      const trigger = document.querySelector(path);
      const panel = document.querySelector(root);
      if (
        !trigger ||
        !panel?.checkVisibility({
          checkOpacity: true,
          checkVisibilityCSS: true,
        })
      )
        return undefined;
      const rect = (element: Element) => {
        const r = element.getBoundingClientRect();
        return {
          x: r.x + scrollX,
          y: r.y + scrollY,
          width: r.width,
          height: r.height,
        };
      };
      const panelRect = rect(panel);
      if (panelRect.width <= 0 || panelRect.height <= 0) return undefined;
      return { root, kind, trigger: rect(trigger), panel: panelRect };
    },
    { path, root, kind },
  );
}

async function disclosureRoot(
  page: Page,
  candidate: Candidate,
  before: string[],
  openedRoots: string[],
): Promise<{ opened: boolean; root?: string | undefined }> {
  return await page.evaluate(
    ({ path, controls, before, openedRoots }) => {
      const pathFor = (element: Element): string => {
        const parts: string[] = [];
        let current: Element | null = element;
        while (current !== null && current !== document.documentElement) {
          const parent: Element | null = current.parentElement;
          const tag = current.tagName.toLowerCase();
          if (parent === null) {
            parts.unshift(tag);
            break;
          }
          const index =
            [...parent.children]
              .filter((child) => child.tagName === current?.tagName)
              .indexOf(current) + 1;
          parts.unshift(`${tag}:nth-of-type(${index})`);
          current = parent;
        }
        return `html > ${parts.join(" > ")}`;
      };
      const visible = (element: Element) => {
        if (!element.checkVisibility({ checkOpacity: true })) return false;
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      };
      const trigger = document.querySelector(path);
      if (trigger === null) return { opened: false };
      const details =
        trigger.tagName.toLowerCase() === "summary" &&
        trigger.parentElement instanceof HTMLDetailsElement
          ? trigger.parentElement
          : undefined;
      const flipped =
        details?.open === true ||
        trigger.getAttribute("aria-expanded") === "true";
      for (const id of (controls ?? "").split(/\s+/)) {
        const target = id === "" ? null : document.getElementById(id);
        if (target !== null && visible(target))
          return { opened: true, root: pathFor(target) };
      }
      if (details?.open === true)
        return { opened: true, root: pathFor(details) };
      const region = openedRoots[0];
      if (region !== undefined) return { opened: true, root: region };
      const earlier = new Set(before);
      let scope: Element | null = trigger.parentElement;
      for (let depth = 0; scope !== null && depth < 3; depth += 1) {
        const fresh = [...scope.querySelectorAll("*")].filter(
          (element) =>
            !element.contains(trigger) &&
            ["absolute", "fixed"].includes(
              getComputedStyle(element).position,
            ) &&
            visible(element) &&
            !earlier.has(pathFor(element)),
        );
        const outermost = fresh.find(
          (element) =>
            !fresh.some(
              (other) => other !== element && other.contains(element),
            ),
        );
        if (outermost !== undefined)
          return { opened: true, root: pathFor(outermost) };
        scope = scope.parentElement;
      }
      return { opened: flipped };
    },
    {
      path: candidate.path,
      controls: candidate.controls,
      before,
      openedRoots,
    },
  );
}

/**
 * The first opened region that is a dialog, alert dialog, modal or open
 * popover: what a plain button opens that the dismissal probe tests.
 */
async function dialogRoot(
  page: Page,
  openedRoots: string[],
): Promise<string | undefined> {
  if (openedRoots.length === 0) return undefined;
  return await page.evaluate(
    (roots) =>
      roots.find((root) => {
        const region = document.querySelector(root);
        if (region === null) return false;
        return (
          (region instanceof HTMLDialogElement && region.open) ||
          region.matches(":popover-open") ||
          ["dialog", "alertdialog"].includes(
            region.getAttribute("role") ?? "",
          ) ||
          region.getAttribute("aria-modal") === "true"
        );
      }),
    openedRoots,
  );
}

/** Probe paths of visible text-entry fields, to see a mode switch add one. */
async function visibleFields(page: Page): Promise<string[]> {
  return await page.evaluate(() => {
    const pathFor = (element: Element): string => {
      const parts: string[] = [];
      let current: Element | null = element;
      while (current !== null && current !== document.documentElement) {
        const parent: Element | null = current.parentElement;
        const tag = current.tagName.toLowerCase();
        if (parent === null) {
          parts.unshift(tag);
          break;
        }
        const index =
          [...parent.children]
            .filter((child) => child.tagName === current?.tagName)
            .indexOf(current) + 1;
        parts.unshift(`${tag}:nth-of-type(${index})`);
        current = parent;
      }
      return `html > ${parts.join(" > ")}`;
    };
    return [
      ...document.querySelectorAll(
        "input:not([type=hidden]), textarea, select, [contenteditable=true]",
      ),
    ]
      .filter((element) => {
        if (!element.checkVisibility({ checkOpacity: true })) return false;
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      })
      .map(pathFor);
  });
}

/**
 * Why a control should not be clicked. Selection (an already-selected tab,
 * option, radio or current item, whose click is a no-op by design) always
 * applies; `selectionOnly` leaves out the opt-in `respectControlIntent`
 * reasons (pressed toggles, drag handles, other aria-checked/selected).
 * Switches and checkboxes toggle on click, so they are never selection.
 */
async function intentSkip(
  page: Page,
  candidate: Candidate,
  { selectionOnly = false }: { selectionOnly?: boolean } = {},
): Promise<string | undefined> {
  return (
    page
      .locator(candidate.path)
      .first()
      .evaluate(
        (control, selectionOnly) => {
          const selected = (selector: string, attribute: string) =>
            control.closest(selector)?.getAttribute(attribute) === "true";
          if (selected("[role=tab], [role=option]", "aria-selected"))
            return "already selected: aria-selected";
          if (selected("[role=radio], [role=menuitemradio]", "aria-checked"))
            return "already selected: aria-checked";
          const current = control.getAttribute("aria-current")?.trim();
          if (current && current !== "false")
            return "already selected: aria-current";
          // A radio, or the label for or wrapping one.
          const radio =
            control instanceof HTMLInputElement
              ? control
              : control.closest("label")?.control;
          if (
            radio instanceof HTMLInputElement &&
            radio.type === "radio" &&
            radio.checked
          )
            return "already selected: checked radio";
          if (control instanceof HTMLOptionElement && control.selected)
            return "already selected: checked option";
          if (selectionOnly) return undefined;
          for (const attribute of [
            "aria-pressed",
            "aria-selected",
            "aria-checked",
          ]) {
            if (control.getAttribute(attribute) === "true")
              return `already selected: ${attribute}`;
          }
          if (control.getAttribute("draggable")?.toLowerCase() === "true")
            return "drag handle: draggable";
          if (/drag/i.test(control.getAttribute("aria-roledescription") ?? ""))
            return "drag handle: aria-roledescription";
          const name = (
            control.getAttribute("aria-label") ??
            ((control as HTMLElement).innerText ||
              control.getAttribute("title") ||
              "")
          )
            .replace(/\s+/g, " ")
            .trim();
          if (/\b(move|drag|reorder)\b/i.test(name)) return "drag handle: name";
          return undefined;
        },
        selectionOnly,
        { timeout: 1500 },
      )
      // A control missing after restore falls through to clickAndObserve, which
      // records it as not clickable instead of stalling the whole probe.
      .catch(() => undefined)
  );
}

function skippedResult(
  candidate: Candidate,
  reason: string,
  parent?: string,
): ProbeResult {
  return {
    selector: candidate.selector,
    name:
      parent === undefined ? candidate.name : `${parent} › ${candidate.name}`,
    effects: [],
    persistent: parent === undefined,
    ...(candidate.repeated ? { repeated: true } : {}),
    ...(candidate.region === undefined ? {} : { region: candidate.region }),
    skipped: reason,
  };
}

/**
 * Click once more inside a timeline-only window tagged `confirmation`.
 * Touches no motion evidence, effects, counters or result signature.
 */
async function confirmClick(
  page: Page,
  path: string,
  name: string,
  waitMs: number,
  timeline: TimelineCollector,
  respectControlIntent: boolean,
): Promise<void> {
  // The pointer rests on the control first, so hover styling is not in the window.
  await page
    .locator(path)
    .first()
    .hover({ timeout: 1500 })
    .catch(() => undefined);
  await page.waitForTimeout(120);
  await installInstrumentation(page, respectControlIntent);
  const recording = await timeline.start({
    source: "probe-click",
    kind: "click",
    selector: path,
    name,
    confirmation: true,
  });
  try {
    const effectWindow = await beginEffectWindow(page, waitMs);
    try {
      await page
        .locator(path)
        .first()
        .click({ timeout: 1500, noWaitAfter: true });
    } catch (error) {
      await recording.finish("control was not clicked successfully", false);
      throw error;
    }
    try {
      await recording.finish(undefined, await effectWindow.wait());
    } finally {
      await effectWindow.dispose();
    }
  } finally {
    await recording.dispose();
  }
}

/** A dismissal test navigated or opened a window. */
function leftByDismissal(dismissal: ProbeDismissal | undefined): boolean {
  return (
    dismissal?.tests.some((test) => test.outcome === "inconclusive") === true
  );
}

/** The trigger box feeds `menu`; it is never a probe result key itself. */
function withoutTriggerBox<T extends { triggerBox?: unknown }>(
  outcome: T,
): Omit<T, "triggerBox"> {
  const { triggerBox: _box, ...rest } = outcome;
  return rest;
}

async function clickAndObserve(
  page: Page,
  path: string,
  waitMs: number,
  motion: MotionCollector,
  timeline: TimelineCollector | undefined,
  name: string,
  respectControlIntent: boolean,
  observed: Set<ProbeEffect>,
  onOpened?: (selectors: string[]) => void,
  timings?: ProbeAttemptTimings,
  clock = () => performance.now(),
  onBlocked?: (kind: "formSubmission" | "permission" | "windowOpen") => void,
  /** How long the click may wait for its own in-flight requests. */
  lateContentMs = LATE_CONTENT_WINDOW_MS,
): Promise<{
  effects: ProbeEffect[];
  signature?: string;
  primary?: boolean;
  selectsAncestor?: SelectsAncestor;
  triggerBox?: { trigger: Rect; group: string };
  backgroundRequests?: string[];
  error?: string;
}> {
  // Hover first and let any tooltip settle, so the click is measured alone.
  const hoverRecording = await timeline?.start({
    source: "probe-hover",
    kind: "hover",
    selector: path,
    name,
  });
  const hover = await motion.start(
    {
      source: "probe-hover",
      selector: path,
      name,
    },
    hoverRecording?.key,
  );
  try {
    await page
      .locator(path)
      .first()
      .hover({ timeout: 1500 })
      .catch(() => undefined);
    await page.waitForTimeout(120);
    await hoverRecording?.finish();
    await hover.finish();
    await hoverRecording?.finishVisual(motion.evidence());
  } finally {
    await hoverRecording?.dispose();
    await hover.dispose();
  }
  const box = await triggerBox(page, path);
  const before = await snapshot(page);
  const requests: Request[] = [];
  let dialogs = 0;
  let popups = 0;
  let filechoosers = 0;
  const onRequest = (request: Request) => {
    if (!ignoredRequest(request)) requests.push(request);
  };
  const onDialog = (dialog: { dismiss(): Promise<void> }) => {
    dialogs += 1;
    void dialog;
  };
  const onPopup = () => {
    popups += 1;
  };
  const onFileChooser = () => {
    filechoosers += 1;
  };
  page.on("filechooser", onFileChooser);
  page.on("request", onRequest);
  page.on("dialog", onDialog);
  page.on("popup", onPopup);
  let click: Awaited<ReturnType<MotionCollector["start"]>> | undefined;
  let recording: Awaited<ReturnType<TimelineCollector["start"]>> | undefined;
  let openedPicker = false;
  let effectWindow: Awaited<ReturnType<typeof beginEffectWindow>> | undefined;
  try {
    await installInstrumentation(page, respectControlIntent);
    recording = await timeline?.start({
      source: "probe-click",
      kind: "click",
      selector: path,
      name,
    });
    click = await motion.start(
      { source: "probe-click", selector: path, name },
      recording?.key,
    );
    effectWindow = await beginEffectWindow(page, waitMs, {
      pendingMs: Math.max(waitMs, lateContentMs),
    });
    const clickStarted = clock();
    try {
      await page
        .locator(path)
        .first()
        .click({ timeout: 1500, noWaitAfter: true });
    } catch (error) {
      await click.finish("control was not clicked successfully");
      await recording?.finish("control was not clicked successfully", false);
      page.off("request", onRequest);
      page.off("dialog", onDialog);
      page.off("popup", onPopup);
      return {
        effects: [],
        error:
          (error instanceof Error ? error.message : String(error)).split(
            "\n",
          )[0] ?? "",
      };
    } finally {
      if (timings) timings.clickMs += clock() - clickStarted;
    }
    const effectStarted = clock();
    try {
      let settled = false;
      try {
        settled = await effectWindow.wait();
      } finally {
        if (timings) timings.effectWindowMs += clock() - effectStarted;
      }
      await recording?.finish(undefined, settled);
      await click.finish();
      await recording?.finishVisual(motion.evidence());
    } finally {
      await click.dispose();
      await recording?.dispose();
    }
    page.off("request", onRequest);
    page.off("dialog", onDialog);
    page.off("popup", onPopup);
    const effects = observed;
    const after = await snapshot(page).catch(() => ({
      url: "",
      revealed: [] as string[],
      regions: [] as Snapshot["regions"],
    }));
    if (after.url !== before.url) effects.add("navigation");
    const counters = await readCounters(page).catch(() => ({
      mutations: 1,
      aria: 0,
      clipboard: 0,
      popups: 0,
      pickers: 0,
      prints: 0,
      submits: 0,
      permissions: 0,
      initiated: [] as InitiatedRequest[],
    }));
    if (counters.prints > 0) effects.add("print");
    // A vetoed submission did try to send; a denied prompt did ask.
    if (counters.submits > 0) {
      effects.add("network");
      for (let index = 0; index < counters.submits; index += 1)
        onBlocked?.("formSubmission");
    }
    if (counters.permissions > 0) {
      effects.add("dialog");
      for (let index = 0; index < counters.permissions; index += 1)
        onBlocked?.("permission");
    }
    for (let index = 0; index < counters.popups; index += 1)
      onBlocked?.("windowOpen");
    if (counters.pickers > 0) {
      effects.add("picker");
      openedPicker = true;
    }
    if (filechoosers > 0) effects.add("filechooser");
    if (counters.mutations > 0) effects.add("dom");
    if (counters.aria > 0) effects.add("aria");
    if (counters.clipboard > 0) effects.add("clipboard");
    if (counters.popups > 0 || popups > 0) effects.add("popup");
    if (dialogs > 0) effects.add("dialog");
    const focus = await page
      .evaluate((clicked) => {
        const active = document.activeElement;
        if (active === null || active === document.body) return false;
        const target = document.querySelector(clicked);
        return !(
          target !== null &&
          (active === target || target.contains(active))
        );
      }, path)
      .catch(() => false);
    if (focus) effects.add("focus");
    const selectsAncestor =
      (effects.has("dom") || effects.has("aria")) &&
      !["navigation", "popup", "download", "filechooser", "picker"].some(
        (effect) => effects.has(effect as ProbeEffect),
      )
        ? await ancestorSelection(
            page,
            path,
            name.split(" › ").at(-1) ?? name,
          ).catch(() => undefined)
        : undefined;
    const opened = after.revealed.filter(
      (name) => !before.revealed.includes(name),
    );
    onOpened?.(
      after.regions
        .filter((region) => opened.includes(region.name))
        .map((region) => region.selector),
    );
    // Only requests the click started count, and only when something
    // visible follows or the request would change data.
    const seen = requests.map((request) => ({
      method: request.method(),
      url: request.url(),
    }));
    const navigations = requests
      .filter(
        (request) =>
          request.isNavigationRequest() && !safeRequestMethod(request.method()),
      )
      .map((request) => ({ method: request.method(), url: request.url() }));
    if (
      clickNetworkEffect({
        initiated: counters.initiated,
        navigations,
        visible:
          [...effects].some((effect) => effect !== "network") ||
          opened.length > 0 ||
          dialogs > 0,
      })
    )
      effects.add("network");
    const backgroundRequests =
      effects.size === 0
        ? backgroundRequestLabels(
            seen,
            [...counters.initiated, ...navigations],
            before.url,
          )
        : [];
    const primary =
      effects.has("print") ||
      effects.has("download") ||
      effects.has("picker") ||
      effects.has("filechooser") ||
      effects.has("navigation") ||
      opened.length > 0 ||
      dialogs > 0 ||
      effects.has("popup") ||
      effects.has("network") ||
      effects.has("clipboard") ||
      effects.has("aria") ||
      (effects.has("dom") && (await primaryMutations(page, path)) > 0);
    let signature: string | undefined;
    if (effects.has("navigation")) {
      try {
        signature = `navigate:${new URL(after.url).pathname}`;
      } catch {
        signature = `navigate:${after.url}`;
      }
    } else if (opened.length > 0) signature = `open:${opened.join("|")}`;
    else if (
      effects.has("focus") &&
      !effects.has("picker") &&
      !effects.has("filechooser")
    ) {
      signature = await page
        .evaluate(() => {
          const active = document.activeElement as HTMLElement | null;
          if (active === null) return undefined;
          const name =
            active.getAttribute("aria-label") ??
            active.getAttribute("placeholder") ??
            active.id ??
            active.tagName;
          return `focus:${active.tagName.toLowerCase()}:${name}`;
        })
        .catch(() => undefined);
    }
    return {
      effects: [...effects],
      ...(signature === undefined ? {} : { signature }),
      primary,
      ...(selectsAncestor === undefined ? {} : { selectsAncestor }),
      ...(box === undefined ? {} : { triggerBox: box }),
      ...(backgroundRequests.length > 0 ? { backgroundRequests } : {}),
    };
  } finally {
    page.off("request", onRequest);
    page.off("dialog", onDialog);
    page.off("popup", onPopup);
    page.off("filechooser", onFileChooser);
    await effectWindow?.dispose();
    if (respectControlIntent && !openedPicker) {
      openedPicker = await readCounters(page)
        .then((counters) => counters.pickers > 0)
        .catch(() => false);
    }
    await cleanupInstrumentation(page);
    await click?.dispose();
    await recording?.finish("action interrupted", false);
    await recording?.dispose();
    if (openedPicker)
      await page.keyboard.press("Escape").catch(() => undefined);
  }
}

/** Page-side state of `recordClickRequests`. */
type ClickRequestRecorder = { armed: boolean; initiated: InitiatedRequest[] };

/**
 * Record the requests a probe click starts: fetch, XHR and beacons sent by
 * its handlers' synchronous code and their microtask continuations. Run
 * before application scripts, so a client that keeps its own reference to
 * `fetch` from load still calls through the wrapper. Inert until a click
 * window arms it. Self-contained: it is serialized.
 */
export function recordClickRequests() {
  const scope = window as unknown as {
    __idiomRequests?: ClickRequestRecorder;
  };
  if (scope.__idiomRequests) return;
  const recorder: ClickRequestRecorder = { armed: false, initiated: [] };
  scope.__idiomRequests = recorder;
  // The reset is a macrotask, so it runs after the dispatching task and its
  // microtask checkpoint, while a poll on its own timer task is outside the
  // window. (A timer already due when the click task ends may slip in
  // first; such a request still needs a visible change or a non-safe method
  // to count.)
  let active = false;
  const onActivity = () => {
    if (!recorder.armed || active) return;
    active = true;
    setTimeout(() => {
      active = false;
    }, 0);
  };
  for (const type of [
    "pointerdown",
    "mousedown",
    "pointerup",
    "mouseup",
    "click",
  ])
    window.addEventListener(type, onActivity, true);
  const initiate = (
    method: string,
    url: string | URL,
    via: "fetch" | "xhr" | "beacon",
  ) => {
    if (!recorder.armed || !active || recorder.initiated.length >= 50) return;
    try {
      recorder.initiated.push({
        method: method.toUpperCase(),
        url: new URL(url, location.href).href,
        via,
      });
    } catch {
      // An unparseable URL fails in the page too.
    }
  };
  const fetcher = window.fetch;
  if (typeof fetcher === "function")
    window.fetch = function (
      this: unknown,
      input: RequestInfo | URL,
      init?: RequestInit,
    ) {
      const request = input instanceof Request ? input : undefined;
      initiate(
        init?.method ?? request?.method ?? "GET",
        request?.url ?? (input as string | URL),
        "fetch",
      );
      return fetcher.call(this, input, init);
    } as typeof window.fetch;
  const xhr = XMLHttpRequest.prototype;
  const xhrOpen = xhr.open;
  const xhrSend = xhr.send;
  const opened = new WeakMap<
    XMLHttpRequest,
    { method: string; url: string | URL }
  >();
  xhr.open = function (
    this: XMLHttpRequest,
    method: string,
    url: string | URL,
    ...rest: unknown[]
  ) {
    opened.set(this, { method, url });
    return (xhrOpen as (...args: unknown[]) => void).call(
      this,
      method,
      url,
      ...rest,
    );
  } as typeof xhr.open;
  xhr.send = function (
    this: XMLHttpRequest,
    body?: Document | XMLHttpRequestBodyInit | null,
  ) {
    const request = opened.get(this);
    if (request) initiate(request.method, request.url, "xhr");
    return xhrSend.call(this, body);
  };
  const beacon = navigator.sendBeacon;
  if (typeof beacon === "function")
    navigator.sendBeacon = (url: string | URL, data?: BodyInit | null) => {
      initiate("POST", url, "beacon");
      return beacon.call(navigator, url, data);
    };
}

/**
 * Probe-only shims run before application scripts in replayed
 * documents/frames. `strict` (third-party pages) also vetoes form submission
 * and denies permission prompts. Self-contained: it is serialized.
 */
function suppressNativeUi(strict = false) {
  // Opaque-origin frames (sandboxed srcdoc) block callbacks and some APIs.
  if (window !== window.top && self.origin === "null") return;
  const scope = window as unknown as {
    __idiomSuppressed?: {
      print: number;
      popup: number;
      submit: number;
      permission: number;
    };
  };
  if (scope.__idiomSuppressed) return;
  const counters = { print: 0, popup: 0, submit: 0, permission: 0 };
  scope.__idiomSuppressed = counters;
  if (strict) {
    // Capture phase on window runs first; the app's own handlers still run
    // and their non-safe requests are blocked by routing.
    window.addEventListener(
      "submit",
      (event) => {
        event.preventDefault();
        counters.submit += 1;
      },
      { capture: true },
    );
    HTMLFormElement.prototype.submit = () => {
      counters.submit += 1;
    };
    const deny = () => {
      counters.permission += 1;
    };
    try {
      if (typeof Notification !== "undefined")
        Notification.requestPermission = () => {
          deny();
          return Promise.resolve("denied" as NotificationPermission);
        };
    } catch {
      // Not every document exposes notifications.
    }
    try {
      const geolocation = navigator.geolocation;
      if (geolocation !== undefined) {
        const refuse = (
          _success: unknown,
          error?: ((error: GeolocationPositionError) => void) | null,
        ) => {
          deny();
          error?.({
            code: 1,
            message: "denied",
            PERMISSION_DENIED: 1,
            POSITION_UNAVAILABLE: 2,
            TIMEOUT: 3,
          } as GeolocationPositionError);
          return 0;
        };
        geolocation.getCurrentPosition = (success, error) => {
          refuse(success, error);
        };
        geolocation.watchPosition = (success, error) => refuse(success, error);
      }
    } catch {
      // A locked geolocation object stays as it is.
    }
    try {
      const media = navigator.mediaDevices;
      if (media !== undefined) {
        const reject = () => {
          deny();
          return Promise.reject(new DOMException("denied", "NotAllowedError"));
        };
        media.getUserMedia = reject;
        media.getDisplayMedia = reject;
      }
    } catch {
      // Insecure origins have no media devices.
    }
  }
  // A replay must be able to leave the disposable document. Prevent the
  // application's unload veto; the native listener remains a fallback.
  window.addEventListener(
    "beforeunload",
    (event) => {
      event.stopImmediatePropagation();
      event.returnValue = "";
    },
    { capture: true },
  );
  window.print = () => {
    counters.print += 1;
  };
  window.open = () => {
    counters.popup += 1;
    return null;
  };
}

/** Apply the click probe's native guards while Tab can trigger page handlers. */
export async function protectProbeFocus(page: Page, ledger: ProbeSafetyLedger) {
  const context = page.context();
  const onDialog = (dialog: Dialog) => {
    if (dialog.type() === "beforeunload") {
      ledger.blocked.beforeunload += 1;
      void dialog.accept().catch(() => undefined);
    } else void dialog.dismiss().catch(() => undefined);
  };
  const onDownload = (download: Download) => {
    ledger.blocked.download += 1;
    void download.cancel().catch(() => undefined);
  };
  const onPage = (popup: Page) => {
    ledger.blocked.popup += 1;
    void popup.close({ runBeforeUnload: false }).catch(() => undefined);
  };
  page.on("dialog", onDialog);
  page.on("download", onDownload);
  context.on("page", onPage);
  const cleanup = async () => {
    try {
      for (const frame of page.frames()) {
        const counters = await frame
          .evaluate(() => {
            const scope = window as unknown as {
              __idiomSuppressed?: {
                submit: number;
                permission: number;
                popup: number;
              };
            };
            return scope.__idiomSuppressed;
          })
          .catch(() => undefined);
        ledger.blocked.formSubmission += counters?.submit ?? 0;
        ledger.blocked.permission += counters?.permission ?? 0;
        ledger.blocked.windowOpen += counters?.popup ?? 0;
      }
    } finally {
      page.off("dialog", onDialog);
      page.off("download", onDownload);
      context.off("page", onPage);
    }
  };
  try {
    await page.addInitScript(suppressNativeUi, true);
    for (const frame of page.frames())
      await frame.evaluate(suppressNativeUi, true);
    return cleanup;
  } catch (error) {
    await cleanup();
    throw error;
  }
}

/** Every continuation uses an attempt-local page and can publish only while valid. */
export async function probeControls(
  options: ProbeOptions,
): Promise<ProbeArtifact> {
  const clock = options.monotonicNow ?? (() => performance.now());
  const artifact: ProbeArtifact = { status: "ran", results: [] };
  const safety = options.safety?.ledger;
  if (safety) {
    // The settled page's origin covers a redirect (apex to www) on load.
    try {
      const origin = new URL(options.page.url()).origin;
      if (origin !== "null" && !safety.origins.includes(origin))
        safety.origins.push(origin);
    } catch {
      // An unparseable URL adds no origin.
    }
  }
  let attemptTimings: ProbeAttemptTimings | undefined;
  const measure = async <T>(
    phase: keyof ProbeAttemptTimings,
    work: () => Promise<T>,
  ): Promise<T> => {
    const timings = attemptTimings;
    const begun = clock();
    try {
      return await work();
    } finally {
      if (timings) timings[phase] += Math.max(0, clock() - begun);
    }
  };
  let activity = "initialization";
  let selector = "html";
  let completed = 0;
  const progress = (phase: string) => {
    activity = phase;
    options.onActivity?.(`probe ${selector} (${phase})`);
    options.onProbeProgress?.({ completed, selector, phase });
  };
  // Must precede any page operation (including handler/shim installation).
  progress("initialization");
  const stateStarted = clock();
  const stateTimeoutMs =
    options.flowBudget?.shareMs() ?? options.stateTimeoutMs ?? 60000;
  const controlTimeoutMs = options.controlTimeoutMs ?? 5000;
  // Waiting for a click's late content never spends more than half of the
  // control's budget, so it cannot time the control out.
  const lateContentMs = Math.min(LATE_CONTENT_WINDOW_MS, controlTimeoutMs / 2);
  // A flow whose wall-clock limit already passed leaves this state no time:
  // that is exhaustion, not a failure, and no deadline can be built from it.
  if (
    options.flowBudget &&
    !(Number.isFinite(stateTimeoutMs) && stateTimeoutMs > 0)
  ) {
    options.flowBudget.finish(0);
    artifact.status = "partial";
    artifact.reason = FLOW_PROBE_EXHAUSTED;
    if (safety) artifact.safety = safety;
    progress("complete");
    return artifact;
  }
  const state = new Deadline(
    "state",
    stateTimeoutMs,
    () => `${selector} (${activity})`,
    { signal: options.signal },
  );
  options.flowBudget?.start(state);
  // With no flow target the state deadline only expires as the capture
  // lifetime ends; name that limit, not a budget.
  const budgetReason = options.unbounded
    ? "capture.maxMinutes"
    : options.flowBudget
      ? "flow budget share"
      : "state budget";
  // A full replay runs on its own budget, never inside the next control's.
  const restoreBudgetMs = Math.max(controlTimeoutMs, 15000);
  // Nested menu items share one small budget so they cannot starve the
  // top-level controls. With no flow target there is nothing to starve:
  // each nested item is bounded only by its own control deadline.
  const nestedBudgetMs = () =>
    options.unbounded
      ? Number.POSITIVE_INFINITY
      : options.flowBudget
        ? 0.25 * options.flowBudget.shareMs()
        : Math.min(15000, 0.25 * stateTimeoutMs);
  let nestedUsed = 0;
  let current: Page | undefined = options.page;
  // Set by navigation, popups, retired pages and a failed restore ladder.
  let needsReplay = false;
  let baseline: { fingerprint: string; revealed: string[] } | undefined;
  let effects: Set<ProbeEffect> | undefined;
  const owned = new Set<Page>([options.page]);
  const protections = new Map<Page, () => Promise<void>>();
  const preparations = new Map<Page, () => Promise<void>>();
  const prepare = async (page: Page, deadline: Deadline) => {
    if (!options.preparePage || options.enumerateOnly) return;
    const pending = options.preparePage(page);
    void pending.then(
      async (dispose) => {
        if (
          deadline.signal.aborted ||
          state.signal.aborted ||
          page.isClosed()
        ) {
          await dispose();
          void page.close().catch(() => undefined);
        } else preparations.set(page, dispose);
      },
      () => undefined,
    );
    await deadline.run(() => pending);
  };
  // Probe clicks must never change the application's data: requests other
  // than GET/HEAD/OPTIONS are blocked (and still count as a network effect),
  // except while the state's own declared steps are being replayed.
  let replaying = 0;
  const restore = async (page: Page) => {
    replaying += 1;
    try {
      await options.restore(page);
    } finally {
      replaying -= 1;
    }
  };
  /** Baselines are taken pointer-off and blurred, as the ladder compares. */
  const takeBaseline = async (page: Page) => {
    await page.mouse.move(-1, -1);
    await page.evaluate(() =>
      (document.activeElement as HTMLElement | null)?.blur?.(),
    );
    const fingerprint = await stateFingerprint(page);
    baseline = {
      fingerprint,
      revealed: (JSON.parse(fingerprint) as [string, string[]])[1],
    };
  };
  const replay = async (page: Page) =>
    measure("replayMs", async () => {
      await restore(page);
      await takeBaseline(page);
      needsReplay = false;
    });
  const settleWait = Math.min(options.waitMs, 150);
  const onBlocked = safety
    ? (kind: "formSubmission" | "permission" | "windowOpen") => {
        safety.blocked[kind] += 1;
      }
    : undefined;
  /**
   * The restore ladder: no reload when nothing changed, then Escape, then a
   * newly revealed close control. False means a full replay is needed. It
   * never raises `replaying`, so the mutation guard blocks whatever an
   * Escape handler or close button sends.
   */
  const settleRaw = async (
    page: Page,
    deadline: Deadline,
  ): Promise<boolean> => {
    const reference = baseline;
    if (reference === undefined) return false;
    try {
      if (page.url() !== JSON.parse(reference.fingerprint)[0]) return false;
      await page.mouse.move(-1, -1);
      if (settleWait > 0) await page.waitForTimeout(settleWait);
      let latest = "";
      const clean = async () => {
        latest = await stateFingerprint(page);
        return latest === reference.fingerprint;
      };
      const blur = () =>
        page.evaluate(() =>
          (document.activeElement as HTMLElement | null)?.blur?.(),
        );
      if (await clean()) return true;
      // An opened menu or popover listens for Escape where focus is, so
      // Escape comes before blurring; with nothing opened, blur comes first.
      const opened =
        JSON.stringify((JSON.parse(latest) as [string, string[]])[1]) !==
        JSON.stringify(reference.revealed);
      if (!opened) {
        await blur();
        if (await clean()) return true;
      }
      for (let press = 0; press < 2; press += 1) {
        await measure("escapeMs", () => page.keyboard.press("Escape"));
        await page.waitForTimeout(Math.max(settleWait, 30));
        if (await clean()) return true;
      }
      await blur();
      if (await clean()) return true;
      // Transient classes (ripples, animations) get one more moment.
      await page.waitForTimeout(Math.max(options.waitMs, 50));
      if (await clean()) return true;
      const closer = await closeControl(page, reference.revealed);
      if (closer === undefined) return false;
      await page
        .locator(closer)
        .first()
        .click({
          timeout: Math.min(1000, deadline.remaining()),
          noWaitAfter: true,
        });
      await page.waitForTimeout(Math.max(settleWait, 30));
      return await clean();
    } catch (error) {
      if (error instanceof DeadlineExpired || deadline.signal.aborted)
        throw error;
      // Anything the ladder cannot read falls through to a full replay.
      return false;
    }
  };
  const settle = async (page: Page, deadline: Deadline) => {
    const timings = attemptTimings;
    const escapeBefore = timings?.escapeMs ?? 0;
    const begun = clock();
    try {
      return await settleRaw(page, deadline);
    } finally {
      if (timings)
        timings.restoreCheckMs += Math.max(
          0,
          clock() - begun - (timings.escapeMs - escapeBefore),
        );
    }
  };
  let creating = false;
  let retireAfterAttempt = false;
  const context = options.page.context();
  const close = (page: Page) => {
    void preparations.get(page)?.();
    preparations.delete(page);
    void protections.get(page)?.();
    protections.delete(page);
    void page.close({ runBeforeUnload: false }).then(
      () => owned.delete(page),
      () => undefined,
    );
  };
  // `popup` and the context's `page` event both report one new window.
  const counted = new WeakSet<Page>();
  const onNewPage = (page: Page) => {
    if (!creating && !owned.has(page)) {
      effects?.add("popup");
      if (safety && !counted.has(page)) {
        counted.add(page);
        safety.blocked.popup += 1;
      }
      close(page);
    }
  };
  context.on("page", onNewPage);
  const onContextRoute = (route: Route) => {
    if (safety) {
      const request = route.request();
      // No replay exemption: quick review's replay is a plain GET.
      if (crossOriginNavigation(safety, request)) {
        if (!recordedRequests.has(request))
          safety.blocked.crossOriginNavigation += 1;
        recordProbeRequest(safety, request, false);
        effects?.add("navigation");
        return route.abort("blockedbyclient").catch(() => undefined);
      }
      const allowed = probeRequestAllowed(request, "third-party");
      recordProbeRequest(safety, request, allowed);
      if (allowed) return route.fallback();
      // The click decides whether a blocked request was its effect.
      return route.abort("blockedbyclient").catch(() => undefined);
    }
    if (replaying > 0 || probeRequestAllowed(route.request()))
      return route.fallback();
    return route.abort("blockedbyclient").catch(() => undefined);
  };
  const protect = async (page: Page, deadline: Deadline) => {
    const onDialog = (dialog: Dialog) => {
      effects?.add("dialog");
      if (dialog.type() === "beforeunload") {
        if (safety) {
          // A listener registered before the shim still vetoes leaving.
          // Dismissing would cancel the replay; the page is disposable, so
          // leave it (cross-origin targets are still blocked by routing).
          // The navigation proceeds, so the page need not be retired.
          safety.blocked.beforeunload += 1;
          void dialog.accept().catch(() => undefined);
          return;
        }
        retireAfterAttempt = true;
      }
      void dialog.dismiss().catch(() => undefined);
    };
    const onFileChooser = (chooser: FileChooser) => {
      effects?.add("filechooser");
      if (!state.signal.aborted)
        void chooser
          .setFiles([], { timeout: state.remaining(1500) })
          .catch(() => undefined);
    };
    const onDownload = (download: Download) => {
      effects?.add("download");
      if (safety) safety.blocked.download += 1;
      void download.cancel().catch(() => undefined);
    };
    const onPopup = (popup: Page) => {
      effects?.add("popup");
      if (safety && !counted.has(popup)) {
        counted.add(popup);
        safety.blocked.popup += 1;
      }
      close(popup);
    };
    const onRoute = onContextRoute;
    page.on("dialog", onDialog);
    page.on("filechooser", onFileChooser);
    page.on("download", onDownload);
    page.on("popup", onPopup);
    protections.set(page, () => {
      page.off("dialog", onDialog);
      page.off("filechooser", onFileChooser);
      page.off("download", onDownload);
      page.off("popup", onPopup);
      return page.unroute("**/*", onRoute).catch(() => undefined);
    });
    await deadline.run(() => page.route("**/*", onRoute));
    await deadline.run(() => page.addInitScript(recordClickRequests));
    const strict = safety !== undefined;
    await deadline.run(() => page.addInitScript(suppressNativeUi, strict));
    for (const frame of page.frames())
      await deadline.run(() => frame.evaluate(suppressNativeUi, strict));
  };
  const retire = () => {
    effects = undefined;
    if (current) close(current);
    current = undefined;
    baseline = undefined;
    needsReplay = true;
  };
  const ensurePage = async (deadline: Deadline) => {
    if (!current) {
      creating = true;
      try {
        const pending = (options.replacePage ?? (() => context.newPage()))();
        // Own a late page even after the operation that requested it expired.
        void pending.then(
          (page) => {
            owned.add(page);
            if (deadline.signal.aborted || state.signal.aborted) close(page);
          },
          () => undefined,
        );
        current = await deadline.run(() => pending);
        await protect(current, deadline);
        await prepare(current, deadline);
      } finally {
        creating = false;
      }
    }
    deadline.check();
    return current;
  };
  const appendMotion = (motion: MotionCollector, reason?: string) => {
    artifact.motion = mergeMotion(artifact.motion, motion.evidence(reason));
  };
  let timelines: ActionTimelineArtifact | undefined;
  const appendTimelines = (timeline: TimelineCollector, reason?: string) => {
    if (timeline.recorded === 0) return;
    timelines = mergeTimelines(timelines, timeline.evidence(reason));
  };
  const markPartial = (reason: string) => {
    if (artifact.status !== "timed-out") artifact.status = "partial";
    artifact.reason = [
      ...new Set([artifact.reason, reason].filter(Boolean)),
    ].join("; ");
  };
  // Results are published in enumeration order whatever order they ran in.
  const ranks = new Map<ProbeResult, number>();
  const handled = new Set<Candidate>();
  const publish = (candidate: Candidate, result: ProbeResult) => {
    artifact.results.push(result);
    ranks.set(result, candidate.order ?? Number.POSITIVE_INFINITY);
    handled.add(candidate);
  };
  const notReached = (
    candidate: Candidate,
    reason: string,
    parent?: string,
  ) => {
    publish(candidate, {
      ...skippedResult(candidate, `not reached: ${reason}`, parent),
      status: "not-reached",
    });
    if (reason.startsWith("assigned to state:") || reason.startsWith("gate: "))
      return;
    if (
      reason !== "checks.probe.maxControls" &&
      artifact.status !== "timed-out"
    )
      markPartial(`controls not reached: ${reason}`);
  };
  const intent = options.respectControlIntent === true;
  type AttemptValue = {
    result?: ProbeResult;
    items?: Candidate[];
    explanationRecords?: ExplanationRecord[];
  };
  /** Publish a deadline expiry; non-deadline errors stop the probe. */
  const expire = (
    candidate: Candidate,
    parent: string | undefined,
    started: number,
    error: unknown,
    deadline: Deadline,
  ) => {
    if (options.signal?.aborted) throw options.signal.reason;
    if (error instanceof DeadlineExpired || deadline.signal.aborted) {
      // State expiration wins if the two timers become ready together.
      // Timer callbacks can be delivered out of order in a busy host loop.
      try {
        state.check();
      } catch {
        /* Scope is read from the parent below. */
      }
      const scope =
        state.signal.aborted ||
        (error instanceof DeadlineExpired && error.scope === "state")
          ? "state"
          : "control";
      publish(candidate, {
        ...skippedResult(candidate, `timed-out: ${activity}`, parent),
        effects: [...(effects ?? [])],
        status: "timed-out",
        timings: attemptTimings ? { ...attemptTimings } : undefined,
        timeoutScope: scope,
        elapsedMs: Math.max(0, clock() - started),
      });
      markPartial(`${candidate.selector} timed-out (${scope})`);
      retire();
      progress("timed-out");
      if (scope === "state") throw state.signal.reason ?? error;
      return;
    }
    markPartial(
      `probe stopped early: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`,
    );
    throw error;
  };
  /** A full replay before an attempt, bounded by the restore budget. */
  const replayBefore = async (
    candidate: Candidate,
    parent: string | undefined,
    started: number,
    limitMs = restoreBudgetMs,
  ): Promise<boolean> => {
    const deadline = new Deadline(
      "control",
      Math.min(restoreBudgetMs, limitMs, state.remaining()),
      () => `${selector} (${activity})`,
      { signal: state.signal },
    );
    let bound: ReturnType<typeof deadlinePage> | undefined;
    try {
      await deadline.run(async () => {
        const realPage = await ensurePage(deadline);
        bound = deadlinePage(realPage, deadline);
        progress("restore");
        await replay(bound.page);
      });
      deadline.check();
      return true;
    } catch (error) {
      expire(candidate, parent, started, error, deadline);
      completed += 1;
      progress("done");
      return false;
    } finally {
      if (retireAfterAttempt) {
        retire();
        retireAfterAttempt = false;
      }
      bound?.dispose();
      deadline.dispose();
    }
  };
  const attempt = async (
    candidate: Candidate,
    phase: string,
    work: (
      page: Page,
      motion: MotionCollector,
      explanation: ExplanationCollector,
      deadline: Deadline,
      timeline: TimelineCollector,
    ) => Promise<AttemptValue>,
    parent?: string,
    budgetMs?: number,
  ): Promise<AttemptValue | undefined> => {
    state.check();
    selector = candidate.selector;
    progress(phase);
    const started = clock();
    attemptTimings = {
      clickMs: 0,
      effectWindowMs: 0,
      restoreCheckMs: 0,
      escapeMs: 0,
      replayMs: 0,
    };
    if (
      (needsReplay || current === undefined) &&
      !(await replayBefore(candidate, parent, started, budgetMs))
    )
      return undefined;
    progress(phase);
    const deadline = new Deadline(
      "control",
      Math.max(
        1,
        Math.min(
          budgetMs === undefined
            ? controlTimeoutMs
            : budgetMs - (clock() - started),
          state.remaining(),
        ),
      ),
      () => `${selector} (${activity})`,
      { signal: state.signal },
    );
    let bound: ReturnType<typeof deadlinePage> | undefined;
    let motion: MotionCollector | undefined;
    let timeline: TimelineCollector | undefined;
    let explanation: ExplanationCollector | undefined;
    let value: AttemptValue | undefined;
    try {
      value = await deadline.run(async () => {
        const realPage = await ensurePage(deadline);
        deadline.check();
        bound = deadlinePage(realPage, deadline);
        const page = bound.page;
        motion = new MotionCollector(page, options.motionSelectors);
        const recorder = new TimelineCollector(page, {
          clock,
          motionSelectors: options.motionSelectors,
          filmstrips: options.filmstrips,
          filmstripPage: realPage,
        });
        timeline = recorder;
        explanation = new ExplanationCollector(page, "probe", options.waitMs);
        await motion.initialize();
        deadline.check();
        progress(phase);
        const value = await work(page, motion, explanation, deadline, recorder);
        effects = undefined;
        const leftPage =
          value.result?.effects.includes("navigation") === true ||
          value.result?.effects.includes("popup") === true ||
          retireAfterAttempt;
        if (leftPage) needsReplay = true;
        else if (!needsReplay) {
          progress(`${phase}: settle`);
          if (!(await settle(page, deadline))) needsReplay = true;
        }
        return value;
      });
      deadline.check();
      if (value.result)
        publish(candidate, {
          ...value.result,
          timings: { ...attemptTimings },
          replayRequired: needsReplay || undefined,
          status: "completed",
          elapsedMs: Math.max(0, clock() - started),
        });
    } catch (error) {
      expire(candidate, parent, started, error, deadline);
    } finally {
      if (motion)
        appendMotion(
          motion,
          deadline.signal.aborted ? "attempt timed-out" : undefined,
        );
      if (timeline) {
        await timeline.finishPending(
          deadline.signal.aborted ? "attempt timed-out" : "action interrupted",
        );
        appendTimelines(
          timeline,
          deadline.signal.aborted ? "attempt timed-out" : undefined,
        );
      }
      if (deadline.signal.aborted && explanation)
        explanation.partial("attempt timed-out");
      if (explanation)
        artifact.explanations = mergeExplanations(
          artifact.explanations,
          explanation.evidence(),
        );
      effects = undefined;
      if (retireAfterAttempt) {
        retire();
        retireAfterAttempt = false;
      }
      bound?.dispose();
      deadline.dispose();
      completed += 1;
      progress("done");
    }
    return value;
  };
  let initialMotion: MotionCollector | undefined;
  let explanationIdentities: ExplanationCandidate[] = [];
  /**
   * Normal-motion snap confirmation. Under prefers-reduced-motion: reduce an
   * instant change is correct, so a suspected snap is replayed once under
   * no-preference in a timeline-only window. One replay per change group
   * (`kind|container`), at most SNAP_CONFIRMATIONS per state.
   */
  const SNAP_CONFIRMATIONS = 6;
  const minExtentPx = options.motionMinExtentPx ?? 24;
  const snapGroups = new Map<string, "confirmed" | "cleared" | "unconfirmed">();
  let confirmations = 0;
  type SnapSuspect = { candidate: Candidate; keys: string[] };
  let snapSuspect: SnapSuspect | undefined;
  const suspectSnap = (
    candidate: Candidate,
    action: ActionTimelineArtifact["actions"][number] | undefined,
  ): SnapSuspect | undefined => {
    if (
      action?.reducedMotion !== true ||
      action.source !== "probe-click" ||
      action.confirmation === true ||
      // A same-document route change replays after a full restore; a
      // document navigation leaves no visible changes to confirm.
      effects?.has("popup")
    )
      return undefined;
    const keys = snapCandidateKeys(action, minExtentPx).filter(
      (key) => !snapGroups.has(key),
    );
    return keys.length ? { candidate, keys } : undefined;
  };
  const confirmSnap = async ({ candidate, keys }: SnapSuspect) => {
    const unconfirmed = () => {
      for (const key of keys)
        if (!snapGroups.has(key)) snapGroups.set(key, "unconfirmed");
    };
    if (
      confirmations >= SNAP_CONFIRMATIONS ||
      state.remaining() < controlTimeoutMs + 2 * options.waitMs + 1500
    ) {
      unconfirmed();
      return;
    }
    confirmations += 1;
    progress("motion confirmation");
    const deadline = new Deadline(
      "control",
      Math.min(restoreBudgetMs, state.remaining()),
      () => `${selector} (${activity})`,
      { signal: state.signal },
    );
    let bound: ReturnType<typeof deadlinePage> | undefined;
    let realPage: Page | undefined;
    let recorder: TimelineCollector | undefined;
    let emulated = false;
    let failure: string | undefined;
    try {
      await deadline.run(async () => {
        realPage = await ensurePage(deadline);
        bound = deadlinePage(realPage, deadline);
        const page = bound.page;
        if (needsReplay || !(await settle(page, deadline))) await replay(page);
        recorder = new TimelineCollector(page, {
          clock,
          motionSelectors: options.motionSelectors,
        });
        emulated = true;
        await realPage.emulateMedia({ reducedMotion: "no-preference" });
        await confirmClick(
          page,
          candidate.path,
          candidate.name,
          options.waitMs,
          recorder,
          intent,
        );
      });
      const replayed = recorder?.lastAction();
      const snapping = new Set(
        replayed?.confirmation === true && replayed.reducedMotion === false
          ? snapCandidateKeys(replayed, minExtentPx)
          : [],
      );
      const animated = new Set(
        replayed?.confirmation === true && replayed.reducedMotion === false
          ? animatedKeys(replayed, minExtentPx)
          : [],
      );
      for (const key of keys)
        snapGroups.set(
          key,
          snapping.has(key)
            ? "confirmed"
            : animated.has(key)
              ? "cleared"
              : "unconfirmed",
        );
    } catch (error) {
      if (options.signal?.aborted) throw options.signal.reason;
      if (
        state.signal.aborted ||
        (error instanceof DeadlineExpired && error.scope === "state")
      )
        throw state.signal.reason ?? error;
      unconfirmed();
      failure = `snap confirmation failed: ${(error instanceof Error ? error.message : String(error)).split("\n")[0]}`;
    } finally {
      if (emulated && realPage)
        await realPage
          .emulateMedia({
            reducedMotion:
              options.reducedMotion === false ? "no-preference" : "reduce",
          })
          .catch(() => undefined);
      if (recorder) {
        await recorder.finishPending("action interrupted");
        appendTimelines(recorder, failure);
      }
      // The replayed click left the page where the original one did.
      if (realPage && bound && !deadline.signal.aborted && !needsReplay) {
        const settled = await settle(bound.page, deadline).catch(() => false);
        if (!settled) needsReplay = true;
      } else needsReplay = true;
      bound?.dispose();
      deadline.dispose();
    }
  };
  /**
   * The selection pass: links and look-alike controls inside selectable
   * containers, clicked once each with navigation suppressed. Its trials
   * stay out of `artifact.results`, where a guarded link would read as dead.
   */
  const selectionPhase = async (already: string[]) => {
    const reserve = () => controlTimeoutMs + 2 * options.waitMs + 1500;
    if (options.signal?.aborted || state.remaining() < reserve()) return;
    progress("selection candidates");
    const trials: SelectionTrial[] = [];
    const record = (pass: NonNullable<ProbeArtifact["selectionTrials"]>) => {
      artifact.selectionTrials = pass;
      return pass;
    };
    const failed = (pass: ReturnType<typeof record>, reason: string) => {
      pass.status = "partial";
      pass.reason = [...new Set([pass.reason, reason].filter(Boolean))].join(
        "; ",
      );
    };
    const step = async <T>(
      work: (page: Page, deadline: Deadline) => Promise<T>,
    ): Promise<T> => {
      const deadline = new Deadline(
        "control",
        Math.min(controlTimeoutMs, state.remaining()),
        () => `${selector} (${activity})`,
        { signal: state.signal },
      );
      let bound: ReturnType<typeof deadlinePage> | undefined;
      try {
        return await deadline.run(async () => {
          const realPage = await ensurePage(deadline);
          bound = deadlinePage(realPage, deadline);
          const page = bound.page;
          if (needsReplay || !(await settle(page, deadline)))
            await replay(page);
          return await work(page, deadline);
        });
      } finally {
        // The trial left the page where its click did.
        if (bound && !deadline.signal.aborted && !needsReplay) {
          const settled = await settle(bound.page, deadline).catch(() => false);
          if (!settled) needsReplay = true;
        } else needsReplay = true;
        bound?.dispose();
        deadline.dispose();
      }
    };
    const rethrowState = (error: unknown) => {
      if (options.signal?.aborted) throw options.signal.reason;
      if (
        state.signal.aborted ||
        (error instanceof DeadlineExpired && error.scope === "state")
      )
        throw state.signal.reason ?? error;
    };
    let found: SelectionCandidate[];
    try {
      found = await step((page) =>
        selectionCandidates(page, options.skip, already, intent),
      );
    } catch (error) {
      rethrowState(error);
      failed(
        record({
          status: "ran",
          limit: SELECTION_TRIAL_LIMIT,
          candidates: 0,
          trials,
        }),
        `selection candidates unavailable: ${(error instanceof Error ? error.message : String(error)).split("\n")[0]}`,
      );
      return;
    }
    const pass = record({
      status: "ran",
      limit: SELECTION_TRIAL_LIMIT,
      candidates: found.length,
      trials,
    });
    let clicked = 0;
    for (const candidate of found) {
      if (options.signal?.aborted || clicked >= SELECTION_TRIAL_LIMIT) break;
      // The same never-click guard as the main and nested passes.
      const preSkip =
        candidate.intentReason ??
        (destructive.test(candidate.name) ? "destructive name" : undefined);
      if (preSkip) {
        if (preSkip === "destructive name" && safety)
          safety.skipped.destructive += 1;
        trials.push({
          selector: candidate.selector,
          name: candidate.name,
          affordance: candidate.affordance,
          status: "skipped",
          skipped: preSkip,
          effects: [],
          elapsedMs: 0,
        });
        continue;
      }
      clicked += 1;
      if (state.remaining() < reserve()) {
        failed(pass, `selection pass stopped: ${budgetReason}`);
        break;
      }
      selector = candidate.selector;
      progress("selection");
      const started = clock();
      try {
        const trial = await step(async (page) => {
          const result = await selectionTrial(
            page,
            candidate,
            options.waitMs,
            intent,
          );
          if (
            result.effects.includes("navigation") ||
            result.effects.includes("popup")
          )
            needsReplay = true;
          return result;
        });
        trials.push({ ...trial, elapsedMs: Math.max(0, clock() - started) });
      } catch (error) {
        rethrowState(error);
        const timedOut = error instanceof DeadlineExpired;
        trials.push({
          selector: candidate.selector,
          name: candidate.name,
          affordance: candidate.affordance,
          status: timedOut ? "timed-out" : "skipped",
          ...(timedOut
            ? {}
            : {
                skipped: `not clickable: ${(error instanceof Error ? error.message : String(error)).split("\n")[0]}`,
              }),
          effects: [],
          elapsedMs: Math.max(0, clock() - started),
        });
        if (timedOut) {
          failed(pass, `${candidate.selector} timed-out (selection)`);
          break;
        }
      }
    }
  };
  let activeCandidate: Candidate | undefined;
  let activeStarted = 0;
  let activeParent: string | undefined;
  const runAttempt: typeof attempt = async (
    candidate,
    phase,
    work,
    parent,
    budgetMs,
  ) => {
    activeCandidate = candidate;
    activeStarted = clock();
    activeParent = parent;
    const result = await attempt(candidate, phase, work, parent, budgetMs);
    activeCandidate = undefined;
    return result;
  };
  const ledger = options.ledger;
  const partition = options.ledgerPartition ?? "";
  const stateId = options.stateId ?? "";
  let queue: Candidate[] = [];
  const nestedQueue: Array<{ candidate: Candidate; parent: string }> = [];
  /** Top-level probe clicks that sent requests, for the held replay. */
  const heldQueue: Array<{
    candidate: Candidate;
    sourceAction: import("../checks/types.js").ActionTimeline;
  }> = [];
  const failureSummary = options.failureReplay
    ? {
        ...DEFAULT_FAILURE,
        ...options.failureReplay,
        completed: [...(options.failureReplay.completed ?? [])],
        queued: 0,
        ran: 0,
        notes: [] as string[],
      }
    : undefined;
  if (failureSummary) artifact.failureReplay = failureSummary;
  /**
   * One held replay on a fresh copy: restore, then replay the action with its
   * requests held. Counts against the state deadline; never publishes a
   * probe result. False ends the phase (the state budget is spent).
   */
  const heldAttempt = async (
    item: HeldItem,
    reach: (page: Page) => Promise<void>,
    notes: string[],
    original?: import("../checks/types.js").ActionTimeline,
    requests: ReplayRequest[] = [],
    runLoading = true,
  ): Promise<boolean> => {
    const held = options.heldReplay;
    if (!held) return false;
    selector = item.selector;
    progress("held replay");
    const deadline = new Deadline(
      "control",
      Math.max(
        1,
        Math.min(
          3 * held.delayMs +
            controlTimeoutMs +
            restoreBudgetMs +
            (failureSummary
              ? failureSummary.feedbackWithinMs + controlTimeoutMs
              : 0),
          state.remaining(),
        ),
      ),
      () => `${selector} (${activity})`,
      { signal: state.signal },
    );
    let bound: ReturnType<typeof deadlinePage> | undefined;
    let timeline: TimelineCollector | undefined;
    try {
      await deadline.run(async () => {
        const realPage = await ensurePage(deadline);
        // Before the restore loads the document, so carousels and tickers
        // are seen rotating on their own from the start.
        if (!noiseRecorded.has(realPage)) {
          noiseRecorded.add(realPage);
          await realPage.addInitScript(installNoiseRecorder);
        }
        bound = deadlinePage(realPage, deadline);
        const page = bound.page;
        needsReplay = true;
        progress("held replay: restore");
        replaying += 1;
        try {
          await reach(page);
        } finally {
          replaying -= 1;
        }
        await takeBaseline(page);
        needsReplay = false;
        deadline.check();
        const recorder = new TimelineCollector(page, {
          clock,
          filmstrips: options.filmstrips,
          filmstripPage: realPage,
        });
        timeline = recorder;
        progress("held replay");
        if (runLoading)
          await replayHeld({
            page,
            routePage: realPage,
            item,
            delayMs: held.delayMs,
            withinMs: held.withinMs,
            waitMs: options.waitMs,
            policy: safety ? "third-party" : "app",
            timeline: recorder,
            clock,
          });
        if (failureSummary && original && requests.length) {
          const key = failureKey(item.selector, original.requests);
          const eligibility = failureEligibility(
            original,
            recorder.lastAction(),
          );
          const eligibleRequests = eligibility
            ? eligibleFailureRequests(
                original,
                recorder.lastAction(),
                eligibility,
                requests,
              )
            : [];
          if (eligibility && eligibleRequests.length)
            failureSummary.queued += 1;
          if (!eligibility || !eligibleRequests.length)
            failureSummary.notes.push(
              `${item.selector}: response-gated visible result was not established`,
            );
          else if (failureSummary.completed.includes(key))
            failureSummary.notes.push(
              `${item.selector}: already replayed in an earlier round`,
            );
          else if (failureSummary.completed.length >= MAX_FAILURE_REPLAYS)
            failureSummary.notes.push(
              `not reached: failure replay cap of ${MAX_FAILURE_REPLAYS}`,
            );
          else if (deadline.remaining() < failureSummary.feedbackWithinMs + 500)
            failureSummary.notes.push(
              `${item.selector}: not reached: probe budget before failure mode`,
            );
          else {
            progress("failure replay: restore");
            if (needsReplay || !(await settle(page, deadline))) {
              replaying += 1;
              try {
                await reach(page);
              } finally {
                replaying -= 1;
              }
            }
            await takeBaseline(page);
            needsReplay = false;
            progress("failure replay");
            // Count an attempt once, including interrupted evidence, across rounds.
            failureSummary.completed.push(key);
            failureSummary.ran += 1;
            await replayFailure({
              page,
              routePage: realPage,
              item,
              requests: eligibleRequests,
              eligibility,
              settings: failureSummary,
              timeline: recorder,
              clock,
            });
          }
        }
      });
      deadline.check();
      return true;
    } catch (error) {
      if (options.signal?.aborted) throw options.signal.reason;
      retire();
      if (
        state.signal.aborted ||
        (error instanceof DeadlineExpired && error.scope === "state")
      ) {
        notes.push(
          `not reached: probe budget (state deadline at ${item.selector})`,
        );
        return false;
      }
      notes.push(
        error instanceof DeadlineExpired || deadline.signal.aborted
          ? `${item.selector}: held replay timed out`
          : `${item.selector}: held replay failed: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`,
      );
      return true;
    } finally {
      if (failureSummary)
        for (const note of notes)
          if (!failureSummary.notes.includes(note))
            failureSummary.notes.push(note);
      if (timeline) {
        await timeline.finishPending("held replay interrupted");
        appendTimelines(timeline);
      }
      needsReplay = true;
      if (retireAfterAttempt) {
        retire();
        retireAfterAttempt = false;
      }
      bound?.dispose();
      deadline.dispose();
      progress("done");
    }
  };
  /** Web steps first, in step order, then probe clicks in enumeration order. */
  const heldPhase = async () => {
    const held = options.heldReplay;
    if (!held) return;
    const items: Array<{
      item: HeldItem;
      reach: (page: Page) => Promise<void>;
      original?: import("../checks/types.js").ActionTimeline | undefined;
      requests?: ReplayRequest[] | undefined;
      replayKey?: string | undefined;
    }> = [
      ...[...held.steps]
        .sort((a, b) => a.stepIndex - b.stepIndex)
        .map((step) => ({
          item: {
            of: "web-step" as const,
            kind: step.action,
            selector: step.selector,
            name: step.action,
            stepIndex: step.stepIndex,
            perform: step.perform,
            repeat: step.repeat,
          },
          reach: step.reach,
          original: step.sourceAction,
          requests: step.requests,
          replayKey: step.replayKey,
        })),
      ...[...heldQueue]
        .sort(
          (a, b) =>
            (a.candidate.order ?? Number.POSITIVE_INFINITY) -
            (b.candidate.order ?? Number.POSITIVE_INFINITY),
        )
        .map(({ candidate, sourceAction }) => ({
          item: {
            of: "probe-click" as const,
            kind: "click" as const,
            selector: candidate.selector,
            name: candidate.name,
            prepare: async (page: Page) => {
              await page
                .locator(candidate.path)
                .first()
                .hover({ timeout: 1500 })
                .catch(() => undefined);
              await page.waitForTimeout(120);
            },
            perform: async (page: Page) => {
              await installInstrumentation(page, intent);
              try {
                await page
                  .locator(candidate.path)
                  .first()
                  .click({ timeout: 1500, noWaitAfter: true });
              } finally {
                await cleanupInstrumentation(page);
              }
            },
            repeat: async (page: Page, timeoutMs: number) => {
              await page
                .locator(candidate.path)
                .first()
                .click({ timeout: timeoutMs, noWaitAfter: true });
            },
          },
          reach: restore,
          original: sourceAction,
          requests: replayRequests(sourceAction),
        })),
    ];
    const summary = {
      delayMs: held.delayMs,
      queued: items.length,
      ran: 0,
      notes: [] as string[],
    };
    artifact.heldReplay = summary;

    if (items.length === 0) return;
    if (held.delayMs <= held.withinMs && !failureSummary) {
      summary.notes.push(
        "unjudgeable: checks.loading.delayMs must exceed checks.progressWithinMs",
      );
      return;
    }
    const seenFailures = new Set<string>();
    const replays = options.replayLedger;
    const planned = replays?.planned(partition) === true;
    // Held replays counted against the cap: a web step another state replays
    // for the flow is skipped and never pushes probe clicks past the cap.
    let position = 0;
    for (const [index, entry] of items.entries()) {
      const key = planned ? entry.replayKey : undefined;
      if (replays && key !== undefined) {
        const owner = replays.owner(partition, key);
        // Already replayed (here in an earlier round, or elsewhere), or owned
        // by another state this round: its result is copied after the round.
        if (
          replays.lookup(partition, key) ||
          (owner !== undefined && owner !== stateId)
        )
          continue;
      }
      const slot = position++;
      if (failureSummary && entry.original) {
        const key = failureKey(entry.item.selector, entry.original.requests);
        if (seenFailures.has(key)) continue;
        seenFailures.add(key);
      }
      const left = items.length - index;
      if (slot >= MAX_HELD_REPLAYS) {
        summary.notes.push(
          `not reached: ${left} held replays beyond the cap of ${MAX_HELD_REPLAYS}`,
        );
        if (
          !failureSummary ||
          !entry.original ||
          !failureEligibility(entry.original)
        ) {
          failureSummary?.notes.push(
            `${entry.item.selector}: not reached: loading evidence cap and no normal response-gating evidence`,
          );
          continue;
        }
      }
      if (state.remaining() < 3 * held.delayMs + controlTimeoutMs) {
        const limit = options.unbounded ? "capture.maxMinutes" : "probe budget";
        summary.notes.push(`not reached: ${limit} (${left} held replays)`);
        failureSummary?.notes.push(
          `not reached: ${limit} (${left} action replays)`,
        );
        break;
      }
      const before = timelines?.actions.length ?? 0;
      const completedBefore = failureSummary?.completed.length ?? 0;
      const go = await heldAttempt(
        entry.item,
        entry.reach,
        summary.notes,
        entry.original,
        entry.requests,
        slot < MAX_HELD_REPLAYS,
      );
      if (slot < MAX_HELD_REPLAYS && (timelines?.actions.length ?? 0) > before)
        summary.ran += 1;
      if (replays && key !== undefined) {
        // This round's probe replays each step at most once.
        const recorded = (timelines?.actions ?? []).filter(
          (action) =>
            (action.held?.of === "web-step" ||
              action.failure?.of === "web-step") &&
            action.stepIndex === entry.item.stepIndex,
        );
        if (
          recorded.length &&
          !recorded.some((action) => action.status === "unavailable")
        )
          replays.record(
            partition,
            key,
            stateId,
            recorded,
            failureSummary?.completed.slice(completedBefore) ?? [],
          );
      }
      if (!go) break;
    }
  };
  /** Copy a result probed at an earlier state onto this state's control. */
  const reuse = (
    candidate: Candidate,
    entry: ProbeLedgerEntry,
    parent?: string,
  ) => {
    // A revealed state is checked once, at the state that opened it.
    const {
      elapsedMs: _elapsed,
      timings: _timings,
      timeoutScope: _scope,
      revealed: _revealed,
      dismissal: _dismissal,
      reclick: _reclick,
      indicator: _indicator,
      ...cached
    } = entry.result;
    const local = skippedResult(candidate, "", parent);
    publish(candidate, {
      ...cached,
      selector: local.selector,
      name: local.name,
      persistent: local.persistent,
      repeated: candidate.repeated ? true : undefined,
      region: candidate.region,
      status: "completed",
      reusedFrom: entry.state,
    });
    for (const nested of entry.nested ?? []) {
      const {
        elapsedMs: _nestedElapsed,
        revealed: _nestedRevealed,
        dismissal: _nestedDismissal,
        reclick: _nestedReclick,
        indicator: _nestedIndicator,
        ...rest
      } = nested;
      publish(candidate, {
        ...rest,
        status: "completed",
        reusedFrom: entry.state,
      });
    }
  };
  const maxRevealed = options.maxRevealed ?? DEFAULT_MAX_REVEALED;
  let revealedCount = 0;
  let dismissalCount = 0;
  const dismissalSummary = options.dismissal
    ? { tested: 0, notReached: 0, limit: MAX_DISMISSALS }
    : undefined;
  if (dismissalSummary) artifact.dismissal = dismissalSummary;
  let reclickCount = 0;
  const reclickSummary = options.dismissal
    ? { tested: 0, notReached: 0, limit: MAX_RECLICKS }
    : undefined;
  if (reclickSummary) artifact.reclick = reclickSummary;
  const indicatorSummary = options.dismissal ? { recorded: 0 } : undefined;
  if (indicatorSummary) artifact.indicators = indicatorSummary;
  /** A disclosure trigger's indicator, read inside the attempt's deadline. */
  const indicatorOf = async (page: Page, deadline: Deadline, path: string) => {
    if (indicatorSummary === undefined || options.enumerateOnly)
      return undefined;
    const snapshot = await readIndicator(page, path);
    deadline.check();
    return snapshot;
  };
  /** Open a panel again: click its parents' paths, then its trigger. */
  const clickOpen = async (page: Page, paths: string[]) => {
    for (const path of paths) {
      const window = await beginEffectWindow(page, options.waitMs);
      try {
        await page
          .locator(path)
          .first()
          .click({ timeout: 1500, noWaitAfter: true });
        await window.wait();
      } finally {
        await window.dispose();
      }
    }
  };
  /**
   * Test how the overlay a click opened closes, inside the attempt's
   * deadline. `root` is the disclosure's root; otherwise the first opened
   * dialog, alert dialog, modal or popover in `openedRoots`.
   */
  const testOpenedDismissal = async (
    page: Page,
    deadline: Deadline,
    trigger: string,
    opened: {
      kind?: "popup" | "expanded" | undefined;
      root?: string | undefined;
      openedRoots: string[];
    },
    reopen: (page: Page) => Promise<void>,
  ): Promise<ProbeDismissal | undefined> => {
    const settings = options.dismissal;
    if (settings === undefined || options.enumerateOnly) return undefined;
    const root = opened.root ?? (await dialogRoot(page, opened.openedRoots));
    deadline.check();
    if (root === undefined) return undefined;
    if (dismissalCount >= MAX_DISMISSALS) {
      if (dismissalSummary) dismissalSummary.notReached += 1;
      return {
        trigger,
        root,
        kind: opened.kind ?? "dialog",
        status: "not-reached",
        reason: dismissalLimitReason,
        tests: [],
      };
    }
    progress("dismissal");
    const { dismissal, disturbed } = await testDismissal(page, {
      trigger,
      root,
      kind: opened.kind,
      explicit: settings.explicit,
      waitMs: options.waitMs,
      deadline,
      reopen,
    });
    deadline.check();
    if (disturbed) needsReplay = true;
    if (dismissal.status !== "not-applicable") {
      dismissalCount += 1;
      if (dismissalSummary) {
        if (dismissal.status !== "not-reached") dismissalSummary.tested += 1;
        if (dismissal.status !== "tested") dismissalSummary.notReached += 1;
      }
    }
    return dismissal;
  };
  /**
   * Click the opener of the panel a click opened a second time, inside the
   * attempt's deadline: after the dismissal tests, so Escape still runs on
   * the probe's own opening. A plain control is tested only when it opened
   * a dialog or popover; `original` is the opener's pre-click box.
   */
  const testOpenedReclick = async (
    page: Page,
    deadline: Deadline,
    trigger: string,
    opened: {
      kind?: "popup" | "expanded" | undefined;
      root?: string | undefined;
      openedRoots: string[];
      original: Rect | undefined;
    },
    reopen: (page: Page) => Promise<void>,
  ): Promise<ProbeReclick | undefined> => {
    if (reclickSummary === undefined || options.enumerateOnly) return undefined;
    if (opened.original === undefined) return undefined;
    const root = opened.root ?? (await dialogRoot(page, opened.openedRoots));
    deadline.check();
    if (root === undefined) return undefined;
    if (reclickCount >= MAX_RECLICKS) {
      reclickSummary.notReached += 1;
      return {
        trigger,
        root,
        outcome: "not-reached",
        reason: reclickLimitReason,
      };
    }
    progress("reclick");
    const { reclick, disturbed } = await testReclick(page, {
      trigger,
      root,
      original: opened.original,
      waitMs: options.waitMs,
      deadline,
      reopen,
    });
    deadline.check();
    if (disturbed) needsReplay = true;
    reclickCount += 1;
    if (reclick.outcome === "not-reached") reclickSummary.notReached += 1;
    else reclickSummary.tested += 1;
    return reclick;
  };
  /** Revealed roots of opened disclosures, for their mode-switch items. */
  const revealedRoots = new Map<Candidate, string | undefined>();
  /**
   * Observe an opened disclosure in place, inside the attempt's deadline.
   * A slow or failed observation is recorded as unavailable; it never turns
   * the control's own result into a timeout.
   */
  const observeRevealedState = async (
    page: Page,
    deadline: Deadline,
    base: Pick<RevealedState, "name" | "kind" | "trigger" | "root">,
  ): Promise<RevealedState | undefined> => {
    const hook = options.observeRevealed;
    if (hook === undefined || maxRevealed === 0) return undefined;
    const described = {
      name: base.name,
      kind: base.kind,
      trigger: base.trigger,
      ...(base.root === undefined ? {} : { root: base.root }),
    };
    if (revealedCount >= maxRevealed)
      return {
        ...described,
        status: "unavailable",
        reason: "revealed-state limit (checks.probe.maxRevealed)",
      };
    revealedCount += 1;
    const begun = clock();
    const budget = Math.min(REVEALED_OBSERVE_MS, deadline.remaining() - 250);
    if (budget < 250)
      return {
        ...described,
        status: "unavailable",
        reason: "no time left in the control's budget",
      };
    progress("revealed state");
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const left = () => Math.max(1, budget - (clock() - begun));
      await settleAnimations(page, Math.min(500, left() / 4));
      const observing = hook(page, { root: base.root, trigger: base.trigger });
      observing.catch(() => undefined);
      const observed = await Promise.race([
        observing,
        new Promise<"timed-out">((resolve) => {
          timer = setTimeout(() => resolve("timed-out"), left());
        }),
      ]);
      if (observed === "timed-out") {
        // The abandoned evaluate may still be running in the page.
        needsReplay = true;
        return {
          ...described,
          status: "unavailable",
          reason: `observation took longer than ${Math.round(budget)}ms`,
        };
      }
      if (observed.version !== 2)
        return {
          ...described,
          status: "unavailable",
          reason: "the revealed page is not HTML",
        };
      const { probe: _probe, ...observations } = observed;
      return { ...described, status: "observed", observations };
    } catch (error) {
      if (
        options.signal?.aborted ||
        state.signal.aborted ||
        (error instanceof DeadlineExpired && error.scope === "state")
      )
        throw error;
      deadline.check();
      needsReplay = true;
      return {
        ...described,
        status: "unavailable",
        reason: `observation failed: ${error instanceof Error ? (error.message.split("\n")[0] ?? "") : String(error)}`,
      };
    } finally {
      clearTimeout(timer);
    }
  };
  try {
    // Context routing also guards a popup's very first request. Page routing
    // remains in place so an earlier library caller's route cannot bypass it.
    await state.run(() => context.route("**/*", onContextRoute));
    await state.run(() => protect(options.page, state));
    await prepare(options.page, state);
    const initial = deadlinePage(options.page, state);
    let candidates: Candidate[];
    let explanations: ExplanationCandidate[] = [];
    const explanationsByCandidate = new Map<Candidate, ExplanationCandidate>();
    try {
      // Visible mode samples every glyph control; the default samples only
      // text glyphs such as "?", whose missing tooltip it reports. Identities
      // come from the captured document, which observations already named.
      explanations = await state.run(() =>
        explanationCandidates(
          initial.page,
          options.explanation === "visible" ? {} : { textGlyphsOnly: true },
        ),
      );
      explanationIdentities = explanations;
      // Probe mode needs a fresh document: libraries measure the scrollbar
      // during startup, and the first baseline must include its gutter.
      if (options.preparePage && !options.enumerateOnly)
        await state.run(() => restore(initial.page));
      const motion = new MotionCollector(initial.page, options.motionSelectors);
      initialMotion = motion;
      await state.run(() => motion.initialize());
      candidates = await state.run(() =>
        enumerate(initial.page, options.skip, undefined, intent),
      );
      // Observation selectors deliberately avoid generated ids; probe action
      // paths can still contain them. Join by DOM node, not selector spelling.
      const matches = await state.run(() =>
        initial.page.evaluate(
          ({ paths, selectors }) => {
            const indices = new Map<Element, number>();
            selectors.forEach((selector, index) => {
              const element = document.querySelector(selector);
              if (element) indices.set(element, index);
            });
            return paths.map((path) => {
              const element = document.querySelector(path);
              return element ? (indices.get(element) ?? -1) : -1;
            });
          },
          {
            paths: candidates.map((candidate) => candidate.path),
            selectors: explanations.map((item) => item.selector),
          },
        ),
      );
      for (const [index, candidate] of candidates.entries()) {
        const explanation = explanations[matches[index] ?? -1];
        if (explanation) {
          explanationsByCandidate.set(candidate, explanation);
          candidate.explanation = {
            selector: explanation.selector,
            controlId: explanation.controlId,
          };
        }
      }
      await state.run(() => takeBaseline(initial.page));
    } finally {
      initial.dispose();
    }
    const keys = identityKeys(
      candidates.map((candidate) => ({
        role: candidate.role ?? "",
        name: candidate.name,
        region: candidate.region,
        signature: candidate.signature ?? candidate.path,
      })),
    );
    const keyOf = new Map<Candidate, string>();
    for (const [index, candidate] of candidates.entries()) {
      candidate.order = index;
      keyOf.set(candidate, keys[index] ?? candidate.path);
    }
    // Every probed run records fingerprints, so a full run seeds the gate.
    try {
      const fingerprints = await state.run(() =>
        renderedFingerprints(
          options.page,
          candidates,
          candidates.map((candidate) => keyOf.get(candidate) ?? ""),
        ),
      );
      const recorded: Record<string, string> = {};
      for (const [index, candidate] of candidates.entries()) {
        const fingerprint = fingerprints[index];
        if (fingerprint === undefined) continue;
        candidate.fingerprint = fingerprint;
        recorded[keyOf.get(candidate) ?? candidate.path] = fingerprint;
      }
      artifact.fingerprints = recorded;
    } catch (error) {
      if (options.signal?.aborted || state.signal.aborted) throw error;
      if (error instanceof DeadlineExpired) throw error;
    }
    const region = options.region;
    if (region) {
      const names = new Map<string, number>();
      for (const candidate of candidates)
        names.set(candidate.name, (names.get(candidate.name) ?? 0) + 1);
      for (const candidate of candidates) {
        const key = keyOf.get(candidate) ?? candidate.path;
        if (
          !candidate.unavailable &&
          candidate.fingerprint !== undefined &&
          !checkCandidate(candidate, names) &&
          region.reference.get(key) === candidate.fingerprint
        )
          candidate.unavailable = gateUnchangedReason(region.runId);
      }
    }
    if (options.enumerateOnly || ledger?.planned(partition))
      artifact.candidates = candidates;
    if (options.enumerateOnly) {
      return artifact;
    }
    const sampled = new Set<string>();
    let ordered = candidates;
    if (ledger) {
      // A state's own controls first, then shared chrome, then controls an
      // earlier state enumerated but never finished.
      const own: Candidate[] = [];
      const chrome: Candidate[] = [];
      const earlier: Candidate[] = [];
      const planned: Candidate[] = [];
      for (const candidate of candidates) {
        const key = keyOf.get(candidate) ?? candidate.path;
        const requested = options.requestedActions?.some(
          (r) =>
            r.selector === candidate.path || r.selector === candidate.selector,
        );
        const entry = requested ? undefined : ledger.lookup(partition, key);
        const allocation = ledger.allocation(partition, key);
        if (requested && !candidate.unavailable) {
          planned.push(candidate);
          continue;
        }
        if (ledger.planned(partition)) {
          // Each round probes only its requeued work; earlier rounds' rows stay.
          const mine =
            allocation?.state === stateId && ledger.pending(partition, key);
          const explanation = explanationsByCandidate.get(candidate);
          if (explanation && !mine) sampled.add(explanation.selector);
          if (!allocation || allocation.reason) {
            notReached(
              candidate,
              allocation?.reason ?? "not in flow allocation",
            );
          } else if (!mine) {
            notReached(candidate, `assigned to state: ${allocation.state}`);
          } else planned.push(candidate);
          continue;
        }
        if (candidate.unavailable) {
          notReached(candidate, candidate.unavailable);
        } else if (entry) {
          reuse(candidate, entry);
          const explanation = explanationsByCandidate.get(candidate);
          if (explanation && entry.explanations.length > 0) {
            sampled.add(explanation.selector);
            artifact.explanations = mergeExplanations(artifact.explanations, {
              version: 1,
              status: "ran",
              records: entry.explanations.map((record) => ({
                ...record,
                selector: explanation.selector,
                controlId: explanation.controlId,
              })),
            });
          }
        } else if (ledger.enumeratedBefore(partition, key, stateId))
          earlier.push(candidate);
        else if (chromeRegion.test(candidate.region ?? ""))
          chrome.push(candidate);
        else own.push(candidate);
      }
      ledger.seen(partition, keys, stateId);
      // Individual actions before repeated rows within each priority group.
      ordered = [
        ...planned.sort(
          (a, b) =>
            ledger.priority(partition, a) - ledger.priority(partition, b) ||
            Number(!ledger.allocation(partition, keyOf.get(a) ?? a.path)?.own) -
              Number(
                !ledger.allocation(partition, keyOf.get(b) ?? b.path)?.own,
              ),
        ),
        ...individualsFirst(own),
        ...individualsFirst(chrome),
        ...individualsFirst(earlier),
      ];
    }
    if (!ledger)
      ordered = ordered.filter((candidate) => {
        if (!candidate.unavailable) return true;
        notReached(candidate, candidate.unavailable);
        return false;
      });
    queue = ordered.slice(0, options.maxControls);
    if (queue.length < ordered.length) {
      markPartial(
        `probed ${queue.length} of ${ordered.length} controls (checks.probe.maxControls)`,
      );
      for (const candidate of ordered.slice(options.maxControls))
        notReached(candidate, "checks.probe.maxControls");
    }
    type NestedTask = {
      item: Candidate;
      parents: Candidate[];
      parentName: string;
      key: string;
      /** The revealing control's effective rank. */
      rank: number;
    };
    /** Planned parents whose revealed items wait for their rank to come up. */
    const explorations: Array<{
      tasks: NestedTask[];
      rankOf: (task: NestedTask) => number;
      runTask: (task: NestedTask) => Promise<void>;
      finish: () => void;
    }> = [];
    // Run waiting nested items ranked above `limit`, best rank first and
    // deepest first within a rank.
    const drain = async (limit: number) => {
      for (;;) {
        let best:
          | {
              exploration: (typeof explorations)[number];
              index: number;
              rank: number;
              depth: number;
            }
          | undefined;
        for (const exploration of explorations)
          for (const [index, task] of exploration.tasks.entries()) {
            const rank = exploration.rankOf(task);
            if (rank >= limit) continue;
            if (
              !best ||
              rank < best.rank ||
              (rank === best.rank && task.parents.length > best.depth)
            )
              best = { exploration, index, rank, depth: task.parents.length };
          }
        if (!best) return;
        const [task] = best.exploration.tasks.splice(best.index, 1);
        state.check();
        if (task) await best.exploration.runTask(task);
        best.exploration.finish();
      }
    };
    /**
     * Once there is an action to replay held, the clicks leave it part of
     * the state budget: on a page with more controls than time, the held
     * replay would otherwise never run. With no flow target the state runs
     * until its work is done, so the held replays always follow the clicks.
     */
    const heldReserveMs =
      options.heldReplay && !options.unbounded
        ? Math.min(
            0.3 * stateTimeoutMs,
            2 *
              (3 * options.heldReplay.delayMs +
                controlTimeoutMs +
                (options.failureReplay
                  ? options.failureReplay.feedbackWithinMs + controlTimeoutMs
                  : 0)),
          )
        : 0;
    const reserved = () =>
      heldReserveMs > 0 &&
      (heldQueue.length > 0 || (options.heldReplay?.steps.length ?? 0) > 0) &&
      state.remaining() < heldReserveMs;
    for (const candidate of queue) {
      state.check();
      if (reserved()) {
        for (const rest of queue.slice(queue.indexOf(candidate)))
          if (!handled.has(rest)) notReached(rest, "held replay reserve");
        break;
      }
      // Top-level controls of a rank go before nested items of that rank.
      if (ledger?.planned(partition))
        await drain(ledger.priority(partition, candidate));
      const preSkip =
        candidate.intentReason ??
        (destructive.test(candidate.name) ? "destructive name" : undefined);
      if (preSkip === "destructive name" && safety)
        safety.skipped.destructive += 1;
      if (preSkip) {
        const result: ProbeResult = {
          ...skippedResult(candidate, preSkip),
          status: "completed",
          elapsedMs: 0,
        };
        publish(candidate, result);
        const explanation = explanationsByCandidate.get(candidate);
        if (explanation) {
          sampled.add(explanation.selector);
          const collector = new ExplanationCollector(options.page, "probe");
          collector.unavailable(explanation.selector, preSkip);
          artifact.explanations = mergeExplanations(
            artifact.explanations,
            collector.evidence(),
          );
        }
        ledger?.record(
          partition,
          keyOf.get(candidate) ?? candidate.path,
          stateId,
          result,
          [],
        );
        selector = candidate.selector;
        completed += 1;
        progress("done");
        continue;
      }
      const parentKey = keyOf.get(candidate) ?? candidate.path;
      if (ledger?.planned(partition))
        ledger.attempt(partition, parentKey, stateId);
      const outcome = await runAttempt(
        candidate,
        "observe",
        async (page, motion, collector, deadline, timeline) => {
          const explanation = explanationsByCandidate.get(candidate);
          // Intent skips (selected options, drag handles) are never hovered
          // or focused either, so they are checked before sampling.
          const skipped = intent
            ? await intentSkip(page, candidate)
            : undefined;
          deadline.check();
          if (skipped) {
            if (explanation) {
              sampled.add(explanation.selector);
              collector.unavailable(explanation.selector, skipped);
            }
            return { result: skippedResult(candidate, skipped) };
          }
          let explanationRecords: ExplanationRecord[] | undefined;
          if (explanation) {
            sampled.add(explanation.selector);
            progress("explanation");
            const ladder = async (active: Page) => {
              if (needsReplay || !(await settle(active, deadline)))
                await replay(active);
            };
            await sampleExplanation({
              page,
              candidate: explanation,
              collector,
              waitMs: options.waitMs,
              restore: ladder,
            });
            await ladder(page);
            explanationRecords = collector
              .evidence()
              .records.filter(
                (record) => record.selector === explanation.selector,
              );
          }
          // Selection skips always apply. Without the intent opt-in they
          // are checked after sampling, so the control keeps its hover and
          // focus evidence; only the no-op click is skipped.
          if (!intent) {
            const selected = await intentSkip(page, candidate, {
              selectionOnly: true,
            });
            deadline.check();
            if (selected)
              return {
                result: skippedResult(candidate, selected),
                ...(explanationRecords === undefined
                  ? {}
                  : { explanationRecords }),
              };
          }
          progress("observe");
          const positionedBefore = candidate.disclosure
            ? await positionedPaths(page)
            : [];
          const indicatorBefore =
            candidate.disclosure === undefined
              ? undefined
              : await indicatorOf(page, deadline, candidate.path);
          effects = new Set();
          let openedRoots: string[] = [];
          const outcome = await clickAndObserve(
            page,
            candidate.path,
            options.waitMs,
            motion,
            timeline,
            candidate.name,
            intent,
            effects,
            (roots) => {
              openedRoots = roots;
            },
            attemptTimings,
            clock,
            onBlocked,
            lateContentMs,
          );
          deadline.check();
          if (options.heldReplay && !outcome.error) {
            const last = timeline.lastAction();
            if (last?.source === "probe-click" && heldCandidate(last.requests))
              heldQueue.push({ candidate, sourceAction: last });
          }
          if (!outcome.error)
            snapSuspect = suspectSnap(candidate, timeline.lastAction());
          const { triggerBox: box, ...observedOutcome } = outcome;
          const result: ProbeResult = outcome.error
            ? skippedResult(candidate, `not clickable: ${outcome.error}`)
            : {
                ...skippedResult(candidate, ""),
                ...observedOutcome,
                skipped: undefined,
              };
          // A disclosure that opened in place: a plain positioned popover
          // has no region, so its own root supplies the nested items.
          let itemsRoot = openedRoots.join(", ");
          const leftPage = outcome.effects.some((effect) =>
            ["navigation", "popup", "download", "filechooser"].includes(effect),
          );
          if (candidate.disclosure && !outcome.error && !leftPage) {
            const found = await disclosureRoot(
              page,
              candidate,
              positionedBefore,
              openedRoots,
            );
            deadline.check();
            if (found.opened) {
              result.openedDisclosure = await openedDisclosureGeometry(
                page,
                candidate.path,
                found.root,
                candidate.disclosure,
              );
              deadline.check();
              const indicatorAfter =
                indicatorBefore === undefined
                  ? undefined
                  : await indicatorOf(page, deadline, candidate.path);
              if (
                indicatorBefore !== undefined &&
                indicatorAfter !== undefined
              ) {
                result.indicator = {
                  before: indicatorBefore,
                  after: indicatorAfter,
                };
                if (indicatorSummary) indicatorSummary.recorded += 1;
              }
              revealedRoots.set(candidate, found.root);
              if (itemsRoot === "" && found.root !== undefined)
                itemsRoot = found.root;
              const revealed = await observeRevealedState(page, deadline, {
                name: candidate.name,
                kind: candidate.disclosure,
                trigger: candidate.path,
                root: found.root,
              });
              if (revealed) result.revealed = revealed;
            }
          }
          if (!outcome.error && !leftPage && itemsRoot !== "" && box) {
            const inventory = await menuInventory(page, itemsRoot, deadline);
            deadline.check();
            if (inventory) result.menu = { ...box, ...inventory };
          }
          const items = itemsRoot
            ? (await enumerate(page, options.skip, itemsRoot, intent)).filter(
                (item) => item.path !== candidate.path,
              )
            : [];
          if (
            !outcome.error &&
            !leftPage &&
            candidate.disclosure !== "details"
          ) {
            const disclosure =
              candidate.disclosure === undefined
                ? undefined
                : revealedRoots.get(candidate);
            const dismissal = await testOpenedDismissal(
              page,
              deadline,
              candidate.path,
              {
                kind: candidate.disclosure,
                root: disclosure,
                openedRoots,
              },
              (active) => clickOpen(active, [candidate.path]),
            );
            if (dismissal) result.dismissal = dismissal;
            // A dismissal test that left the page leaves nothing to re-click.
            const reclick = leftByDismissal(dismissal)
              ? undefined
              : await testOpenedReclick(
                  page,
                  deadline,
                  candidate.path,
                  {
                    kind: candidate.disclosure,
                    root: disclosure,
                    openedRoots,
                    original: box?.trigger,
                  },
                  (active) => clickOpen(active, [candidate.path]),
                );
            if (reclick) result.reclick = reclick;
          }
          return {
            result,
            items,
            ...(explanationRecords === undefined ? {} : { explanationRecords }),
          };
        },
      );
      const suspect = snapSuspect;
      snapSuspect = undefined;
      if (
        suspect &&
        outcome?.result &&
        !outcome.result.skipped &&
        (outcome.items ?? []).length === 0
      )
        await confirmSnap(suspect);
      const tasks: NestedTask[] = [];
      const nested: ProbeResult[] = [];
      let nestedComplete = true;
      let nestedStarved = false;
      const discovered = new Set<string>();
      const enqueue = (
        items: Candidate[],
        parents: Candidate[],
        parentName: string,
        key: string,
        rank: number,
      ) => {
        for (const item of items) item.order = candidate.order;
        const keys = identityKeys(
          items.map((item) => ({
            ...item,
            role: item.role ?? "",
            signature: item.signature ?? item.path,
          })),
        );
        const identityOf = new Map(
          items.map((item, index) => [item, keys[index] ?? item.path]),
        );
        let eligible = items;
        if (ledger?.planned(partition)) {
          ledger.registerNames(partition, eligible);
          // Sample repeated groups in their saved DOM order before priority.
          eligible = eligible.filter((item) => {
            if (
              !item.repeatedGroup ||
              ledger.priority(partition, item) < ORDINARY_PRIORITY
            )
              return true;
            if (
              ledger.sample(
                partition,
                item.repeatedGroup,
                `${key} › ${identityOf.get(item)}`,
              )
            )
              return true;
            notReached(item, "repeated-row sample", parentName);
            return false;
          });
          eligible = [...eligible].sort(
            (a, b) =>
              ledger.priority(partition, a) - ledger.priority(partition, b),
          );
        } else eligible = individualsFirst(eligible);
        for (const [index, item] of eligible.entries()) {
          const identity = identityOf.get(item) ?? item.path;
          // A surface can reveal itself again. Never follow a cycle.
          if (discovered.has(identity)) continue;
          discovered.add(identity);
          item.order = candidate.order;
          if (index >= 20 || parents.length > 3) {
            notReached(item, "nested-menu limit", parentName);
            nestedComplete = false;
            continue;
          }
          tasks.push({
            item,
            parents,
            parentName,
            key: `${key} › ${identity}`,
            rank,
          });
          nestedQueue.push({ candidate: item, parent: parentName });
        }
      };
      const planned = ledger?.planned(partition) === true;
      // A tab inside a revealed surface is part of exploring its parent.
      const rankOf = (task: NestedTask) => {
        if (!ledger || !planned) return 0;
        const own = ledger.priority(partition, task.item);
        return task.item.role === "tab" ? Math.min(own, task.rank) : own;
      };
      enqueue(
        outcome?.items ?? [],
        [candidate],
        candidate.name,
        parentKey,
        planned && ledger ? ledger.priority(partition, candidate) : 0,
      );
      const runTask = async (task: NestedTask) => {
        const { item, parents, parentName, key: itemKey } = task;
        const skip =
          item.intentReason ??
          (destructive.test(item.name) ? "destructive name" : undefined);
        if (skip === "destructive name" && safety)
          safety.skipped.destructive += 1;
        if (skip) {
          const result: ProbeResult = {
            ...skippedResult(item, skip, parentName),
            status: "completed",
            elapsedMs: 0,
          };
          publish(item, result);
          nested.push(result);
          ledger?.record(partition, itemKey, stateId, result, []);
          return;
        }
        const cached = ledger?.lookup(partition, itemKey);
        if (cached) {
          reuse(item, cached, parentName);
          const reused = artifact.results.at(-1);
          if (reused) nested.push(reused);
          return;
        }
        // The probe's own check candidates are bounded by the state deadline
        // only; ordinary nested items share the small nested budget.
        const candidateItem =
          ledger?.planned(partition) === true &&
          ledger.priority(partition, item) < ORDINARY_PRIORITY;
        const remaining = candidateItem
          ? controlTimeoutMs
          : nestedBudgetMs() - nestedUsed;
        if (remaining < 1) {
          notReached(item, "nested-menu budget", parentName);
          nestedComplete = false;
          nestedStarved = true;
          return;
        }
        const begun = clock();
        const value = await runAttempt(
          item,
          "nested menu",
          async (page, motion, _collector, deadline, timeline) => {
            for (const parent of parents) {
              const window = await beginEffectWindow(page, options.waitMs);
              try {
                await measure("clickMs", () =>
                  page
                    .locator(parent.path)
                    .first()
                    .click({ timeout: 1500, noWaitAfter: true }),
                );
                await measure("effectWindowMs", () => window.wait());
              } finally {
                await window.dispose();
              }
            }
            const skipped = await intentSkip(page, item, {
              selectionOnly: !intent,
            });
            deadline.check();
            if (skipped)
              return { result: skippedResult(item, skipped, parentName) };
            // One step below a disclosure, an item may switch it into a new
            // mode (a field appears, a surface opens) worth checking too.
            const disclosureParent =
              parents.length === 1 && parents[0]?.disclosure !== undefined
                ? parents[0]
                : undefined;
            const fieldsBefore = disclosureParent
              ? await visibleFields(page)
              : [];
            // A nested item that is itself a disclosure (a drawer's menu
            // button) opens an overlay the dismissal pass tests too.
            const positionedBefore =
              item.disclosure !== undefined && item.disclosure !== "details"
                ? await positionedPaths(page)
                : [];
            const indicatorBefore =
              item.disclosure === undefined
                ? undefined
                : await indicatorOf(page, deadline, item.path);
            effects = new Set();
            let openedRoots: string[] = [];
            const result = await clickAndObserve(
              page,
              item.path,
              options.waitMs,
              motion,
              timeline,
              `${parentName} › ${item.name}`,
              intent,
              effects,
              (roots) => {
                openedRoots = roots;
              },
              attemptTimings,
              clock,
              onBlocked,
              lateContentMs,
            );
            const opened =
              item.disclosure !== undefined &&
              !result.error &&
              !result.effects.some((effect) =>
                ["navigation", "popup", "download", "filechooser"].includes(
                  effect,
                ),
              )
                ? await disclosureRoot(
                    page,
                    item,
                    positionedBefore,
                    openedRoots,
                  )
                : undefined;
            const openedDisclosure =
              opened?.opened && item.disclosure !== undefined
                ? await openedDisclosureGeometry(
                    page,
                    item.path,
                    opened.root,
                    item.disclosure,
                  )
                : undefined;
            deadline.check();
            const indicatorAfter =
              opened?.opened && indicatorBefore !== undefined
                ? await indicatorOf(page, deadline, item.path)
                : undefined;
            const indicator =
              indicatorBefore !== undefined && indicatorAfter !== undefined
                ? { before: indicatorBefore, after: indicatorAfter }
                : undefined;
            if (indicator !== undefined && indicatorSummary)
              indicatorSummary.recorded += 1;
            let revealed: RevealedState | undefined;
            if (
              disclosureParent &&
              !result.error &&
              !result.effects.some((effect) =>
                ["navigation", "popup", "download", "filechooser"].includes(
                  effect,
                ),
              )
            ) {
              const earlier = new Set(fieldsBefore);
              const newField = (await visibleFields(page)).some(
                (path) => !earlier.has(path),
              );
              deadline.check();
              if (newField || openedRoots.length > 0)
                revealed = await observeRevealedState(page, deadline, {
                  name: `${parentName} › ${item.name}`,
                  kind: "mode",
                  trigger: item.path,
                  root: revealedRoots.get(disclosureParent),
                });
            }
            const items = openedRoots.length
              ? await enumerate(
                  page,
                  options.skip,
                  openedRoots.join(", "),
                  intent,
                )
              : [];
            const nestedDisclosure =
              item.disclosure === "details" ? undefined : item.disclosure;
            const testable =
              item.disclosure !== "details" &&
              !result.error &&
              !result.effects.some((effect) =>
                ["navigation", "popup", "download", "filechooser"].includes(
                  effect,
                ),
              );
            deadline.check();
            const dismissal = testable
              ? await testOpenedDismissal(
                  page,
                  deadline,
                  item.path,
                  {
                    kind: nestedDisclosure,
                    root: opened?.opened ? opened.root : undefined,
                    openedRoots,
                  },
                  (active) =>
                    clickOpen(active, [
                      ...parents.map((parent) => parent.path),
                      item.path,
                    ]),
                )
              : undefined;
            const reclick =
              testable && !leftByDismissal(dismissal)
                ? await testOpenedReclick(
                    page,
                    deadline,
                    item.path,
                    {
                      kind: nestedDisclosure,
                      root: opened?.opened ? opened.root : undefined,
                      openedRoots,
                      original: result.triggerBox?.trigger,
                    },
                    (active) =>
                      clickOpen(active, [
                        ...parents.map((parent) => parent.path),
                        item.path,
                      ]),
                  )
                : undefined;
            return {
              items,
              result: result.error
                ? skippedResult(
                    item,
                    `not clickable: ${result.error}`,
                    parentName,
                  )
                : {
                    ...skippedResult(item, "", parentName),
                    ...withoutTriggerBox(result),
                    skipped: undefined,
                    ...(openedDisclosure === undefined
                      ? {}
                      : { openedDisclosure }),
                    ...(revealed === undefined ? {} : { revealed }),
                    ...(dismissal === undefined ? {} : { dismissal }),
                    ...(indicator === undefined ? {} : { indicator }),
                    ...(reclick === undefined ? {} : { reclick }),
                  },
            };
          },
          parentName,
          Math.min(controlTimeoutMs, remaining),
        );
        if (!candidateItem) nestedUsed += Math.max(0, clock() - begun);
        enqueue(
          value?.items ?? [],
          [...parents, item],
          `${parentName} › ${item.name}`,
          itemKey,
          rankOf(task),
        );
        const published = artifact.results.at(-1);
        if (value?.result && published?.status === "completed") {
          nested.push(published);
          ledger?.record(partition, itemKey, stateId, published, []);
        } else nestedComplete = false;
      };
      const finish = () => {
        const published = artifact.results.find(
          (result) =>
            ranks.get(result) === candidate.order &&
            result.selector === candidate.selector &&
            result.status === "completed",
        );
        // A control is reused only when it and every nested item finished;
        // otherwise a later state that shows it gets another chance.
        // An incomplete explanation sample is not reused: the glyph-only pass
        // samples it again at the later state, without another click.
        const explanationRecords = outcome?.explanationRecords ?? [];
        if (
          ledger &&
          published &&
          (nestedComplete || ledger.planned(partition))
        )
          ledger.record(
            partition,
            parentKey,
            stateId,
            { ...published },
            explanationRecords.some((record) => record.status === "unavailable")
              ? []
              : explanationRecords,
            nested,
            nestedStarved || tasks.length > 0,
          );
        else if (ledger?.planned(partition) && !published)
          ledger.fail(partition, parentKey, stateId);
      };
      if (planned) {
        // Record now; drained nested results are appended as they finish.
        finish();
        explorations.push({ tasks, rankOf, runTask, finish });
      } else {
        for (let task = tasks.shift(); task; task = tasks.shift())
          await runTask(task);
        finish();
      }
    }
    await drain(Number.POSITIVE_INFINITY);
    // Held replays use the reserve the clicks left them, before the
    // explanation and collection passes take what remains.
    effects = undefined;
    await heldPhase();
    effects = undefined;
    await selectionPhase(candidates.map((candidate) => candidate.path));
    effects = undefined;
    // Glyph links receive explanations without becoming click candidates.
    for (const explanation of explanations.filter(
      (item) => !sampled.has(item.selector),
    )) {
      await runAttempt(
        {
          path: explanation.selector,
          selector: explanation.selector,
          name: "",
          repeated: false,
        },
        "explanation",
        async (page, _motion, collector, deadline) => {
          const skip = await page
            .locator(explanation.selector)
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
          if (skip || sampled.size >= options.maxControls) {
            collector.unavailable(
              explanation.selector,
              skip ? "checks.probe.skip" : "checks.probe.maxControls",
            );
            return {};
          }
          sampled.add(explanation.selector);
          await sampleExplanation({
            page,
            candidate: explanation,
            collector,
            waitMs: options.waitMs,
            restore: async (active) => {
              if (needsReplay || !(await settle(active, deadline)))
                await replay(active);
            },
          });
          return {};
        },
      );
    }
    if (options.collections?.length) artifact.collections = [];
    for (const itemSelector of options.collections ?? []) {
      const collectionStarted = Date.now();
      const entry: ProbeCollection = { selector: itemSelector, menus: [] };
      artifact.collections?.push(entry);
      let triggers: Array<{ selector: string; name: string }> = [];
      await runAttempt(
        {
          path: itemSelector,
          selector: itemSelector,
          name: "collection",
          repeated: false,
        },
        "collection discovery",
        async (page) => {
          await replay(page);
          const item = page
            .locator(itemSelector)
            .filter({ visible: true })
            .first();
          if (!(await item.count())) {
            entry.reason = "no rendered item";
            return {};
          }
          await item.hover({ timeout: 1500 }).catch(() => undefined);
          const matches = item
            .locator('[aria-haspopup="menu"], [aria-haspopup="true"]')
            .or(
              item.getByRole("button", {
                name: menuTriggerPattern,
                includeHidden: true,
              }),
            );
          triggers = await matches.evaluateAll((elements) =>
            elements.slice(0, 3).map((element) => {
              const parts: string[] = [];
              let current: Element | null = element;
              while (current && current !== document.documentElement) {
                const node: Element = current;
                const siblings = [
                  ...(node.parentElement?.children ?? []),
                ].filter((child) => child.tagName === node.tagName);
                parts.unshift(
                  `${node.tagName.toLowerCase()}:nth-of-type(${siblings.indexOf(node) + 1})`,
                );
                current = node.parentElement;
              }
              return {
                selector: element.id
                  ? `#${CSS.escape(element.id)}`
                  : `html > ${parts.join(" > ")}`,
                name: (
                  element.getAttribute("aria-label") ||
                  (element as HTMLElement).innerText ||
                  element.getAttribute("title") ||
                  ""
                ).trim(),
              };
            }),
          );
          return {};
        },
      );
      for (const trigger of [
        ...triggers,
        { selector: itemSelector, name: "right-click" },
      ]) {
        const candidate = {
          path: trigger.selector,
          selector: trigger.selector,
          name: trigger.name,
          repeated: false,
        };
        const value = await runAttempt(
          candidate,
          "collection",
          async (page) => {
            await replay(page);
            const item = page
              .locator(itemSelector)
              .filter({ visible: true })
              .first();
            await item.hover({ timeout: 1500 }).catch(() => undefined);
            const before = await visibleMenuItems(page);
            effects = new Set();
            await page
              .locator(trigger.selector)
              .first()
              .click({
                button: trigger.name === "right-click" ? "right" : "left",
                timeout: 1500,
                noWaitAfter: true,
              });
            await page.waitForTimeout(options.waitMs);
            const items = appeared(await visibleMenuItems(page), before);
            await page.keyboard.press("Escape");
            // Publication occurs only after all guarded awaits completed.
            entry.menus.push({
              trigger:
                trigger.name === "right-click" ? "contextmenu" : "button",
              name: trigger.name,
              items,
            });
            return {};
          },
        );
        if (!value)
          entry.reason = `collection sampling timed-out: ${trigger.selector}`;
      }
      entry.elapsedMs = Date.now() - collectionStarted;
    }
    effects = undefined;
    selector = "html";
    progress("restore");
    if (needsReplay && current) {
      const final = deadlinePage(current, state);
      try {
        await state.run(() => restore(final.page));
      } finally {
        final.dispose();
      }
    }
  } catch (error) {
    if (options.signal?.aborted) throw options.signal.reason;
    if (
      state.signal.aborted ||
      (error instanceof DeadlineExpired && error.scope === "state")
    ) {
      artifact.status = "timed-out";
      const expiration = state.signal.reason;
      artifact.reason =
        expiration instanceof DeadlineExpired
          ? expiration.message
          : `state timed-out: ${selector} (${activity})`;
      artifact.selector = selector;
      artifact.step =
        expiration instanceof DeadlineExpired ? expiration.activity : activity;
      if (
        activeCandidate &&
        !artifact.results.some(
          (result) =>
            result.selector === activeCandidate?.selector &&
            result.status === "timed-out",
        )
      ) {
        publish(activeCandidate, {
          ...skippedResult(activeCandidate, artifact.reason, activeParent),
          effects: [...(effects ?? [])],
          status: "timed-out",
          timeoutScope: "state",
          elapsedMs: Math.max(0, clock() - activeStarted),
        });
      }
      // Every queued control the state budget never reached is reported.
      for (const candidate of queue)
        if (!handled.has(candidate)) notReached(candidate, budgetReason);
      for (const { candidate, parent } of nestedQueue)
        if (!handled.has(candidate))
          notReached(candidate, budgetReason, parent);
      retire();
      progress("state timed-out");
    } else {
      const reason = `probe stopped early: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`;
      markPartial(reason);
      if (activeCandidate && !handled.has(activeCandidate))
        publish(activeCandidate, {
          ...skippedResult(activeCandidate, reason, activeParent),
          status: "completed",
          elapsedMs: Math.max(0, clock() - activeStarted),
          timings: attemptTimings ? { ...attemptTimings } : undefined,
        });
      for (const candidate of queue)
        if (!handled.has(candidate)) notReached(candidate, reason);
      for (const { candidate, parent } of nestedQueue)
        if (!handled.has(candidate)) notReached(candidate, reason, parent);
    }
  } finally {
    if (failureSummary && artifact.status !== "ran")
      failureSummary.notes.push(
        artifact.reason ?? "probe interrupted before replay coverage completed",
      );
    if (artifact.status !== "ran" && explanationIdentities.length) {
      const missing = new ExplanationCollector(options.page);
      for (const candidate of explanationIdentities) {
        if (
          !artifact.explanations?.records.some(
            (record) => record.selector === candidate.selector,
          )
        )
          missing.unavailable(
            candidate.selector,
            artifact.reason ?? "probe incomplete",
          );
      }
      artifact.explanations = mergeExplanations(
        artifact.explanations,
        missing.evidence(),
      );
    }
    artifact.motion ??= initialMotion?.evidence(artifact.reason);
    if (timelines) options.onTimelines?.(timelines);
    artifact.results = artifact.results
      .map((result, index) => ({ result, index }))
      .sort(
        (a, b) =>
          (ranks.get(a.result) ?? Number.POSITIVE_INFINITY) -
            (ranks.get(b.result) ?? Number.POSITIVE_INFINITY) ||
          a.index - b.index,
      )
      .map(({ result }) => result);
    await Promise.all([...preparations.values()].map((dispose) => dispose()));
    preparations.clear();
    context.off("page", onNewPage);
    // The capture page is reused for the next tuple, whose own steps may
    // submit forms: the mutation block must be gone before returning.
    await Promise.all([...protections.values()].map((dispose) => dispose()));
    await context.unroute("**/*", onContextRoute).catch(() => undefined);
    state.dispose();
    options.flowBudget?.finish(Math.max(0, clock() - stateStarted));
    if (safety) artifact.safety = safety;
    progress("complete");
  }
  return artifact;
}

import type {
  Dialog,
  Download,
  FileChooser,
  Page,
  Request,
  Route,
} from "playwright";
import { menuTriggerPattern } from "../checks/collection-actions.js";
import type {
  ExplanationRecord,
  ProbeArtifact,
  ProbeAttemptTimings,
  ProbeCollection,
  ProbeEffect,
  ProbeResult,
} from "../checks/types.js";
import { Deadline, DeadlineExpired, deadlinePage } from "./deadline.js";
import { beginEffectWindow } from "./effect-window.js";
import {
  type ExplanationCandidate,
  ExplanationCollector,
  explanationCandidates,
  mergeExplanations,
  sampleExplanation,
} from "./explanations.js";
import { MotionCollector, mergeMotion } from "./motion.js";
import {
  identityKeys,
  ORDINARY_PRIORITY,
  type ProbeLedger,
  type ProbeLedgerEntry,
} from "./probe-ledger.js";
import type { CaptureHooks } from "./types.js";

export type ProbeOptions = CaptureHooks & {
  page: Page;
  enumerateOnly?: boolean | undefined;
  flowBudget?: import("./probe-budget.js").ProbeBudgetLease | undefined;
  /** Replay on the supplied disposable page, including replacement pages. */
  restore: (page: Page) => Promise<void>;
  replacePage?: (() => Promise<Page>) | undefined;
  controlTimeoutMs?: number | undefined;
  stateTimeoutMs?: number | undefined;
  monotonicNow?: (() => number) | undefined;
  skip: string[];
  maxControls: number;
  waitMs: number;
  motionSelectors?: string[] | undefined;
  respectControlIntent?: boolean;
  explanation?: "default" | "visible" | undefined;
  collections?: string[] | undefined;
  /**
   * Flow-scoped results of earlier states. A control whose identity already
   * has a completed result is not clicked again; its result is reused.
   */
  ledger?: ProbeLedger | undefined;
  /** This state's id, recorded as `reusedFrom` by later states. */
  stateId?: string | undefined;
  /** Ledger partition: the tuple's viewport and colour scheme. */
  ledgerPartition?: string | undefined;
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
  region?: string | undefined;
  /** Explicit or implicit role, part of the control's identity. */
  role?: string | undefined;
  /** `#id`, or the control's and its parent's tag and sorted classes. */
  signature?: string | undefined;
  /** Enumeration position; results are published in this order. */
  order?: number | undefined;
  unavailable?: string | undefined;
  intentReason?: string | undefined;
};

type Candidate = ProbeCandidate;

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

/**
 * Names that must never be clicked by an automated probe, because the click
 * would destroy or publish fixture data rather than reveal behaviour.
 */
const destructive =
  /\b(delete|remove|sign ?out|log ?out|publish|unpublish|reset|discard|clear all|archive|deactivate|unsubscribe|pay|purchase|buy|checkout|send|submit order)\b/i;

const safeMethods = new Set(["GET", "HEAD", "OPTIONS"]);

const ignoredRequest = (request: Request) =>
  /(?:webpack-hmr|__nextjs|_next\/static|hot-update|favicon|\/__vite|sockjs)/.test(
    request.url(),
  );

/** The same request policy applies to focus sweeps and every probe context. */
export function probeRequestAllowed(request: Request): boolean {
  return safeMethods.has(request.method()) || ignoredRequest(request);
}

async function installInstrumentation(
  page: Page,
  respectControlIntent: boolean,
): Promise<void> {
  await page.evaluate((respectControlIntent) => {
    const scope = window as unknown as {
      __idiomProbe?: {
        mutations: number;
        aria: number;
        clipboard: number;
        popups: number;
      };
      __idiomCleanup?: () => void;
      __idiomPickerCount?: () => number;
      __idiomObserver?: MutationObserver;
      __idiomRecords?: Array<{
        target: Node;
        type: MutationRecordType;
        attributeName: string | null;
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
    const state = { mutations: 0, aria: 0, clipboard: 0, popups: 0 };
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
      return (
        element.closest(
          "[role=tooltip], [data-radix-popper-content-wrapper]",
        ) !== null || element.querySelector?.("[role=tooltip]") !== null
      );
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
        __idiomSuppressed?: { print: number; popup: number };
      }
    ).__idiomSuppressed;
    if (suppressed) {
      suppressed.print = 0;
      suppressed.popup = 0;
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
      };
    };
    return {
      ...(scope.__idiomProbe ?? {
        mutations: 0,
        aria: 0,
        clipboard: 0,
        popups: 0,
      }),
      pickers: scope.__idiomPickerCount?.() ?? 0,
      prints:
        (window as unknown as { __idiomSuppressed?: { print: number } })
          .__idiomSuppressed?.print ?? 0,
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
      const controlSelector =
        "button, summary, [role=button], [role=menuitem], [role=menuitemradio], [role=menuitemcheckbox], input[type=button], input[type=submit]";
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
        result.push({
          repeated,
          ...(repeatedGroup ? { repeatedGroup } : {}),
          textLabel: /\p{L}{2}/u.test(html.innerText ?? ""),
          modal: modal !== undefined,
          ...(haspopup !== null && haspopup !== "false" ? { popup: true } : {}),
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

async function intentSkip(
  page: Page,
  candidate: Candidate,
): Promise<string | undefined> {
  return (
    page
      .locator(candidate.path)
      .first()
      .evaluate(
        (control) => {
          for (const attribute of [
            "aria-pressed",
            "aria-selected",
            "aria-checked",
          ]) {
            if (control.getAttribute(attribute) === "true")
              return `already selected: ${attribute}`;
          }
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
        undefined,
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

async function clickAndObserve(
  page: Page,
  path: string,
  waitMs: number,
  motion: MotionCollector,
  name: string,
  respectControlIntent: boolean,
  observed: Set<ProbeEffect>,
  onOpened?: (selectors: string[]) => void,
  timings?: ProbeAttemptTimings,
  clock = () => performance.now(),
): Promise<{
  effects: ProbeEffect[];
  signature?: string;
  primary?: boolean;
  error?: string;
}> {
  // Hover first and let any tooltip settle, so the click is measured alone.
  const hover = await motion.start({
    source: "probe-hover",
    selector: path,
    name,
  });
  try {
    await page
      .locator(path)
      .first()
      .hover({ timeout: 1500 })
      .catch(() => undefined);
    await page.waitForTimeout(120);
    await hover.finish();
  } finally {
    await hover.dispose();
  }
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
  let openedPicker = false;
  let effectWindow: Awaited<ReturnType<typeof beginEffectWindow>> | undefined;
  try {
    await installInstrumentation(page, respectControlIntent);
    click = await motion.start({ source: "probe-click", selector: path, name });
    effectWindow = await beginEffectWindow(page, waitMs);
    const clickStarted = clock();
    try {
      await page
        .locator(path)
        .first()
        .click({ timeout: 1500, noWaitAfter: true });
    } catch (error) {
      await click.finish("control was not clicked successfully");
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
      try {
        await effectWindow.wait();
      } finally {
        if (timings) timings.effectWindowMs += clock() - effectStarted;
      }
      await click.finish();
    } finally {
      await click.dispose();
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
    }));
    if (counters.prints > 0) effects.add("print");
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
    if (requests.length > 0) effects.add("network");
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
    const opened = after.revealed.filter(
      (name) => !before.revealed.includes(name),
    );
    onOpened?.(
      after.regions
        .filter((region) => opened.includes(region.name))
        .map((region) => region.selector),
    );
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
    if (openedPicker)
      await page.keyboard.press("Escape").catch(() => undefined);
  }
}

/** Probe-only shims run before application scripts in replayed documents/frames. */
function suppressNativeUi() {
  const scope = window as unknown as {
    __idiomSuppressed?: { print: number; popup: number };
  };
  if (scope.__idiomSuppressed) return;
  const counters = { print: 0, popup: 0 };
  scope.__idiomSuppressed = counters;
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

/** Every continuation uses an attempt-local page and can publish only while valid. */
export async function probeControls(
  options: ProbeOptions,
): Promise<ProbeArtifact> {
  const clock = options.monotonicNow ?? (() => performance.now());
  const artifact: ProbeArtifact = { status: "ran", results: [] };
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
  const state = new Deadline(
    "state",
    stateTimeoutMs,
    () => `${selector} (${activity})`,
    { signal: options.signal },
  );
  options.flowBudget?.start(state);
  // A full replay runs on its own budget, never inside the next control's.
  const restoreBudgetMs = Math.max(controlTimeoutMs, 15000);
  // Nested menu items share one small budget so they cannot starve the
  // top-level controls.
  const nestedBudgetMs = () =>
    options.flowBudget
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
    void protections.get(page)?.();
    protections.delete(page);
    void page.close({ runBeforeUnload: false }).then(
      () => owned.delete(page),
      () => undefined,
    );
  };
  const onNewPage = (page: Page) => {
    if (!creating && !owned.has(page)) {
      effects?.add("popup");
      close(page);
    }
  };
  context.on("page", onNewPage);
  const onContextRoute = (route: Route) => {
    if (replaying > 0 || probeRequestAllowed(route.request()))
      return route.fallback();
    effects?.add("network");
    return route.abort("blockedbyclient").catch(() => undefined);
  };
  const protect = async (page: Page, deadline: Deadline) => {
    const onDialog = (dialog: Dialog) => {
      effects?.add("dialog");
      if (dialog.type() === "beforeunload") retireAfterAttempt = true;
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
      void download.cancel().catch(() => undefined);
    };
    const onPopup = (popup: Page) => {
      effects?.add("popup");
      close(popup);
    };
    const onRequest = (request: Request) => {
      if (!ignoredRequest(request)) effects?.add("network");
    };
    const onRoute = onContextRoute;
    page.on("dialog", onDialog);
    page.on("filechooser", onFileChooser);
    page.on("download", onDownload);
    page.on("popup", onPopup);
    page.on("request", onRequest);
    protections.set(page, () => {
      page.off("dialog", onDialog);
      page.off("filechooser", onFileChooser);
      page.off("download", onDownload);
      page.off("popup", onPopup);
      page.off("request", onRequest);
      return page.unroute("**/*", onRoute).catch(() => undefined);
    });
    await deadline.run(() => page.route("**/*", onRoute));
    await deadline.run(() => page.addInitScript(suppressNativeUi));
    for (const frame of page.frames())
      await deadline.run(() => frame.evaluate(suppressNativeUi));
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
    if (reason.startsWith("assigned to state:")) return;
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
    let explanation: ExplanationCollector | undefined;
    let value: AttemptValue | undefined;
    try {
      value = await deadline.run(async () => {
        const realPage = await ensurePage(deadline);
        deadline.check();
        bound = deadlinePage(realPage, deadline);
        const page = bound.page;
        motion = new MotionCollector(page, options.motionSelectors);
        explanation = new ExplanationCollector(page, "probe", options.waitMs);
        await motion.initialize();
        deadline.check();
        progress(phase);
        const value = await work(page, motion, explanation, deadline);
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
  /** Copy a result probed at an earlier state onto this state's control. */
  const reuse = (
    candidate: Candidate,
    entry: ProbeLedgerEntry,
    parent?: string,
  ) => {
    const {
      elapsedMs: _elapsed,
      timings: _timings,
      timeoutScope: _scope,
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
      const { elapsedMs: _nestedElapsed, ...rest } = nested;
      publish(candidate, {
        ...rest,
        status: "completed",
        reusedFrom: entry.state,
      });
    }
  };
  try {
    // Context routing also guards a popup's very first request. Page routing
    // remains in place so an earlier library caller's route cannot bypass it.
    await state.run(() => context.route("**/*", onContextRoute));
    await state.run(() => protect(options.page, state));
    const initial = deadlinePage(options.page, state);
    let candidates: Candidate[];
    let explanations: ExplanationCandidate[] = [];
    const explanationsByCandidate = new Map<Candidate, ExplanationCandidate>();
    try {
      const motion = new MotionCollector(initial.page, options.motionSelectors);
      initialMotion = motion;
      await state.run(() => motion.initialize());
      // Visible mode samples every glyph control; the default samples only
      // text glyphs such as "?", whose missing tooltip it reports.
      explanations = await state.run(() =>
        explanationCandidates(
          initial.page,
          options.explanation === "visible" ? {} : { textGlyphsOnly: true },
        ),
      );
      explanationIdentities = explanations;
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
        const entry = ledger.lookup(partition, key);
        const allocation = ledger.allocation(partition, key);
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
    for (const candidate of queue) {
      state.check();
      // Top-level controls of a rank go before nested items of that rank.
      if (ledger?.planned(partition))
        await drain(ledger.priority(partition, candidate));
      const preSkip =
        candidate.intentReason ??
        (destructive.test(candidate.name) ? "destructive name" : undefined);
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
        async (page, motion, collector, deadline) => {
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
          progress("observe");
          effects = new Set();
          let openedRoots: string[] = [];
          const outcome = await clickAndObserve(
            page,
            candidate.path,
            options.waitMs,
            motion,
            candidate.name,
            intent,
            effects,
            (roots) => {
              openedRoots = roots;
            },
            attemptTimings,
            clock,
          );
          deadline.check();
          const result: ProbeResult = outcome.error
            ? skippedResult(candidate, `not clickable: ${outcome.error}`)
            : {
                ...skippedResult(candidate, ""),
                ...outcome,
                skipped: undefined,
              };
          const items = openedRoots.length
            ? await enumerate(
                page,
                options.skip,
                openedRoots.join(", "),
                intent,
              )
            : [];
          return {
            result,
            items,
            ...(explanationRecords === undefined ? {} : { explanationRecords }),
          };
        },
      );
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
          async (page, motion, _collector, deadline) => {
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
            const skipped = intent ? await intentSkip(page, item) : undefined;
            deadline.check();
            if (skipped)
              return { result: skippedResult(item, skipped, parentName) };
            effects = new Set();
            let openedRoots: string[] = [];
            const result = await clickAndObserve(
              page,
              item.path,
              options.waitMs,
              motion,
              `${parentName} › ${item.name}`,
              intent,
              effects,
              (roots) => {
                openedRoots = roots;
              },
              attemptTimings,
              clock,
            );
            const items = openedRoots.length
              ? await enumerate(
                  page,
                  options.skip,
                  openedRoots.join(", "),
                  intent,
                )
              : [];
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
                    ...result,
                    skipped: undefined,
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
        if (!handled.has(candidate))
          notReached(
            candidate,
            options.flowBudget ? "flow budget share" : "state budget",
          );
      for (const { candidate, parent } of nestedQueue)
        if (!handled.has(candidate))
          notReached(
            candidate,
            options.flowBudget ? "flow budget share" : "state budget",
            parent,
          );
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
    artifact.results = artifact.results
      .map((result, index) => ({ result, index }))
      .sort(
        (a, b) =>
          (ranks.get(a.result) ?? Number.POSITIVE_INFINITY) -
            (ranks.get(b.result) ?? Number.POSITIVE_INFINITY) ||
          a.index - b.index,
      )
      .map(({ result }) => result);
    context.off("page", onNewPage);
    // The capture page is reused for the next tuple, whose own steps may
    // submit forms: the mutation block must be gone before returning.
    await Promise.all([...protections.values()].map((dispose) => dispose()));
    await context.unroute("**/*", onContextRoute).catch(() => undefined);
    state.dispose();
    options.flowBudget?.finish(Math.max(0, clock() - stateStarted));
    progress("complete");
  }
  return artifact;
}

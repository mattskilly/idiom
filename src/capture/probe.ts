import type { Dialog, Download, FileChooser, Page, Request } from "playwright";
import { menuTriggerPattern } from "../checks/collection-actions.js";
import type {
  ProbeArtifact,
  ProbeCollection,
  ProbeEffect,
  ProbeResult,
} from "../checks/types.js";

import { Deadline, DeadlineExpired, deadlinePage } from "./deadline.js";
import {
  type ExplanationCandidate,
  ExplanationCollector,
  explanationCandidates,
  mergeExplanations,
  sampleExplanation,
} from "./explanations.js";
import { MotionCollector, mergeMotion } from "./motion.js";
import type { CaptureHooks } from "./types.js";

export type ProbeOptions = CaptureHooks & {
  page: Page;
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
};

type Candidate = {
  path: string;
  selector: string;
  name: string;
  repeated: boolean;
  region?: string | undefined;
};

type Snapshot = {
  url: string;
  revealed: string[];
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

const ignoredRequest = (request: Request) =>
  /(?:webpack-hmr|__nextjs|_next\/static|hot-update|favicon|\/__vite|sockjs)/.test(
    request.url(),
  );

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
  const revealed = await page.evaluate(() => {
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
      "dialog[open], [role=dialog], [role=alertdialog], [role=menu], [role=listbox], [role=region], aside, [aria-modal=true], [popover]",
    );
    const names: string[] = [];
    for (const region of regions) {
      if (!visible(region)) continue;
      const role = region.getAttribute("role") ?? region.tagName.toLowerCase();
      const heading = region.querySelector("h1, h2, h3, h4, [role=heading]");
      const name =
        region.getAttribute("aria-label") ??
        (text(region.getAttribute("aria-labelledby")) ||
          (heading?.textContent ?? "").replace(/\s+/g, " ").trim());
      names.push(`${role}:${name.slice(0, 80)}`);
    }
    return names.sort();
  });
  return { url: page.url(), revealed };
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
      const scope =
        rootSelector === undefined
          ? document
          : document.querySelector(rootSelector);
      if (scope === null) return [];
      const controlSelector =
        "button, summary, [role=button], [role=menuitem], [role=menuitemradio], [role=menuitemcheckbox], input[type=button], input[type=submit]";
      const selectedSelector =
        "input[type=radio]:checked, [role=tab][aria-selected=true], [role=radio][aria-checked=true]";
      const controls = scope.querySelectorAll(
        respectControlIntent
          ? `${controlSelector}, ${selectedSelector}`
          : controlSelector,
      );
      const nameOf = (element: Element) =>
        (
          element.getAttribute("aria-label") ??
          ((element as HTMLElement).innerText ||
            element.getAttribute("title") ||
            "")
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
      }> = [];
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
              parent.closest("[role=toolbar], [role=menubar]") !== null;
            repeated =
              toolbar && transparent(current)
                ? alike.filter((member) => {
                    const inner = controlIn(member);
                    return inner !== null && nameOf(inner) === name;
                  }).length >= 3
                : true;
          }
          current = parent;
        }
        const region = regionOf(control);
        result.push({
          repeated,
          path: pathFor(control),
          selector: control.id
            ? `#${CSS.escape(control.id)}`
            : pathFor(control),
          name,
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
  try {
    await installInstrumentation(page, respectControlIntent);
    click = await motion.start({ source: "probe-click", selector: path, name });
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
    }
    try {
      await page.waitForTimeout(waitMs);
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
  const state = new Deadline(
    "state",
    options.stateTimeoutMs ?? 60000,
    () => `${selector} (${activity})`,
    { signal: options.signal },
  );
  let current: Page | undefined = options.page;
  let dirty = false;
  let effects: Set<ProbeEffect> | undefined;
  const owned = new Set<Page>([options.page]);
  const protections = new Map<Page, () => void>();
  let creating = false;
  let retireAfterAttempt = false;
  const context = options.page.context();
  const close = (page: Page) => {
    protections.get(page)?.();
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
    });
    await deadline.run(() => page.addInitScript(suppressNativeUi));
    for (const frame of page.frames())
      await deadline.run(() => frame.evaluate(suppressNativeUi));
  };
  const retire = () => {
    effects = undefined;
    if (current) close(current);
    current = undefined;
    dirty = true;
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
  const intent = options.respectControlIntent === true;
  type AttemptValue = { result?: ProbeResult; items?: Candidate[] };
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
  ): Promise<AttemptValue | undefined> => {
    state.check();
    selector = candidate.selector;
    progress(phase);
    const started = clock();
    const deadline = new Deadline(
      "control",
      Math.min(options.controlTimeoutMs ?? 5000, state.remaining()),
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
        if (dirty) {
          progress(`${phase}: restore`);
          await options.restore(page);
          deadline.check();
          dirty = false;
        }
        await motion.initialize();
        deadline.check();
        progress(phase);
        return await work(page, motion, explanation, deadline);
      });
      deadline.check();
      if (value.result)
        artifact.results.push({
          ...value.result,
          status: "completed",
          elapsedMs: Math.max(0, clock() - started),
        });
    } catch (error) {
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
        artifact.results.push({
          ...skippedResult(candidate, `timed-out: ${activity}`, parent),
          effects: [...(effects ?? [])],
          status: "timed-out",
          timeoutScope: scope,
          elapsedMs: Math.max(0, clock() - started),
        });
        markPartial(`${candidate.selector} timed-out (${scope})`);
        retire();
        progress("timed-out");
        if (scope === "state") throw state.signal.reason ?? error;
      } else {
        markPartial(
          `probe stopped early: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`,
        );
        throw error;
      }
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
  const runAttempt: typeof attempt = async (candidate, phase, work, parent) => {
    activeCandidate = candidate;
    activeStarted = clock();
    activeParent = parent;
    const result = await attempt(candidate, phase, work, parent);
    activeCandidate = undefined;
    return result;
  };
  try {
    await state.run(() => protect(options.page, state));
    const initial = deadlinePage(options.page, state);
    let candidates: Candidate[];
    let explanations: ExplanationCandidate[] = [];
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
    } finally {
      initial.dispose();
    }
    const queue = candidates.slice(0, options.maxControls);
    if (queue.length < candidates.length)
      markPartial(
        `probed ${queue.length} of ${candidates.length} controls (checks.probe.maxControls)`,
      );
    const sampled = new Set<string>();
    for (const candidate of queue) {
      state.check();
      if (destructive.test(candidate.name)) {
        artifact.results.push({
          ...skippedResult(candidate, "destructive name"),
          status: "completed",
          elapsedMs: 0,
        });
        selector = candidate.selector;
        completed += 1;
        progress("done");
        continue;
      }
      const outcome = await runAttempt(
        candidate,
        "observe",
        async (page, motion, collector, deadline) => {
          const explanation = explanations.find(
            (item) => item.selector === candidate.selector,
          );
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
          if (explanation) {
            sampled.add(explanation.selector);
            dirty = true;
            progress("explanation");
            await sampleExplanation({
              page,
              candidate: explanation,
              collector,
              waitMs: options.waitMs,
              restore: options.restore,
            });
            await options.restore(page);
            dirty = false;
          }
          progress("observe");
          dirty = true;
          effects = new Set();
          const outcome = await clickAndObserve(
            page,
            candidate.path,
            options.waitMs,
            motion,
            candidate.name,
            intent,
            effects,
          );
          deadline.check();
          const result: ProbeResult = outcome.error
            ? skippedResult(candidate, `not clickable: ${outcome.error}`)
            : {
                ...skippedResult(candidate, ""),
                ...outcome,
                skipped: undefined,
              };
          const items = outcome.signature?.includes("menu:")
            ? await enumerate(page, options.skip, "[role=menu]", intent)
            : [];
          return { result, items };
        },
      );
      for (const item of outcome?.items?.slice(0, 20) ?? []) {
        if (destructive.test(item.name)) continue;
        await runAttempt(
          item,
          "nested menu",
          async (page, motion, _collector, deadline) => {
            dirty = true;
            await options.restore(page);
            await page
              .locator(candidate.path)
              .first()
              .click({ timeout: 1500, noWaitAfter: true });
            await page.waitForTimeout(options.waitMs);
            const skipped = intent ? await intentSkip(page, item) : undefined;
            deadline.check();
            if (skipped)
              return { result: skippedResult(item, skipped, candidate.name) };
            effects = new Set();
            const nested = await clickAndObserve(
              page,
              item.path,
              options.waitMs,
              motion,
              `${candidate.name} › ${item.name}`,
              intent,
              effects,
            );
            return {
              result: nested.error
                ? skippedResult(
                    item,
                    `not clickable: ${nested.error}`,
                    candidate.name,
                  )
                : {
                    ...skippedResult(item, "", candidate.name),
                    ...nested,
                    skipped: undefined,
                  },
            };
          },
          candidate.name,
        );
      }
    }
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
        async (page, _motion, collector) => {
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
          dirty = true;
          await sampleExplanation({
            page,
            candidate: explanation,
            collector,
            waitMs: options.waitMs,
            restore: options.restore,
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
          dirty = true;
          await options.restore(page);
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
            dirty = true;
            await options.restore(page);
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
    if (dirty && current) {
      const final = deadlinePage(current, state);
      try {
        await state.run(() => options.restore(final.page));
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
        artifact.results.push({
          ...skippedResult(activeCandidate, artifact.reason, activeParent),
          effects: [...(effects ?? [])],
          status: "timed-out",
          timeoutScope: "state",
          elapsedMs: Math.max(0, clock() - activeStarted),
        });
      }
      retire();
      progress("state timed-out");
    } else
      markPartial(
        `probe stopped early: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`,
      );
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
    context.off("page", onNewPage);
    for (const dispose of protections.values()) dispose();
    state.dispose();
    progress("complete");
  }
  return artifact;
}

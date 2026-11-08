import type { Frame, Page } from "playwright";
import { redactUrlSecrets } from "./server-diagnosis.js";
import type { ConsoleRecord, CspViolation } from "./types.js";

const BINDING = "__idiomCspViolation";

/** What the in-frame listener reports for one `securitypolicyviolation`. */
type ViolationPayload = {
  effectiveDirective: string;
  violatedDirective: string;
  blockedURI: string;
  sample: string;
  sourceFile: string;
  lineNumber: number;
  columnNumber: number;
  documentURI: string;
  disposition: string;
  element?: string | undefined;
};

type Pending = {
  payload: ViolationPayload;
  srcdoc: boolean;
  owner: Promise<string | undefined>;
};

/**
 * Installed into every frame, srcdoc ones included. Self-contained because it
 * is serialized; it only adds a listener and calls the binding, so it never
 * logs in an opaque-origin frame.
 */
function installCspListener(binding: string): void {
  try {
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
    const selectorFor = (element: Element) =>
      element.id ? `#${CSS.escape(element.id)}` : pathFor(element);
    const attributeElement = (directive: string, sample: string) => {
      const script = directive === "script-src-attr";
      if (!script && directive !== "style-src-attr") return undefined;
      const candidates = [...document.querySelectorAll("*")].filter((element) =>
        [...element.attributes].some(
          (attribute) =>
            (script
              ? /^on/i.test(attribute.name)
              : attribute.name === "style") &&
            attribute.value.startsWith(sample),
        ),
      );
      return candidates.length === 1 ? candidates[0] : undefined;
    };
    document.addEventListener(
      "securitypolicyviolation",
      (event) => {
        try {
          const report = (window as unknown as Record<string, unknown>)[
            binding
          ];
          if (typeof report !== "function") return;
          const target =
            event.target instanceof Element
              ? event.target
              : attributeElement(event.effectiveDirective, event.sample);
          (report as (payload: unknown) => unknown)({
            effectiveDirective: event.effectiveDirective,
            violatedDirective: event.violatedDirective,
            blockedURI: event.blockedURI,
            sample: event.sample,
            sourceFile: event.sourceFile,
            lineNumber: event.lineNumber,
            columnNumber: event.columnNumber,
            documentURI: event.documentURI,
            disposition: event.disposition,
            element: target === undefined ? undefined : selectorFor(target),
          });
        } catch {}
      },
      true,
    );
  } catch {}
}

/** The owner iframe's selector, computed in its parent frame. */
function ownerSelector(element: Element): string {
  const pathFor = (node: Element): string => {
    const parts: string[] = [];
    let current: Element | null = node;
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
  return element.id ? `#${CSS.escape(element.id)}` : pathFor(element);
}

async function ownerOf(frame: Frame): Promise<string | undefined> {
  if (frame.parentFrame() === null) return undefined;
  const handle = await frame.frameElement();
  try {
    return await handle.evaluate(ownerSelector);
  } finally {
    await handle.dispose().catch(() => undefined);
  }
}

const text = (value: unknown) => (typeof value === "string" ? value : "");
const integer = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : undefined;

function payloadOf(value: unknown): ViolationPayload | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  const effectiveDirective = text(raw.effectiveDirective);
  if (effectiveDirective.length === 0) return undefined;
  const element = text(raw.element);
  return {
    effectiveDirective,
    violatedDirective: text(raw.violatedDirective) || effectiveDirective,
    blockedURI: text(raw.blockedURI),
    sample: text(raw.sample),
    sourceFile: text(raw.sourceFile),
    lineNumber: integer(raw.lineNumber) ?? 0,
    columnNumber: integer(raw.columnNumber) ?? 0,
    documentURI: text(raw.documentURI),
    disposition: text(raw.disposition),
    ...(element.length === 0 ? {} : { element }),
  };
}

function blockedOf(payload: ViolationPayload): string {
  const uri = payload.blockedURI;
  if (uri === "inline" || uri === "eval" || uri === "wasm-eval") return uri;
  if (uri === "" && /-(attr|elem)$/.test(payload.effectiveDirective))
    return "inline";
  return redactUrlSecrets(uri);
}

const escapeRegExp = (value: string) =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Whether a console line is Chromium's own log of this violation: it speaks
 * of a Content Security Policy directive (older builds start `Refused to`,
 * newer ones `Applying inline style violates`) and names either directive as
 * a whole token. This only deduplicates; every field shown comes from the
 * violation event.
 */
export function matchesCspConsoleLine(
  text: string,
  violation: { effectiveDirective: string; violatedDirective: string },
): boolean {
  if (!/Content Security Policy directive/.test(text)) return false;
  return [violation.effectiveDirective, violation.violatedDirective]
    .filter((directive) => directive.length > 0)
    .some((directive) =>
      new RegExp(`(^|[\\s"'])${escapeRegExp(directive)}($|[\\s"'])`).test(text),
    );
}

/**
 * Records Content Security Policy violations in every frame through a page
 * binding, and joins each onto Chromium's console line for it, so a CSP
 * finding names the directive, the blocked resource, the element and the
 * owner iframe instead of only a line number in `about:srcdoc`.
 */
export class CspRecorder {
  private readonly pending: Pending[] = [];

  private constructor() {}

  static async create(page: Page): Promise<CspRecorder> {
    const recorder = new CspRecorder();
    await page.exposeBinding(BINDING, (source, value: unknown) => {
      const payload = payloadOf(value);
      if (payload === undefined) return;
      recorder.pending.push({
        payload,
        srcdoc: source.frame.url() === "about:srcdoc",
        owner: ownerOf(source.frame).catch(() => undefined),
      });
    });
    await page.addInitScript(installCspListener, BINDING);
    return recorder;
  }

  /**
   * Attach each violation to the first unconsumed console error that logs it;
   * a violation with no console line becomes a record of its own.
   */
  async annotate(
    records: ConsoleRecord[],
    annotate: (record: ConsoleRecord) => ConsoleRecord = (record) => record,
  ): Promise<ConsoleRecord[]> {
    const violations = await Promise.all(
      this.pending.map(async (pending) => ({
        ...pending,
        frame: await pending.owner,
      })),
    );
    const result = [...records];
    const consumed = new Set<number>();
    const synthesized: ConsoleRecord[] = [];
    for (const violation of violations) {
      const { payload } = violation;
      const csp: CspViolation = {
        directive: payload.effectiveDirective,
        violatedDirective: payload.violatedDirective,
        blocked: blockedOf(payload),
        ...(payload.element === undefined ? {} : { element: payload.element }),
        ...(violation.frame === undefined ? {} : { frame: violation.frame }),
        ...(payload.sample.length === 0 ? {} : { sample: payload.sample }),
        ...(payload.sourceFile.length === 0
          ? {}
          : { sourceFile: redactUrlSecrets(payload.sourceFile) }),
        ...(payload.lineNumber === 0 ? {} : { lineNumber: payload.lineNumber }),
        ...(payload.columnNumber === 0
          ? {}
          : { columnNumber: payload.columnNumber }),
        documentUrl: redactUrlSecrets(payload.documentURI),
      };
      const index = result.findIndex((record, position) => {
        if (consumed.has(position) || record.type !== "error") return false;
        if (record.csp !== undefined) return false;
        if (!matchesCspConsoleLine(record.text, payload)) return false;
        const url = record.location?.url ?? "";
        return (
          url === "" ||
          url === payload.documentURI ||
          (violation.srcdoc && url === "about:srcdoc")
        );
      });
      if (index === -1) {
        synthesized.push(
          annotate({
            type: "error",
            text: "Content Security Policy violation",
            csp,
          }),
        );
        continue;
      }
      consumed.add(index);
      const record = result[index];
      if (record !== undefined) result[index] = { ...record, csp };
    }
    return [...result, ...synthesized];
  }

  async dispose(): Promise<void> {}
}

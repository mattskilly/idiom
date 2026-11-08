import { renderServerLogLines } from "../capture/server-log.js";
import type { ConsoleRequest, CspViolation } from "../capture/types.js";
import { ran, unavailable, verify } from "./shared.js";
import type { CheckTuple, DeterministicCheck } from "./types.js";

type ConsoleRecord = CheckTuple["console"][number];

const SERVER_LOG_MARGIN_MS = 2_000;
const SERVER_LOG_LINE_LIMIT = 20;

export function normalizeConsoleIdentity(value: string): string {
  return value.trim().replace(/\s+/g, " ") || "<empty message>";
}

/** Chromium never sends a fragment, so a failing request's URL has none. */
const withoutFragment = (url: string) => url.split("#", 1)[0] ?? url;

function isExpectedDocumentLoadError(
  tuple: CheckTuple,
  record: CheckTuple["console"][number],
): boolean {
  const response = tuple.documentResponse;
  if (
    record.type !== "error" ||
    response === undefined ||
    response.expectedStatus === 200 ||
    response.actualStatus !== response.expectedStatus ||
    record.location === undefined ||
    withoutFragment(record.location.url) !==
      withoutFragment(response.finalUrl ?? response.url) ||
    record.location.lineNumber !== 0 ||
    record.location.columnNumber !== 0
  ) {
    return false;
  }
  // A same-URL subresource fails with an identical message; only the
  // main-frame document's own record is the expected one.
  if (record.request !== undefined) {
    if (record.request.resourceType !== "document" || !record.request.mainFrame)
      return false;
  } else if (tuple.consoleProvenance === true) return false;
  const message = normalizeConsoleIdentity(record.text);
  return new RegExp(
    `^Failed to load resource: the server responded with a status of ${response.expectedStatus}(?: \\([^()]*\\))?$`,
  ).test(message);
}

/** The request as the page would name it: path and query when same-origin. */
function requestTarget(tuple: CheckTuple, url: string): string {
  const page =
    tuple.documentUrl ??
    tuple.documentResponse?.finalUrl ??
    tuple.documentResponse?.url;
  try {
    const parsed = new URL(url);
    if (page !== undefined && new URL(page).origin === parsed.origin) {
      const origin = url.indexOf(parsed.host) + parsed.host.length;
      return url.slice(origin) || "/";
    }
  } catch {}
  return url;
}

function requestHeadline(
  tuple: CheckTuple,
  request: ConsoleRequest & { url: string },
): string {
  const target = requestTarget(tuple, request.url);
  return `${request.method ?? "GET"} ${target} ${request.status === undefined ? "failed" : `returned ${request.status}`}`;
}

function cspHeadline(csp: CspViolation): string {
  // `style-src-attr` blocks an inline style; a URL is named as the resource.
  const subject =
    csp.blocked === "inline"
      ? `inline ${csp.directive.split("-")[0]}`
      : csp.blocked === "eval"
        ? "eval"
        : `resource ${csp.blocked}`;
  const where =
    csp.element ??
    (csp.sourceFile === undefined
      ? undefined
      : `${csp.sourceFile}${csp.lineNumber === undefined ? "" : `:${csp.lineNumber}`}`);
  return `Content Security Policy blocked ${subject}${where === undefined ? "" : ` on ${where}`} (${csp.directive})${csp.frame === undefined ? "" : ` inside iframe ${csp.frame}`}`;
}

/** Server log lines from 2 s before a 5xx request to 2 s after its response. */
function serverLogWindow(
  tuple: CheckTuple,
  request: ConsoleRequest | undefined,
): { excerpt: string; count: number } | undefined {
  if (
    tuple.serverLog === undefined ||
    request?.status === undefined ||
    request.status < 500 ||
    request.at === undefined
  )
    return undefined;
  const from = request.at - SERVER_LOG_MARGIN_MS;
  const to = (request.endAt ?? request.at) + SERVER_LOG_MARGIN_MS;
  const lines = tuple.serverLog
    .filter((line) => line.at >= from && line.at <= to)
    .sort((left, right) => left.at - right.at)
    .slice(0, SERVER_LOG_LINE_LIMIT);
  return lines.length === 0
    ? undefined
    : { excerpt: renderServerLogLines(lines), count: lines.length };
}

function groupingKey(record: ConsoleRecord): string {
  if (record.csp !== undefined) {
    const { csp } = record;
    return [
      "csp",
      csp.directive,
      csp.frame ?? "page",
      csp.element ?? `${csp.sourceFile ?? ""}:${csp.lineNumber ?? 0}`,
      csp.blocked,
    ].join(" | ");
  }
  if (record.request?.url !== undefined)
    return [
      "request",
      `${record.request.method ?? "GET"} ${record.request.url}`,
      record.request.status ?? "failed",
    ].join(" | ");
  return [
    record.type,
    record.location === undefined
      ? "page"
      : `${record.location.url}:${record.location.lineNumber}:${record.location.columnNumber}`,
    normalizeConsoleIdentity(record.text),
  ].join(" | ");
}

export const consoleErrorCheck: DeterministicCheck = {
  id: "console-error",
  run({ tuple }) {
    if (tuple.consoleAvailable === false) {
      return unavailable(this.id, "console.jsonl is unavailable");
    }
    const records = new Map<string, { record: ConsoleRecord; count: number }>();
    for (const record of tuple.console) {
      if (record.healthAllowed === true) continue;
      if (record.type !== "error" && record.type !== "pageerror") continue;
      if (isExpectedDocumentLoadError(tuple, record)) continue;
      const selectorHint = groupingKey(record);
      const existing = records.get(selectorHint);
      if (existing === undefined)
        records.set(selectorHint, { record, count: 1 });
      else existing.count += 1;
    }
    return ran(
      this.id,
      [...records].map(([selectorHint, { record, count }]) => {
        const request =
          record.request?.url === undefined
            ? undefined
            : { ...record.request, url: record.request.url };
        const serverLog = serverLogWindow(tuple, record.request);
        const detail = `${record.type === "pageerror" ? "An uncaught page error" : "console.error"} occurred during capture: ${record.text}`;
        const headline =
          record.csp !== undefined
            ? cspHeadline(record.csp)
            : request !== undefined
              ? requestHeadline(tuple, request)
              : undefined;
        const serverLogNote =
          serverLog === undefined
            ? ""
            : ` server.log has ${serverLog.count} ${serverLog.count === 1 ? "line" : "lines"} from 2 s before the request to 2 s after its response.`;
        return {
          category: this.id,
          severity: "major" as const,
          rule:
            record.type === "pageerror"
              ? "idiom:uncaught-page-error"
              : "idiom:console-error",
          selectorHint,
          explanation: `${headline === undefined ? detail : `${headline}. ${detail}`}${count > 1 ? ` (recorded ${count} times)` : ""}${serverLogNote}`,
          acceptance: [
            "The state renders without this error being recorded during capture.",
          ],
          verification: verify(this.id, {
            type: record.type,
            text: record.text,
            ...(request === undefined
              ? {}
              : {
                  method: request.method ?? "GET",
                  url: request.url,
                  ...(request.status === undefined
                    ? {}
                    : { status: request.status }),
                }),
          }),
          consoleExcerpt: record.text,
          ...(serverLog === undefined
            ? {}
            : { serverLogExcerpt: serverLog.excerpt }),
        };
      }),
    );
  },
};

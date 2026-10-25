import { ran, unavailable, verify } from "./shared.js";
import type { CheckTuple, DeterministicCheck } from "./types.js";

export function normalizeConsoleIdentity(value: string): string {
  return value.trim().replace(/\s+/g, " ") || "<empty message>";
}

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
    record.location?.url !== response.url ||
    record.location.lineNumber !== 0 ||
    record.location.columnNumber !== 0
  ) {
    return false;
  }
  const message = normalizeConsoleIdentity(record.text);
  return new RegExp(
    `^Failed to load resource: the server responded with a status of ${response.expectedStatus}(?: \\([^()]*\\))?$`,
  ).test(message);
}

export const consoleErrorCheck: DeterministicCheck = {
  id: "console-error",
  run({ tuple }) {
    if (tuple.consoleAvailable === false) {
      return unavailable(this.id, "console.jsonl is unavailable");
    }
    const records = new Map<
      string,
      { record: (typeof tuple.console)[number]; count: number }
    >();
    for (const record of tuple.console) {
      if (record.healthAllowed === true) continue;
      if (record.type !== "error" && record.type !== "pageerror") continue;
      if (isExpectedDocumentLoadError(tuple, record)) continue;
      const selectorHint = [
        record.type,
        record.location === undefined
          ? "page"
          : `${record.location.url}:${record.location.lineNumber}:${record.location.columnNumber}`,
        normalizeConsoleIdentity(record.text),
      ].join(" | ");
      const existing = records.get(selectorHint);
      if (existing === undefined)
        records.set(selectorHint, { record, count: 1 });
      else existing.count += 1;
    }
    return ran(
      this.id,
      [...records].map(([selectorHint, { record, count }]) => ({
        category: this.id,
        severity: "major" as const,
        rule:
          record.type === "pageerror"
            ? "idiom:uncaught-page-error"
            : "idiom:console-error",
        selectorHint,
        explanation: `${record.type === "pageerror" ? "An uncaught page error" : "console.error"} occurred during capture: ${record.text}${count > 1 ? ` (recorded ${count} times)` : ""}`,
        acceptance: [
          "The state renders without this error being recorded during capture.",
        ],
        verification: verify(this.id, {
          type: record.type,
          text: record.text,
        }),
        consoleExcerpt: record.text,
      })),
    );
  },
};

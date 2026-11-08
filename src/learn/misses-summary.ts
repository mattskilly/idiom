import type { LearnedEntry } from "../schemas/learned.js";

export type HumanFoundSummary = {
  logged: number;
  covered: number;
  coveredByRun: number;
  coveredByMark: number;
  open: number;
  latest: string;
  openEntries: Array<
    Pick<
      LearnedEntry,
      "id" | "flow" | "state" | "kind" | "observation" | "recordedAt"
    > & { selector?: string | undefined }
  >;
};

export function relativeAge(iso: string, now: Date): string {
  const days = Math.max(
    0,
    Math.floor((now.getTime() - Date.parse(iso)) / 86_400_000),
  );
  return days === 0 ? "today" : `${days} day${days === 1 ? "" : "s"} ago`;
}

export function humanFoundLine(summary: HumanFoundSummary, now: Date): string {
  return `Human-found misses: ${summary.logged} logged, ${summary.covered} now covered by a rule, ${summary.open} open (latest: ${relativeAge(summary.latest, now)}).`;
}

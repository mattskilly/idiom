import type {
  CheckTuple,
  ProbeArtifact,
  ProbeSafetyLedger,
} from "../checks/types.js";
import type { ColorScheme } from "../schemas/project.js";

/** A page quick review asked the interaction probe to run on. */
export type ProbedPage = {
  state: string;
  viewport: string;
  colorScheme: ColorScheme;
  url: string;
};

export type QuickInteractionPage = ProbedPage & {
  probeStatus: "ran" | "partial" | "timed-out" | "unavailable";
  probed: number;
  skipped: { destructive: number; intent: number; other: number };
  notReached: { budget: number; maxControls: number; other: number };
  blocked: ProbeSafetyLedger["blocked"];
  requests: ProbeSafetyLedger["requests"];
  reason?: string | undefined;
};

export type QuickInteraction =
  | { status: "off" }
  | {
      status: "probed";
      budgetMs: number;
      maxControls: number;
      pages: QuickInteractionPage[];
      totals: {
        probed: number;
        skipped: number;
        notReached: number;
        /** Every blocked action class, summed. */
        blocked: number;
        /** Non-GET/HEAD/OPTIONS requests that left the browser; always 0. */
        nonSafeSent: number;
      };
    };

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const INTENT_SKIP = /^(?:already selected|drag handle):/;
const BUDGET_REASON = /budget|timed-out|timed out/;

function emptyBlocked(): ProbeSafetyLedger["blocked"] {
  return {
    crossOriginNavigation: 0,
    formSubmission: 0,
    download: 0,
    popup: 0,
    windowOpen: 0,
    beforeunload: 0,
    permission: 0,
  };
}

/** Requests sent with a method other than GET, HEAD or OPTIONS. */
export function nonSafeSent(requests: ProbeSafetyLedger["requests"]): number {
  return Object.entries(requests.sent)
    .filter(([method]) => !SAFE_METHODS.has(method.toUpperCase()))
    .reduce((sum, [, count]) => sum + count, 0);
}

function countResults(
  probe: ProbeArtifact,
): Pick<QuickInteractionPage, "probed" | "skipped" | "notReached"> {
  const skipped = { destructive: 0, intent: 0, other: 0 };
  const notReached = { budget: 0, maxControls: 0, other: 0 };
  let probed = 0;
  for (const result of probe.results) {
    const reason = result.skipped ?? "";
    if (result.status === "not-reached") {
      if (reason.includes("checks.probe.maxControls"))
        notReached.maxControls += 1;
      else if (BUDGET_REASON.test(reason)) notReached.budget += 1;
      else notReached.other += 1;
    } else if (result.status === "timed-out") {
      // A state timeout stopped the probe mid-control: the budget ran out.
      if (result.timeoutScope === "state") notReached.budget += 1;
      else probed += 1;
    } else if (reason === "destructive name") skipped.destructive += 1;
    else if (INTENT_SKIP.test(reason)) skipped.intent += 1;
    else if (reason !== "") skipped.other += 1;
    else probed += 1;
  }
  return { probed, skipped, notReached };
}

const sum = (values: Record<string, number>) =>
  Object.values(values).reduce((total, value) => total + value, 0);

/** What quick review's interaction probe did on each page. */
export function summarizeQuickInteraction(options: {
  tuples: CheckTuple[];
  probed: ProbedPage[];
  enabled: boolean;
  budgetMs: number;
  maxControls: number;
}): QuickInteraction {
  if (!options.enabled) return { status: "off" };
  const pages = options.probed.map((page): QuickInteractionPage => {
    const tuple = options.tuples.find(
      (candidate) =>
        candidate.state === page.state &&
        candidate.viewport === page.viewport &&
        (candidate.colorScheme ?? "light") === page.colorScheme,
    );
    const probe =
      tuple?.observations?.version === 2 ? tuple.observations.probe : undefined;
    if (probe === undefined)
      return {
        ...page,
        probeStatus: "unavailable",
        probed: 0,
        skipped: { destructive: 0, intent: 0, other: 0 },
        notReached: { budget: 0, maxControls: 0, other: 0 },
        blocked: emptyBlocked(),
        requests: { sent: {}, blocked: {} },
        reason: tuple?.failure?.message ?? "no probe evidence was recorded",
      };
    return {
      ...page,
      probeStatus: probe.status,
      ...countResults(probe),
      blocked: probe.safety?.blocked ?? emptyBlocked(),
      requests: probe.safety?.requests ?? { sent: {}, blocked: {} },
      ...(probe.reason === undefined ? {} : { reason: probe.reason }),
    };
  });
  return {
    status: "probed",
    budgetMs: options.budgetMs,
    maxControls: options.maxControls,
    pages,
    totals: {
      probed: pages.reduce((total, page) => total + page.probed, 0),
      skipped: pages.reduce((total, page) => total + sum(page.skipped), 0),
      notReached: pages.reduce(
        (total, page) => total + sum(page.notReached),
        0,
      ),
      blocked: pages.reduce((total, page) => total + sum(page.blocked), 0),
      nonSafeSent: pages.reduce(
        (total, page) => total + nonSafeSent(page.requests),
        0,
      ),
    },
  };
}

const plural = (count: number, one: string, many = `${one}s`) =>
  `${count} ${count === 1 ? one : many}`;

const seconds = (ms: number) =>
  ms % 1000 === 0 ? `${ms / 1000} s` : `${(ms / 1000).toFixed(1)} s`;

function pageSentence(
  page: QuickInteractionPage,
  summary: Extract<QuickInteraction, { status: "probed" }>,
  label: string,
): string {
  const where = `${page.viewport}/${page.colorScheme}`;
  if (page.probeStatus === "unavailable")
    return `Idiom could not interact with ${label} at ${where}: ${page.reason ?? "no probe evidence was recorded"}.`;
  const parts = [
    `Idiom interacted with ${label}: it clicked ${plural(page.probed, "control")} at ${where} within a ${seconds(summary.budgetMs)} budget (at most ${summary.maxControls} controls).`,
  ];
  const skipped: string[] = [];
  if (page.skipped.destructive > 0)
    skipped.push(
      `${plural(page.skipped.destructive, "destructive-looking control")} (delete, sign out, purchase…)`,
    );
  if (page.skipped.intent > 0)
    skipped.push(
      `${plural(page.skipped.intent, "already-selected or drag control")}`,
    );
  if (page.skipped.other > 0) skipped.push(`${page.skipped.other} other`);
  if (skipped.length > 0) parts.push(`Skipped: ${skipped.join(", ")}.`);
  const notReached = sum(page.notReached);
  if (notReached > 0) {
    const why: string[] = [];
    if (page.notReached.budget > 0)
      why.push(`${page.notReached.budget} because the budget ran out`);
    if (page.notReached.maxControls > 0)
      why.push(
        `${page.notReached.maxControls} beyond the ${summary.maxControls}-control cap`,
      );
    if (page.notReached.other > 0)
      why.push(`${page.notReached.other} for other limits`);
    parts.push(
      `${plural(notReached, "control was", "controls were")} not probed: ${why.join(", ")}.`,
    );
  }
  const blockedRequests = Object.entries(page.requests.blocked)
    .filter(([method]) => !SAFE_METHODS.has(method.toUpperCase()))
    .reduce((total, [, count]) => total + count, 0);
  const sent = nonSafeSent(page.requests);
  parts.push(
    `Blocked: ${plural(page.blocked.crossOriginNavigation, "cross-origin navigation")}, ${plural(page.blocked.formSubmission, "form submission")}, ${plural(page.blocked.download, "download")}, ${plural(page.blocked.popup + page.blocked.windowOpen, "new window")}, ${plural(page.blocked.permission, "permission prompt")}; ${plural(blockedRequests, "non-GET request was", "non-GET requests were")} blocked and ${sent === 0 ? "none" : sent} left the browser.`,
  );
  if (page.probeStatus !== "ran" && page.reason !== undefined)
    parts.push(`Probe ${page.probeStatus}: ${page.reason}.`);
  return parts.join(" ");
}

/** Plain sentences for the Markdown and HTML reports. */
export function renderInteractionSentences(
  summary: QuickInteraction,
): string[] {
  if (summary.status === "off")
    return [
      "Interaction probe off (--no-probe): this is a static review. Probe-based rules (dead control, duplicate entry, motion) were not evaluated.",
    ];
  if (summary.pages.length === 1) {
    const [page] = summary.pages;
    return page ? [pageSentence(page, summary, "this page")] : [];
  }
  return summary.pages.map((page) =>
    pageSentence(page, summary, `${page.url} (${page.state})`),
  );
}

/** The CLI's one-line tail. */
export function interactionTail(summary: QuickInteraction): string {
  if (summary.status === "off") return "probe off";
  return `probed ${plural(summary.totals.probed, "control")}, skipped ${summary.totals.skipped}, not probed ${summary.totals.notReached}`;
}

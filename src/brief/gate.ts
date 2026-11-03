import type { BriefStatus, BriefTriageResult } from "../schemas/brief.js";

/** A brief a ticket carries: a `brief: <slug>` link or a pasted rendered brief. */
export type TicketBriefRef =
  | { source: "link"; slug: string }
  | { source: "embedded"; status: BriefStatus; supersededBy?: string };

/** A ticket's brief after the gate looked it up. */
export type GateBrief =
  | {
      source: "link";
      slug: string;
      status: BriefStatus;
      supersededBy?: string;
    }
  | { source: "link"; slug: string; status: "missing"; error: string }
  | { source: "embedded"; status: BriefStatus; supersededBy?: string };

export const gateReasons = [
  "decided",
  "no-decision",
  "no-brief",
  "proposed",
  "superseded",
  "missing-brief",
  "triage-failed",
] as const;
export type GateReason = (typeof gateReasons)[number];

export type GateTriage = {
  id: string;
  verdict: BriefTriageResult["verdict"];
  reason: string;
  questions: string[];
};

export type GateTicket = {
  path: string;
  outcome: "pass" | "warn" | "error";
  reason: GateReason;
  briefs: GateBrief[];
  triage?: GateTriage;
  message?: string;
  next?: string[];
};

export type GateResult = {
  strict: boolean;
  warnings: number;
  tickets: GateTicket[];
};

const LINK_LINE =
  /^\s*(?:[-*]\s+)?(?:\*\*)?brief(?:\*\*)?\s*:\s*(?:\*\*)?\s*`?([A-Za-z0-9-]+)`?\s*$/i;
const TOML_LINK_LINE = /^\s*brief\s*=\s*"([A-Za-z0-9-]+)"\s*$/;
const STATUS_LINE =
  /^Status: (proposed|decided|superseded)\b(.*)· rubric v\d+\s*$/;
const SUPERSEDED_BY = /· superseded by ([a-z0-9]+(?:-[a-z0-9]+)*)/;
const FENCE = /^\s{0,3}(`{3,}|~{3,})/;

/** Line indexes outside fenced code blocks. */
function unfenced(lines: string[]): number[] {
  const open: { char: string; length: number }[] = [];
  const kept: number[] = [];
  lines.forEach((line, index) => {
    const fence = FENCE.exec(line)?.[1];
    if (fence !== undefined) {
      const current = open[0];
      if (current === undefined)
        open.push({ char: fence[0] ?? "`", length: fence.length });
      else if (fence[0] === current.char && fence.length >= current.length)
        open.pop();
      return;
    }
    if (open.length === 0) kept.push(index);
  });
  return kept;
}

/** Indexes of a leading `+++` TOML front-matter block's body lines. */
function tomlFrontMatter(lines: string[]): Set<number> {
  if (lines[0]?.trim() !== "+++") return new Set();
  const end = lines.findIndex(
    (line, index) => index > 0 && line.trim() === "+++",
  );
  if (end === -1) return new Set();
  return new Set(Array.from({ length: end - 1 }, (_, index) => index + 1));
}

/** Every brief a ticket links or embeds; links are deduplicated by slug. */
export function findTicketBriefs(text: string): TicketBriefRef[] {
  const lines = text.split(/\r?\n/);
  const toml = tomlFrontMatter(lines);
  const refs: TicketBriefRef[] = [];
  const slugs = new Set<string>();
  const link = (slug: string) => {
    if (slugs.has(slug)) return;
    slugs.add(slug);
    refs.push({ source: "link", slug });
  };
  for (const index of unfenced(lines)) {
    const line = lines[index] ?? "";
    if (toml.has(index)) {
      const slug = TOML_LINK_LINE.exec(line)?.[1];
      if (slug !== undefined) link(slug);
      continue;
    }
    const slug = LINK_LINE.exec(line)?.[1];
    if (slug !== undefined) {
      link(slug);
      continue;
    }
    const status = STATUS_LINE.exec(line);
    if (status !== null) {
      const supersededBy = SUPERSEDED_BY.exec(line)?.[1];
      refs.push({
        source: "embedded",
        status: status[1] as BriefStatus,
        ...(supersededBy === undefined ? {} : { supersededBy }),
      });
    }
  }
  return refs;
}

const severity: Record<GateBrief["status"], number> = {
  missing: 3,
  superseded: 2,
  proposed: 1,
  decided: 0,
};

function named(brief: GateBrief): string {
  return brief.source === "link"
    ? `links brief ${brief.slug}`
    : "embeds a brief";
}

/** Outcome from the briefs a ticket carries; the worst brief decides. */
export function classifyBriefs(path: string, briefs: GateBrief[]): GateTicket {
  const worst = briefs.reduce((a, b) =>
    severity[b.status] > severity[a.status] ? b : a,
  );
  const base = { path, briefs };
  switch (worst.status) {
    case "decided":
      return { ...base, outcome: "pass", reason: "decided" };
    case "missing":
      return {
        ...base,
        outcome: "warn",
        reason: "missing-brief",
        message: `${path} links brief ${worst.slug}, which Idiom cannot read: ${worst.error}`,
        next: ["idiom brief list"],
      };
    case "proposed":
      return {
        ...base,
        outcome: "warn",
        reason: "proposed",
        message: `${path} ${named(worst)}, which is still proposed: the decision is open.`,
        next: [
          worst.source === "link"
            ? `ask the requester, then idiom brief decide ${worst.slug} --option <id>`
            : "ask the requester, then idiom brief decide <slug> --option <id> (idiom brief list names the slug)",
        ],
      };
    case "superseded":
      return {
        ...base,
        outcome: "warn",
        reason: "superseded",
        message: `${path} ${named(worst)}, which is superseded${worst.supersededBy === undefined ? "" : ` by ${worst.supersededBy}`}.`,
        next: [
          worst.supersededBy === undefined
            ? "link the brief that replaced it"
            : `link the superseding brief: brief: ${worst.supersededBy}`,
        ],
      };
  }
}

/** Outcome for a ticket with no brief, from its triage. */
export function classifyTriage(
  path: string,
  triageId: string,
  result: BriefTriageResult,
): GateTicket {
  const triage: GateTriage = {
    id: triageId,
    verdict: result.verdict,
    reason: result.reason,
    questions: result.questions,
  };
  if (result.verdict === "no design decision")
    return { path, outcome: "pass", reason: "no-decision", briefs: [], triage };
  return {
    path,
    outcome: "warn",
    reason: "no-brief",
    briefs: [],
    triage,
    message: `${path} adds a design decision with no brief.`,
    next: [`idiom brief plan ${triageId}`, `idiom brief "${path}" --research`],
  };
}

export function triageFailed(path: string, error: unknown): GateTicket {
  return {
    path,
    outcome: "error",
    reason: "triage-failed",
    briefs: [],
    message: `could not triage ${path}: ${error instanceof Error ? error.message : String(error)}`,
    next: [`idiom brief triage "${path}"`],
  };
}

function renderTicket(ticket: GateTicket): string[] {
  if (ticket.outcome === "pass") return [];
  const next = ticket.next ?? [];
  if (ticket.reason === "no-brief")
    return [
      `Warning: ${ticket.message}`,
      ...(ticket.triage?.questions ?? []).map((question) => `  - ${question}`),
      `  Run: ${next[0]} (or: ${next[1]})`,
      '  Then link it with a "brief: <slug>" line, or paste .idiom/briefs/<slug>.md into the ticket.',
    ];
  return [
    `Warning: ${ticket.message}`,
    ...next.map((step) => `  Run: ${step}`),
  ];
}

/** Human output; empty when every ticket passes, so a hook stays silent. */
export function renderGate(result: GateResult): string {
  if (result.warnings === 0) return "";
  return [
    ...result.tickets.flatMap(renderTicket),
    `${result.warnings} of ${result.tickets.length} ticket(s) need a decided brief.`,
  ].join("\n");
}

export function gateJson(result: GateResult): GateResult {
  return {
    strict: result.strict,
    warnings: result.warnings,
    tickets: result.tickets.map((ticket) => ({
      path: ticket.path,
      outcome: ticket.outcome,
      reason: ticket.reason,
      briefs: ticket.briefs,
      ...(ticket.triage === undefined ? {} : { triage: ticket.triage }),
      ...(ticket.message === undefined ? {} : { message: ticket.message }),
      ...(ticket.next === undefined ? {} : { next: ticket.next }),
    })),
  };
}

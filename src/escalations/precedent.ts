import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { readIdentifiedDecisions } from "../decisions/log.js";
import { classifyQuestion } from "../learn/harvest-classify.js";
import { readLearnedLog } from "../learn/misses.js";
import { readEffectiveLaw } from "../rulings/effective.js";
import { parseRulingBlocks, scaleRulingText } from "../rulings/law.js";
import type { PrecedentKind } from "../schemas/escalation-answer.js";

/** Something the director already decided, that a question can be checked against. */
export type Precedent = {
  kind: PrecedentKind;
  /** `ruling-1`, a finding id, or `learned-4`. */
  id: string;
  /** The file it lives in: `DESIGN.md`, `.idiom/decisions.jsonl`, `.idiom/learned.jsonl`. */
  file: string;
  /** Where it lives, for a person to open: `DESIGN.md (recorded ruling ruling-1)`. */
  where: string;
  /** The words quoted back: a ruling's wording, a decision's reason, a law's rule. */
  text: string;
  /** The words matched against: the quote plus any recorded reason. */
  matchText: string;
  /** Accepted or rejected, for a decision. */
  stance?: "accepted" | "rejected" | undefined;
  /** When it was decided, for ranking ties. */
  at?: string | undefined;
};

async function readText(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}

/**
 * Every recorded precedent: rulings (DESIGN.md recorded-ruling blocks and
 * decision-log rulings, one effective law), accept/reject decisions with a
 * design reason, and learned laws. Read-only.
 */
export async function loadPrecedent(options: {
  projectDirectory: string;
  stateProjectDirectory: string;
  designFile: string;
}): Promise<Precedent[]> {
  const precedent: Precedent[] = [];
  const designPath = join(options.projectDirectory, options.designFile);

  // Rulings: the merged law, located in DESIGN.md or only in the log.
  const inDesign = new Set(
    parseRulingBlocks(await readText(designPath)).resolutions.map(
      (resolution) => resolution.id,
    ),
  );
  const law = await readEffectiveLaw(designPath, options.stateProjectDirectory);
  for (const resolution of law.resolutions) {
    if (resolution.outcome !== "rule") continue;
    const text =
      resolution.wording ??
      (resolution.scale === undefined
        ? undefined
        : scaleRulingText(resolution.scale));
    if (text === undefined) continue;
    precedent.push({
      kind: "ruling",
      id: resolution.id,
      file: inDesign.has(resolution.id)
        ? options.designFile
        : ".idiom/decisions.jsonl",
      where: inDesign.has(resolution.id)
        ? `${options.designFile} (recorded ruling ${resolution.id})`
        : `.idiom/decisions.jsonl (ruling ${resolution.id})`,
      text,
      matchText:
        resolution.reason === undefined ? text : `${text} ${resolution.reason}`,
      at: resolution.recordedAt,
    });
  }

  // Decisions: the latest accept or reject per finding, with a design reason.
  const latest = new Map<
    string,
    Awaited<ReturnType<typeof readIdentifiedDecisions>>[number]
  >();
  for (const entry of await readIdentifiedDecisions(
    options.stateProjectDirectory,
  )) {
    const record = entry.record;
    if (record.decision !== "accept" && record.decision !== "reject") continue;
    // A later judgment of the same finding supersedes an earlier one.
    latest.delete(record.findingId);
    latest.set(record.findingId, entry);
  }
  for (const { source, record } of latest.values()) {
    if (record.decision !== "accept" && record.decision !== "reject") continue;
    const reason = record.reason?.trim();
    if (!reason) continue;
    // "False positive, Idiom bug" is about the tool, not the design.
    if (!classifyQuestion(reason).design) continue;
    precedent.push({
      kind: "decision",
      id: record.findingId,
      file: ".idiom/decisions.jsonl",
      where: `.idiom/decisions.jsonl line ${source.line}`,
      text: reason,
      matchText: reason,
      stance: record.decision === "accept" ? "accepted" : "rejected",
      at: record.at,
    });
  }

  // Learned laws: every record that became more than an observation.
  for (const entry of await readLearnedLog(options.stateProjectDirectory)) {
    if (entry.kind === "observation") continue;
    const text = entry.candidate?.rule ?? entry.observation;
    precedent.push({
      kind: "law",
      id: entry.id,
      file: ".idiom/learned.jsonl",
      where: `.idiom/learned.jsonl (${entry.id})`,
      text,
      matchText: text,
      at: entry.recordedAt,
    });
  }
  return precedent;
}

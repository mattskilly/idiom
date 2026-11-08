import type { Dirent } from "node:fs";
import { access, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { isGateOpen } from "../baseline/summary.js";
import { loadRunRecord } from "../capture/run-record.js";
import { designChoicesFrom } from "../design/decide.js";
import { loadReviewCatalog } from "../review/catalog.js";
import { reduceLifecycles } from "../review/lifecycle.js";
import { readUnruledDecisions } from "../rulings/artifacts.js";
import { readEffectiveLaw } from "../rulings/effective.js";
import type { Finding } from "../schemas/finding.js";
import type { PendingDecision } from "../schemas/pending-decision.js";
import { loadProjectContext } from "../validation.js";
import { primaryCheckout } from "../verify/baseline.js";
import {
  acknowledgements,
  judgments,
  readDecisionLog,
  readDecisionLogEntries,
} from "./log.js";

export function isReferenceQuestion(
  finding: Pick<Finding, "rule" | "evidence">,
): boolean {
  return (
    finding.rule === "idiom:design-decision" &&
    finding.evidence.designDrift?.designDecision !== undefined
  );
}

/** Reference choice identity: one question across viewports. */
export function referenceKey(
  finding: Pick<Finding, "flow" | "state" | "colorScheme" | "evidence">,
): string | undefined {
  const decision = finding.evidence.designDrift?.designDecision;
  return decision
    ? JSON.stringify([
        finding.flow,
        finding.state,
        finding.colorScheme ?? "",
        decision.decisionKey,
      ])
    : undefined;
}

export function mergePending(
  questions: readonly PendingDecision[],
): PendingDecision[] {
  const merged = new Map<string, PendingDecision>();
  for (const question of questions) {
    const previous = merged.get(question.key);
    if (!previous) merged.set(question.key, structuredClone(question));
    else {
      previous.evidence = [
        ...new Set([...previous.evidence, ...question.evidence]),
      ];
      previous.coordinates = [
        ...new Map(
          [...previous.coordinates, ...question.coordinates].map((c) => [
            JSON.stringify(c),
            c,
          ]),
        ).values(),
      ];
      if (previous.findingIds || question.findingIds)
        previous.findingIds = [
          ...new Set([
            ...(previous.findingIds ?? []),
            ...(question.findingIds ?? []),
          ]),
        ];
      previous.citations = [
        ...new Set([...previous.citations, ...question.citations]),
      ];
      previous.missingCropEvidence &&= question.missingCropEvidence;
    }
  }
  return [...merged.values()];
}

/** Only explicitly marked, current-run questions; never infer from prose. */
export async function pendingForRun(options: {
  projectDirectory: string;
  designPath: string;
  runDirectory: string;
  findings: Finding[];
  unruledDecisionsPath?: string | undefined;
  flow: string;
}): Promise<PendingDecision[]> {
  const choices = designChoicesFrom(
    await readDecisionLog(options.projectDirectory),
  );
  const questions: PendingDecision[] = [];
  for (const finding of options.findings) {
    if (
      !isReferenceQuestion(finding) ||
      !isGateOpen(finding) ||
      finding.acknowledgement
    )
      continue;
    const decision = finding.evidence.designDrift?.designDecision;
    if (!decision) continue;
    if (
      choices.some(
        (choice) =>
          choice.flow === finding.flow &&
          choice.state === finding.state &&
          choice.colorScheme === finding.colorScheme &&
          choice.decisionKey === decision.decisionKey &&
          decision.references.some((r) => r.name === choice.reference),
      )
    )
      continue;
    const crops = finding.evidence.designDrift?.crops;
    const cropPaths = crops?.map((crop) => crop.path) ?? [];
    questions.push({
      kind: "reference-conflict",
      key: referenceKey(finding) ?? finding.id,
      fingerprint: finding.fingerprint,
      id: finding.id,
      findingIds: [finding.id],
      flow: finding.flow,
      runDirectory: options.runDirectory,
      artifact: join(options.runDirectory, "findings.json"),
      question: finding.explanation,
      coordinates: [
        {
          state: finding.state,
          viewport: finding.viewport,
          ...(finding.colorScheme ? { colorScheme: finding.colorScheme } : {}),
        },
      ],
      evidence: [
        ...new Set(
          [...finding.evidence.screenshots, ...cropPaths].map((p) =>
            resolve(options.runDirectory, p),
          ),
        ),
      ],
      missingCropEvidence: !cropPaths.length,
      citations: decision.references.map(
        (r) =>
          `${r.name}: ${JSON.stringify(r.value)} (${r.source}${r.link ? `; ${r.link}` : ""}${r.layerPath ? `; ${r.layerPath}` : ""})`,
      ),
      options: decision.references.map((r) => ({
        label: r.name,
        args: ["--finding", finding.id, "--choose", r.name],
      })),
    });
  }
  const law = await readEffectiveLaw(
    options.designPath,
    options.projectDirectory,
  );
  if (options.unruledDecisionsPath) {
    let present = true;
    try {
      await access(options.unruledDecisionsPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") present = false;
      else throw error;
    }
    for (const decision of present
      ? await readUnruledDecisions(dirname(options.unruledDecisionsPath))
      : []) {
      if (law.resolutions.some((r) => r.fingerprint === decision.fingerprint))
        continue;
      const cluster = decision.scaleCluster;
      const args = ["--decision", decision.id];
      questions.push({
        kind: cluster ? "scaleCluster" : "unruled",
        key: decision.fingerprint,
        fingerprint: decision.fingerprint,
        id: decision.id,
        flow: options.flow,
        runDirectory: options.runDirectory,
        artifact: options.unruledDecisionsPath,
        question: decision.question,
        coordinates: decision.occurrences.map(
          ({ screenshot: _screenshot, ...coordinate }) => coordinate,
        ),
        evidence: [
          ...new Set(
            [
              ...decision.occurrences.map((c) =>
                /\.(png|jpe?g|webp)$/i.test(c.screenshot)
                  ? c.screenshot
                  : join(c.screenshot, "screenshot.png"),
              ),
              ...decision.candidates.flatMap((c) =>
                c.precedent.kind === "governed-surface"
                  ? [join(c.precedent.screenshot, "screenshot.png")]
                  : [],
              ),
              ...(cluster?.examples.flatMap((e) => (e.crop ? [e.crop] : [])) ??
                []),
            ].map((p) => resolve(options.runDirectory, p)),
          ),
        ],
        missingCropEvidence: !cluster?.examples.some((e) => e.crop),
        citations: [
          decision.nearestLawExcerpt,
          ...decision.candidates.map((c) => JSON.stringify(c.precedent)),
        ],
        options: cluster
          ? [
              {
                label: `Add ${cluster.value} as ${cluster.suggestedToken}`,
                args: [
                  ...args,
                  "--add-step",
                  "--token",
                  cluster.suggestedToken,
                ],
              },
              { label: "Keep reporting drift", args: [...args, "--drift"] },
            ]
          : [
              ...decision.candidates.map((c, i) => ({
                label: c.wording,
                args: [...args, "--candidate", String(i + 1)],
              })),
              {
                label: "Custom rule",
                args: [...args, "--wording", "<wording>"],
                input: "wording",
              },
              { label: "No rule needed", args: [...args, "--no-rule"] },
            ],
      });
    }
  }
  return mergePending(questions);
}

export async function pendingDecisions(options: {
  project?: string | undefined;
  cwd?: string | undefined;
}): Promise<PendingDecision[]> {
  const context = await loadProjectContext(options);
  const root = context.projectDirectory;
  let primary: string | undefined;
  try {
    primary = await primaryCheckout(root);
  } catch {
    primary = undefined;
  }
  const additionalReportRoots =
    primary && resolve(primary) !== resolve(root)
      ? [join(primary, ".idiom/reports")]
      : [];
  const catalog = await loadReviewCatalog({
    ...options,
    additionalReportRoots,
    additionalTrackerRoots:
      primary && resolve(primary) !== resolve(root)
        ? [join(primary, ".autobuild/tickets")]
        : [],
  });
  const entries = await readDecisionLogEntries(root);
  const lifecycles = await reduceLifecycles({
    catalog,
    decisions: judgments(entries),
    acknowledgements: acknowledgements(entries),
  });
  const open = new Set(
    lifecycles
      .filter(
        (l) =>
          l.decision?.decision !== "reject" &&
          l.acknowledgement?.state !== "active" &&
          l.verification !== "verified-fixed",
      )
      .map((l) => l.id),
  );
  const runs = new Map<string, string>();
  // Legacy/model-only runs can contain ruling questions without findings.json.
  for (const reports of [
    join(root, ".idiom/reports"),
    ...additionalReportRoots,
  ]) {
    let entries: Dirent<string>[];
    try {
      entries = await readdir(reports, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    for (const entry of entries)
      if (entry.isDirectory() && !runs.has(entry.name))
        runs.set(entry.name, join(reports, entry.name));
  }
  const newest = new Map<string, PendingDecision>();
  for (const [runId, runDirectory] of [...runs].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    const findings = catalog.lineages
      .filter((l) => l.latest.runId === runId && open.has(l.id))
      .flatMap((l) =>
        l.occurrences
          .filter((o) => o.runId === l.latest.runId)
          .map((o) => ({ ...o.finding, id: l.id })),
      );
    const run = await loadRunRecord(runDirectory);
    const pending = await pendingForRun({
      projectDirectory: root,
      designPath: join(root, context.project.design.designFile),
      runDirectory,
      findings,
      flow: run?.flow ?? findings[0]?.flow ?? "",
      unruledDecisionsPath: join(runDirectory, "unruled-decisions.json"),
    });
    for (const question of pending) newest.set(question.key, question);
  }
  return [...newest.values()];
}

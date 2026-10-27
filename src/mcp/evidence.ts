import { evidencePath } from "../artifact-path.js";

export { evidencePath } from "../artifact-path.js";

import { readFile, realpath } from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/server";
import { tupleCoordinateKey } from "../baseline/coordinate.js";
import { decodeFrame } from "../capture/filmstrips.js";
import {
  captureTupleKey,
  expectedCaptureTupleKeys,
} from "../capture/resolve.js";
import { actionTimelineArtifactSchema } from "../checks/artifact-schema.js";
import { FILMSTRIP_LIMITS } from "../checks/filmstrip-schema.js";
import type { ActionTimeline } from "../checks/types.js";
import { IdiomError } from "../errors.js";
import { loadRunTuples } from "../review/artifacts.js";
import {
  type CatalogFinding,
  findCatalogFinding,
  loadReviewCatalog,
} from "../review/catalog.js";
import { type FindingGroup, readGroups } from "../review/groups.js";
import { type CheckIssue, collapseIssues } from "../review/issues.js";
import { type Finding, findingSchema } from "../schemas/finding.js";
import { validateProject } from "../validation.js";

export const safeIdentifier = (value: string) =>
  value !== "." && value !== ".." && !/[\\/\0]/.test(value);

export function result(text: string, data: object): CallToolResult {
  // JSON roundtrip strips undefined and gives the SDK a plain JSON object.
  return {
    content: [{ type: "text", text }],
    structuredContent: JSON.parse(JSON.stringify(data)),
  };
}

function inside(root: string, target: string) {
  const path = relative(root, target);
  return path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

/**
 * A caller-supplied path resolved against the bound root. The nearest existing
 * ancestor is resolved through symlinks, so a link cannot carry a write out.
 */
export async function insideRoot(
  root: string,
  supplied: string,
  label = "path",
): Promise<string> {
  const target = resolve(root, supplied);
  const physicalRoot = await realpath(root);
  let existing = target;
  let rest = "";
  for (;;) {
    try {
      existing = await realpath(existing);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = dirname(existing);
      if (parent === existing) break;
      rest = join(basename(existing), rest);
      existing = parent;
    }
  }
  if (
    /\0/.test(supplied) ||
    !(inside(root, target) || inside(physicalRoot, target)) ||
    !inside(physicalRoot, join(existing, rest))
  )
    throw new IdiomError(
      `${label} must be inside the bound project root ${root}: ${supplied}`,
    );
  return target;
}

export function findingDetail(
  record: CatalogFinding,
  qualify: (id: string) => string = (id) => id,
) {
  const finding = record.finding;
  const screenshots = finding.evidence.screenshots;
  const crop =
    screenshots.find((path) => /(^|\/)crops\//.test(path)) ?? screenshots[0];
  return {
    id: qualify(finding.id),
    runId: record.runId,
    flow: finding.flow,
    verificationReference: { id: qualify(finding.id), runId: record.runId },
    finding,
    selector: finding.verification.params?.selector,
    measurement: {
      explanation: finding.explanation,
      verification: finding.verification,
    },
    fix: { instructions: finding.fix, acceptance: finding.acceptance },
    coordinate: {
      state: finding.state,
      viewport: finding.viewport,
      colorScheme: finding.colorScheme,
      combination: finding.combination,
    },
    filmstrip: finding.evidence.filmstrip,
    cropPath:
      crop === undefined ? undefined : resolve(record.runDirectory, crop),
    evidencePaths: screenshots.map((path) =>
      resolve(record.runDirectory, path),
    ),
    evidenceStatus:
      crop === undefined
        ? "unavailable: original finding has no visual evidence"
        : "available",
    timeline:
      finding.evidence.timeline === undefined
        ? undefined
        : {
            id: finding.evidence.timeline.id,
            path: resolve(
              record.runDirectory,
              finding.evidence.timeline.artifact,
            ),
          },
  };
}

/** Attach the referenced action; old or missing timelines are not an error. */
async function timelineDetail(
  runDirectory: string,
  reference: { artifact: string; id: string },
): Promise<
  | { status: "available"; record: ActionTimeline }
  | { status: "unavailable: recapture" }
> {
  try {
    const path = await evidencePath(runDirectory, reference.artifact);
    const parsed = actionTimelineArtifactSchema.parse(
      JSON.parse(await readFile(path, "utf8")),
    );
    const record = parsed.actions.find((action) => action.id === reference.id);
    if (record) return { status: "available", record };
  } catch {
    // Fall through: consumers recapture rather than fail the lookup.
  }
  return { status: "unavailable: recapture" };
}

type RunEvidence = {
  runDirectory: string;
  findings: Finding[];
  groups: FindingGroup[];
  issues: CheckIssue[];
  quick: boolean;
};
export class EvidenceStore {
  private ids = new Map<string, RunEvidence>();
  constructor(readonly root: string) {}
  remember(run: RunEvidence) {
    const qualify = (id: string) =>
      run.quick ? `quick:${basename(run.runDirectory)}:${id}` : id;
    for (const id of [
      ...run.findings.map((finding) => finding.id),
      ...run.groups.map((group) => group.id),
    ])
      this.ids.set(qualify(id), run);
  }
  async lookup(id: string) {
    if (id.startsWith("quick:")) {
      const [, runId, localId, ...rest] = id.split(":");
      if (
        !runId ||
        !localId ||
        rest.length ||
        !safeIdentifier(runId) ||
        !safeIdentifier(localId)
      )
        throw new IdiomError(
          "Invalid quick evidence ID; use an ID returned by idiom_quick.",
        );
      let run = this.ids.get(id);
      if (!run) {
        const runDirectory = join(this.root, "idiom-quick-reports", runId);
        await evidencePath(
          join(this.root, "idiom-quick-reports"),
          `${runId}/findings.json`,
        );
        const findings = findingSchema
          .array()
          .parse(
            JSON.parse(
              await readFile(join(runDirectory, "findings.json"), "utf8"),
            ),
          );
        const groups = (await readGroups(runDirectory)) ?? [];
        const detail = JSON.parse(
          await readFile(join(runDirectory, "mcp-detail.json"), "utf8"),
        ) as { issues: CheckIssue[] };
        run = {
          runDirectory,
          findings,
          groups,
          issues: detail.issues,
          quick: true,
        };
        this.remember(run);
      }
      return this.resolve(run, localId);
    }
    const cached = this.ids.get(id);
    const catalog = await loadReviewCatalog({ project: this.root });
    if (id.startsWith("group-")) {
      for (const item of [...catalog.runs].reverse()) {
        const groups = (await readGroups(item.runDirectory)) ?? [];
        if (groups.some((group) => group.id === id)) {
          const findings = item.findings.map((record) => record.finding);
          return this.resolve(
            {
              runDirectory: item.runDirectory,
              findings,
              groups,
              issues:
                cached?.runDirectory === item.runDirectory
                  ? cached.issues
                  : collapseIssues(
                      groups.map((group) => ({
                        ...group,
                        selector: findings.find(
                          (finding) => finding.id === group.representative,
                        )?.verification.params?.selector as string | undefined,
                        coordinates: group.coordinates.map(tupleCoordinateKey),
                      })),
                      new Set(),
                    ),
              quick: false,
            },
            id,
          );
        }
      }
      throw new IdiomError(`Unknown issue/group ${id}; run idiom_check first.`);
    }
    const record = findCatalogFinding(catalog, id);
    if (cached?.runDirectory === record.runDirectory)
      return this.resolve(cached, record.finding.id);
    const groups = (await readGroups(record.runDirectory)) ?? [];
    return this.resolve(
      {
        runDirectory: record.runDirectory,
        findings: catalog.runs
          .find((run) => run.runDirectory === record.runDirectory)
          ?.findings.map((entry) => entry.finding) ?? [record.finding],
        groups,
        issues: collapseIssues(
          groups.map((group) => ({
            ...group,
            selector: catalog.runs
              .find((run) => run.runDirectory === record.runDirectory)
              ?.findings.find(
                (entry) => entry.finding.id === group.representative,
              )?.finding.verification.params?.selector as string | undefined,
            coordinates: group.coordinates.map(tupleCoordinateKey),
          })),
          new Set(),
        ),
        quick: false,
      },
      record.finding.id,
    );
  }
  private resolve(run: RunEvidence, id: string) {
    const group = run.groups.find(
      (group) =>
        group.id === id || group.members.some((member) => member.id === id),
    );
    const issue = run.issues.find(
      (issue) => issue.id === id || issue.groups.includes(group?.id ?? id),
    );
    const representative =
      run.findings.find((finding) => finding.id === id) ??
      run.findings.find((finding) => finding.id === group?.representative);
    if (!representative)
      throw new IdiomError(
        `Evidence ${id} is not materialized in its original run. Obtain a full idiom_check.`,
      );
    const qualify = (value: string) =>
      run.quick ? `quick:${basename(run.runDirectory)}:${value}` : value;
    const record = (finding: Finding): CatalogFinding => ({
      finding,
      runId: basename(run.runDirectory),
      runDirectory: run.runDirectory,
      findingsPath: join(run.runDirectory, "findings.json"),
    });
    const groups = issue
      ? run.groups.filter((candidate) => issue.groups.includes(candidate.id))
      : group
        ? [group]
        : [];
    return {
      run,
      group,
      representative,
      detail: {
        ...findingDetail(record(representative), qualify),
        id: qualify(id),
        group:
          group === undefined
            ? undefined
            : {
                ...group,
                id: qualify(group.id),
                representative: qualify(group.representative),
                members: group.members.map((member) => ({
                  ...member,
                  id: qualify(member.id),
                })),
              },
        siblingGroups: groups
          .filter((candidate) => candidate.id !== group?.id)
          .map((candidate) => ({
            ...candidate,
            id: qualify(candidate.id),
            representative: qualify(candidate.representative),
            members: candidate.members.map((member) => ({
              ...member,
              id: qualify(member.id),
            })),
          })),
        members: run.findings
          .filter((finding) =>
            groups.some((candidate) =>
              candidate.members.some((member) => member.id === finding.id),
            ),
          )
          .map((finding) => findingDetail(record(finding), qualify)),
      },
    };
  }
  async issue(id: string): Promise<CallToolResult> {
    const found = await this.lookup(id);
    const reference = found.representative.evidence.timeline;
    const detail =
      reference === undefined || found.detail.timeline === undefined
        ? found.detail
        : {
            ...found.detail,
            timeline: {
              ...found.detail.timeline,
              ...(await timelineDetail(found.run.runDirectory, reference)),
            },
          };
    const response = result(
      `Evidence for ${id}: ${found.representative.explanation}`,
      detail,
    );
    const filmstrip = found.representative.evidence.filmstrip;
    if (filmstrip?.sheet) {
      try {
        const data = await readFile(
          await evidencePath(found.run.runDirectory, filmstrip.sheet),
        );
        if (data.length > FILMSTRIP_LIMITS.bytes)
          throw new Error("filmstrip exceeds encoded size limit");
        const png = decodeFrame(data);
        if (
          png.width > FILMSTRIP_LIMITS.width ||
          png.height > FILMSTRIP_LIMITS.height
        )
          throw new Error("filmstrip exceeds dimension limits");
        response.content.push({
          type: "image",
          mimeType: "image/png",
          data: data.toString("base64"),
        });
      } catch (error) {
        throw new IdiomError(
          `Cannot read referenced evidence ${filmstrip.sheet}: ${String(error)}. Run idiom_check to regenerate it.`,
        );
      }
    }
    const paths = found.representative.evidence.screenshots;
    const selected =
      paths.find((path) => /(^|\/)crops\//.test(path)) ?? paths[0];
    if (selected !== undefined) {
      try {
        const path = await evidencePath(found.run.runDirectory, selected);
        const data = await readFile(path);
        if (
          !data
            .subarray(0, 8)
            .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
        )
          throw new Error("not a PNG");
        response.content.push({
          type: "image",
          mimeType: "image/png",
          data: data.toString("base64"),
        });
      } catch (error) {
        throw new IdiomError(
          `Cannot read referenced evidence ${selected}: ${String(error)}. Run idiom_check to regenerate it.`,
        );
      }
    }
    return response;
  }
  async source(flow: string, refs: Array<{ id: string; runId: string }>) {
    if (refs.some((ref) => ref.id.startsWith("quick:")))
      throw new IdiomError(
        "Quick evidence requires an initialized flow for verification; run idiom init --flows, then idiom_check.",
      );
    const runId = refs[0]?.runId;
    if (
      !runId ||
      !safeIdentifier(runId) ||
      refs.some((ref) => ref.runId !== runId)
    )
      throw new IdiomError(
        "Verification references must name one exact source run.",
      );
    const validated = await validateProject({ project: this.root, flow });
    const configuredFlow = validated.flows[0]?.flow;
    if (!configuredFlow || configuredFlow.id !== flow)
      throw new IdiomError(`Unknown flow ${flow}.`);
    const reports = join(validated.projectDirectory, ".idiom", "reports");
    const runDirectory = join(reports, runId);
    await evidencePath(reports, `${runId}/findings.json`);
    const originals = findingSchema
      .array()
      .parse(
        JSON.parse(await readFile(join(runDirectory, "findings.json"), "utf8")),
      );
    const findings = refs.map((ref) => {
      const finding = originals.find((finding) => finding.id === ref.id);
      if (!finding || finding.flow !== flow)
        throw new IdiomError(
          `Unknown finding ${ref.id} for flow ${flow} in source run ${runId}; use returned verification references.`,
        );
      return finding;
    });
    const loaded = await loadRunTuples(validated, configuredFlow, runDirectory);
    const expected = expectedCaptureTupleKeys({
      project: validated.project,
      flow: configuredFlow,
      collapsed: loaded.collapsedTupleKeys,
    });
    const actual = loaded.tuples.map((tuple) =>
      captureTupleKey({
        ...tuple,
        colorScheme: tuple.colorScheme ?? validated.project.capture.colorScheme,
      }),
    );
    if (
      !loaded.record ||
      loaded.record.selected.length !== loaded.record.declared.length ||
      expected.some((key) => !actual.includes(key)) ||
      actual.some((key) => !expected.includes(key)) ||
      new Set(actual).size !== actual.length ||
      loaded.tuples.some(
        (tuple) =>
          tuple.failure || tuple.mismatches.length || !tuple.observations,
      )
    )
      throw new IdiomError(
        "Verification requires complete successful full-flow source coverage. Obtain a full idiom_check (without states/viewports) or idiom_fix_plan first.",
      );
    for (const finding of findings)
      for (const path of finding.evidence.screenshots)
        await evidencePath(runDirectory, path);
    return { runId, runDirectory, findings };
  }
}

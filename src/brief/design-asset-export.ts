import {
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  expectedStatusByState,
  selectCaptureTuples,
} from "../capture/resolve.js";
import { type CaptureDependencies, runCapture } from "../capture/run.js";
import { briefMismatchRuleId } from "../checks/brief-mismatch.js";
import type { CheckTuple } from "../checks/types.js";
import { IdiomError } from "../errors.js";
import { findNewestCapture, loadCaptureRun } from "../review/artifacts.js";
import {
  type BriefOption,
  type CompleteStoredBrief,
  isCompleteBrief,
} from "../schemas/brief.js";
import type { Flow } from "../schemas/flow.js";
import type { Project } from "../schemas/project.js";
import { briefEligibility, briefStateMatches } from "./assertions.js";
import {
  DESIGN_ASSET_FORMAT,
  type DesignAsset,
  designAssetSchema,
} from "./design-asset.js";
import { assertionText, chosenOption } from "./render.js";
import { readBrief } from "./store.js";

export type DesignAssetExport = {
  out: string;
  slug: string;
  /** Relative to `out`, sorted. */
  files: string[];
  screenshots: number;
  states: number;
};

type Screenshot = DesignAsset["screenshots"][number];

/** Titles and table cells are single-line. */
function line(value: string): string {
  return value.replace(/\s*[\r\n]+\s*/g, " ").trim();
}

function cell(value: string): string {
  return line(value).replace(/\|/g, "\\|");
}

function segment(value: string): string {
  return value.replace(/[^A-Za-z0-9._+-]/g, "-");
}

/** The decided brief, or why it is not a contract a build can be held to. */
function decidedBrief(
  brief: Awaited<ReturnType<typeof readBrief>>["brief"],
): CompleteStoredBrief {
  if (brief.status !== "decided")
    throw new IdiomError(
      `brief ${brief.slug} is ${brief.status}; decide it first (idiom brief decide)`,
    );
  if (!isCompleteBrief(brief))
    throw new IdiomError(
      `brief ${brief.slug} has incomplete research; record a complete brief and decide it first`,
    );
  const eligible = briefEligibility(brief);
  if (eligible !== true)
    throw new IdiomError(
      `brief ${brief.slug} cannot be a design asset: ${eligible.reason}`,
    );
  return brief;
}

function assetFrom(
  brief: CompleteStoredBrief,
  chosen: BriefOption,
  screenshots: Screenshot[],
  capture: DesignAsset["capture"],
): DesignAsset {
  return designAssetSchema.parse({
    format: DESIGN_ASSET_FORMAT,
    version: 1,
    brief: {
      slug: brief.slug,
      title: line(brief.title),
      decision: brief.decision.trim(),
      chosenOption: chosen.id,
      chosenTitle: line(chosen.title),
      decidedBy: brief.decidedBy ?? "requester",
    },
    criteria: brief.acceptanceCriteria.map((criterion, index) => {
      const assertions = criterion.assertions ?? [];
      return {
        index,
        kind: criterion.kind,
        statement: criterion.statement.trim(),
        assertions,
        rules: assertions.map((assertion, assertionIndex) =>
          briefMismatchRuleId(brief.slug, index, assertionIndex, assertion),
        ),
      };
    }),
    screenshots,
    ...(capture === undefined ? {} : { capture }),
  });
}

/** The asset's README: decision, checkable criteria, references, verification. */
export function renderDesignAssetReadme(
  brief: CompleteStoredBrief,
  asset: DesignAsset,
): string {
  const chosen = brief.options.find(
    (option) => option.id === asset.brief.chosenOption,
  ) as BriefOption;
  const rejected = brief.options.filter((option) => option !== chosen);
  const cost = (option: BriefOption) =>
    `space: ${line(option.cost.space)}; steps: ${line(option.cost.steps)}; new concepts: ${line(option.cost.concepts)}; code: ${line(option.cost.code)}`;
  const machineChecked = asset.criteria.some(
    (criterion) => criterion.assertions.length > 0,
  );
  const blocks = [
    `# ${line(brief.title)}`,
    `Idiom design asset · decided by ${line(asset.brief.decidedBy)} · brief ${brief.slug}`,
    "## Decision",
    brief.decision.trim(),
    `**Chosen:** ${line(chosen.title)}. ${chosen.summary.trim()}`,
    `Cost: ${cost(chosen)}`,
    "### Rejected options",
    rejected
      .map(
        (option) =>
          `- **${line(option.title)}**: ${line(option.summary)} Rejected because ${line(option.rejectedBecause ?? "it was not chosen")}`,
      )
      .join("\n"),
    "## Acceptance criteria",
    asset.criteria
      .map((criterion) =>
        [
          `- [ ] ${line(criterion.statement)}`,
          ...(criterion.assertions.length === 0
            ? [
                "  - Not machine-checked by Idiom: judge it against the reference screenshots.",
              ]
            : criterion.assertions.map(
                (assertion) =>
                  `  - Verified by Idiom: brief-mismatch — ${assertionText(assertion)}, on ${assertion.flow}/${assertion.state}`,
              )),
        ].join("\n"),
      )
      .join("\n"),
    "## Out of scope",
    brief.outOfScope.length === 0
      ? "- Nothing listed."
      : brief.outOfScope.map((item) => `- ${line(item)}`).join("\n"),
    "## Reference screenshots",
  ];
  if (asset.screenshots.length === 0)
    blocks.push(
      "None. No criterion carries an assertion, so Idiom has nothing to verify; the criteria are for human or agent judgement.",
    );
  else
    blocks.push(
      [
        "| Flow | State | Viewport | Scheme | Screenshot |",
        "| --- | --- | --- | --- | --- |",
        ...asset.screenshots.map(
          (shot) =>
            `| ${cell(shot.flow)} | ${cell(shot.state)} | ${cell(shot.viewport)} | ${shot.colorScheme} | [${cell(shot.path.slice("screenshots/".length))}](${shot.path}) |`,
        ),
      ].join("\n"),
      `From capture run ${asset.capture?.runId ?? "unknown"}${asset.capture?.commit === undefined ? "" : ` at commit ${asset.capture.commit.slice(0, 12)}`}. They show the UI **before** the build.`,
    );
  blocks.push(
    "## How this is verified",
    machineChecked
      ? `Inside an autobuild build, \`idiom check --gate\` and \`idiom verify\` read \`.ab/assets/design/<name>/criteria.json\` and report each broken assertion as a \`brief-mismatch\` finding naming this brief (${brief.slug}). These mismatches always block, even when a recorded baseline already holds them.`
      : "Idiom has no assertions to verify for this brief. Judge the criteria above against the built UI.",
  );
  return `${blocks.join("\n\n")}\n`;
}

/** Every successful screenshot of the asserted states, from one capture run. */
function collectScreenshots(options: {
  flow: Flow;
  project: Project;
  states: string[];
  loaded: { tuples: CheckTuple[] };
  runDirectory: string;
  missing: string[];
}): Array<Screenshot & { source: string }> {
  const shots: Array<Screenshot & { source: string }> = [];
  const expected = selectCaptureTuples({
    project: options.project,
    flow: options.flow,
  }).filter((tuple) => options.states.includes(tuple.state.id));
  for (const tuple of expected) {
    const matches = options.loaded.tuples.filter(
      (candidate) =>
        briefStateMatches(candidate.state, tuple.state.id) &&
        candidate.viewport === tuple.viewport.name &&
        candidate.colorScheme === tuple.colorScheme &&
        candidate.failure === undefined &&
        candidate.screenshotPath !== undefined,
    );
    if (matches.length === 0) {
      options.missing.push(
        `${options.flow.id}/${tuple.state.id} at ${tuple.viewport.name}/${tuple.colorScheme}`,
      );
      continue;
    }
    for (const match of matches)
      shots.push({
        flow: options.flow.id,
        state: match.state,
        viewport: match.viewport,
        colorScheme: match.colorScheme ?? tuple.colorScheme,
        path: "",
        source: join(options.runDirectory, match.screenshotPath as string),
      });
  }
  return shots;
}

/**
 * Writes a self-contained design asset for a decided brief: README.md,
 * criteria.json and the reference screenshots of every asserted state at
 * every configured viewport and scheme. Never overwrites; never writes an
 * absolute path.
 */
export async function exportDesignAsset(options: {
  projectDirectory: string;
  project: Project;
  flows: readonly Flow[];
  slug: string;
  out: string;
  cwd?: string | undefined;
  /** Take a fresh capture of the asserted states instead of the latest one. */
  capture?: boolean | undefined;
  dependencies?: { capture?: CaptureDependencies | undefined } | undefined;
}): Promise<DesignAssetExport> {
  const { brief: stored } = await readBrief(
    options.projectDirectory,
    options.slug,
  );
  const brief = decidedBrief(stored);
  const chosen = chosenOption(brief) as BriefOption;
  const out = resolve(options.cwd ?? process.cwd(), options.out);
  const existing = await readdir(out).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new IdiomError(`cannot use ${options.out} as the export directory`);
  });
  if (existing !== undefined && existing.length > 0)
    throw new IdiomError(
      `${options.out} is not empty; export into a new or empty directory`,
    );

  const byFlow = new Map<string, string[]>();
  for (const criterion of brief.acceptanceCriteria)
    for (const assertion of criterion.assertions ?? []) {
      const states = byFlow.get(assertion.flow) ?? [];
      if (!states.includes(assertion.state)) states.push(assertion.state);
      byFlow.set(assertion.flow, states);
    }
  const stateCount = [...byFlow.values()].reduce(
    (sum, states) => sum + states.length,
    0,
  );

  const shots: Array<Screenshot & { source: string }> = [];
  const missing: string[] = [];
  const temporary: string[] = [];
  let capture: DesignAsset["capture"];
  try {
    for (const [flowId, states] of byFlow) {
      const flow = options.flows.find((candidate) => candidate.id === flowId);
      if (flow === undefined)
        throw new IdiomError(
          `brief ${brief.slug} asserts flow ${flowId}, which the project does not declare; re-record the brief`,
        );
      for (const state of states)
        if (!flow.states.some((declared) => declared.id === state))
          throw new IdiomError(
            `brief ${brief.slug} asserts ${flowId}/${state}, which the flow does not declare; re-record the brief`,
          );
      const load = (runDirectory: string) =>
        loadCaptureRun({
          runDirectory,
          expectedFlow: flow.id,
          expectedStatusByState: expectedStatusByState(flow),
          legacyColorScheme: options.project.capture.colorScheme,
        });
      let runDirectory: string | undefined;
      if (options.capture === true) {
        const root = await mkdtemp(join(tmpdir(), "idiom-design-capture-"));
        temporary.push(root);
        const requested = selectCaptureTuples({
          project: options.project,
          flow,
        })
          .filter((tuple) => states.includes(tuple.state.id))
          .map((tuple) => ({
            state: tuple.state.id,
            viewport: tuple.viewport.name,
            colorScheme: tuple.colorScheme,
          }));
        const run = await runCapture({
          projectDirectory: options.projectDirectory,
          project: options.project,
          flow,
          out: join(root, "run"),
          tuples: requested,
          dependencies: options.dependencies?.capture,
        });
        runDirectory = run.runDirectory;
        const loaded = await load(runDirectory);
        const failed = loaded.tuples.filter(
          (tuple) => tuple.failure !== undefined,
        );
        if (failed.length > 0)
          throw new IdiomError(
            `capture failed for ${failed
              .map(
                (tuple) =>
                  `${flow.id}/${tuple.state} at ${tuple.viewport}/${tuple.colorScheme}: ${tuple.failure?.message}`,
              )
              .join("; ")}`,
          );
        shots.push(
          ...collectScreenshots({
            flow,
            project: options.project,
            states,
            loaded,
            runDirectory,
            missing,
          }),
        );
        capture ??= {
          runId: loaded.runId,
          ...(/^[0-9a-f]{7,64}$/.test(loaded.commit)
            ? { commit: loaded.commit }
            : {}),
        };
        continue;
      }
      runDirectory = await findNewestCapture({
        projectDirectory: options.projectDirectory,
        flow: flow.id,
      });
      if (runDirectory === undefined) {
        for (const tuple of selectCaptureTuples({
          project: options.project,
          flow,
        }))
          if (states.includes(tuple.state.id))
            missing.push(
              `${flow.id}/${tuple.state.id} at ${tuple.viewport.name}/${tuple.colorScheme}`,
            );
        continue;
      }
      const loaded = await load(runDirectory);
      shots.push(
        ...collectScreenshots({
          flow,
          project: options.project,
          states,
          loaded,
          runDirectory,
          missing,
        }),
      );
      capture ??= {
        runId: loaded.runId,
        ...(/^[0-9a-f]{7,64}$/.test(loaded.commit)
          ? { commit: loaded.commit }
          : {}),
      };
    }
    if (missing.length > 0) {
      const flows = [...byFlow.keys()].join(" / ");
      throw new IdiomError(
        `no captured screenshot for ${missing.join(", ")}; capture it (idiom capture ${flows}) or pass --capture`,
      );
    }

    const used = new Set<string>();
    const screenshots: Screenshot[] = shots.map(({ source, ...shot }) => {
      const base = [shot.flow, shot.state, shot.viewport, shot.colorScheme]
        .map(segment)
        .join("--");
      let name = `${base}.png`;
      for (let index = 2; used.has(name); index += 1)
        name = `${base}-${index}.png`;
      used.add(name);
      return { ...shot, path: `screenshots/${name}` };
    });
    const asset = assetFrom(brief, chosen, screenshots, capture);
    const readme = renderDesignAssetReadme(brief, asset);
    const criteria = `${JSON.stringify(asset, null, 2)}\n`;
    const leaks = [options.projectDirectory, homedir(), tmpdir(), out].filter(
      (path) => path.length > 1,
    );
    const leaked = leaks.find(
      (path) => readme.includes(path) || criteria.includes(path),
    );
    if (leaked !== undefined)
      throw new IdiomError(
        `brief ${brief.slug} would export an absolute path (${leaked}); remove it from the brief text and export again`,
      );

    await mkdir(join(out, "screenshots"), { recursive: true });
    try {
      for (const [index, shot] of screenshots.entries())
        await copyFile(
          (shots[index] as { source: string }).source,
          join(out, shot.path),
        );
      await writeFile(join(out, "criteria.json"), criteria, "utf8");
      await writeFile(join(out, "README.md"), readme, "utf8");
    } catch (error) {
      await rm(out, { recursive: true, force: true });
      throw error;
    }
    if (screenshots.length === 0)
      await rm(join(out, "screenshots"), { recursive: true, force: true });
    return {
      out,
      slug: brief.slug,
      files: [
        "README.md",
        "criteria.json",
        ...screenshots.map((shot) => shot.path),
      ].sort(),
      screenshots: screenshots.length,
      states: stateCount,
    };
  } finally {
    for (const directory of temporary)
      await rm(directory, { recursive: true, force: true });
  }
}

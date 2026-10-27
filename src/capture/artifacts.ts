import {
  access,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { arch, release, tmpdir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import { writeDesignArtifacts } from "../design/artifacts.js";
import type { CapturedDesign, DesignDescriptor } from "../design/types.js";
import { IdiomError } from "../errors.js";
import type { Flow, StateCombination, ToggleCap } from "../schemas/flow.js";
import { IDIOM_VERSION } from "../version.js";
import type {
  MetadataUrl,
  ProductionBuild,
  SelectedColorScheme,
  SelectedViewport,
  SourceIdentity,
  TupleResult,
} from "./types.js";

export type ArtifactTuple = {
  /** Every design reference that applied to this tuple, in declaration order. */
  designs?: CapturedDesign[] | undefined;
  /** Why a state's declared references did not apply to this tuple. */
  designNotApplicable?: string | undefined;
  /** State whose screenshot represents this layout; evidence remains local. */
  layoutRepresentative?: string | undefined;
  flow: Flow;
  state: Flow["states"][number];
  viewport: SelectedViewport;
  colorScheme?: SelectedColorScheme | undefined;
  colorSchemeAxis?: boolean | undefined;
  metadataUrl?: MetadataUrl | undefined;
  resolutionFailure?: string | undefined;
  result?: TupleResult | undefined;
  runtimeVersion?: string | undefined;
  /** Labels of combinations collapsed into this one as layout-identical. */
  equivalentCombinations?: string[] | undefined;
};

/** The toggle combination a state was generated for, if any. */
export function stateCombination(
  state: Flow["states"][number],
): StateCombination | undefined {
  return "combination" in state ? state.combination : undefined;
}

export type CollapsedCombination = {
  state: string;
  viewport: string;
  colorScheme: SelectedColorScheme;
  colorSchemeAxis: boolean;
  combination: string;
  sameAs: { state: string; combination: string };
};

export type CombinationSummary = {
  captured: number;
  collapsed: CollapsedCombination[];
  cap?: ToggleCap | undefined;
  notes: string[];
};

export type ArtifactWorkspace = {
  finalDirectory: string;
  stagingDirectory: string;
  dataDirectory: string;
};

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function defaultRunName(now: Date): string {
  return now.toISOString().replaceAll(":", "-").replaceAll(".", "-");
}

export async function createArtifactWorkspace(options: {
  projectDirectory: string;
  out?: string | undefined;
  now?: Date | undefined;
}): Promise<ArtifactWorkspace> {
  const finalDirectory =
    options.out ??
    join(
      options.projectDirectory,
      ".idiom",
      "reports",
      defaultRunName(options.now ?? new Date()),
    );
  try {
    await access(finalDirectory);
    throw new IdiomError(
      `capture output already exists and will not be overwritten: ${finalDirectory}`,
    );
  } catch (error) {
    if (error instanceof IdiomError) throw error;
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const parent = dirname(finalDirectory);
  await mkdir(parent, { recursive: true });
  const stagingDirectory = await mkdtemp(
    join(parent, `.${basename(finalDirectory)}.staging-`),
  );
  const dataDirectory = await mkdtemp(join(tmpdir(), "idiom-capture-data-"));
  return { finalDirectory, stagingDirectory, dataDirectory };
}

function consoleJsonl(result: TupleResult): string {
  if (result.console.length === 0) return "";
  return `${result.console.map((record) => JSON.stringify(record)).join("\n")}\n`;
}

function failure(
  tuple: ArtifactTuple,
): { stage: string; message: string } | undefined {
  const designFailure = tuple.designs?.find(
    (design) => design.failure !== undefined,
  );
  if (designFailure?.failure !== undefined)
    return {
      stage: "design-reference",
      message:
        (tuple.designs?.length ?? 0) > 1 && designFailure.name
          ? `${designFailure.name}: ${designFailure.failure}`
          : designFailure.failure,
    };
  if (tuple.resolutionFailure !== undefined) {
    return { stage: "url-resolution", message: tuple.resolutionFailure };
  }
  if (tuple.result !== undefined && !tuple.result.ok) {
    return { stage: tuple.result.stage, message: tuple.result.message };
  }
  return undefined;
}

function passed(tuple: ArtifactTuple): boolean {
  return (
    (tuple.designs ?? []).every((design) => design.failure === undefined) &&
    tuple.resolutionFailure === undefined &&
    tuple.result?.ok === true &&
    tuple.result.mismatches.length === 0
  );
}

export function tupleRelativeDirectory(
  tuple: Pick<
    ArtifactTuple,
    "state" | "viewport" | "colorScheme" | "colorSchemeAxis"
  >,
): string {
  return join(
    tuple.state.id,
    tuple.viewport.name,
    ...(tuple.colorSchemeAxis ? [tuple.colorScheme ?? "light"] : []),
  );
}

/** The screenshot review will load for this tuple (a collapsed tuple's is its representative's). */
async function appScreenshot(
  stagingDirectory: string,
  tuple: ArtifactTuple,
): Promise<Buffer | undefined> {
  if (tuple.layoutRepresentative === undefined) return tuple.result?.screenshot;
  try {
    return await readFile(
      join(
        stagingDirectory,
        tupleRelativeDirectory({
          ...tuple,
          state: { ...tuple.state, id: tuple.layoutRepresentative },
        }),
        "screenshot.png",
      ),
    );
  } catch {
    return undefined;
  }
}

export async function writeTupleArtifacts(options: {
  stagingDirectory: string;
  tuple: ArtifactTuple;
  source: SourceIdentity;
  browserVersion: string;
  fallbackTimestamp: string;
  build?: ProductionBuild | undefined;
}): Promise<void> {
  const { tuple } = options;
  const directory = join(
    options.stagingDirectory,
    tupleRelativeDirectory(tuple),
  );
  await mkdir(directory, { recursive: true });
  const result = tuple.result;
  if (result !== undefined) {
    if (
      result.screenshot !== undefined &&
      tuple.layoutRepresentative === undefined
    ) {
      await writeFile(join(directory, "screenshot.png"), result.screenshot);
    }
    if (result.dom !== undefined) {
      await writeFile(join(directory, "dom.html"), result.dom);
    }
    await writeFile(join(directory, "console.jsonl"), consoleJsonl(result));
    if (result.axe !== undefined) {
      await writeFile(join(directory, "axe.json"), json(result.axe));
    }
    if (result.observations !== undefined) {
      await writeFile(
        join(directory, "observations.json"),
        json(result.observations),
      );
    }
  }
  const electronTarget =
    tuple.flow.target.kind === "electron" ? tuple.flow.target : undefined;
  const combination = stateCombination(tuple.state);
  const designs: DesignDescriptor[] = [];
  const several = (tuple.designs?.length ?? 0) > 1;
  const screenshot = tuple.designs?.length
    ? await appScreenshot(options.stagingDirectory, tuple)
    : undefined;
  for (const [index, captured] of (tuple.designs ?? []).entries()) {
    const descriptor = await writeDesignArtifacts({
      runDirectory: options.stagingDirectory,
      base: tupleRelativeDirectory(tuple),
      // One reference keeps the original layout and metadata exactly.
      design: several ? captured : { ...captured, name: undefined },
      coordinate: {
        state: tuple.state.id,
        viewport: tuple.viewport.name,
        width: tuple.viewport.width,
        height: tuple.viewport.height,
        colorScheme: tuple.colorScheme ?? "light",
      },
      app: result?.observations,
      appScreenshot: screenshot,
      subdirectory: several
        ? (captured.name ?? `design-${index + 1}`)
        : undefined,
    });
    designs.push(descriptor);
    if (descriptor.status === "failed" && tuple.designs)
      tuple.designs[index] = {
        ...captured,
        failure: descriptor.failure ?? "Design capture failed",
      };
  }
  const design = designs[0];
  // How the screenshot was taken; its drift rects stay in observations.
  const shot =
    result?.observations?.version === 2
      ? result.observations.screenshot
      : undefined;
  const metadata = {
    ...(design === undefined ? {} : { design }),
    ...(several ? { designs } : {}),
    ...(tuple.designNotApplicable === undefined
      ? {}
      : { designNotApplicable: tuple.designNotApplicable }),
    ...(tuple.layoutRepresentative === undefined
      ? {}
      : { layoutRepresentative: tuple.layoutRepresentative }),
    source: options.source,
    ...(options.build === undefined ? {} : { build: options.build }),
    flow: { id: tuple.flow.id, title: tuple.flow.title },
    state: {
      id: tuple.state.id,
      description: tuple.state.description,
      ...("reachedFrom" in tuple.state && tuple.state.reachedFrom !== undefined
        ? { from: tuple.state.reachedFrom.chain.slice(1) }
        : {}),
      ...(tuple.state.siblingGroup === undefined
        ? {}
        : { siblingGroup: tuple.state.siblingGroup }),
      ...(tuple.state.group === undefined ? {} : { group: tuple.state.group }),
    },
    ...(combination === undefined
      ? {}
      : {
          combination: {
            base: combination.base,
            label: combination.label,
            options: combination.options,
            equivalent: tuple.equivalentCombinations ?? [],
          },
        }),
    viewport: {
      name: tuple.viewport.name,
      width: tuple.viewport.width,
      height: tuple.viewport.height,
      deviceScaleFactor: 2,
    },
    colorScheme: tuple.colorScheme ?? "light",
    colorSchemeAxis: tuple.colorSchemeAxis ?? false,
    ...(electronTarget !== undefined
      ? {
          target: {
            kind: "electron",
            launch: {
              executablePath: electronTarget.launch.executablePath,
              args: electronTarget.launch.args,
              ...(electronTarget.launch.cwd === undefined
                ? {}
                : { cwd: electronTarget.launch.cwd }),
            },
            window: electronTarget.window,
          },
          accessibility: {
            engine: "axe",
            mode: "legacy",
            crossOriginFrames: false,
          },
        }
      : {
          url: tuple.metadataUrl ?? {
            kind: "unresolved",
            declaration:
              "url" in tuple.state && tuple.state.url !== undefined
                ? { url: tuple.state.url }
                : {
                    urlFrom:
                      "urlFrom" in tuple.state
                        ? tuple.state.urlFrom
                        : undefined,
                  },
          },
        }),
    timestamps: {
      startedAt: result?.startedAt ?? options.fallbackTimestamp,
      endedAt: result?.endedAt ?? options.fallbackTimestamp,
    },
    status: result?.status ?? null,
    expectations: {
      passed: passed(tuple),
      mismatches: result?.mismatches ?? [],
    },
    failure: tuple.resolutionFailure
      ? { stage: "url-resolution", message: tuple.resolutionFailure }
      : result?.ok === false
        ? { stage: result.stage, message: result.message }
        : null,
    platform: {
      platform: process.platform,
      architecture: arch(),
      release: release(),
    },
    browserVersion: tuple.runtimeVersion ?? options.browserVersion,
    toolVersion: IDIOM_VERSION,
    ...(shot === undefined
      ? {}
      : {
          screenshot: {
            strategy: shot.strategy,
            scale: shot.scale,
            width: shot.width,
            height: shot.height,
            ...(shot.tiles === undefined ? {} : { tiles: shot.tiles }),
            ...(shot.drift === undefined ? {} : { drift: shot.drift }),
          },
        }),
  };
  await writeFile(join(directory, "metadata.json"), json(metadata));
}

async function existingArtifactLinks(
  stagingDirectory: string,
  tuple: ArtifactTuple,
): Promise<string[]> {
  const base = tupleRelativeDirectory(tuple);
  const names = [
    "screenshot.png",
    "dom.html",
    "console.jsonl",
    "axe.json",
    "observations.json",
    "metadata.json",
  ];
  const links: string[] = [];
  for (const name of names) {
    try {
      const path =
        name === "screenshot.png" && tuple.layoutRepresentative !== undefined
          ? join(
              tupleRelativeDirectory({
                ...tuple,
                state: { ...tuple.state, id: tuple.layoutRepresentative },
              }),
              name,
            )
          : join(base, name);
      await access(join(stagingDirectory, path));
      links.push(`[${name}](${path.split("\\").join("/")})`);
    } catch {
      // A typed tuple failure can occur before all browser artifacts exist.
    }
  }
  return links;
}

function capSentence(cap: ToggleCap): string {
  return `Toggles ${cap.combined.join(", ")} combined; ${cap.held.join(", ")} held at ${cap.held.length === 1 ? "its" : "their"} first option (cap of three toggles).`;
}

export async function writeCombinationsReport(options: {
  stagingDirectory: string;
  summary: CombinationSummary;
}): Promise<void> {
  await writeFile(
    join(options.stagingDirectory, "combinations.json"),
    json({
      version: 1,
      evidence: "per-combination",
      captured: options.summary.captured,
      collapsed: options.summary.collapsed,
      ...(options.summary.cap === undefined
        ? {}
        : { cap: options.summary.cap }),
      notes: options.summary.notes,
    }),
  );
}

function combinationLines(summary: CombinationSummary): string[] {
  return [
    "## Combinations",
    "",
    `Combinations: ${summary.captured} captured, ${summary.collapsed.length} collapsed as layout-identical.`,
    "Every combination retains its own expectations, DOM, axe and observations; only layout screenshots are shared.",
    ...(summary.cap === undefined ? [] : ["", capSentence(summary.cap)]),
    ...summary.notes.flatMap((note) => ["", note]),
    ...(summary.collapsed.length === 0
      ? []
      : [
          "",
          ...summary.collapsed.map(
            (entry) =>
              `- ${entry.state}/${entry.viewport}${entry.colorSchemeAxis ? `/${entry.colorScheme}` : ""} (${entry.combination}) = same layout as (${entry.sameAs.combination})`,
          ),
        ]),
    "",
  ];
}

export async function writeBaselineReport(options: {
  stagingDirectory: string;
  flow: Flow;
  tuples: ArtifactTuple[];
  build?: ProductionBuild | undefined;
  combinations?: CombinationSummary | undefined;
}): Promise<{ passed: number; failed: number; total: number }> {
  // Empty production flows still need durable run-level provenance.
  if (options.build !== undefined) {
    await writeFile(
      join(options.stagingDirectory, "build.json"),
      json(options.build),
    );
  }
  const passCount = options.tuples.filter(passed).length;
  const counts = {
    passed: passCount,
    failed: options.tuples.length - passCount,
    total: options.tuples.length,
  };
  const colorSchemeAxis = options.tuples.some((tuple) => tuple.colorSchemeAxis);
  const electronTarget =
    options.flow.target.kind === "electron" ? options.flow.target : undefined;
  const provenance =
    electronTarget !== undefined ? "Window provenance" : "URL provenance";
  const lines = [
    `# Baseline: ${options.flow.title}`,
    "",
    ...(options.build === undefined
      ? []
      : [`Production build: \`${options.build.id}\``, ""]),
    `Flow \`${options.flow.id}\`: ${counts.passed} passed, ${counts.failed} failed, ${counts.total} total.`,
    "",
    colorSchemeAxis
      ? `| State | Viewport | Scheme | Result | ${provenance} | Artifacts |`
      : `| State | Viewport | Result | ${provenance} | Artifacts |`,
    colorSchemeAxis
      ? "| --- | --- | --- | --- | --- | --- |"
      : "| --- | --- | --- | --- | --- |",
  ];
  const tableCell = (value: string) =>
    value.replaceAll("|", "\\|").replace(/\r\n?|\n/g, "<br>");
  for (const tuple of options.tuples) {
    const result = passed(tuple)
      ? "passed"
      : `failed: ${failure(tuple)?.message ?? "expectation mismatch"}`;
    const targetProvenance =
      electronTarget !== undefined
        ? electronTarget.window.title
        : tuple.metadataUrl?.kind === "literal"
          ? tuple.metadataUrl.url
          : (tuple.metadataUrl?.template ?? "unresolved");
    const links = await existingArtifactLinks(options.stagingDirectory, tuple);
    lines.push(
      colorSchemeAxis
        ? `| ${tuple.state.id} | ${tuple.viewport.name} | ${tuple.colorScheme ?? "light"} | ${tableCell(result)} | ${tableCell(targetProvenance)} | ${links.join(" · ")} |`
        : `| ${tuple.state.id} | ${tuple.viewport.name} | ${tableCell(result)} | ${tableCell(targetProvenance)} | ${links.join(" · ")} |`,
    );
  }
  lines.push("");
  if (options.combinations !== undefined)
    lines.push(...combinationLines(options.combinations));
  await writeFile(
    join(options.stagingDirectory, "baseline.md"),
    `${lines.join("\n")}\n`,
  );
  return counts;
}

async function filesBelow(directory: string): Promise<string[]> {
  const results: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) results.push(...(await filesBelow(path)));
    else if (entry.isFile()) results.push(path);
  }
  return results;
}

export async function scanForSecrets(
  stagingDirectory: string,
  environments: NodeJS.ProcessEnv[],
): Promise<void> {
  const secrets: Array<{ name: string; value: Buffer }> = [];
  const seen = new Set<string>();
  for (const environment of environments) {
    for (const [name, value] of Object.entries(environment)) {
      if (
        /_(TOKEN|SECRET|KEY)$/.test(name) &&
        value !== undefined &&
        value.length > 0
      ) {
        const identity = `${name}\0${value}`;
        if (!seen.has(identity)) {
          seen.add(identity);
          secrets.push({ name, value: Buffer.from(value) });
        }
      }
    }
  }
  if (secrets.length === 0) return;
  for (const file of await filesBelow(stagingDirectory)) {
    const contents = await readFile(file);
    for (const { name, value } of secrets) {
      if (contents.includes(value)) {
        throw new IdiomError(
          `secret scan found ${name} in ${relative(stagingDirectory, file)}; no capture was published`,
        );
      }
    }
  }
}

export async function publishArtifacts(
  workspace: ArtifactWorkspace,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  await rename(workspace.stagingDirectory, workspace.finalDirectory);
}

export async function cleanupWorkspace(
  workspace: ArtifactWorkspace,
): Promise<void> {
  const results = await Promise.allSettled([
    rm(workspace.dataDirectory, { recursive: true, force: true }),
    rm(workspace.stagingDirectory, { recursive: true, force: true }),
  ]);
  const rejected = results.find(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  if (rejected !== undefined) throw rejected.reason;
}

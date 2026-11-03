import {
  computeDisclosureCoverage,
  type DisclosureCoverage,
  disclosureCoverageLines,
} from "../coverage/disclosures.js";
import {
  computeEmptyContainerCoverage,
  type EmptyContainerCoverage,
  emptyContainerCoverageLines,
} from "../coverage/empty-containers.js";
import {
  crawlRoutes,
  discoverRouteEntries,
  type ExcludedRoute,
  excludeRoutes,
  routeCoverage,
} from "../coverage/routes.js";
import {
  computeFlowStateCoverage,
  type StateCoverageSummary,
  uncapturedFlowCoverage,
} from "../coverage/states.js";
import { IdiomError } from "../errors.js";
import { findNewestCapture, loadRunTuples } from "../review/artifacts.js";
import { stateChainLabel } from "../schemas/flow.js";
import { validateProject } from "../validation.js";

export type CoverageSummary = ReturnType<typeof routeCoverage> & {
  discoveredFrom: string;
  /** Routes coverage.exclude in project.json removed from the list. */
  excluded: ExcludedRoute[];
  /** Per flow, from its newest capture: disclosures nothing opened. */
  disclosures: Array<{ flow: string; coverage: DisclosureCoverage }>;
  /** Per flow, from its newest capture: containers only ever seen empty. */
  emptyContainers: Array<{ flow: string; coverage: EmptyContainerCoverage }>;
};

type Validated = Awaited<ReturnType<typeof validateProject>>;

/** Each flow's disclosure and empty-container coverage from its newest stored capture. */
async function flowCaptureCoverage(
  validated: Validated,
): Promise<Pick<CoverageSummary, "disclosures" | "emptyContainers">> {
  const disclosures: CoverageSummary["disclosures"] = [];
  const emptyContainers: CoverageSummary["emptyContainers"] = [];
  const unavailable = (flow: string, reason: string) => {
    disclosures.push({ flow, coverage: { status: "unavailable", reason } });
    emptyContainers.push({ flow, coverage: { status: "unavailable", reason } });
  };
  for (const { flow } of validated.flows) {
    const directory = await findNewestCapture({
      projectDirectory: validated.projectDirectory,
      flow: flow.id,
    });
    if (directory === undefined) {
      unavailable(flow.id, `not captured yet; run idiom capture ${flow.id}`);
      continue;
    }
    try {
      const loaded = await loadRunTuples(validated, flow, directory);
      const tuples = loaded.tuples.filter(
        (tuple) => tuple.failure === undefined,
      );
      const labels = Object.fromEntries(
        flow.states.map((state) => [state.id, stateChainLabel(state)]),
      );
      disclosures.push({
        flow: flow.id,
        coverage: computeDisclosureCoverage(tuples, labels),
      });
      emptyContainers.push({
        flow: flow.id,
        coverage: computeEmptyContainerCoverage(tuples, labels),
      });
    } catch (error) {
      if (!(error instanceof IdiomError)) throw error;
      unavailable(flow.id, error.message);
    }
  }
  return { disclosures, emptyContainers };
}

/**
 * Which of the app's routes no flow captures. Idiom's silence about a route
 * nobody captures is not approval; this makes the gap visible.
 */
export async function coverageCommand(options: {
  project?: string | undefined;
  cwd?: string | undefined;
  crawl?: string | undefined;
}): Promise<CoverageSummary> {
  const validated = await validateProject(options);
  const entries =
    options.crawl === undefined
      ? await discoverRouteEntries(validated.projectDirectory)
      : await crawlRoutes(options.crawl);
  if (entries.length === 0)
    throw new IdiomError(
      options.crawl === undefined
        ? "no app/ or pages/ routes found; pass --crawl <url> to discover routes from links"
        : `no same-origin links found at ${options.crawl}`,
    );
  const { kept, excluded } = excludeRoutes(
    entries,
    validated.project.coverage?.exclude ?? [],
  );
  return {
    ...routeCoverage(
      kept,
      validated.flows.map(({ flow }) => flow),
    ),
    discoveredFrom: options.crawl ?? "filesystem routes (app/, pages/)",
    excluded,
    ...(await flowCaptureCoverage(validated)),
  };
}

/**
 * Which states, viewports, schemes, motion modes, network conditions,
 * interactions, and data states each flow's newest stored capture observed.
 * Coverage of what was reviewed, not a measure of quality.
 */
export async function stateCoverageCommand(options: {
  project?: string | undefined;
  cwd?: string | undefined;
}): Promise<StateCoverageSummary> {
  const validated = await validateProject(options);
  const flows = [];
  for (const { flow } of validated.flows) {
    const directory = await findNewestCapture({
      projectDirectory: validated.projectDirectory,
      flow: flow.id,
    });
    if (directory === undefined) {
      flows.push(uncapturedFlowCoverage(flow));
      continue;
    }
    try {
      const loaded = await loadRunTuples(validated, flow, directory);
      flows.push(
        computeFlowStateCoverage({
          project: validated.project,
          flow,
          runId: loaded.runId,
          commit: loaded.commit,
          record: loaded.record,
          tuples: loaded.tuples,
          collapsedTupleKeys: loaded.collapsedTupleKeys,
        }),
      );
    } catch (error) {
      if (!(error instanceof IdiomError)) throw error;
      flows.push(uncapturedFlowCoverage(flow, error.message));
    }
  }
  return { flows };
}

export function renderCoverage(summary: CoverageSummary): string {
  const uncaptured = summary.routes.filter(
    (route) => route.capturedBy.length === 0,
  );
  const lines = [
    `Routes from ${summary.discoveredFrom}: ${summary.routes.length + summary.excluded.length} found, ${summary.excluded.length > 0 ? `${summary.excluded.length} excluded (coverage.exclude), ` : ""}${summary.routes.length - uncaptured.length} captured, ${uncaptured.length} uncaptured.`,
    "",
    "| Route | Captured by | Source |",
    "| --- | --- | --- |",
    ...summary.routes.map(
      (route) =>
        `| ${route.route}${route.examples.length === 0 ? "" : ` (e.g. ${route.examples.slice(0, 3).join(", ")})`} | ${route.capturedBy.length === 0 ? "**uncaptured**" : route.capturedBy.map(({ flow, state, label }) => `${flow}/${label ?? state}`).join(", ")} | ${route.source} |`,
    ),
  ];
  if (summary.unresolvedStates.length > 0)
    lines.push(
      "",
      `States with runtime URLs (urlFrom), not matched to a route: ${summary.unresolvedStates.map(({ flow, state, label }) => `${flow}/${label ?? state}`).join(", ")}.`,
    );
  if (uncaptured.length > 0)
    lines.push(
      "",
      `To capture plain routes, add them to a flow: "routes": [${uncaptured
        .filter((route) => !route.route.includes("["))
        .slice(0, 6)
        .map((route) => JSON.stringify(route.route))
        .join(", ")}]`,
    );
  if (summary.disclosures.length > 0) {
    lines.push("", "Disclosures never opened:");
    for (const { flow, coverage } of summary.disclosures)
      lines.push(
        ...disclosureCoverageLines(coverage).map((line, index) =>
          index === 0 ? `${flow}: ${line}` : line,
        ),
      );
  }
  if (summary.emptyContainers.length > 0) {
    lines.push("", "Containers only ever seen empty:");
    for (const { flow, coverage } of summary.emptyContainers)
      lines.push(
        ...emptyContainerCoverageLines(coverage).map((line, index) =>
          index === 0 ? `${flow}: ${line}` : line,
        ),
      );
  }
  return `${lines.join("\n")}\n`;
}

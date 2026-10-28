import { appendFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { loadDesignComponents } from "../checks/design-components.js";
import { loadTokenDeclarations } from "../checks/observe.js";
import { linkRecording, recordingKey } from "../checks/temporal-evidence.js";
import { captureDesigns, figmaFrameLoader } from "../design/capture.js";
import { classifyDocument } from "../document.js";
import { IdiomError } from "../errors.js";
import {
  buildReviewCoverage,
  renderCoverageMarkdown,
} from "../report/coverage.js";
import { type Flow, isPublishedFlow, isWebFlow } from "../schemas/flow.js";
import {
  effectiveInvariants,
  invariantSelectors,
} from "../schemas/invariant.js";
import { type Project, productionConfigExample } from "../schemas/project.js";
import {
  type ArtifactTuple,
  type CollapsedCombination,
  type CombinationSummary,
  cleanupWorkspace,
  createArtifactWorkspace,
  publishArtifacts,
  scanForSecrets,
  stateCombination,
  writeBaselineReport,
  writeCombinationsReport,
  writeTupleArtifacts,
} from "./artifacts.js";
import { createBrowserLauncher } from "./browser.js";
import { createElectronLauncher } from "./electron.js";
import { mergeExplanations } from "./explanations.js";
import { failureKey } from "./failure.js";
import { captureConcurrency, runCaptureLanes } from "./lanes.js";
import { mergeMotion } from "./motion.js";
import {
  type CaptureLifetime,
  type CaptureOwnership,
  withCaptureOwnership,
} from "./ownership.js";
import {
  bindProjectToPort,
  type PortReservation,
  replaceOrigin,
  requestedPort,
  reservePort,
} from "./port.js";
import {
  createFlowProbeBudget,
  type ProbeBudgetLease,
} from "./probe-budget.js";
import { createProbeLedger } from "./probe-ledger.js";
import { accumulateProbeRound, mergePlannedProbe } from "./probe-merge.js";
import {
  type OwnedServer,
  type ProcessDependencies,
  type ProductionRuntime,
  prepareProduction,
  runServerBuild,
  runSetupSteps,
  startServer,
} from "./process.js";
import {
  captureTupleKey,
  resolveStates,
  selectViewports,
  snapshotSource,
} from "./resolve.js";
import { type RunRecord, runRecordSchema } from "./run-record.js";
import {
  type CaptureScope,
  coordinate,
  probeCoordinates,
  resolveCaptureScope,
} from "./scope.js";
import { mergeTimelines, withTimelineIds } from "./timeline.js";
import { type ControlTiming, skipped, slowestControls } from "./timings.js";
import type {
  BrowserLauncher,
  BrowserSession,
  CaptureRunResult,
  CaptureTupleSelection,
  ElectronLauncher,
  ElectronSession,
  MetadataUrl,
  ProbeProgress,
  ProductionBuild,
  TupleResult,
} from "./types.js";

import { resolveWebHealth } from "./web-steps.js";

/** The whole run's wall-clock target the flow probe budget is sized against. */
export const PROBE_WALL_TARGET_MS = 400_000;
/** Wall time kept back for merging, artifacts and checks after probing. */
const PROBE_WALL_RESERVE_MS = 20_000;
/** Smallest per-lane allowance worth a follow-up probe round. */
const PROBE_MIN_ROUND_MS = 10_000;

export type CaptureDependencies = CaptureLifetime & {
  browserLauncher?: BrowserLauncher | undefined;
  onProbeProgress?: ((event: ProbeProgress) => void) | undefined;
  electronLauncher?: ElectronLauncher;
  process?: ProcessDependencies;
  inheritedEnvironment?: NodeJS.ProcessEnv;
  now?: (() => Date) | undefined;
  monotonicNow?: () => number;
  /** Overrides PROBE_WALL_TARGET_MS. */
  probeWallTargetMs?: number | undefined;
  snapshotSource?: typeof snapshotSource;
  createArtifactWorkspace?: typeof createArtifactWorkspace | undefined;
  /** Recorded Figma API responses in tests. */
  figma?: import("../design/figma/client.js").FigmaDependencies | undefined;
};

function replaceDerivedValue(
  value: string,
  navigationUrl: string,
  metadataUrl: MetadataUrl,
  aliases: string[] = [],
): string {
  if (metadataUrl.kind !== "setup-stdout") return value;
  const navigation = new URL(navigationUrl);
  const template = new URL(metadataUrl.template);
  let replaced = value;
  for (const url of [navigationUrl, ...aliases]) {
    replaced = replaced.split(url).join(metadataUrl.template);
    if (aliases.length > 0) {
      // Rebased aliases can also appear in serialized DOM attributes.
      replaced = replaced
        .split(url.replaceAll("&", "&amp;"))
        .join(metadataUrl.template.replaceAll("&", "&amp;"));
    }
  }
  return replaced.split(navigation.pathname).join(template.pathname);
}

function mapStrings(value: unknown, map: (value: string) => string): unknown {
  if (typeof value === "string") return map(value);
  if (Array.isArray(value)) return value.map((entry) => mapStrings(entry, map));
  if (value !== null && typeof value === "object") {
    return linkRecording(
      {
        ...value,
        ...Object.fromEntries(
          Object.entries(value).map(([key, entry]) => [
            key,
            mapStrings(entry, map),
          ]),
        ),
      },
      recordingKey(value),
    );
  }
  return value;
}

/** Apply one string transform to every derived field of a captured tuple. */
function mapResult(
  result: TupleResult,
  map: (value: string) => string,
): TupleResult {
  const records = result.console.map((record) => ({
    ...record,
    text: map(record.text),
    ...(record.location === undefined
      ? {}
      : { location: { ...record.location, url: map(record.location.url) } }),
  }));
  const axe = mapStrings(result.axe, map);
  const observations = mapStrings(
    result.observations,
    map,
  ) as TupleResult["observations"];
  const timelines =
    result.timelines === undefined
      ? {}
      : {
          timelines: mapStrings(
            result.timelines,
            map,
          ) as TupleResult["timelines"],
        };
  if (result.ok) {
    return {
      ...result,
      dom: map(result.dom),
      console: records,
      axe,
      observations,
      ...timelines,
    };
  }
  return {
    ...result,
    ...(result.dom === undefined ? {} : { dom: map(result.dom) }),
    console: records,
    axe,
    observations,
    ...timelines,
    message: map(result.message),
  };
}

export function sanitizeDerivedResult(
  result: TupleResult,
  navigationUrl: string,
  metadataUrl: MetadataUrl,
  aliases: string[] = [],
): TupleResult {
  if (metadataUrl.kind !== "setup-stdout") return result;
  return mapResult(result, (value) =>
    replaceDerivedValue(value, navigationUrl, metadataUrl, aliases),
  );
}

/**
 * Rewrite the origin a run actually served on back to the configured one, so
 * a per-run port never changes a finding's identity.
 */
export function canonicalizeOrigin(
  result: TupleResult,
  actualOrigin: string,
  configuredOrigin: string,
): TupleResult {
  if (actualOrigin === configuredOrigin) return result;
  return mapResult(result, (value) =>
    replaceOrigin(value, actualOrigin, configuredOrigin),
  );
}

type CaptureOptions = {
  filmstripRequests?: import("./types.js").FilmstripRequest[] | undefined;
  projectDirectory: string;
  project: Project;
  flow: Flow;
  out?: string | undefined;
  tuples?: CaptureTupleSelection[] | undefined;
  scope?: CaptureScope | undefined;
  prod?: boolean | undefined;
  /** Serve on this port instead of a free one (`--port`). */
  port?: number | undefined;
  /** Verification needs a separate screenshot at every requested coordinate. */
  deduplicateCombinations?: boolean | undefined;
  /** Refetch pinned Figma frames instead of reusing the cache. */
  refreshDesign?: boolean | undefined;
  dependencies?: CaptureDependencies | undefined;
};

export async function runCapture(
  options: CaptureOptions,
): Promise<CaptureRunResult> {
  return withCaptureOwnership(
    options.project.capture.maxMinutes ?? 30,
    options.dependencies,
    (owner) => captureOwned(options, owner),
  );
}

async function captureOwned(
  options: CaptureOptions,
  owner: CaptureOwnership,
): Promise<CaptureRunResult> {
  const selection = resolveCaptureScope(options);
  const selectedTuples = selection.selected;
  const probePolicy = probeCoordinates(
    options.project,
    options.flow,
    selectedTuples,
  );
  const probeKeys = new Set(probePolicy.intended.map(captureTupleKey));
  const clock = options.dependencies?.monotonicNow ?? (() => performance.now());
  const runStarted = clock();
  const timings: RunRecord["timings"] = {
    build: skipped(),
    start: skipped(),
    tuples: [],
    probe: skipped(),
    checks: skipped(),
  };
  const productionRequested =
    options.prod === true ||
    (isWebFlow(options.flow) && options.flow.server === "production");
  if (productionRequested && !isWebFlow(options.flow))
    throw new IdiomError("production capture is only available for web flows");
  if (productionRequested && options.project.server.production === undefined)
    throw new IdiomError(
      `production capture requires server.production; ${productionConfigExample}`,
    );
  const asCaptureError = (error: unknown) =>
    error instanceof IdiomError
      ? error
      : new IdiomError(
          `capture failed: ${error instanceof Error ? error.message : String(error)}`,
        );
  const now = options.dependencies?.now ?? (() => new Date());
  const resolvedOut =
    options.out === undefined
      ? undefined
      : resolve(options.projectDirectory, options.out);
  const managedReportsDirectory = resolve(
    options.projectDirectory,
    ".idiom",
    "reports",
  );
  owner.stage("source snapshot");
  const source = await (options.dependencies?.snapshotSource ?? snapshotSource)(
    options.projectDirectory,
    {
      excludedPaths: [
        managedReportsDirectory,
        ...(resolvedOut === undefined ? [] : [resolvedOut]),
      ],
      explicitOutputPath: resolvedOut,
    },
  );
  owner.stage("tokens");
  const tokens = await loadTokenDeclarations(
    options.projectDirectory,
    options.project.design.tokensFile,
    options.project.design.tokens,
  );
  const designComponents = await loadDesignComponents(
    options.projectDirectory,
    options.project,
  );
  owner.stage("workspace initialization");
  const workspace = await owner.acquire(
    (options.dependencies?.createArtifactWorkspace ?? createArtifactWorkspace)({
      projectDirectory: options.projectDirectory,
      out: resolvedOut,
      now: now(),
    }),
    cleanupWorkspace,
  );
  owner.check();
  const inherited = options.dependencies?.inheritedEnvironment ?? process.env;
  const effectiveEnvironments: NodeJS.ProcessEnv[] = [inherited];
  const controller = { signal: owner.signal };
  // TERM and KILL each fit inside the fixed five-second cleanup grace.
  const processDependencies = {
    ...options.dependencies?.process,
    teardownTimeoutMs: Math.min(
      options.dependencies?.process?.teardownTimeoutMs ?? 3000,
      2000,
    ),
  };
  const prepareRuntime = () =>
    prepareProduction({
      projectDirectory: options.projectDirectory,
      project: options.project,
      dataDirectory: workspace.dataDirectory,
      commit: source.commit,
      dirty: source.dirty,
      port: requestedPort({
        flag: options.port,
        environment: inherited,
        project: options.project,
      }),
      inheritedEnvironment: inherited,
      dependencies: { ...processDependencies, monotonicNow: clock },
      onActivity: owner.stage,
      signal: controller.signal,
    });
  let production: ProductionRuntime | undefined;
  let build: ProductionBuild | undefined;
  let project = options.project;
  let server: OwnedServer | undefined;
  let reservation: PortReservation | undefined;
  let browser: BrowserSession | undefined;
  let electron: ElectronSession | undefined;
  const closeActive = async () => {
    await Promise.all(
      [browser, electron, server, production, reservation]
        .filter(
          (value): value is NonNullable<typeof value> => value !== undefined,
        )
        .map((value) => owner.close(value)),
    );
  };
  const assertNotInterrupted = owner.check;

  let completed: CaptureRunResult | undefined;
  let failure: unknown;
  try {
    if (productionRequested && options.project.server.production?.reuseBuild) {
      owner.stage("production preparation");
      production = await owner.acquire(prepareRuntime(), (runtime) =>
        runtime.close(),
      );
    }
    owner.stage("setup");
    const setup = await runSetupSteps({
      projectDirectory: options.projectDirectory,
      flow: options.flow,
      signal: controller.signal,
      onActivity: owner.stage,
      dataDirectory: production?.dataDirectory ?? workspace.dataDirectory,
      inheritedEnvironment: inherited,
      dependencies: processDependencies,
    });
    assertNotInterrupted();
    effectiveEnvironments.push(...setup.effectiveEnvironments);
    const tuples: ArtifactTuple[] = [];
    let combinations: CombinationSummary | undefined;
    let browserVersion = "unavailable";
    if (isWebFlow(options.flow)) {
      const flowHealth = resolveWebHealth(
        options.projectDirectory,
        options.flow.health,
        { allow: { urls: [], console: [] } },
      );
      const explicitPort = requestedPort({
        flag: options.port,
        environment: inherited,
        project: options.project,
      });
      if (productionRequested) {
        owner.stage("production preparation");
        production ??= await owner.acquire(prepareRuntime(), (runtime) =>
          runtime.close(),
        );
        effectiveEnvironments.push(production.environment);
        project = production.project;
        owner.stage("production build/start");
        build = await production.execute();
        timings.build = production.timings.build;
        timings.start = production.timings.start;
        assertNotInterrupted();
      } else {
        let port = explicitPort;
        if (port === undefined) {
          owner.stage("port allocation");
          reservation = await owner.acquire(
            reservePort(options.project.server.port),
            (held) => held.release(),
          );
          port = reservation.port;
        }
        project = bindProjectToPort(options.project, port);
      }
      const configuredOrigin = new URL(options.project.server.readyUrl).origin;
      const boundOrigin = new URL(project.server.readyUrl).origin;
      const resolutions = resolveStates({
        project,
        flow: options.flow,
        setupStdout: setup.capturedStdout,
        ...(boundOrigin === configuredOrigin
          ? {}
          : { originalReadyUrl: options.project.server.readyUrl }),
        states: [
          ...new Map(
            selectedTuples.map(({ state }) => [state.id, state]),
          ).values(),
        ],
      });
      if (!productionRequested) {
        const buildStarted = clock();
        owner.stage("server build");
        const serverEnvironment = await runServerBuild({
          projectDirectory: options.projectDirectory,
          project,
          dataDirectory: workspace.dataDirectory,
          port: project.server.port,
          signal: controller.signal,
          inheritedEnvironment: inherited,
          dependencies: processDependencies,
        });
        assertNotInterrupted();
        timings.build = {
          status: "measured",
          ms: Math.max(0, clock() - buildStarted),
        };
        effectiveEnvironments.push(serverEnvironment);
        const held = reservation;
        reservation = undefined;
        if (held) await owner.close(held);
        owner.check();
        const startStarted = clock();
        owner.stage("server readiness");
        server = await startServer({
          signal: controller.signal,
          onOwned: (owned) => {
            server = owner.own(owned, (value) => value.stop());
          },
          projectDirectory: options.projectDirectory,
          project,
          environment: serverEnvironment,
          configuredPort: options.project.server.port,
          dependencies: processDependencies,
        });
        timings.start = {
          status: "measured",
          ms: Math.max(0, clock() - startStarted),
        };
        assertNotInterrupted();
      }
      owner.stage("browser launch");
      if (server) owner.own(server, (value) => value.stop());
      browser = await owner.acquire(
        (
          options.dependencies?.browserLauncher ??
          createBrowserLauncher({ monotonicNow: clock })
        )({ signal: owner.signal, onActivity: owner.stage }),
        (value) => value.close(),
      );
      assertNotInterrupted();
      browserVersion = browser.version;
      const resolutionByState = new Map(
        resolutions.map((resolution) => [
          resolution.ok ? resolution.value.state.id : resolution.state.id,
          resolution,
        ]),
      );
      const tupleHealth = (
        state: (typeof selectedTuples)[number]["state"],
      ) => ({
        ...flowHealth,
        allow: {
          urls: [
            ...flowHealth.allow.urls,
            ...("health" in state ? state.health.allow.urls : []),
          ],
          console: [
            ...flowHealth.allow.console,
            ...("health" in state ? state.health.allow.console : []),
          ],
        },
      });
      // Combinations whose toggled regions lay out identically to an earlier
      // combination of the same base state, viewport, and scheme are measured
      // and share screenshots while retaining independent deterministic evidence.
      const collapsed = new Map<string, CollapsedCombination>();

      const tupleId = (selected: (typeof selectedTuples)[number]) =>
        `${selected.state.id}\0${selected.viewport.name}\0${selected.colorScheme}`;
      if (options.flow.toggles !== undefined) {
        const notes: string[] = [];
        const measure =
          options.deduplicateCombinations === false
            ? undefined
            : browser.measure?.bind(browser);
        const representatives = new Map<
          string,
          (typeof selectedTuples)[number]
        >();
        const unsigned = new Set<string>();
        for (const selected of selectedTuples) {
          assertNotInterrupted();
          const combination = stateCombination(selected.state);
          const resolution = resolutionByState.get(selected.state.id);
          if (
            combination === undefined ||
            measure === undefined ||
            resolution?.ok !== true
          )
            continue;
          const state = resolution.value.state;
          const invariants = effectiveInvariants(options.flow, state);
          const selectors = [
            ...new Set([
              ...(options.flow.toggleRegions ?? []),
              ...invariants.flatMap((invariant) =>
                invariantSelectors(invariant.declaration),
              ),
            ]),
          ];
          if (selectors.length === 0) {
            unsigned.add(combination.base);
            continue;
          }
          owner.coordinate(selected, "combination measurement");
          const signature = await measure(
            {
              signal: owner.signal,
              onActivity: owner.stage,
              invariants,
              project,
              state,
              viewport: selected.viewport,
              colorScheme: selected.colorScheme,
              navigationUrl: resolution.value.navigationUrl,
              health: tupleHealth(selected.state),
              tokens,
            },
            selectors,
          );
          assertNotInterrupted();
          if (signature === undefined) continue;
          const group = `${combination.base}\0${selected.viewport.name}\0${selected.colorScheme}\0${signature}`;
          const representative = representatives.get(group);
          if (representative === undefined) {
            representatives.set(group, selected);
            continue;
          }
          const sameAs = stateCombination(representative.state);
          if (sameAs === undefined) continue;
          collapsed.set(tupleId(selected), {
            state: selected.state.id,
            viewport: selected.viewport.name,
            colorScheme: selected.colorScheme,
            colorSchemeAxis: selected.colorSchemeAxis,
            combination: combination.label,
            sameAs: {
              state: representative.state.id,
              combination: sameAs.label,
            },
          });
        }
        if (measure === undefined)
          notes.push(
            options.deduplicateCombinations === false
              ? "Combination layout deduplication is disabled; every requested coordinate is retained."
              : "The browser session cannot measure layouts; combinations were not deduplicated.",
          );
        for (const base of unsigned)
          notes.push(
            `State ${base} declares no toggleRegions or invariants; its combinations were not deduplicated.`,
          );
        combinations = {
          captured: selectedTuples.filter(
            (selected) =>
              stateCombination(selected.state) !== undefined &&
              !collapsed.has(tupleId(selected)),
          ).length,
          collapsed: [...collapsed.values()],
          cap: options.flow.toggleCap,
          notes,
        };
      }
      const capturedByKey = new Map<string, ArtifactTuple>();
      const probeLedger = createProbeLedger();
      let probeBudgets = new Map<string, ProbeBudgetLease>();
      /** Tuples whose probe already ran once; later rounds accumulate. */
      const probedOnce = new Set<number>();
      type LaneResult = {
        artifact: ArtifactTuple;
        timing: RunRecord["timings"]["tuples"][number];
        executed: boolean;
        controls: ControlTiming[];
      };
      const session = browser;
      // Filled by position, so the run reads as if captured in order.
      const laneResults: Array<LaneResult | undefined> = [];
      const captureTuple = async (
        selected: (typeof selectedTuples)[number],
        index: number,
        probePass = false,
      ) => {
        const previous = probePass ? laneResults[index] : undefined;
        let executed = false;
        let controls: ControlTiming[] = [];
        owner.coordinate(selected, "tuple");
        const resolution = resolutionByState.get(selected.state.id);
        if (resolution === undefined) {
          throw new IdiomError(
            `missing state resolution for ${selected.state.id}`,
          );
        }
        if (resolution.ok) {
          const probe = probeKeys.has(tupleId(selected));
          const collapse = collapsed.get(tupleId(selected));
          const representative =
            collapse === undefined
              ? undefined
              : capturedByKey.get(
                  `${collapse.sameAs.state}\0${selected.viewport.name}\0${selected.colorScheme}`,
                );
          const reuseScreenshot =
            representative?.result?.ok === true
              ? representative.result.screenshot
              : undefined;
          // The collapsed tuple decides drift against its own observations.
          const reuseScreenshotGeometry =
            representative?.result?.ok === true &&
            representative.result.screenshotGeometry !== undefined
              ? (({ drift: _drift, rects: _rects, ...own }) => own)(
                  representative.result.screenshotGeometry,
                )
              : undefined;
          if (collapse !== undefined && reuseScreenshot === undefined)
            collapsed.delete(tupleId(selected));
          const captureStarted = clock();
          const captured = await session.capture({
            signal: owner.signal,
            onActivity: owner.stage,
            onProbeProgress: (event) =>
              options.dependencies?.onProbeProgress?.({
                ...event,
                ...coordinate(selected),
              }),
            shell: options.flow.shell,
            reuseScreenshot,
            reuseScreenshotGeometry,
            invariants: effectiveInvariants(
              options.flow,
              resolution.value.state,
            ),
            project,
            filmstripRequests: options.filmstripRequests?.filter(
              (r) =>
                r.state === selected.state.id &&
                r.viewport === selected.viewport.name &&
                (r.colorScheme === undefined ||
                  r.colorScheme === selected.colorScheme),
            ),
            state: resolution.value.state,
            viewport: selected.viewport,
            colorScheme: selected.colorScheme,
            navigationUrl: resolution.value.navigationUrl,
            health: tupleHealth(selected.state),
            tokens,
            designComponents,
            ...(probe
              ? {
                  probe: true,
                  probeLedger,
                  failureReplays:
                    previous?.artifact.result?.observations?.version === 2
                      ? previous.artifact.result.observations.probe
                          ?.failureReplay?.completed
                      : undefined,
                  enumerateProbe: session.planProbes && !probePass,
                  probeBudget: probePass
                    ? probeBudgets.get(tupleId(selected))
                    : undefined,
                }
              : {}),
            ...(isPublishedFlow(options.flow) ? { published: true } : {}),
          });
          owner.check();
          if (probePass && captured.probeMs === undefined)
            probeBudgets.get(tupleId(selected))?.finish(0);
          if (session.planProbes && !probePass) captured.probeMs = undefined;
          if (previous?.artifact.result?.observations?.version === 2) {
            // Keep the saved evidence even if the disposable probe context
            // cannot reach it; every planned control still receives a reason.
            const round = (captured.observations?.version === 2
              ? captured.observations.probe
              : undefined) ?? {
              status: "partial" as const,
              results: [],
              reason: captured.ok
                ? "probe evidence unavailable"
                : `probe context failed: ${captured.message}`,
            };
            const earlier = probedOnce.has(index)
              ? previous.artifact.result.observations.probe
              : undefined;
            const probe = earlier
              ? accumulateProbeRound(earlier, round)
              : round;
            if (earlier && previous.artifact.result.probeMs !== undefined)
              captured.probeMs =
                previous.artifact.result.probeMs + (captured.probeMs ?? 0);
            probedOnce.add(index);
            const focusVisible =
              captured.observations?.version === 2
                ? captured.observations.focusVisible
                : undefined;
            // This round re-navigated: only its probe clicks are new.
            const roundTimelines = captured.timelines && {
              ...captured.timelines,
              // A web step's held replay repeats each round; keep the first.
              actions: captured.timelines.actions.filter(
                (action) =>
                  action.source === "probe-click" ||
                  action.source === "probe-hover" ||
                  (action.source === "failure-replay" &&
                    !previous.artifact.result?.timelines?.actions.some(
                      (earlier) =>
                        earlier.source === "failure-replay" &&
                        earlier.selector === action.selector &&
                        earlier.failure !== undefined &&
                        action.failure !== undefined &&
                        failureKey(
                          earlier.selector ?? earlier.name,
                          earlier.failure.requests,
                        ) ===
                          failureKey(
                            action.selector ?? action.name,
                            action.failure.requests,
                          ),
                    )) ||
                  (action.source === "slow-replay" &&
                    !(
                      action.held?.of === "web-step" &&
                      previous.artifact.result?.timelines?.actions.some(
                        (earlier) =>
                          earlier.source === "slow-replay" &&
                          earlier.held?.of === "web-step" &&
                          earlier.stepIndex === action.stepIndex,
                      )
                    )),
              ),
            };
            const filmstrips =
              captured.filmstrips?.merge(previous.artifact.result.filmstrips) ??
              previous.artifact.result.filmstrips;
            Object.assign(captured, {
              ...previous.artifact.result,
              probeMs: captured.probeMs,
            });
            captured.filmstrips = filmstrips;
            captured.timelines = withTimelineIds(
              mergeTimelines(
                previous.artifact.result.timelines,
                roundTimelines,
              ),
            );
            captured.observations = {
              ...previous.artifact.result.observations,
              probe,
              focusVisible:
                focusVisible ??
                previous.artifact.result.observations.focusVisible,
              motion: mergeMotion(
                previous.artifact.result.observations.motion,
                probe.motion,
              ),
              explanations: mergeExplanations(
                previous.artifact.result.observations.explanations,
                probe.explanations,
              ),
            };
          }
          const probeTiming =
            captured.probeMs === undefined
              ? {
                  status: probe
                    ? ("unavailable" as const)
                    : ("skipped" as const),
                  ms: 0,
                }
              : { status: "measured" as const, ms: captured.probeMs };
          if (captured.probeMs !== undefined) executed = true;
          const timing = {
            ...coordinate(selected),
            total: {
              status: "measured" as const,
              ms:
                (previous?.timing.total.ms ?? 0) +
                Math.max(0, clock() - captureStarted),
            },
            probe: probeTiming,
          };
          const result = canonicalizeOrigin(
            sanitizeDerivedResult(
              captured,
              resolution.value.navigationUrl,
              resolution.value.metadataUrl,
              resolution.value.sanitizationAliases,
            ),
            boundOrigin,
            configuredOrigin,
          );
          if (result.observations?.version === 2) {
            controls = (result.observations.probe?.results ?? []).flatMap(
              (control) =>
                control.elapsedMs === undefined ||
                control.status === "not-reached"
                  ? []
                  : [
                      {
                        ...coordinate(selected),
                        selector: control.selector,
                        name: control.name,
                        elapsedMs: control.elapsedMs,
                        outcome:
                          control.status === "timed-out"
                            ? ("timed-out" as const)
                            : ("completed" as const),
                      },
                    ],
            );
          }
          if (!result.ok) collapsed.delete(tupleId(selected));
          const artifact: ArtifactTuple = {
            ...(collapsed.has(tupleId(selected))
              ? { layoutRepresentative: collapse?.sameAs.state }
              : {}),
            flow: options.flow,
            state: resolution.value.state,
            viewport: selected.viewport,
            colorScheme: selected.colorScheme,
            colorSchemeAxis: selected.colorSchemeAxis,
            metadataUrl:
              resolution.value.metadataUrl.origin === configuredOrigin
                ? resolution.value.metadataUrl
                : {
                    ...resolution.value.metadataUrl,
                    canonicalOrigin: configuredOrigin,
                  },
            result,
          };
          capturedByKey.set(tupleId(selected), artifact);
          laneResults[index] = { artifact, timing, executed, controls };
        } else {
          laneResults[index] = {
            timing: {
              ...coordinate(selected),
              total: { status: "unavailable", ms: 0 },
              probe: {
                status: probeKeys.has(tupleId(selected))
                  ? "unavailable"
                  : "skipped",
                ms: 0,
              },
            },
            artifact: {
              flow: options.flow,
              state: resolution.state,
              viewport: selected.viewport,
              colorScheme: selected.colorScheme,
              colorSchemeAxis: selected.colorSchemeAxis,
              resolutionFailure: resolution.message,
            },
            executed: false,
            controls: [],
          };
        }
        assertNotInterrupted();
      };
      await runCaptureLanes({
        tuples: selectedTuples,
        lane: (selected) =>
          `${selected.viewport.name}\0${selected.colorScheme}`,
        first: (selected) => probeKeys.has(tupleId(selected)),
        concurrency: captureConcurrency(project, inherited),
        owner,
        work: captureTuple,
      });
      if (session.planProbes) {
        const partitions = new Map<
          string,
          Array<{
            state: string;
            candidates: import("./probe.js").ProbeCandidate[];
          }>
        >();
        for (const [index, selected] of selectedTuples.entries()) {
          if (!probeKeys.has(tupleId(selected))) continue;
          const observation = laneResults[index]?.artifact.result?.observations;
          const candidates =
            observation?.version === 2
              ? observation.probe?.candidates
              : undefined;
          if (!candidates) continue;
          const partition = `${selected.viewport.name}\0${selected.colorScheme}`;
          const states = partitions.get(partition) ?? [];
          states.push({ state: selected.state.id, candidates });
          partitions.set(partition, states);
        }
        for (const [partition, states] of partitions)
          probeLedger.plan(partition, states);
        const concurrency = captureConcurrency(project, inherited);
        const stateTimeoutMs = project.checks.probe.stateTimeoutMs;
        const runnable = new Map<string, Set<string>>();
        for (const [index, selected] of selectedTuples.entries()) {
          if (
            !probeKeys.has(tupleId(selected)) ||
            !laneResults[index]?.artifact.result?.ok ||
            classifyDocument(
              laneResults[index]?.artifact.result?.observations?.document
                .contentType,
            ) === "non-html"
          )
            continue;
          const partition = `${selected.viewport.name}\0${selected.colorScheme}`;
          const states = runnable.get(partition) ?? new Set<string>();
          states.add(selected.state.id);
          runnable.set(partition, states);
        }
        // The flow's probe time is sized from the wall clock: rounds continue
        // while unfinished work and time before the run's target remain. A
        // round gives each state at most one state budget, and the first
        // round never less than one state budget per lane.
        const wallTarget =
          options.dependencies?.probeWallTargetMs ?? PROBE_WALL_TARGET_MS;
        const flowDeadline = runStarted + wallTarget - PROBE_WALL_RESERVE_MS;
        for (let round = 1; ; round += 1) {
          const work = selectedTuples.flatMap((selected, index) => {
            if (
              !probeKeys.has(tupleId(selected)) ||
              !laneResults[index]?.artifact.result?.ok ||
              classifyDocument(
                laneResults[index]?.artifact.result?.observations?.document
                  .contentType,
              ) === "non-html"
            )
              return [];
            const partition = `${selected.viewport.name}\0${selected.colorScheme}`;
            const count = probeLedger.assignedCount(
              partition,
              selected.state.id,
            );
            // The first round runs every state: unassigned glyphs and local
            // rows still come from its own replay. Shares follow check work.
            return round === 1 || count > 0
              ? [
                  {
                    id: tupleId(selected),
                    count: probeLedger.assignedWeight(
                      partition,
                      selected.state.id,
                    ),
                  },
                ]
              : [];
          });
          if (work.length === 0) break;
          const lanes = Math.min(concurrency, work.length);
          const wallLeft = Math.max(0, flowDeadline - clock());
          const floor = round === 1 ? stateTimeoutMs * lanes : 0;
          const totalMs = Math.max(
            floor,
            Math.min(stateTimeoutMs * work.length, wallLeft * lanes),
          );
          // A follow-up round needs room for at least one control per lane.
          if (round > 1 && totalMs < PROBE_MIN_ROUND_MS * lanes) break;
          const budgets = createFlowProbeBudget(totalMs, work, {
            deadlineAt: Math.max(flowDeadline, clock() + floor / lanes),
            now: clock,
          });
          probeBudgets = budgets;
          const ids = new Set(work.map((item) => item.id));
          // Each state probes in its own fresh context on the capture pool;
          // a round's assignments are fixed, so no two states race for work.
          await runCaptureLanes({
            tuples: selectedTuples,
            lane: (selected) => tupleId(selected),
            concurrency,
            owner,
            work: async (selected, index) => {
              if (ids.has(tupleId(selected)))
                await captureTuple(selected, index, true);
            },
          });
          // Work stealing: whatever an assigned state left unprobed goes back
          // to the flow queue for another state that shows it.
          let requeued = 0;
          for (const [partition, states] of runnable)
            requeued += probeLedger.steal(partition, states);
          if (requeued === 0) break;
        }
        for (const partition of runnable.keys())
          probeLedger.exhaust(partition, "flow probe time exhausted");
        // Merge only after every assigned state finishes, regardless of order.
        for (const [index, selected] of selectedTuples.entries()) {
          if (!probeKeys.has(tupleId(selected))) continue;
          const observation = laneResults[index]?.artifact.result?.observations;
          if (observation?.version !== 2 || !observation.probe) continue;
          const partition = `${selected.viewport.name}\0${selected.colorScheme}`;
          const candidates =
            partitions
              .get(partition)
              ?.find((entry) => entry.state === selected.state.id)
              ?.candidates ?? [];
          mergePlannedProbe({
            ledger: probeLedger,
            partition,
            state: selected.state.id,
            candidates,
            artifact: observation.probe,
          });
          observation.explanations = mergeExplanations(
            observation.explanations,
            observation.probe.explanations,
          );
        }
      }
      for (const entry of laneResults) {
        if (entry === undefined) continue;
        tuples.push(entry.artifact);
        timings.tuples.push(entry.timing);
        if (entry.executed)
          probePolicy.executed.push({
            state: entry.timing.state,
            viewport: entry.timing.viewport,
            colorScheme: entry.timing.colorScheme,
          });
        if (entry.controls.length)
          timings.slowestControls = slowestControls([
            ...(timings.slowestControls ?? []),
            ...entry.controls,
          ]);
      }
      // Finalise only successfully reused images; failures keep their own artifacts.
      for (const entry of collapsed.values()) {
        const representative = capturedByKey.get(
          `${entry.sameAs.state}\0${entry.viewport}\0${entry.colorScheme}`,
        );
        if (representative !== undefined) {
          representative.equivalentCombinations ??= [];
          representative.equivalentCombinations.push(entry.combination);
        }
      }
      if (combinations !== undefined) {
        combinations.collapsed = [...collapsed.values()];
        combinations.captured =
          selectedTuples.filter(
            (selected) => stateCombination(selected.state) !== undefined,
          ).length - collapsed.size;
      }
    } else {
      timings.build = { status: "unsupported", ms: 0 };
      timings.start = { status: "unsupported", ms: 0 };
      owner.stage("Electron session");
      electron = await owner.acquire(
        (options.dependencies?.electronLauncher ?? createElectronLauncher())({
          projectDirectory: options.projectDirectory,
          flow: options.flow,
          dataDirectory: workspace.dataDirectory,
          inheritedEnvironment: inherited,
          signal: owner.signal,
          onActivity: owner.stage,
        }),
        (value) => value.close(),
      );
      effectiveEnvironments.push(electron.effectiveEnvironment);
      for (const selected of selectedTuples) {
        owner.coordinate(selected, "Electron launch");
        const captureStarted = clock();
        const captured = await electron.capture({
          signal: owner.signal,
          onActivity: owner.stage,
          shell: options.flow.shell,
          invariants: effectiveInvariants(options.flow, selected.state),
          project: options.project,
          state:
            selected.state as import("../schemas/flow.js").ElectronFlowState,
          viewport: selected.viewport,
          colorScheme: selected.colorScheme,
          tokens,
        });
        timings.tuples.push({
          ...coordinate(selected),
          total: {
            status: "measured",
            ms: Math.max(0, clock() - captureStarted),
          },
          probe: { status: "unsupported", ms: 0 },
        });
        tuples.push({
          flow: options.flow,
          state:
            selected.state as import("../schemas/flow.js").ElectronFlowState,
          viewport: selected.viewport,
          colorScheme: selected.colorScheme,
          colorSchemeAxis: selected.colorSchemeAxis,
          result: captured.result,
          runtimeVersion: captured.version,
        });
        assertNotInterrupted();
      }
    }

    const figma = figmaFrameLoader({
      projectDirectory: options.projectDirectory,
      refresh: options.refreshDesign,
      deps: options.dependencies?.figma,
    });
    for (const tuple of tuples) {
      if (tuple.state.design === undefined) continue;
      owner.check();
      owner.coordinate(
        {
          ...tuple,
          colorScheme: tuple.colorScheme ?? options.project.capture.colorScheme,
        },
        "design reference",
      );
      const started = clock();
      const planned = await captureDesigns({
        state: tuple.state,
        directory: options.projectDirectory,
        project: options.project,
        viewport: tuple.viewport,
        colorScheme: tuple.colorScheme ?? options.project.capture.colorScheme,
        browser: async () => {
          browser ??= await owner.acquire(
            (options.dependencies?.browserLauncher ?? createBrowserLauncher())({
              signal: owner.signal,
              onActivity: owner.stage,
            }),
            (value) => value.close(),
          );
          return browser;
        },
        figma,
        signal: owner.signal,
        onActivity: owner.stage,
      });
      tuple.designs = planned.designs;
      tuple.designNotApplicable = planned.notApplicable;
      const timing = timings.tuples.find(
        (entry) =>
          entry.state === tuple.state.id &&
          entry.viewport === tuple.viewport.name &&
          entry.colorScheme === tuple.colorScheme,
      );
      if (timing) timing.total.ms += Math.max(0, clock() - started);
    }
    owner.stage("runtime teardown");
    await closeActive();
    owner.stage("artifact writing");
    const fallbackTimestamp = now().toISOString();
    for (const tuple of tuples) {
      owner.check();
      await writeTupleArtifacts({
        stagingDirectory: workspace.stagingDirectory,
        tuple,
        source,
        browserVersion,
        fallbackTimestamp,
        build,
      });
    }
    if (combinations !== undefined)
      await writeCombinationsReport({
        stagingDirectory: workspace.stagingDirectory,
        summary: combinations,
      });
    const counts = await writeBaselineReport({
      stagingDirectory: workspace.stagingDirectory,
      flow: options.flow,
      tuples,
      build,
      combinations,
    });
    timings.probe = {
      status:
        probePolicy.policy === "unsupported"
          ? "unsupported"
          : timings.tuples.some((tuple) => tuple.probe.status === "measured")
            ? "measured"
            : probePolicy.intended.length > 0
              ? "unavailable"
              : "skipped",
      ms: timings.tuples.reduce((sum, tuple) => sum + tuple.probe.ms, 0),
    };
    const scope = runRecordSchema.parse({
      version: 1,
      flow: options.flow.id,
      source,
      declared: selection.declared.map(coordinate),
      selected: selectedTuples.map(coordinate),
      viewports: selectViewports(options.project, options.flow),
      probe: probePolicy,
      timings,
    });
    await writeFile(
      resolve(workspace.stagingDirectory, "run.json"),
      `${JSON.stringify(scope, null, 2)}\n`,
    );

    const coverage = buildReviewCoverage({
      flow: options.flow,
      project: options.project,
      tuples: tuples.map((tuple) => ({
        state: tuple.state.id,
        viewport: tuple.viewport.name,
        colorScheme: tuple.colorScheme,
        mismatches: tuple.result?.mismatches ?? [],
        failure: tuple.resolutionFailure
          ? { stage: "url-resolution", message: tuple.resolutionFailure }
          : tuple.result?.ok === false
            ? { stage: tuple.result.stage, message: tuple.result.message }
            : undefined,
        layoutRepresentative: tuple.layoutRepresentative,
      })),
      commit: source.commit,
      record: scope,
    });
    await appendFile(
      resolve(workspace.stagingDirectory, "baseline.md"),
      `\n${renderCoverageMarkdown(coverage)}`,
    );
    owner.stage("secret scan");
    await scanForSecrets(workspace.stagingDirectory, effectiveEnvironments);
    assertNotInterrupted();
    owner.stage("artifact publication");
    await publishArtifacts(workspace, owner.signal);
    owner.check();
    completed = {
      reportPath: resolve(workspace.finalDirectory, "baseline.md"),
      runDirectory: workspace.finalDirectory,
      counts,
      scope,
      timings,
      ...(build === undefined ? {} : { build }),
    };
  } catch (error) {
    failure = asCaptureError(error);
  } finally {
    try {
      await closeActive();
    } catch (error) {
      failure =
        failure === undefined
          ? asCaptureError(error)
          : new IdiomError(
              `${String(failure)}; cleanup failed: ${String(error)}`,
            );
    }
    try {
      if (!owner.signal.aborted) owner.stage("workspace cleanup");
      await owner.close(workspace);
    } catch (error) {
      failure =
        failure === undefined
          ? asCaptureError(error)
          : new IdiomError(
              `${String(failure)}; cleanup failed: ${String(error)}`,
            );
    }
  }
  if (failure !== undefined) throw failure;
  if (completed === undefined) {
    throw new IdiomError("capture ended without a result");
  }
  return completed;
}

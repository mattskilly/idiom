import { appendFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { loadDesignComponents } from "../checks/design-components.js";
import { loadTokenDeclarations } from "../checks/observe.js";
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
import { Deadline, DeadlineExpired } from "./deadline.js";
import { createElectronLauncher } from "./electron.js";
import {
  bindProjectToPort,
  type PortReservation,
  replaceOrigin,
  requestedPort,
  reservePort,
} from "./port.js";
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
import { skipped, slowestControls } from "./timings.js";
import type {
  BrowserLauncher,
  BrowserSession,
  CaptureActivity,
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

export type CaptureDependencies = {
  browserLauncher?: BrowserLauncher;
  onProbeProgress?: ((event: ProbeProgress) => void) | undefined;
  electronLauncher?: ElectronLauncher;
  process?: ProcessDependencies;
  inheritedEnvironment?: NodeJS.ProcessEnv;
  now?: () => Date;
  monotonicNow?: () => number;
  snapshotSource?: typeof snapshotSource;
  createArtifactWorkspace?: typeof createArtifactWorkspace;
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
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        mapStrings(entry, map),
      ]),
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
  if (result.ok) {
    return {
      ...result,
      dom: map(result.dom),
      console: records,
      axe,
      observations,
    };
  }
  return {
    ...result,
    ...(result.dom === undefined ? {} : { dom: map(result.dom) }),
    console: records,
    axe,
    observations,
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
  dependencies?: CaptureDependencies | undefined;
};

/** Fixed maximum grace after deadline expiry, including all resource teardown. */
const CLEANUP_GRACE_MS = 5000;
class CaptureOwnership {
  private resources = new Map<object, () => Promise<unknown>>();
  private started = new Map<object, Promise<unknown>>();
  activity: CaptureActivity = {
    state: "pending",
    viewport: "pending",
    colorScheme: "pending",
    step: "initialization",
  };
  controller = new AbortController();
  deadline: Deadline;
  constructor(maxMinutes: number) {
    this.deadline = new Deadline(
      "capture",
      Math.min(Number.MAX_SAFE_INTEGER, maxMinutes * 60000),
      () => {
        const a = this.activity;
        return `state ${a.state}, viewport ${a.viewport}, scheme ${a.colorScheme}, step ${a.step}`;
      },
      { signal: this.controller.signal },
    );
  }
  get signal() {
    return this.deadline.signal;
  }
  check = () => this.deadline.check();
  stage = (step: string) => {
    this.check();
    this.activity.step = step;
  };
  coordinate(
    selected: {
      state: { id: string };
      viewport: { name: string };
      colorScheme: string;
    },
    step: string,
  ) {
    this.check();
    this.activity = {
      state: selected.state.id,
      viewport: selected.viewport.name,
      colorScheme: selected.colorScheme,
      step,
    };
  }
  own<T extends object>(value: T, close: (value: T) => Promise<unknown>): T {
    if (!this.resources.has(value))
      this.resources.set(value, () => close(value));
    if (this.signal.aborted) void this.close(value).catch(() => undefined);
    return value;
  }
  async acquire<T extends object>(
    pending: Promise<T>,
    close: (value: T) => Promise<unknown>,
  ): Promise<T> {
    // A launcher/workspace adapter may resolve after the caller has failed.
    const registered = pending.then((value) => this.own(value, close));
    return this.deadline.run(() => registered);
  }
  close(value: object): Promise<unknown> {
    let pending = this.started.get(value);
    if (!pending) {
      pending = Promise.resolve().then(() => this.resources.get(value)?.());
      this.started.set(value, pending);
      void pending.catch(() => undefined);
    }
    return pending;
  }
  async cleanup() {
    await Promise.all(
      [...this.resources.keys()].map((value) => this.close(value)),
    );
  }
}

export async function runCapture(
  options: CaptureOptions,
): Promise<CaptureRunResult> {
  const owner = new CaptureOwnership(options.project.capture.maxMinutes ?? 30);
  const sigint = () =>
    owner.controller.abort(new IdiomError("capture interrupted by SIGINT"));
  const sigterm = () =>
    owner.controller.abort(new IdiomError("capture interrupted by SIGTERM"));
  // A stray rejection from abandoned browser work must end this capture
  // through the normal path, so the application server is always stopped.
  const unhandled = (reason: unknown) =>
    owner.controller.abort(
      new IdiomError(
        `capture failed on an unhandled browser error: ${String(reason).split("\n")[0]}`,
      ),
    );
  process.once("SIGINT", sigint);
  process.once("SIGTERM", sigterm);
  process.on("unhandledRejection", unhandled);
  let failure: unknown;
  let result: CaptureRunResult | undefined;
  // Start cleanup at expiry, independently of the losing operation's finally.
  const abort = () => {
    void owner.cleanup().catch(() => undefined);
  };
  owner.signal.addEventListener("abort", abort, { once: true });
  try {
    result = await owner.deadline.run(() => captureOwned(options, owner));
  } catch (error) {
    failure =
      error instanceof DeadlineExpired && error.scope === "capture"
        ? new IdiomError(
            `Capture exceeded capture.maxMinutes=${options.project.capture.maxMinutes}: ${error.activity}`,
          )
        : error;
  } finally {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        owner.cleanup(),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, CLEANUP_GRACE_MS);
        }),
      ]);
    } catch (error) {
      failure ??= error;
    } finally {
      clearTimeout(timer);
      owner.signal.removeEventListener("abort", abort);
      owner.deadline.dispose();
      process.off("SIGINT", sigint);
      process.off("SIGTERM", sigterm);
      process.off("unhandledRejection", unhandled);
    }
  }
  if (failure !== undefined) throw failure;
  if (!result) throw new IdiomError("capture ended without a result");
  return result;
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
      for (const selected of selectedTuples) {
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
          if (collapse !== undefined && reuseScreenshot === undefined)
            collapsed.delete(tupleId(selected));
          const captureStarted = clock();
          const captured = await browser.capture({
            signal: owner.signal,
            onActivity: owner.stage,
            onProbeProgress: (event) =>
              options.dependencies?.onProbeProgress?.({
                ...event,
                ...coordinate(selected),
              }),
            shell: options.flow.shell,
            reuseScreenshot,
            invariants: effectiveInvariants(
              options.flow,
              resolution.value.state,
            ),
            project,
            state: resolution.value.state,
            viewport: selected.viewport,
            colorScheme: selected.colorScheme,
            navigationUrl: resolution.value.navigationUrl,
            health: tupleHealth(selected.state),
            tokens,
            designComponents,
            ...(probe ? { probe: true } : {}),
            ...(isPublishedFlow(options.flow) ? { published: true } : {}),
          });
          owner.check();
          const probeTiming =
            captured.probeMs === undefined
              ? {
                  status: probe
                    ? ("unavailable" as const)
                    : ("skipped" as const),
                  ms: 0,
                }
              : { status: "measured" as const, ms: captured.probeMs };
          if (captured.probeMs !== undefined)
            probePolicy.executed.push(coordinate(selected));
          timings.tuples.push({
            ...coordinate(selected),
            total: {
              status: "measured",
              ms: Math.max(0, clock() - captureStarted),
            },
            probe: probeTiming,
          });
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
            const controls = (result.observations.probe?.results ?? []).flatMap(
              (control) =>
                control.elapsedMs === undefined
                  ? []
                  : [
                      {
                        ...coordinate(selected),
                        selector: control.selector,
                        name: control.name,
                        elapsedMs: control.elapsedMs,
                        outcome: control.status ?? ("completed" as const),
                      },
                    ],
            );
            if (controls.length)
              timings.slowestControls = slowestControls([
                ...(timings.slowestControls ?? []),
                ...controls,
              ]);
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
          tuples.push(artifact);
          capturedByKey.set(tupleId(selected), artifact);
        } else {
          timings.tuples.push({
            ...coordinate(selected),
            total: { status: "unavailable", ms: 0 },
            probe: {
              status: probeKeys.has(tupleId(selected))
                ? "unavailable"
                : "skipped",
              ms: 0,
            },
          });
          tuples.push({
            flow: options.flow,
            state: resolution.state,
            viewport: selected.viewport,
            colorScheme: selected.colorScheme,
            colorSchemeAxis: selected.colorSchemeAxis,
            resolutionFailure: resolution.message,
          });
        }
        assertNotInterrupted();
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

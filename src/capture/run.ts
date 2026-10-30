import { appendFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { loadDesignComponents } from "../checks/design-components.js";
import { loadTokenDeclarations } from "../checks/observe.js";
import { linkRecording, recordingKey } from "../checks/temporal-evidence.js";
import { captureDesigns, figmaFrameLoader } from "../design/capture.js";
import { classifyDocument } from "../document.js";
import { IdiomError } from "../errors.js";
import { capturePredicateIdentity } from "../findings/settings.js";
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
import { heldStepIndexes, replayKey } from "./loading.js";
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
import {
  accumulateProbeRound,
  fillReplays,
  mergePlannedProbe,
} from "./probe-merge.js";
import {
  type OwnedServer,
  type ProcessDependencies,
  type ProductionRuntime,
  prepareProduction,
  runServerBuild,
  runSetupSteps,
  startServer,
} from "./process.js";
import { createReplayLedger, type ReplayLedger } from "./replay-ledger.js";
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
  /**
   * The flow's web-step replay ledger; null replays every web step at every
   * state that shows it (the behaviour before the ledger).
   */
  replayLedger?: ReplayLedger | null | undefined;
  snapshotSource?: typeof snapshotSource;
  createArtifactWorkspace?: typeof createArtifactWorkspace | undefined;
  /** Recorded Figma API responses in tests. */
  figma?: import("../design/figma/client.js").FigmaDependencies | undefined;
};

function derivedTextTransform(
  navigationUrl: string,
  metadataUrl: MetadataUrl,
  aliases: string[] = [],
): DerivedTransform {
  if (metadataUrl.kind !== "setup-stdout") return (value) => value;
  const path = templatePath(metadataUrl.template);
  const replacements = new Map<string, { value: string; segment: boolean }>();
  const json = (value: string) => JSON.stringify(value).slice(1, -1);
  const amp = (value: string) => value.replaceAll("&", "&amp;");
  const htmlText = (value: string) =>
    amp(value).replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  const htmlAttribute = (value: string) =>
    htmlText(value).replaceAll('"', "&quot;");
  const html = (value: string) => htmlAttribute(value).replaceAll("'", "&#39;");
  const forms = [
    (value: string) => value,
    json,
    // Text, browser attributes and framework attributes escape different
    // quote sets. Embedded JSON can appear inside any of these contexts.
    ...[amp, htmlText, htmlAttribute, html].flatMap((serialize) => [
      serialize,
      (value: string) => serialize(json(value)),
      (value: string) => json(serialize(value)),
    ]),
  ];
  const add = (candidate: string, replacement: string, segment = false) => {
    for (const form of forms) {
      const key = form(candidate);
      if (key && !replacements.has(key))
        replacements.set(key, { value: form(replacement), segment });
    }
  };
  // Keep stable output intact when later probe rounds sanitize it again,
  // even if a route segment is also part of the state/template name.
  add(metadataUrl.template, metadataUrl.template);
  if (path !== "/") add(path, path);
  for (const url of [navigationUrl, ...aliases]) {
    add(url, metadataUrl.template);
    const { pathname } = new URL(url);
    if (pathname !== "/") add(pathname, path);
    // Split before decoding: an encoded slash belongs to one parameter.
    for (const segment of pathname.split("/")) {
      if (!segment) continue;
      add(segment, path, true);
      try {
        add(decodeURIComponent(segment), path, true);
      } catch {
        // Malformed escapes still have an exact encoded spelling to protect.
      }
    }
  }
  const matcher = (mode: DerivedMode) =>
    new RegExp(
      [...replacements.entries()]
        .filter(([, entry]) => mode !== "url" || !entry.segment)
        .sort(([a], [b]) => b.length - a.length)
        .map(([candidate, entry]) => {
          const literal = candidate.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          if (!entry.segment) return literal;
          // A bare parameter is a complete token, not part of an ordinary
          // word, CSS identifier or percent escape (e.g. b in block/available).
          // In a selector, a token at the start of a compound (after a
          // combinator or path slash) is a tag name such as b in body[0]/b[0].
          const selectorTag = mode === "selector" ? "(?<=[^\\s>+~,(/])" : "";
          return `(?<![\\p{L}\\p{N}_%\\-])${selectorTag}${literal}(?![\\p{L}\\p{N}_%\\-])`;
        })
        .join("|"),
      "gu",
    );
  const matchers = {
    text: matcher("text"),
    url: matcher("url"),
    selector: matcher("selector"),
  };
  // One pass over the original text prevents overlaps and replacement text
  // from being consumed by a later segment replacement.
  const transform = (
    value: string,
    mode: Exclude<DerivedMode, "markup"> = "text",
  ) =>
    value.replace(
      matchers[mode],
      (match) => replacements.get(match)?.value ?? match,
    );
  return (value, mode = "text") =>
    mode === "markup"
      ? mapMarkup(value, (text) => transform(text))
      : transform(value, mode);
}

/**
 * The path of a metadata URL template, read from its raw text. Template
 * placeholders are display text, and URL pathname serialization would
 * percent-encode their braces.
 */
function templatePath(template: string): string {
  const path = template
    .replace(/^[a-z][a-z\d+.-]*:\/\/[^/?#]*/i, "")
    .split(/[?#]/, 1)[0];
  return path === undefined || path === "" ? "/" : path;
}

type DerivedMode = "text" | "url" | "selector" | "markup";
type DerivedTransform = (value: string, mode?: DerivedMode) => string;

const rawTextElements = new Set([
  "script",
  "style",
  "textarea",
  "title",
  "xmp",
  "iframe",
  "noembed",
  "noframes",
  "noscript",
  "plaintext",
]);

/**
 * Transform an HTML string's text and attribute values while leaving tag and
 * attribute names alone, so a route value spelled like a tag (b, p, button)
 * never rewrites the markup itself.
 */
function mapMarkup(html: string, text: (value: string) => string): string {
  const tag = /<(\/?)([A-Za-z][^\s/>]*)((?:[^>"']|"[^"]*"|'[^']*')*)(>|$)/y;
  const attribute =
    /([^\s"'>/=]+)(\s*=\s*)("[^"]*"|'[^']*'|[^\s>]+)|[^\s"'>/=]+|[\s\S]/g;
  let out = "";
  let textStart = 0;
  let index = 0;
  while (index < html.length) {
    const open = html.indexOf("<", index);
    if (open === -1) break;
    tag.lastIndex = open;
    const match = tag.exec(html);
    if (!match) {
      index = open + 1;
      continue;
    }
    const [, close = "", name = "", attributes = "", end = ""] = match;
    out += text(html.slice(textStart, open));
    out += `<${close}${name}${attributes.replace(
      attribute,
      (whole, attributeName?: string, equals?: string, value?: string) =>
        value === undefined ? whole : `${attributeName}${equals}${text(value)}`,
    )}${end}`;
    index = textStart = tag.lastIndex;
    if (!close && rawTextElements.has(name.toLowerCase())) {
      // Script and style bodies are text even when they contain `<b`.
      const closing = new RegExp(`</${name}[\\s/>]`, "iy");
      let body = index;
      for (; body < html.length; body++) {
        if (html[body] !== "<") continue;
        closing.lastIndex = body;
        if (closing.test(html)) break;
      }
      index = body;
    }
  }
  return out + text(html.slice(textStart));
}

type StringMap = (value: string, field?: string, measured?: boolean) => string;

// Bare route values belong in captured text/identities, not measurement enums,
// tag/role names, computed CSS, engine ids or other structural string fields.
const structuralFields = new Set([
  "status",
  "source",
  "kind",
  "type",
  "timing",
  "direction",
  "cause",
  "align",
  "of",
  "mode",
  "basis",
  "resourceType",
  "outcome",
  "iterations",
  "side",
  "trigger",
  "policy",
  "timeoutScope",
  "axis",
  "matchedBy",
  "cut",
  "role",
  "scope",
  "action",
  "strategy",
  "pointer",
  "hover",
  "purpose",
  "effects",
  "truncated",
  "method",
  "tag",
  "property",
  "properties",
  "authoredProperties",
  "appearance",
  "cursor",
  "haspopup",
  "state",
  "transition",
  "animation",
  "transform",
  "pseudoElement",
  "fontSize",
  "fontWeight",
  "family",
  "format",
  "used",
  "sourceAction",
  "controlId",
  "timelineId",
  "structuralPath",
  "legacyRenderedPath",
  "stableIslandPath",
  "contentType",
]);

// Axe's fixed report keys are structure; additional keys in rule data can be
// page-derived (unlike the strict observation/timeline schemas).
const axeFields = new Set([
  "testEngine",
  "testRunner",
  "testEnvironment",
  "timestamp",
  "url",
  "toolOptions",
  "inapplicable",
  "incomplete",
  "passes",
  "violations",
  "id",
  "impact",
  "tags",
  "description",
  "help",
  "helpUrl",
  "nodes",
  "any",
  "all",
  "none",
  "html",
  "target",
  "failureSummary",
  "summary",
  "data",
  "message",
  "relatedNodes",
  "name",
  "version",
  "userAgent",
  "windowWidth",
  "windowHeight",
  "orientationAngle",
  "orientationType",
  "result",
  "type",
  "status",
  "kind",
]);

function mapStrings(
  value: unknown,
  map: StringMap,
  field?: string,
  mapKey?: StringMap,
  parent?: string,
  measured = false,
): unknown {
  if (typeof value === "string") return map(value, field, measured);
  if (Array.isArray(value))
    return value.map((entry) =>
      mapStrings(entry, map, field, mapKey, parent, measured),
    );
  if (value !== null && typeof value === "object") {
    // These subtrees contain measured CSS/configuration, not route text.
    const measuredValues =
      measured ||
      field === "styles" ||
      field === "tokens" ||
      ["testEngine", "testRunner", "testEnvironment", "toolOptions"].includes(
        field ?? "",
      ) ||
      "transitionProperty" in value;
    return linkRecording(
      {
        ...Object.fromEntries(
          Object.entries(value).map(([key, entry]) => [
            // Screenshot rects are a selector-keyed dictionary. Fixed schema
            // property names remain intact; these keys follow their selectors.
            field === "rects" && parent === "screenshot"
              ? map(key, "selector")
              : (mapKey?.(key) ?? key),
            mapStrings(
              entry,
              map,
              field === "attributes" ? undefined : key,
              mapKey,
              field,
              measuredValues,
            ),
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
  evidenceMap: StringMap = map,
  axeMap: StringMap = map,
  axeKeyMap?: StringMap,
  domMap: (value: string) => string = map,
): TupleResult {
  const records = result.console.map((record) => ({
    ...record,
    text: map(record.text),
    ...(record.location === undefined
      ? {}
      : { location: { ...record.location, url: map(record.location.url) } }),
  }));
  const axe = mapStrings(result.axe, axeMap, undefined, axeKeyMap);
  const observations = mapStrings(
    result.observations,
    evidenceMap,
  ) as TupleResult["observations"];
  const timelines =
    result.timelines === undefined
      ? {}
      : {
          timelines: mapStrings(
            result.timelines,
            evidenceMap,
          ) as TupleResult["timelines"],
        };
  if (result.ok) {
    return {
      ...result,
      dom: domMap(result.dom),
      console: records,
      axe,
      observations,
      ...timelines,
    };
  }
  return {
    ...result,
    ...(result.dom === undefined ? {} : { dom: domMap(result.dom) }),
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
  const transform = derivedTextTransform(navigationUrl, metadataUrl, aliases);
  const mode = (field: string | undefined, structural = false): DerivedMode =>
    structural || structuralFields.has(field ?? "")
      ? "url"
      : /selector/i.test(field ?? "") || field === "target"
        ? "selector"
        : field === "html"
          ? "markup"
          : "text";
  return mapResult(
    result,
    (value) => transform(value),
    (value, field, measured) => transform(value, mode(field, measured)),
    (value, field, measured) =>
      transform(
        value,
        mode(
          field,
          measured || ["id", "impact", "tags", "version"].includes(field ?? ""),
        ),
      ),
    (key) => (axeFields.has(key) ? key : transform(key)),
    (value) => transform(value, "markup"),
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
      const injected = options.dependencies?.replayLedger;
      const replayLedger =
        injected === null ? undefined : (injected ?? createReplayLedger());
      /** Each probed tuple's held web steps: replay keys and step indexes. */
      const replayKeysOf = new Map<
        number,
        Array<{ key: string; stepIndex: number }>
      >();
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
                  // Held replays run only in the probe pass.
                  ...(probePass && replayLedger ? { replayLedger } : {}),
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
          const result = captured;
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
        // Web-step held replays: the steps each state's enumerate pass showed
        // sending requests, keyed by the steps through them, each owned by
        // one state. The others receive its result after the round.
        const replayPartitions = new Map<
          string,
          Array<{ state: string; keys: string[] }>
        >();
        for (const [index, selected] of selectedTuples.entries()) {
          const partition = `${selected.viewport.name}\0${selected.colorScheme}`;
          if (!runnable.get(partition)?.has(selected.state.id)) continue;
          const resolution = resolutionByState.get(selected.state.id);
          if (!resolution?.ok) continue;
          const state = resolution.value.state;
          const steps = "health" in state ? state.steps : [];
          const held = heldStepIndexes(
            laneResults[index]?.artifact.result?.timelines?.actions ?? [],
            steps,
          ).map((stepIndex) => ({
            stepIndex,
            key: replayKey(resolution.value.navigationUrl, steps, stepIndex),
          }));
          replayKeysOf.set(index, held);
          const states = replayPartitions.get(partition) ?? [];
          states.push({
            state: selected.state.id,
            keys: held.map(({ key }) => key),
          });
          replayPartitions.set(partition, states);
        }
        for (const [partition, states] of replayPartitions)
          replayLedger?.plan(partition, states);
        /** Copy finished web-step replays into every other holder. */
        const fillAll = () => {
          if (!replayLedger) return;
          for (const [index, held] of replayKeysOf) {
            const selected = selectedTuples[index];
            const result = laneResults[index]?.artifact.result;
            if (!selected || !result || held.length === 0) continue;
            const resolution = resolutionByState.get(selected.state.id);
            if (!resolution?.ok) continue;
            const probe =
              result.observations?.version === 2
                ? result.observations.probe
                : undefined;
            result.timelines = fillReplays({
              ledger: replayLedger,
              partition: `${selected.viewport.name}\0${selected.colorScheme}`,
              state: selected.state.id,
              // A state that kept its own replay of a step (one that did not
              // record) is not given a second.
              keys: held
                .filter(
                  ({ stepIndex }) =>
                    !result.timelines?.actions.some(
                      (action) =>
                        action.held?.of === "web-step" &&
                        action.stepIndex === stepIndex,
                    ),
                )
                .map(({ key }) => key),
              timelines: result.timelines,
              probe,
              delayMs: project.checks.loading.delayMs,
              // Keep copied evidence raw as well: later probe rounds compare
              // selectors, names and completed failure keys against the browser.
            });
          }
        };
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
            const replays =
              replayLedger?.assignedCount(partition, selected.state.id) ?? 0;
            const count =
              probeLedger.assignedCount(partition, selected.state.id) + replays;
            // The first round runs every state: unassigned glyphs and local
            // rows still come from its own replay. Shares follow check work.
            return round === 1 || count > 0
              ? [
                  {
                    id: tupleId(selected),
                    count:
                      probeLedger.assignedWeight(partition, selected.state.id) +
                      replays,
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
          // After the round's barrier: other states' web-step replays.
          fillAll();
          // Work stealing: whatever an assigned state left unprobed goes back
          // to the flow queue for another state that shows it.
          let requeued = 0;
          for (const [partition, states] of runnable) {
            const ran = new Set(
              selectedTuples
                .filter(
                  (selected) =>
                    ids.has(tupleId(selected)) &&
                    `${selected.viewport.name}\0${selected.colorScheme}` ===
                      partition,
                )
                .map((selected) => selected.state.id),
            );
            requeued +=
              probeLedger.steal(partition, states) +
              (replayLedger?.steal(partition, ran, states) ?? 0);
          }
          if (requeued === 0) break;
        }
        for (const partition of runnable.keys()) {
          probeLedger.exhaust(partition, "flow probe time exhausted");
          replayLedger?.exhaust(partition, "flow probe time exhausted");
        }
        fillAll();
        // A holder that got neither its own replay nor a copy says why.
        for (const [index, held] of replayKeysOf) {
          const selected = selectedTuples[index];
          const result = laneResults[index]?.artifact.result;
          if (
            !replayLedger ||
            !selected ||
            !result ||
            result.observations?.version !== 2
          )
            continue;
          const partition = `${selected.viewport.name}\0${selected.colorScheme}`;
          for (const { key, stepIndex } of held) {
            if (
              replayLedger.lookup(partition, key) ||
              result.timelines?.actions.some(
                (action) =>
                  action.held?.of === "web-step" &&
                  action.stepIndex === stepIndex,
              )
            )
              continue;
            const reason = replayLedger.finalReason(partition, key);
            const probe = result.observations.probe;
            if (!reason || !probe) continue;
            probe.heldReplay ??= {
              delayMs: project.checks.loading.delayMs,
              queued: 0,
              ran: 0,
              notes: [],
            };
            const note = `not reached: ${reason} (step ${stepIndex})`;
            if (!probe.heldReplay.notes.includes(note))
              probe.heldReplay.notes.push(note);
          }
        }
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
      for (const [index, entry] of laneResults.entries()) {
        if (entry === undefined) continue;
        const selected = selectedTuples[index];
        const resolution = selected && resolutionByState.get(selected.state.id);
        if (entry.artifact.result && resolution?.ok) {
          // All planning, probe rounds and ledger merges use raw identities.
          // Normalize the completed evidence once, before checks and writers.
          const result = canonicalizeOrigin(
            sanitizeDerivedResult(
              entry.artifact.result,
              resolution.value.navigationUrl,
              resolution.value.metadataUrl,
              resolution.value.sanitizationAliases,
            ),
            boundOrigin,
            configuredOrigin,
          );
          entry.artifact.result = result;
          const controlText = derivedTextTransform(
            resolution.value.navigationUrl,
            resolution.value.metadataUrl,
            resolution.value.sanitizationAliases,
          );
          entry.controls = entry.controls.map((control) => ({
            ...control,
            selector: replaceOrigin(
              controlText(control.selector, "selector"),
              boundOrigin,
              configuredOrigin,
            ),
            name: replaceOrigin(
              controlText(control.name),
              boundOrigin,
              configuredOrigin,
            ),
          }));
        }
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
      captureSettingsIdentity: capturePredicateIdentity(
        options.project,
        options.flow,
      ),
      flow: options.flow.id,
      source,
      declared: selection.declared.map(coordinate),
      selected: selectedTuples.map(coordinate),
      viewports: selectViewports(options.project, options.flow),
      probe: probePolicy,
      timings,
      capture: { reducedMotion: options.project.capture.reducedMotion },
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

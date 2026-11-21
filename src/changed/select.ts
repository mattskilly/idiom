import { realpath } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import {
  discoverRouteTopology,
  routeCoverage,
  routeForFile,
} from "../coverage/routes.js";
import type { Flow } from "../schemas/flow.js";
import {
  type DesignContext,
  defaultDesignContext,
  designContextPaths,
  projectPrefix,
} from "./design-context.js";
import type { ChangeSet } from "./git.js";
import { classifyByPath } from "./non-ui.js";

export type StateIdentity = { flow: string; state: string };
export type FileMapping = {
  path: string;
  kind:
    | "route"
    | "import"
    | "global"
    | "unresolved"
    | "documentation"
    | "non-ui";
  reason: string;
  routes: string[];
  states: StateIdentity[];
  importChains?: string[][];
  uncertainties?: string[];
};
export type ChangedSelection = {
  git: Omit<ChangeSet, "files">;
  files: FileMapping[];
  candidates: StateIdentity[];
  selected: StateIdentity[];
  skipped: StateIdentity[];
  fallbackFiles: string[];
  /**
   * Whether the import graph accounts for every route module's edges. Only a
   * complete graph lets the build gate treat an unreached module as non-UI.
   */
  graph?: { complete: boolean; reasons: string[] } | undefined;
};
export const stateKey = (state: StateIdentity) =>
  `${state.flow}\0${state.state}`;
const within = (directory: string, file: string) => {
  const path = relative(directory, file);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== "..");
};
export function isGlobalFile(path: string): boolean {
  const normalized = path.replaceAll(sep, "/");
  return (
    /(?:^|\/)\.idiom\//.test(normalized) ||
    /(?:^|\/)(?:layout|template|_app|_document|\+layout(?:\.server)?|root)\.[^.]+$/.test(
      normalized,
    ) ||
    /(?:^|\/)(?:tailwind|postcss|theme)(?:\.config)?\.[^/]+$/.test(
      normalized,
    ) ||
    /(?:^|\/)(?:globals?|app|main|index|styles)\.(?:css|scss|sass)$/.test(
      normalized,
    ) ||
    /(?:^|\/)(?:(?:design[-.]?)?tokens)(?:\/|\.[^/]+$)/i.test(normalized)
  );
}

/**
 * A DESIGN.md at any depth. Only the project's own design file is global; any
 * other (a fixture, a template, another package) is documentation.
 */
const isDesignDocument = (path: string) =>
  /(?:^|\/)DESIGN\.md$/i.test(path.replaceAll(sep, "/"));

export async function selectChangedStates(
  project: string,
  flows: Flow[],
  changes: ChangeSet,
  options: {
    design?: DesignContext | undefined;
    /** The project's `checks.gate.nonUi` globs, project-relative. */
    nonUi?: string[] | undefined;
  } = {},
): Promise<ChangedSelection> {
  project = await realpath(project);
  const repository = await realpath(changes.repository).catch(
    () => changes.repository,
  );
  const prefix = await projectPrefix(repository, project);
  // The same design context the build gate widens on, repository-relative.
  const context = designContextPaths(
    options.design ?? defaultDesignContext,
    prefix,
  );
  const candidates = flows.flatMap((flow) =>
    flow.states.map((state) => ({ flow: flow.id, state: state.id })),
  );
  const { files: changedFiles, ...git } = changes;
  const result: ChangedSelection = {
    git,
    files: [],
    candidates,
    selected: [],
    skipped: candidates,
    fallbackFiles: [],
  };
  if (!changedFiles.length) return result;
  // The gate's path pass: globs are project-relative, changed paths
  // repository-relative.
  const local = (path: string) =>
    prefix && path.startsWith(`${prefix}/`)
      ? path.slice(prefix.length + 1)
      : path;
  const byPath = classifyByPath(
    changedFiles.map((file) => {
      const repoPath = file.path.replaceAll(sep, "/");
      return { path: local(repoPath), repoPath };
    }),
    options.nonUi ?? [],
    [context.design, context.product],
  );
  // Files that select nothing: a DESIGN.md outside the design context, and
  // anything the gate's path pass calls non-UI. The project's own design
  // context stays global.
  const quietMappings = changedFiles.map(
    (file, index): Pick<FileMapping, "kind" | "reason"> | undefined => {
      const path = file.path.replaceAll(sep, "/");
      if (path === context.design || path === context.product) return undefined;
      if (isDesignDocument(path))
        return {
          kind: "documentation",
          reason:
            "a DESIGN.md outside this project's design context (design.designFile): documentation",
        };
      const pathClass = byPath[index];
      if (pathClass && !pathClass.ui)
        return { kind: "non-ui", reason: pathClass.reason };
      return undefined;
    },
  );
  // Nothing rendered changed: no route discovery or import graph to build.
  if (quietMappings.every(Boolean)) {
    result.files = changedFiles.map((file, index) => ({
      path: file.path,
      ...(quietMappings[index] as Pick<FileMapping, "kind" | "reason">),
      routes: [],
      states: [],
    }));
    return result;
  }
  const topology = await discoverRouteTopology(project);
  // States no static route can claim (urlFrom, non-web targets, odd URLs) join every source edit.
  const unmappable = candidates.filter(({ flow: id, state: stateId }) => {
    const flow = flows.find((candidate) => candidate.id === id);
    const state = flow?.states.find((candidate) => candidate.id === stateId);
    if (flow?.target.kind !== "web" || !state) return true;
    if (!("url" in state) || state.url === undefined) return true;
    try {
      return !["http:", "https:"].includes(
        new URL(state.url, "http://idiom.invalid").protocol,
      );
    } catch {
      return true;
    }
  });
  const { buildImportGraph } = await import("./imports.js");
  const graph = await buildImportGraph(
    topology.entries.map((entry) => resolve(project, entry.source)),
    topology.globals,
  );
  // A module with an unknowable edge may depend on any file, so the routes reaching it are
  // suspect for every edit; a global module (or a configuration error) makes everything suspect.
  const globalUncertainties = [
    ...graph.globalUncertainties,
    ...topology.uncertainties.map(
      (path) => `unsupported route convention: ${path}`,
    ),
  ];
  const suspectRoutes = new Set<string>();
  const suspectReasons: string[] = [];
  for (const [module, reasons] of graph.uncertainModules) {
    if (graph.globalDependencies.has(module))
      globalUncertainties.push(...reasons);
    const consumers = graph.consumers.get(module);
    if (!consumers) continue;
    suspectReasons.push(...reasons);
    for (const source of consumers.keys())
      for (const entry of topology.entries)
        if (resolve(project, entry.source) === source)
          suspectRoutes.add(entry.route);
  }
  // Reasons name modules repository-relative, like the file mappings.
  const relativeReason = (reason: string) => {
    for (const root of [repository, project])
      if (reason.startsWith(`${root}${sep}`))
        return reason.slice(root.length + 1).replaceAll(sep, "/");
    return reason;
  };
  const graphReasons = [
    ...(topology.entries.length ? [] : ["no route entries"]),
    ...[...graph.uncertainModules.values()].flat().map(relativeReason),
    ...globalUncertainties.map(relativeReason),
    ...(unmappable.length ? [`${unmappable.length} unmappable state(s)`] : []),
  ];
  result.graph = {
    complete: graphReasons.length === 0,
    reasons: [...new Set(graphReasons)],
  };
  const suspectStates = routeCoverage(
    [...suspectRoutes].map((route) => ({ route, source: "" })),
    flows,
  ).routes.flatMap((route) => route.capturedBy);
  const broadening = [
    ...(unmappable.length
      ? [
          `${unmappable.length} state(s) whose URL or target cannot be resolved statically`,
        ]
      : []),
    ...suspectReasons,
  ];
  const selected = new Set<string>();
  for (const [index, file] of changedFiles.entries()) {
    const quietMapping = quietMappings[index];
    let kind: FileMapping["kind"] = "route";
    let reason = "route module or nearest route directory";
    const routes = new Set<string>();
    const chains: string[][] = [];
    const path = file.path.replaceAll(sep, "/");
    if (path === context.design) {
      kind = "global";
      reason = "the project's design file (design.designFile)";
    } else if (path === context.product) {
      kind = "global";
      reason = "the project's product file (design.productFile)";
    } else if (quietMapping) {
      // Never reaches a rendered page: the gate skips it, and so does --changed.
      ({ kind, reason } = quietMapping);
    } else if (
      isGlobalFile(file.path) ||
      graph.globalDependencies.has(file.absolute)
    ) {
      kind = "global";
      reason = "global design, configuration, layout or its dependency";
    } else {
      for (const root of topology.roots) {
        const route = routeForFile(root, file.absolute);
        if (route !== undefined) routes.add(route);
      }
      if (!routes.size) {
        const owners = topology.entries.filter(
          (entry) =>
            within(entry.directory, file.absolute) &&
            (entry.directory !== entry.root.path ||
              dirname(file.absolute) === entry.directory),
        );
        const depth = Math.max(
          -1,
          ...owners.map((entry) => entry.directory.length),
        );
        const nearest = owners.filter(
          (entry) => entry.directory.length === depth,
        );
        if (new Set(nearest.map((entry) => entry.route)).size === 1)
          for (const entry of nearest) routes.add(entry.route);
      }
      const consumers = graph.consumers.get(file.absolute);
      if (consumers) {
        if (!routes.size) {
          kind = "import";
          reason = "transitive static import from route modules";
        }
        for (const [source, chain] of consumers) {
          for (const entry of topology.entries)
            if (resolve(project, entry.source) === source)
              routes.add(entry.route);
          chains.push(chain.map((path) => relative(changes.repository, path)));
        }
      }
      if (!routes.size || globalUncertainties.length) {
        kind = "unresolved";
        reason =
          globalUncertainties[0] ??
          "no reliable route ownership or static import association";
      }
    }
    const fallback = kind === "global" || kind === "unresolved";
    const quiet = kind === "documentation" || kind === "non-ui";
    const states = fallback
      ? candidates
      : quiet
        ? []
        : [
            ...routeCoverage(
              [...routes].map((route) => ({ route, source: file.path })),
              flows,
            ).routes.flatMap((route) => route.capturedBy),
            ...unmappable,
            ...suspectStates,
          ];
    const keys = new Set(states.map(stateKey));
    const affected = candidates.filter((state) => keys.has(stateKey(state)));
    for (const state of affected) selected.add(stateKey(state));
    if (fallback) result.fallbackFiles.push(file.path);
    result.files.push({
      path: file.path,
      kind,
      reason,
      routes: [...routes].sort(),
      states: affected,
      ...(chains.length ? { importChains: chains } : {}),
      ...(kind === "unresolved" && globalUncertainties.length
        ? { uncertainties: globalUncertainties }
        : !fallback && !quiet && broadening.length
          ? { uncertainties: broadening }
          : {}),
    });
  }
  result.selected = candidates.filter((state) => selected.has(stateKey(state)));
  result.skipped = candidates.filter((state) => !selected.has(stateKey(state)));
  return result;
}

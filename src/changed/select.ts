import { realpath } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import {
  discoverRouteTopology,
  routeCoverage,
  routeForFile,
} from "../coverage/routes.js";
import type { Flow } from "../schemas/flow.js";
import type { ChangeSet } from "./git.js";

export type StateIdentity = { flow: string; state: string };
export type FileMapping = {
  path: string;
  kind: "route" | "import" | "global" | "unresolved";
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
    /(?:^|\/)DESIGN\.md$/i.test(normalized) ||
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

export async function selectChangedStates(
  project: string,
  flows: Flow[],
  changes: ChangeSet,
): Promise<ChangedSelection> {
  project = await realpath(project);
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
  for (const file of changedFiles) {
    let kind: FileMapping["kind"] = "route";
    let reason = "route module or nearest route directory";
    const routes = new Set<string>();
    const chains: string[][] = [];
    if (
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
    const states = fallback
      ? candidates
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
        : !fallback && broadening.length
          ? { uncertainties: broadening }
          : {}),
    });
  }
  result.selected = candidates.filter((state) => selected.has(stateKey(state)));
  result.skipped = candidates.filter((state) => !selected.has(stateKey(state)));
  return result;
}

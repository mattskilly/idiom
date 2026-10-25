import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { IdiomError } from "../errors.js";
import { type Flow, isWebFlow } from "../schemas/flow.js";
import type { Project } from "../schemas/project.js";
import type {
  CaptureTupleSelection,
  FlowState,
  SelectedColorScheme,
  SelectedViewport,
  SourceIdentity,
  StateResolution,
} from "./types.js";

const execFileAsync = promisify(execFile);
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function assertSafeUnique(values: string[], kind: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (!SAFE_ID.test(value)) {
      throw new IdiomError(
        `${kind} id ${JSON.stringify(value)} is path-unsafe; use letters, numbers, dot, underscore, or dash`,
      );
    }
    if (seen.has(value)) {
      throw new IdiomError(`duplicate ${kind} id ${JSON.stringify(value)}`);
    }
    seen.add(value);
  }
}

export async function snapshotSource(
  projectDirectory: string,
  options: {
    excludedPaths?: string[] | undefined;
    explicitOutputPath?: string | undefined;
  } = {},
): Promise<SourceIdentity> {
  try {
    const [{ stdout: commit }, { stdout: rootOutput }] = await Promise.all([
      execFileAsync("git", ["rev-parse", "HEAD"], {
        cwd: projectDirectory,
        encoding: "utf8",
      }),
      execFileAsync("git", ["rev-parse", "--show-toplevel"], {
        cwd: projectDirectory,
        encoding: "utf8",
      }),
    ]);
    const root = await realpath(rootOutput.trim());
    const canonicalProject = await realpath(projectDirectory);
    const canonicalizeFromProject = (path: string) =>
      resolve(
        canonicalProject,
        relative(resolve(projectDirectory), resolve(path)),
      );
    const explicitOutput = options.explicitOutputPath;
    if (explicitOutput !== undefined) {
      const canonicalOutput = canonicalizeFromProject(explicitOutput);
      const managedReports = canonicalizeFromProject(
        resolve(projectDirectory, ".idiom", "reports"),
      );
      const relativeToRepository = relative(root, canonicalOutput);
      const insideRepository =
        relativeToRepository !== "" &&
        relativeToRepository !== ".." &&
        !relativeToRepository.startsWith(`..${sep}`);
      const relativeToReports = relative(managedReports, canonicalOutput);
      const insideManagedReports =
        relativeToReports === "" ||
        (relativeToReports !== ".." &&
          !relativeToReports.startsWith(`..${sep}`));
      if (insideRepository && !insideManagedReports) {
        try {
          await execFileAsync(
            "git",
            [
              "check-ignore",
              "--quiet",
              "--no-index",
              resolve(canonicalOutput, ".idiom-output-probe"),
            ],
            { cwd: projectDirectory },
          );
        } catch {
          throw new IdiomError(
            `repo-internal --out must be gitignored or located under .idiom/reports so capture artifacts cannot change source identity: ${explicitOutput}`,
          );
        }
      }
    }
    const excludedDirectories = [
      ...(options.excludedPaths ?? []),
      resolve(projectDirectory, ".idiom", "cache", "production"),
    ]
      .map((path) => relative(root, canonicalizeFromProject(path)))
      .filter(
        (path) => path !== "" && path !== ".." && !path.startsWith(`..${sep}`),
      )
      .map((path) => path.split(sep).join("/"));
    const { stdout: status } = await execFileAsync(
      "git",
      ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
      { cwd: root, encoding: "utf8" },
    );
    const pathIsExcluded = (path: string) =>
      excludedDirectories.some(
        (directory) => path === directory || path.startsWith(`${directory}/`),
      );
    const records = status.split("\0").filter((record) => record.length > 0);
    let dirty = false;
    for (let index = 0; index < records.length; index += 1) {
      const record = records[index];
      if (record === undefined) continue;
      const code = record.slice(0, 2);
      const paths = [record.slice(3)];
      if (/[RC]/.test(code)) {
        const source = records[index + 1];
        if (source !== undefined) paths.push(source);
        index += 1;
      }
      if (!paths.every(pathIsExcluded)) {
        dirty = true;
        break;
      }
    }
    return { commit: commit.trim(), dirty };
  } catch (error) {
    if (error instanceof IdiomError) throw error;
    throw new IdiomError(
      `target project is not a readable Git worktree: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function selectViewports(
  project: Project,
  flow: Flow,
): SelectedViewport[] {
  assertSafeUnique(
    flow.states.map((state) => state.id),
    "state",
  );
  assertSafeUnique(
    project.viewports.map((viewport) => viewport.name),
    "viewport",
  );
  const byName = new Map(
    project.viewports.map((viewport) => [viewport.name, viewport]),
  );
  const names = flow.viewports ?? project.viewports.map(({ name }) => name);
  assertSafeUnique(names, "selected viewport");
  // A project viewport wins over a published flow's same-named width.
  const sizes = isWebFlow(flow) ? flow.viewportSizes : undefined;
  return names.map((name) => {
    const viewport = byName.get(name);
    if (viewport !== undefined) return viewport;
    const size =
      sizes !== undefined && Object.hasOwn(sizes, name)
        ? sizes[name]
        : undefined;
    if (size === undefined) {
      throw new IdiomError(`unknown project viewport ${JSON.stringify(name)}`);
    }
    return { name, width: size.width, height: size.height };
  });
}

/**
 * A state may narrow the flow's viewport matrix (for example a panel that is
 * offscreen by design on mobile). Names outside the flow selection are a
 * configuration error rather than a silent expansion.
 */
export function stateViewports(
  viewports: SelectedViewport[],
  state: { id: string; viewports?: string[] | undefined },
): SelectedViewport[] {
  if (state.viewports === undefined) return viewports;
  const byName = new Map(
    viewports.map((viewport) => [viewport.name, viewport]),
  );
  return state.viewports.map((name) => {
    const viewport = byName.get(name);
    if (viewport === undefined)
      throw new IdiomError(
        `state ${JSON.stringify(state.id)} selects viewport ${JSON.stringify(name)}, which its flow does not capture`,
      );
    return viewport;
  });
}

export function selectColorSchemes(
  project: Project,
  flow: Flow,
): SelectedColorScheme[] {
  const declared = new Set<SelectedColorScheme>(project.colorSchemes);
  const schemes = flow.colorSchemes ?? project.colorSchemes;
  for (const scheme of schemes) {
    if (!declared.has(scheme)) {
      throw new IdiomError(
        `unknown project color scheme ${JSON.stringify(scheme)}`,
      );
    }
  }
  return [...schemes];
}

export function captureTupleKey(tuple: {
  state: string;
  viewport: string;
  colorScheme: SelectedColorScheme;
}): string {
  return `${tuple.state}\0${tuple.viewport}\0${tuple.colorScheme}`;
}

export function expectedCaptureTupleKeys(options: {
  project: Project;
  flow: Flow;
  collapsed?: Iterable<string> | undefined;
}): string[] {
  const viewports = selectViewports(options.project, options.flow);
  const schemes = selectColorSchemes(options.project, options.flow);
  const collapsed = new Set(options.collapsed);
  return options.flow.states
    .flatMap((state) =>
      stateViewports(viewports, state).flatMap((viewport) =>
        schemes.map((colorScheme) =>
          captureTupleKey({
            state: state.id,
            viewport: viewport.name,
            colorScheme,
          }),
        ),
      ),
    )
    .filter((key) => !collapsed.has(key));
}

export function selectCaptureTuples<T extends Flow>(options: {
  project: Project;
  flow: T;
  requested?: CaptureTupleSelection[] | undefined;
}): Array<{
  state: T["states"][number];
  viewport: SelectedViewport;
  colorScheme: SelectedColorScheme;
  colorSchemeAxis: boolean;
}> {
  const viewports = selectViewports(options.project, options.flow);
  const colorSchemes = selectColorSchemes(options.project, options.flow);
  const stateById = new Map(
    options.flow.states.map((state) => [state.id, state] as const),
  );
  const viewportByName = new Map(
    viewports.map((viewport) => [viewport.name, viewport] as const),
  );
  const selectedSchemes = new Set(colorSchemes);
  if (options.requested === undefined) {
    return options.flow.states.flatMap((state) =>
      stateViewports(viewports, state).flatMap((viewport) =>
        colorSchemes.map((colorScheme) => ({
          state,
          viewport,
          colorScheme,
          colorSchemeAxis: options.project.colorSchemes.length > 1,
        })),
      ),
    ) as Array<{
      state: T["states"][number];
      viewport: SelectedViewport;
      colorScheme: SelectedColorScheme;
      colorSchemeAxis: boolean;
    }>;
  }
  const requested = new Set<string>();
  for (const pair of options.requested) {
    if (!stateById.has(pair.state))
      throw new IdiomError(
        `capture tuple references unknown state ${JSON.stringify(pair.state)}`,
      );
    if (!viewportByName.has(pair.viewport))
      throw new IdiomError(
        `capture tuple references unknown viewport ${JSON.stringify(pair.viewport)}`,
      );
    const colorScheme = pair.colorScheme ?? options.project.capture.colorScheme;
    if (!selectedSchemes.has(colorScheme))
      throw new IdiomError(
        `capture tuple references unknown or flow-unselected color scheme ${JSON.stringify(colorScheme)}`,
      );
    requested.add(
      captureTupleKey({
        state: pair.state,
        viewport: pair.viewport,
        colorScheme,
      }),
    );
  }
  return options.flow.states.flatMap((state) =>
    stateViewports(viewports, state).flatMap((viewport) =>
      colorSchemes.flatMap((colorScheme) =>
        requested.has(
          captureTupleKey({
            state: state.id,
            viewport: viewport.name,
            colorScheme,
          }),
        )
          ? [
              {
                state,
                viewport,
                colorScheme,
                colorSchemeAxis: options.project.colorSchemes.length > 1,
              },
            ]
          : [],
      ),
    ),
  ) as Array<{
    state: T["states"][number];
    viewport: SelectedViewport;
    colorScheme: SelectedColorScheme;
    colorSchemeAxis: boolean;
  }>;
}

export function expectedStatusByState(flow: Flow): Map<string, number> {
  return new Map(
    flow.states.flatMap((state) =>
      state.expect.status === undefined
        ? []
        : [[state.id, state.expect.status] as const],
    ),
  );
}

export function localOrigin(readyUrl: string): URL {
  let ready: URL;
  try {
    ready = new URL(readyUrl);
  } catch {
    throw new IdiomError(
      `server.readyUrl is not a valid absolute URL: ${readyUrl}`,
    );
  }
  const hostname = ready.hostname.toLowerCase();
  const loopback =
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1" ||
    hostname === "[::1]";
  if (
    !loopback ||
    (ready.protocol !== "http:" && ready.protocol !== "https:")
  ) {
    throw new IdiomError(
      `server.readyUrl must use HTTP(S) on a loopback hostname: ${readyUrl}`,
    );
  }
  return ready;
}

function sameOrigin(value: string, ready: URL): URL {
  let resolved: URL;
  try {
    resolved = new URL(value, ready.origin);
  } catch {
    throw new Error(`could not parse URL ${JSON.stringify(value)}`);
  }
  if (resolved.origin !== ready.origin) {
    throw new Error(
      `resolved URL origin ${resolved.origin} does not match local server origin ${ready.origin}`,
    );
  }
  return resolved;
}

export function resolveStates(options: {
  project: Project;
  flow: Flow;
  setupStdout: string[];
  states?: FlowState[] | undefined;
  originalReadyUrl?: string | undefined;
}): StateResolution[] {
  const ready = localOrigin(options.project.server.readyUrl);
  const original =
    options.originalReadyUrl === undefined
      ? undefined
      : localOrigin(options.originalReadyUrl);
  const rebase = (value: string): URL => {
    const parsed = new URL(value, ready.origin);
    if (original !== undefined && parsed.origin === original.origin) {
      parsed.protocol = ready.protocol;
      parsed.host = ready.host;
    }
    return sameOrigin(parsed.href, ready);
  };
  const stdout = options.setupStdout.join("");
  return (options.states ?? options.flow.states).map(
    (state): StateResolution => {
      try {
        if (state.url !== undefined) {
          const resolved = rebase(state.url);
          return {
            ok: true,
            value: {
              state,
              navigationUrl: resolved.href,
              metadataUrl: {
                kind: "literal",
                origin: ready.origin,
                url: resolved.href,
              },
            },
          };
        }
        if (state.urlFrom === undefined)
          throw new Error("state has no URL source");
        const match = new RegExp(state.urlFrom.pattern).exec(stdout);
        const captured = match?.[1];
        if (captured === undefined) {
          throw new Error(
            `setup stdout did not match pattern ${JSON.stringify(state.urlFrom.pattern)}`,
          );
        }
        const append = state.urlFrom.append ?? "";
        const originalUrl = new URL(`${captured}${append}`, ready.origin).href;
        const navigationUrl = rebase(`${captured}${append}`).href;
        const template = `${ready.origin}/{setup-stdout:${state.id}}${append}`;
        return {
          ok: true,
          value: {
            state,
            navigationUrl,
            ...(originalUrl === navigationUrl
              ? {}
              : { sanitizationAliases: [originalUrl] }),
            metadataUrl: {
              kind: "setup-stdout",
              origin: ready.origin,
              source: "setup-stdout",
              pattern: state.urlFrom.pattern,
              append,
              template,
            },
          },
        };
      } catch (error) {
        return {
          ok: false,
          state,
          message: error instanceof Error ? error.message : String(error),
        };
      }
    },
  );
}

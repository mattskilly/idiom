import { readFile, realpath } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { parse } from "smol-toml";
import { IdiomError } from "../errors.js";

export type FileTracker = { root: string; readyState: string; source: string };
export type TicketTarget = {
  root: string;
  outputDirectory: string;
  canonicalRoot: string;
  canonical: boolean;
};

/** Resolve existing prefixes too, so a not-yet-created leaf cannot hide an alias. */
export async function physicalPath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const parent = dirname(path);
    if (parent === path) throw error;
    return join(await physicalPath(parent), basename(path));
  }
}

export async function fileTrackerFrom(start: string): Promise<FileTracker> {
  let directory = resolve(start);
  while (true) {
    const path = join(directory, "autobuild.toml");
    let source: string | undefined;
    try {
      source = await readFile(path, "utf8");
    } catch (error) {
      if (
        !["ENOENT", "ENOTDIR"].includes(
          (error as NodeJS.ErrnoException).code ?? "",
        )
      )
        throw error;
    }
    if (source !== undefined) {
      try {
        const config = parse(source);
        const tickets = config.tickets;
        if (tickets === undefined)
          return {
            root: join(directory, ".autobuild/tickets"),
            readyState: "ready",
            source: "file",
          };
        if (
          typeof tickets !== "object" ||
          tickets === null ||
          Array.isArray(tickets)
        )
          throw new Error("tickets must be a table");
        const table = tickets as Record<string, unknown>;
        for (const key of ["dir", "readyState", "source"])
          if (
            table[key] !== undefined &&
            (typeof table[key] !== "string" || !(table[key] as string).trim())
          )
            throw new Error(`tickets.${key} must be a nonempty string`);
        return {
          root: resolve(
            directory,
            (table.dir as string | undefined) ?? ".autobuild/tickets",
          ),
          readyState: (table.readyState as string | undefined) ?? "ready",
          source: (table.source as string | undefined) ?? "file",
        };
      } catch (error) {
        throw new IdiomError(
          `cannot read ticket configuration ${path}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    const parent = dirname(directory);
    if (parent === directory)
      return {
        root: resolve(start, ".autobuild/tickets"),
        readyState: "ready",
        source: "file",
      };
    directory = parent;
  }
}

function isWithinState(path: string, parent: string): boolean {
  const value = path.toLowerCase();
  const root = parent.toLowerCase();
  return value === root || value.startsWith(`${root}/`);
}

export async function resolveTicketTarget(options: {
  projectDirectory: string;
  out?: string | undefined;
  cwd?: string | undefined;
}): Promise<TicketTarget> {
  const source = await fileTrackerFrom(options.projectDirectory);
  if (options.out === undefined && source.source !== "file")
    throw new IdiomError(
      "clustered tickets require an explicit file output directory for a non-file tracker",
    );
  const supplied =
    options.out === undefined
      ? source.root
      : resolve(options.cwd ?? process.cwd(), options.out);
  const physical = await physicalPath(supplied);
  const target =
    options.out === undefined ? source : await fileTrackerFrom(supplied);
  const physicalConfig =
    options.out === undefined ? source : await fileTrackerFrom(physical);
  // An explicit nested path must not turn a conventional state into a new tracker root.
  for (const candidate of [supplied, physical]) {
    let ancestor = candidate;
    while (dirname(ancestor) !== ancestor) {
      if (["ready", "doing", "done"].includes(basename(ancestor).toLowerCase()))
        throw new IdiomError(
          `ticket destination is inside a workflow state: ${supplied}`,
        );
      ancestor = dirname(ancestor);
    }
  }
  const leaf = basename(physical).toLowerCase();
  const namedTriage = basename(supplied).toLowerCase() === "triage";
  if (
    [
      "ready",
      "doing",
      "done",
      target.readyState.toLowerCase(),
      physicalConfig.readyState.toLowerCase(),
    ].includes(leaf) ||
    ["ready", "doing", "done", target.readyState.toLowerCase()].includes(
      basename(supplied).toLowerCase(),
    )
  )
    throw new IdiomError(`ticket proposals must land in triage: ${supplied}`);
  const root = namedTriage || leaf === "triage" ? dirname(physical) : physical;
  const outputDirectory = await physicalPath(
    namedTriage || leaf === "triage" ? physical : join(root, "triage"),
  );
  for (const config of [target, physicalConfig]) {
    if (config.readyState.toLowerCase() === "triage")
      throw new IdiomError(
        "triage is configured as ready; refusing dispatchable proposals",
      );
    const configuredRoot = await physicalPath(config.root);
    for (const state of [config.readyState, "ready", "doing", "done"]) {
      const statePath = await physicalPath(join(configuredRoot, state));
      if (
        isWithinState(outputDirectory, statePath) ||
        isWithinState(physical, statePath)
      )
        throw new IdiomError(
          `ticket destination is inside ${state} state: ${supplied}`,
        );
    }
    if (
      isWithinState(
        outputDirectory,
        await physicalPath(join(root, config.readyState)),
      )
    )
      throw new IdiomError(
        `ticket destination is inside ready state: ${supplied}`,
      );
  }
  const canonicalRoot = await physicalPath(source.root);
  return {
    root,
    outputDirectory,
    canonicalRoot,
    canonical: source.source === "file" && root === canonicalRoot,
  };
}

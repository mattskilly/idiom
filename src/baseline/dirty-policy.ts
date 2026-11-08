import { execFile } from "node:child_process";
import { lstat, readFile, realpath } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { globRegex, validGlob } from "../../plugins/claude/hooks/lib.mjs";
import { buildImportGraph } from "../changed/imports.js";
import { discoverRouteTopology } from "../coverage/routes.js";
import { IdiomError } from "../errors.js";
import { isElectronFlow } from "../schemas/flow.js";
import type { ValidationResult } from "../validation.js";

const exec = promisify(execFile);
const compiled = new WeakMap<readonly string[], RegExp[]>();
export function dirtyMatchers(patterns: readonly string[]): RegExp[] {
  let result = compiled.get(patterns);
  if (!result) {
    result = patterns.map(globRegex);
    compiled.set(patterns, result);
  }
  return result;
}
const slash = (path: string) => path.split(sep).join("/");
const within = (path: string) => path !== ".." && !path.startsWith("../");

/** Whether a supported glob can match any descendant, including future files. */
function overlapsDirectory(pattern: string, directory: string): boolean {
  const parts = pattern.replaceAll("\\", "/").replace(/^\.\//, "").split("/");
  const prefix = directory.split("/");
  const visit = (p: number, d: number): boolean => {
    if (d === prefix.length) return p < parts.length;
    if (p === parts.length) return false;
    if (parts[p] === "**") return visit(p + 1, d) || visit(p, d + 1);
    return (
      globRegex(parts[p] as string).test(prefix[d] as string) &&
      visit(p + 1, d + 1)
    );
  };
  return visit(0, 0);
}

/** Split shell control operators without splitting quoted inline programs. */
function commandSegments(command: string): string[] {
  const result: string[] = [];
  let start = 0;
  let quote: string | undefined;
  let escaped = false;
  for (let index = 0; index < command.length; index++) {
    const char = command[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = undefined;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (
      char === ";" ||
      char === "\n" ||
      command.slice(index, index + 2) === "&&" ||
      command.slice(index, index + 2) === "||"
    ) {
      result.push(command.slice(start, index));
      if (char === "&" || char === "|") index++;
      start = index + 1;
    }
  }
  result.push(command.slice(start));
  return result;
}

/** Static, conservative input inventory. Never executes project commands. */
export async function validateDirtyPolicy(
  context: ValidationResult,
): Promise<void> {
  const patterns = context.project.baselines?.ignoreDirty;
  if (!patterns?.length) return;
  const matchers = dirtyMatchers(patterns);
  const project = await realpath(context.projectDirectory);
  let root: string;
  let inventory: string[];
  try {
    root = await realpath(
      (
        await exec("git", ["rev-parse", "--show-toplevel"], { cwd: project })
      ).stdout.trim(),
    );
    inventory = [
      ...new Set(
        (
          await exec(
            "git",
            ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
            { cwd: root, maxBuffer: 32 * 1024 * 1024 },
          )
        ).stdout
          .split("\0")
          .filter(Boolean),
      ),
    ];
  } catch (error) {
    throw new IdiomError(
      `baselines.ignoreDirty requires a readable Git repository: ${String(error)}`,
    );
  }
  const refuse = (index: number, example: string, why: string): never => {
    throw new IdiomError(
      `baselines.ignoreDirty[${index}] ${JSON.stringify(patterns[index])} excludes protected input ${example} (${why}); narrow or remove this pattern`,
    );
  };
  if (
    inventory.length &&
    inventory.every((file) => matchers.some((re) => re.test(file)))
  )
    refuse(
      0,
      inventory[0] as string,
      "the union excludes the entire repository file inventory",
    );
  type Input = { path: string; directory: boolean; why: string };
  const inputs = new Map<string, Input>();
  const add = async (path: string, why: string, directory = false) => {
    const absolute = resolve(path);
    const local = slash(relative(root, absolute));
    if (!within(local)) return;
    const stat = await lstat(absolute).catch(() => undefined);
    inputs.set(local, {
      path: local,
      directory: directory || stat?.isDirectory() === true,
      why,
    });
    if (stat?.isSymbolicLink()) {
      const target = await realpath(absolute).catch(() => undefined);
      if (target && target !== absolute) {
        const name = slash(relative(root, target));
        if (within(name))
          inputs.set(name, {
            path: name,
            directory: (await lstat(target)).isDirectory(),
            why: `${why}; symlink target of ${local}`,
          });
      }
    }
  };
  await add(resolve(project, ".idiom/project.json"), "project configuration");
  await add(resolve(project, ".idiom/glossary.json"), "copy policy");
  for (const record of context.flows)
    await add(
      resolve(project, relative(context.projectDirectory, record.file)),
      "flow configuration",
    );
  for (const file of Object.values(context.project.design))
    if (typeof file === "string")
      await add(resolve(project, file), "configured design input");
  // Reference schemas contain local paths at several depths; remote URLs are not inputs.
  const referencePaths = async (
    value: unknown,
    declared = false,
  ): Promise<void> => {
    if (
      typeof value === "string" &&
      !/^[a-z]+:\/\//i.test(value) &&
      (declared || /[/.]/.test(value))
    ) {
      const path = resolve(project, value);
      if (declared || (await lstat(path).catch(() => undefined)))
        await add(
          path,
          "configured local reference",
          inventory.some((file) =>
            file.startsWith(`${slash(relative(root, path))}/`),
          ),
        );
    } else if (Array.isArray(value))
      for (const item of value) await referencePaths(item, declared);
    else if (value && typeof value === "object")
      for (const [key, item] of Object.entries(value))
        await referencePaths(
          item,
          ["design", "source", "path"].includes(key) || key.endsWith("File"),
        );
  };
  await referencePaths(context.project.brief);
  await referencePaths(context.project.design);
  for (const record of context.flows) await referencePaths(record.flow);
  const topology = await discoverRouteTopology(project);
  const entries = topology.entries.map((entry) =>
    resolve(project, entry.source),
  );
  const graph = await buildImportGraph(entries, topology.globals);
  const indexed = new Set(inventory);
  const sourceFiles = new Set([
    ...entries,
    ...topology.globals,
    ...graph.consumers.keys(),
    ...graph.globalDependencies,
  ]);
  const routeInputs = new Set(sourceFiles);
  const inspectLiterals = async (
    text: string,
    bases: string[],
    why: string,
  ) => {
    for (const match of text.matchAll(/["']([^"'\n]+)["']/g)) {
      const literal = match[1] ?? "";
      if (/[$`]|:\/\//.test(literal)) continue;
      for (const base of bases) {
        const target = resolve(base, literal);
        if (
          indexed.has(slash(relative(root, target))) ||
          (await lstat(target).catch(() => undefined))
        ) {
          await add(target, why);
          if (/\.[cm]?[jt]sx?$/.test(target)) sourceFiles.add(target);
        }
      }
    }
  };
  const appRoots = new Set([
    project,
    ...topology.roots.map((entry) =>
      entry.kind === "svelte"
        ? dirname(dirname(entry.path))
        : dirname(entry.path),
    ),
  ]);
  const manifests: Array<{
    directory: string;
    value: Record<string, unknown>;
  }> = [];
  // Manifests, lockfiles and build/compiler configuration anywhere in the repo
  // are observable inputs, including deleted index entries.
  for (const file of inventory) {
    if (
      /(?:^|\/)(?:package\.json|(?:bun|pnpm|yarn|package|npm-shrinkwrap)[^/]*lock[^/]*|yarn\.lock|pnpm-workspace\.yaml|(?:tsconfig|jsconfig)(?:\.[^/]*)?\.json|[^/]*\.config\.[^/]+|\.[^/]*rc(?:\.[^/]+)?)$/.test(
        file,
      )
    )
      await add(
        resolve(root, file),
        "manifest, lockfile or build configuration",
      );
    if (/(?:^|\/)package\.json$/.test(file)) {
      const packageRoot = dirname(resolve(root, file));
      appRoots.add(packageRoot);
      const manifest = await readFile(resolve(root, file), "utf8")
        .then(JSON.parse)
        .catch(() => undefined);
      if (manifest) manifests.push({ directory: packageRoot, value: manifest });
      for (const dependency of Object.values({
        ...manifest?.dependencies,
        ...manifest?.devDependencies,
        ...manifest?.optionalDependencies,
      })) {
        if (
          typeof dependency === "string" &&
          /^(?:file|link):/.test(dependency)
        )
          await add(
            resolve(packageRoot, dependency.replace(/^(?:file|link):/, "")),
            `local package dependency of ${file}`,
            true,
          );
      }
    }
  }
  for (const { directory, value } of manifests) {
    const dependencies = {
      ...(value.dependencies as object),
      ...(value.devDependencies as object),
      ...(value.optionalDependencies as object),
    };
    for (const name of Object.keys(dependencies))
      for (const candidate of manifests)
        if (candidate.value.name === name && candidate.directory !== directory)
          await add(
            candidate.directory,
            `local workspace dependency ${name} of ${slash(relative(root, directory)) || "."}`,
            true,
          );
  }
  for (const directory of appRoots)
    for (const name of ["src", "app", "pages", "public", "static"])
      await add(
        resolve(directory, name),
        "conventional application source/asset tree",
        true,
      );
  const seen = new Set<string>();
  const inspectCommand = async (
    command: string,
    cwd: string,
    why: string,
  ): Promise<void> => {
    const key = `${cwd}\0${command}`;
    if (seen.has(key)) return;
    seen.add(key);
    for (const segment of commandSegments(command)) {
      const tokens = [...segment.matchAll(/"([^"]*)"|'([^']*)'|([^\s]+)/g)].map(
        (m) => m[1] ?? m[2] ?? m[3] ?? "",
      );
      if (tokens[0] === "env") tokens.shift();
      while (/^[A-Za-z_][A-Za-z_0-9]*=/.test(tokens[0] ?? "")) tokens.shift();
      let commandRoot = cwd;
      const rootFlag = tokens.findIndex((t) =>
        ["--cwd", "--prefix", "--dir", "-C"].includes(t),
      );
      if (rootFlag >= 0 && tokens[rootFlag + 1])
        commandRoot = resolve(cwd, tokens[rootFlag + 1] as string);
      const equalRoot = tokens.find((t) => /^(?:--cwd|--prefix)=/.test(t));
      if (equalRoot)
        commandRoot = resolve(cwd, equalRoot.slice(equalRoot.indexOf("=") + 1));
      if (tokens[0] === "cd" && tokens[1]) {
        cwd = resolve(cwd, tokens[1]);
        continue;
      }
      if (/^(?:npm|bun|pnpm|yarn)$/.test(tokens[0] ?? "")) {
        const rest = tokens
          .slice(1)
          .filter(
            (t, i) =>
              i + 1 !== rootFlag &&
              i !== rootFlag &&
              !/^(?:--cwd|--prefix)=/.test(t),
          );
        const script =
          rest[0] === "run" || rest[0] === "run-script" ? rest[1] : rest[0];
        const pkg = await readFile(resolve(commandRoot, "package.json"), "utf8")
          .then(JSON.parse)
          .catch(() => undefined);
        if (script && typeof pkg?.scripts?.[script] === "string") {
          await add(resolve(commandRoot, "package.json"), why);
          await inspectCommand(
            pkg.scripts[script],
            commandRoot,
            `${why}; package script ${script}`,
          );
        }
      }
      const evalFlag = tokens.findIndex((token) =>
        ["-e", "--eval", "-p", "--print"].includes(token),
      );
      if (evalFlag >= 0 && /^(?:node|bun)$/.test(tokens[0] ?? ""))
        await inspectLiterals(
          tokens[evalFlag + 1] ?? "",
          [commandRoot],
          `${why}; inline script input`,
        );
      for (let i = 1; i < tokens.length; i++) {
        const token = (tokens[i] ?? "").replace(/^--[^=]+=/, "");
        if (!token || token.startsWith("-") || /[$`]|:\/\//.test(token))
          continue;
        const absolute = resolve(commandRoot, token);
        const stat = await lstat(absolute).catch(() => undefined);
        if (stat || token.includes("/") || /\.[a-z0-9]+$/i.test(token)) {
          if (/[*?]/.test(token)) {
            const prefix = token.split(/[*?]/)[0] ?? "";
            const directory = prefix.endsWith("/") ? prefix : dirname(prefix);
            if (directory && directory !== ".")
              await add(
                resolve(commandRoot, directory),
                `${why}; literal input glob ${token}`,
                true,
              );
            const pattern = slash(relative(root, resolve(commandRoot, token)));
            if (validGlob(pattern))
              for (const file of inventory)
                if (globRegex(pattern).test(file))
                  await add(
                    resolve(root, file),
                    `${why}; literal input glob ${token}`,
                  );
          } else {
            await add(absolute, `${why}; literal command input`);
            if (stat?.isFile() && /\.[cm]?[jt]sx?$/.test(absolute))
              sourceFiles.add(absolute);
            if (stat?.isFile() && /\.(?:sh|bash|zsh)$/.test(absolute))
              await inspectCommand(
                (await readFile(absolute, "utf8")).replace(/^\s*#.*$/gm, ""),
                commandRoot,
                `${why}; local shell script ${token}`,
              );
          }
        }
      }
    }
  };
  await inspectCommand(context.project.server.build, project, "server.build");
  if (context.project.server.production)
    await inspectCommand(
      context.project.server.production.build,
      project,
      "server.production.build",
    );
  for (const { flow } of context.flows) {
    for (const setup of flow.setup)
      await inspectCommand(
        setup.run,
        resolve(project, setup.cwd ?? "."),
        `flow ${flow.id} setup`,
      );
    if (isElectronFlow(flow)) {
      const launch = flow.target.launch;
      const cwd = resolve(project, launch.cwd ?? ".");
      for (const path of [launch.executablePath, ...launch.args]) {
        const file = resolve(cwd, path);
        await add(file, `flow ${flow.id} Electron entrypoint`);
        sourceFiles.add(file);
      }
    }
  }
  const scriptGraph = await buildImportGraph(
    [...sourceFiles].filter((file) => !routeInputs.has(file)),
    [],
  );
  for (const file of scriptGraph.consumers.keys()) sourceFiles.add(file);
  // Follow literal local imports/assets beyond TypeScript's supported extensions,
  // and literal filesystem inputs in local build scripts (including Markdown).
  for (const file of sourceFiles) {
    await add(file, "route/layout or transitive local build/source dependency");
    const text = await readFile(file, "utf8").catch(() => "");
    await inspectLiterals(
      text,
      [dirname(file), project],
      `literal local input of ${slash(relative(root, file))}`,
    );
  }

  for (let index = 0; index < matchers.length; index++) {
    const matcher = matchers[index] as RegExp;
    for (const input of inputs.values()) {
      if (
        matcher.test(input.path) ||
        (input.directory &&
          overlapsDirectory(patterns[index] as string, input.path))
      )
        refuse(index, input.path, input.why);
    }
  }
}

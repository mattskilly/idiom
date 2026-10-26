import { readdir, readFile } from "node:fs/promises";
import { basename, join, relative } from "node:path";
import type { ZodIssue, ZodType } from "zod";
import { selectColorSchemes } from "./capture/resolve.js";
import { mergeCopyPolicy } from "./copy-policy.js";
import { IdiomError } from "./errors.js";
import { findProjectDirectory, resolveProjectArgument } from "./project.js";
import { readRules } from "./rules/index.js";
import { isWebFlow } from "./schemas/flow.js";
import {
  type Flow,
  flowSchema,
  type Project,
  projectSchema,
  type Rules,
} from "./schemas/index.js";
import {
  copyPolicySchema,
  productionConfigExample,
} from "./schemas/project.js";

export type ProjectContext = {
  projectDirectory: string;
  project: Project;
  rules: Rules;
};

export type FlowRecord = { file: string; flow: Flow };

export type ValidationResult = ProjectContext & {
  flows: FlowRecord[];
};

export type ProjectConfiguration = {
  projectDirectory: string;
  project: Project;
};

function fieldPath(path: PropertyKey[]): string {
  let rendered = "";
  for (const segment of path) {
    if (typeof segment === "number") rendered += `[${segment}]`;
    else rendered += rendered === "" ? String(segment) : `.${String(segment)}`;
  }
  return rendered || "<root>";
}

function actionableIssues(issues: ZodIssue[]): Array<{
  path: PropertyKey[];
  message: string;
}> {
  return issues.flatMap((issue) => {
    if (issue.code === "invalid_union") {
      const branches = issue.errors.map((branch) => actionableIssues(branch));
      const actionableBranches = branches.filter((branch) => branch.length > 0);
      return (
        actionableBranches.sort(
          (left, right) => left.length - right.length,
        )[0] ?? [{ path: issue.path, message: issue.message }]
      );
    }
    if (issue.code === "unrecognized_keys") {
      return issue.keys.map((key) => ({
        path: [...issue.path, key],
        message: "unrecognized field",
      }));
    }
    return [{ path: issue.path, message: issue.message }];
  });
}

async function parseJsonFile<T>(
  file: string,
  projectDirectory: string,
  schema: ZodType<T>,
): Promise<T>;
async function parseJsonFile<T>(
  file: string,
  projectDirectory: string,
  schema: ZodType<T>,
  optional: true,
): Promise<T | undefined>;
async function parseJsonFile<T>(
  file: string,
  projectDirectory: string,
  schema: ZodType<T>,
  optional = false,
): Promise<T | undefined> {
  const displayFile = relative(projectDirectory, file) || basename(file);
  let source: string;
  try {
    source = await readFile(file, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" && optional) return undefined;
    if (code === "ENOENT")
      throw new IdiomError(`${displayFile}: file not found`);
    throw new IdiomError(`${displayFile}: could not be read: ${String(error)}`);
  }

  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch (error) {
    throw new IdiomError(
      `${displayFile}: malformed JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const result = schema.safeParse(value);
  if (!result.success) {
    const issues = actionableIssues(result.error.issues)
      .map(
        (issue) => `${displayFile}: ${fieldPath(issue.path)}: ${issue.message}`,
      )
      .join("\n");
    throw new IdiomError(issues);
  }
  return result.data;
}

async function flowFiles(
  projectDirectory: string,
  flow: string | undefined,
): Promise<string[]> {
  const directory = join(projectDirectory, ".idiom", "flows");
  if (flow !== undefined) return [join(directory, `${flow}.json`)];

  let entries: string[];
  try {
    entries = await readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new IdiomError(
        `${relative(projectDirectory, directory)}: directory not found`,
      );
    }
    throw error;
  }
  const files = entries.filter((entry) => entry.endsWith(".json")).sort();
  if (files.length === 0) {
    throw new IdiomError(
      `${relative(projectDirectory, directory)}: no flow manifests found`,
    );
  }
  return files.map((entry) => join(directory, entry));
}

/**
 * The project-root, project-schema, and rules boundary shared by every command.
 * It reads no flow manifest, so a command that needs only project-wide context
 * never fails on an unrelated malformed or absent manifest.
 */
export async function loadProjectContext(options: {
  project?: string | undefined;
  cwd?: string | undefined;
}): Promise<ProjectContext> {
  const { projectDirectory, project } =
    await validateProjectConfiguration(options);
  const rules = await readRules(projectDirectory);
  return { projectDirectory, project, rules };
}

async function loadFlows(
  context: ProjectContext,
  flow: string | undefined,
): Promise<FlowRecord[]> {
  const files = await flowFiles(context.projectDirectory, flow);
  const flows: FlowRecord[] = [];
  const availableViewports = new Set(
    context.project.viewports.map((viewport) => viewport.name),
  );
  const availableSurfaces = new Set(
    context.project.surfaces.map((surface) => surface.id),
  );

  for (const file of files) {
    const parsed = await parseJsonFile(
      file,
      context.projectDirectory,
      flowSchema,
    );
    if (
      isWebFlow(parsed) &&
      parsed.server === "production" &&
      context.project.server.production === undefined
    ) {
      throw new IdiomError(
        `${relative(context.projectDirectory, file)}: server: production requires server.production; ${productionConfigExample}`,
      );
    }
    // Published flows may name viewports by width; those sizes travel on
    // the flow rather than in the project.
    const knownViewports = new Set([
      ...availableViewports,
      ...Object.keys((isWebFlow(parsed) && parsed.viewportSizes) || {}),
    ]);
    for (const [index, viewport] of (parsed.viewports ?? []).entries()) {
      if (!knownViewports.has(viewport)) {
        throw new IdiomError(
          `${relative(context.projectDirectory, file)}: viewports[${index}]: unknown project viewport ${JSON.stringify(viewport)}`,
        );
      }
    }
    const flowViewports = new Set(parsed.viewports ?? availableViewports);
    for (const [stateIndex, state] of parsed.states.entries()) {
      const design = state.design;
      for (const [index, entry] of (Array.isArray(design)
        ? design
        : design === undefined
          ? []
          : [design]
      ).entries())
        if (
          typeof entry !== "string" &&
          entry.viewport !== undefined &&
          !knownViewports.has(entry.viewport)
        )
          throw new IdiomError(
            `${relative(context.projectDirectory, file)}: states[${stateIndex}].design${Array.isArray(design) ? `[${index}]` : ""}.viewport: unknown project viewport ${JSON.stringify(entry.viewport)}`,
          );
      for (const [index, viewport] of (state.viewports ?? []).entries()) {
        if (!flowViewports.has(viewport)) {
          throw new IdiomError(
            `${relative(context.projectDirectory, file)}: states[${stateIndex}].viewports[${index}]: viewport ${JSON.stringify(viewport)} is not captured by this flow`,
          );
        }
      }
    }
    if (
      parsed.surface !== undefined &&
      !availableSurfaces.has(parsed.surface)
    ) {
      throw new IdiomError(
        `${relative(context.projectDirectory, file)}: surface: unknown project surface ${JSON.stringify(parsed.surface)}`,
      );
    }
    if (context.project.surfaces.length > 0 && parsed.surface === undefined) {
      throw new IdiomError(
        `${relative(context.projectDirectory, file)}: surface: required when project surfaces are declared`,
      );
    }
    try {
      selectColorSchemes(context.project, parsed);
    } catch (error) {
      throw new IdiomError(
        `${relative(context.projectDirectory, file)}: colorSchemes: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    flows.push({ file, flow: parsed });
  }
  return flows;
}

/**
 * Loads every flow only for projects that opted into declared surfaces. This
 * keeps legacy named-flow commands isolated from unrelated manifests while
 * giving surface-aware reviews a complete, validated association set.
 */
export async function loadDeclaredSurfaceFlows(
  context: ProjectContext,
): Promise<FlowRecord[]> {
  if (context.project.surfaces.length === 0) return [];
  const records = await loadFlows(context, undefined);
  const ids = new Map<string, string>();
  for (const record of records) {
    const display = relative(context.projectDirectory, record.file);
    const prior = ids.get(record.flow.id);
    if (prior !== undefined) {
      throw new IdiomError(
        `${display}: id: duplicates flow id ${JSON.stringify(record.flow.id)} from ${prior}`,
      );
    }
    ids.set(record.flow.id, display);
  }
  return records;
}

/**
 * Validates exactly `.idiom/flows/<flow>.json` and enforces the same
 * filename-versus-manifest-id agreement review requires, so a typo or a renamed
 * manifest fails instead of silently narrowing scope. Unrelated manifests stay
 * unread.
 */
export async function validateNamedFlow(
  context: ProjectContext,
  flow: string,
): Promise<FlowRecord> {
  const record = (await loadFlows(context, flow))[0];
  if (record === undefined || record.flow.id !== flow) {
    throw new IdiomError(
      `requested flow ${JSON.stringify(flow)} does not match the manifest id ${JSON.stringify(record?.flow.id)}`,
    );
  }
  return record;
}

export async function validateProject(options: {
  project?: string | undefined;
  flow?: string | undefined;
  cwd?: string | undefined;
}): Promise<ValidationResult> {
  const context = await loadProjectContext(options);
  const flows = await loadFlows(context, options.flow);
  if (context.project.surfaces.length > 0)
    await loadDeclaredSurfaceFlows(context);
  return { ...context, flows };
}

export async function validateProjectConfiguration(options: {
  project?: string | undefined;
  cwd?: string | undefined;
}): Promise<ProjectConfiguration> {
  const start = resolveProjectArgument(options.project, options.cwd);
  const projectDirectory = await findProjectDirectory(start);
  const project = await parseJsonFile(
    join(projectDirectory, ".idiom", "project.json"),
    projectDirectory,
    projectSchema,
  );
  const policy = await parseJsonFile(
    join(projectDirectory, ".idiom", "glossary.json"),
    projectDirectory,
    copyPolicySchema,
    true,
  );
  project.checks.copy = mergeCopyPolicy(policy, project.checks.copy);
  return { projectDirectory, project };
}

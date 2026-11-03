import { randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";

/** The two lines offered for the project's agent file. */
export const BRIEF_INSTRUCTION_LINES = [
  "## Design decisions (Idiom)",
  'Before writing a ticket or code that involves a design decision, run `idiom brief triage "<request>"` (or the `idiom_brief_triage` MCP tool) and follow it.',
] as const;
export const BRIEF_INSTRUCTION = `${BRIEF_INSTRUCTION_LINES.join("\n")}\n`;

const MARKER = "idiom brief triage";
const AGENT_FILES = ["CLAUDE.md", "AGENTS.md"] as const;

export type BriefInstructionOutcome =
  | { kind: "present"; path: string }
  | { kind: "added"; path: string }
  | { kind: "declined"; path: string }
  | { kind: "available"; path: string; lines: string[] }
  | { kind: "no-agent-file"; lines: string[] }
  | { kind: "unsafe"; path: string; reason: string }
  | { kind: "changed"; path: string };

export type BriefInstructionConfirmation = (request: {
  kind: "offer-brief-instruction";
  prompt: string;
  path: string;
}) => Promise<boolean>;

type Target =
  | { path: string; realPath: string; content: string }
  | { path: string; unsafe: string };

export type BriefInstructionPlan =
  | { kind: "present"; path: string }
  | { kind: "no-agent-file" }
  | { kind: "targets"; targets: Target[] };

function inside(root: string, target: string): boolean {
  const path = relative(root, target);
  return path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

async function inspect(
  projectDirectory: string,
  root: string,
  name: string,
): Promise<Target | undefined> {
  const path = join(projectDirectory, name);
  try {
    await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  let realPath: string;
  try {
    realPath = await realpath(path);
  } catch {
    return { path: name, unsafe: `${name} is a broken link` };
  }
  if (!inside(root, realPath))
    return { path: name, unsafe: `${name} resolves outside the project` };
  if (!(await stat(realPath)).isFile())
    return { path: name, unsafe: `${name} is not a regular file` };
  return { path: name, realPath, content: await readFile(realPath, "utf8") };
}

/** Which agent files could take the instruction; never creates one. */
export async function planBriefInstruction(
  projectDirectory: string,
): Promise<BriefInstructionPlan> {
  const root = await realpath(projectDirectory);
  const found: Target[] = [];
  for (const name of AGENT_FILES) {
    const target = await inspect(projectDirectory, root, name);
    if (target === undefined) continue;
    // CLAUDE.md -> AGENTS.md links count once.
    if (
      "realPath" in target &&
      found.some(
        (prior) => "realPath" in prior && prior.realPath === target.realPath,
      )
    )
      continue;
    found.push(target);
  }
  if (found.length === 0) return { kind: "no-agent-file" };
  for (const target of found)
    if ("content" in target && target.content.includes(MARKER))
      return { kind: "present", path: target.path };
  const agents = found.find(
    (target) => target.path === "AGENTS.md" && "content" in target,
  );
  // A CLAUDE.md that imports AGENTS.md reads the instruction from there.
  const targets = found.filter(
    (target) =>
      !(
        agents !== undefined &&
        target.path === "CLAUDE.md" &&
        "content" in target &&
        /^\s*@AGENTS\.md\s*$/m.test(target.content)
      ),
  );
  return { kind: "targets", targets };
}

/** Appends the block; refuses when the file changed since it was previewed. */
export async function applyBriefInstruction(target: {
  path: string;
  realPath: string;
  content: string;
}): Promise<"added" | "changed"> {
  const current = await readFile(target.realPath, "utf8").catch(
    () => undefined,
  );
  if (current !== target.content) return "changed";
  const separator =
    current === "" ? "" : current.endsWith("\n") ? "\n" : "\n\n";
  const next = `${current}${separator}${BRIEF_INSTRUCTION}`;
  const staging = join(
    dirname(target.realPath),
    `.${basename(target.realPath)}.${randomUUID()}.tmp`,
  );
  const { mode } = await stat(target.realPath);
  try {
    await writeFile(staging, next, "utf8");
    await chmod(staging, mode);
    await rename(staging, target.realPath);
  } catch (error) {
    await rm(staging, { force: true });
    throw error;
  }
  return "added";
}

/**
 * Offers the instruction once per agent file. Without an interactive
 * confirmation it only reports that the instruction is available.
 */
export async function offerBriefInstruction(options: {
  projectDirectory: string;
  interactive: boolean;
  confirm: BriefInstructionConfirmation;
}): Promise<BriefInstructionOutcome[]> {
  const plan = await planBriefInstruction(options.projectDirectory);
  const lines = [...BRIEF_INSTRUCTION_LINES];
  if (plan.kind === "present") return [{ kind: "present", path: plan.path }];
  if (plan.kind === "no-agent-file") return [{ kind: "no-agent-file", lines }];
  const outcomes: BriefInstructionOutcome[] = [];
  for (const target of plan.targets) {
    if ("unsafe" in target) {
      outcomes.push({
        kind: "unsafe",
        path: target.path,
        reason: target.unsafe,
      });
      continue;
    }
    if (!options.interactive) {
      outcomes.push({ kind: "available", path: target.path, lines });
      continue;
    }
    const accepted = await options.confirm({
      kind: "offer-brief-instruction",
      path: target.path,
      prompt: `Add a two-line instruction to ${target.path} telling agents to run idiom brief triage before writing a ticket or code that involves a design decision? [y/N] `,
    });
    if (!accepted) {
      outcomes.push({ kind: "declined", path: target.path });
      continue;
    }
    outcomes.push({
      kind: await applyBriefInstruction(target),
      path: target.path,
    });
  }
  return outcomes;
}

export function briefInstructionLines(
  outcomes: BriefInstructionOutcome[],
): string[] {
  const lines: string[] = [];
  let offered = false;
  const offer = (where: string) => {
    if (offered) return;
    offered = true;
    lines.push(
      `Optional: add these two lines to ${where} so agents triage design decisions first:`,
      ...BRIEF_INSTRUCTION_LINES,
    );
  };
  for (const outcome of outcomes) {
    switch (outcome.kind) {
      case "present":
        break;
      case "added":
        lines.push(`Added the idiom brief instruction to ${outcome.path}.`);
        break;
      case "declined":
        lines.push(`Brief instruction declined; ${outcome.path} is unchanged.`);
        break;
      case "available":
        offer(
          outcomes
            .filter((entry) => entry.kind === "available")
            .map((entry) => entry.path)
            .join(" or "),
        );
        break;
      case "no-agent-file":
        offer("CLAUDE.md or AGENTS.md");
        break;
      case "unsafe":
        lines.push(
          `Brief instruction not offered for ${outcome.path}: ${outcome.reason}.`,
        );
        break;
      case "changed":
        lines.push(
          `${outcome.path} changed after it was previewed; rerun to add the brief instruction.`,
        );
        break;
    }
  }
  return lines;
}

import { readFile } from "node:fs/promises";
import { selectColorSchemes } from "../capture/resolve.js";
import type { CaptureTupleSelection } from "../capture/types.js";
import { IdiomError } from "../errors.js";
import { type Finding, findingSchema } from "../schemas/finding.js";
import type { Flow } from "../schemas/flow.js";
import type { Project } from "../schemas/project.js";

function issues(error: {
  issues: Array<{ path: PropertyKey[]; message: string }>;
}): string {
  return error.issues
    .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
    .join("; ");
}

export function parseFindingBlocks(source: string): Finding[] {
  const lines = source.split(/\r?\n/);
  const findings: Finding[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const opening = /^(\s*)(`{3,})idiom:finding\s*$/.exec(lines[index] ?? "");
    if (opening === null) continue;
    const size = opening[2]?.length ?? 3;
    const body: string[] = [];
    let closed = false;
    for (index += 1; index < lines.length; index += 1) {
      const line = lines[index] ?? "";
      const closing = /^\s*(`{3,})\s*$/.exec(line);
      if (closing !== null && (closing[1]?.length ?? 0) >= size) {
        closed = true;
        break;
      }
      body.push(line);
    }
    if (!closed)
      throw new IdiomError(
        `unterminated idiom:finding block beginning on line ${index - body.length}`,
      );
    let value: unknown;
    try {
      value = JSON.parse(body.join("\n"));
    } catch (error) {
      throw new IdiomError(
        `malformed idiom:finding JSON: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const parsed = findingSchema.safeParse(value);
    if (!parsed.success)
      throw new IdiomError(`invalid idiom:finding: ${issues(parsed.error)}`);
    findings.push(parsed.data);
  }
  const deduplicated: Finding[] = [];
  for (const finding of findings) {
    const ids = new Set([finding.id, ...(finding.idAliases ?? [])]);
    const matches = deduplicated.filter((candidate) =>
      [candidate.id, ...(candidate.idAliases ?? [])].some((id) => ids.has(id)),
    );
    if (matches.length > 1)
      throw new IdiomError(
        `ambiguous embedded finding identity ${JSON.stringify(finding.id)} joins multiple blocks`,
      );
    const existing = matches[0];
    if (existing === undefined) {
      deduplicated.push(finding);
      continue;
    }
    const {
      id: _existingId,
      idAliases: _existingAliases,
      ...existingBody
    } = existing;
    const {
      id: _findingId,
      idAliases: _findingAliases,
      ...findingBody
    } = finding;
    if (JSON.stringify(existingBody) !== JSON.stringify(findingBody))
      throw new IdiomError(
        `incompatible embedded finding identity ${JSON.stringify(finding.id)} appears more than once`,
      );
    const canonical = /^finding-[1-9]\d*$/.test(existing.id)
      ? existing.id
      : /^finding-[1-9]\d*$/.test(finding.id)
        ? finding.id
        : existing.id;
    const aliases = [
      existing.id,
      ...(existing.idAliases ?? []),
      finding.id,
      ...(finding.idAliases ?? []),
    ].filter((id) => id !== canonical && !/^finding-[1-9]\d*$/.test(id));
    Object.assign(
      existing,
      findingSchema.parse({
        ...existing,
        id: canonical,
        ...(aliases.length === 0 ? {} : { idAliases: [...new Set(aliases)] }),
      }),
    );
  }
  return deduplicated;
}

export async function readVerificationSpec(path: string): Promise<Finding[]> {
  try {
    return parseFindingBlocks(await readFile(path, "utf8"));
  } catch (error) {
    if (error instanceof IdiomError) throw error;
    throw new IdiomError(
      `cannot read verification spec ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function selectFindingTuples(options: {
  findings: Finding[];
  flow: Flow;
  project: Project;
}): CaptureTupleSelection[] {
  const stateIds = new Set(options.flow.states.map(({ id }) => id));
  const selectedViewportNames = new Set(
    options.flow.viewports ?? options.project.viewports.map(({ name }) => name),
  );
  const selectedColorSchemes = selectColorSchemes(
    options.project,
    options.flow,
  );
  const selectedColorSchemeNames = new Set(selectedColorSchemes);
  const wanted = new Set<string>();
  const requiresFullGrid = options.findings.some(
    (finding) =>
      finding.rule === "idiom:missing-color-scheme" ||
      finding.verification.params?.fullFlow === true,
  );
  for (const finding of options.findings) {
    if (finding.acceptance.kind === "rule") {
      for (const coordinate of finding.acceptance.requiredCoordinates) {
        if (
          coordinate.flow !== options.flow.id ||
          !stateIds.has(coordinate.state) ||
          !selectedViewportNames.has(coordinate.viewport) ||
          !selectedColorSchemeNames.has(
            coordinate.colorScheme ?? options.project.capture.colorScheme,
          )
        )
          throw new IdiomError(
            `acceptance for ${finding.id} requires an unknown or unselected tuple`,
          );
        wanted.add(
          `${coordinate.state}\0${coordinate.viewport}\0${coordinate.colorScheme ?? options.project.capture.colorScheme}`,
        );
      }
    }
    if (finding.flow !== options.flow.id)
      throw new IdiomError(
        `embedded finding ${finding.id} references flow ${JSON.stringify(finding.flow)}, expected ${JSON.stringify(options.flow.id)}`,
      );
    if (!stateIds.has(finding.state))
      throw new IdiomError(
        `embedded finding ${finding.id} references unknown state ${JSON.stringify(finding.state)}`,
      );
    if (!selectedViewportNames.has(finding.viewport))
      throw new IdiomError(
        `embedded finding ${finding.id} references unknown or unselected viewport ${JSON.stringify(finding.viewport)}`,
      );
    const colorScheme =
      finding.colorScheme ?? options.project.capture.colorScheme;
    if (!selectedColorSchemeNames.has(colorScheme))
      throw new IdiomError(
        `embedded finding ${finding.id} references unknown or unselected color scheme ${JSON.stringify(colorScheme)}`,
      );
    wanted.add(`${finding.state}\0${finding.viewport}\0${colorScheme}`);
  }
  return options.flow.states.flatMap((state) =>
    (
      options.flow.viewports ??
      options.project.viewports.map(({ name }) => name)
    ).flatMap((viewport) =>
      selectedColorSchemes.flatMap((colorScheme) =>
        requiresFullGrid ||
        wanted.has(`${state.id}\0${viewport}\0${colorScheme}`)
          ? [
              {
                state: state.id,
                viewport,
                ...(options.project.colorSchemes.length > 1
                  ? { colorScheme }
                  : {}),
              },
            ]
          : [],
      ),
    ),
  );
}

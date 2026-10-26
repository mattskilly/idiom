import { randomUUID } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { IdiomError } from "../errors.js";
import { designSourceSchema } from "../schemas/design.js";
import { flowSchema } from "../schemas/flow.js";
import { validateProject } from "../validation.js";

export async function addDesignCommand(options: {
  state: string;
  source: string;
  /** Upsert this named entry into an array of references. */
  name?: string | undefined;
  viewport?: string | undefined;
  flow?: string | undefined;
  project?: string | undefined;
  cwd?: string | undefined;
}): Promise<{ file: string; changed: boolean; source: string }> {
  const source = designSourceSchema.parse(options.source),
    cwd = resolve(options.cwd ?? process.cwd());
  const validated = await validateProject(options);
  const records = validated.flows
    .filter(({ flow }) => !options.flow || flow.id === options.flow)
    .filter(({ flow }) =>
      flow.states.some((state) => state.id === options.state),
    );
  const candidates: Array<{
    file: string;
    raw: Record<string, unknown>;
    state: Record<string, unknown>;
  }> = [];
  for (const { file } of records) {
    const raw = JSON.parse(await readFile(file, "utf8")) as Record<
      string,
      unknown
    >;
    const states = Array.isArray(raw.states)
      ? (raw.states as Record<string, unknown>[])
      : [];
    for (const state of states)
      if (state.id === options.state) candidates.push({ file, raw, state });
  }
  if (candidates.length !== 1)
    throw new IdiomError(
      candidates.length
        ? `State ${options.state} is ambiguous; use --flow <id>.`
        : `No authored state ${options.state}; declare an explicit state for generated pages/routes/combinations.`,
    );
  const entry = candidates[0];
  if (!entry) throw new IdiomError("State not found");
  let stored = source;
  if (!/^https?:/i.test(source)) {
    const absolute = resolve(cwd, source),
      local = relative(validated.projectDirectory, absolute);
    stored =
      !isAbsolute(local) && local !== ".." && !local.startsWith(`..${sep}`)
        ? local.split(sep).join("/") || "."
        : absolute;
  }
  if (
    options.viewport !== undefined &&
    !validated.project.viewports.some((v) => v.name === options.viewport)
  )
    throw new IdiomError(
      `Unknown project viewport ${JSON.stringify(options.viewport)}.`,
    );
  const declaration =
    options.name === undefined
      ? options.viewport === undefined
        ? stored
        : { source: stored, viewport: options.viewport }
      : upsert(entry.state.design, {
          source: stored,
          name: options.name,
          ...(options.viewport === undefined
            ? {}
            : { viewport: options.viewport }),
        });
  if (JSON.stringify(entry.state.design) === JSON.stringify(declaration))
    return { file: entry.file, changed: false, source: stored };
  entry.state.design = declaration;
  flowSchema.parse(entry.raw);
  const temporary = `${entry.file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(entry.raw, null, 2)}\n`, {
      flag: "wx",
    });
    await rename(temporary, entry.file);
  } finally {
    await rm(temporary, { force: true });
  }
  return { file: entry.file, changed: true, source: stored };
}

/** Replace the same-named entry or append; a bare string becomes `{ source }`. */
function upsert(
  current: unknown,
  entry: { source: string; name: string; viewport?: string },
): unknown[] {
  const entries = (
    Array.isArray(current) ? current : current === undefined ? [] : [current]
  ).map((item) => (typeof item === "string" ? { source: item } : item));
  const index = entries.findIndex(
    (item) =>
      typeof item === "object" &&
      item !== null &&
      (item as { name?: unknown }).name === entry.name,
  );
  if (index >= 0) entries[index] = entry;
  else entries.push(entry);
  return entries;
}

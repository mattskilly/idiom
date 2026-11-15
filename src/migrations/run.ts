import { randomBytes } from "node:crypto";
import {
  lstat,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  type FormatDocument,
  type ProjectFileFormat,
  projectFileFormats,
} from "./formats.js";

export type ProjectFileAction =
  | "migrated"
  | "current"
  | "kept"
  | "refused"
  | "skipped"
  | "failed";

export type ProjectFileOutcome = {
  /** Project-relative, e.g. `.idiom/rules.json`. */
  path: string;
  /** The registry id of the file's format. */
  format: string;
  kind: ProjectFileFormat["kind"];
  outcome: ProjectFileAction;
  /** The version found: the document's, or a log's highest record version. */
  version?: number;
  currentVersion: number;
  from?: number;
  to?: number;
  /** Project-relative path of the original's copy (real runs only). */
  backupPath?: string;
  reason?: string;
};

export type ProjectFilesReport = {
  /** Project-relative backup directory, or null when nothing was written. */
  backupDirectory: string | null;
  files: ProjectFileOutcome[];
};

type Found = { relative: string; format: ProjectFileFormat };

const isVersion = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value > 0;

/** Directory entries, or none when the directory is missing or unreadable. */
async function entries(directory: string) {
  try {
    return await readdir(directory, { withFileTypes: true });
  } catch {
    return [];
  }
}

/** Expand one location pattern into `.idiom/`-relative paths. */
async function expand(idiom: string, pattern: string): Promise<string[]> {
  let prefixes = [""];
  const segments = pattern.split("/");
  for (const [index, segment] of segments.entries()) {
    const last = index === segments.length - 1;
    const next: string[] = [];
    for (const prefix of prefixes) {
      const listing = await entries(join(idiom, prefix));
      for (const entry of listing) {
        if (entry.name.startsWith(".")) continue;
        if (!matches(segment, entry.name)) continue;
        // Intermediate segments descend into real directories only (never a
        // symlink); the final segment names a file, which is checked later.
        if (!last && !entry.isDirectory()) continue;
        if (last && entry.isDirectory()) continue;
        next.push(prefix === "" ? entry.name : `${prefix}/${entry.name}`);
      }
    }
    prefixes = next;
  }
  return prefixes;
}

function matches(segment: string, name: string): boolean {
  if (!segment.includes("*")) return segment === name;
  const [head, tail] = segment.split("*") as [string, string];
  return (
    name.length >= head.length + tail.length &&
    name.startsWith(head) &&
    name.endsWith(tail)
  );
}

async function find(
  idiom: string,
  formats: ProjectFileFormat[],
): Promise<Found[]> {
  const found = new Map<string, Found>();
  for (const format of formats)
    for (const location of format.locations)
      for (const relative of await expand(idiom, location))
        if (!found.has(relative)) found.set(relative, { relative, format });
  return [...found.values()];
}

type Plan =
  | {
      outcome: Exclude<ProjectFileAction, "migrated">;
      base: ProjectFileOutcome;
    }
  | {
      outcome: "migrated";
      base: ProjectFileOutcome;
      original: Buffer;
      migrated: FormatDocument;
    };

function outcome(
  path: string,
  format: ProjectFileFormat,
  values: Partial<ProjectFileOutcome> & { outcome: ProjectFileAction },
): ProjectFileOutcome {
  return {
    path,
    format: format.id,
    kind: format.kind,
    currentVersion: format.current,
    ...values,
  };
}

function newer(version: number, format: ProjectFileFormat): string {
  return `format ${version} is newer than format ${format.current}, the newest this Idiom understands; update Idiom, then run idiom upgrade again`;
}

function classifyDocument(
  path: string,
  format: ProjectFileFormat,
  original: Buffer,
): Plan {
  let value: unknown;
  try {
    value = JSON.parse(original.toString("utf8"));
  } catch {
    return {
      outcome: "skipped",
      base: outcome(path, format, {
        outcome: "skipped",
        reason: "not valid JSON; idiom validate reports it",
      }),
    };
  }
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return {
      outcome: "skipped",
      base: outcome(path, format, {
        outcome: "skipped",
        reason: "not a JSON object; idiom validate reports it",
      }),
    };
  const version = (value as FormatDocument).version;
  if (!isVersion(version))
    return {
      outcome: "skipped",
      base: outcome(path, format, {
        outcome: "skipped",
        reason: "no format version; idiom validate reports it",
      }),
    };
  if (version === format.current)
    return {
      outcome: "current",
      base: outcome(path, format, { outcome: "current", version }),
    };
  if (version > format.current)
    return {
      outcome: "refused",
      base: outcome(path, format, {
        outcome: "refused",
        version,
        reason: newer(version, format),
      }),
    };
  const failed = (reason: string): Plan => ({
    outcome: "failed",
    base: outcome(path, format, {
      outcome: "failed",
      version,
      from: version,
      to: format.current,
      reason,
    }),
  });
  let document = value as FormatDocument;
  for (let step = version; step < format.current; step++) {
    const migrate = format.migrations[step];
    if (migrate === undefined)
      return failed(`no migration from format ${step}; nothing written`);
    try {
      document = migrate(structuredClone(document));
    } catch (error) {
      return failed(
        `migration from format ${step} failed (${error instanceof Error ? error.message : String(error)}); nothing written`,
      );
    }
  }
  if (document.version !== format.current || !format.validate(document))
    return failed(
      `the migrated file does not pass the format ${format.current} schema; nothing written`,
    );
  return {
    outcome: "migrated",
    base: outcome(path, format, {
      outcome: "migrated",
      version,
      from: version,
      to: format.current,
    }),
    original,
    migrated: document,
  };
}

/** Logs are append-only: classified from their records, never rewritten. */
function classifyLog(
  path: string,
  format: ProjectFileFormat,
  original: Buffer,
): Plan {
  const versions: number[] = [];
  for (const line of original.toString("utf8").split("\n")) {
    if (line.trim() === "") continue;
    try {
      const value: unknown = JSON.parse(line);
      const version =
        typeof value === "object" && value !== null
          ? (value as FormatDocument).version
          : undefined;
      if (isVersion(version)) versions.push(version);
    } catch {
      /* The reader reports malformed lines. */
    }
  }
  if (versions.length === 0)
    return {
      outcome: "current",
      base: outcome(path, format, { outcome: "current" }),
    };
  const highest = Math.max(...versions);
  const lowest = Math.min(...versions);
  if (highest > format.current)
    return {
      outcome: "refused",
      base: outcome(path, format, {
        outcome: "refused",
        version: highest,
        reason: `a record uses ${newer(highest, format)}`,
      }),
    };
  if (lowest < format.current)
    return {
      outcome: "kept",
      base: outcome(path, format, {
        outcome: "kept",
        version: highest,
        reason: `records at format ${lowest} stay as written; Idiom reads them`,
      }),
    };
  return {
    outcome: "current",
    base: outcome(path, format, { outcome: "current", version: highest }),
  };
}

async function classify(idiom: string, found: Found): Promise<Plan> {
  const path = `.idiom/${found.relative}`;
  const absolute = join(idiom, found.relative);
  const skipped = (reason: string): Plan => ({
    outcome: "skipped",
    base: outcome(path, found.format, { outcome: "skipped", reason }),
  });
  let original: Buffer;
  try {
    const stat = await lstat(absolute);
    if (!stat.isFile()) return skipped("not a regular file");
    original = await readFile(absolute);
  } catch (error) {
    return skipped(
      `could not be read (${(error as NodeJS.ErrnoException).code ?? "error"})`,
    );
  }
  return found.format.kind === "log"
    ? classifyLog(path, found.format, original)
    : classifyDocument(path, found.format, original);
}

/** `YYYYMMDDTHHMMSSZ` in UTC. */
function stamp(now: Date): string {
  return now
    .toISOString()
    .replace(/\.\d{3}Z$/, "Z")
    .replaceAll(/[-:]/g, "");
}

/** Create a fresh backup directory, suffixing `-2`, `-3`, … on a collision. */
async function backupDirectory(idiom: string, now: Date): Promise<string> {
  const parent = join(idiom, "backups");
  await mkdir(parent, { recursive: true });
  const base = `upgrade-${stamp(now)}`;
  for (let attempt = 1; ; attempt++) {
    const name = attempt === 1 ? base : `${base}-${attempt}`;
    try {
      await mkdir(join(parent, name));
      return `backups/${name}`;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
}

async function write(
  idiom: string,
  relative: string,
  backup: string,
  original: Buffer,
  migrated: FormatDocument,
): Promise<void> {
  const copy = join(idiom, backup, relative);
  await mkdir(dirname(copy), { recursive: true });
  await writeFile(copy, original, { flag: "wx" });
  const target = join(idiom, relative);
  const temporary = `${target}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(migrated, null, 2)}\n`, {
      flag: "wx",
    });
    await rename(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

/**
 * Bring the project's versioned `.idiom/` files to the formats this release
 * writes. Current files are only read; logs are never rewritten; a file on a
 * newer format is refused; every original is copied to one backup directory
 * before its migrated form replaces it.
 */
export async function migrateProjectFiles(
  options: { projectDirectory: string; dryRun: boolean; now?: () => Date },
  dependencies: { formats?: ProjectFileFormat[] | undefined } = {},
): Promise<ProjectFilesReport> {
  const idiom = join(options.projectDirectory, ".idiom");
  const found = await find(idiom, dependencies.formats ?? projectFileFormats);
  found.sort((left, right) => left.relative.localeCompare(right.relative));
  const files: ProjectFileOutcome[] = [];
  let backup: string | null = null;
  for (const item of found) {
    const plan = await classify(idiom, item);
    if (plan.outcome !== "migrated" || options.dryRun) {
      files.push(plan.base);
      continue;
    }
    try {
      backup ??= await backupDirectory(idiom, (options.now ?? nowDate)());
      await write(idiom, item.relative, backup, plan.original, plan.migrated);
      files.push({
        ...plan.base,
        backupPath: `.idiom/${backup}/${item.relative}`,
      });
    } catch (error) {
      files.push({
        ...plan.base,
        outcome: "failed",
        reason: `could not back up or write (${(error as NodeJS.ErrnoException).code ?? (error instanceof Error ? error.message : String(error))}); the original is unchanged`,
      });
    }
  }
  return {
    backupDirectory: backup === null ? null : `.idiom/${backup}`,
    files,
  };
}

const nowDate = () => new Date();

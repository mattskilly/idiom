import { AsyncLocalStorage } from "node:async_hooks";
import { resolve } from "node:path";

/**
 * Shared append-only logs whose records carry a type a newer Idiom may add.
 * A reader skips a record whose type it doesn't know, keeps every other one,
 * and reports the skip once per command.
 */
export type RecordFamily = "decision" | "learned";

const families: readonly RecordFamily[] = ["decision", "learned"];

type Skipped = { family: RecordFamily; type: string };
type Scope = Map<string, Skipped>;

const scopes = new AsyncLocalStorage<Scope>();
/** Outside a command scope (direct library use), note each family once per process. */
const notedWithoutScope = new Set<RecordFamily>();

export function unknownRecordNote(
  family: RecordFamily,
  count: number,
  types: Iterable<string>,
): string {
  const listed = [...new Set(types)].sort().join(", ");
  return `Skipped ${count} ${family} record${count === 1 ? "" : "s"} written by a newer Idiom (types: ${listed}). Upgrade to use them.`;
}

export function noteUnknownRecord(record: {
  family: RecordFamily;
  path: string;
  line: number;
  type: string;
}): void {
  const scope = scopes.getStore();
  if (scope) {
    scope.set(`${resolve(record.path)}:${record.line}`, {
      family: record.family,
      type: record.type,
    });
    return;
  }
  if (notedWithoutScope.has(record.family)) return;
  notedWithoutScope.add(record.family);
  process.stderr.write(
    `${unknownRecordNote(record.family, 1, [record.type])}\n`,
  );
}

/** Runs one command; writes one note per family that skipped records, even if it throws. */
export async function withRecordNotes<T>(
  run: () => Promise<T>,
  write: (line: string) => void,
): Promise<T> {
  const scope: Scope = new Map();
  try {
    return await scopes.run(scope, run);
  } finally {
    for (const family of families) {
      const types = [...scope.values()]
        .filter((skipped) => skipped.family === family)
        .map((skipped) => skipped.type);
      if (types.length > 0)
        write(unknownRecordNote(family, types.length, types));
    }
  }
}

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import { deterministicCheckIds } from "../src/checks/types.js";
import { checksConfigSchema } from "../src/schemas/project.js";

/** docs/rules.md stays in sync with the check registry. */
const labels = [
  "Catches",
  "Why it matters",
  "Severity",
  "Source",
  "Configure or decide",
];

async function sections() {
  const text = await readFile(
    join(import.meta.dirname, "..", "docs", "rules.md"),
    "utf8",
  );
  return [
    ...text.matchAll(/^### `([^`]+)`\n([\s\S]*?)(?=^#{1,3} |(?![\s\S]))/gm),
  ].map((match) => ({ id: match[1] as string, body: match[2] as string }));
}

test("every check has one section, in registry order", async () => {
  expect((await sections()).map(({ id }) => id)).toEqual([
    ...deterministicCheckIds,
  ]);
});

test("every section has the five labelled entries", async () => {
  const missing = (await sections()).flatMap(({ id, body }) => {
    const bullets = [...body.matchAll(/^- \*\*([^*]+):\*\* *(.*)$/gm)].map(
      (match) => ({ label: match[1], text: (match[2] ?? "").trim() }),
    );
    return bullets.map(({ label }) => label).join("|") === labels.join("|") &&
      bullets.every(({ text }) => text !== "")
      ? []
      : [id];
  });
  expect(missing).toEqual([]);
});

test("every checks.<key> the doc names is a real setting", async () => {
  const text = await readFile(
    join(import.meta.dirname, "..", "docs", "rules.md"),
    "utf8",
  );
  const keys = new Set(
    [...text.matchAll(/checks\.([A-Za-z]+)/g)].map((match) => match[1]),
  );
  const known = Object.keys(checksConfigSchema.shape);
  expect([...keys].filter((key) => !known.includes(key as string))).toEqual([]);
});

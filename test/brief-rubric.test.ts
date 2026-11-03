import { readFile } from "node:fs/promises";
import { expect, test } from "vitest";
import { parseBriefRubric, readBriefRubric } from "../src/brief/rubric.js";

test("the shipped rubric is version 1 with the spec's triggers and non-triggers", async () => {
  const rubric = await readBriefRubric();
  expect(rubric.version).toBe(1);
  expect(rubric.triggers).toEqual([
    "new-control-or-surface",
    "new-interaction-or-mode",
    "placement-or-timing",
    "input-modality",
    "density",
    "concept-naming",
    "per-item-addition",
    "raw-technical-input",
  ]);
  expect(rubric.nonTriggers).toEqual([
    "copy-fix",
    "single-answer-bug",
    "tests",
    "refactor",
  ]);
});

test("docs/brief.md documents every rubric id and the version", async () => {
  const rubric = await readBriefRubric();
  const docs = await readFile(
    new URL("../docs/brief.md", import.meta.url),
    "utf8",
  );
  for (const id of [...rubric.triggers, ...rubric.nonTriggers])
    expect(docs, id).toContain(`\`${id}\``);
  expect(docs).toContain(`version ${rubric.version}`);
  expect(docs).toContain("templates/brief/rubric.md");
});

test("a malformed rubric is refused", () => {
  expect(() => parseBriefRubric("# no front matter")).toThrow(/version/);
  expect(() =>
    parseBriefRubric("---\nversion: 1\n---\n\n## Triggers\n\n- `a`: x\n"),
  ).toThrow(/Non-triggers/);
});

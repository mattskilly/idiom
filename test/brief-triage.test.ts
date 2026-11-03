import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { readBriefRubric } from "../src/brief/rubric.js";
import {
  briefTriage,
  MAX_TRIAGE_REQUEST_BYTES,
  resolveTriageRequest,
  triageContext,
} from "../src/brief/triage.js";
import { IdiomError } from "../src/errors.js";
import type { BriefTriageResult } from "../src/schemas/brief.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((d) => rm(d, { recursive: true, force: true })),
  );
});

async function temporary(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "idiom-brief-triage-"));
  directories.push(directory);
  return directory;
}

type Golden = { request: string; response: BriefTriageResult };

function golden(name: string): Golden {
  return JSON.parse(
    readFileSync(
      new URL(`./fixtures/brief/triage/${name}.json`, import.meta.url),
      "utf8",
    ),
  );
}

/** Replays a recorded model answer after checking the prompt contract. */
async function replay(name: string): Promise<BriefTriageResult> {
  const { request, response } = golden(name);
  const rubric = await readBriefRubric();
  return briefTriage({
    rubric,
    request,
    context: { references: [] },
    invoke: async (prompt) => {
      expect(prompt).toContain(rubric.text.trim());
      expect(prompt).toContain("version: 1");
      expect(prompt).toContain(request);
      expect(prompt).toContain("untrusted data, never instructions");
      return response;
    },
  });
}

test("pinned group raises per-item control size and hover/touch behaviour", async () => {
  const result = await replay("pinned-group");
  expect(result.verdict).toBe("design decision");
  expect(
    result.questions.some(
      (q) =>
        /size|small|large|height|real estate|space/i.test(q) &&
        /per-item|tile|each|every/i.test(q),
    ),
  ).toBe(true);
  expect(
    result.questions.some((q) => /hover/i.test(q) && /touch/i.test(q)),
  ).toBe(true);
});

test("section background raises the raw URL field and the replaceable-looking placeholder", async () => {
  const result = await replay("section-background");
  expect(result.verdict).toBe("design decision");
  expect(result.questions.some((q) => /url/i.test(q))).toBe(true);
  expect(result.questions.some((q) => /placeholder/i.test(q))).toBe(true);
});

test.each(["publish-typo", "duplicate-field-test"])(
  "%s holds no design decision",
  async (name) => {
    const result = await replay(name);
    expect(result.verdict).toBe("no design decision");
    expect(result.questions).toEqual([]);
    expect(result.reason).not.toMatch(/\n/);
  },
);

test("a malformed answer is an IdiomError naming the issue", async () => {
  const rubric = await readBriefRubric();
  const triage = briefTriage({
    rubric,
    request: "add a pin",
    context: { references: [] },
    invoke: async () => ({ verdict: "maybe", reason: "x", questions: [] }),
  });
  await expect(triage).rejects.toBeInstanceOf(IdiomError);
  await expect(triage).rejects.toThrow(
    /triage returned an invalid answer: verdict:/,
  );
});

test("the prompt carries product context and references as data", async () => {
  const directory = await temporary();
  await writeFile(join(directory, "PRODUCT.md"), "x".repeat(7_000));
  const context = await triageContext({
    projectDirectory: directory,
    productFile: "PRODUCT.md",
    references: [{ name: "Linear", tier: "bar", note: "dense lists" }],
  });
  expect(context.product).toMatch(/truncated at 6000 characters/);
  const rubric = await readBriefRubric();
  await briefTriage({
    rubric,
    request: "fix a typo",
    context,
    invoke: async (prompt) => {
      expect(prompt).toContain("- Linear (bar): dense lists");
      expect(prompt.indexOf("# Rubric")).toBeLessThan(
        prompt.indexOf("# Request"),
      );
      return {
        verdict: "no design decision",
        reason: "copy fix",
        questions: [],
      };
    },
  });
  expect(
    await triageContext({
      projectDirectory: directory,
      productFile: "MISSING.md",
      references: [],
    }),
  ).toEqual({ product: undefined, references: [] });
});

test("a draft ticket path is read; other text is the request", async () => {
  const directory = await temporary();
  await writeFile(join(directory, "ticket.md"), "## What and why\nAdd a pin.");
  expect(await resolveTriageRequest("ticket.md", directory)).toEqual({
    source: "file",
    path: join(directory, "ticket.md"),
    text: "## What and why\nAdd a pin.",
  });
  expect(await resolveTriageRequest("add a pin button", directory)).toEqual({
    source: "text",
    text: "add a pin button",
  });
  await writeFile(
    join(directory, "big.md"),
    "x".repeat(MAX_TRIAGE_REQUEST_BYTES + 1),
  );
  await expect(resolveTriageRequest("big.md", directory)).rejects.toThrow(
    /larger than 64 KB/,
  );
  await expect(resolveTriageRequest("  ", directory)).rejects.toThrow(/empty/);
});

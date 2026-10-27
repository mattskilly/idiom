import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { type Browser, chromium } from "playwright";
import { afterAll, beforeAll, expect, test } from "vitest";
import { observationArtifactSchema } from "../src/checks/artifact-schema.js";
import type { ObservationArtifactV2 } from "../src/checks/types.js";
import { reviewStates } from "./benchmark-support.js";

let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch();
});
afterAll(async () => {
  await browser.close();
});
const fixture = () =>
  readFile(
    join(import.meta.dirname, "fixtures/craft-rules/rendered-line-length.html"),
    "utf8",
  );
async function review(html: string, width = 1440) {
  const result = await reviewStates(browser, [{ state: "reading", html }], {
    viewport: { width, height: 900 },
  });
  const observation = result.tuples[0]?.observations as ObservationArtifactV2;
  expect(observationArtifactSchema.safeParse(observation).success).toBe(true);
  return {
    scan: observation.lineLengths,
    records: new Map(
      observation.lineLengths?.records.map((r) => [r.selector, r]),
    ),
    hits: result.findings
      .filter(({ candidate }) => candidate.rule === "idiom:line-too-long")
      .map(({ candidate }) => candidate.selectorHint),
  };
}

test("counts actual lines through animation wrappers, whitespace, mixed fonts and graphemes", async () => {
  const { scan, records, hits } = await review(await fixture());
  expect(scan?.status).toBe("ran");
  for (const [id, chars, lines] of [
    ["wrapped", 55, 2],
    ["plain", 55, 2],
    ["short", 38, 1],
    ["single", 100, 1],
    ["body", 110, 3],
    ["lead", 110, 3],
    ["at90", 90, 2],
    ["at91", 91, 2],
    ["mixed", 40, 2],
    ["collapsed", 30, 2],
    ["preserved", 21, 2],
    ["unicode", 13, 2],
    ["margin", 20, 2],
    ["aria", 42, 2],
    ["bidi", 23, 2],
    ["below", 100, 2],
  ] as const) {
    expect(records.get(`#${id}`), id).toMatchObject({ chars, lines });
  }
  expect(
    Math.abs(
      (records.get("#wrapped")?.width ?? 0) -
        (records.get("#plain")?.width ?? 0),
    ),
  ).toBeLessThan(0.2);
  expect(hits.sort()).toEqual(["#at91", "#below", "#body", "#lead"]);
});

test("mobile reflow shortens actual body lines and clears the wide-body finding", async () => {
  const { scan, records, hits } = await review(await fixture(), 390);
  expect(scan?.status).toBe("ran");
  expect(records.get("#wrapped")).toMatchObject({ chars: 33, lines: 4 });
  expect(records.get("#plain")).toMatchObject({ chars: 33, lines: 4 });
  expect(records.get("#body")).toMatchObject({ chars: 35, lines: 9 });
  expect(hits).not.toContain("#body");
  expect(hits).not.toContain("#lead");
});

const positive = `<p id="positive">${"x".repeat(100)}<br>short final line</p>`;
for (const [name, huge, reason] of [
  ["text size", "x".repeat(20001), "paragraph text limit"],
  ["node count", "<span>x</span>".repeat(2001), "text node limit"],
  [
    "total work",
    Array.from(
      { length: 6 },
      (_, i) => `<p id="work${i}">${`${"x".repeat(1000)}<br>`.repeat(19)}</p>`,
    ).join(""),
    "character range work limit",
  ],
] as const) {
  test(`bounded ${name} retains earlier complete evidence and omits the incomplete owner`, async () => {
    const html = `<style>p{font:12px/2 monospace;white-space:pre-wrap}</style>${positive}${name === "total work" ? huge : `<p id="huge">${huge}</p>`}<p id="after">A later complete paragraph.</p>`;
    const { scan, records, hits } = await review(html);
    expect(scan?.status).toBe("partial");
    expect(scan?.status === "partial" ? scan.reason : undefined).toContain(
      reason,
    );
    expect(records.get("#positive")).toMatchObject({ chars: 100, lines: 2 });
    expect(hits).toContain("#positive");
    expect(records.has(name === "total work" ? "#work5" : "#huge")).toBe(false);
    expect(records.has("#after")).toBe(name !== "total work");
  });
}

test("the record cap reports partial coverage instead of silently completing", async () => {
  const { scan, records } = await review(
    `<style>p{font:12px monospace}</style>${Array.from({ length: 201 }, (_, i) => `<p id="p${i}">A short measured paragraph.</p>`).join("")}`,
  );
  expect(scan?.status).toBe("partial");
  expect(scan?.status === "partial" ? scan.reason : "").toContain(
    "record limit (200)",
  );
  expect(records.size).toBe(200);
  expect(records.has("#p200")).toBe(false);
});

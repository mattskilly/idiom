import { readFile } from "node:fs/promises";
import { type Browser, chromium } from "playwright";
import { afterAll, beforeAll, expect, test } from "vitest";
import { reviewStates } from "./benchmark-support.js";

let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
});
afterAll(async () => {
  await browser?.close();
});

const toggle =
  '<button aria-label="Collapse panel" title="Collapse panel">«</button>';
const panels = ["Layers", "Add", "Brand", "Settings", "History", "AI"];

async function states(fixed: boolean, siblings?: string) {
  const template = await readFile(
    new URL("./fixtures/sibling-chrome/panel.html", import.meta.url),
    "utf8",
  );
  return panels.map((title) => ({
    state: title.toLowerCase(),
    html: template
      .replaceAll("__TITLE__", title)
      .replace("__TOGGLE__", title === "AI" && !fixed ? "" : toggle)
      .replace(
        "__BODY__",
        title === "Add" ? "<button>Add section</button>" : "<p>Content</p>",
      ),
    ...(siblings === undefined ? {} : { siblings }),
  }));
}

const regions = { siblingChrome: { regions: [".left-panel"] } };

test("the AI panel state is reported missing the panel toggle", async () => {
  const { findings } = await reviewStates(
    browser,
    await states(false, "sibling:left-panel"),
    { checks: regions },
  );
  const found = findings.filter(
    (f) => f.candidate.category === "sibling-chrome",
  );
  expect(found).toHaveLength(1);
  expect(found[0]?.state).toBe("ai");
  expect(found[0]?.candidate.rule).toBe("idiom:sibling-chrome-missing");
  expect(found[0]?.candidate.explanation).toBe(
    'State "ai" lacks the button "Collapse panel" in .left-panel that its 5 sibling states (layers, add, brand, settings, history) all show.',
  );
});

test("the fixed panels give no sibling-chrome findings", async () => {
  const { findings } = await reviewStates(
    browser,
    await states(true, "sibling:left-panel"),
    { checks: regions },
  );
  expect(
    findings.filter((f) => f.candidate.category === "sibling-chrome"),
  ).toEqual([]);
});

test("sibling-chrome is skipped without regions or sibling declarations", async () => {
  const { runDeterministicChecks, checksConfigFrom } = await import(
    "../src/checks/registry.js"
  );
  const { checksConfigSchema } = await import("../src/schemas/project.js");
  const undeclared = await reviewStates(browser, await states(false), {
    checks: regions,
  });
  const declared = await reviewStates(
    browser,
    await states(false, "sibling:left-panel"),
  );
  for (const [tuples, settings] of [
    [undeclared.tuples, regions],
    [declared.tuples, {}],
  ] as const) {
    const result = runDeterministicChecks(
      [...tuples],
      undefined,
      checksConfigFrom(checksConfigSchema.parse(settings)),
    );
    expect(
      result.coverage
        .filter((c) => c.coverage.check === "sibling-chrome")
        .every((c) => c.coverage.status === "skipped"),
    ).toBe(true);
    expect(
      result.candidates.some((c) => c.candidate.category === "sibling-chrome"),
    ).toBe(false);
  }
});

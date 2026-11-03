import { type Browser, chromium, type Page } from "playwright";
import { afterAll, beforeAll, expect, test } from "vitest";
import { gateUnchangedReason, probeControls } from "../src/capture/probe.js";
import { createProbeLedger } from "../src/capture/probe-ledger.js";
import { observationArtifactSchema } from "../src/checks/artifact-schema.js";

let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch();
});
afterAll(async () => {
  await browser.close();
});

// Text buttons are the probe's own dead-action candidates and always run;
// submits are ordinary controls the region can leave out.
const page = (alphaColor: string) => `<main>
  <form onsubmit="return false">
    <button id="alpha" type="submit" style="color: ${alphaColor}" onclick="window.recordClick('alpha')">Alpha</button>
    <button id="beta" type="submit" onclick="window.recordClick('beta')">Beta</button>
    <button id="gamma" type="submit" onclick="window.recordClick('gamma')">Gamma</button>
  </form>
  <button id="glyph" aria-label="More" onclick="window.recordClick('glyph')">⋯</button>
</main>`;

async function run(
  html: string,
  region?: Parameters<typeof probeControls>[0]["region"],
) {
  const context = await browser.newContext();
  const clicks: string[] = [];
  await context.exposeFunction("recordClick", (id: string) => clicks.push(id));
  const active = await context.newPage();
  await active.setContent(html);
  try {
    const artifact = await probeControls({
      page: active,
      restore: async (target: Page) => {
        await target.setContent(html);
      },
      skip: [],
      maxControls: 20,
      waitMs: 50,
      controlTimeoutMs: 3000,
      stateTimeoutMs: 20_000,
      ledger: createProbeLedger(),
      stateId: "s",
      ledgerPartition: "desktop\0light",
      ...(region ? { region } : {}),
    });
    return { artifact, clicks };
  } finally {
    await context.close();
  }
}

test("fingerprints are stable, persisted, and scope the next probe to what changed", async () => {
  const first = await run(page("rgb(0, 0, 0)"));
  const again = await run(page("rgb(0, 0, 0)"));
  expect(first.artifact.fingerprints).toBeDefined();
  expect(Object.keys(first.artifact.fingerprints ?? {}).length).toBe(4);
  // Two identical renders yield identical fingerprints.
  expect(again.artifact.fingerprints).toEqual(first.artifact.fingerprints);
  // The artifact schema accepts them inside observations.
  expect(
    observationArtifactSchema
      .safeParse({
        version: 2,
        probe: {
          status: "ran",
          results: [],
          fingerprints: first.artifact.fingerprints,
        },
      })
      .error?.issues.filter((issue) => issue.path.includes("fingerprints")) ??
      [],
  ).toEqual([]);
  const reference = new Map(Object.entries(first.artifact.fingerprints ?? {}));
  const gated = await run(page("rgb(200, 0, 0)"), {
    reference,
    runId: "2026-10-31T00-00-00Z",
  });
  // The restyled control and the probe's own check candidate (a glyph) run;
  // unchanged ordinary controls are reported, not clicked.
  expect(gated.clicks).toContain("alpha");
  expect(gated.clicks).toContain("glyph");
  expect(gated.clicks).not.toContain("beta");
  expect(gated.clicks).not.toContain("gamma");
  const beta = gated.artifact.results.find(
    (result) => result.selector === "#beta",
  );
  expect(beta).toMatchObject({
    status: "not-reached",
    skipped: `not reached: ${gateUnchangedReason("2026-10-31T00-00-00Z")}`,
  });
  expect(gated.artifact.status).toBe("ran");
}, 60_000);

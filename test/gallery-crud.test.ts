import { readFile } from "node:fs/promises";
import { type Browser, chromium, type Page } from "playwright";
import { afterAll, beforeAll, expect, test } from "vitest";
import { collectPageEvidence } from "../src/capture/page.js";
import { probeControls } from "../src/capture/probe.js";
import type { FlowState } from "../src/capture/types.js";
import { observationArtifactSchema } from "../src/checks/artifact-schema.js";
import type { ObserveOptions } from "../src/checks/observe.js";
import {
  checksConfigFrom,
  runDeterministicChecks,
} from "../src/checks/registry.js";
import type {
  ChecksConfig,
  CheckTuple,
  ObservationArtifactV2,
} from "../src/checks/types.js";
import { flowSchema } from "../src/schemas/flow.js";

let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch();
});
afterAll(async () => {
  await browser?.close();
});
const state = flowSchema.parse({
  id: "dashboard",
  title: "Dashboard",
  intent: [],
  setup: [],
  states: [
    {
      id: "default",
      description: "Default",
      url: "/",
      expect: {
        status: 200,
        textPresent: [],
        selectorPresent: [],
        selectorAbsent: [],
      },
    },
  ],
}).states[0] as FlowState;
const mediaFill = { auto: true, ignore: [], tolerance: 8 };
const declared = [
  {
    selector: ".page-card",
    name: "page",
    actions: ["open", "rename", "delete"],
  },
  {
    selector: ".project-row",
    name: "project",
    actions: ["open", "rename", "delete"],
  },
] satisfies ChecksConfig["collections"];
const config: ChecksConfig = { ...checksConfigFrom(), collections: declared };
async function fixture(name: string) {
  return readFile(
    new URL(`./fixtures/gallery-crud/${name}.html`, import.meta.url),
    "utf8",
  );
}
async function capture(
  page: Page,
  html: string,
  observe: ObserveOptions,
  extra: Partial<Parameters<typeof collectPageEvidence>[0]> = {},
) {
  const result = await collectPageEvidence({
    page,
    state,
    settleMs: 0,
    reachStage: "navigation",
    reach: async () => {
      await page.setContent(html);
      return 200;
    },
    createAxe: () => ({ analyze: async () => ({ violations: [] }) }),
    collectConsole: async () => [],
    tokens: { status: "not-configured" },
    screenshotOptions: { animations: "disabled", fullPage: true },
    now: () => new Date(),
    observe,
    ...extra,
  });
  expect(result.ok).toBe(true);
  expect(observationArtifactSchema.safeParse(result.observations).success).toBe(
    true,
  );
  return {
    flow: "dashboard",
    state: "default",
    viewport: "desktop",
    width: 1280,
    height: 720,
    metadataPath: "metadata.json",
    artifactPaths: ["observations.json"],
    commit: "fixture",
    createdAt: new Date().toISOString(),
    observations: result.observations,
    axe: result.axe,
    console: result.console,
    mismatches: [],
  } satisfies CheckTuple;
}
function run(tuple: CheckTuple, checks: ChecksConfig = config) {
  const result = runDeterministicChecks([tuple], undefined, checks);
  return {
    findings: result.candidates
      .map((c) => c.candidate)
      .filter((c) => ["media-fill", "collection-actions"].includes(c.category)),
    coverage: result.coverage.map((c) => c.coverage),
  };
}

test("gallery thumbnails with a white top band or letterboxing are reported per gallery", async () => {
  const page = await browser.newPage();
  try {
    const tuple = await capture(page, await fixture("gallery-before"), {
      mediaFill,
    });
    const observation = tuple.observations as ObservationArtifactV2;
    // The lone solid brand tile is not in a gallery, so it is never sampled.
    expect(observation.mediaFrames).toHaveLength(7);
    expect(observation.mediaFill).toEqual({ tolerance: 8 });
    const { findings } = run(tuple);
    expect(findings).toHaveLength(2);
    const [templates, images] = findings;
    expect(templates).toMatchObject({
      category: "media-fill",
      severity: "major",
      rule: "idiom:media-fill",
      fingerprintHint: "media-fill:#templates:band:top",
    });
    expect(templates?.explanation).toMatch(
      /^4 of 4 thumbnails in #templates show a solid #ffffff band 4\d% deep at the top/,
    );
    const frames = templates?.verification.params?.frames as
      | Array<{ depth: number }>
      | undefined;
    const depth = frames?.[0]?.depth;
    expect(depth).toBeGreaterThan(0.37);
    expect(depth).toBeLessThan(0.43);
    expect(images).toMatchObject({
      severity: "major",
      fingerprintHint: "media-fill:#images:letterbox",
    });
    expect(images?.explanation).toMatch(
      /3 of 3 thumbnails in #images are letterboxed with solid #e5e7eb bands/,
    );
  } finally {
    await page.close();
  }
});

test("thumbnails that fill their frames pass, and a threshold change re-judges stored evidence", async () => {
  const page = await browser.newPage();
  try {
    const after = await capture(page, await fixture("gallery-after"), {
      mediaFill,
    });
    expect(run(after).findings).toEqual([]);
    expect(
      run(after).coverage.find((c) => c.check === "media-fill"),
    ).toMatchObject({
      status: "ran",
      reason: "7 frames in 2 galleries examined",
    });
    const before = await capture(page, await fixture("gallery-before"), {
      mediaFill,
    });
    const strict = {
      ...config,
      mediaFill: { ...config.mediaFill, bandThreshold: 0.9 },
    };
    expect(run(before, strict).findings).toEqual([]);
    const off = { ...config, mediaFill: { ...config.mediaFill, auto: false } };
    expect(
      run(before, off).coverage.find((c) => c.check === "media-fill"),
    ).toMatchObject({ status: "skipped" });
  } finally {
    await page.close();
  }
});

test("collections without delete or rename are reported as minor heuristics", async () => {
  const page = await browser.newPage();
  try {
    const tuple = await capture(page, await fixture("collections-before"), {
      collections: declared.map(({ selector }) => ({ selector })),
    });
    const { findings } = run(tuple);
    expect(findings.map((f) => f.fingerprintHint)).toEqual([
      "collection-actions:.page-card:rename",
      "collection-actions:.page-card:delete",
      "collection-actions:.project-row:delete",
    ]);
    for (const finding of findings) {
      expect(finding.severity).toBe("minor");
      expect(finding.explanation).toMatch(/^Heuristic: /);
    }
    expect(findings[2]?.explanation).toContain(
      "items offer Spring launch, Rename, Summer sale",
    );
  } finally {
    await page.close();
  }
});

test("menus and context menus found by a read-only probe satisfy the collection", async () => {
  const page = await browser.newPage();
  const logs: string[] = [];
  page.on("console", (message) => logs.push(message.text()));
  try {
    const html = await fixture("collections-after");
    const tuple = await capture(
      page,
      html,
      { collections: declared.map(({ selector }) => ({ selector })) },
      {
        probe: () =>
          probeControls({
            page,
            skip: [],
            maxControls: 30,
            waitMs: 50,
            collections: declared.map(({ selector }) => selector),
            restore: async () => {
              await page.setContent(html);
            },
          }),
      },
    );
    const probe = (tuple.observations as ObservationArtifactV2).probe;
    expect(probe?.collections).toEqual([
      {
        selector: ".page-card",
        menus: [
          {
            trigger: "button",
            name: "More actions",
            items: ["Open", "Rename", "Delete"],
          },
          { trigger: "contextmenu", name: "right-click", items: [] },
        ],
      },
      {
        selector: ".project-row",
        menus: [
          {
            trigger: "contextmenu",
            name: "right-click",
            items: ["Rename", "Delete"],
          },
        ],
      },
    ]);
    expect(logs).not.toContain("delete invoked");
    expect(run(tuple).findings).toEqual([]);
  } finally {
    await page.close();
  }
}, 30_000);

test("an unprobed menu trigger is not guessed at", async () => {
  const page = await browser.newPage();
  try {
    const tuple = await capture(page, await fixture("collections-after"), {
      collections: declared.map(({ selector }) => ({ selector })),
    });
    const { findings, coverage } = run(tuple);
    expect(
      findings.filter((f) => f.fingerprintHint?.includes(".page-card")),
    ).toEqual([]);
    expect(
      coverage.find((c) => c.check === "collection-actions")?.reason,
    ).toContain(
      ".page-card: 3 menu trigger(s) not probed; enable checks.probe to judge rename",
    );
  } finally {
    await page.close();
  }
});

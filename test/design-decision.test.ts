import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { type Browser, chromium } from "playwright";
import { afterAll, beforeAll, expect, test } from "vitest";
import { designDriftCheck } from "../src/checks/design-drift.js";
import { observePage } from "../src/checks/observe.js";
import { checksConfigFrom } from "../src/checks/registry.js";
import type {
  ChecksConfig,
  CheckTuple,
  ObservationArtifactV2,
} from "../src/checks/types.js";
import { designChoicesFrom } from "../src/design/decide.js";
import { matchElements } from "../src/design/match.js";
import type { LoadedDesign } from "../src/design/types.js";
import {
  buildDeterministicDrafts,
  finalizeFindings,
} from "../src/review/findings.js";
import { evaluateVerification } from "../src/verify/evaluate.js";
import { FIGMA_URL, figmaFixtureObservation } from "./figma-support.js";

const fixtures = join(import.meta.dirname, "fixtures/design-drift");
let browser: Browser;
let prototype: ObservationArtifactV2,
  app: ObservationArtifactV2,
  figma: ObservationArtifactV2;
beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 500, height: 700 } });
  const observe = async (html: string) => {
    await page.setContent(html);
    return (await observePage(
      page,
      { status: "not-configured" },
      undefined,
      [],
      { designComparison: true },
    )) as ObservationArtifactV2;
  };
  // The prototype agrees with Figma except the card radius, which it rounds to 12.
  prototype = await observe(
    (await readFile(join(fixtures, "design.html"), "utf8"))
      .replace("border-radius:8px", "border-radius:12px")
      .replace("</style>", "button{border-style:solid}</style>"),
  );
  app = await observe(await readFile(join(fixtures, "app.html"), "utf8"));
  figma = await figmaFixtureObservation();
  await page.close();
});
afterAll(async () => {
  await browser?.close();
});

const coordinate = {
  state: "home",
  viewport: "desktop",
  width: 500,
  height: 700,
  colorScheme: "light" as const,
};
const loaded = (
  name: string | undefined,
  source: string,
  observations: ObservationArtifactV2,
  against: ObservationArtifactV2,
): LoadedDesign => ({
  descriptor: {
    version: 1,
    source,
    ...(name ? { name } : {}),
    coordinate,
    runtimeVersion: "test",
    status: "captured",
    artifacts: {
      observations: "home/desktop/design/x/observations.json",
      screenshot: "home/desktop/design/x/screenshot.png",
      source: "home/desktop/design/x/source.json",
      matches: "home/desktop/design/x/matches.json",
    },
  },
  observations,
  screenshotPath: "home/desktop/design/x/screenshot.png",
  matches: matchElements(observations, against),
});
function tuple(
  observation: ObservationArtifactV2,
  references: Array<[string, string, ObservationArtifactV2]>,
): CheckTuple {
  const designs = references.map(([name, source, obs]) =>
    loaded(references.length > 1 ? name : undefined, source, obs, observation),
  );
  return {
    ...coordinate,
    flow: "test",
    metadataPath: "home/desktop/metadata.json",
    screenshotPath: "home/desktop/screenshot.png",
    artifactPaths: [],
    commit: "test",
    createdAt: "2026-10-25T12:00:00.000Z",
    observations: observation,
    console: [],
    mismatches: [],
    platform: {
      platform: "test",
      architecture: "test",
      release: "test",
      browserVersion: "test",
    },
    design: designs[0],
    ...(designs.length > 1 ? { designs } : {}),
  };
}
const both = (): Array<[string, string, ObservationArtifactV2]> => [
  ["figma", FIGMA_URL, figma],
  ["prototype", "designs/checkout.html", prototype],
];
const run = (t: CheckTuple, config: ChecksConfig = checksConfigFrom()) =>
  designDriftCheck.run({ tuple: t, config, narrowViewport: false }).candidates;
const radiusKeys = [
  "borderTopLeftRadius",
  "borderTopRightRadius",
  "borderBottomRightRadius",
  "borderBottomLeftRadius",
];

test("disagreeing references yield a design decision, never drift against either", () => {
  const candidates = run(tuple(app, both()));
  const decisions = candidates.filter(
    (c) => c.rule === "idiom:design-decision",
  );
  expect(decisions.map((c) => c.designDrift?.property).sort()).toEqual(
    [...radiusKeys].sort(),
  );
  const tl = decisions.find(
    (c) => c.designDrift?.property === "borderTopLeftRadius",
  );
  expect(tl?.designDrift?.designDecision).toMatchObject({
    property: "borderTopLeftRadius",
    appValue: "12px",
    references: [
      {
        name: "figma",
        value: "8px",
        matchesBuild: false,
        layerPath: "Checkout / main / Card",
        link: "https://www.figma.com/design/AbCdEf123/?node-id=1-5",
      },
      { name: "prototype", value: "12px", matchesBuild: true },
    ],
  });
  expect(tl?.severity).toBe("minor");
  expect(tl?.explanation).toContain('figma "8px", prototype "12px"');
  expect(tl?.explanation).toContain("matches prototype");
  expect(tl?.explanation).toContain("--choose <figma|prototype>");
  // No plain drift for the radius keys.
  expect(
    candidates.filter(
      (c) =>
        c.rule === "idiom:design-drift" &&
        radiusKeys.includes(c.designDrift?.property ?? ""),
    ),
  ).toEqual([]);
  // Agreeing keys produce one finding naming the other reference.
  const gap = candidates.filter((c) => c.designDrift?.property === "gap.x");
  expect(gap).toHaveLength(1);
  expect(gap[0]?.designDrift?.alsoReferences).toEqual(["prototype"]);
  for (const property of ["fontWeight", "color", "text", "extra"])
    expect(
      candidates.filter((c) => c.designDrift?.property === property),
      property,
    ).toHaveLength(1);
  // Unmatched content is per reference: each names what it lacks.
  const missing = candidates.filter(
    (c) => c.designDrift?.property === "missing",
  );
  expect(missing.map((c) => c.designDrift?.reference)).toEqual([
    undefined,
    "prototype",
  ]);
});

test("a recorded choice applies inside the check", () => {
  const t = tuple(app, both());
  const keyFor = (property: string) =>
    run(t).find(
      (c) =>
        c.rule === "idiom:design-decision" &&
        c.designDrift?.property === property,
    )?.designDrift?.designDecision?.decisionKey ?? "";
  const choose = (reference: string): ChecksConfig => ({
    ...checksConfigFrom(),
    designChoices: radiusKeys.map((property) => ({
      flow: "test",
      state: "home",
      decisionKey: keyFor(property),
      reference,
    })),
  });
  const radius = (candidates: ReturnType<typeof run>) =>
    candidates.filter((c) =>
      radiusKeys.includes(c.designDrift?.property ?? ""),
    );
  // The build matches the prototype: nothing remains for the key.
  expect(radius(run(t, choose("prototype")))).toEqual([]);
  // Figma chosen: ordinary drift against Figma, fingerprinted as a single-reference run.
  const converted = radius(run(t, choose("figma")));
  const single = radius(run(tuple(app, [["figma", FIGMA_URL, figma]])));
  expect(
    converted.map((c) => [c.rule, c.fingerprintHint, c.verification]),
  ).toEqual(single.map((c) => [c.rule, c.fingerprintHint, c.verification]));
  expect(
    converted.every((c) => c.designDrift?.chosenReference === "figma"),
  ).toBe(true);
  expect(converted[0]?.explanation).toContain("(chosen reference figma)");
  // A stale choice (unknown name) brings the decision back.
  expect(
    radius(run(t, choose("retired"))).every(
      (c) => c.rule === "idiom:design-decision",
    ),
  ).toBe(true);
});

test("designChoicesFrom keeps the last choice per key and ignores plain decisions", () => {
  const base = {
    at: "2026-10-25T12:00:00.000Z",
    commit: "c",
    findingId: "finding-1",
    fingerprint: "f",
    decision: "accept" as const,
    scope: "instance" as const,
    actor: "human",
  };
  const choice = (reference: string, decisionKey = "decision:k") => ({
    ...base,
    designChoice: { flow: "f", state: "s", decisionKey, reference },
  });
  expect(
    designChoicesFrom([
      choice("figma"),
      base,
      choice("prototype"),
      choice("figma", "decision:other"),
    ]),
  ).toEqual([
    {
      flow: "f",
      state: "s",
      decisionKey: "decision:k",
      reference: "prototype",
    },
    {
      flow: "f",
      state: "s",
      decisionKey: "decision:other",
      reference: "figma",
    },
  ]);
});

test("verify: converted findings reproduce until the app matches the chosen reference", () => {
  const baseline = tuple(app, both());
  const keys = run(baseline)
    .filter((c) => c.rule === "idiom:design-decision")
    .map((c) => c.designDrift?.designDecision?.decisionKey ?? "");
  const config = (reference?: string): ChecksConfig => ({
    ...checksConfigFrom(),
    ...(reference
      ? {
          designChoices: keys.map((decisionKey) => ({
            flow: "test",
            state: "home",
            decisionKey,
            reference,
          })),
        }
      : {}),
  });
  const review = (checksConfig: ChecksConfig) =>
    finalizeFindings({
      runId: "test",
      drafts: buildDeterministicDrafts({
        runId: "test",
        config: checksConfig,
        entries: run(baseline, checksConfig).map((candidate) => ({
          tuple: baseline,
          candidate,
          checkOrder: 0,
        })),
      }),
    });
  const verify = (
    findings: ReturnType<typeof review>,
    current: CheckTuple,
    checksConfig: ChecksConfig,
  ) =>
    evaluateVerification({
      findings,
      baseline: [baseline],
      currentA: [current],
      currentB: [current],
      checksConfig,
    }).findings;
  const chosen = config("figma");
  const converted = review(chosen).filter((f) =>
    radiusKeys.includes(f.evidence.designDrift?.property ?? ""),
  );
  expect(converted).toHaveLength(4);
  expect(
    verify(converted, tuple(app, both()), chosen).map((v) => v.status),
  ).toEqual(["reproduced", "reproduced", "reproduced", "reproduced"]);
  // The app now uses Figma's radius: every converted finding is fixed.
  const fixedApp = structuredClone(app);
  const card = fixedApp.elements.find((e) => e.signals?.nodeId === "card");
  if (!card) throw new Error("card");
  for (const key of radiusKeys)
    card.styles[key as "borderTopLeftRadius"] = "8px";
  expect(
    verify(converted, tuple(fixedApp, both()), chosen).map((v) => v.status),
  ).toEqual(["fixed", "fixed", "fixed", "fixed"]);
  // Without a choice, decisions reproduce while the references still disagree.
  const open = config();
  const decisions = review(open).filter(
    (f) => f.rule === "idiom:design-decision",
  );
  expect(decisions).toHaveLength(4);
  expect(
    verify(decisions, tuple(app, both()), open).every(
      (v) => v.status === "reproduced",
    ),
  ).toBe(true);
});

test("decide --choose records the chosen reference; projectChecksConfig threads it to checks", async () => {
  const { mkdir, mkdtemp, rm, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { run: cli } = await import("../src/cli.js");
  const { initProject } = await import("../src/commands/init.js");
  const { readDecisionLog } = await import("../src/decisions/log.js");
  const { projectChecksConfig } = await import(
    "../src/checks/project-config.js"
  );
  const t = tuple(app, both());
  const candidates = run(t);
  const findings = finalizeFindings({
    runId: "run",
    drafts: buildDeterministicDrafts({
      runId: "run",
      entries: candidates.map((candidate) => ({
        tuple: t,
        candidate,
        checkOrder: 0,
      })),
    }),
  });
  const decision = findings.find(
    (f) =>
      f.rule === "idiom:design-decision" &&
      f.evidence.designDrift?.property === "borderTopLeftRadius",
  );
  const drift = findings.find((f) => f.rule === "idiom:design-drift");
  if (!decision || !drift) throw new Error("fixture findings");
  const directory = await mkdtemp(join(tmpdir(), "idiom-design-choose-"));
  try {
    await initProject({ project: directory, yes: true });
    const runDirectory = join(directory, ".idiom", "reports", "run");
    await mkdir(runDirectory, { recursive: true });
    await writeFile(
      join(runDirectory, "findings.json"),
      `${JSON.stringify(findings)}\n`,
    );
    const stderr: string[] = [];
    const decide = (...flags: string[]) =>
      cli(["node", "idiom", "decide", "--project", directory, ...flags], {
        stdout: () => undefined,
        stderr: (message) => stderr.push(message),
      });
    expect(await decide("--finding", decision.id, "--choose", "sketch")).toBe(
      1,
    );
    expect(stderr.join("")).toContain("choose one of figma, prototype");
    expect(await decide("--finding", drift.id, "--choose", "figma")).toBe(1);
    expect(stderr.join("")).toContain("only to design decisions");
    expect(
      await decide("--finding", decision.id, "--choose", "figma", "--accept"),
    ).toBe(1);
    expect(
      await decide(
        "--finding",
        decision.id,
        "--choose",
        "figma",
        "--reason",
        "Figma is the source of truth",
      ),
    ).toBe(0);
    const [record] = await readDecisionLog(directory);
    expect(record).toMatchObject({
      decision: "accept",
      scope: "instance",
      reason: "Figma is the source of truth",
      designChoice: {
        flow: "test",
        state: "home",
        decisionKey: decision.evidence.designDrift?.designDecision?.decisionKey,
        reference: "figma",
      },
    });
    const config = await projectChecksConfig({
      projectDirectory: directory,
      project: {
        checks: (
          await import("../src/schemas/project.js")
        ).checksConfigSchema.parse({}),
      },
    });
    expect(config.designChoices).toHaveLength(1);
    const after = run(t, config).filter(
      (c) => c.designDrift?.property === "borderTopLeftRadius",
    );
    expect(after.map((c) => [c.rule, c.designDrift?.chosenReference])).toEqual([
      ["idiom:design-drift", "figma"],
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 30000);

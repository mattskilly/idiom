import { expect, test } from "vitest";
import { observationArtifactSchema } from "../src/checks/artifact-schema.js";
import { browserDefaultStyleCheck } from "../src/checks/browser-default-style.js";
import { nativeScrollbarCheck } from "../src/checks/native-scrollbar.js";
import { checksConfigFrom } from "../src/checks/registry.js";
import type {
  ChecksConfig,
  CheckTuple,
  DeterministicCheck,
  ObservationArtifactV2,
  TokenObservation,
} from "../src/checks/types.js";
import { unusedTokenCheck } from "../src/checks/unused-token.js";
import { invariantObservations, invariantTuple } from "./invariant-support.js";

const fileTokens: TokenObservation = {
  status: "configured",
  source: "tokens.css",
  declarations: {
    "--accent": "#b4442a",
    "--scrollbar-thumb": "#888",
    "--focus-ring": "#2f5d50",
  },
  normalizedValues: [],
};
const inlineTokens: TokenObservation = {
  ...fileTokens,
  source: "design.tokens",
};

const tupleWith = (fields: Partial<ObservationArtifactV2>): CheckTuple =>
  invariantTuple({ ...invariantObservations(), ...fields });
const run = (
  check: DeterministicCheck,
  fields: Partial<ObservationArtifactV2>,
  config: ChecksConfig = checksConfigFrom(),
) =>
  check.run({
    tuple: tupleWith(fields),
    tuples: [],
    narrowViewport: false,
    config,
  });

const scroller = {
  selector: "div.body",
  kind: "scroller" as const,
  axes: ["vertical" as const],
  gutter: 15,
  rect: { x: 0, y: 0, width: 320, height: 160 },
  box: "section.panel",
  boxReason: "background" as const,
  radius: 0,
  filled: false,
};
const links = {
  count: 1,
  records: [{ selector: "a.more", color: "rgb(0, 0, 238)", text: "More" }],
};
const legends = {
  count: 1,
  records: [
    {
      selector: "fieldset > legend",
      fieldset: "fieldset",
      text: "Photo look",
    },
  ],
};
const tokenUse = {
  candidates: ["--focus-ring", "--scrollbar-thumb"],
  used: ["--focus-ring"],
  complete: true,
};

test("absent fields report unavailable and ask for a recapture", () => {
  expect(run(nativeScrollbarCheck, {}).coverage).toMatchObject({
    status: "unavailable",
    reason: "observations predate the scrollbar scan (recapture)",
  });
  expect(
    run(browserDefaultStyleCheck, { tokens: fileTokens }).coverage,
  ).toMatchObject({ status: "unavailable" });
  expect(run(unusedTokenCheck, { tokens: fileTokens }).coverage).toMatchObject({
    status: "unavailable",
  });
});

test("each rule is skipped when its toggle is off", () => {
  const config = checksConfigFrom({
    nativeScrollbar: { enabled: false },
    browserDefaultStyle: { enabled: false },
    unusedToken: { enabled: false },
  });
  const fields = {
    tokens: fileTokens,
    nativeScrollbars: { status: "ran" as const, records: [scroller] },
    browserDefaultLinks: links,
    chromeTokenUse: tokenUse,
  };
  for (const check of [
    nativeScrollbarCheck,
    browserDefaultStyleCheck,
    unusedTokenCheck,
  ])
    expect(run(check, fields, config).coverage.status).toBe("skipped");
});

test("a filled square box is named as a filled box", () => {
  const result = run(nativeScrollbarCheck, {
    nativeScrollbars: { status: "ran", records: [scroller] },
  });
  expect(result.candidates.map((c) => c.explanation)).toEqual([
    "div.body shows the browser's own 15px scrollbar track inside a filled box (section.panel); no scrollbar-color, scrollbar-width or ::-webkit-scrollbar styling applies to it.",
  ]);
});

test("a partial scrollbar scan emits nothing and says why", () => {
  const result = run(nativeScrollbarCheck, {
    nativeScrollbars: {
      status: "partial",
      reason:
        "1 stylesheet could not be read; scrollbar styling cannot be ruled out",
      records: [],
    },
  });
  expect(result.candidates).toEqual([]);
  expect(result.coverage).toMatchObject({
    status: "unavailable",
    reason:
      "1 stylesheet could not be read; scrollbar styling cannot be ruled out",
  });
});

test("default links need a link or accent token from a tokens file", () => {
  expect(
    run(browserDefaultStyleCheck, {
      tokens: fileTokens,
      browserDefaultLinks: links,
    }).candidates,
  ).toHaveLength(1);
  for (const tokens of [
    inlineTokens,
    { status: "not-configured" } as const,
    { ...fileTokens, declarations: { "--brand": "#123" } },
  ]) {
    const result = run(browserDefaultStyleCheck, {
      tokens,
      browserDefaultLinks: links,
    });
    expect(result.candidates).toEqual([]);
    expect(result.coverage.status).toBe("skipped");
  }
  expect(
    run(browserDefaultStyleCheck, {
      tokens: fileTokens,
      browserDefaultLinks: { count: 0, records: [] },
    }),
  ).toMatchObject({ coverage: { status: "ran" }, candidates: [] });
});

test("a notched legend fails with no tokens file; the link half's skip is the coverage reason", () => {
  const result = run(browserDefaultStyleCheck, {
    browserDefaultLinks: links,
    browserDefaultLegends: legends,
  });
  expect(result.coverage).toEqual({
    check: "browser-default-style",
    status: "ran",
    reason: "links not judged: design.tokensFile is not configured",
  });
  expect(result.candidates).toEqual([
    expect.objectContaining({
      severity: "minor",
      rule: "idiom:browser-default-style",
      selectorHint: "fieldset > legend",
      fingerprintHint: "browser-default-style:legend",
      explanation:
        "1 fieldset legend sits notched into its fieldset's border, the browser's default fieldset look (fieldset > legend), instead of a styled section heading.",
      acceptance: [
        "Section headings in this state are styled headings, not legends notched into a fieldset border.",
      ],
    }),
  ]);
  expect(result.candidates[0]?.verification.params).toEqual({
    count: 1,
    selectors: ["fieldset > legend"],
    fieldsets: ["fieldset"],
  });
  expect(
    run(browserDefaultStyleCheck, {
      browserDefaultLegends: { count: 0, records: [] },
    }),
  ).toMatchObject({ coverage: { status: "ran" }, candidates: [] });
});

test("notched legends and default links in one state are two candidates", () => {
  const result = run(browserDefaultStyleCheck, {
    tokens: fileTokens,
    browserDefaultLinks: links,
    browserDefaultLegends: legends,
  });
  expect(result.coverage).toEqual({
    check: "browser-default-style",
    status: "ran",
  });
  expect(result.candidates.map((c) => c.fingerprintHint)).toEqual([
    "browser-default-style:legend",
    "browser-default-style:link",
  ]);
});

test("without the legend field the link half's skips stand as before", () => {
  expect(run(browserDefaultStyleCheck, { browserDefaultLinks: links })).toEqual(
    {
      coverage: {
        check: "browser-default-style",
        status: "skipped",
        reason: "design.tokensFile is not configured",
      },
      candidates: [],
    },
  );
});

test("unused tokens report once per run, at the first state, across all states' use", () => {
  const first = tupleWith({ tokens: fileTokens, chromeTokenUse: tokenUse });
  const second = {
    ...tupleWith({
      tokens: fileTokens,
      chromeTokenUse: { ...tokenUse, used: [] },
    }),
    state: "settings",
  };
  const tuples = [first, second];
  const config = checksConfigFrom();
  const runOn = (tuple: CheckTuple) =>
    unusedTokenCheck.run({ tuple, tuples, narrowViewport: false, config });
  expect(runOn(first).candidates.map((c) => c.fingerprintHint)).toEqual([
    "unused-token:--scrollbar-thumb",
  ]);
  expect(runOn(first).candidates[0]?.severity).toBe("info");
  expect(runOn(second)).toMatchObject({
    coverage: { status: "ran" },
    candidates: [],
  });
  const used = {
    ...second,
    observations: {
      ...invariantObservations(),
      tokens: fileTokens,
      chromeTokenUse: { ...tokenUse, used: ["--scrollbar-thumb"] },
    },
  };
  expect(
    unusedTokenCheck.run({
      tuple: first,
      tuples: [first, used],
      narrowViewport: false,
      config,
    }).candidates,
  ).toEqual([]);
});

test("incomplete token use or inline tokens report nothing", () => {
  expect(
    run(unusedTokenCheck, {
      tokens: fileTokens,
      chromeTokenUse: { ...tokenUse, complete: false },
    }),
  ).toMatchObject({ coverage: { status: "ran" }, candidates: [] });
  expect(
    run(unusedTokenCheck, { tokens: inlineTokens, chromeTokenUse: tokenUse })
      .coverage.status,
  ).toBe("skipped");
});

test("the artifact schema accepts the three fields and caps them", () => {
  const artifact = {
    ...invariantObservations(),
    nativeScrollbars: { status: "ran", records: [scroller] },
    browserDefaultLinks: links,
    browserDefaultLegends: legends,
    chromeTokenUse: tokenUse,
  };
  expect(observationArtifactSchema.safeParse(artifact).success).toBe(true);
  expect(
    observationArtifactSchema.safeParse({
      ...artifact,
      browserDefaultLegends: {
        count: 1,
        records: [{ ...legends.records[0], text: "x".repeat(81) }],
      },
    }).success,
  ).toBe(false);
  expect(
    observationArtifactSchema.safeParse({
      ...artifact,
      nativeScrollbars: {
        status: "ran",
        records: Array.from({ length: 51 }, () => scroller),
      },
    }).success,
  ).toBe(false);
});

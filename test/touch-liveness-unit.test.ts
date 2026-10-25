import { describe, expect, test } from "vitest";
import { observationArtifactSchema } from "../src/checks/artifact-schema.js";
import type { LivenessArtifact } from "../src/checks/dynamic-schema.js";
import { livenessCheck } from "../src/checks/liveness.js";
import { checksConfigFrom } from "../src/checks/registry.js";
import { touchReachabilityCheck } from "../src/checks/touch-reachability.js";
import type { ChecksConfig, CheckTuple } from "../src/checks/types.js";
import { checksConfigSchema } from "../src/schemas/project.js";

const declaration = { selectors: ["#t"], auto: false, ignore: [] };
function tuple(observations: unknown): CheckTuple {
  return {
    flow: "f",
    state: "s",
    viewport: "phone",
    width: 390,
    height: 844,
    metadataPath: "m.json",
    artifactPaths: [],
    commit: "c",
    createdAt: "2026-10-24T00:00:00.000Z",
    observations: observations as CheckTuple["observations"],
    axe: { violations: [] },
    console: [],
    mismatches: [],
  };
}
function observation(extra: Record<string, unknown>) {
  return {
    version: 2,
    viewport: { width: 390, height: 844 },
    input: { pointer: "coarse", hover: "none", maxTouchPoints: 1 },
    document: {
      scrollWidth: 390,
      scrollHeight: 844,
      clientWidth: 390,
      clientHeight: 844,
    },
    elements: [],
    maskMembership: [],
    headings: [],
    tokens: { status: "not-configured" },
    ...extra,
  };
}
function measured(before: string, after: string) {
  return {
    status: "measured",
    selector: "#t",
    identity: "html > body > div",
    source: "declared",
    declaration: "#t",
    before,
    after,
    elapsedMs: 1501,
  } as const;
}
function live(
  entries: LivenessArtifact["entries"],
  config: ChecksConfig["liveness"] = declaration,
) {
  return livenessCheck.run({
    tuple: tuple(
      observation({
        liveness: {
          version: 1,
          status: "ran",
          declaration,
          diagnostics: [],
          entries,
        },
      }),
    ),
    narrowViewport: true,
    config: { ...checksConfigFrom(), liveness: config },
  });
}

describe("configuration", () => {
  test("omitted blocks stay disabled and {} enables defaults", () => {
    const omitted = checksConfigSchema.parse({});
    expect(omitted.touchReachability).toBeUndefined();
    expect(omitted.liveness).toBeUndefined();
    expect(checksConfigFrom(omitted).liveness).toBeUndefined();
    const enabled = checksConfigSchema.parse({
      touchReachability: {},
      liveness: {},
    });
    expect(checksConfigFrom(enabled)).toMatchObject({
      touchReachability: { ignore: [] },
      liveness: { selectors: [], auto: true, ignore: [] },
    });
    expect(
      checksConfigSchema.parse({ liveness: { selectors: [" #a "] } }).liveness
        ?.selectors,
    ).toEqual(["#a"]);
  });

  test("rejects blank, duplicate and unknown entries", () => {
    for (const liveness of [
      { selectors: [" "] },
      { selectors: ["#a", "#a"] },
      { every: 2 },
    ])
      expect(checksConfigSchema.safeParse({ liveness }).success).toBe(false);
    expect(
      checksConfigSchema.safeParse({ touchReachability: { ignore: [""] } })
        .success,
    ).toBe(false);
  });
});

describe("liveness policy", () => {
  test("all-zero takes priority, unchanged otherwise, changes pass", () => {
    expect(
      live([measured("0 days 0 hours", "0 days 0 hours")]).candidates.map(
        (c) => c.rule,
      ),
    ).toEqual(["idiom:liveness-all-zero"]);
    expect(
      live([measured("01:12:30", "01:12:30")]).candidates.map((c) => c.rule),
    ).toEqual(["idiom:liveness-unchanged"]);
    expect(
      live([measured("Sold out", "Sold out")]).candidates.map((c) => c.rule),
    ).toEqual(["idiom:liveness-unchanged"]);
    expect(live([measured("0:00:00:00", "1:23:45:10")]).candidates).toEqual([]);
  });

  test("fingerprints ignore values and timing", () => {
    const [a] = live([measured("0:00", "0:00")]).candidates;
    const [b] = live([
      { ...measured("1:00", "1:00"), elapsedMs: 1700 },
    ]).candidates;
    expect(a?.fingerprintHint).toBe(
      "html > body > div:idiom:liveness-all-zero",
    );
    expect(b?.fingerprintHint).toBe(
      "html > body > div:idiom:liveness-unchanged",
    );
  });

  test("absent config skips before evidence; stale or missing evidence is unavailable", () => {
    const old = { tuple: tuple(observation({})), narrowViewport: true };
    expect(
      livenessCheck.run({ ...old, config: checksConfigFrom() }).coverage.status,
    ).toBe("skipped");
    expect(
      livenessCheck.run({
        ...old,
        config: {
          ...checksConfigFrom(),
          liveness: { selectors: [], auto: false, ignore: [] },
        },
      }).coverage.status,
    ).toBe("skipped");
    expect(
      livenessCheck.run({
        ...old,
        config: { ...checksConfigFrom(), liveness: declaration },
      }).coverage,
    ).toMatchObject({ status: "unavailable", reason: /recapture/ });
    expect(
      live([measured("0:00", "0:00")], { ...declaration, selectors: ["#u"] })
        .coverage,
    ).toMatchObject({ status: "unavailable", reason: /changed/ });
  });

  test("unavailable entries disclose coverage without findings", () => {
    const result = live([
      {
        status: "unavailable",
        selector: "#t",
        identity: "x",
        source: "declared",
        reason: "target detached or replaced",
      },
    ]);
    expect(result.candidates).toEqual([]);
    expect(result.coverage).toMatchObject({
      status: "unavailable",
      reason: "#t: target detached or replaced",
    });
  });
});

describe("touch policy", () => {
  const entry = {
    selector: "html > body > button",
    identity: "html > body > button",
    name: "Preview",
    rect: { x: 0, y: 0, width: 80, height: 32 },
    owner: "html > body > article",
    baseline: { visibility: "hidden", opacity: 1 },
    cause: "visibility",
    hover: { status: "revealed" },
    focus: { status: "hidden" },
  } as const;
  const evidence = (entries: unknown[], restored = true) => ({
    touchReachability: {
      version: 1,
      status: "ran",
      declaration: { ignore: [] },
      diagnostics: [],
      eligible: entries.length,
      restored,
      entries,
    },
  });
  const run = (obs: unknown, enabled = true) =>
    touchReachabilityCheck.run({
      tuple: tuple(obs),
      narrowViewport: true,
      config: {
        ...checksConfigFrom(),
        touchReachability: enabled ? { ignore: [] } : undefined,
      },
    });

  test("reports hover-only actions anchored on the visible owner", () => {
    const [candidate] = run(observation(evidence([entry]))).candidates;
    expect(candidate).toMatchObject({
      rule: "idiom:touch-hover-only",
      selectorHint: entry.owner,
      fingerprintHint: `touch:${entry.identity}`,
      verification: { params: { control: entry.selector } },
    });
  });

  test("focus alternatives, unrevealed and unknown measurements do not emit", () => {
    expect(
      run(
        observation(
          evidence([
            { ...entry, focus: { status: "revealed", target: "x" } },
            { ...entry, hover: { status: "hidden" } },
          ]),
        ),
      ).candidates,
    ).toEqual([]);
    const unknown = run(
      observation(
        evidence([
          { ...entry, hover: { status: "unavailable", reason: "no settle" } },
        ]),
      ),
    );
    expect(unknown.candidates).toEqual([]);
    expect(unknown.coverage.status).toBe("unavailable");
    expect(run(observation(evidence([entry], false))).coverage.status).toBe(
      "unavailable",
    );
  });

  test("desktop, disabled and legacy captures skip or disclose", () => {
    expect(run(observation(evidence([entry])), false).coverage.status).toBe(
      "skipped",
    );
    expect(
      run(
        observation({
          ...evidence([entry]),
          input: { pointer: "coarse", hover: "hover", maxTouchPoints: 1 },
        }),
      ).coverage.status,
    ).toBe("skipped");
    expect(run(observation({})).coverage).toMatchObject({
      status: "unavailable",
      reason: /recapture/,
    });
  });

  test("evidence schema is strict and optional", () => {
    expect(
      observationArtifactSchema.safeParse(observation(evidence([entry])))
        .success,
    ).toBe(true);
    expect(observationArtifactSchema.safeParse(observation({})).success).toBe(
      true,
    );
    expect(
      observationArtifactSchema.safeParse(
        observation(
          evidence([
            { ...entry, baseline: { visibility: "hidden", opacity: 2 } },
          ]),
        ),
      ).success,
    ).toBe(false);
    expect(
      observationArtifactSchema.safeParse(
        observation(evidence([{ ...entry, extra: true }])),
      ).success,
    ).toBe(false);
  });
});

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  contentPatternStateId,
  isWebFlow,
  stateChainLabel,
} from "../src/schemas/flow.js";
import {
  decisionSchema,
  findingCategories,
  findingSchema,
  flowSchema,
  projectSchema,
} from "../src/schemas/index.js";

import {
  checksConfigSchema,
  productionSchema,
} from "../src/schemas/project.js";

const root = join(import.meta.dirname, "..");

async function json(path: string): Promise<unknown> {
  return JSON.parse(await readFile(join(root, path), "utf8"));
}

function minimalState(overrides: Record<string, unknown> = {}) {
  return {
    id: "home",
    description: "Home",
    url: "/?tz=America/New_York",
    expect: {},
    ...overrides,
  };
}

function minimalFlow(state = minimalState()) {
  return {
    id: "example",
    title: "Example",
    intent: ["The purpose is obvious."],
    setup: [],
    states: [state],
  };
}

describe("committed record examples", () => {
  test("all four record types validate", async () => {
    expect(
      projectSchema.parse(await json("examples/booking/.idiom/project.json")),
    ).toBeDefined();
    expect(
      flowSchema.parse(
        await json("examples/booking/.idiom/flows/booking.json"),
      ),
    ).toBeDefined();
    expect(
      findingSchema.parse(await json("examples/booking/records/finding.json")),
    ).toBeDefined();
    expect(
      decisionSchema.parse(
        await json("examples/booking/records/decision.json"),
      ),
    ).toBeDefined();
  });

  test("booking covers every required state and pins its timezone", async () => {
    const flow = flowSchema.parse(
      await json("examples/booking/.idiom/flows/booking.json"),
    );
    expect(flow.states.map((state) => state.id)).toEqual([
      "valid-known",
      "valid-anonymous",
      "confirmed",
      "taken",
      "expired",
      "withdrawn",
      "not-found",
      "error-name",
      "error-email-empty",
      "error-email-long",
      "error-email-invalid",
      "error-link",
      "error-calendar",
      "taken-race",
    ]);
    for (const state of flow.states) {
      const declaration = state.url ?? state.urlFrom?.append;
      expect(declaration, state.id).toContain("tz=America/New_York");
    }
  });
});

describe("schema behavior", () => {
  test("normalizes and validates the colour-scheme axis", async () => {
    const source = (await json(
      "examples/booking/.idiom/project.json",
    )) as Record<string, unknown>;
    const legacy = projectSchema.parse(source);
    expect(legacy.colorSchemes).toEqual(["light"]);

    const dark = projectSchema.parse({
      ...source,
      capture: { ...legacy.capture, colorScheme: "dark" },
    });
    expect(dark.colorSchemes).toEqual(["dark"]);
    expect(
      projectSchema.parse({
        ...source,
        colorSchemes: ["dark", "light"],
        capture: {
          ...legacy.capture,
          colorScheme: "dark",
          colorSchemeAttribute: "data-theme",
        },
      }).colorSchemes,
    ).toEqual(["dark", "light"]);

    for (const colorSchemes of [[], ["light", "light"], ["dark"]]) {
      expect(projectSchema.safeParse({ ...source, colorSchemes }).success).toBe(
        false,
      );
    }
    expect(
      projectSchema.safeParse({
        ...source,
        capture: { ...legacy.capture, colorSchemeAttribute: "bad name" },
      }).success,
    ).toBe(false);
    expect(
      flowSchema.safeParse({
        ...minimalFlow(),
        colorSchemes: ["dark", "light"],
      }).success,
    ).toBe(true);
    expect(
      flowSchema.safeParse({ ...minimalFlow(), colorSchemes: ["dark", "dark"] })
        .success,
    ).toBe(false);
  });

  test("accepts both critique providers and rejects unknown providers", async () => {
    const legacy = await json("examples/booking/.idiom/project.json");
    const anthropic = projectSchema.parse(legacy);
    expect(anthropic.model.provider).toBe("anthropic");
    expect(
      projectSchema.parse({
        ...(legacy as Record<string, unknown>),
        model: { ...anthropic.model, provider: "claude-code" },
      }).model.provider,
    ).toBe("claude-code");
    expect(
      projectSchema.safeParse({
        ...(legacy as Record<string, unknown>),
        model: { ...anthropic.model, provider: "unknown" },
      }).success,
    ).toBe(false);
  });

  test("applies defaults without mutating the input", () => {
    const input = minimalFlow();
    const original = structuredClone(input);
    const parsed = flowSchema.parse(input);
    expect(input).toEqual(original);
    expect(parsed.setup).toEqual([]);
    expect(parsed.target).toEqual({ kind: "web" });
    expect(parsed.states[0]?.expect).toEqual({
      status: 200,
      textPresent: [],
      selectorPresent: [],
      selectorAbsent: [],
    });
    expect(parsed.states[0]?.mask).toEqual([]);
  });

  test("validates and defaults the Electron target and action contract", () => {
    const parsed = flowSchema.parse({
      id: "desktop",
      title: "Desktop",
      intent: [],
      setup: [],
      target: {
        kind: "electron",
        launch: { executablePath: "node_modules/electron/dist/electron" },
        window: { title: "Capture Fixture" },
      },
      states: [
        {
          id: "settings",
          description: "Settings",
          steps: [
            { action: "click", selector: "#settings" },
            { action: "fill", selector: "#name", value: "Ada" },
            { action: "press", selector: "#name", key: "Enter" },
          ],
          expect: {},
        },
      ],
    });
    expect(parsed.target).toMatchObject({
      kind: "electron",
      launch: { args: [], env: {}, timeoutMs: 30_000 },
      window: { timeoutMs: 10_000 },
    });
    expect(parsed.states[0]?.expect).toEqual({
      textPresent: [],
      selectorPresent: [],
      selectorAbsent: [],
    });
    expect(parsed.states[0]?.expect.status).toBeUndefined();
  });

  test("states declare siblingGroup or a flow-scoped group, not both", () => {
    for (const fields of [{ siblingGroup: "left" }, { group: "panels" }])
      expect(
        flowSchema.parse(minimalFlow(minimalState(fields))).states[0],
      ).toMatchObject(fields);
    const both = flowSchema.safeParse(
      minimalFlow(minimalState({ siblingGroup: "left", group: "panels" })),
    );
    expect(both.success).toBe(false);
    // Web flows report through the target union; the web branch carries it.
    expect(JSON.stringify(both.error?.issues)).toContain(
      JSON.stringify({
        code: "custom",
        path: ["states", 0, "group"],
        message: "declare siblingGroup or group, not both",
      }),
    );
    const electron = flowSchema.safeParse({
      id: "example",
      title: "Example",
      intent: [],
      setup: [],
      states: [
        {
          id: "settings",
          description: "Settings",
          expect: {},
          siblingGroup: "left",
          group: "panels",
        },
      ],
      target: {
        kind: "electron",
        launch: { executablePath: "electron" },
        window: { title: "Capture" },
      },
    });
    expect(electron.error?.issues[0]?.path).toEqual(["states", 0, "group"]);
    const toggled = flowSchema.parse({
      ...minimalFlow(minimalState({ siblingGroup: "left" })),
      toggles: { drawer: { closed: [], open: [] } },
    });
    expect(
      toggled.states.map((state) => [state.id, state.siblingGroup]),
    ).toEqual([
      ["home", "left"],
      ["home.drawer-closed", "left"],
      ["home.drawer-open", "left"],
    ]);
  });

  test("strictly pairs target kinds with their state declarations", () => {
    const electron = {
      id: "example",
      title: "Example",
      intent: [],
      setup: [],
      states: [
        { id: "settings", description: "Settings", steps: [], expect: {} },
      ],
      target: {
        kind: "electron",
        launch: { executablePath: "electron" },
        window: { title: "Capture" },
      },
    };
    expect(flowSchema.safeParse(electron).success).toBe(true);
    expect(
      flowSchema.safeParse({
        ...electron,
        states: [{ ...electron.states[0], url: "/settings" }],
      }).success,
    ).toBe(false);
    expect(
      flowSchema.safeParse({
        ...electron,
        states: [{ ...electron.states[0], expect: { status: 200 } }],
      }).success,
    ).toBe(false);
    expect(
      flowSchema.safeParse({
        ...minimalFlow(),
        states: [
          {
            ...minimalState(),
            steps: [{ action: "click", selector: "#x" }],
          },
        ],
      }).success,
    ).toBe(true);
    expect(
      flowSchema.safeParse({
        ...electron,
        states: [
          {
            ...electron.states[0],
            steps: [{ action: "select", selector: "select", value: "x" }],
          },
        ],
      }).success,
    ).toBe(false);
    for (const target of [
      { kind: "electron", launch: {}, window: { title: "Capture" } },
      {
        kind: "electron",
        launch: { executablePath: "electron" },
        window: { title: "" },
      },
    ]) {
      expect(flowSchema.safeParse({ ...electron, target }).success).toBe(false);
    }
  });

  test("declared surfaces default empty, trim values, and require unique ids", async () => {
    const source = (await json(
      "examples/booking/.idiom/project.json",
    )) as Record<string, unknown>;
    const legacy = { ...source };
    delete legacy.surfaces;
    expect(projectSchema.parse(legacy).surfaces).toEqual([]);
    expect(
      projectSchema.parse({
        ...source,
        surfaces: [{ id: " recipient ", name: " Booking " }],
      }).surfaces,
    ).toEqual([{ id: "recipient", name: "Booking" }]);
    expect(
      projectSchema.safeParse({
        ...source,
        surfaces: [
          { id: "recipient", name: "Booking" },
          { id: "recipient", name: "Duplicate" },
        ],
      }).success,
    ).toBe(false);
    expect(
      flowSchema.parse({ ...minimalFlow(), surface: " recipient " }).surface,
    ).toBe("recipient");
  });

  test.each(findingCategories)(
    "accepts finding category %s",
    async (category) => {
      const finding = (await json(
        "examples/booking/records/finding.json",
      )) as Record<string, unknown>;
      expect(findingSchema.safeParse({ ...finding, category }).success).toBe(
        true,
      );
    },
  );

  test.each(["deterministic", "model"] as const)(
    "accepts layer %s",
    async (layer) => {
      const finding = (await json(
        "examples/booking/records/finding.json",
      )) as Record<string, unknown>;
      expect(
        findingSchema.safeParse({
          ...finding,
          layer,
          basis: undefined,
          basisDetails: undefined,
          acceptance: ["Historical criterion"],
        }).success,
      ).toBe(true);
    },
  );

  test.each(["blocker", "major", "minor"] as const)(
    "accepts severity %s",
    async (severity) => {
      const finding = (await json(
        "examples/booking/records/finding.json",
      )) as Record<string, unknown>;
      expect(findingSchema.safeParse({ ...finding, severity }).success).toBe(
        true,
      );
    },
  );

  test.each(["deterministic-check", "recapture-visual", "manual"] as const)(
    "accepts verification kind %s",
    async (kind) => {
      const finding = (await json(
        "test/fixtures/finding-contract/legacy.json",
      )) as Record<string, unknown>;
      const verification = { kind };
      expect(
        findingSchema.safeParse({ ...finding, verification }).success,
      ).toBe(true);
    },
  );

  test.each([
    "open",
    "approved",
    "rejected",
    "ticketed",
    "verified-fixed",
    "verify-failed",
  ])("accepts status %s", async (status) => {
    const finding = (await json(
      "examples/booking/records/finding.json",
    )) as Record<string, unknown>;
    expect(findingSchema.safeParse({ ...finding, status }).success).toBe(true);
  });

  test("requires exactly one URL declaration", () => {
    expect(
      flowSchema.safeParse(minimalFlow(minimalState({ urlFrom: undefined })))
        .success,
    ).toBe(true);
    expect(
      flowSchema.safeParse(
        minimalFlow(
          minimalState({
            urlFrom: { source: "setup-stdout", pattern: "url=(\\S+)" },
          }),
        ),
      ).success,
    ).toBe(false);
    const neither = minimalState();
    delete (neither as { url?: string }).url;
    expect(flowSchema.safeParse(minimalFlow(neither)).success).toBe(false);
  });

  test.each([
    ["one plain group", "url=(\\S+)", true],
    ["one named group", "url=(?<path>\\S+)", true],
    ["escaped parenthesis", "literal\\(x\\)-(\\S+)", true],
    ["character class", "[(](\\S+)", true],
    ["lookaround", "(?=url)url=(\\S+)(?:end)?", true],
    ["no group", "url=\\S+", false],
    ["two groups", "url=(\\S+)-(x)", false],
    ["invalid expression", "([", false],
  ])("checks regex capture groups: %s", (_label, pattern, valid) => {
    const state = minimalState({
      url: undefined,
      urlFrom: { source: "setup-stdout", pattern },
    });
    expect(flowSchema.safeParse(minimalFlow(state)).success).toBe(valid);
  });

  test("rejects unknown fields and out-of-range confidence", async () => {
    const finding = (await json(
      "examples/booking/records/finding.json",
    )) as Record<string, unknown>;
    expect(findingSchema.safeParse({ ...finding, typo: true }).success).toBe(
      false,
    );
    expect(
      findingSchema.safeParse({ ...finding, confidence: 1.01 }).success,
    ).toBe(false);
  });

  test("accepts optional artifact evidence and rejects empty artifact paths", async () => {
    const finding = (await json(
      "examples/booking/records/finding.json",
    )) as Record<string, unknown>;
    const evidence = finding.evidence as Record<string, unknown>;
    expect(
      findingSchema.safeParse({
        ...finding,
        evidence: {
          ...evidence,
          artifacts: ["state/mobile/metadata.json"],
        },
      }).success,
    ).toBe(true);
    expect(
      findingSchema.safeParse({
        ...finding,
        evidence: { ...evidence, artifacts: [""] },
      }).success,
    ).toBe(false);
    for (const path of [
      "../metadata.json",
      "/tmp/metadata.json",
      "C:\\metadata.json",
    ]) {
      expect(
        findingSchema.safeParse({
          ...finding,
          evidence: { ...evidence, artifacts: [path] },
        }).success,
      ).toBe(false);
    }
  });

  test("keeps historical findings valid and accepts nonblank reference citations", async () => {
    const finding = (await json(
      "examples/booking/records/finding.json",
    )) as Record<string, unknown>;
    const evidence = finding.evidence as Record<string, unknown>;
    expect(findingSchema.safeParse(finding).success).toBe(true);
    expect(
      findingSchema.safeParse({
        ...finding,
        evidence: {
          ...evidence,
          references: [
            "reference:editorial-density",
            "anti-reference:booking-widget",
          ],
        },
      }).success,
    ).toBe(true);
    expect(
      findingSchema.safeParse({
        ...finding,
        evidence: { ...evidence, references: [""] },
      }).success,
    ).toBe(false);
  });

  test.each(["nextjs", "other"] as const)(
    "accepts project framework %s",
    async (framework) => {
      const project = (await json(
        "examples/booking/.idiom/project.json",
      )) as Record<string, unknown>;
      const app = { ...(project.app as Record<string, unknown>), framework };
      expect(projectSchema.safeParse({ ...project, app }).success).toBe(true);
    },
  );

  test.each(["light", "dark"] as const)(
    "accepts capture color scheme %s",
    async (colorScheme) => {
      const project = (await json(
        "examples/booking/.idiom/project.json",
      )) as Record<string, unknown>;
      const capture = {
        ...(project.capture as Record<string, unknown>),
        colorScheme,
      };
      expect(projectSchema.safeParse({ ...project, capture }).success).toBe(
        true,
      );
    },
  );

  test.each([
    [1, true],
    [5, true],
    [0, false],
    [6, false],
    [2.5, false],
  ])(
    "constrains model.maxFindings %s to an integer from one through five",
    async (maxFindings, valid) => {
      const project = (await json(
        "examples/booking/.idiom/project.json",
      )) as Record<string, unknown>;
      const model = {
        ...(project.model as Record<string, unknown>),
        maxFindings,
      };
      expect(projectSchema.safeParse({ ...project, model }).success).toBe(
        valid,
      );
    },
  );

  test.each([
    ["accept", "instance"],
    ["accept", "rule"],
    ["reject", "instance"],
    ["reject", "rule"],
  ] as const)("accepts decision %s with %s scope", async (decision, scope) => {
    const record = (await json(
      "examples/booking/records/decision.json",
    )) as Record<string, unknown>;
    expect(
      decisionSchema.safeParse({ ...record, decision, scope }).success,
    ).toBe(true);
  });
});

describe("web interaction contracts", () => {
  const actions = [
    { action: "click", selector: "#open" },
    { action: "fill", selector: "input", value: "" },
    { action: "press", selector: "input", key: "Enter" },
    { action: "select", selector: "select", value: "" },
    { action: "select", selector: "select", label: "Template" },
    { action: "waitFor", selector: "#editor" },
    { action: "waitFor", selector: "#loading", state: "hidden" },
    { action: "expectUrl", path: "/editor" },
    { action: "expectUrl", pattern: "/editor[?]id=" },
    { action: "expectText", text: "Created" },
  ];
  test("accepts every web action and defaults legacy and route states", () => {
    const flow = flowSchema.parse({
      ...minimalFlow(minimalState({ steps: actions })),
      routes: ["/plain"],
    });
    expect(flow.states[0]?.steps).toHaveLength(actions.length);
    expect(flow.states[0]?.steps[5]).toMatchObject({ state: "visible" });
    expect(flow.states[1]).toMatchObject({
      steps: [],
      health: { allow: { urls: [], console: [] } },
    });
    expect(flowSchema.parse(minimalFlow()).states[0]?.steps).toEqual([]);
  });
  test.each([
    { action: "click", selector: " " },
    { action: "fill", selector: "input" },
    { action: "press", selector: "input", key: " " },
    { action: "select", selector: "select" },
    { action: "select", selector: "select", value: "x", label: "X" },
    { action: "select", selector: "select", label: " " },
    { action: "waitFor", selector: "main", state: "attached" },
    { action: "expectUrl" },
    { action: "expectUrl", path: "/x", pattern: "x" },
    { action: "expectUrl", path: "/x?q=1" },
    { action: "expectUrl", path: "x" },
    { action: "expectUrl", pattern: "[" },
    { action: "expectText", text: " " },
    { action: "click", selector: "button", extra: true },
  ])("rejects invalid action %j", (step) => {
    expect(
      flowSchema.safeParse(minimalFlow(minimalState({ steps: [step] })))
        .success,
    ).toBe(false);
  });
  test("accepts strict health configuration on flows and states", () => {
    const flow = flowSchema.parse({
      ...minimalFlow(
        minimalState({
          health: { allow: { urls: ["/404$"], console: ["expected"] } },
        }),
      ),
      health: {
        allow: { urls: ["/background"], console: ["known"] },
        serverLog: "logs/server.log",
        serverErrorPatterns: ["FAIL"],
      },
    });
    expect(flow).toMatchObject({
      health: { serverLog: "logs/server.log", serverErrorPatterns: ["FAIL"] },
    });
  });
  test.each([
    { allow: { urls: ["["] } },
    { allow: { console: [" "] } },
    { allow: { globs: [] } },
    { serverLog: "../outside.log" },
    { serverLog: "/tmp/server.log" },
    { serverLog: "C:\\server.log" },
    { serverLog: "logs/../../server.log" },
    { serverLog: "..\\server.log" },
    { serverLog: " " },
    { serverErrorPatterns: ["["] },
    { unknown: true },
  ])("rejects invalid health %j", (health) => {
    expect(flowSchema.safeParse({ ...minimalFlow(), health }).success).toBe(
      false,
    );
  });
  test("state health cannot configure server log", () => {
    expect(
      flowSchema.safeParse(
        minimalFlow(minimalState({ health: { serverLog: "server.log" } })),
      ).success,
    ).toBe(false);
  });
});

test("production config is optional, strict, and limited to contained output paths", async () => {
  const project = (await json(
    "examples/booking/.idiom/project.json",
  )) as Record<string, unknown> & { server: Record<string, unknown> };
  const production = { build: "next build", start: "next start", env: {} };
  expect(projectSchema.parse(project).server.production).toBeUndefined();
  expect(
    projectSchema.parse({
      ...project,
      server: { ...project.server, production },
    }).server.production,
  ).toEqual({ ...production, reuseBuild: false });
  for (const distDir of [
    "..",
    ".",
    "../out",
    "/tmp/out",
    "nested/../../out",
    "C:\\out",
    "nested\\out",
    ".git/output",
    ".idiom/reports",
    "",
  ]) {
    expect(
      projectSchema.safeParse({
        ...project,
        server: { ...project.server, production: { ...production, distDir } },
      }).success,
      distDir,
    ).toBe(false);
  }
  for (const invalid of [
    { ...production, build: " " },
    { ...production, start: "" },
    { ...production, typo: true },
  ]) {
    expect(
      projectSchema.safeParse({
        ...project,
        server: { ...project.server, production: invalid },
      }).success,
    ).toBe(false);
  }
  expect(
    projectSchema.parse({
      ...project,
      server: {
        ...project.server,
        production: { ...production, distDir: "app/.next" },
      },
    }).server.production?.distDir,
  ).toBe("app/.next");
});

test("production flow selection is web only", () => {
  expect(
    flowSchema.parse({ ...minimalFlow(), server: "production" }),
  ).toMatchObject({ server: "production", target: { kind: "web" } });
  expect(
    flowSchema.safeParse({ ...minimalFlow(), server: "dev" }).success,
  ).toBe(false);
  expect(
    flowSchema.safeParse({
      ...minimalFlow(),
      server: "production",
      target: {
        kind: "electron",
        launch: { executablePath: "electron" },
        window: { title: "App" },
      },
      states: [],
    }).success,
  ).toBe(false);
});

// Layout assertions are opt-in, with the same contract in flow and state scopes.
test("layout invariant examples and additive web, route and Electron scopes", async () => {
  const { invariantSchema, effectiveInvariants, parseInvariantEdge } =
    await import("../src/schemas/invariant.js");
  const examples = [
    { selector: ".ed-controls", height: 64 },
    { selector: ".panel", width: { min: 280, max: 480 } },
    {
      align: "bottom",
      selectors: [".drawer-head", ".ed-controls", ".inspector-head"],
      tolerance: 0,
    },
    { edge: ".canvas:top", equals: ".ed-controls:bottom", offset: 16 },
  ];
  for (const value of examples)
    expect(invariantSchema.safeParse(value).success).toBe(true);
  expect(parseInvariantEdge(".canvas:not(.hidden):top")).toEqual({
    selector: ".canvas:not(.hidden)",
    edge: "top",
  });
  const web = flowSchema.parse({
    id: "web",
    title: "Web",
    setup: [],
    intent: [],
    invariants: examples,
    states: [
      {
        id: "ready",
        description: "Ready",
        url: "/",
        expect: {},
        invariants: [{ selector: ".local", width: 20 }],
      },
    ],
    routes: ["/extra"],
  });
  const ready = web.states[0];
  const route = web.states[1];
  if (!ready || !route) throw new Error("missing states");
  expect(effectiveInvariants(web, ready)).toHaveLength(5);
  expect(effectiveInvariants(web, route)).toHaveLength(4);
  expect(effectiveInvariants(web, { ...ready, invariants: [] })).toHaveLength(
    4,
  );
  const electron = flowSchema.parse({
    id: "desktop",
    title: "Desktop",
    setup: [],
    intent: [],
    invariants: examples,
    target: {
      kind: "electron",
      launch: { executablePath: "electron" },
      window: { title: "Editor" },
    },
    states: [
      {
        id: "ready",
        description: "Ready",
        expect: {},
        invariants: [{ selector: ".local", width: 20 }],
      },
    ],
  });
  const electronState = electron.states[0];
  if (!electronState) throw new Error("missing Electron state");
  expect(effectiveInvariants(electron, electronState)).toHaveLength(5);
});

test("layout invariant schema rejects invalid constraints and mixed variants", async () => {
  const { invariantSchema } = await import("../src/schemas/invariant.js");
  const invalid = [
    { selector: " ", height: 64 },
    { selector: ".a" },
    { selector: ".a", height: -1 },
    { selector: ".a", width: Infinity },
    { selector: ".a", height: NaN },
    { selector: ".a", width: { min: 10, max: 5 } },
    { selector: ".a", height: { min: -1, max: 5 } },
    { selector: ".a", height: 64, tolerance: -1 },
    { selector: ".a", height: 64, tolerance: Infinity },
    { selector: ".a", height: 64, name: " " },
    { selector: ".a", height: 64, optional: "yes" },
    { align: "bottom", selectors: [".a"] },
    { align: "bottom", selectors: [".a", ".a"] },
    { align: "top", selectors: [".a", " "] },
    { align: "center", selectors: [".a", ".b"] },
    { align: "top", selectors: [".a", ".b"], height: 64 },
    { edge: ".a:middle", equals: ".b:top", offset: 0 },
    { edge: ":top", equals: ".b:top", offset: 0 },
    { edge: ".a:left", equals: ".b:top", offset: 0 },
    { edge: ".a:top", equals: ".b:bottom", offset: Infinity },
    {
      edge: ".a:top",
      equals: ".b:bottom",
      offset: 0,
      selector: ".a",
      height: 64,
    },
  ];
  for (const value of invalid)
    expect(
      invariantSchema.safeParse(value).success,
      JSON.stringify(value),
    ).toBe(false);
  expect(
    invariantSchema.parse({ edge: ".a:right", equals: ".b:left", offset: -10 }),
  ).toMatchObject({ offset: -10 });
});

test("group invariants parse attribute and text modes and reject mixed shapes (#41)", async () => {
  const { invariantSchema, invariantSelectors } = await import(
    "../src/schemas/invariant.js"
  );
  const attribute = invariantSchema.parse({
    name: "page switcher",
    group: ".page-switcher",
    items: ".page-link",
    attribute: "data-project-id",
  });
  expect(attribute).toEqual({
    name: "page switcher",
    optional: false,
    group: ".page-switcher",
    items: ".page-link",
    attribute: "data-project-id",
  });
  expect(invariantSelectors(attribute)).toEqual([".page-switcher"]);
  const text = invariantSchema.parse({
    group: ".page-switcher",
    items: "a",
    owner: ".project-title",
    text: "^(\\S+)",
  });
  expect(invariantSelectors(text)).toEqual([
    ".page-switcher",
    ".project-title",
  ]);
  const invalid = [
    { group: ".g", items: "a" },
    { group: ".g", items: "a", attribute: "data-id", text: "x" },
    { group: ".g", items: "a", text: "(" },
    { group: ".g", items: "a", attribute: "data-id", tolerance: 0 },
    { group: " ", items: "a", attribute: "data-id" },
    { group: ".g", items: " ", attribute: "data-id" },
    {
      group: ".g",
      items: "a",
      attribute: "data-id",
      selector: ".g",
      height: 1,
    },
  ];
  for (const value of invalid)
    expect(
      invariantSchema.safeParse(value).success,
      JSON.stringify(value),
    ).toBe(false);
});

test("states may be declared fresh on web and Electron flows (#33)", () => {
  const web = flowSchema.parse(minimalFlow(minimalState({ fresh: true })));
  expect(web.states[0]?.fresh).toBe(true);
  expect(
    flowSchema.safeParse(minimalFlow(minimalState({ fresh: "yes" }))).success,
  ).toBe(false);
  const electron = flowSchema.parse({
    id: "desktop",
    title: "Desktop",
    setup: [],
    intent: [],
    target: {
      kind: "electron",
      launch: { executablePath: "electron" },
      window: { title: "Editor" },
    },
    states: [{ id: "ready", description: "Ready", expect: {}, fresh: true }],
  });
  expect(electron.states[0]?.fresh).toBe(true);
});

test("disguised-control and fresh-state configuration parses, defaults and validates (#33)", async () => {
  const { checksConfigSchema, checkMarks, defaultChecksSettings } =
    await import("../src/schemas/project.js");
  expect(defaultChecksSettings.disguisedControl).toEqual({
    placeholderPatterns: [],
    ignore: [],
  });
  expect(defaultChecksSettings.freshState).toEqual({
    historyNames: [],
    historySelectors: [],
    unsavedPatterns: [],
    unsavedSelectors: [],
  });
  const parsed = checksConfigSchema.parse({
    disguisedControl: {
      placeholderPatterns: ["^Ask Builder\\b"],
      ignore: [".cmdk-trigger"],
    },
    freshState: {
      historyNames: ["^revert\\b"],
      historySelectors: ["[data-history]"],
      unsavedPatterns: ["\\bdraft not saved\\b"],
      unsavedSelectors: [".dirty-dot"],
    },
  });
  expect(checkMarks(parsed)).toEqual([
    { purpose: "history", selector: "[data-history]" },
    { purpose: "unsaved", selector: ".dirty-dot" },
    { purpose: "disguised-ignore", selector: ".cmdk-trigger" },
  ]);
  for (const invalid of [
    { disguisedControl: { placeholderPatterns: ["(unclosed"] } },
    { freshState: { historyNames: ["["] } },
    { freshState: { unsavedSelectors: [" "] } },
    { freshState: { extra: true } },
  ])
    expect(checksConfigSchema.safeParse(invalid).success).toBe(false);
});

test("observation artifacts load with and without fresh and selector marks (#33)", async () => {
  const { observationArtifactSchema } = await import(
    "../src/checks/artifact-schema.js"
  );
  const artifact = {
    version: 2,
    viewport: { width: 1440, height: 900 },
    document: {
      scrollWidth: 1440,
      scrollHeight: 900,
      clientWidth: 1440,
      clientHeight: 900,
    },
    elements: [],
    headings: [],
    tokens: { status: "not-configured" },
    maskMembership: [],
  };
  expect(observationArtifactSchema.safeParse(artifact).success).toBe(true);
  const marked = {
    ...artifact,
    fresh: true,
    selectorMarks: [
      { purpose: "history", selector: "[data-history]", matches: ["#undo"] },
    ],
  };
  expect(observationArtifactSchema.parse(marked)).toEqual(marked);
  expect(
    observationArtifactSchema.safeParse({
      ...artifact,
      selectorMarks: [{ purpose: "other", selector: "a", matches: [] }],
    }).success,
  ).toBe(false);
});

test("mirrored pairs validate, default their axis and deduplicate capture selectors (#24)", async () => {
  const { checksConfigSchema, checkMarks } = await import(
    "../src/schemas/project.js"
  );
  const pair = { name: "collapse", a: "#left", b: "#right" };
  expect(checksConfigSchema.parse({}).mirrored).toEqual([]);
  const parsed = checksConfigSchema.parse({
    mirrored: [
      pair,
      { ...pair, name: "shared", b: "#other", axis: "horizontal" },
    ],
  });
  expect(parsed.mirrored[0]).toEqual({ ...pair, axis: "vertical" });
  expect(checkMarks(parsed)).toEqual(
    ["#left", "#right", "#other"].map((selector) => ({
      purpose: "mirrored",
      selector,
    })),
  );
  for (const invalid of [
    { ...pair, name: " " },
    { ...pair, a: " " },
    { ...pair, b: "" },
    { ...pair, b: " #left " },
    { ...pair, axis: "diagonal" },
    { ...pair, panel: "#panel" },
  ])
    expect(checksConfigSchema.safeParse({ mirrored: [invalid] }).success).toBe(
      false,
    );
});

test("mirrored capture marks round-trip while legacy artifacts still load (#24)", async () => {
  const { observationArtifactSchema } = await import(
    "../src/checks/artifact-schema.js"
  );
  const artifact = {
    version: 2,
    viewport: { width: 1440, height: 900 },
    document: {
      scrollWidth: 1440,
      scrollHeight: 900,
      clientWidth: 1440,
      clientHeight: 900,
    },
    elements: [],
    headings: [],
    tokens: { status: "not-configured" },
    maskMembership: [],
  };
  expect(observationArtifactSchema.parse(artifact)).toEqual(artifact);
  const marked = {
    ...artifact,
    selectorMarks: [
      { purpose: "mirrored", selector: "#left", matches: ["#left"] },
    ],
  };
  expect(observationArtifactSchema.parse(marked)).toEqual(marked);
});

test("checks.scales defaults, validates and resolves role selectors at capture (#17)", async () => {
  const { checksConfigSchema, checkMarks, defaultChecksSettings } =
    await import("../src/schemas/project.js");
  expect(defaultChecksSettings.scales).toEqual({
    spacing: [],
    controlHeights: [],
    radius: { control: [], card: [], panel: [], chip: [] },
    border: { divider: [], control: [] },
    roles: { control: [], card: [], panel: [], chip: [], divider: [] },
    suggestAfter: 5,
  });
  const parsed = checksConfigSchema.parse({
    scales: {
      controlHeights: [28, 32, 40],
      radius: { control: [6], chip: ["full"] },
      border: { divider: ["#E5E7EB", "rgba(0, 0, 0, 0.1)"] },
      roles: { chip: [".tag", ".tag"], divider: ["[role=separator]"] },
    },
  });
  expect(parsed.scales.radius).toEqual({
    control: [6],
    card: [],
    panel: [],
    chip: ["full"],
  });
  expect(checkMarks(parsed)).toEqual([
    { purpose: "scale-chip", selector: ".tag" },
    { purpose: "scale-divider", selector: "[role=separator]" },
  ]);
  for (const invalid of [
    { controlHeights: [-28] },
    { controlHeights: [0] },
    { radius: { control: [-1] } },
    { radius: { control: ["pill"] } },
    { radius: { button: [6] } },
    { border: { divider: ["light grey"] } },
    { border: { divider: ["#12345"] } },
    { roles: { chip: [" "] } },
    { spacing: [-4, 8] },
  ])
    expect(checksConfigSchema.safeParse({ scales: invalid }).success).toBe(
      false,
    );
});

test("checks.primaryRegion, alarm and naming default, validate and resolve at capture (#18, #21, #19)", async () => {
  const { checksConfigSchema, checkMarks, defaultChecksSettings } =
    await import("../src/schemas/project.js");
  expect(defaultChecksSettings.primaryRegion).toBeUndefined();
  expect(defaultChecksSettings.alarm).toEqual({
    colors: [],
    brand: [],
    ignore: [],
  });
  expect(defaultChecksSettings.naming).toEqual({ surfaces: {} });
  const parsed = checksConfigSchema.parse({
    mirrored: [{ name: "rails", a: "#left", b: "#right" }],
    primaryRegion: { selector: "main.frame", minShare: { desktop: 0.65 } },
    alarm: {
      colors: ["#f59e0b"],
      brand: ["rgb(37, 99, 235)"],
      ignore: [".star", ".star"],
    },
    naming: {
      surfaces: { tree: "#tree", breadcrumb: "#crumbs", chip: "#tree" },
    },
  });
  expect(checkMarks(parsed)).toEqual([
    { purpose: "mirrored", selector: "#left" },
    { purpose: "mirrored", selector: "#right" },
    { purpose: "primary-region", selector: "main.frame" },
    { purpose: "alarm-ignore", selector: ".star" },
    { purpose: "naming", selector: "#tree" },
    { purpose: "naming", selector: "#crumbs" },
  ]);
  for (const invalid of [
    { primaryRegion: { selector: "main", minShare: 0 } },
    { primaryRegion: { selector: "main", minShare: 1.2 } },
    { primaryRegion: { selector: "main", minShare: {} } },
    { primaryRegion: { selector: " ", minShare: 0.5 } },
    { primaryRegion: { minShare: 0.5 } },
    { alarm: { colors: ["orange"] } },
    { alarm: { brand: ["#12345"] } },
    { naming: { surfaces: { tree: "#tree" } } },
    { naming: { surfaces: { tree: "", chip: "#chip" } } },
  ])
    expect(checksConfigSchema.safeParse(invalid).success).toBe(false);
});

test("longRunning is optional on web mutation steps only", async () => {
  const { webStepSchema } = await import("../src/schemas/flow.js");
  for (const step of [
    { action: "click", selector: "#go" },
    { action: "fill", selector: "#input", value: "hello" },
    { action: "press", selector: "#input", key: "Enter" },
    { action: "select", selector: "#option", value: "one" },
  ])
    expect(webStepSchema.parse({ ...step, longRunning: true })).toMatchObject({
      longRunning: true,
    });
  for (const step of [
    { action: "waitFor", selector: "#ready" },
    { action: "expectUrl", path: "/ready" },
    { action: "expectText", text: "Ready" },
  ])
    expect(
      webStepSchema.safeParse({ ...step, longRunning: true }).success,
    ).toBe(false);
});

test("empty-state and progress settings have strict optional defaults", async () => {
  const { checksConfigSchema } = await import("../src/schemas/project.js");
  expect(checksConfigSchema.parse({})).toMatchObject({
    progressWithinMs: 1000,
    emptyState: { regions: [], auto: true, ignore: [] },
  });
  for (const progressWithinMs of [0, -1, 1.5])
    expect(checksConfigSchema.safeParse({ progressWithinMs }).success).toBe(
      false,
    );
  for (const emptyState of [
    { regions: [{ selector: "main" }] },
    { unknown: true },
    { regions: [{ selector: "main", items: ".block", unknown: true }] },
  ])
    expect(checksConfigSchema.safeParse({ emptyState }).success).toBe(false);
});

test("probe results round-trip region and primary while older results still load (#51, #63)", async () => {
  const { observationArtifactSchema } = await import(
    "../src/checks/artifact-schema.js"
  );
  const artifact = {
    version: 2,
    viewport: { width: 1440, height: 900 },
    document: {
      scrollWidth: 1440,
      scrollHeight: 900,
      clientWidth: 1440,
      clientHeight: 900,
    },
    elements: [],
    headings: [],
    tokens: { status: "not-configured" },
    maskMembership: [],
  };
  const legacy = {
    selector: "#gear",
    name: "Page settings",
    effects: ["dom"],
    signature: "open:aside:Page settings",
    persistent: true,
  };
  const probed = {
    ...artifact,
    probe: {
      status: "ran",
      results: [
        legacy,
        {
          ...legacy,
          selector: "#tool-gear",
          region: 'toolbar "Tools"',
          primary: true,
        },
      ],
    },
  };
  expect(observationArtifactSchema.parse(probed)).toEqual(probed);
  expect(
    observationArtifactSchema.safeParse({
      ...artifact,
      probe: { status: "ran", results: [{ ...legacy, primary: "yes" }] },
    }).success,
  ).toBe(false);
});

test("control intent configuration is optional, boolean and disabled by default (#54)", async () => {
  const { checksConfigSchema } = await import("../src/schemas/project.js");
  expect(checksConfigSchema.parse({}).probe.respectControlIntent).toBe(false);
  expect(checksConfigSchema.parse({}).probe.enabled).toBe(true);
  expect(
    checksConfigSchema.parse({ probe: {} }).probe.respectControlIntent,
  ).toBe(false);
  for (const respectControlIntent of [true, false])
    expect(
      checksConfigSchema.parse({ probe: { respectControlIntent } }).probe,
    ).toMatchObject({ enabled: true, respectControlIntent });
  for (const respectControlIntent of ["true", 1, null, {}])
    expect(
      checksConfigSchema.safeParse({ probe: { respectControlIntent } }).success,
    ).toBe(false);
});

test("strict v2 probe artifacts accept chooser/picker effects and selected skips (#54)", async () => {
  const { observationArtifactSchema } = await import(
    "../src/checks/artifact-schema.js"
  );
  const artifact = {
    version: 2,
    viewport: { width: 800, height: 600 },
    document: {
      scrollWidth: 800,
      scrollHeight: 600,
      clientWidth: 800,
      clientHeight: 600,
    },
    elements: [],
    headings: [],
    tokens: { status: "not-configured" },
    maskMembership: [],
    probe: {
      status: "ran",
      results: [
        {
          selector: "#selected",
          name: "Light",
          effects: [],
          skipped: "already selected: aria-pressed",
          persistent: true,
        },
        {
          selector: "#upload",
          name: "Upload image",
          effects: ["filechooser"],
          primary: true,
          persistent: true,
        },
        {
          selector: "#date",
          name: "Choose date",
          effects: ["picker"],
          primary: true,
          persistent: true,
        },
        {
          selector: "#legacy",
          name: "Old result",
          effects: ["focus"],
          persistent: true,
        },
      ],
    },
  };
  expect(observationArtifactSchema.parse(artifact)).toEqual(artifact);
  expect(
    observationArtifactSchema.safeParse({
      ...artifact,
      probe: {
        status: "ran",
        results: [
          { ...artifact.probe.results[0], effects: ["invented-picker"] },
        ],
      },
    }).success,
  ).toBe(false);
  const { probe: _, maskMembership: __, ...legacy } = artifact;
  expect(
    observationArtifactSchema.parse({ ...legacy, version: 1 }).version,
  ).toBe(1);
});

test("visible explanation configuration defaults, validates and reaches checks", async () => {
  const { checksConfigSchema } = await import("../src/schemas/project.js");
  const { checksConfigFrom } = await import("../src/checks/registry.js");
  expect(checksConfigSchema.parse({}).explanation).toBe("default");
  expect(checksConfigFrom().explanation).toBe("default");
  expect(
    checksConfigFrom(checksConfigSchema.parse({ explanation: "visible" }))
      .explanation,
  ).toBe("visible");
  expect(checksConfigSchema.safeParse({ explanation: "title" }).success).toBe(
    false,
  );
});

test("explanation evidence round-trips strictly while legacy v1/v2 omit it", async () => {
  const { explanationArtifactSchema, observationArtifactSchema } = await import(
    "../src/checks/artifact-schema.js"
  );
  const { emptyObservation } = await import("./motion-support.js");
  const record = {
    selector: "#help",
    controlId: "document:node",
    trigger: "focus",
    source: "capture",
    status: "observed",
    tooltips: [{ selector: "#tip", text: "Help topics" }],
  };
  const explanations = { version: 1, status: "ran", records: [record] };
  const artifact = { ...emptyObservation, explanations };
  expect(
    observationArtifactSchema.parse(JSON.parse(JSON.stringify(artifact))),
  ).toEqual(artifact);
  expect(observationArtifactSchema.parse(emptyObservation)).toEqual(
    emptyObservation,
  );
  const { maskMembership: _, ...legacy } = emptyObservation;
  expect(
    observationArtifactSchema.safeParse({ ...legacy, version: 1 }).success,
  ).toBe(true);
  for (const invalid of [
    { ...explanations, unknown: true },
    { ...explanations, version: 2 },
    { ...explanations, status: "partial" },
    { ...explanations, records: [{ ...record, trigger: "click" }] },
    { ...explanations, records: [{ ...record, controlId: 12 }] },
    { ...explanations, records: [{ ...record, controlId: "" }] },
    { ...explanations, records: [{ ...record, tooltips: [] }] },
    {
      ...explanations,
      records: [{ ...record, tooltips: [{ selector: "#tip", text: " " }] }],
    },
    { ...explanations, records: [{ ...record, status: "absent" }] },
    {
      ...explanations,
      records: [{ ...record, status: "unavailable", tooltips: [] }],
    },
    { ...explanations, records: [{ ...record, unknown: true }] },
  ])
    expect(explanationArtifactSchema.safeParse(invalid).success).toBe(false);
});

describe("component tolerance normalization (#56)", () => {
  test.each([
    {
      name: "omitted",
      input: {},
      expected: { ratio: 0.15, px: 1, mode: "tighter" },
    },
    {
      name: "empty object",
      input: { tolerance: {} },
      expected: { ratio: 0.25, px: 4, mode: "looser" },
    },
    {
      name: "ratio only",
      input: { tolerance: { ratio: 0.1 } },
      expected: { ratio: 0.1, px: 4, mode: "looser" },
    },
    {
      name: "pixels only",
      input: { tolerance: { px: 2 } },
      expected: { ratio: 0.25, px: 2, mode: "looser" },
    },
    {
      name: "both numbers",
      input: { tolerance: { ratio: 0.1, px: 2 } },
      expected: { ratio: 0.1, px: 2, mode: "looser" },
    },
    {
      name: "explicit looser",
      input: { tolerance: { mode: "looser" } },
      expected: { ratio: 0.25, px: 4, mode: "looser" },
    },
    {
      name: "tighter only",
      input: { tolerance: { mode: "tighter" } },
      expected: { ratio: 0.25, px: 4, mode: "tighter" },
    },
    {
      name: "custom tighter",
      input: { tolerance: { ratio: 0.1, px: 2, mode: "tighter" } },
      expected: { ratio: 0.1, px: 2, mode: "tighter" },
    },
  ])("$name", async ({ input, expected }) => {
    const { checksConfigSchema } = await import("../src/schemas/project.js");
    const parsed = checksConfigSchema.parse({
      components: [
        { name: "dot", selector: ".dot", width: 8, height: 8, ...input },
      ],
    });
    expect(parsed.components[0]?.tolerance).toEqual(expected);
    expect(checksConfigSchema.parse(parsed)).toEqual(parsed);
  });

  test.each([
    { mode: "closest" },
    { extra: true },
    { ratio: -0.1 },
    { px: -1 },
    null,
  ])("rejects invalid tolerance %j", async (tolerance) => {
    const { checksConfigSchema } = await import("../src/schemas/project.js");
    expect(
      checksConfigSchema.safeParse({
        components: [
          { name: "dot", selector: ".dot", width: 8, height: 8, tolerance },
        ],
      }).success,
    ).toBe(false);
  });

  test("v2 artifacts preserve optional mode without defaulting historical observations", async () => {
    const { observationArtifactSchema } = await import(
      "../src/checks/artifact-schema.js"
    );
    const artifact = {
      version: 2,
      viewport: { width: 320, height: 600 },
      document: {
        scrollWidth: 320,
        scrollHeight: 600,
        clientWidth: 320,
        clientHeight: 600,
      },
      elements: [],
      headings: [],
      tokens: { status: "not-configured" },
      maskMembership: [],
    };
    const withTolerance = (tolerance: unknown) => ({
      ...artifact,
      components: [
        {
          name: "dot",
          selector: ".dot",
          width: 8,
          height: 8,
          tolerance,
          rects: [],
        },
      ],
    });
    for (const mode of [undefined, "tighter", "looser"]) {
      const value = withTolerance({
        ratio: 0.25,
        px: 4,
        ...(mode === undefined ? {} : { mode }),
      });
      expect(observationArtifactSchema.parse(value)).toEqual(value);
    }
    for (const tolerance of [
      { ratio: 0.25, px: 4, mode: "closest" },
      { ratio: 0.25, px: 4, extra: true },
      { ratio: -1, px: 4 },
      { ratio: 0.25, px: -1 },
    ]) {
      expect(
        observationArtifactSchema.safeParse(withTolerance(tolerance)).success,
      ).toBe(false);
    }
  });
});

test("probe placement and production reuse are optional strict booleans", () => {
  for (const everywhere of [false, true])
    expect(
      checksConfigSchema.parse({ probe: { everywhere } }).probe.everywhere,
    ).toBe(everywhere);
  expect(checksConfigSchema.parse({}).probe.everywhere).toBe(false);
  expect(
    checksConfigSchema.safeParse({ probe: { everywhere: "true" } }).success,
  ).toBe(false);
  for (const reuseBuild of [false, true])
    expect(
      productionSchema.parse({ build: "build", start: "start", reuseBuild })
        .reuseBuild,
    ).toBe(reuseBuild);
  expect(
    productionSchema.safeParse({
      build: "build",
      start: "start",
      reuseBuild: "true",
    }).success,
  ).toBe(false);
});

describe("states reached from another state (#57)", () => {
  const empty = minimalState({
    id: "empty",
    url: "/editor",
    steps: [{ action: "click", selector: "#history" }],
    health: { allow: { urls: ["/analytics"] } },
  });
  const versions = {
    id: "versions",
    description: "Versions panel",
    from: "empty",
    steps: [{ action: "click", selector: "#tab-versions" }],
    health: { allow: { console: ["deprecated"] } },
    expect: {},
  };
  const parse = (states: unknown[], extra: Record<string, unknown> = {}) =>
    flowSchema.safeParse({ ...minimalFlow(), states, ...extra });
  const issues = (states: unknown[], extra: Record<string, unknown> = {}) => {
    const result = parse(states, extra);
    if (result.success) throw Error("expected a validation failure");
    // The web branch of the flow union carries the actionable issues.
    return result.error.issues
      .flatMap((issue) =>
        issue.code === "invalid_union" ? (issue.errors[1] ?? []) : [issue],
      )
      .map(({ path, message }) => ({ path, message }));
  };

  test("flattens the root URL, ancestor steps first, and merged allow rules", () => {
    const result = parse([empty, versions]);
    if (!result.success) throw result.error;
    expect(result.data.states[1]).toMatchObject({
      id: "versions",
      url: "/editor",
      from: "empty",
      steps: [
        { action: "click", selector: "#history" },
        { action: "click", selector: "#tab-versions" },
      ],
      health: { allow: { urls: ["/analytics"], console: ["deprecated"] } },
      reachedFrom: {
        chain: ["versions", "empty"],
        stepStates: ["empty", "versions"],
      },
    });
    expect(result.data.states[0]).not.toHaveProperty("reachedFrom");
  });

  test("resolves multi-hop chains declared in any order and urlFrom roots", () => {
    const named = {
      ...versions,
      id: "named",
      from: "versions",
      steps: [{ action: "focus", selector: "#name" }],
    };
    const result = parse([
      named,
      versions,
      minimalState({
        id: "empty",
        url: undefined,
        urlFrom: { source: "setup-stdout", pattern: "(http\\S+)" },
        steps: [{ action: "click", selector: "#history" }],
      }),
    ]);
    if (!result.success) throw result.error;
    const state = result.data.states[0];
    expect(state).toMatchObject({
      urlFrom: { source: "setup-stdout" },
      reachedFrom: {
        chain: ["named", "versions", "empty"],
        stepStates: ["empty", "versions", "named"],
      },
    });
    expect(state).not.toHaveProperty("url");
    expect(state?.steps.map(({ action }) => action)).toEqual([
      "click",
      "click",
      "focus",
    ]);
  });

  test.each([
    { url: "/editor" },
    { urlFrom: { source: "setup-stdout", pattern: "(x)" } },
  ])("from is exclusive with %o", (source) => {
    expect(issues([empty, { ...versions, ...source }])).toContainEqual({
      path: ["states", 1, expect.any(String)],
      message: "must provide exactly one of url, urlFrom, and from",
    });
  });

  test("a state with no URL source is rejected", () => {
    expect(
      issues([minimalState({ url: undefined })]).map(({ message }) => message),
    ).toContain("must provide exactly one of url, urlFrom, and from");
  });

  test.each([{}, { toggles: { drawer: { open: [] } } }])(
    "unknown ids and cycles fail validation (extra %o)",
    (extra) => {
      expect(issues([empty, { ...versions, from: "nope" }], extra)).toEqual([
        { path: ["states", 1, "from"], message: 'unknown state "nope"' },
      ]);
      expect(issues([{ ...versions, from: "versions" }], extra)).toEqual([
        {
          path: ["states", 0, "from"],
          message: "cycle: versions from versions",
        },
      ]);
      expect(
        issues(
          [
            { ...versions, id: "a", from: "b" },
            { ...versions, id: "b", from: "a" },
            { ...versions, id: "c", from: "a" },
          ],
          extra,
        ),
      ).toEqual([
        { path: ["states", 0, "from"], message: "cycle: a from b from a" },
        { path: ["states", 1, "from"], message: "cycle: b from a from b" },
      ]);
    },
  );

  test("toggle combinations of a chained state keep chain steps first", () => {
    const result = parse([empty, versions], {
      toggles: { search: { focused: [{ action: "focus", selector: "#q" }] } },
      toggleStates: ["versions"],
    });
    if (!result.success) throw result.error;
    expect(result.data.states.at(-1)).toMatchObject({
      id: "versions.search-focused",
      url: "/editor",
      steps: [
        { action: "click", selector: "#history" },
        { action: "click", selector: "#tab-versions" },
        { action: "focus", selector: "#q" },
      ],
      reachedFrom: { chain: ["versions", "empty"] },
    });
    expect(result.data.states.map(stateChainLabel)).toEqual([
      "empty",
      "versions from empty",
      "versions.search-focused from empty",
    ]);
  });

  test("focus steps require a selector", () => {
    expect(
      parse([minimalState({ steps: [{ action: "focus", selector: "#x" }] })])
        .success,
    ).toBe(true);
    expect(
      parse([minimalState({ steps: [{ action: "focus", selector: " " }] })])
        .success,
    ).toBe(false);
  });
});

test("copy policy defaults and strict terminology entries remain compatible", async () => {
  const { copyConfigSchema, copyPolicySchema } = await import(
    "../src/schemas/project.js"
  );
  expect(checksConfigSchema.parse({}).copy).toEqual({
    glossary: [],
    retired: [],
    jargon: [],
    schemaWords: [],
    properNouns: [],
  });
  expect(copyPolicySchema.parse({})).toEqual({});
  expect(
    copyConfigSchema.parse({ glossary: [{ term: "legacy" }] }).glossary,
  ).toEqual([{ term: "legacy" }]);
  for (const locale of ["en-US", "en-GB", "en-CA", "en-AU"])
    expect(copyConfigSchema.parse({ locale }).locale).toBe(locale);
  for (const field of ["retired", "jargon"]) {
    expect(
      copyConfigSchema.parse({
        [field]: [{ term: " old ", preferred: " new " }],
      }),
    ).toMatchObject({ [field]: [{ term: "old", preferred: "new" }] });
    for (const entry of [
      { term: "old" },
      { term: " ", preferred: "new" },
      { term: "old", preferred: " " },
      { term: "old", preferred: "new", extra: true },
    ]) {
      expect(copyConfigSchema.safeParse({ [field]: [entry] }).success).toBe(
        false,
      );
      expect(copyPolicySchema.safeParse({ [field]: [entry] }).success).toBe(
        false,
      );
    }
  }
  expect(copyPolicySchema.safeParse({ checks: { copy: {} } }).success).toBe(
    false,
  );
  expect(copyConfigSchema.safeParse({ locale: "fr-CA" }).success).toBe(false);
});

test("shell and overlay declarations are optional, strict and nonblank", async () => {
  const { checksConfigSchema } = await import("../src/schemas/project.js");
  const { checksConfigFrom } = await import("../src/checks/registry.js");
  expect(flowSchema.parse({ ...minimalFlow(), shell: ".ed-shell" }).shell).toBe(
    ".ed-shell",
  );
  expect(flowSchema.safeParse({ ...minimalFlow(), shell: " " }).success).toBe(
    false,
  );
  const electron = flowSchema.parse({
    ...minimalFlow(),
    shell: ".ed-shell",
    target: {
      kind: "electron",
      launch: { executablePath: "electron" },
      window: { title: "Capture" },
    },
    states: [{ id: "home", description: "Home", expect: {} }],
  });
  expect(electron.shell).toBe(".ed-shell");
  expect(checksConfigSchema.parse({}).shellVisibility).toBeUndefined();
  expect(
    checksConfigSchema.parse({ shellVisibility: {} }).shellVisibility,
  ).toEqual({ floatingOverlays: [] });
  for (const value of [
    { floatingOverlays: [""] },
    { floatingOverlays: ["#a", " #a "] },
    { floatingOverlays: ["#a"], extra: true },
  ])
    expect(
      checksConfigSchema.safeParse({ shellVisibility: value }).success,
    ).toBe(false);
  expect(
    checksConfigFrom(
      checksConfigSchema.parse({
        shellVisibility: { floatingOverlays: ["#a"] },
      }),
    ).shellVisibility,
  ).toEqual({ floatingOverlays: ["#a"] });
});

test("expectVisible forms normalize strictly through state chains and toggles", async () => {
  const { webStepSchema } = await import("../src/schemas/flow.js");
  const normalized = {
    action: "expectVisible",
    selector: "#footer",
    within: ".canvas",
  };
  expect(
    webStepSchema.parse({
      expectVisible: { selector: "#footer", within: ".canvas" },
    }),
  ).toEqual(normalized);
  expect(webStepSchema.parse(normalized)).toEqual(normalized);
  for (const step of [
    { expectVisible: { selector: " " } },
    { expectVisible: { selector: "#footer", within: " " } },
    { expectVisible: { selector: "#footer", value: "x" } },
    { action: "expectVisible", selector: "#footer", text: "x" },
    {
      action: "expectVisible",
      selector: "#footer",
      expectVisible: { selector: "#other" },
    },
    { expectVisible: { selector: "#footer" }, selector: "#other" },
  ])
    expect(webStepSchema.safeParse(step).success).toBe(false);
  const flow = flowSchema.parse({
    ...minimalFlow(),
    states: [
      minimalState({ steps: [{ expectVisible: { selector: "#hero" } }] }),
      {
        id: "selected",
        description: "Selected",
        from: "home",
        steps: [{ expectVisible: { selector: "#footer" } }],
        expect: {},
      },
    ],
    toggles: { panel: { open: [{ expectVisible: { selector: "#panel" } }] } },
  });
  expect(flow.states.find((state) => state.id === "selected")?.steps).toEqual([
    { action: "expectVisible", selector: "#hero" },
    { action: "expectVisible", selector: "#footer" },
  ]);
  if ("toggles" in flow)
    expect(flow.toggles?.panel?.open).toEqual([
      { action: "expectVisible", selector: "#panel" },
    ]);
});

describe("flow content patterns (dogfooding request #69)", () => {
  const pattern = (overrides: Record<string, unknown> = {}) => ({
    id: "carousel-cards",
    path: "/patterns/carousel-cards",
    intent: "A heading introduces a row of equal cards.",
    ...overrides,
  });
  const withContent = (patterns: unknown[]) => ({
    ...minimalFlow(),
    content: { patterns },
  });

  test("a path pattern generates a pattern state and a state pattern reuses one", () => {
    const flow = flowSchema.parse(
      withContent([
        pattern({ reference: "carousel-cards" }),
        { id: "home-hero", state: "home", intent: "The hero leads." },
      ]),
    );
    expect(flow.states.map((state) => state.id)).toEqual([
      "home",
      "pattern-carousel-cards",
    ]);
    expect(flow.states[1]).toMatchObject({
      description: "Pattern carousel-cards",
      url: "/patterns/carousel-cards",
      steps: [],
    });
    if (!isWebFlow(flow)) throw new Error("expected a web flow");
    expect(flow.content?.patterns.map(contentPatternStateId)).toEqual([
      "pattern-carousel-cards",
      "home",
    ]);
  });

  test("existing flows parse unchanged", () => {
    const parsed = flowSchema.parse(minimalFlow());
    expect("content" in parsed).toBe(false);
    expect(parsed.states.map((state) => state.id)).toEqual(["home"]);
  });

  test.each([
    ["both path and state", [pattern({ state: "home" })]],
    ["neither path nor state", [pattern({ path: undefined })]],
    ["a duplicate id", [pattern(), pattern({ path: "/other" })]],
    ["an unknown state", [pattern({ path: undefined, state: "nowhere" })]],
    ["a blank intent", [pattern({ intent: " " })]],
    ["a non-slug id", [pattern({ id: "Carousel Cards" })]],
    ["an unknown field", [pattern({ weight: 1 })]],
  ])("rejects %s", (_label, patterns) => {
    expect(flowSchema.safeParse(withContent(patterns)).success).toBe(false);
  });

  test("rejects an empty pattern list", () => {
    expect(flowSchema.safeParse(withContent([])).success).toBe(false);
  });

  test("rejects a generated id that collides with a declared state", () => {
    const declared = flowSchema.safeParse({
      ...withContent([pattern()]),
      states: [minimalState({ id: "pattern-carousel-cards" })],
    });
    expect(declared.success).toBe(false);
    expect(JSON.stringify(declared.error?.issues)).toContain("collides");
  });

  test("electron flows reject content", () => {
    expect(
      flowSchema.safeParse({
        id: "example",
        title: "Example",
        intent: [],
        setup: [],
        states: [{ id: "settings", description: "Settings", expect: {} }],
        target: {
          kind: "electron",
          launch: { executablePath: "electron" },
          window: { title: "Capture" },
        },
        content: { patterns: [pattern()] },
      }).success,
    ).toBe(false);
  });
});

test("probe and capture budgets default, allow fractional minutes, and reject unlimited/invalid values", async () => {
  for (const checks of [{}, { probe: {} }]) {
    expect(checksConfigSchema.parse(checks).probe).toMatchObject({
      controlTimeoutMs: 5000,
      stateTimeoutMs: 60000,
    });
  }
  const legacy = (await json("examples/booking/.idiom/project.json")) as Record<
    string,
    unknown
  >;
  expect(projectSchema.parse(legacy).capture.maxMinutes).toBe(30);
  expect(
    projectSchema.parse({ ...legacy, capture: { maxMinutes: 0.01 } }).capture
      .maxMinutes,
  ).toBe(0.01);
  for (const field of ["controlTimeoutMs", "stateTimeoutMs"]) {
    for (const value of [0, -1, 1.2, Infinity, NaN, "5000", null]) {
      expect(
        checksConfigSchema.safeParse({ probe: { [field]: value } }).success,
        `${field}: ${String(value)}`,
      ).toBe(false);
    }
  }
  for (const value of [0, -1, Infinity, NaN, "30", null])
    expect(
      projectSchema.safeParse({ ...legacy, capture: { maxMinutes: value } })
        .success,
    ).toBe(false);
});

test("V2 artifacts keep legacy probes and accept strict additive timeout evidence", async () => {
  const { observationArtifactSchema } = await import(
    "../src/checks/artifact-schema.js"
  );
  const artifact = {
    version: 2,
    viewport: { width: 800, height: 600 },
    document: {
      scrollWidth: 800,
      scrollHeight: 600,
      clientWidth: 800,
      clientHeight: 600,
    },
    elements: [],
    headings: [],
    maskMembership: [],
    tokens: { status: "not-configured" },
  };
  const legacy = {
    selector: "#print",
    name: "Print",
    persistent: true,
    effects: [],
  };
  const timeout = {
    ...legacy,
    elapsedMs: 503.2,
    status: "timed-out",
    timeoutScope: "state",
    skipped: "timed-out: observe",
  };
  expect(
    observationArtifactSchema.parse({
      ...artifact,
      probe: { status: "ran", results: [legacy] },
    }),
  ).toBeDefined();
  expect(
    observationArtifactSchema.parse({
      ...artifact,
      probe: {
        status: "timed-out",
        selector: "#print",
        step: "observe",
        results: [timeout, { ...legacy, effects: ["print", "download"] }],
      },
    }),
  ).toBeDefined();
  for (const invalid of [
    { elapsedMs: -1 },
    { elapsedMs: Infinity },
    { status: "unknown" },
    { timeoutScope: "all" },
  ])
    expect(
      observationArtifactSchema.safeParse({
        ...artifact,
        probe: { status: "ran", results: [{ ...timeout, ...invalid }] },
      }).success,
    ).toBe(false);
});

import { describe, expect, test } from "vitest";
import { observationArtifactSchema } from "../src/checks/artifact-schema.js";
import {
  actionVocabulary,
  collectionActionsCheck,
  menuTriggerPattern,
} from "../src/checks/collection-actions.js";
import { checksConfigFrom } from "../src/checks/registry.js";
import type {
  ChecksConfig,
  CheckTuple,
  CollectionItemObservation,
  CollectionObservation,
  ProbeCollection,
} from "../src/checks/types.js";
import { checksConfigSchema } from "../src/schemas/project.js";

function item(
  value: Partial<CollectionItemObservation> = {},
): CollectionItemObservation {
  return {
    selector: "article:nth-of-type(1)",
    rect: { x: 0, y: 0, width: 200, height: 120 },
    open: false,
    controls: [],
    menuTriggers: [],
    ...value,
  };
}
function collection(
  items: CollectionItemObservation[],
  selector = ".card",
): CollectionObservation {
  return { selector, matched: items.length, items };
}
function tuple(extra: Record<string, unknown> | undefined): CheckTuple {
  return {
    flow: "f",
    state: "s",
    viewport: "desktop",
    width: 1280,
    height: 720,
    metadataPath: "m.json",
    artifactPaths: [],
    commit: "c",
    createdAt: "2026-10-24T00:00:00.000Z",
    observations: {
      version: 2,
      viewport: { width: 1280, height: 720 },
      document: {
        scrollWidth: 1280,
        scrollHeight: 720,
        clientWidth: 1280,
        clientHeight: 720,
      },
      elements: [],
      maskMembership: [],
      headings: [],
      tokens: { status: "not-configured" },
      ...extra,
    } as CheckTuple["observations"],
    axe: { violations: [] },
    console: [],
    mismatches: [],
  };
}
const declared: ChecksConfig["collections"] = [
  { selector: ".card", name: "page", actions: ["open", "rename", "delete"] },
];
function run(
  collections: CollectionObservation[] | undefined,
  probe?: ProbeCollection[],
  config: ChecksConfig = { ...checksConfigFrom(), collections: declared },
) {
  return collectionActionsCheck.run({
    tuple: tuple({
      ...(collections === undefined ? {} : { collections }),
      ...(probe === undefined
        ? {}
        : { probe: { status: "ran", results: [], collections: probe } }),
    }),
    narrowViewport: false,
    config,
  });
}
const verbs = (result: ReturnType<typeof run>) =>
  result.candidates.map((c) => c.verification.params?.verb);

describe("vocabulary", () => {
  test("verbs match whole words only", () => {
    expect(actionVocabulary.delete.test("Delete page")).toBe(true);
    expect(actionVocabulary.delete.test("Move to trash")).toBe(true);
    expect(actionVocabulary.delete.test("Removed items")).toBe(false);
    expect(actionVocabulary.rename.test("Rename")).toBe(true);
    expect(actionVocabulary.rename.test("Edit title")).toBe(true);
    expect(actionVocabulary.rename.test("Edit layout")).toBe(false);
    expect(actionVocabulary.open.test("View page")).toBe(true);
    expect(actionVocabulary.open.test("Opened yesterday")).toBe(false);
  });

  test("menu triggers are named more/options/actions/menu or are a bare ellipsis", () => {
    for (const name of ["More actions", "Options", "⋯", "⋮", "…", "Menu"])
      expect(menuTriggerPattern.test(name)).toBe(true);
    for (const name of ["Morel", "Save as…", "Promenade"])
      expect(menuTriggerPattern.test(name)).toBe(false);
  });
});

describe("collectionActionsCheck", () => {
  test("static controls, hidden ones included, and the open flag satisfy verbs", () => {
    expect(
      run([
        collection([
          item({ open: true, controls: ["Rename", "Delete"] }),
          item(),
        ]),
      ]).candidates,
    ).toEqual([]);
    expect(verbs(run([collection([item({ controls: ["Rename"] })])]))).toEqual([
      "open",
      "delete",
    ]);
  });

  test("findings are minor heuristics naming what was found", () => {
    const result = run(
      [collection([item({ open: true, controls: ["Landing page A"] })])],
      [
        {
          selector: ".card",
          menus: [{ trigger: "contextmenu", name: "right-click", items: [] }],
        },
      ],
    );
    expect(result.candidates).toHaveLength(2);
    for (const candidate of result.candidates) {
      expect(candidate.severity).toBe("minor");
      expect(candidate.rule).toBe("idiom:collection-actions");
      expect(candidate.explanation).toMatch(/^Heuristic: /);
    }
    expect(result.candidates[1]).toMatchObject({
      fingerprintHint: "collection-actions:.card:delete",
      selectorHint: "article:nth-of-type(1)",
      explanation:
        "Heuristic: no way to delete page items was found: items offer Landing page A; right-click opens nothing.",
      verification: {
        params: { collection: ".card", verb: "delete", probed: true },
      },
    });
  });

  test("menus from the probe satisfy verbs, button and context menus alike", () => {
    const items = [
      item({
        open: true,
        menuTriggers: [{ selector: "#m", name: "More actions" }],
      }),
    ];
    expect(
      run(
        [collection(items)],
        [
          {
            selector: ".card",
            menus: [
              { trigger: "button", name: "More actions", items: ["Rename"] },
              {
                trigger: "contextmenu",
                name: "right-click",
                items: ["Move to trash"],
              },
            ],
          },
        ],
      ).candidates,
    ).toEqual([]);
  });

  test("an unprobed menu trigger is noted, not reported", () => {
    const result = run([
      collection([
        item({
          open: true,
          menuTriggers: [{ selector: "#m", name: "More actions" }],
        }),
      ]),
    ]);
    expect(result.candidates).toEqual([]);
    expect(result.coverage.reason).toBe(
      "1 collections examined; .card: 1 menu trigger(s) not probed; enable checks.probe to judge rename; .card: 1 menu trigger(s) not probed; enable checks.probe to judge delete",
    );
  });

  test("a declared actions subset is honoured", () => {
    expect(
      verbs(
        run([collection([item()])], undefined, {
          ...checksConfigFrom(),
          collections: [{ selector: ".card", actions: ["delete"] }],
        }),
      ),
    ).toEqual(["delete"]);
  });

  test("missing, invalid and empty selectors are notes", () => {
    const config = {
      ...checksConfigFrom(),
      collections: [
        { selector: ".card", actions: ["delete"] },
        { selector: "[", actions: ["delete"] },
        { selector: ".gone", actions: ["delete"] },
        { selector: ".new", actions: ["delete"] },
      ],
    } satisfies ChecksConfig;
    const result = run(
      [
        collection([item({ controls: ["Delete"] })]),
        { selector: "[", matched: 0, invalid: true, items: [] },
        { selector: ".gone", matched: 0, items: [] },
      ],
      undefined,
      config,
    );
    expect(result.candidates).toEqual([]);
    expect(result.coverage).toEqual({
      check: "collection-actions",
      status: "ran",
      reason:
        "1 collections examined; [ is not a valid selector; .gone matched no rendered items; .new not resolved at capture (recapture after adding checks.collections)",
    });
  });

  test("undeclared is skipped and an old capture is unavailable", () => {
    expect(run([], undefined, checksConfigFrom()).coverage.status).toBe(
      "skipped",
    );
    expect(run(undefined).coverage).toMatchObject({ status: "unavailable" });
  });

  test("evidence round-trips through the strict artifact schema", () => {
    const observations = tuple({
      collections: [
        collection([
          item({ menuTriggers: [{ selector: "#m", name: "More actions" }] }),
        ]),
      ],
      probe: {
        status: "ran",
        results: [],
        collections: [
          {
            selector: ".card",
            menus: [{ trigger: "button", name: "More", items: ["Delete"] }],
          },
          { selector: ".row", menus: [], reason: "no rendered item" },
        ],
      },
    }).observations;
    expect(observationArtifactSchema.safeParse(observations).success).toBe(
      true,
    );
  });
});

describe("checks.collections config", () => {
  test("defaults, the action enum, uniqueness and threading", () => {
    expect(checksConfigSchema.parse({}).collections).toEqual([]);
    const parsed = checksConfigSchema.parse({
      collections: [
        { selector: ".card", name: "page" },
        { selector: ".row", actions: ["delete"] },
      ],
    });
    expect(checksConfigFrom(parsed).collections).toEqual([
      {
        selector: ".card",
        name: "page",
        actions: ["open", "rename", "delete"],
      },
      { selector: ".row", actions: ["delete"] },
    ]);
    for (const collections of [
      [{ selector: ".a", actions: ["archive"] }],
      [{ selector: ".a", actions: [] }],
      [{ selector: ".a", actions: ["delete", "delete"] }],
      [{ selector: ".a" }, { selector: ".a" }],
      [{ selector: " " }],
      [{ selector: ".a", extra: 1 }],
    ])
      expect(checksConfigSchema.safeParse({ collections }).success).toBe(false);
  });
});

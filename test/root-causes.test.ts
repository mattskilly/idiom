import { expect, test } from "vitest";
import { collapseIssues } from "../src/review/issues.js";
import type {
  IssueRankingContext,
  IssueRankingTuple,
  RankingElement,
} from "../src/review/ranking.js";
import { rootCauseBreadth } from "../src/review/ranking.js";
import { rootCauseIssues } from "../src/review/root-causes.js";
import type { CheckGroup } from "../src/review/summary.js";
import type { Finding } from "../src/schemas/finding.js";

const coordinate = "editor/desktop";

function element(
  selector: string,
  overrides: Partial<RankingElement> = {},
): RankingElement {
  return {
    selector,
    tag: "button",
    interactive: true,
    visible: true,
    rect: { x: 0, y: 0, width: 40, height: 20 },
    ancestorSelectors: ["main"],
    attributes: {},
    styles: {},
    ...overrides,
  };
}

function context(
  elements: RankingElement[],
  extra: Partial<IssueRankingTuple> = {},
): IssueRankingContext {
  return new Map([
    [
      coordinate,
      {
        state: "editor",
        viewport: { width: 800, height: 600 },
        elements: new Map(
          [
            element("main", { tag: "main", interactive: false }),
            ...elements,
          ].map((entry) => [entry.selector, entry]),
        ),
        primaryRegions: new Set<string>(),
        ...extra,
      },
    ],
  ]);
}

let counter = 0;
type Spec = {
  category?: string;
  rule: string;
  selector?: string;
  params: Record<string, unknown>;
};
function fixture(specs: Spec[]) {
  const findings: Finding[] = [];
  const groups: CheckGroup[] = specs.map((spec) => {
    counter += 1;
    const id = `finding-${counter}`;
    findings.push({
      id,
      fingerprint: `fp-${counter}`,
      status: "open",
      category: spec.category ?? "scale-conformance",
      rule: spec.rule,
      verification: {
        check: spec.category ?? "scale-conformance",
        params: spec.params,
      },
    } as unknown as Finding);
    return {
      id: `group-${String(counter).padStart(12, "0")}`,
      severity: "minor",
      category: (spec.category ??
        "scale-conformance") as CheckGroup["category"],
      rule: spec.rule,
      where: "editor/desktop",
      ...(spec.selector === undefined ? {} : { selector: spec.selector }),
      problem: `${spec.rule} problem ${counter}. More detail.`,
      fix: [],
      members: [
        {
          id,
          severity: "minor",
          where: "editor/desktop",
          coordinates: [coordinate],
        },
      ],
      coordinates: [coordinate],
      states: ["editor"],
      viewports: ["desktop"],
      colorSchemes: [],
    };
  });
  return {
    groups,
    findingsById: new Map(findings.map((finding) => [finding.id, finding])),
  };
}

const run = (
  specs: Spec[],
  rankingContext: IssueRankingContext,
  order: (groups: CheckGroup[]) => CheckGroup[] = (groups) => groups,
) => {
  const { groups, findingsById } = fixture(specs);
  return {
    groups,
    issues: rootCauseIssues(
      order(groups),
      findingsById,
      new Set(),
      rankingContext,
    ),
  };
};

const radiusFrom = (token: string, unresolved: boolean) => ({
  styles: { borderTopLeftRadius: "4px" },
  styleSources: {
    borderTopLeftRadius: {
      sheet: "app.css",
      selector: ".control",
      tokens: [token],
      ...(unresolved ? { unresolved: [token] } : {}),
    },
  },
});

const tokenDrift = (selector: string): Spec => ({
  category: "token-drift",
  rule: "idiom:token-drift",
  selector: `${selector}::borderRadius`,
  params: { selector, property: "borderRadius" },
});

test("token tier: an unresolved token behind several symptoms is one cause", () => {
  const { issues, groups } = run(
    ["#a", "#b", "#c"].map(tokenDrift),
    context(
      ["#a", "#b", "#c"].map((selector) =>
        element(selector, radiusFrom("--r-md", true)),
      ),
      { tokens: { "--r-md": "8px" } },
    ),
  );
  expect(issues).toHaveLength(1);
  const [issue] = issues;
  expect(issue?.rootCause).toMatchObject({
    kind: "token",
    key: "--r-md",
    confidence: 0.9,
    cause: "`--r-md` is not applied: 3 controls render 4px against 8px",
    fix: "Define `--r-md` where these elements inherit it (or fix the reference)",
    counts: { symptoms: 3, findings: 3 },
  });
  expect(issue?.rootCause?.id).toMatch(/^cause-[0-9a-f]{12}$/);
  expect(groups.map((group) => group.id)).toContain(issue?.id);
  expect(issue?.groups[0]).toBe(issue?.id);
  expect(issue?.explanation.breadth).toBeCloseTo(rootCauseBreadth(3));
  expect(issue?.rootCause?.symptoms[0]?.measurement).toMatch(/problem \d+\.$/);
});

test("token tier: a token that resolves off the system is a lower-confidence cause", () => {
  const { issues } = run(
    ["#a", "#b"].map(tokenDrift),
    context(
      ["#a", "#b"].map((selector) =>
        element(selector, radiusFrom("--r-sm", false)),
      ),
    ),
  );
  expect(issues).toHaveLength(1);
  expect(issues[0]?.rootCause).toMatchObject({
    kind: "token",
    confidence: 0.8,
    cause: "`--r-sm` resolves to 4px off the system on 2 controls (radius)",
    fix: "Set `--r-sm` to a declared token value",
  });
});

test("component tier: declared name beats data-idiom-name beats class signature, and needs two rule families", () => {
  const specs = ([first, second]: [string, string]): Spec[] => [
    {
      category: "target-size",
      rule: "idiom:minimum-target-size",
      selector: first,
      params: { selector: first },
    },
    {
      category: "text-centering",
      rule: "idiom:text-off-centre",
      selector: second,
      params: { selector: second },
    },
  ];
  const elements = (extra: Partial<RankingElement>) => [
    element("#a", {
      ...extra,
      attributes: {
        class: "btn",
        "data-idiom-name": "Primary",
        ...extra.attributes,
      },
    }),
    element("#b", {
      ...extra,
      attributes: {
        class: "btn",
        "data-idiom-name": "Primary",
        ...extra.attributes,
      },
    }),
  ];
  const declared = run(
    specs(["#a", "#b"]),
    context(elements({}), {
      components: new Map([
        ["#a", "Button"],
        ["#b", "Button"],
      ]),
    }),
  );
  expect(declared.issues).toHaveLength(1);
  expect(declared.issues[0]?.rootCause).toMatchObject({
    kind: "component",
    key: "component:Button",
    confidence: 0.7,
    cause:
      "The `Button` component fails 2 rules across 2 instances: minimum-target-size, text-off-centre",
  });
  const named = run(specs(["#a", "#b"]), context(elements({})));
  expect(named.issues[0]?.rootCause?.key).toBe("idiom-name:Primary");
  const classed = run(
    specs(["#a", "#b"]),
    context([
      element("#a", { attributes: { class: "btn css-1a2b3c4d5e" } }),
      element("#b", { attributes: { class: "btn" } }),
    ]),
  );
  expect(classed.issues[0]?.rootCause?.key).toBe("class:button|btn");
  // One rule family on one component is not a shared cause.
  const sameRule = run(
    [
      {
        category: "target-size",
        rule: "idiom:minimum-target-size",
        selector: "#a",
        params: { selector: "#a" },
      },
      {
        category: "target-size",
        rule: "idiom:minimum-target-size",
        selector: "#b",
        params: { selector: "#b" },
      },
    ],
    context(elements({})),
  );
  expect(sameRule.issues.some((issue) => issue.rootCause)).toBe(false);
});

test("style-rule tier: one authored rule behind several symptoms", () => {
  const source = { sheet: "styles.css", selector: ".field" };
  const { issues } = run(
    [
      {
        rule: "idiom:scale-outlier",
        params: {
          property: "radius",
          targets: [{ selector: "#a", property: "borderTopLeftRadius" }],
        },
      },
      {
        rule: "idiom:off-scale-spacing",
        params: {
          property: "spacing",
          targets: [{ selector: "#a", property: "paddingTop" }],
        },
      },
    ],
    context([
      element("#a", {
        styleSources: { borderTopLeftRadius: source, paddingTop: source },
      }),
    ]),
  );
  expect(issues).toHaveLength(1);
  expect(issues[0]?.rootCause).toMatchObject({
    kind: "style-rule",
    key: "styles.css\0.field",
    confidence: 0.6,
    cause:
      "`.field` in styles.css sets the offending radius and padding on 1 element",
    fix: "Edit `.field` in styles.css",
  });
});

test("region tier needs three rule families failing inside one boundary", () => {
  const inside = { ancestorSelectors: ["form#booking", "main"] };
  const regionContext = context([
    element("form#booking", { tag: "form", interactive: false }),
    element("#a", inside),
    element("#b", inside),
    element("#c", inside),
  ]);
  const specs: Spec[] = [
    {
      category: "target-size",
      rule: "idiom:minimum-target-size",
      selector: "#a",
      params: { selector: "#a" },
    },
    {
      category: "text-centering",
      rule: "idiom:text-off-centre",
      selector: "#b",
      params: { selector: "#b" },
    },
    {
      category: "dead-control",
      rule: "idiom:no-effect",
      selector: "#c",
      params: { selector: "#c" },
    },
  ];
  const three = run(specs, regionContext);
  expect(three.issues).toHaveLength(1);
  expect(three.issues[0]?.rootCause).toMatchObject({
    kind: "region",
    key: "form#booking",
    confidence: 0.4,
    cause:
      "`form#booking` fails 3 rules at once: minimum-target-size, text-off-centre, no-effect",
  });
  expect(three.issues[0]?.rootCause?.fix).toBeUndefined();
  const two = run(specs.slice(0, 2), regionContext);
  expect(two.issues.some((issue) => issue.rootCause)).toBe(false);
});

test("tiers apply in confidence order, deterministically, and leave unrelated defects alone", () => {
  // Both groups share a token and a component: the token wins.
  const shared = [
    element("#a", {
      ...radiusFrom("--r-md", true),
      attributes: { class: "btn" },
    }),
    element("#b", {
      ...radiusFrom("--r-md", true),
      attributes: { class: "btn" },
    }),
    element("#c", { ancestorSelectors: ["header"] }),
    element("#d", { ancestorSelectors: ["footer"] }),
  ];
  const specs: Spec[] = [
    tokenDrift("#a"),
    {
      category: "target-size",
      rule: "idiom:minimum-target-size",
      selector: "#b",
      params: {
        selector: "#b",
        targets: [{ selector: "#b", property: "borderTopLeftRadius" }],
      },
    },
    {
      category: "target-size",
      rule: "idiom:minimum-target-size",
      selector: "#c",
      params: { selector: "#c" },
    },
    {
      category: "dead-affordance",
      rule: "idiom:placeholder-link",
      selector: "#d",
      params: { selector: "#d" },
    },
  ];
  const forward = run(specs, context(shared));
  const causes = forward.issues.filter((issue) => issue.rootCause);
  expect(causes).toHaveLength(1);
  expect(causes[0]?.rootCause?.kind).toBe("token");
  expect(forward.issues).toHaveLength(3);
  const { groups, findingsById } = fixture(specs);
  const once = rootCauseIssues(
    groups,
    findingsById,
    new Set(),
    context(shared),
  );
  const again = rootCauseIssues(
    [...groups].reverse(),
    findingsById,
    new Set(),
    context(shared),
  );
  expect(again.map((issue) => [issue.id, issue.rootCause?.id])).toEqual(
    once.map((issue) => [issue.id, issue.rootCause?.id]),
  );
});

test("without a ranking context the output is collapseIssues'", () => {
  const { groups, findingsById } = fixture(["#a", "#b"].map(tokenDrift));
  expect(rootCauseIssues(groups, findingsById, new Set())).toEqual(
    collapseIssues(groups, new Set()),
  );
});

test("the breadth factor is capped at 25%", () => {
  expect(rootCauseBreadth(1)).toBe(1);
  expect(rootCauseBreadth(8)).toBeCloseTo(1.25);
  expect(rootCauseBreadth(100)).toBeCloseTo(1.25);
});

test("aggregate same-rule components join across flows with qualified geometry; default grouping stays unchanged", () => {
  const { groups, findingsById } = fixture(
    ["#a", "#a"].map((selector) => ({
      category: "target-size",
      rule: "idiom:minimum-target-size",
      selector,
      params: { selector },
    })),
  );
  const qualifiedGroups = groups.map((g, i) => ({
    ...g,
    coordinates: [JSON.stringify([i ? "beta" : "alpha", coordinate])],
  }));
  const tuple = context([element("#a")], {
    components: new Map([["#a", "Button"]]),
  }).get(coordinate) as IssueRankingTuple;
  const ctx: IssueRankingContext = new Map(
    qualifiedGroups.map((g, i) => [
      g.coordinates[0] as string,
      {
        ...tuple,
        state: JSON.stringify([i, "editor"]),
        elements: new Map([
          [
            "#a",
            element("#a", {
              rect: { x: 0, y: 0, width: i ? 400 : 40, height: i ? 300 : 20 },
            }),
          ],
        ]),
      },
    ]),
  );
  const groupFlows = new Map(
    groups.map((g, i) => [g.id, i ? "beta" : "alpha"]),
  );
  const aggregate = rootCauseIssues(
    qualifiedGroups,
    findingsById,
    new Set(),
    ctx,
    { groupFlows },
  );
  expect(aggregate).toHaveLength(1);
  expect(aggregate[0]?.rootCause?.key).toBe("component:Button");
  expect(aggregate[0]?.explanation.states).toBe(2);
  expect(aggregate[0]?.explanation.coordinate).toBe(
    qualifiedGroups[1]?.coordinates[0],
  );
  expect(
    rootCauseIssues(qualifiedGroups, findingsById, new Set(), ctx).some(
      (i) => i.rootCause,
    ),
  ).toBe(false);
  const plain = new Map(
    [...ctx].map(([key, t]) => [
      key,
      { ...t, components: new Map<string, string>() },
    ]),
  );
  expect(
    rootCauseIssues(qualifiedGroups, findingsById, new Set(), plain, {
      groupFlows,
    }).some((i) => i.rootCause),
  ).toBe(false);
});

test("aggregate regions and class heuristics remain local to their flow", () => {
  const { groups, findingsById } = fixture([
    {
      category: "target-size",
      rule: "idiom:minimum-target-size",
      selector: "#a",
      params: { selector: "#a" },
    },
    {
      category: "text-centering",
      rule: "idiom:text-off-centre",
      selector: "#a",
      params: { selector: "#a" },
    },
    {
      category: "dead-control",
      rule: "idiom:no-effect",
      selector: "#a",
      params: { selector: "#a" },
    },
  ]);
  const tuple = context([
    element("#a", { ancestorSelectors: ["#settings"] }),
    element("#settings", { tag: "section", interactive: false }),
  ]).get(coordinate) as IssueRankingTuple;
  const ctx = new Map<string, IssueRankingTuple>();
  const flows = new Map<string, string>();
  for (const [i, g] of groups.entries()) {
    g.coordinates = [JSON.stringify([String(i), coordinate])];
    ctx.set(g.coordinates[0] as string, { ...tuple, state: String(i) });
    flows.set(g.id, String(i));
  }
  expect(
    rootCauseIssues(groups, findingsById, new Set(), ctx).some(
      (i) => i.rootCause?.kind === "region",
    ),
  ).toBe(true);
  expect(
    rootCauseIssues(groups, findingsById, new Set(), ctx, {
      groupFlows: flows,
    }).some((i) => i.rootCause),
  ).toBe(false);
});

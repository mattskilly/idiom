import { expect, test } from "vitest";
import { observationArtifactSchema } from "../src/checks/artifact-schema.js";
import {
  claimTokens,
  normalizeClaim,
  pageContentCheck,
  pageSections,
} from "../src/checks/page-content.js";
import { checksConfigFrom } from "../src/checks/registry.js";
import type {
  ChecksConfig,
  ExpandedObservedStyles,
  ObservationArtifactV2,
  ObservedElementV2,
  SelectorMark,
} from "../src/checks/types.js";
import type { FindingDraft } from "../src/review/findings.js";
import { sortFindingDrafts } from "../src/review/findings.js";
import { checkMarks, checksConfigSchema } from "../src/schemas/project.js";
import { emptyObservation, tupleFor } from "./motion-support.js";

const plain: ExpandedObservedStyles = {
  color: "rgb(17, 24, 39)",
  backgroundColor: "rgba(0, 0, 0, 0)",
  borderTopColor: "rgb(0, 0, 0)",
  borderRightColor: "rgb(0, 0, 0)",
  borderBottomColor: "rgb(0, 0, 0)",
  borderLeftColor: "rgb(0, 0, 0)",
  borderTopWidth: "0px",
  borderRightWidth: "0px",
  borderBottomWidth: "0px",
  borderLeftWidth: "0px",
  outlineColor: "rgb(0, 0, 0)",
  outlineWidth: "0px",
  fill: "none",
  stroke: "none",
  borderTopLeftRadius: "0px",
  borderTopRightRadius: "0px",
  borderBottomRightRadius: "0px",
  borderBottomLeftRadius: "0px",
  overflowX: "visible",
  overflowY: "visible",
  position: "static",
  display: "block",
  visibility: "visible",
  opacity: "1",
  fontFamily: "sans-serif",
  fontSize: "16px",
  fontWeight: "400",
  lineHeight: "normal",
  letterSpacing: "normal",
  textAlign: "left",
  textDecorationLine: "none",
  textTransform: "none",
  whiteSpace: "normal",
  wordBreak: "normal",
  paddingTop: "0px",
  paddingRight: "0px",
  paddingBottom: "0px",
  paddingLeft: "0px",
  marginTop: "0px",
  marginRight: "0px",
  marginBottom: "0px",
  marginLeft: "0px",
  gap: "normal",
  flexDirection: "row",
  justifyContent: "normal",
  alignItems: "normal",
  gridTemplateColumns: "none",
  boxShadow: "none",
  transform: "none",
  zIndex: "auto",
};

/** One element at a structural path; selector is the path's last segment. */
function node(
  path: string,
  overrides: Partial<Omit<ObservedElementV2, "styles">> & {
    styles?: Partial<ExpandedObservedStyles>;
  } = {},
): ObservedElementV2 {
  const { styles, ...rest } = overrides;
  const tag = (path.split("/").at(-1) ?? "").replace(/\[\d+\]$/, "");
  const rect = overrides.rect ?? { x: 0, y: 0, width: 1000, height: 40 };
  return {
    selector: `#${path.replaceAll(/[[\]/]/g, "-")}`,
    tag,
    text: overrides.directText ?? "",
    visible: true,
    interactive: false,
    enabled: true,
    scrollWidth: rect.width,
    scrollHeight: rect.height,
    clientWidth: rect.width,
    clientHeight: rect.height,
    outOfFlow: false,
    ancestorSelectors: [],
    hitTestWith: [],
    structuralPath: `html[0]/body[0]/${path}`,
    directText: "",
    attributes: {},
    temporal: false,
    stableIslandPath: "html[0]/body[0]",
    relativeRect: rect,
    ...rest,
    rect,
    styles: { ...plain, ...styles },
  };
}

const section = (path: string, y: number, height = 400) =>
  node(path, { rect: { x: 0, y, width: 1000, height } });

const button = (path: string, text = "Start now") =>
  node(path, {
    interactive: true,
    directText: text,
    text,
    styles: { backgroundColor: "rgb(15, 82, 87)" },
  });

function observation(
  elements: ObservedElementV2[],
  selectorMarks?: SelectorMark[],
): ObservationArtifactV2 {
  return {
    ...emptyObservation,
    elements,
    ...(selectorMarks === undefined ? {} : { selectorMarks }),
  };
}

function config(page: Partial<NonNullable<ChecksConfig["page"]>> = {}) {
  return {
    ...checksConfigFrom(),
    page: {
      ctaSelectors: [],
      placeholderPatterns: [],
      claimsAllow: [],
      ...page,
    },
  };
}

function run(
  elements: ObservedElementV2[],
  page: Partial<NonNullable<ChecksConfig["page"]>> = {},
  marks?: SelectorMark[],
) {
  return pageContentCheck.run({
    tuple: tupleFor(observation(elements, marks)),
    narrowViewport: false,
    config: config(page),
  });
}

const rules = (result: ReturnType<typeof run>) =>
  result.candidates.map((candidate) => candidate.rule);

const landing = (heroCta: ObservedElementV2[] = []) => [
  node("header[0]", { rect: { x: 0, y: 0, width: 1000, height: 60 } }),
  node("header[0]/nav[0]"),
  button("header[0]/nav[0]/a[0]", "Sign up"),
  node("main[0]"),
  section("main[0]/section[0]", 60),
  node("main[0]/section[0]/h1[0]", { headingLevel: 1, text: "Launch" }),
  ...heroCta,
  section("main[0]/section[1]", 460),
  section("main[0]/section[1]/article[0]", 480, 120),
  section("main[0]/section[2]", 860),
  button("main[0]/section[2]/button[0]"),
  section("footer[0]", 1260, 120),
  button("footer[0]/a[0]", "Contact"),
];

test("pageSections orders top-level sections, drops nested ones and marks the footer", () => {
  const sections = pageSections(observation(landing()), 600);
  expect(sections.map(({ id, role, heading }) => [id, role, heading])).toEqual([
    ["s1", "hero", "Launch"],
    ["s2", "body", undefined],
    ["s3", "final", undefined],
    ["s4", "footer", undefined],
  ]);
});

test("a main child that only wraps sections is not itself a section", () => {
  const sections = pageSections(
    observation([
      node("main[0]"),
      section("main[0]/div[0]", 0, 1200),
      section("main[0]/div[0]/section[0]", 0),
      section("main[0]/div[0]/section[1]", 400),
      section("main[0]/div[1]", 1200, 300),
    ]),
    600,
  );
  expect(sections.map((entry) => entry.structuralPath)).toEqual([
    "html[0]/body[0]/main[0]/div[0]/section[0]",
    "html[0]/body[0]/main[0]/div[0]/section[1]",
    "html[0]/body[0]/main[0]/div[1]",
  ]);
});

test("nav links and bare inline links are not a hero CTA; a button is", () => {
  expect(rules(run(landing()))).toEqual(["idiom:missing-hero-cta"]);
  const inline = node("main[0]/section[0]/a[0]", {
    interactive: true,
    directText: "Read more",
    text: "Read more",
    inlineTextTarget: true,
  });
  expect(rules(run(landing([inline])))).toEqual(["idiom:missing-hero-cta"]);
  expect(rules(run(landing([button("main[0]/section[0]/a[0]")])))).toEqual([]);
});

test("a nav inside the hero is an action group; a header's site nav is not", () => {
  const heroNav = [
    node("main[0]/section[0]/nav[0]"),
    button("main[0]/section[0]/nav[0]/a[0]", "Get a first result"),
  ];
  expect(rules(run(landing(heroNav)))).toEqual([]);
  const headerHero = [
    section("header[0]", 0, 300),
    node("header[0]/h1[0]", { headingLevel: 1, text: "Launch" }),
    node("header[0]/nav[0]"),
    button("header[0]/nav[0]/a[0]", "Pricing"),
    section("main[0]/section[0]", 300),
    button("main[0]/section[0]/button[0]"),
  ];
  expect(rules(run(headerHero))).toEqual(["idiom:missing-hero-cta"]);
});

test("one content section leaves the CTA rules unevaluated, and says so", () => {
  const result = run([section("main[0]/section[0]", 0)]);
  expect(result.candidates).toEqual([]);
  expect(result.coverage.reason).toContain("CTA rules not evaluated");
});

test("ctaSelectors read capture-time marks", () => {
  const link = node("main[0]/section[0]/a[0]", {
    interactive: true,
    directText: "Start",
    inlineTextTarget: true,
  });
  const elements = landing([link]);
  const mark = (matches: string[], invalid?: true): SelectorMark => ({
    purpose: "cta",
    selector: ".cta",
    matches,
    ...(invalid === undefined ? {} : { invalid }),
  });
  expect(
    rules(
      run(elements, { ctaSelectors: [".cta"] }, [
        mark([
          link.selector,
          elements.find((entry) =>
            entry.structuralPath.endsWith("section[2]/button[0]"),
          )?.selector ?? "",
        ]),
      ]),
    ),
  ).toEqual([]);
  const missing = run(elements, { ctaSelectors: [".cta"] }, []);
  expect(missing.coverage).toEqual({
    check: "page-content",
    status: "unavailable",
    reason:
      ".cta was not resolved at capture (recapture after adding checks.page.ctaSelectors)",
  });
  const invalid = run(elements, { ctaSelectors: [".cta"] }, [mark([], true)]);
  expect(rules(invalid)).toEqual([
    "idiom:missing-hero-cta",
    "idiom:missing-final-cta",
  ]);
  expect(invalid.coverage.reason).toContain(".cta is not a valid selector");
  const legacy = pageContentCheck.run({
    tuple: tupleFor({ ...observation(elements), version: 1 } as never),
    narrowViewport: false,
    config: config(),
  });
  expect(legacy.coverage.status).toBe("unavailable");
});

test("the check is skipped without page config", () => {
  const result = pageContentCheck.run({
    tuple: tupleFor(observation(landing())),
    narrowViewport: false,
    config: checksConfigFrom(),
  });
  expect(result).toEqual({
    coverage: {
      check: "page-content",
      status: "skipped",
      reason: "page review not enabled (idiom review --page or checks.page)",
    },
    candidates: [],
  });
});

test("checkMarks appends deduplicated cta marks last and nothing without page", () => {
  const base = checksConfigSchema.parse({
    primaryRegion: { selector: "main", minShare: 0.5 },
  });
  expect(checkMarks(base).map((mark) => mark.purpose)).toEqual([
    "primary-region",
  ]);
  expect(
    checkMarks({
      ...base,
      page: checksConfigSchema.parse({
        page: { ctaSelectors: [".a", ".b", ".a"] },
      }).page,
    }),
  ).toEqual([
    { purpose: "primary-region", selector: "main" },
    { purpose: "cta", selector: ".a" },
    { purpose: "cta", selector: ".b" },
  ]);
});

test("observation artifacts accept cta marks and still load without them", () => {
  const withMark = observation(landing(), [
    { purpose: "cta", selector: ".cta", matches: [] },
  ]);
  expect(() => observationArtifactSchema.parse(withMark)).not.toThrow();
  expect(() =>
    observationArtifactSchema.parse(observation(landing())),
  ).not.toThrow();
});

test("claims normalise separators, spelled units and magnitudes", () => {
  expect(
    claimTokens("Trusted by 12,000+ teams — 87% faster, 3x quicker"),
  ).toEqual(["12,000+ teams", "87%", "3x"]);
  expect(claimTokens("15 × 2 × 2 declared states")).toEqual([]);
  expect(normalizeClaim("12,000+ teams")).toBe("12000+teams");
  expect(normalizeClaim("40 percent")).toBe("40%");
  expect(normalizeClaim("$2.5 million")).toBe("$2.5m");
  expect(
    claimTokens("Rated 4.9/5 by 200 reviews; 5 minutes; v2.0; 2024"),
  ).toEqual(["4.9/5", "200 reviews"]);
});

test("claims in the brief, claimsAllow, footers and years are supported", () => {
  const page = (text: string, path = "main[0]/section[1]/p[0]") => [
    section("main[0]/section[0]", 0),
    section("main[0]/section[1]", 400),
    node(path, { directText: text }),
    section("footer[0]", 800, 100),
  ];
  const claims = (
    text: string,
    brief: string,
    extra: Partial<NonNullable<ChecksConfig["page"]>> = {},
    path?: string,
  ) =>
    run(page(text, path), { brief: { text: brief }, ...extra })
      .candidates.filter(
        (candidate) => candidate.rule === "idiom:unsupported-claim",
      )
      .map((candidate) => candidate.fingerprintHint);
  expect(claims("Join 12,000+ teams", "Used by 12000+ customers")).toEqual([]);
  expect(claims("40% faster", "launch 40 percent faster")).toEqual([]);
  expect(claims("7% faster", "87% faster")).toEqual(["7%"]);
  expect(claims("Since 2019, 99.9% uptime", "")).toEqual(["99.9%"]);
  expect(claims("99.9% uptime", "", { claimsAllow: ["99.9%"] })).toEqual([]);
  expect(claims("100% of rights", "", {}, "footer[0]/p[0]")).toEqual([]);
  expect(
    claims(
      "€22.60",
      "",
      {},
      "main[0]/section[1]/button[0]/div[0]/div[0]/span[0]",
    ),
  ).toEqual([]);
  expect(
    claims("Start for $59", "", {}, "main[0]/section[1]/button[0]/span[0]"),
  ).toEqual(["$59"]);
  const unbriefed = run(page("87% faster"));
  expect(unbriefed.coverage.reason).toContain("no brief; claims not checked");
});

test("placeholder text, built in and configured", () => {
  const page = (text: string) => [node("p[0]", { directText: text })];
  const placeholders = (text: string, patterns: string[] = []) =>
    run(page(text), { placeholderPatterns: patterns }).candidates.map(
      (candidate) => candidate.fingerprintHint,
    );
  expect(placeholders("Lorem ipsum dolor")).toEqual(["Lorem ipsum"]);
  expect(placeholders("Hello {{firstName}}")).toEqual(["{{firstName}}"]);
  expect(placeholders("[Insert testimonial]")).toEqual([
    "[Insert testimonial]",
  ]);
  expect(placeholders("TODO: pricing")).toEqual(["TODO"]);
  expect(placeholders("Headline goes here")).toEqual(["Headline goes here"]);
  expect(placeholders("Your todo list, sorted")).toEqual([]);
  expect(placeholders("Acme Placeholder Co", ["acme placeholder"])).toEqual([
    "Acme Placeholder",
  ]);
});

test("sortFindingDrafts applies priority after severity and is unchanged without it", () => {
  const draft = (
    fingerprint: string,
    severity: "major" | "minor",
    confidence: number,
    focus?: "jargon",
  ) =>
    ({
      selectorHint: fingerprint,
      stableOrder: 0,
      finding: {
        fingerprint,
        severity,
        confidence,
        layer: "model",
        ...(focus === undefined ? {} : { focus }),
      },
    }) as unknown as FindingDraft;
  const drafts = [
    draft("a", "major", 0.9),
    draft("b", "major", 0.5, "jargon"),
    draft("c", "minor", 0.9, "jargon"),
  ];
  const order = (sorted: FindingDraft[]) =>
    sorted.map((entry) => entry.finding.fingerprint);
  expect(order(sortFindingDrafts(drafts))).toEqual(["a", "b", "c"]);
  expect(
    order(
      sortFindingDrafts(drafts, (entry) =>
        entry.finding.focus === "jargon" ? 0 : 1,
      ),
    ),
  ).toEqual(["b", "a", "c"]);
});

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { observationArtifactSchema } from "../src/checks/artifact-schema.js";
import { loadTokenDeclarations } from "../src/checks/observe.js";
import {
  checksConfigFrom,
  runDeterministicChecks,
} from "../src/checks/registry.js";
import { reportsInteractiveOverlap } from "../src/checks/responsive-break.js";
import { spacingRhythmCheck } from "../src/checks/spacing-rhythm.js";
import type {
  CheckTuple,
  ExpandedObservedStyles,
  ObservationArtifact,
  ObservationArtifactV2,
  ObservedElement,
  ObservedElementV2,
} from "../src/checks/types.js";
import {
  findingFingerprint,
  findingFingerprintIdentity,
} from "../src/review/fingerprint.js";

import {
  checksConfigSchema,
  defaultChecksSettings,
} from "../src/schemas/project.js";

const styles: ObservedElement["styles"] = {
  color: "rgb(0, 0, 0)",
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
  outlineStyle: "none",
  fill: "none",
  stroke: "none",
  borderTopLeftRadius: "0px",
  borderTopRightRadius: "0px",
  borderBottomRightRadius: "0px",
  borderBottomLeftRadius: "0px",
  overflowX: "visible",
  overflowY: "visible",
  position: "static",
};

const expandedStyles: ExpandedObservedStyles = {
  ...styles,
  display: "block",
  visibility: "visible",
  opacity: "1",
  fontFamily: "sans-serif",
  fontSize: "16px",
  fontWeight: "400",
  lineHeight: "normal",
  letterSpacing: "normal",
  textAlign: "start",
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

function element(overrides: Partial<ObservedElement>): ObservedElement {
  return {
    selector: "button.action",
    tag: "button",
    text: "Action",
    visible: true,
    interactive: true,
    enabled: true,
    rect: { x: 0, y: 0, width: 44, height: 44 },
    scrollWidth: 44,
    scrollHeight: 44,
    clientWidth: 44,
    clientHeight: 44,
    outOfFlow: false,
    ancestorSelectors: [],
    styles,
    hitTestWith: [],
    ...overrides,
  };
}

function observations(elements: ObservedElement[] = []): ObservationArtifact {
  return {
    version: 1,
    viewport: { width: 320, height: 600 },
    document: {
      scrollWidth: 320,
      scrollHeight: 600,
      clientWidth: 320,
      clientHeight: 600,
    },
    elements,
    headings: [{ selector: "h1", level: 1, text: "Title" }],
    tokens: { status: "not-configured" },
  };
}

function v2Element(
  overrides: Partial<ObservedElementV2> &
    Pick<ObservedElementV2, "selector" | "tag" | "structuralPath">,
): ObservedElementV2 {
  const base = element({
    selector: overrides.selector,
    tag: overrides.tag,
    interactive: false,
    rect: { x: 0, y: 0, width: 320, height: 600 },
  });
  const rect = overrides.rect ?? base.rect;
  return {
    ...base,
    ...overrides,
    legacyRenderedPath:
      overrides.legacyRenderedPath ?? overrides.structuralPath,
    directText: overrides.directText ?? overrides.text ?? "",
    attributes: overrides.attributes ?? {},
    temporal: overrides.temporal ?? false,
    stableIslandPath: overrides.stableIslandPath ?? "html[0]/body[0]/main[0]",
    relativeRect: overrides.relativeRect ?? rect,
    styles: overrides.styles ?? expandedStyles,
    rect,
  };
}

function v2Observations(
  elements: ObservedElementV2[],
  viewport = { width: 320, height: 600 },
): ObservationArtifact {
  return {
    version: 2,
    viewport,
    document: {
      scrollWidth: viewport.width,
      scrollHeight: viewport.height,
      clientWidth: viewport.width,
      clientHeight: viewport.height,
    },
    elements,
    headings: [],
    tokens: { status: "not-configured" },
    maskMembership: [],
  };
}

function rhythmElements(clearances: number[]): ObservedElementV2[] {
  const result = [
    v2Element({
      selector: "html",
      tag: "html",
      structuralPath: "html[0]",
    }),
    v2Element({
      selector: "body",
      tag: "body",
      structuralPath: "html[0]/body[0]",
    }),
    v2Element({
      selector: "main.settings",
      tag: "main",
      structuralPath: "html[0]/body[0]/main[0]",
      rect: { x: 20, y: 10, width: 280, height: 570 },
    }),
  ];
  clearances.forEach((clearance, index) => {
    const sectionY = 20 + index * 90;
    const sectionHeight = 10 + 44 + clearance;
    const sectionPath = `html[0]/body[0]/main[0]/section[${index}]`;
    result.push(
      v2Element({
        selector: `section.action-${index + 1}`,
        tag: "section",
        structuralPath: sectionPath,
        rect: { x: 30, y: sectionY, width: 260, height: sectionHeight },
      }),
      v2Element({
        selector: `button.action-${index + 1}`,
        tag: "button",
        structuralPath: `${sectionPath}/button[0]`,
        interactive: true,
        rect: { x: 40, y: sectionY + 10, width: 120, height: 44 },
        text: `Action ${index + 1}`,
        directText: `Action ${index + 1}`,
      }),
    );
  });
  const outlierBottom =
    20 + (clearances.length - 1) * 90 + 54 + (clearances.at(-1) ?? 0);
  result.push(
    v2Element({
      selector: "hr.actions-rule",
      tag: "hr",
      structuralPath: `html[0]/body[0]/main[0]/hr[0]`,
      rect: { x: 30, y: outlierBottom, width: 260, height: 1 },
    }),
  );
  return result;
}

function tuple(overrides: Partial<CheckTuple> = {}): CheckTuple {
  return {
    flow: "booking",
    state: "ready",
    viewport: "phone",
    width: 320,
    height: 600,
    metadataPath: "ready/phone/metadata.json",
    artifactPaths: ["ready/phone/metadata.json"],
    commit: "abc123",
    createdAt: "2026-08-14T12:00:00.000Z",
    observations: observations(),
    axe: { violations: [] },
    console: [],
    mismatches: [],
    ...overrides,
  };
}

describe("deterministic checks", () => {
  test("only the legacy scalar scheme inherits scheme-less fingerprint aliases", () => {
    const input = {
      category: "contrast",
      flow: "booking",
      state: "ready",
      rule: "axe:color-contrast",
      selectorHint: "button.secondary.primary",
    };
    const historical = findingFingerprintIdentity(input);
    const dark = findingFingerprintIdentity({
      ...input,
      colorScheme: "dark",
      legacyColorScheme: "dark",
    });
    const light = findingFingerprintIdentity({
      ...input,
      colorScheme: "light",
      legacyColorScheme: "dark",
    });
    expect(dark.aliases).toEqual(
      expect.arrayContaining([historical.fingerprint, ...historical.aliases]),
    );
    expect(light.aliases).not.toContain(historical.fingerprint);
    expect(light.fingerprint).not.toBe(dark.fingerprint);
  });

  test("reports an inert scheme only for an authoritative complete v2 grid", () => {
    const renderedElement: ObservedElementV2 = {
      ...element({
        selector: "main",
        tag: "main",
        text: "Theme surface",
        interactive: false,
      }),
      structuralPath: "html[0]/body[0]/main[0]",
      legacyRenderedPath: "html[0]/body[0]/main[0]",
      directText: "Theme surface",
      attributes: {},
      temporal: false,
      stableIslandPath: "html[0]/body[0]/main[0]",
      relativeRect: { x: 0, y: 0, width: 44, height: 44 },
      styles: expandedStyles,
    };
    const artifact = (color: string): ObservationArtifact => ({
      version: 2,
      viewport: { width: 320, height: 600 },
      document: {
        scrollWidth: 320,
        scrollHeight: 600,
        clientWidth: 320,
        clientHeight: 600,
      },
      elements: [
        {
          ...renderedElement,
          styles: { ...renderedElement.styles, color },
        },
      ],
      headings: [],
      tokens: { status: "not-configured" },
      maskMembership: [],
    });
    const light = tuple({
      colorScheme: "light",
      colorSchemeAxis: true,
      observations: artifact("rgb(24, 24, 24)"),
      metadataPath: "ready/phone/light/metadata.json",
      screenshotPath: "ready/phone/light/screenshot.png",
      artifactPaths: ["ready/phone/light/metadata.json"],
    });
    const dark = tuple({
      colorScheme: "dark",
      colorSchemeAxis: true,
      observations: artifact("rgb(24, 24, 24)"),
      metadataPath: "ready/phone/dark/metadata.json",
      screenshotPath: "ready/phone/dark/screenshot.png",
      artifactPaths: ["ready/phone/dark/metadata.json"],
    });
    const expected = ["ready\0phone\0light", "ready\0phone\0dark"];
    const candidates = runDeterministicChecks(
      [light, dark],
      expected,
    ).candidates;
    expect(
      candidates.filter(
        ({ candidate }) => candidate.rule === "idiom:missing-color-scheme",
      ),
    ).toHaveLength(1);
    expect(
      runDeterministicChecks(
        [
          light,
          {
            ...dark,
            observations: artifact("rgb(240, 240, 240)"),
          },
        ],
        expected,
      ).candidates.some(
        ({ candidate }) => candidate.rule === "idiom:missing-color-scheme",
      ),
    ).toBe(false);
    expect(
      runDeterministicChecks([light, dark]).candidates.some(
        ({ candidate }) => candidate.rule === "idiom:missing-color-scheme",
      ),
    ).toBe(false);
    expect(
      runDeterministicChecks([light], expected).candidates.some(
        ({ candidate }) => candidate.rule === "idiom:missing-color-scheme",
      ),
    ).toBe(false);
  });

  test("defines unavailable coverage for a capture with no viewport tuples", () => {
    const result = runDeterministicChecks([]);
    expect(result.narrowWidth).toBeUndefined();
    expect(result.captureCoverage).toEqual(
      expect.arrayContaining([
        {
          check: "responsive-break",
          status: "unavailable",
          reason: "the capture has no viewport tuples",
        },
        {
          check: "target-size",
          status: "unavailable",
          reason: "the capture has no viewport tuples",
        },
      ]),
    );
  });

  test("parses nested token declarations and skips file I/O when undeclared", async () => {
    const missingDirectory = join(
      tmpdir(),
      "idiom-directory-that-does-not-exist",
    );
    await expect(
      loadTokenDeclarations(missingDirectory, undefined),
    ).resolves.toEqual({ status: "not-configured" });
    const directory = await mkdtemp(join(tmpdir(), "idiom-tokens-"));
    try {
      await writeFile(
        join(directory, "theme.css"),
        ":root { --ink: #111; } @media (min-width: 1px) { :root { --radius: 8px; } }",
      );
      await expect(
        loadTokenDeclarations(directory, "theme.css"),
      ).resolves.toMatchObject({
        status: "configured",
        declarations: { "--ink": "#111", "--radius": "8px" },
        values: ["#111", "8px"],
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  describe("configured target sizes", () => {
    const settings = { fine: 24, coarse: 44, narrowBelow: 768 };
    const targets = (tuples: CheckTuple[], configured = true) =>
      runDeterministicChecks(
        tuples,
        undefined,
        checksConfigFrom(
          configured
            ? checksConfigSchema.parse({ targetSize: settings })
            : defaultChecksSettings,
        ),
      ).candidates.filter(
        ({ candidate }) => candidate.category === "target-size",
      );
    const compact = (
      width: number,
      size = 32,
      input?: ObservationArtifactV2["input"],
    ) =>
      tuple({
        viewport: width >= 768 ? "desktop" : "mobile",
        width,
        observations: {
          ...v2Observations(
            [
              v2Element({
                selector: "button.tool",
                tag: "button",
                structuralPath: "html[0]/body[0]/button[0]",
                interactive: true,
                rect: { x: 0, y: 0, width: size, height: size },
              }),
            ],
            { width, height: 900 },
          ),
          version: 2,
          maskMembership: [],
          ...(input === undefined ? {} : { input }),
        } as ObservationArtifactV2,
      });

    test("32px tools pass at 1440 and fail at 390", () => {
      const found = targets([compact(1440), compact(390)]);
      expect(found).toHaveLength(1);
      expect(found[0]?.tuple.width).toBe(390);
      expect(found[0]?.candidate.explanation).toContain(
        "at mobile (narrower than 768px, minimum 44)",
      );
      expect(found[0]?.candidate.verification).toMatchObject({
        params: { selector: "button.tool", minimum: 44, inputClass: "narrow" },
      });
    });

    test("fine-pointer failures state the viewport and applied minimum", () => {
      const crowded = compact(1440, 20);
      crowded.observations?.elements.push(
        v2Element({
          selector: "button.neighbor",
          tag: "button",
          structuralPath: "body[0]/button[1]",
          interactive: true,
          rect: { x: 20, y: 0, width: 44, height: 44 },
        }),
      );
      const found = targets([crowded]);
      expect(found).toHaveLength(1);
      expect(found[0]?.candidate.explanation).toContain(
        "20×20 at desktop (fine pointer, minimum 24)",
      );
      expect(found[0]?.candidate.acceptance).toEqual([
        "button.tool has a clickable region containing a 24×24 CSS pixel square or sufficient spacing for its 24px circle to avoid other targets and undersized target circles at desktop.",
      ]);
      expect(found[0]?.candidate.verification).toMatchObject({
        params: { minimum: 24, inputClass: "fine" },
      });
    });

    test.each([
      { pointer: "coarse", hover: "none", maxTouchPoints: 5 },
      { pointer: "fine", hover: "hover", maxTouchPoints: 1 },
      { pointer: "coarse", hover: "hover", maxTouchPoints: 0 },
      { pointer: "fine", hover: "none", maxTouchPoints: 0 },
    ] as const)("touch or no hover uses coarse minimum: %j", (input) => {
      const found = targets([compact(1440, 32, input)]);
      expect(found).toHaveLength(1);
      expect(found[0]?.candidate.explanation).toContain("(touch, minimum 44)");
    });

    test("the breakpoint is exclusive and exactly 24px passes fine", () => {
      expect(targets([compact(768, 24)])).toEqual([]);
      expect(targets([compact(767, 24)])[0]?.candidate.explanation).toContain(
        "narrower than 768px",
      );
      expect(
        targets([
          compact(390, 32, {
            pointer: "coarse",
            hover: "none",
            maxTouchPoints: 1,
          }),
        ])[0]?.candidate.verification,
      ).toMatchObject({ params: { inputClass: "narrow" } });
    });

    test("unconfigured desktop uses fine-pointer defaults", () => {
      expect(targets([compact(1440)], false)).toEqual([]);
      expect(targets([compact(1440, 20)], false)).toEqual([]);
    });

    test("configuration is optional, strict, positive and ordered", () => {
      expect(defaultChecksSettings.targetSize).toBeUndefined();
      expect(checksConfigFrom().targetSize).toBeUndefined();
      expect(
        checksConfigSchema.parse({ targetSize: { fine: 24 } }).targetSize,
      ).toEqual(settings);
      for (const targetSize of [
        { fine: 44, coarse: 24 },
        { fine: 0 },
        { coarse: -1 },
        { narrowBelow: 0 },
        { fine: Number.POSITIVE_INFINITY },
        { extra: 24 },
      ])
        expect(checksConfigSchema.safeParse({ targetSize }).success).toBe(
          false,
        );
    });

    test("input signals validate while older artifacts remain readable", () => {
      const observed = compact(1440, 32, {
        pointer: "fine",
        hover: "hover",
        maxTouchPoints: 0,
      }).observations;
      expect(observationArtifactSchema.safeParse(observed).success).toBe(true);
      const { input: _input, ...older } = observed as ObservationArtifactV2;
      expect(observationArtifactSchema.safeParse(older).success).toBe(true);
      expect(
        observationArtifactSchema.safeParse({
          ...older,
          input: { pointer: "fine", hover: "hover", maxTouchPoints: -1 },
        }).success,
      ).toBe(false);
    });
  });

  test("selects narrow viewports by measured width and keeps the 44px boundary", () => {
    const result = runDeterministicChecks([
      tuple({ viewport: "wide", width: 900 }),
      tuple({
        viewport: "phone",
        width: 320,
        observations: observations([
          element({ selector: "button.boundary" }),
          element({
            selector: "button.small",
            rect: { x: 0, y: 0, width: 43, height: 44 },
          }),
        ]),
      }),
    ]);
    expect(result.narrowWidth).toBe(320);
    expect(
      result.candidates
        .filter(({ candidate }) => candidate.category === "target-size")
        .map(({ tuple: item, candidate }) => [
          item.viewport,
          candidate.selectorHint,
        ]),
    ).toEqual([["phone", "button.small"]]);
  });

  test("reports responsive-break not applicable off the minimum width while target-size runs everywhere", () => {
    const small = () =>
      observations([
        element({
          selector: "button.small",
          rect: { x: 0, y: 0, width: 43, height: 44 },
        }),
      ]);
    const result = runDeterministicChecks([
      tuple({ viewport: "wide", width: 900, observations: small() }),
      tuple({ viewport: "phone", width: 320, observations: small() }),
    ]);
    const coverage = (check: string, viewport: string) =>
      result.coverage.find(
        (entry) =>
          entry.coverage.check === check && entry.tuple.viewport === viewport,
      )?.coverage;
    expect(coverage("responsive-break", "wide")).toEqual({
      check: "responsive-break",
      status: "not-applicable",
      reason: "evaluated only at the minimum captured CSS width",
    });
    expect(coverage("responsive-break", "phone")?.status).toBe("ran");
    expect(coverage("target-size", "wide")?.status).toBe("ran");
    expect(coverage("target-size", "phone")?.status).toBe("ran");
  });

  test("excludes canonical visually hidden controls from geometry findings", () => {
    const clipped = {
      ...styles,
      overflowX: "hidden",
      overflowY: "hidden",
    };
    const result = runDeterministicChecks([
      tuple({
        observations: observations([
          element({
            selector: "a.sr-only",
            rect: { x: 0, y: 0, width: 1, height: 1 },
            scrollWidth: 97,
            scrollHeight: 18,
            clientWidth: 1,
            clientHeight: 1,
            outOfFlow: true,
            styles: clipped,
          }),
          element({
            selector: "button.tiny-clipped",
            rect: { x: 0, y: 0, width: 1, height: 1 },
            scrollWidth: 97,
            scrollHeight: 18,
            clientWidth: 1,
            clientHeight: 1,
            styles: clipped,
          }),
        ]),
      }),
    ]);
    const geometryHints = result.candidates
      .filter(({ candidate }) =>
        ["overflow-clip", "target-size"].includes(candidate.category),
      )
      .map(({ candidate }) => candidate.selectorHint);
    expect(geometryHints).not.toContain("a.sr-only");
    expect(geometryHints).toEqual([
      "button.tiny-clipped",
      "button.tiny-clipped",
    ]);
  });

  test("distinguishes declared ellipsis from accidental horizontal clipping", () => {
    const clipped = {
      ...styles,
      overflowX: "hidden",
    };
    const result = runDeterministicChecks([
      tuple({
        observations: observations([
          element({
            selector: "div.ellipsis",
            interactive: false,
            scrollWidth: 304,
            clientWidth: 120,
            styles: { ...clipped, textOverflow: "ellipsis" },
          }),
          element({
            selector: "div.clipped",
            interactive: false,
            scrollWidth: 304,
            clientWidth: 120,
            styles: { ...clipped, textOverflow: "clip" },
          }),
          element({
            selector: "div.legacy-clipped",
            interactive: false,
            scrollWidth: 304,
            clientWidth: 120,
            styles: clipped,
          }),
        ]),
      }),
    ]);
    expect(
      result.candidates
        .filter(({ candidate }) => candidate.category === "overflow-clip")
        .map(({ candidate }) => candidate.selectorHint),
    ).toEqual(["div.clipped", "div.legacy-clipped"]);
  });

  test("exempts unpadded inline links without hiding genuine small targets", () => {
    const result = runDeterministicChecks([
      tuple({
        observations: observations([
          element({
            selector: "a.terms",
            tag: "a",
            rect: { x: 0, y: 0, width: 80, height: 18 },
            inlineTextTarget: true,
          }),
          element({
            selector: "a.footer-link",
            tag: "a",
            rect: { x: 0, y: 0, width: 80, height: 18 },
            inlineTextTarget: true,
          }),
          element({
            selector: "button.small",
            tag: "button",
            rect: { x: 0, y: 0, width: 40, height: 40 },
            inlineTextTarget: false,
          }),
          element({
            selector: "input.small",
            tag: "input",
            rect: { x: 0, y: 0, width: 40, height: 40 },
            inlineTextTarget: false,
          }),
          element({
            selector: "a.padded-link",
            tag: "a",
            rect: { x: 0, y: 0, width: 40, height: 24 },
            inlineTextTarget: false,
          }),
          element({
            selector: "a.block-link",
            tag: "a",
            rect: { x: 0, y: 0, width: 40, height: 18 },
            inlineTextTarget: false,
          }),
        ]),
      }),
    ]);
    expect(
      result.candidates
        .filter(({ candidate }) => candidate.category === "target-size")
        .map(({ candidate }) => candidate.selectorHint),
    ).toEqual(["button.small", "input.small", "a.padded-link", "a.block-link"]);
  });

  test("excludes horizontally off-screen targets but keeps vertical and partial targets", () => {
    const result = runDeterministicChecks([
      tuple({
        observations: observations([
          element({
            selector: "a.drawer-left",
            rect: { x: -280, y: 0, width: 280, height: 36 },
            outOfFlow: true,
          }),
          element({
            selector: "a.drawer-right",
            rect: { x: 320, y: 0, width: 280, height: 36 },
            outOfFlow: true,
          }),
          element({
            selector: "button.below-fold",
            rect: { x: 0, y: 700, width: 40, height: 40 },
            outOfFlow: true,
          }),
          element({
            selector: "button.partially-visible",
            rect: { x: -20, y: 0, width: 40, height: 40 },
            outOfFlow: true,
          }),
        ]),
      }),
    ]);
    expect(
      result.candidates
        .filter(({ candidate }) => candidate.category === "target-size")
        .map(({ candidate }) => candidate.selectorHint),
    ).toEqual(["button.below-fold", "button.partially-visible"]);
  });

  test("emits one document-overflow finding at the narrow viewport", () => {
    const observed = observations();
    observed.document.scrollWidth = 360;
    observed.elements = [
      element({
        selector: "html",
        tag: "html",
        interactive: false,
        scrollWidth: 360,
        clientWidth: 320,
        styles: { ...styles, overflowX: "hidden" },
      }),
      element({
        selector: "body",
        tag: "body",
        interactive: false,
        scrollWidth: 360,
        clientWidth: 320,
        styles: { ...styles, overflowX: "hidden" },
      }),
    ];
    const result = runDeterministicChecks([
      tuple({ observations: observed }),
    ]).candidates.filter(
      ({ candidate }) => candidate.category === "overflow-clip",
    );
    expect(result).toHaveLength(1);
    expect(result[0]?.candidate).toMatchObject({
      category: "overflow-clip",
      rule: "idiom:document-horizontal-overflow",
      selectorHint: "document",
    });
  });

  test("requires live hit-test confirmation and excludes out-of-flow overlaps", () => {
    const normal = element({
      selector: "button.first",
      hitTestWith: ["button.second", "button.fixed"],
    });
    const second = element({ selector: "button.second" });
    const fixed = element({ selector: "button.fixed", outOfFlow: true });
    const result = runDeterministicChecks([
      tuple({ observations: observations([normal, second, fixed]) }),
    ]);
    expect(
      result.candidates
        .filter(
          ({ candidate }) => candidate.rule === "idiom:interactive-overlap",
        )
        .map(({ candidate }) => candidate.selectorHint),
    ).toEqual(["button.first | button.second"]);
  });

  test("a not-applicable responsive-break tuple counts as clear for acceptance", async () => {
    const { buildRuleContract } = await import("../src/findings/contract.js");
    const { evaluateRuleAcceptance } = await import(
      "../src/verify/acceptance.js"
    );
    const config = checksConfigFrom();
    const overlapping = observations([
      element({ selector: "button.first", hitTestWith: ["button.second"] }),
      element({ selector: "button.second" }),
    ]);
    const wide = tuple({ viewport: "wide", width: 900 });
    const phone = tuple({ observations: overlapping });
    const before = [wide, phone];
    const found = runDeterministicChecks(
      before,
      undefined,
      config,
    ).candidates.find(
      ({ candidate }) => candidate.rule === "idiom:interactive-overlap",
    );
    if (!found) throw new Error("expected interactive overlap");
    const { acceptance } = buildRuleContract(
      found.tuple,
      found.candidate,
      config,
      before,
    );
    expect(acceptance.requiredCoordinates).toContainEqual(
      expect.objectContaining({ viewport: "wide" }),
    );
    const fixed = [
      wide,
      tuple({
        observations: observations([
          element({ selector: "button.first" }),
          element({ selector: "button.second" }),
        ]),
      }),
    ];
    expect(
      evaluateRuleAcceptance({
        contract: acceptance,
        currentA: fixed,
        currentB: fixed,
        config,
      }).status,
    ).toBe("passed");
  });

  describe("joined controls", () => {
    const bordered: ObservedElement["styles"] = {
      ...styles,
      borderTopWidth: "1px",
      borderRightWidth: "1px",
      borderBottomWidth: "1px",
      borderLeftWidth: "1px",
      borderTopColor: "rgb(222, 226, 230)",
      borderRightColor: "rgb(222, 226, 230)",
      borderBottomColor: "rgb(222, 226, 230)",
      borderLeftColor: "rgb(222, 226, 230)",
    };
    const promo = (
      buttonRect: ObservedElement["rect"],
      buttonStyles: Partial<ObservedElement["styles"]> = {},
      inputRect: ObservedElement["rect"] = {
        x: 0,
        y: 0,
        width: 250,
        height: 38,
      },
    ) => {
      const input = v2Element({
        selector: "input.promo",
        tag: "input",
        structuralPath: "html[0]/body[0]/form[0]/input[0]",
        interactive: true,
        rect: inputRect,
        styles: { ...expandedStyles, ...bordered },
        hitTestWith: ["button.redeem"],
      });
      const button = v2Element({
        selector: "button.redeem",
        tag: "button",
        structuralPath: "html[0]/body[0]/form[0]/button[0]",
        interactive: true,
        rect: buttonRect,
        styles: { ...expandedStyles, ...bordered, ...buttonStyles },
        hitTestWith: ["input.promo"],
      });
      return { input, button };
    };
    const intersection = (
      a: ObservedElement["rect"],
      b: ObservedElement["rect"],
    ) => {
      const x = Math.max(a.x, b.x);
      const y = Math.max(a.y, b.y);
      return {
        x,
        y,
        width: Math.min(a.x + a.width, b.x + b.width) - x,
        height: Math.min(a.y + a.height, b.y + b.height) - y,
      };
    };
    const overlapRules = (pair: {
      input: ObservedElementV2;
      button: ObservedElementV2;
    }) => {
      const observed = v2Observations([pair.input, pair.button]);
      if (observed.version === 2)
        observed.overlaps = [
          {
            a: "button.redeem",
            b: "input.promo",
            kinds: ["interactive", "interactive"],
            rect: intersection(pair.input.rect, pair.button.rect),
            partial: [],
            samples: 4,
            hits: 4,
          },
        ];
      return runDeterministicChecks([tuple({ observations: observed })])
        .candidates.map(({ candidate }) => candidate)
        .filter(
          (candidate) =>
            candidate.rule === "idiom:interactive-overlap" ||
            candidate.rule === "idiom:elements-overlap",
        )
        .map((candidate) => `${candidate.rule} ${candidate.severity}`);
    };

    test("an input group's 1px shared border is not an overlap, in either rule", () => {
      expect(
        overlapRules(promo({ x: 249, y: 0, width: 80, height: 38 })),
      ).toEqual([]);
      // Sub-pixel layout measures the collapsed border a hair over 1px.
      expect(
        overlapRules(promo({ x: 249.0000153, y: 0, width: 80, height: 38 })),
      ).toEqual([]);
      // Stacked groups join on the vertical axis.
      expect(
        overlapRules(
          promo(
            { x: 0, y: 37, width: 250, height: 38 },
            {},
            { x: 0, y: 0, width: 250, height: 38 },
          ),
        ),
      ).toEqual([]);
    });

    test("the predicate drops a joined pair in both argument orders", () => {
      const { input, button } = promo({ x: 249, y: 0, width: 80, height: 38 });
      expect(reportsInteractiveOverlap(input, button, true)).toBe(false);
      expect(reportsInteractiveOverlap(button, input, true)).toBe(false);
    });

    test("thicker, unbordered, rounded, corner-clipped and click-stealing overlaps are still reported", () => {
      const reported = ["idiom:interactive-overlap major"];
      // 2px overlap with shared borders.
      expect(
        overlapRules(promo({ x: 248, y: 0, width: 80, height: 38 })),
      ).toEqual(reported);
      // No border on the button's facing side.
      expect(
        overlapRules(
          promo(
            { x: 249, y: 0, width: 80, height: 38 },
            { borderLeftWidth: "0px" },
          ),
        ),
      ).toEqual(reported);
      // Transparent facing border.
      expect(
        overlapRules(
          promo(
            { x: 249, y: 0, width: 80, height: 38 },
            { borderLeftColor: "rgba(0, 0, 0, 0)" },
          ),
        ),
      ).toEqual(reported);
      // Rounded facing corners: two pills, not a group.
      expect(
        overlapRules(
          promo(
            { x: 249, y: 0, width: 80, height: 38 },
            { borderTopLeftRadius: "8px", borderBottomLeftRadius: "8px" },
          ),
        ),
      ).toEqual(reported);
      // A 1px corner clip, not an edge-to-edge join.
      expect(
        overlapRules(promo({ x: 249, y: 34, width: 80, height: 38 })),
      ).toEqual(reported);
      // The button sits on the field: it steals clicks.
      expect(
        overlapRules(promo({ x: 200, y: 0, width: 80, height: 38 })),
      ).toEqual(reported);
    });
  });

  test("maps axe, console, heading, token, and missing-state evidence", () => {
    const observed = observations([
      element({
        selector: "p.copy",
        interactive: false,
        styles: { ...styles, color: "rgb(1, 2, 3)" },
      }),
    ]);
    observed.headings = [{ selector: "h3", level: 3, text: "Skipped" }];
    observed.tokens = {
      status: "configured",
      source: "theme.css",
      declarations: { "--ink": "#000" },
      normalizedValues: ["rgb(0, 0, 0)"],
    };
    const result = runDeterministicChecks([
      tuple({
        observations: observed,
        axe: {
          violations: [
            {
              id: "color-contrast",
              impact: "serious",
              nodes: [{ target: ["p.copy"], html: "<p>copy</p>" }],
            },
            {
              id: "button-name",
              impact: "critical",
              nodes: [{ target: ["button"] }],
            },
            {
              id: "heading-order",
              impact: "moderate",
              nodes: [{ target: ["h3"] }],
            },
          ],
        },
        console: [
          { type: "log", text: "fine" },
          { type: "pageerror", text: "boom" },
        ],
        mismatches: [{ kind: "text-present", expected: "Ready" }],
      }),
    ]);
    const categories = result.candidates.map(
      ({ candidate }) => candidate.category,
    );
    expect(categories).toEqual(
      expect.arrayContaining([
        "contrast",
        "a11y-label",
        "heading-structure",
        "token-drift",
        "console-error",
        "missing-state",
      ]),
    );
    expect(
      result.candidates.filter(
        ({ candidate }) => candidate.rule === "idiom:heading-level-skip",
      ),
    ).toHaveLength(0);
  });

  test("all ten deterministic producers keep configured repository paths out of criteria", () => {
    const first = element({
      selector: "button.first",
      rect: { x: 0, y: 0, width: 30, height: 30 },
      hitTestWith: ["button.second"],
      styles: { ...styles, color: "rgb(1, 2, 3)" },
    });
    const second = element({ selector: "button.second" });
    const observed = observations([first, second]);
    observed.document.scrollWidth = 360;
    observed.tokens = {
      status: "configured",
      source: "packages/design/src/theme.css",
      declarations: { "--ink": "#000" },
      normalizedValues: ["rgb(0, 0, 0)"],
    };
    const result = runDeterministicChecks([
      tuple({
        observations: observed,
        axe: {
          violations: [
            {
              id: "color-contrast",
              impact: "serious",
              nodes: [{ target: ["p.copy"] }],
            },
            {
              id: "button-name",
              impact: "critical",
              nodes: [{ target: ["button.first"] }],
            },
            {
              id: "heading-order",
              impact: "moderate",
              nodes: [{ target: ["h3"] }],
            },
          ],
        },
        console: [{ type: "pageerror", text: "boom" }],
        mismatches: [{ kind: "text-present", expected: "Ready" }],
      }),
      tuple({
        state: "settings",
        observations: v2Observations(rhythmElements([16, 16, 16, 0])),
      }),
    ]);
    expect(
      new Set(result.candidates.map(({ candidate }) => candidate.category)),
    ).toEqual(
      new Set([
        "overflow-clip",
        "responsive-break",
        "contrast",
        "a11y-label",
        "target-size",
        "heading-structure",
        "token-drift",
        "console-error",
        "missing-state",
        "spacing-rhythm",
      ]),
    );
    for (const { candidate } of result.candidates) {
      for (const criterion of candidate.acceptance) {
        expect(criterion).not.toContain("packages/design/src/theme.css");
        expect(criterion).not.toMatch(/(?:^|\s)(?:src|apps|packages)\//);
      }
    }
  });

  test("derives a spacing-rhythm outlier from comparable run observations", () => {
    const settings = tuple({
      state: "settings",
      viewport: "desktop",
      width: 320,
      height: 600,
      screenshotPath: "settings/desktop/screenshot.png",
      artifactPaths: [
        "settings/desktop/metadata.json",
        "settings/desktop/observations.json",
      ],
      observations: v2Observations(rhythmElements([16, 16, 16, 0])),
    });
    const findings = runDeterministicChecks([settings]).candidates.filter(
      ({ candidate }) => candidate.category === "spacing-rhythm",
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      tuple: settings,
      checkOrder: 9,
      candidate: {
        severity: "minor",
        rule: "idiom:spacing-rhythm-outlier",
        selectorHint: expect.stringContaining(
          "button.action-4::boundary-below",
        ),
        verification: {
          check: "spacing-rhythm",
          params: {
            placement: {
              structuralPath: expect.stringContaining("section[3]/button[0]"),
              kind: "button",
              side: "boundary-below",
            },
            fullFlow: true,
          },
        },
        evidenceTuples: [settings],
      },
    });
    expect(findings[0]?.candidate.explanation).toContain(
      "0 CSS px clearance below",
    );
    expect(findings[0]?.candidate.explanation).toContain(
      "prevailing clearance is 16 CSS px, supported by 3 observed placements",
    );
    expect(findings[0]?.candidate.explanation).toContain("settings/desktop");
  });

  test("counts distinct placements rather than repeated scheme captures", () => {
    const captured = (
      state: string,
      colorScheme: "light" | "dark",
      clearances: number[],
    ) =>
      tuple({
        state,
        colorScheme,
        colorSchemeAxis: true,
        metadataPath: `${state}/desktop/${colorScheme}/metadata.json`,
        observations: v2Observations(rhythmElements(clearances)),
      });
    const result = runDeterministicChecks([
      captured("home", "light", [16]),
      captured("home", "dark", [16]),
      captured("settings", "light", [16, 0]),
      captured("settings", "dark", [16, 0]),
    ]);
    expect(
      result.candidates.filter(
        ({ candidate }) => candidate.category === "spacing-rhythm",
      ),
    ).toEqual([]);
  });

  test("prefers prevailing evidence from the outlier's scheme", () => {
    const captured = (
      state: string,
      colorScheme: "light" | "dark",
      clearances: number[],
      outlier = false,
    ) => {
      const elements = rhythmElements(clearances);
      if (outlier) {
        for (const element of elements) {
          element.structuralPath = element.structuralPath.replace(
            "section[0]",
            "section[3]",
          );
          element.selector = element.selector.replace("action-1", "action-4");
        }
      }
      return tuple({
        state,
        viewport: "desktop",
        colorScheme,
        colorSchemeAxis: true,
        metadataPath: `${state}/desktop/${colorScheme}/metadata.json`,
        screenshotPath: `${state}/desktop/${colorScheme}/screenshot.png`,
        observations: v2Observations(elements),
      });
    };
    const tuples = [
      captured("alpha", "dark", [16, 16, 16]),
      captured("alpha", "light", [16, 16, 16]),
      captured("settings", "dark", [0], true),
      captured("settings", "light", [0], true),
    ];
    const findings = runDeterministicChecks(tuples).candidates.filter(
      ({ candidate }) => candidate.category === "spacing-rhythm",
    );
    expect(findings).toHaveLength(2);
    for (const { tuple: outlier, candidate } of findings) {
      expect(candidate.explanation).toContain(
        "supported by 3 observed placements",
      );
      const exemplar = candidate.evidenceTuples?.[1];
      expect(exemplar?.colorScheme).toBe(outlier.colorScheme);
      expect(candidate.explanation).toContain(
        `/${outlier.colorScheme ?? "light"}`,
      );
    }
  });

  test("counts one structural placement once across multiple states", () => {
    const captured = (state: string, clearance: number, outlier = false) => {
      const elements = rhythmElements([clearance]);
      if (outlier) {
        for (const element of elements) {
          element.structuralPath = element.structuralPath.replace(
            "section[0]",
            "section[3]",
          );
          element.selector = element.selector.replace("action-1", "action-4");
        }
      }
      return tuple({
        state,
        metadataPath: `${state}/desktop/metadata.json`,
        observations: v2Observations(elements),
      });
    };
    const result = runDeterministicChecks([
      captured("filtered", 16),
      captured("dialog-open", 16),
      captured("saved", 16),
      captured("settings", 0, true),
    ]);
    expect(
      result.candidates.filter(
        ({ candidate }) => candidate.category === "spacing-rhythm",
      ),
    ).toEqual([]);
  });

  test("still evaluates state measurements when one placement changes clearance", () => {
    const captured = (state: string, clearances: number[]) =>
      tuple({
        state,
        metadataPath: `${state}/desktop/metadata.json`,
        screenshotPath: `${state}/desktop/screenshot.png`,
        observations: v2Observations(rhythmElements(clearances)),
      });
    const result = runDeterministicChecks([
      captured("account", [16, 16, 16, 0]),
      captured("account-filtered", [16, 16, 16, 16]),
    ]);
    const findings = result.candidates.filter(
      ({ candidate }) => candidate.category === "spacing-rhythm",
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      tuple: { state: "account" },
      candidate: {
        explanation: expect.stringContaining(
          "prevailing clearance is 16 CSS px, supported by 3 observed placements",
        ),
      },
    });
  });

  test("evaluates a large observation artifact without per-boundary element rescans", () => {
    const elements = [
      v2Element({ selector: "html", tag: "html", structuralPath: "html[0]" }),
      v2Element({
        selector: "body",
        tag: "body",
        structuralPath: "html[0]/body[0]",
      }),
      v2Element({
        selector: "main",
        tag: "main",
        structuralPath: "html[0]/body[0]/main[0]",
      }),
    ];
    for (let index = 0; index < 100; index += 1) {
      const y = index * 70;
      const sectionPath = `html[0]/body[0]/main[0]/section[${index}]`;
      elements.push(
        v2Element({
          selector: `section.row-${index}`,
          tag: "section",
          structuralPath: sectionPath,
          rect: { x: 10, y, width: 600, height: 60 },
        }),
        v2Element({
          selector: `h3.title-${index}`,
          tag: "h3",
          structuralPath: `${sectionPath}/h3[0]`,
          rect: { x: 20, y: y + 5, width: 150, height: 15 },
        }),
        v2Element({
          selector: `p.copy-${index}`,
          tag: "p",
          structuralPath: `${sectionPath}/p[0]`,
          rect: { x: 20, y: y + 25, width: 150, height: 20 },
        }),
        ...(["button", "a", "input"] as const).map((tag, control) =>
          v2Element({
            selector: `${tag}.control-${index}-${control}`,
            tag,
            structuralPath: `${sectionPath}/${tag}[0]`,
            interactive: true,
            rect: {
              x: 200 + control * 110,
              y: y + 10,
              width: 90,
              height: 30,
            },
          }),
        ),
      );
    }
    const artifact = v2Observations(elements, { width: 1280, height: 900 });
    if (artifact.version !== 2) throw new Error("expected v2 fixture");
    artifact.document.scrollHeight = 7_000;
    const result = spacingRhythmCheck.run([
      tuple({
        width: 1280,
        height: 900,
        observations: artifact,
      }),
    ]);
    expect(result.coverage[0]?.coverage.status).toBe("ran");
  });

  test("does not report uniform, weakly supported, or non-sharp spacing", () => {
    const spacingFindings = (clearances: number[]) =>
      runDeterministicChecks([
        tuple({ observations: v2Observations(rhythmElements(clearances)) }),
      ]).candidates.filter(
        ({ candidate }) => candidate.category === "spacing-rhythm",
      );
    expect(spacingFindings([0, 0, 0, 0])).toEqual([]);
    expect(spacingFindings([16, 16, 16, 16])).toEqual([]);
    expect(spacingFindings([16, 16, 0])).toEqual([]);
    expect(spacingFindings([16, 16, 16, 12])).toEqual([]);
    expect(spacingFindings([16, 16, 0, 0])).toEqual([]);
  });

  test("keeps spacing coverage and candidates local to usable v2 tuples", () => {
    const healthy = tuple({
      state: "settings",
      observations: v2Observations(rhythmElements([16, 16, 16, 0])),
    });
    const legacy = tuple({ state: "legacy", observations: observations() });
    const missing = tuple({ state: "missing", observations: undefined });
    const result = runDeterministicChecks([missing, healthy, legacy]);
    expect(
      result.coverage
        .filter(({ coverage }) => coverage.check === "spacing-rhythm")
        .map(({ tuple: item, coverage }) => [
          item.state,
          coverage.status,
          coverage.reason,
        ]),
    ).toEqual([
      [
        "legacy",
        "unavailable",
        "not evaluated: observations version 1 lacks structural geometry",
      ],
      [
        "missing",
        "unavailable",
        "not evaluated: observations.json is unavailable",
      ],
      ["settings", "ran", undefined],
    ]);
    expect(
      result.candidates.filter(
        ({ candidate }) => candidate.category === "spacing-rhythm",
      ),
    ).toHaveLength(1);
    expect(
      runDeterministicChecks([legacy, missing]).candidates.some(
        ({ candidate }) => candidate.category === "spacing-rhythm",
      ),
    ).toBe(false);
  });

  test("spacing output is stable across tuple order", () => {
    const first = tuple({
      state: "settings",
      observations: v2Observations(rhythmElements([16, 16, 16, 0])),
    });
    const bordered = rhythmElements([16, 16, 16, 0]);
    const main = bordered.find(({ selector }) => selector === "main.settings");
    if (main === undefined) throw new Error("missing main fixture");
    main.styles = {
      ...main.styles,
      borderBottomWidth: "8px",
      borderBottomColor: "rgba(0, 0, 0, 0)",
    };
    const second = tuple({
      state: "other",
      observations: v2Observations(bordered),
    });
    const signature = (values: CheckTuple[]) =>
      runDeterministicChecks(values)
        .candidates.filter(
          ({ candidate }) => candidate.category === "spacing-rhythm",
        )
        .map(({ tuple: item, candidate }) => ({
          state: item.state,
          hint: candidate.selectorHint,
          explanation: candidate.explanation,
        }));
    expect(signature([first, second])).toEqual(signature([second, first]));
  });

  test("separates viewport and interactive-kind spacing cohorts", () => {
    const desktop = tuple({
      viewport: "desktop",
      width: 320,
      observations: v2Observations(rhythmElements([16, 16, 16])),
    });
    const mobile = tuple({
      viewport: "mobile",
      width: 390,
      observations: v2Observations(rhythmElements([0]), {
        width: 390,
        height: 600,
      }),
    });
    expect(
      runDeterministicChecks([desktop, mobile]).candidates.filter(
        ({ candidate }) => candidate.category === "spacing-rhythm",
      ),
    ).toEqual([]);

    const mixedKinds = rhythmElements([16, 16, 16, 0]);
    const last = mixedKinds.find(
      ({ selector }) => selector === "button.action-4",
    );
    if (last === undefined) throw new Error("missing action fixture");
    last.tag = "a";
    last.selector = "a.action-4";
    expect(
      runDeterministicChecks([
        tuple({ observations: v2Observations(mixedKinds) }),
      ]).candidates.filter(
        ({ candidate }) => candidate.category === "spacing-rhythm",
      ),
    ).toEqual([]);
  });

  test("uses painted horizontal borders and ignores transparent ones", () => {
    const withSiblingBorders = (color: string) => {
      const elements = rhythmElements([30, 30, 30, 30]);
      for (let index = 0; index < 4; index += 1) {
        const button = elements.find(
          ({ selector }) => selector === `button.action-${index + 1}`,
        );
        if (button === undefined) throw new Error("missing action fixture");
        const gap = index === 3 ? 0 : 8;
        elements.push(
          v2Element({
            selector: `div.border-${index + 1}`,
            tag: "div",
            structuralPath: `html[0]/body[0]/main[0]/div[${index}]`,
            rect: {
              x: 30,
              y: button.rect.y + button.rect.height + gap,
              width: 260,
              height: 1,
            },
            styles: {
              ...expandedStyles,
              borderTopWidth: "1px",
              borderTopColor: color,
            },
          }),
        );
      }
      return v2Observations(elements);
    };
    const findings = (color: string) =>
      runDeterministicChecks([
        tuple({ observations: withSiblingBorders(color) }),
      ]).candidates.filter(
        ({ candidate }) => candidate.category === "spacing-rhythm",
      );
    expect(findings("rgba(0, 0, 0, 0)")).toEqual([]);
    expect(findings("rgb(80, 80, 80)")).toHaveLength(1);
    expect(findings("rgb(80, 80, 80)")[0]?.candidate.explanation).toContain(
      "top border",
    );
  });

  test("console fingerprints survive insertion and distinguish shared logging locations", () => {
    const hints = (console: CheckTuple["console"]) =>
      new Map(
        runDeterministicChecks([tuple({ console })])
          .candidates.filter(
            ({ candidate }) => candidate.category === "console-error",
          )
          .map(({ candidate }) => [
            candidate.consoleExcerpt ?? "",
            candidate.selectorHint,
          ]),
      );
    const original = "Cannot read properties of undefined";
    const first = hints([{ type: "pageerror", text: original }]);
    const shifted = hints([
      { type: "pageerror", text: "Hydration failed" },
      { type: "pageerror", text: original },
    ]);
    expect(shifted.get(original)).toBe(first.get(original));

    const sharedLocation = {
      url: "http://localhost/logger.js",
      lineNumber: 12,
      columnNumber: 4,
    };
    const shared = hints([
      { type: "error", text: "First failure", location: sharedLocation },
      { type: "error", text: "Second failure", location: sharedLocation },
    ]);
    const fingerprint = (selectorHint: string) =>
      findingFingerprint({
        category: "console-error",
        flow: "booking",
        state: "ready",
        rule: "idiom:console-error",
        selectorHint,
      });
    expect(fingerprint(shared.get("First failure") ?? "")).not.toBe(
      fingerprint(shared.get("Second failure") ?? ""),
    );

    const repeatedRecord = {
      type: "error" as const,
      text: "Polling failed",
      location: sharedLocation,
    };
    const repeated = runDeterministicChecks([
      tuple({ console: [repeatedRecord, repeatedRecord] }),
    ]).candidates.filter(
      ({ candidate }) => candidate.category === "console-error",
    );
    expect(repeated).toHaveLength(1);
    expect(repeated[0]?.candidate.explanation).toContain("recorded 2 times");
  });

  test("exempts only the expected non-200 document load error", () => {
    const documentUrl = "http://127.0.0.1:3107/not-found";
    const resourceMessage =
      "Failed to load resource: the server responded with a status of 404";
    const result = runDeterministicChecks([
      tuple({
        documentResponse: {
          url: documentUrl,
          actualStatus: 404,
          expectedStatus: 404,
        },
        console: [
          {
            type: "error",
            text: resourceMessage,
            location: { url: documentUrl, lineNumber: 0, columnNumber: 0 },
          },
          {
            type: "error",
            text: `${resourceMessage} (Not Found)`,
            location: {
              url: "http://127.0.0.1:3107/missing.css",
              lineNumber: 0,
              columnNumber: 0,
            },
          },
          { type: "pageerror", text: "Application crashed" },
        ],
      }),
    ]).candidates.filter(
      ({ candidate }) => candidate.category === "console-error",
    );
    expect(result.map(({ candidate }) => candidate.consoleExcerpt)).toEqual([
      `${resourceMessage} (Not Found)`,
      "Application crashed",
    ]);
  });

  test("keeps expected document failures when any exemption guard is absent", () => {
    const documentUrl = "http://127.0.0.1:3107/not-found";
    const resourceMessage =
      "Failed to load resource: the server responded with a status of 404";
    const record = {
      type: "error",
      text: resourceMessage,
      location: { url: documentUrl, lineNumber: 0, columnNumber: 0 },
    };
    const candidates = (value: CheckTuple) =>
      runDeterministicChecks([value]).candidates.filter(
        ({ candidate }) => candidate.category === "console-error",
      );
    const context = {
      url: documentUrl,
      actualStatus: 404,
      expectedStatus: 404,
    };
    const cases = [
      tuple({
        documentResponse: { ...context, expectedStatus: 200 },
        console: [record],
      }),
      tuple({
        documentResponse: { ...context, actualStatus: 500 },
        console: [record],
      }),
      tuple({
        documentResponse: context,
        console: [{ ...record, text: "Application logged status 404" }],
      }),
      tuple({
        documentResponse: context,
        console: [
          {
            ...record,
            location: { ...record.location, lineNumber: 1 },
          },
        ],
      }),
      tuple({ console: [record] }),
    ];
    expect(cases.map((item) => candidates(item).length)).toEqual([
      1, 1, 1, 1, 1,
    ]);
  });

  test("undeclared tokens are an explicit skip, not an empty allow-list", () => {
    const result = runDeterministicChecks([tuple()]);
    expect(
      result.coverage.find(({ coverage }) => coverage.check === "token-drift")
        ?.coverage,
    ).toEqual({
      check: "token-drift",
      status: "skipped",
      reason: "design.tokensFile is not configured",
    });
    expect(
      result.candidates.some(
        ({ candidate }) => candidate.category === "token-drift",
      ),
    ).toBe(false);
  });

  test("ignores unpainted outlines and collapses uniform box shorthands", () => {
    const observed = observations([
      element({
        selector: "div.no-outline",
        interactive: false,
        styles: {
          ...styles,
          outlineColor: "rgb(1, 2, 3)",
          outlineWidth: "3px",
          outlineStyle: "none",
        },
      }),
      element({
        selector: "div.painted-outline",
        interactive: false,
        styles: {
          ...styles,
          outlineColor: "rgb(1, 2, 3)",
          outlineWidth: "3px",
          outlineStyle: "solid",
        },
      }),
      element({
        selector: "div.rounded",
        interactive: false,
        styles: {
          ...styles,
          borderTopLeftRadius: "8px",
          borderTopRightRadius: "8px",
          borderBottomRightRadius: "8px",
          borderBottomLeftRadius: "8px",
        },
      }),
      element({
        selector: "div.bordered",
        interactive: false,
        styles: {
          ...styles,
          borderTopColor: "rgb(4, 5, 6)",
          borderRightColor: "rgb(4, 5, 6)",
          borderBottomColor: "rgb(4, 5, 6)",
          borderLeftColor: "rgb(4, 5, 6)",
          borderTopWidth: "1px",
          borderRightWidth: "1px",
          borderBottomWidth: "1px",
          borderLeftWidth: "1px",
        },
      }),
      element({
        selector: "div.asymmetric",
        interactive: false,
        styles: {
          ...styles,
          borderTopLeftRadius: "8px",
          borderTopRightRadius: "8px",
          borderBottomRightRadius: "4px",
          borderBottomLeftRadius: "4px",
        },
      }),
    ]);
    observed.tokens = {
      status: "configured",
      source: "theme.css",
      declarations: { "--ink": "#000" },
      normalizedValues: ["rgb(0, 0, 0)"],
    };
    const hints = runDeterministicChecks([tuple({ observations: observed })])
      .candidates.filter(
        ({ candidate }) => candidate.category === "token-drift",
      )
      .map(({ candidate }) => candidate.selectorHint);
    expect(hints).not.toContain("div.no-outline::outlineColor");
    expect(hints).toEqual([
      "div.painted-outline::outlineColor",
      "div.rounded::borderRadius",
      "div.bordered::borderColor",
      "div.asymmetric::borderTopLeftRadius",
      "div.asymmetric::borderTopRightRadius",
      "div.asymmetric::borderBottomRightRadius",
      "div.asymmetric::borderBottomLeftRadius",
    ]);
  });

  test("fingerprints canonicalize reordered class tokens", () => {
    const base = {
      category: "target-size",
      flow: "booking",
      state: "ready",
      rule: "idiom:minimum-target-size",
    };
    expect(
      findingFingerprint({ ...base, selectorHint: "button.beta.alpha" }),
    ).toBe(findingFingerprint({ ...base, selectorHint: "button.alpha.beta" }));
  });
});

test("only exactly true healthAllowed console records are exempt", () => {
  const result = runDeterministicChecks([
    tuple({
      console: [
        { type: "error", text: "expected resource", healthAllowed: true },
        { type: "pageerror", text: "expected page error", healthAllowed: true },
        { type: "error", text: "legacy error" },
        { type: "error", text: "explicit false", healthAllowed: false },
      ],
    }),
  ]);
  const errors = result.candidates.filter(
    ({ candidate }) => candidate.category === "console-error",
  );
  expect(errors).toHaveLength(2);
  expect(errors.map(({ candidate }) => candidate.consoleExcerpt)).toEqual([
    "legacy error",
    "explicit false",
  ]);
});

describe("component-size persisted tolerance", () => {
  const tighter = { ratio: 0.15, px: 1, mode: "tighter" as const };
  const legacy = { ratio: 0.25, px: 4 };
  test.each([
    { name: "12px oversize", actual: [12, 12], fails: true },
    { name: "subpixel allowance", actual: [8.5, 8.5], fails: false },
    { name: "upper equality", actual: [9, 9], fails: false },
    { name: "lower equality", actual: [7, 7], fails: false },
    { name: "just above width", actual: [9.0001, 8], fails: true },
    { name: "just below height", actual: [8, 6.9999], fails: true },
    { name: "undersize", actual: [6, 6], fails: true },
    {
      name: "percentage boundary",
      declared: [4, 20],
      actual: [4.6, 21],
      fails: false,
    },
    {
      name: "percentage width exceeded",
      declared: [4, 20],
      actual: [4.6001, 20],
      fails: true,
    },
    {
      name: "pixel height exceeded",
      declared: [4, 20],
      actual: [4, 21.0001],
      fails: true,
    },
    {
      name: "legacy missing mode",
      tolerance: legacy,
      actual: [12, 12],
      fails: false,
    },
    {
      name: "legacy max equality",
      tolerance: legacy,
      actual: [4, 4],
      fails: false,
    },
    {
      name: "legacy max exceeded",
      tolerance: legacy,
      actual: [12.0001, 8],
      fails: true,
    },
    {
      name: "explicit looser",
      tolerance: { ...legacy, mode: "looser" as const },
      actual: [12, 12],
      fails: false,
    },
    {
      name: "explicit tighter",
      tolerance: { ...legacy, mode: "tighter" as const },
      actual: [12, 12],
      fails: true,
    },
    {
      name: "explicit tighter equality",
      tolerance: { ...legacy, mode: "tighter" as const },
      actual: [10, 6],
      fails: false,
    },
    {
      name: "looser percentage wins",
      tolerance: { ratio: 0.75, px: 1, mode: "looser" as const },
      actual: [14, 2],
      fails: false,
    },
    {
      name: "zero ratio tighter",
      tolerance: { ...tighter, ratio: 0 },
      actual: [8.001, 8],
      fails: true,
    },
    {
      name: "zero px tighter",
      tolerance: { ...tighter, px: 0 },
      actual: [8, 7.999],
      fails: true,
    },
    {
      name: "zero ratio looser",
      tolerance: { ...legacy, ratio: 0 },
      actual: [12, 12],
      fails: false,
    },
    {
      name: "zero px looser",
      tolerance: { ...legacy, px: 0 },
      actual: [10, 10],
      fails: false,
    },
    {
      name: "both zero equality",
      tolerance: { ratio: 0, px: 0 },
      actual: [8, 8],
      fails: false,
    },
  ])("$name", ({ declared = [8, 8], actual, tolerance = tighter, fails }) => {
    const input = tuple({
      observations: {
        ...v2Observations([]),
        version: 2,
        elements: [],
        maskMembership: [],
        components: [
          {
            name: "indicator",
            selector: ".dot",
            width: declared[0] as number,
            height: declared[1] as number,
            tolerance,
            rects: [
              {
                selector: ".dot",
                x: 0,
                y: 0,
                width: actual[0] as number,
                height: actual[1] as number,
              },
            ],
          },
        ],
      },
    });
    const candidates = runDeterministicChecks([input]).candidates.filter(
      ({ candidate }) => candidate.category === "component-size",
    );
    expect(candidates).toHaveLength(fails ? 1 : 0);
    if (fails && declared[0] === 4)
      expect(candidates[0]?.candidate.explanation).toContain("(±0.6×1px)");
    if (fails && tolerance === legacy)
      expect(candidates[0]?.candidate.explanation).toContain("(±4×4px)");
  });

  test("aggregates off-size elements per declaration and preserves finding identity", () => {
    const component = {
      name: "indicator",
      selector: ".dot",
      width: 8,
      height: 8,
      tolerance: tighter,
      rects: [
        { selector: ".dot:first-child", x: 0, y: 0, width: 12, height: 12 },
        { selector: ".dot:nth-child(2)", x: 20, y: 0, width: 8.5, height: 8.5 },
        { selector: ".dot:last-child", x: 40, y: 0, width: 6, height: 6 },
      ],
    };
    const result = runDeterministicChecks([
      tuple({
        observations: {
          ...v2Observations([]),
          version: 2,
          elements: [],
          maskMembership: [],
          components: [component],
        },
      }),
    ]);
    const candidates = result.candidates.filter(
      ({ candidate }) => candidate.category === "component-size",
    );
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.candidate).toMatchObject({
      severity: "minor",
      rule: "idiom:component-size-mismatch",
      selectorHint: ".dot:first-child",
      explanation:
        '2 of 3 "indicator" elements render at 12×12, 6×6px; the design specifies 8×8px (±1×1px).',
      verification: {
        check: "component-size",
        params: { component: "indicator", selector: ".dot" },
      },
    });
  });
});

test.each([
  "image/png",
  "application/json",
  "application/rss+xml",
  "application/xml",
])(
  "persisted %s suppresses heading checks even with stale HTML evidence",
  (contentType) => {
    for (const headings of [
      [],
      [
        { selector: "h1.a", level: 1, text: "A" },
        { selector: "h1.b", level: 1, text: "B" },
        { selector: "h4", level: 4, text: "Skipped" },
      ],
    ]) {
      const observed = observations();
      observed.headings = headings;
      observed.document.contentType = contentType;
      const axe = {
        violations: ["page-has-heading-one", "heading-order"].map((id) => ({
          id,
          nodes: [{ target: ["document"] }],
        })),
      };
      const checked = runDeterministicChecks([
        tuple({ observations: observed, axe }),
      ]);
      expect(
        checked.candidates.filter(
          ({ candidate }) => candidate.category === "heading-structure",
        ),
      ).toEqual([]);
      expect(checked.coverage.map(({ coverage }) => coverage)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            check: "heading-structure",
            status: "skipped",
            reason: expect.stringContaining("non-HTML"),
          }),
        ]),
      );
      for (const mime of ["text/html", "application/xhtml+xml", undefined]) {
        if (mime) observed.document.contentType = mime;
        else delete observed.document.contentType;
        expect(
          runDeterministicChecks([
            tuple({ observations: observed, axe }),
          ]).candidates.filter(
            ({ candidate }) => candidate.category === "heading-structure",
          ).length,
        ).toBeGreaterThan(0);
      }
    }
  },
);

test("optional document MIME round trips in V1 and V2 while malformed values are rejected", () => {
  for (const artifact of [observations(), v2Observations([])]) {
    expect(observationArtifactSchema.parse(artifact)).toEqual(artifact);
    artifact.document.contentType = "application/json";
    expect(observationArtifactSchema.parse(artifact)).toEqual(artifact);
    for (const contentType of ["", "  ", null, 42, {}, []])
      expect(
        observationArtifactSchema.safeParse({
          ...artifact,
          document: { ...artifact.document, contentType },
        }).success,
      ).toBe(false);
  }
});

test("a declared 200 expectation capturing 404 remains an expectation-status blocker", () => {
  const result = runDeterministicChecks([
    tuple({
      mismatches: [{ kind: "status", expected: 200, actual: 404 }],
    }),
  ]);
  expect(result.candidates).toContainEqual(
    expect.objectContaining({
      candidate: expect.objectContaining({
        rule: "idiom:expectation-status",
        severity: "blocker",
      }),
    }),
  );
});

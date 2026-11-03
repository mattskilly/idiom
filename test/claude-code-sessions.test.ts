import { describe, expect, test } from "vitest";
import {
  CLAUDE_CODE_MAX_SESSION_DOM_CHARS,
  CLAUDE_CODE_MAX_SESSION_IMAGE_BYTES,
  CLAUDE_CODE_MAX_SESSION_IMAGES,
  type ClaudeCodeSessionLimits,
  describeEvidenceLimits,
  fitsOneSession,
  planClaudeCodeSessions,
} from "../src/critique/claude-code-sessions.js";
import { validateCritiqueResult } from "../src/critique/schema.js";
import type {
  CritiqueInput,
  CropRef,
  DesignImageRef,
  DomExcerpt,
  ReferenceRef,
  ScreenshotRef,
} from "../src/critique/types.js";

const MIB = 1024 * 1024;

function screenshot(state: string, viewport: string): ScreenshotRef {
  return {
    label: `${state}/${viewport}`,
    path: `${state}/${viewport}/screenshot.png`,
    readPath: `/run/${state}/${viewport}.png`,
    state,
    viewport,
  };
}

function crop(parent: ScreenshotRef, index: number): CropRef {
  return {
    label: `${parent.label}/crop-${index}`,
    screenshot: parent.label,
    path: `${parent.label}/crop-${index}.png`,
    readPath: `/run/${parent.label}/crop-${index}.png`,
    state: parent.state,
    viewport: parent.viewport,
    rect: { x: 0, y: 0, width: 10, height: 10 },
  };
}

function design(parent: ScreenshotRef): DesignImageRef {
  return {
    label: `${parent.label}/design`,
    designFor: parent.label,
    path: `${parent.label}/design.png`,
    readPath: `/run/${parent.label}/design.png`,
    state: parent.state,
    viewport: parent.viewport,
    offset: 0,
    regions: [],
  };
}

function dom(parent: ScreenshotRef, chars = 100): DomExcerpt {
  return {
    label: parent.label,
    state: parent.state,
    viewport: parent.viewport,
    content: "x".repeat(chars),
  };
}

function imageReference(label: string): ReferenceRef {
  return {
    label,
    polarity: "reference",
    kind: "image",
    readPath: `/refs/${label}.png`,
    mediaType: "image/png",
  };
}

function flowInput(
  states: number,
  extra: Partial<CritiqueInput> = {},
): CritiqueInput {
  const screenshots = Array.from({ length: states }, (_, index) => [
    screenshot(`state-${index}`, "desktop"),
    screenshot(`state-${index}`, "mobile"),
  ]).flat();
  return {
    flow: "booking",
    intent: [],
    screenshots,
    domExcerpts: screenshots.map((item) => dom(item)),
    productMd: "",
    designMd: "",
    references: [],
    priorDecisions: [],
    deterministicFindings: [],
    modelCandidateAllowance: 5,
    decisionObservationAllowance: 3,
    rulingResolutions: [],
    ...extra,
  };
}

function sizesFor(input: CritiqueInput, bytes = 200 * 1024) {
  return new Map(
    [
      ...input.screenshots,
      ...input.references.flatMap((item) =>
        item.kind === "image" ? [item] : [],
      ),
      ...(input.crops ?? []),
      ...(input.designImages ?? []),
    ].map((item) => [item.readPath, bytes]),
  );
}

const tiny: ClaudeCodeSessionLimits = {
  images: 4,
  imageBytes: 4 * MIB,
  domChars: 1_000,
};

describe("Claude Code session budget", () => {
  test("documents the per-session limits", () => {
    expect(CLAUDE_CODE_MAX_SESSION_IMAGES).toBe(20);
    expect(CLAUDE_CODE_MAX_SESSION_IMAGE_BYTES).toBe(20 * MIB);
    expect(CLAUDE_CODE_MAX_SESSION_DOM_CHARS).toBe(60_000);
  });

  test("a capture within every limit fits one session", () => {
    const input = flowInput(5);
    expect(fitsOneSession(input, sizesFor(input))).toBe(true);
  });

  test("28 screenshots split by state into sessions of at most 20 images", () => {
    const input = flowInput(14, {
      references: [imageReference("anchor")],
    });
    const sizes = sizesFor(input);
    expect(fitsOneSession(input, sizes)).toBe(false);
    const { sessions, omitted } = planClaudeCodeSessions(input, sizes);
    expect(omitted).toEqual([]);
    expect(sessions).toHaveLength(2);
    const seen = sessions.flatMap((session) =>
      session.screenshots.map((item) => item.label),
    );
    expect(seen).toEqual(input.screenshots.map((item) => item.label));
    for (const session of sessions) {
      expect(
        session.screenshots.length + session.references.length,
      ).toBeLessThanOrEqual(20);
      expect(session.references.map((item) => item.label)).toEqual(["anchor"]);
      const states = new Set(session.screenshots.map((item) => item.state));
      for (const state of states)
        expect(
          session.screenshots.filter((item) => item.state === state),
        ).toHaveLength(2);
      expect(session.domExcerpts.map((item) => item.label)).toEqual(
        session.screenshots.map((item) => item.label),
      );
    }
  });

  test("references are reserved in every session and count against both limits", () => {
    const input = flowInput(3, {
      references: [imageReference("a"), imageReference("b")],
    });
    const sizes = sizesFor(input, MIB);
    const { sessions, omitted } = planClaudeCodeSessions(input, sizes, tiny);
    expect(omitted).toEqual([]);
    // 2 references leave 2 images and 2 MB: one state (two screenshots) each.
    expect(sessions).toHaveLength(3);
    for (const session of sessions) {
      expect(session.references.map((item) => item.label)).toEqual(["a", "b"]);
      expect(session.screenshots).toHaveLength(2);
    }
  });

  test("references are dropped from the end until a screenshot fits", () => {
    const input = flowInput(1, {
      references: [
        imageReference("a"),
        imageReference("b"),
        imageReference("c"),
        imageReference("d"),
      ],
    });
    const { sessions, omitted } = planClaudeCodeSessions(
      input,
      sizesFor(input, MIB),
      tiny,
    );
    expect(omitted.map((item) => [item.label, item.kind])).toEqual([
      ["d", "reference"],
    ]);
    expect(sessions.map((s) => s.screenshots.length)).toEqual([1, 1]);
    expect(sessions[0]?.references.map((item) => item.label)).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  test("a state too big for a session splits per screenshot, then sheds crops and design images", () => {
    const base = flowInput(1);
    const [desktop, mobile] = base.screenshots as [
      ScreenshotRef,
      ScreenshotRef,
    ];
    const input: CritiqueInput = {
      ...base,
      crops: [crop(desktop, 1), crop(desktop, 2), crop(desktop, 3)],
      designImages: [design(desktop)],
    };
    const { sessions, omitted } = planClaudeCodeSessions(
      input,
      sizesFor(input, MIB),
      tiny,
    );
    // desktop + 3 crops + design = 5 images > 4: one crop goes.
    expect(omitted).toEqual([
      {
        label: "state-0/desktop/crop-3",
        kind: "zoomed-crop",
        reason:
          "state-0/desktop with its crops exceeds one session's image budget",
      },
    ]);
    expect(sessions).toHaveLength(2);
    expect(sessions[0]?.screenshots).toEqual([desktop]);
    expect(sessions[0]?.crops.map((item) => item.label)).toEqual([
      "state-0/desktop/crop-1",
      "state-0/desktop/crop-2",
    ]);
    expect(sessions[0]?.designImages).toHaveLength(1);
    expect(sessions[1]?.screenshots).toEqual([mobile]);

    const designHeavy: CritiqueInput = {
      ...base,
      designImages: [design(desktop)],
    };
    const sizes = sizesFor(designHeavy, MIB);
    sizes.set(desktop.readPath, 3.5 * MIB);
    const planned = planClaudeCodeSessions(designHeavy, sizes, tiny);
    expect(planned.omitted.map((item) => [item.label, item.kind])).toEqual([
      ["state-0/desktop/design", "intended-design-image"],
    ]);
    expect(planned.sessions[0]?.designImages).toEqual([]);
  });

  test("a screenshot whose file is over the byte budget is omitted with a byte reason", () => {
    const input = flowInput(2);
    const sizes = sizesFor(input, MIB);
    const huge = input.screenshots[0] as ScreenshotRef;
    sizes.set(huge.readPath, 5.25 * MIB);
    const { sessions, omitted } = planClaudeCodeSessions(input, sizes, tiny);
    expect(omitted).toEqual([
      {
        label: "state-0/desktop",
        kind: "captured-screenshot",
        reason: "file is 5.3 MB; session image budget is 4 MB",
      },
    ]);
    const labels = sessions.flatMap((s) => s.screenshots.map((i) => i.label));
    expect(labels).toEqual([
      "state-0/mobile",
      "state-1/desktop",
      "state-1/mobile",
    ]);
    // The omitted screenshot's DOM excerpt still rides with its state.
    expect(sessions[0]?.domExcerpts.map((item) => item.label)).toContain(
      "state-0/desktop",
    );
  });

  test("orphan DOM excerpts follow their state, and the DOM limit is enforced", () => {
    const base = flowInput(3);
    const orphan: DomExcerpt = {
      label: "state-2/tablet",
      state: "state-2",
      viewport: "tablet",
      content: "o".repeat(50),
    };
    const nowhere: DomExcerpt = {
      label: "elsewhere/desktop",
      state: "elsewhere",
      viewport: "desktop",
      content: "n".repeat(50),
    };
    const input: CritiqueInput = {
      ...base,
      domExcerpts: [...base.domExcerpts, orphan, nowhere],
    };
    const limits = { images: 2, imageBytes: 4 * MIB, domChars: 250 };
    const { sessions, omitted } = planClaudeCodeSessions(
      input,
      sizesFor(input, MIB),
      limits,
    );
    expect(sessions).toHaveLength(3);
    expect(sessions[2]?.domExcerpts.map((item) => item.label)).toContain(
      "state-2/tablet",
    );
    expect(sessions[0]?.domExcerpts.map((item) => item.label)).toContain(
      "elsewhere/desktop",
    );
    expect(omitted).toEqual([]);

    const tight = planClaudeCodeSessions(input, sizesFor(input, MIB), {
      ...limits,
      domChars: 200,
    });
    expect(tight.omitted).toEqual([
      {
        label: "state-2/tablet",
        kind: "dom-excerpt",
        reason: "no session had room in its 200-character DOM budget",
      },
      {
        label: "elsewhere/desktop",
        kind: "dom-excerpt",
        reason: "no session had room in its 200-character DOM budget",
      },
    ]);

    const oversized: CritiqueInput = {
      ...base,
      domExcerpts: [dom(base.screenshots[0] as ScreenshotRef, 1_500)],
    };
    const result = planClaudeCodeSessions(
      oversized,
      sizesFor(oversized, MIB),
      tiny,
    );
    expect(result.omitted).toEqual([
      {
        label: "state-0/desktop",
        kind: "dom-excerpt",
        reason: "excerpt is 1,500 characters; session DOM budget is 1,000",
      },
    ]);
    expect(result.sessions.flatMap((s) => s.screenshots)).toHaveLength(6);
  });

  test("planning is deterministic", () => {
    const input = flowInput(14, { references: [imageReference("anchor")] });
    const sizes = sizesFor(input);
    expect(planClaudeCodeSessions(input, sizes)).toEqual(
      planClaudeCodeSessions(input, sizes),
    );
  });

  test("describes limits in one bounded sentence", () => {
    const limits = { images: 20, imageBytes: 20 * MIB, domChars: 60_000 };
    expect(
      describeEvidenceLimits({
        provider: "claude-code",
        limits,
        sessions: 2,
        omitted: [],
      }),
    ).toBe(
      "Claude Code critique evidence was limited (per session: 20 images, 20 MB of images, 60,000 DOM characters): split across 2 sessions.",
    );
    const many = describeEvidenceLimits({
      provider: "claude-code",
      limits,
      sessions: 1,
      omitted: Array.from({ length: 13 }, (_, index) => ({
        label: `s${index}/desktop`,
        kind: "captured-screenshot" as const,
        reason: "file is 23.4 MB; session image budget is 20 MB",
      })),
    });
    expect(many).toContain(
      "ran in 1 session; omitted s0/desktop (captured-screenshot: file is 23.4 MB; session image budget is 20 MB)",
    );
    expect(many).toContain("s9/desktop");
    expect(many).not.toContain("s10/desktop");
    expect(many).toMatch(/, and 3 more\.$/);
  });
});

describe("validateCritiqueResult evidence limits", () => {
  const shot = screenshot("ready", "mobile");
  const limits = {
    provider: "claude-code" as const,
    limits: { images: 20, imageBytes: 20 * MIB, domChars: 60_000 },
    sessions: 2,
    omitted: [],
  };

  test("keeps a well-formed record and drops a malformed one", () => {
    expect(
      validateCritiqueResult({
        result: { findings: [], evidenceLimits: limits },
        screenshots: [shot],
        designMd: "",
      }).evidenceLimits,
    ).toEqual(limits);
    for (const malformed of [
      { ...limits, provider: "codex" },
      { ...limits, sessions: "2" },
      { ...limits, omitted: [{ label: "x" }] },
      { ...limits, limits: null },
      "split",
    ]) {
      const result = validateCritiqueResult({
        result: { findings: [], evidenceLimits: malformed },
        screenshots: [shot],
        designMd: "",
      });
      expect(result).not.toHaveProperty("evidenceLimits");
    }
  });
});

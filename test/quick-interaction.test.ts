import { expect, test } from "vitest";
import { createProbeSafetyLedger } from "../src/capture/probe.js";
import type {
  CheckTuple,
  ProbeArtifact,
  ProbeResult,
} from "../src/checks/types.js";
import {
  interactionTail,
  nonSafeSent,
  renderInteractionSentences,
  summarizeQuickInteraction,
} from "../src/quick/interaction.js";

const page = {
  state: "page-1",
  viewport: "desktop",
  colorScheme: "light" as const,
  url: "https://example.com/",
};

function result(name: string, extra: Partial<ProbeResult> = {}): ProbeResult {
  return {
    selector: `#${name}`,
    name,
    effects: [],
    persistent: true,
    status: "completed",
    ...extra,
  };
}

function tuple(probe?: ProbeArtifact, failure?: string): CheckTuple {
  return {
    flow: "quick-review",
    state: "page-1",
    viewport: "desktop",
    colorScheme: "light",
    width: 1440,
    height: 900,
    metadataPath: "page-1/desktop/light/metadata.json",
    artifactPaths: [],
    commit: "unavailable",
    createdAt: "2026-10-26T00:00:00.000Z",
    console: [],
    mismatches: [],
    ...(failure === undefined
      ? {}
      : { failure: { stage: "navigation", message: failure } }),
    ...(probe === undefined
      ? {}
      : {
          observations: {
            version: 2,
            probe,
          } as unknown as CheckTuple["observations"],
        }),
  };
}

function summarize(tuples: CheckTuple[]) {
  return summarizeQuickInteraction({
    tuples,
    probed: [page],
    enabled: true,
    budgetMs: 45_000,
    maxControls: 40,
  });
}

test("each probe result lands in exactly one count", () => {
  const safety = createProbeSafetyLedger(["https://example.com"]);
  safety.requests.sent = { GET: 4 };
  safety.requests.blocked = { GET: 1, POST: 3, DELETE: 1 };
  safety.blocked.crossOriginNavigation = 1;
  safety.blocked.formSubmission = 2;
  safety.skipped.destructive = 1;
  const summary = summarize([
    tuple({
      status: "partial",
      reason: "probed 3 of 5 controls (checks.probe.maxControls)",
      safety,
      results: [
        result("done", { effects: ["dom"] }),
        result("reused", { reusedFrom: "page-0" }),
        result("slow", { status: "timed-out", timeoutScope: "control" }),
        result("Delete", { skipped: "destructive name" }),
        result("selected", { skipped: "already selected: aria-pressed" }),
        result("broken", { skipped: "not clickable: hidden" }),
        result("cap", {
          status: "not-reached",
          skipped: "not reached: checks.probe.maxControls",
        }),
        result("late", {
          status: "not-reached",
          skipped: "not reached: state budget",
        }),
        result("cut", {
          status: "timed-out",
          timeoutScope: "state",
          skipped: "state timed-out",
        }),
        result("deep", {
          status: "not-reached",
          skipped: "not reached: nested-menu limit",
        }),
      ],
    }),
  ]);
  if (summary.status !== "probed") throw new Error("expected probed");
  expect(summary.pages[0]).toMatchObject({
    probeStatus: "partial",
    probed: 3,
    skipped: { destructive: 1, intent: 1, other: 1 },
    notReached: { budget: 2, maxControls: 1, other: 1 },
  });
  expect(summary.totals).toEqual({
    probed: 3,
    skipped: 3,
    notReached: 4,
    blocked: 3,
    nonSafeSent: 0,
  });
  const [sentence] = renderInteractionSentences(summary);
  expect(sentence).toContain(
    "Idiom interacted with this page: it clicked 3 controls at desktop/light within a 45 s budget (at most 40 controls).",
  );
  expect(sentence).toContain(
    "Skipped: 1 destructive-looking control (delete, sign out, purchase…), 1 already-selected or drag control, 1 other.",
  );
  expect(sentence).toContain(
    "4 controls were not probed: 2 because the budget ran out, 1 beyond the 40-control cap, 1 for other limits.",
  );
  expect(sentence).toContain(
    "Blocked: 1 cross-origin navigation, 2 form submissions, 0 downloads, 0 new windows, 0 permission prompts; 4 non-GET requests were blocked and none left the browser.",
  );
  expect(interactionTail(summary)).toBe(
    "probed 3 controls, skipped 3, not probed 4",
  );
});

test("a probed page without probe evidence is reported as unavailable", () => {
  const summary = summarize([tuple(undefined, "navigation timed out")]);
  if (summary.status !== "probed") throw new Error("expected probed");
  expect(summary.pages[0]).toMatchObject({
    probeStatus: "unavailable",
    probed: 0,
    reason: "navigation timed out",
  });
  expect(renderInteractionSentences(summary)).toEqual([
    "Idiom could not interact with this page at desktop/light: navigation timed out.",
  ]);
});

test("the off summary says the review is static", () => {
  const summary = summarizeQuickInteraction({
    tuples: [],
    probed: [],
    enabled: false,
    budgetMs: 45_000,
    maxControls: 40,
  });
  expect(summary).toEqual({ status: "off" });
  expect(renderInteractionSentences(summary)[0]).toContain(
    "Interaction probe off (--no-probe): this is a static review.",
  );
  expect(interactionTail(summary)).toBe("probe off");
});

test("non-safe sent requests are counted by method", () => {
  expect(
    nonSafeSent({
      sent: { GET: 9, HEAD: 1, OPTIONS: 1, POST: 2, PUT: 1, DELETE: 1 },
      blocked: {},
    }),
  ).toBe(4);
});

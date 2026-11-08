import { findingSchema } from "../src/schemas/finding.js";
import type { UnruledDecision } from "../src/schemas/ruling.js";

export function referenceQuestion() {
  return findingSchema.parse({
    id: "finding-1",
    fingerprint: "ref-fingerprint",
    commit: "abc",
    createdAt: "2026-11-07T00:00:00.000Z",
    flow: "site",
    state: "home",
    viewport: "wide",
    colorScheme: "light",
    layer: "deterministic",
    category: "design-drift",
    severity: "minor",
    confidence: 1,
    rule: "idiom:design-decision",
    status: "open",
    explanation: "Card radius: two references disagree.",
    evidence: {
      screenshots: ["home/wide/light/screenshot.png"],
      designDrift: {
        version: 1,
        pairId: "card",
        method: "role-name",
        property: "borderRadius",
        designValue: "8px",
        appValue: "8px",
        designSelector: ".card",
        appSelector: ".card",
        crops: [{ label: "App capture", path: "crops/card.png" }],
        designDecision: {
          version: 1,
          decisionKey: "decision:card.radius",
          property: "borderRadius",
          appSelector: ".card",
          appValue: "8px",
          references: [
            {
              name: "Designer’s 'reference'",
              source: "designs/a.html",
              value: "8px",
              matchesBuild: true,
              pairId: "card",
              designSelector: ".card",
              link: "https://example.com/design#card",
            },
            {
              name: "prototype",
              source: "designs/b.html",
              value: "12px",
              matchesBuild: false,
              pairId: "card",
              designSelector: ".card",
            },
          ],
        },
      },
    },
    verification: { kind: "deterministic-check", check: "design-drift" },
    acceptance: ["A person chooses the intended reference."],
  });
}
export function unruledQuestion(): UnruledDecision {
  return {
    id: "ruling-1",
    fingerprint: "chip-fingerprint",
    choiceKey: "chip-selection",
    question: "How should selection be shown?",
    nearestLawExcerpt: "Use observable UI behavior.",
    occurrences: [
      { state: "ready", viewport: "wide", screenshot: "ready/wide" },
      { state: "done", viewport: "wide", screenshot: "done/wide" },
    ],
    candidates: [
      {
        wording: "Selected chips use a filled treatment.",
        precedent: { kind: "law", excerpt: "Use observable UI behavior." },
      },
    ],
  };
}

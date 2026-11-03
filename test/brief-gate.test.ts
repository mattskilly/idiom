import { expect, test } from "vitest";
import {
  classifyBriefs,
  classifyTriage,
  findTicketBriefs,
  type GateResult,
  renderGate,
} from "../src/brief/gate.js";

test("finds brief links in bullets, YAML and bold markdown", () => {
  expect(findTicketBriefs("# Pin\n\n- brief: pinned-group\n")).toEqual([
    { source: "link", slug: "pinned-group" },
  ]);
  expect(
    findTicketBriefs("---\ntitle: Pin\nbrief: pinned-group\n---\n\nBody"),
  ).toEqual([{ source: "link", slug: "pinned-group" }]);
  expect(findTicketBriefs("**Brief:** `pinned-group`\n")).toEqual([
    { source: "link", slug: "pinned-group" },
  ]);
  expect(
    findTicketBriefs("brief: pinned-group\n* Brief: pinned-group\n"),
  ).toEqual([{ source: "link", slug: "pinned-group" }]);
});

test("reads brief = in leading TOML front matter, not in a body snippet", () => {
  expect(
    findTicketBriefs(
      '+++\nid = "file-239"\ntitle = "Pin"\nbrief = "pinned-group"\n+++\n\nBody\n',
    ),
  ).toEqual([{ source: "link", slug: "pinned-group" }]);
  expect(
    findTicketBriefs('# Pin\n\nSet this:\n\nbrief = "pinned-group"\n'),
  ).toEqual([]);
});

test("finds an embedded rendered brief by its status line", () => {
  expect(
    findTicketBriefs(
      "# Pinned group\n\nStatus: decided · decided by requester · rubric v1\n",
    ),
  ).toEqual([{ source: "embedded", status: "decided" }]);
  expect(
    findTicketBriefs(
      "Status: proposed · not ticket-ready · research incomplete · rubric v2\n",
    ),
  ).toEqual([{ source: "embedded", status: "proposed" }]);
  expect(
    findTicketBriefs(
      "Status: superseded · superseded by pinned-group-v2 · rubric v1\n",
    ),
  ).toEqual([
    {
      source: "embedded",
      status: "superseded",
      supersededBy: "pinned-group-v2",
    },
  ]);
});

test("ignores prose and anything inside code fences", () => {
  expect(
    findTicketBriefs("Brief: we should add a pin to every tile.\n"),
  ).toEqual([]);
  expect(
    findTicketBriefs(
      "Example:\n\n```md\nbrief: pinned-group\nStatus: decided · rubric v1\n```\n\n~~~\nbrief: other\n~~~\n",
    ),
  ).toEqual([]);
});

test("the worst brief decides", () => {
  expect(
    classifyBriefs("t.md", [
      { source: "link", slug: "a", status: "decided" },
      { source: "link", slug: "b", status: "proposed" },
    ]),
  ).toMatchObject({ outcome: "warn", reason: "proposed" });
  expect(
    classifyBriefs("t.md", [
      { source: "link", slug: "a", status: "superseded" },
      {
        source: "link",
        slug: "b",
        status: "missing",
        error: "no brief named b",
      },
    ]),
  ).toMatchObject({ outcome: "warn", reason: "missing-brief" });
  expect(
    classifyBriefs("t.md", [{ source: "embedded", status: "decided" }]),
  ).toMatchObject({ outcome: "pass", reason: "decided" });
  const superseded = classifyBriefs("t.md", [
    { source: "link", slug: "a", status: "superseded", supersededBy: "a-v2" },
  ]);
  expect(superseded.reason).toBe("superseded");
  expect(superseded.message).toContain("superseded by a-v2");
  expect(superseded.next).toEqual(["link the superseding brief: brief: a-v2"]);
});

test("renderGate is empty when every ticket passes", () => {
  const result: GateResult = {
    strict: false,
    warnings: 0,
    tickets: [
      classifyBriefs("ok.md", [{ source: "embedded", status: "decided" }]),
    ],
  };
  expect(renderGate(result)).toBe("");
});

test("the no-brief warning lists each question and both ways to research", () => {
  const ticket = classifyTriage("tickets/pin.md", "triage-0123456789", {
    verdict: "design decision",
    reason: "adds a per-tile control",
    questions: ["How large is the pin?", "How does it behave on touch?"],
  });
  expect(renderGate({ strict: false, warnings: 1, tickets: [ticket] })).toBe(
    [
      "Warning: tickets/pin.md adds a design decision with no brief.",
      "  - How large is the pin?",
      "  - How does it behave on touch?",
      '  Run: idiom brief plan triage-0123456789 (or: idiom brief "tickets/pin.md" --research)',
      '  Then link it with a "brief: <slug>" line, or paste .idiom/briefs/<slug>.md into the ticket.',
      "1 of 1 ticket(s) need a decided brief.",
    ].join("\n"),
  );
});

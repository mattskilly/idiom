import { expect, test } from "vitest";
import { fileDiff } from "../src/learn/diff.js";
import {
  interpretObservation,
  singularize,
  subjectTokens,
} from "../src/learn/interpret.js";
import { appendJsonArrayItem } from "../src/learn/json-edit.js";

test.each([
  [
    "the override dots should be 8px",
    { kind: "component", subject: "override dots", width: 8, height: 8 },
  ],
  [
    "Status pills must be 32×24px.",
    { kind: "component", subject: "Status pills", width: 32, height: 24 },
  ],
  [
    "the avatar needs to be 24 x 24",
    { kind: "component", subject: "avatar", width: 24, height: 24 },
  ],
  [
    "the toolbar should be 40px tall",
    { kind: "invariant", subject: "toolbar", height: 40 },
  ],
  [
    "the sidebar should be 280px wide",
    { kind: "invariant", subject: "sidebar", width: 280 },
  ],
  [
    'say "Sign in" not "Log in"',
    { kind: "glossary", term: "Log in", preferred: "Sign in" },
  ],
  [
    '"Log in" should say "Sign in"',
    { kind: "glossary", term: "Log in", preferred: "Sign in" },
  ],
  [
    "the left rail and the right rail should mirror horizontally",
    {
      kind: "mirrored",
      subjects: ["left rail", "right rail"],
      axis: "horizontal",
    },
  ],
  [
    "prev button and next button should mirror each other",
    {
      kind: "mirrored",
      subjects: ["prev button", "next button"],
      axis: "vertical",
    },
  ],
  ["section headers never use all caps", { kind: "ruling" }],
  ["the dots feel too big", { kind: "ruling" }],
])("%s", (observation, expected) => {
  expect(interpretObservation(observation)).toEqual(expected);
});

test("singularize and subject tokens", () => {
  expect(singularize("override dots")).toBe("override dot");
  expect(singularize("category pills")).toBe("category pill");
  expect(singularize("entries")).toBe("entry");
  expect(singularize("glasses")).toBe("glass");
  expect(singularize("status")).toBe("status");
  expect(singularize("class")).toBe("class");
  expect(subjectTokens("The Override-Dots")).toEqual(["override", "dot"]);
});

test("fileDiff renders one hunk with context, and new files from /dev/null", () => {
  const before = "a\nb\nc\nd\ne\nf\ng\n";
  const after = "a\nb\nc\nd\nX\ne\nf\ng\n";
  expect(fileDiff("x.txt", before, after)).toBe(
    [
      "--- a/x.txt",
      "+++ b/x.txt",
      "@@ -2,6 +2,7 @@",
      " b",
      " c",
      " d",
      "+X",
      " e",
      " f",
      " g",
      "",
    ].join("\n"),
  );
  expect(fileDiff("new.jsonl", undefined, "{}\n")).toBe(
    ["--- /dev/null", "+++ b/new.jsonl", "@@ -0,0 +1,1 @@", "+{}", ""].join(
      "\n",
    ),
  );
});

test("appendJsonArrayItem edits in place and keeps the rest of the file as written", () => {
  const source =
    '{\n  "viewports": [{ "name": "desktop" }],\n  "checks": {\n    "components": []\n  }\n}\n';
  expect(
    appendJsonArrayItem(source, ["checks", "components"], { name: "dot" }),
  ).toBe(
    '{\n  "viewports": [{ "name": "desktop" }],\n  "checks": {\n    "components": [\n      {\n        "name": "dot"\n      }\n    ]\n  }\n}\n',
  );
  expect(
    appendJsonArrayItem(source, ["checks", "copy", "glossary"], { term: "x" }),
  ).toBe(
    '{\n  "viewports": [{ "name": "desktop" }],\n  "checks": {\n    "components": [],\n    "copy": {\n      "glossary": [\n        {\n          "term": "x"\n        }\n      ]\n    }\n  }\n}\n',
  );
  expect(appendJsonArrayItem(source, ["viewports"], { name: "m" })).toBe(
    '{\n  "viewports": [{ "name": "desktop" }, {"name":"m"}],\n  "checks": {\n    "components": []\n  }\n}\n',
  );
  expect(
    appendJsonArrayItem(
      '{"states":[{"id":"a"}]}',
      ["states", 0, "invariants"],
      1,
    ),
  ).toBe('{"states":[{"id":"a", "invariants": [1]}]}');
  expect(appendJsonArrayItem("{ not json", ["a"], 1)).toBeUndefined();
  expect(appendJsonArrayItem('{"a": 1}', ["a"], 1)).toBeUndefined();
});

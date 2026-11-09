import { expect, test } from "vitest";
import {
  copyQuoteRanges,
  copyQuoteSegments,
} from "../src/checks/copy-quotes.js";
import { codeContext } from "../src/checks/shared.js";
import type { ObservedElementV2 } from "../src/checks/types.js";

// Minimal records exercise only classifier evidence; browser coverage supplies full artifacts.
function element(
  tag = "div",
  path = `html[0]/body[0]/${tag}[0]`,
  extra: Record<string, unknown> = {},
) {
  return {
    tag,
    structuralPath: path,
    attributes: {},
    styles: { display: "block", fontFamily: "sans-serif" },
    ...extra,
  } as ObservedElementV2;
}
const root = "html[0]/body[0]";
test.each(["pre", "code", "kbd", "samp", "textarea"])(
  "semantic %s owners and missing ancestors",
  (tag) => {
    const owner = element(tag);
    const child = element("span", `${owner.structuralPath}/span[0]`);
    expect(codeContext([owner, child]).isCode(owner)).toBe(true);
    expect(codeContext([child]).isCode(child)).toBe(true);
  },
);
test.each([
  ["code", true],
  ["unknown code button", true],
  ["button code", false],
  ["decode", false],
  ["presentation code", false],
  ["none code", false],
  ["unknown", false],
])("effective fallback role %s", (role, expected) => {
  const owner = element("div", `${root}/div[0]`, {
    attributes: { role },
    visible: false,
  });
  const child = element("span", `${owner.structuralPath}/span[0]`);
  const context = codeContext([owner, child]);
  expect(context.isCode(owner)).toBe(expected);
  expect(context.isCode(child)).toBe(expected);
  expect(context.ancestry(child.structuralPath)).toEqual([child, owner]);
});
test.each([
  ["monospace", true],
  ['"UI-MONOSPACE"', true],
  ["Menlo, monospace", true],
  ["'Courier New', serif", true],
  ["Consolas", true],
  ["Monaco", true],
  ["SFMono-Regular", true],
  ['"Some monospace font", serif', false],
  ["CustomFixedWidth", false],
  ["sans-serif", false],
])("authored mono family tokens %s", (fontFamily, expected) => {
  const owner = element("div", `${root}/div[0]`, {
    styles: { display: "block", fontFamily },
    authoredProperties: ["fontFamily"],
  });
  const child = element("span", `${owner.structuralPath}/span[0]`);
  expect(codeContext([owner, child]).isCode(child)).toBe(expected);
});
test.each([
  "block",
  "flow-root",
  "list-item",
  "flex",
  "grid",
  "table",
  "table-cell",
  "table-row",
  "table-caption",
])("mono block display %s", (display) => {
  const owner = element("div", `${root}/div[0]`, {
    styles: { display, fontFamily: "monospace" },
    authoredProperties: ["font"],
  });
  expect(codeContext([owner]).isCode(owner)).toBe(true);
});
test.each([
  "inline",
  "inline-block",
  "inline-flex",
  "inline-grid",
  "contents",
  "none",
])("inline or absent block evidence: %s", (display) => {
  const owner = element("em", `${root}/em[0]`, {
    styles: { display, fontFamily: "monospace" },
    authoredProperties: ["fontFamily"],
  });
  expect(codeContext([owner]).isCode(owner)).toBe(false);
});
test("font change needs an observed parent; inherited mono is not a new declaration", () => {
  const parent = element("div", `${root}/div[0]`, {
    styles: { display: "inline", fontFamily: "monospace" },
  });
  const child = element("div", `${parent.structuralPath}/div[0]`, {
    styles: { display: "block", fontFamily: "monospace" },
  });
  expect(codeContext([parent, child]).isCode(child)).toBe(false);
  expect(codeContext([child]).isCode(child)).toBe(false);
  const sans = { ...parent, styles: { ...parent.styles, fontFamily: "serif" } };
  expect(codeContext([sans, child]).isCode(child)).toBe(true);
});

test.each([
  ['Say "Save save" then open open', ['"Save save"']],
  ["Say 'Save save'", ["'Save save'"]],
  ["“Save save” ‘Open open’", ["“Save save”", "‘Open open’"]],
  ["“outer ‘inner’ end”", ["“outer ‘inner’ end”", "‘inner’"]],
  [String.raw`\"Save save\"`, []],
  ['"Save save', []],
  ["Users' choices aren't aren't final", []],
  ["‘It’s it’s’", ["‘It’s it’s’"]],
])("balanced quotation positions: %s", (text, quoted) => {
  expect(
    copyQuoteRanges(text).map(({ start, end }) => text.slice(start, end)),
  ).toEqual(quoted);
  expect(
    copyQuoteSegments(text)
      .map((segment) => segment.text)
      .join(""),
  ).toBe(text);
});
test("identical quoted and unquoted phrases retain distinct ranges", () => {
  expect(copyQuoteSegments("“open open” open open")).toEqual([
    { text: "“open open”", quoted: true },
    { text: " open open", quoted: false },
  ]);
});

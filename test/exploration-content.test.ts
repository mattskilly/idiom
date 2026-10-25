import { expect, test } from "vitest";
import type { ObservationArtifactV2 } from "../src/checks/types.js";
import {
  assertCandidateCopy,
  assertSafeGeneratedContent,
  copyCorpus,
  domCopyValues,
  normalizeCopy,
} from "../src/explore/content.js";

function observations(
  values: Array<{
    text: string;
    tag?: string;
    temporal?: boolean;
    attributes?: Record<string, string>;
  }>,
): ObservationArtifactV2 {
  return {
    version: 2,
    viewport: { width: 100, height: 100 },
    document: {
      scrollWidth: 100,
      scrollHeight: 100,
      clientWidth: 100,
      clientHeight: 100,
    },
    headings: [],
    tokens: { status: "not-configured" },
    maskMembership: [],
    elements: values.map((value, index) => ({
      selector: `#item-${index}`,
      tag: value.tag ?? "div",
      text: value.text,
      directText: value.text,
      visible: true,
      interactive: false,
      enabled: true,
      rect: { x: 0, y: 0, width: 1, height: 1 },
      relativeRect: { x: 0, y: 0, width: 1, height: 1 },
      scrollWidth: 1,
      scrollHeight: 1,
      clientWidth: 1,
      clientHeight: 1,
      outOfFlow: false,
      ancestorSelectors: [],
      attributes: value.attributes ?? {},
      temporal: value.temporal ?? false,
      structuralPath: `html/body/div[${index + 1}]`,
      stableIslandPath: "html/body",
      styles: {} as ObservationArtifactV2["elements"][number]["styles"],
      hitTestWith: [],
    })),
  };
}

test("copy normalization and DOM channels cover placeholders and rendered input values", () => {
  expect(normalizeCopy("  Ｃhoose\n a slot ")).toBe("Choose a slot");
  expect(
    domCopyValues(
      '<input placeholder="Where?" aria-placeholder="Place"><input type="submit" value="Continue">',
    ),
  ).toEqual(["Where?", "Place", "Continue"]);
  expect(
    domCopyValues(
      '<input placeholder="e.g. > 5 guests"><button value="Next >">Next</button>',
    ),
  ).toEqual(["e.g. > 5 guests", "Next >"]);
  expect(
    domCopyValues('<input type="text" @input="search()" placeholder="Search">'),
  ).toEqual(["Search"]);
  expect(
    domCopyValues(
      '<html><body><script>var t=document.querySelector("input");if(t.value<max){t.value="1"}</script><input type="submit" value="Book"></body></html>',
    ),
  ).toEqual(["Book"]);
  expect(
    domCopyValues(
      '<html><body><!-- <input placeholder="Ignore"> --><style>.a<b{value:x}</style><textarea placeholder="Notes">a<b</textarea></body></html>',
    ),
  ).toEqual(["Notes"]);
});

test("candidate copy permits splits, hidden baseline values, and temporal drift but rejects invention", () => {
  const baseline = observations([
    { text: "Choose a time slot" },
    { text: "Starts at 3:00pm", temporal: true },
    { text: "Advanced options" },
  ]);
  const corpus = copyCorpus(baseline, '<input placeholder="Where?">');
  expect(() =>
    assertCandidateCopy({
      baselineCorpus: corpus,
      observations: observations([
        { text: "Choose" },
        { text: "a time slot" },
        { text: "Starts at" },
        { text: "4:15pm", temporal: true },
        { text: "Advanced options" },
      ]),
      dom: '<input placeholder="Where?">',
      coordinate: "state/desktop/light",
    }),
  ).not.toThrow();
  expect(() =>
    assertCandidateCopy({
      baselineCorpus: corpus,
      observations: observations([{ text: "Brand new feature" }]),
      dom: "<main></main>",
      coordinate: "state/desktop/light",
    }),
  ).toThrow("introduces copy");
  for (const text of [
    "You may add more options",
    "Sunday availability",
    "Deadline is March 4",
  ]) {
    expect(() =>
      assertCandidateCopy({
        baselineCorpus: corpus,
        observations: observations([{ text }]),
        dom: "<main></main>",
        coordinate: "state/desktop/light",
      }),
    ).toThrow("introduces copy");
  }
});

test("candidate copy excludes inline script and style payloads on both sides", () => {
  const baseline = observations([
    { text: "Choose a time slot", tag: "h1" },
    {
      tag: "script",
      text: 'self.__next_f.push([1,"className\\":\\"flex gap-2"])',
    },
    { tag: "style", text: ".slot{display:flex}" },
  ]);
  const corpus = copyCorpus(
    baseline,
    '<script>self.__next_f.push([1,"baseline"])</script>',
  );
  expect(corpus).toBe("Choose a time slot");
  expect(() =>
    assertCandidateCopy({
      baselineCorpus: corpus,
      observations: observations([
        { text: "Choose a time slot", tag: "h1" },
        {
          tag: "script",
          text: 'self.__next_f.push([1,"className\\":\\"grid gap-4"])',
        },
        { tag: "style", text: ".slot{display:grid}" },
      ]),
      dom: '<script>self.__next_f.push([1,"candidate"])</script>',
      coordinate: "choose-slot/desktop/light",
    }),
  ).not.toThrow();
});

test("generated content accepts baseline literals and rejects dynamic or invented copy", () => {
  const corpus = "Continue Advanced options";
  expect(() =>
    assertSafeGeneratedContent(
      [
        {
          path: "src/app.css",
          oldText: ".a { color: red }",
          newText: '.a::after { content: "Continue" }',
        },
      ],
      corpus,
    ),
  ).not.toThrow();
  expect(() =>
    assertSafeGeneratedContent(
      [
        {
          path: "src/app.css",
          oldText: ".a { color: red }",
          newText: ".a::after { content: attr(title) }",
        },
      ],
      corpus,
    ),
  ).toThrow("dynamic CSS content");
  expect(() =>
    assertSafeGeneratedContent(
      [
        {
          path: "src/app.tsx",
          oldText: "color: 'red'",
          newText: `content: '"Invented"'`,
        },
      ],
      corpus,
    ),
  ).toThrow("introduces copy");
  expect(() =>
    assertSafeGeneratedContent(
      [
        {
          path: "src/app.tsx",
          oldText: "const D = styled.div`color: red;`;",
          newText:
            'const D = styled.div`\n  color: red;\n  &::after { content: "Book a demo now"; }\n`;',
        },
      ],
      corpus,
    ),
  ).toThrow("introduces copy");
  expect(() =>
    assertSafeGeneratedContent(
      [
        {
          path: "src/app.tsx",
          oldText: "const D = css`color: red;`;",
          newText:
            "const D = css`\n  color: red;\n  &::after { content: attr(data-x); }\n`;",
        },
      ],
      corpus,
    ),
  ).toThrow("dynamic CSS content");
  expect(() =>
    assertSafeGeneratedContent(
      [
        {
          path: "src/app.tsx",
          oldText: "const D = styled.div`color: red;`;",
          newText:
            'const D = styled.div`\n  &::after { content: "Continue"; }\n`;',
        },
      ],
      corpus,
    ),
  ).not.toThrow();

  for (const newText of [
    'content: "none"',
    `content: '""'`,
    `content: "''"`,
    "content: <Options />",
    "content: ReactNode",
  ]) {
    expect(() =>
      assertSafeGeneratedContent(
        [
          {
            path: "src/app.tsx",
            oldText: "color: 'red'",
            newText,
          },
        ],
        corpus,
      ),
    ).not.toThrow();
  }

  for (const path of [
    "src/app.scss",
    "src/app.sass",
    "src/app.less",
    "src/app.styl",
    "src/App.vue",
    "src/App.svelte",
    "index.html",
  ]) {
    const component = /\.(?:vue|svelte|html?)$/i.test(path);
    expect(() =>
      assertSafeGeneratedContent(
        [
          {
            path,
            oldText: component
              ? "<style>.a { color: red }</style>"
              : ".a { color: red }",
            newText: component
              ? '<style>.a::after { content: "Book a demo now" }</style>'
              : '.a::after { content: "Book a demo now" }',
          },
        ],
        corpus,
      ),
    ).toThrow("introduces copy");
  }
});

test("generated content accepts unbalanced edit fragments and validates their complete CSS files", () => {
  const edit = {
    path: "src/app.css",
    oldText: "  gap: 4px;\n}\n.b {\n  margin: 0;",
    newText: "  gap: 8px;\n}\n.b {\n  margin: 0;",
  };
  expect(() => assertSafeGeneratedContent([edit], "Continue")).not.toThrow();
  expect(() =>
    assertSafeGeneratedContent([edit], "Continue", [
      {
        path: edit.path,
        before: `.a {\n${edit.oldText}\n}\n`,
        after: `.a {\n${edit.newText}\n}\n`,
      },
    ]),
  ).not.toThrow();
});

test("generated content validates CSS in untagged JavaScript templates and strings", () => {
  const corpus = "Choose a time slot Advanced options";
  const templateBefore = 'const sheet = `\n.slot::after { content: ""; }\n`;';
  const templateAfter =
    'const sheet = `\n.slot::after { content: "Only 2 left — book now"; }\n`;';
  expect(() =>
    assertSafeGeneratedContent(
      [
        {
          path: "src/ui/slot.ts",
          oldText: 'content: ""',
          newText: 'content: "Only 2 left — book now"',
        },
      ],
      corpus,
      [
        {
          path: "src/ui/slot.ts",
          before: templateBefore,
          after: templateAfter,
        },
      ],
    ),
  ).toThrow("introduces copy");

  const stringBefore = `const sheet = '.slot::after { content: ""; }';`;
  const stringAfter = `const sheet = '.slot::after { content: attr(data-label); }';`;
  expect(() =>
    assertSafeGeneratedContent(
      [
        {
          path: "src/ui/slot.ts",
          oldText: 'content: ""',
          newText: "content: attr(data-label)",
        },
      ],
      corpus,
      [
        {
          path: "src/ui/slot.ts",
          before: stringBefore,
          after: stringAfter,
        },
      ],
    ),
  ).toThrow("dynamic CSS content");
});

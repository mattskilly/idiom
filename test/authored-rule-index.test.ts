import { beforeAll, describe, expect, test } from "vitest";
import {
  type AuthoredRuleIndexFactory,
  installAuthoredRuleIndex,
} from "../src/checks/authored-rules-dom.js";

type Rule = { selector: string; order: number };

let createIndex: AuthoredRuleIndexFactory;
beforeAll(() => {
  installAuthoredRuleIndex();
  const factory = globalThis.__idiomAuthoredRuleIndex;
  if (!factory) throw new Error("index not installed");
  createIndex = factory;
});

const el = (localName: string, classes: string[] = [], id = "") => ({
  id,
  classes,
  localName,
});

const isCandidate = (
  selector: string,
  element: ReturnType<typeof el>,
): boolean => {
  const rule = { selector, order: 0 };
  return createIndex([rule]).candidates(element).includes(rule);
};

const isUniversal = (selector: string): boolean =>
  createIndex([{ selector, order: 0 }]).stats.universal === 1;

describe("authored rule index keys", () => {
  // selector, element that must receive it, element that must not (or
  // undefined when the selector belongs in the universal bucket).
  const cases: Array<
    [string, ReturnType<typeof el>, ReturnType<typeof el> | undefined]
  > = [
    [".a", el("div", ["a"]), el("div", ["b"])],
    ["div.a", el("span", ["a"]), el("div", ["b"])],
    ["#x.a", el("div", [], "x"), el("div", ["a"])],
    [".p > .c", el("div", ["c"]), el("div", ["p"])],
    [".p .c:hover", el("div", ["c"]), el("div", ["p"])],
    ["ul li", el("li"), el("ul")],
    ["ul>li", el("li"), el("ul")],
    [".a ~ .b", el("div", ["b"]), el("div", ["a"])],
    [".a + .b", el("div", ["b"]), el("div", ["a"])],
    [".a::before", el("div", ["a"]), el("div", ["b"])],
    [".md\\:flex", el("div", ["md:flex"]), el("div", ["md"])],
    [".w-1\\/2", el("div", ["w-1/2"]), el("div", ["w-1"])],
    [".\\31 0", el("div", ["10"]), el("div", ["1"])],
    [".\\31 0.x", el("div", ["10"]), el("div", ["x"])],
    ['.a[data-x="b c"]', el("div", ["a"]), el("div", ["b"])],
    ['[data-x="a > b"] .c', el("div", ["c"]), el("div", ["a"])],
    [".a:nth-child(2n + 1 of .b)", el("div", ["a"]), el("div", ["b"])],
    ["div:not(.a)", el("div"), el("span", ["a"])],
    ["*.a", el("div", ["a"]), el("div")],
    ["*", el("div"), undefined],
    ["[data-x]", el("div"), undefined],
    [":is(.a,.b)", el("div"), undefined],
    [":not(.a)", el("div"), undefined],
    ["::selection", el("div"), undefined],
    ["svg|rect", el("rect"), undefined],
    ["*|div", el("div"), undefined],
    ["&.a", el("div"), undefined],
  ];
  test.each(cases)("%s", (selector, hit, miss) => {
    expect(isCandidate(selector, hit)).toBe(true);
    if (miss === undefined) expect(isUniversal(selector)).toBe(true);
    else {
      expect(isUniversal(selector)).toBe(false);
      expect(isCandidate(selector, miss)).toBe(false);
    }
  });

  test("a selector list files the rule under every alternative's key", () => {
    const rule = { selector: ".a, #b, span", order: 0 };
    const index = createIndex([rule]);
    expect(index.candidates(el("div", ["a"]))).toEqual([rule]);
    expect(index.candidates(el("div", [], "b"))).toEqual([rule]);
    expect(index.candidates(el("span"))).toEqual([rule]);
    expect(index.candidates(el("div", ["b"], "a"))).toEqual([]);
  });

  test("keys compare ASCII case-insensitively so quirks-mode matches stay candidates", () => {
    expect(isCandidate(".Foo", el("div", ["foo"]))).toBe(true);
    expect(isCandidate(".Foo", el("div", ["Foo"]))).toBe(true);
    expect(isCandidate(".foo", el("div", ["FOO"]))).toBe(true);
    expect(isCandidate("#Main", el("div", [], "main"))).toBe(true);
    expect(isCandidate("DIV", el("div"))).toBe(true);
    expect(isCandidate("linearGradient", el("linearGradient"))).toBe(true);
  });

  test("unparseable selectors fall back to universal instead of throwing", () => {
    for (const selector of [".a[", ".", "#", ".a:", ".a\\"])
      expect(isUniversal(selector)).toBe(true);
  });
});

describe("authored rule index candidates", () => {
  test("come back deduped in ascending order across buckets", () => {
    const rules: Rule[] = [
      { selector: ".b", order: 0 },
      { selector: ".a, .b", order: 1 },
      { selector: "[data-x]", order: 2 },
      { selector: "div", order: 3 },
      { selector: ".a", order: 4 },
      { selector: "#x", order: 5 },
      { selector: ".c", order: 6 },
    ];
    const index = createIndex(rules);
    expect(
      index.candidates(el("div", ["a", "b"], "x")).map((rule) => rule.order),
    ).toEqual([0, 1, 2, 3, 4, 5]);
  });

  test("bound selector-matching work on many elements and many rules", () => {
    const elements = 2_000;
    const keyed = 2_000;
    const universal = 20;
    const rules: Rule[] = [];
    for (let i = 0; i < keyed; i += 1)
      rules.push({ selector: `.c-${i}`, order: rules.length });
    for (let i = 0; i < universal; i += 1)
      rules.push({
        selector: i % 2 === 0 ? `[data-x="${i}"]` : "*",
        order: rules.length,
      });
    const index = createIndex(rules);
    expect(index.stats).toMatchObject({ rules: keyed + universal, universal });
    for (let i = 0; i < elements; i += 1) {
      const candidates = index.candidates(el("div", [`c-${i}`]));
      expect(candidates[0]?.selector).toBe(`.c-${i}`);
    }
    expect(index.stats.candidateChecks).toBe(elements * (1 + universal));
    expect(index.stats.candidateChecks).toBeLessThan(
      (elements * rules.length) / 50,
    );
  });
});

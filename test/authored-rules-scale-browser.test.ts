import { chromium } from "playwright";
import { expect, test } from "vitest";
import { observePage } from "../src/checks/observe.js";
import type { ObservedElementV2 } from "../src/checks/types.js";

const ELEMENTS = 400;
const CLASS_RULES = 1_200;
const DESCENDANT_RULES = 200;
const ID_RULES = 100;

const rules: string[] = [];
for (let i = 0; i < CLASS_RULES; i += 1)
  rules.push(`.gen-r-${i} { color: rgb(${i % 255}, 0, 0); }`);
for (let i = 0; i < DESCENDANT_RULES; i += 1)
  rules.push(`.gen-wrap .gen-r-${i} { margin-top: 1px; }`);
for (let i = 0; i < ID_RULES; i += 1)
  rules.push(`#gen-id-${i} { padding-left: 2px; }`);
rules.push(
  "[data-gen-k] { border-top-width: 1px; }",
  ":where(.gen-r-7) { letter-spacing: 1px; }",
  ".gen-esc\\:x { text-decoration: underline; }",
  ".gen-nest { & .gen-r-9 { opacity: 0.5; } }",
  "@media (max-width: 1px) { .gen-r-11 { font-style: italic; } }",
  "@media (min-width: 1px) { .gen-r-12 { font-weight: 700; } }",
);

const items: string[] = [];
for (let i = 0; i < ELEMENTS; i += 1)
  items.push(
    `<div id="gen-id-${i}" class="gen-r-${i}"${i === 5 ? " data-gen-k" : ""}>item ${i}</div>`,
  );
const markup = `<!doctype html><html><head><style>${rules.join("\n")}</style></head><body>
<div class="gen-wrap gen-nest">${items.join("")}</div>
<p id="gen-esc" class="gen-esc:x">escaped</p>
</body></html>`;

test("authored-property matching stays bounded on many elements and many rules", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({
      viewport: { width: 640, height: 480 },
    });
    await page.setContent(markup);
    const renderedState = () =>
      page.evaluate(() => ({
        html: document.documentElement.outerHTML,
        styles: [...document.querySelectorAll("[id^=gen-]")]
          .slice(0, 20)
          .map((element) => {
            const style = getComputedStyle(element);
            return [style.color, style.marginTop, style.opacity].join("|");
          }),
        scroll: [scrollX, scrollY],
      }));
    const before = await renderedState();
    // Count selector matches against generated selectors only; the naive
    // scan would test every element against every rule (~600k calls).
    await page.evaluate(() => {
      const scope = window as unknown as { __genMatches: number };
      scope.__genMatches = 0;
      const original = Element.prototype.matches;
      Element.prototype.matches = function (selector: string) {
        if (selector.includes("gen-")) scope.__genMatches += 1;
        return original.call(this, selector);
      };
    });
    const observations = await observePage(page, { status: "not-configured" });
    const matchCalls = await page.evaluate(
      () => (window as unknown as { __genMatches: number }).__genMatches,
    );
    const domElements = await page.evaluate(
      () => document.querySelectorAll("*").length,
    );
    expect(matchCalls).toBeGreaterThan(ELEMENTS);
    expect(matchCalls).toBeLessThan(domElements * 10);
    expect(await renderedState()).toEqual(before);

    const element = (selector: string) =>
      (observations.elements as ObservedElementV2[]).find(
        (candidate) => candidate.selector === selector,
      );
    const authored = (selector: string) =>
      element(selector)?.authoredProperties ?? [];
    // Class-keyed, id-keyed and descendant rules.
    expect(authored("#gen-id-3")).toEqual(
      expect.arrayContaining(["color", "marginTop", "paddingLeft"]),
    );
    expect(element("#gen-id-3")?.styleSources?.paddingLeft?.selector).toBe(
      "#gen-id-3",
    );
    expect(element("#gen-id-3")?.styleSources?.marginTop?.selector).toBe(
      ".gen-wrap .gen-r-3",
    );
    expect(authored("#gen-id-300")).toContain("color");
    expect(authored("#gen-id-300")).not.toContain("marginTop");
    expect(authored("#gen-id-300")).not.toContain("paddingLeft");
    // Attribute and :where() rules live in the universal bucket.
    expect(authored("#gen-id-5")).toContain("borderTopWidth");
    expect(authored("#gen-id-6")).not.toContain("borderTopWidth");
    expect(authored("#gen-id-7")).toContain("letterSpacing");
    // Escaped class, nested rule, active and inactive media.
    expect(authored("#gen-esc")).toContain("textDecorationLine");
    expect(authored("#gen-id-9")).toContain("opacity");
    expect(authored("#gen-id-10")).not.toContain("opacity");
    expect(authored("#gen-id-11")).not.toContain("fontStyle");
    expect(authored("#gen-id-12")).toContain("fontWeight");
  } finally {
    await browser.close();
  }
}, 60_000);

test("authored-property matching survives form controls that shadow element properties", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({
      viewport: { width: 640, height: 480 },
    });
    await page.setContent(`<!doctype html><html><head><style>
.edit-form { padding-top: 3px; }
#edit-form { margin-left: 4px; }
form { border-left-width: 1px; }
</style></head><body>
<form id="edit-form" class="edit-form"><input type="hidden" name="id" value="3"><input type="hidden" name="localName"><button>Save</button></form>
</body></html>`);
    const observations = await observePage(page, { status: "not-configured" });
    const form = (observations.elements as ObservedElementV2[]).find(
      (candidate) => candidate.tag === "form",
    );
    expect(form?.authoredProperties).toEqual(
      expect.arrayContaining(["paddingTop", "marginLeft", "borderLeftWidth"]),
    );
  } finally {
    await browser.close();
  }
}, 60_000);

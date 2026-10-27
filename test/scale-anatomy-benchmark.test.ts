import { type Browser, chromium } from "playwright";
import { afterAll, beforeAll, expect, test } from "vitest";
import { observationArtifactSchema } from "../src/checks/artifact-schema.js";
import type { FindingCandidate } from "../src/checks/types.js";
import { fixture, reviewFixture, reviewStates } from "./benchmark-support.js";

let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
});
afterAll(async () => {
  await browser.close();
});

const checks = {
  scales: {
    controlHeights: [28, 32, 40],
    radius: { control: [6], card: [8], panel: [12], chip: ["full"] },
    border: { divider: ["#E5E7EB"], control: ["#D1D5DB"] },
  },
};
const ours = new Set(["scale-conformance", "control-anatomy"]);

async function reported(
  html: string,
  options: Parameters<typeof reviewFixture>[2] = { checks },
): Promise<FindingCandidate[]> {
  return (await reviewFixture(browser, html, options))
    .map(({ candidate }) => candidate)
    .filter((candidate) => ours.has(candidate.category));
}

const value = (candidate: FindingCandidate) =>
  (candidate.verification.params as { value?: string }).value;

test("eight button heights, mixed radii, dark dividers and the Fit chevron are reported (#17, #26)", async () => {
  const found = await reported(await fixture("scale-before.html"));
  const heights = found.filter(
    (candidate) => candidate.rule === "idiom:off-scale-height",
  );
  expect(heights.map(value).sort()).toEqual([
    "24px",
    "26px",
    "30px",
    "36px",
    "50px",
  ]);
  const tall = heights.find((candidate) => value(candidate) === "50px");
  expect(tall?.explanation).toContain("3 buttons at 50px");
  expect(tall?.explanation).toContain("scale is 28/32/40");

  const radii = found.filter(
    (candidate) => candidate.rule === "idiom:off-scale-radius",
  );
  expect(
    radii
      .filter((candidate) => candidate.fingerprintHint?.includes(":control:"))
      .map(value)
      .sort(),
  ).toEqual(["0px", "4px", "50% (ellipse)", "full"]);
  expect(
    radii.find((candidate) => candidate.fingerprintHint?.includes(":card:"))
      ?.explanation,
  ).toContain("3 cards at radius 4px; scale is 8px");

  const dividers = found.filter(
    (candidate) => candidate.rule === "idiom:off-scale-border",
  );
  expect(dividers).toHaveLength(1);
  expect(dividers[0]?.explanation).toContain(
    "5 dividers at rgb(138, 145, 159); scale is #E5E7EB",
  );

  const offCentre = found.filter(
    (candidate) => candidate.rule === "idiom:icon-off-centre",
  );
  expect(offCentre.map((candidate) => candidate.selectorHint).sort()).toEqual([
    "#font",
    "#zoom-fit",
  ]);
  expect(
    offCentre.find((candidate) => candidate.selectorHint === "#zoom-fit")
      ?.explanation,
  ).toBe(
    'The chevron in #zoom-fit sits 3px below the "Fit" label\'s ink centre (tolerance 1px).',
  );
  expect(
    found.filter(
      (candidate) => candidate.rule === "idiom:sibling-select-inconsistent",
    ),
  ).toEqual([]);
}, 60_000);

test.each([
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
])(
  "the repaired fixture is quiet at $width px (#17, #26)",
  async (viewport) => {
    expect(
      await reported(await fixture("scale-after.html"), { checks, viewport }),
    ).toEqual([]);
    expect(
      await reported(await fixture("scale-after.html"), { viewport }),
    ).toEqual([]);
  },
  60_000,
);

test("without declared scales only sharp outliers against the run's prevailing values are reported", async () => {
  const found = await reported(await fixture("scale-before.html"), {});
  const scale = found.filter(
    (candidate) => candidate.category === "scale-conformance",
  );
  expect(new Set(scale.map((candidate) => candidate.rule))).toEqual(
    new Set(["idiom:scale-outlier"]),
  );
  // 4px beside a prevailing 6px is not sharp; heights have no prevailing value.
  expect(scale.map(value).sort()).toEqual(["0px", "50% (ellipse)", "full"]);
  expect(scale[0]?.explanation).toMatch(
    /the run's controls are radius 6px \(\d+ controls\)/,
  );
}, 60_000);

const page = (body: string, css = "") => `<!doctype html><html><head><style>
* { box-sizing: border-box; }
body { margin: 0; padding: 24px; font: 14px/1.4 Helvetica, Arial, sans-serif; display: flex; flex-wrap: wrap; gap: 8px; align-items: flex-start; }
button, select { font: inherit; height: 32px; border: 1px solid #ccc; background: #fff; border-radius: 6px; padding: 0 10px; display: inline-flex; align-items: center; justify-content: center; }
svg { width: 14px; height: 14px; }
${css}
</style></head><body>${body}</body></html>`;
const svg =
  '<svg viewBox="0 0 14 14" aria-hidden="true"><path d="M3 7h8" stroke="currentColor"/></svg>';

test.each([
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
])(
  "table siblings require matching controls at $width px",
  async (viewport) => {
    const table = (padding: number) =>
      page(
        `<table><tbody>
      <tr id="mixed"><td><button id="reviewer" role="combobox" aria-haspopup="listbox"><span>Assign reviewer</span>${svg}</button></td>
      <td><button id="menu" aria-haspopup="menu" aria-label="Open menu"><svg viewBox="0 0 14 14" aria-hidden="true"><circle cx="7" cy="3" r="1"/><circle cx="7" cy="7" r="1"/><circle cx="7" cy="11" r="1"/></svg><span class="sr-only" id="hidden-label">Open menu</span></button></td></tr>
      <tr id="native"><td><select id="native1"><option>One</option></select></td><td><select id="native2" style="padding-left:${padding}px"><option>Two</option></select></td></tr>
      <tr id="custom"><td><button id="custom1" role="combobox" aria-haspopup="listbox">One${svg}</button></td><td><button id="custom2" role="combobox" aria-haspopup="listbox" style="padding-left:${padding}px">Two${svg}</button></td></tr>
    </tbody></table>`,
        `body { padding:8px; } button, select { height:32px; } #menu { width:32px; padding:2px; } #menu svg { width:18px; height:18px; }
    .sr-only { position:absolute; width:1px; height:1px; padding:0; margin:-1px; overflow:hidden; clip:rect(0,0,0,0); white-space:nowrap; border:0; }`,
      );
    const { findings, tuples } = await reviewStates(
      browser,
      [
        { state: "unequal", html: table(14) },
        { state: "corrected", html: table(10) },
      ],
      { viewport },
    );
    for (const tuple of tuples) {
      const observations = tuple.observations;
      if (observations?.version !== 2) throw new Error("expected v2");
      const observed = (selector: string) =>
        observations.elements.find((element) => element.selector === selector);
      expect(observed("#reviewer")?.signals?.role).toBe("combobox");
      expect(observed("#reviewer")?.signals?.renderedContent?.text).toBe(true);
      expect(observed("#menu")?.signals?.role).toBe("button");
      expect(observed("#menu")?.signals?.name).toBe("Open menu");
      expect(observed("#menu")?.signals?.renderedContent).toMatchObject({
        text: false,
        directText: false,
        graphic: true,
      });
      expect(observed("#reviewer")?.rect.height).toBe(
        observed("#menu")?.rect.height,
      );
      expect(observed("#reviewer")?.ancestorSelectors[1]).toBe("#mixed");
      expect(observed("#menu")?.ancestorSelectors[1]).toBe("#mixed");
      for (const selector of ["#native1", "#native2", "#custom1", "#custom2"])
        expect(observed(selector)?.signals?.role).toBe("combobox");
    }
    const siblings = findings.filter(
      ({ candidate }) => candidate.rule === "idiom:sibling-select-inconsistent",
    );
    expect(siblings.filter(({ state }) => state === "corrected")).toEqual([]);
    expect(
      siblings.map(({ candidate }) => candidate.verification.params),
    ).toEqual([
      {
        property: "paddingLeft",
        selectors: ["#custom1", "#custom2"],
        tolerance: 0.5,
      },
      {
        property: "paddingLeft",
        selectors: ["#native1", "#native2"],
        tolerance: 0.5,
      },
    ]);
  },
);

const buttons = (count: number) =>
  Array.from(
    { length: count },
    (_, index) => `<button>Item ${index}</button>`,
  ).join("");

const backgroundChevron = `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='10'%3E%3Cpath d='M2 3 5 6 8 3' fill='none' stroke='black'/%3E%3C/svg%3E")`;

test.each([0, 3, 5])(
  "a segmented control measures a leading glyph against its visible label (%ipx offset)",
  async (offset) => {
    const found = await reported(
      page(
        `<div role="group"><button id="next"><i class="icon" style="display:inline-block;width:14px;height:18px;transform:translateY(${offset}px)">→</i><span>Next</span></button></div>`,
        "button { height:40px; }",
      ),
      {},
    );
    expect(found).toHaveLength(offset === 0 ? 0 : 1);
    if (offset !== 0)
      expect(found[0]).toMatchObject({
        rule: "idiom:icon-off-centre",
        selectorHint: "#next",
        explanation: expect.stringContaining(
          'below the "Next" label\'s ink centre',
        ),
      });
  },
);

test("a segmented control with a multiline label keeps its box reference", async () => {
  expect(
    await reported(
      page(
        '<div role="group"><button><i class="icon" style="display:inline-block;width:14px;height:18px">→</i><span><b>Next</b><br>step</span></button></div>',
        "button { height:80px; }",
      ),
      {},
    ),
  ).toEqual([]);
});

test.each([32, 50])(
  "ARIA tabs and active-descendant options retain their control role (%ipx)",
  async (height) => {
    const { findings, tuples } = await reviewStates(
      browser,
      [
        {
          state: "editor",
          html: page(
            `<div role="tablist"><div role="tab" tabindex="0">Active</div><div id="inactive" role="tab" tabindex="-1" style="height:${height}px">Inactive</div></div>
         <div role="listbox" tabindex="0" aria-activedescendant="selected"><div id="selected" role="option" aria-selected="true">Selected</div><div id="option" role="option" style="height:${height}px">Other</div></div>`,
            '[role="tab"], [role="option"] { height:32px; width:120px; border:1px solid #ccc; }',
          ),
        },
      ],
      { checks: { scales: { controlHeights: [32] } } },
    );
    const observations = tuples[0]?.observations;
    if (observations?.version !== 2) throw new Error("expected v2");
    for (const selector of ["#inactive", "#option"])
      expect(
        observations.elements.find((element) => element.selector === selector)
          ?.interactive,
      ).toBe(false);
    const heights = findings
      .map(({ candidate }) => candidate)
      .filter((candidate) => candidate.rule === "idiom:off-scale-height");
    expect(heights).toHaveLength(height === 32 ? 0 : 1);
    if (height !== 32) {
      expect(heights[0]?.explanation).toContain("2 controls at 50px");
      expect(heights[0]?.explanation).toContain("#inactive, #option");
    }
  },
);

test.each([20, 9999])(
  "a declared numeric %ipx radius accepts the matching pill",
  async (radius) => {
    expect(
      await reported(
        page(
          `<button style="width:120px;height:40px;border-radius:${radius}px">Pill</button>`,
        ),
        {
          checks: { scales: { radius: { control: [radius] } } },
        },
      ),
    ).toEqual([]);
  },
);

test.each([0, 3])(
  "an icon button with a screen-reader label uses its box centre (offset %ipx)",
  async (offset) => {
    const found = await reported(
      page(
        `<button id="close" style="width:40px;height:40px;padding:0">${svg.replace("<svg", `<svg style="transform:translateY(${offset}px)"`)}<span class="sr-only">Close</span></button>`,
        ".sr-only { position:absolute; width:1px; height:1px; padding:0; margin:-1px; overflow:hidden; clip:rect(0,0,0,0); white-space:nowrap; border:0; }",
      ),
      {},
    );
    expect(found).toHaveLength(offset === 0 ? 0 : 1);
    if (offset !== 0)
      expect(found[0]?.explanation).toContain(
        "3px below the vertical centre of its 40px box",
      );
  },
);

test.each(["i", "span"])(
  "a %s glyph icon uses the box centre while a visible label remains a label",
  async (tag) => {
    const icon = `<${tag} class="icon" style="display:inline-block;width:14px;height:14px;transform:translateY(3px)">→</${tag}>`;
    const found = await reported(
      page(
        `<button id="glyph" aria-label="Next">${icon}</button><button id="labelled">${icon}<span>Next</span></button>`,
        "button { height:40px; }",
      ),
      {},
    );
    expect(found).toEqual([
      expect.objectContaining({
        rule: "idiom:icon-off-centre",
        selectorHint: "#glyph",
        explanation: expect.stringContaining(
          "3px below the vertical centre of its 40px box",
        ),
      }),
    ]);
    expect(
      await reported(
        page(
          `<button aria-label="Next">${icon.replace("translateY(3px)", "translateY(0px)")}</button>`,
        ),
        {},
      ),
    ).toEqual([]);
  },
);

test("the trailing background chevron is checked alongside a leading SVG", async () => {
  const found = await reported(
    page(
      `<button id="fit" aria-haspopup="listbox">${svg}Fit</button>`,
      `button { height:40px; width:120px; background-image:${backgroundChevron}; background-repeat:no-repeat; background-size:10px 10px; background-position:right 12px top 80%; }`,
    ),
    {},
  );
  expect(found).toEqual([
    expect.objectContaining({
      rule: "idiom:icon-off-centre",
      selectorHint: "#fit",
      explanation: expect.stringContaining(
        'below the "Fit" label\'s ink centre',
      ),
    }),
  ]);
});

test.each([12, 24])(
  "sibling plain glyph chevrons compare captured sizes (%ipx second glyph)",
  async (size) => {
    const { findings, tuples } = await reviewStates(browser, [
      {
        state: "editor",
        html: page(
          `<div><button id="first" aria-haspopup="listbox"><span id="label1">Fit</span><span id="glyph1" style="font-size:12px;transform:translateY(-1.95px)">▾</span></button><button id="second" aria-haspopup="listbox"><span id="label2">Fit</span><span id="glyph2" style="font-size:${size}px;transform:translateY(${size === 12 ? -1.95 : -3.1}px)">▾</span></button></div>`,
          "button { height:40px; width:120px; } span { display:inline-block; }",
        ),
      },
    ]);
    const observations = tuples[0]?.observations;
    if (observations?.version !== 2) throw new Error("expected v2");
    for (const index of [1, 2]) {
      const label = observations.elements.find(
        (element) => element.selector === `#label${index}`,
      )?.signals;
      const glyph = observations.elements.find(
        (element) => element.selector === `#glyph${index}`,
      )?.signals;
      expect(glyph?.textRect?.width).toBeGreaterThan(7);
      expect(glyph?.textRect?.height).toBeGreaterThan(13);
      if (glyph?.inkCenterY === undefined || label?.inkCenterY === undefined)
        throw new Error("expected captured ink centres");
      expect(Math.abs(glyph.inkCenterY - label.inkCenterY)).toBeLessThan(0.05);
    }
    const anatomy = findings
      .map(({ candidate }) => candidate)
      .filter((candidate) => candidate.category === "control-anatomy");
    expect(
      anatomy.map((candidate) => candidate.fingerprintHint).sort(),
    ).toEqual(
      size === 12
        ? []
        : [
            "anatomy:chevronHeight:#first,#second",
            "anatomy:chevronWidth:#first,#second",
          ],
    );
  },
);

test.each([
  {
    name: "size endpoints",
    property: "size",
    values: [10, 14],
    expected: ["chevronHeight", "chevronWidth"],
  },
  {
    name: "size chain",
    property: "size",
    values: [10, 11, 12, 13, 14],
    expected: ["chevronHeight", "chevronWidth"],
  },
  {
    name: "sizes within tolerance",
    property: "size",
    values: [10, 10.5, 11],
    expected: [],
  },
  {
    name: "padding endpoints",
    property: "padding",
    values: [8, 10],
    expected: ["paddingLeft"],
  },
  {
    name: "padding chain",
    property: "padding",
    values: [8, 8.5, 9, 9.5, 10],
    expected: ["paddingLeft"],
  },
  {
    name: "padding within tolerance",
    property: "padding",
    values: [8, 8.25, 8.5],
    expected: [],
  },
])(
  "sibling tolerance bounds the full spread: $name",
  async ({ property, values, expected }) => {
    const found = await reported(
      page(
        `<div>${values.map((value, index) => `<button id="s${index}" aria-haspopup="listbox" style="padding-left:${property === "padding" ? value : 10}px"><span>Fit</span>${svg.replace("<svg", `<svg style="width:${property === "size" ? value : 10}px;height:${property === "size" ? value : 10}px"`)}</button>`).join("")}</div>`,
        "button { height:40px; width:120px; }",
      ),
      {},
    );
    expect(
      found
        .map(
          (candidate) =>
            (candidate.verification.params as { property: string }).property,
        )
        .sort(),
    ).toEqual(expected);
    expect(
      found.every(
        (candidate) => candidate.rule === "idiom:sibling-select-inconsistent",
      ),
    ).toBe(true);
  },
);

test.each([10, 20])(
  "sibling SVG and background chevrons compare measured sizes (%ipx background)",
  async (size) => {
    const found = await reported(
      page(
        `<div><button id="dom" aria-haspopup="listbox">Fit${svg.replace("<svg", '<svg style="width:20px;height:20px"')}</button><button id="background" aria-haspopup="listbox">Fit</button></div>`,
        `button { height:40px; width:120px; } #background { background-image:${backgroundChevron}; background-repeat:no-repeat; background-size:${size}px ${size}px; background-position:right 12px center; }`,
      ),
      {},
    );
    expect(found.map((candidate) => candidate.fingerprintHint).sort()).toEqual(
      size === 20
        ? []
        : [
            "anatomy:chevronHeight:#background,#dom",
            "anatomy:chevronWidth:#background,#dom",
          ],
    );
  },
);

test.each([
  {
    name: "six 32px buttons and one at 72px give one outlier",
    html: page(`${buttons(6)}<button style="height:72px">Huge</button>`),
    expected: ["idiom:scale-outlier"],
  },
  {
    name: "a uniformly 24px product is consistent",
    html: page(buttons(6), "button { height: 24px; }"),
    expected: [],
  },
  {
    name: "two at 32px and two at 40px have no prevailing value",
    html: page(
      `${buttons(2)}<button style="height:40px">A</button><button style="height:40px">B</button>`,
    ),
    expected: [],
  },
  {
    name: "sibling selects with 8px and 12px left padding",
    html: page(
      `<div><select style="padding-left:8px"><option>A</option></select><select style="padding-left:12px"><option>B</option></select></div>`,
    ),
    expected: ["idiom:sibling-select-inconsistent"],
  },
  {
    name: "a centred icon button and a segmented control with centred icons",
    html: page(
      `<button aria-label="Add" style="width:32px;padding:0">${svg}</button>
       <div role="group" aria-label="Align"><button aria-label="Left">${svg}</button><button aria-label="Centre">${svg}</button></div>`,
    ),
    expected: [],
  },
  {
    name: "an icon 2px low in an icon button",
    html: page(
      `<button aria-label="Add" style="width:32px;padding:0">${svg.replace("<svg", '<svg style="margin-top:4px"')}</button>`,
    ),
    expected: ["idiom:icon-off-centre"],
  },
  {
    name: "a native select keeps its UA chevron and is skipped",
    html: page(
      `<select style="height:32px"><option>One</option></select>`,
      "select { appearance: auto; }",
    ),
    expected: [],
  },
])("$name", async ({ html, expected }) => {
  expect((await reported(html, {})).map((candidate) => candidate.rule)).toEqual(
    expected,
  );
});

test("capture measures the background chevron and the artifact round-trips", async () => {
  const { tuples } = await reviewStates(browser, [
    { state: "editor", html: await fixture("scale-before.html") },
  ]);
  const observations = tuples[0]?.observations;
  expect(observationArtifactSchema.parse(observations)).toEqual(observations);
  if (observations?.version !== 2) throw new Error("expected v2");
  const signal = (selector: string) =>
    observations.elements.find((element) => element.selector === selector)
      ?.signals?.adornment;
  expect(signal("#zoom-fit")).toEqual({ status: "none" });
  const font = observations.elements.find(
    (element) => element.selector === "#font",
  );
  const adornment = signal("#font");
  if (adornment?.status !== "measured" || font === undefined)
    throw new Error("expected a measured chevron");
  expect(adornment.rect.width).toBe(10);
  expect(adornment.rect.height).toBe(10);
  // right 8px inside a 1px border; top 80% of the 16px free height.
  expect(adornment.rect.x).toBeCloseTo(
    font.rect.x + font.rect.width - 1 - 8 - 10,
    1,
  );
  expect(adornment.rect.y).toBeCloseTo(font.rect.y + 1 + 0.8 * 16, 1);
  expect(signal("#undo")).toBeUndefined();
}, 60_000);

import { readFile } from "node:fs/promises";
import { type Browser, chromium } from "playwright";
import { afterAll, beforeAll, expect, test } from "vitest";
import { probeControls } from "../src/capture/probe.js";
import { adjacentGapCheck } from "../src/checks/adjacent-gap.js";
import { observationArtifactSchema } from "../src/checks/artifact-schema.js";
import { deadControlCheck } from "../src/checks/dead-control.js";
import { detachedFlyoutCheck } from "../src/checks/detached-flyout.js";
import { observePage } from "../src/checks/observe.js";
import { checksConfigFrom } from "../src/checks/registry.js";
import type { CheckTuple, ObservationArtifactV2 } from "../src/checks/types.js";
import { checksConfigSchema } from "../src/schemas/project.js";
import { reviewStates } from "./benchmark-support.js";

let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch();
});
afterAll(async () => {
  await browser.close();
});
const html = (name: string) =>
  readFile(
    new URL(`./fixtures/interaction-geometry/${name}.html`, import.meta.url),
    "utf8",
  );
const review = async (name: string, probe = false) =>
  reviewStates(browser, [{ state: name, html: await html(name) }], { probe });

test("closed and transparent menus are excluded while an open touching menu reports", async () => {
  const { findings } = await review("menus");
  const gaps = findings.filter(
    ({ candidate }) => candidate.category === "adjacent-gap",
  );
  expect(
    gaps.some(({ candidate }) => candidate.explanation.includes("#open-menu")),
  ).toBe(true);
  for (const selector of ["#closed-menu", "#faded-menu", "#offscreen-menu"])
    expect(
      gaps.filter(({ candidate }) => candidate.explanation.includes(selector)),
      selector,
    ).toEqual([]);
});

test("field labels use text fragments rather than tall caption line boxes", async () => {
  const { findings } = await review("labels");
  const fields = findings.filter(
    ({ candidate }) => candidate.category === "field-group",
  );
  for (const selector of ["#external", "#wrapping", "#multiline"])
    expect(
      fields.filter(({ candidate }) =>
        candidate.explanation.includes(selector),
      ),
      selector,
    ).toEqual([]);
  expect(
    fields.some(({ candidate }) => candidate.explanation.includes("#touching")),
  ).toBe(true);
});

test("a delayed six-item disclosure inside a popper has real effects", async () => {
  const { findings, tuples } = await review("flyout", true);
  const observation = tuples[0]?.observations;
  const result =
    observation?.version === 2
      ? observation.probe?.results.find(
          (entry) => entry.selector === "#settings",
        )
      : undefined;
  expect(result?.menu?.items).toHaveLength(6);
  expect(
    result?.effects.some((effect) => effect === "aria" || effect === "dom"),
  ).toBe(true);
  expect(
    findings.filter(
      ({ candidate }) =>
        candidate.category === "dead-control" &&
        candidate.selectorHint === "#settings",
    ),
  ).toEqual([]);
}, 60_000);

test.each([1440, 390])(
  "grid, edge-poking and partial-cover card actions remain reachable at %ipx",
  async (width) => {
    const { findings } = await reviewStates(
      browser,
      [{ state: "cards", html: await html("cards") }],
      { viewport: { width, height: 900 } },
    );
    expect(
      findings.filter(
        ({ candidate }) =>
          candidate.rule === "idiom:elements-overlap" ||
          candidate.rule === "idiom:interactive-overlap",
      ),
    ).toEqual([]);
  },
);

const config = checksConfigFrom(checksConfigSchema.parse({}));
const context = (observations: ObservationArtifactV2) => ({
  tuple: {
    observations,
    state: "rail",
    viewport: "desktop",
    width: 800,
    height: 900,
  } as CheckTuple,
  config,
  narrowViewport: true,
});

test("adjacent eligibility captures ancestry, IDREFs, transforms and preserves partial/below-fold controls", async () => {
  const page = await browser.newPage({ viewport: { width: 800, height: 900 } });
  try {
    await page.setContent(`<!doctype html><style>body{margin:20px}.pair{display:flex;position:relative;margin-bottom:20px;width:max-content}button{width:100px;height:36px;border:1px solid;border-radius:8px;background:white}.pair:has(:focus){gap:2px}button:focus{outline:1px solid blue}</style>
      <button aria-expanded=false aria-controls="one two">Closed</button>
      <div id=one><div class=pair><button id=closed-a>A</button><button id=closed-b>B</button></div></div>
      <div id=two><div class=pair><button id=idref-a>A</button><button id=idref-b>B</button></div></div>
      <div style="opacity:0"><div class=pair><button id=opacity-a>A</button><button id=opacity-b>B</button></div></div>
      <div style="visibility:hidden"><div class=pair><button id=hidden-a>A</button><button id=hidden-b>B</button></div></div>
      <div style="transform:translateX(-2000px)"><div class=pair><button id=transform-a>A</button><button id=transform-b>B</button></div></div>
      <div style="translate:-2000px"><div class=pair><button id=translate-a>A</button><button id=translate-b>B</button></div></div>
      <div style="transform:translateX(-70px)" class=pair><button id=partial-a>A</button><button id=partial-b>B</button></div>
      <div style="margin-top:1500px;transform:translateZ(0)" class=pair><button id=below-a>A</button><button id=below-b>B</button></div>
      <div style="transform:translateX(-2000px)" class=pair><button id=below-transformed-a>A</button><button id=below-transformed-b>B</button></div>`);
    for (const focus of [
      undefined,
      "#closed-a",
      "#opacity-a",
      "#transform-a",
      "#translate-a",
      "#partial-a",
    ]) {
      // Programmatic focus scrolls; reset before observing the viewport guard.
      if (focus) await page.locator(focus).focus();
      await page.evaluate(() => scrollTo(0, 0));
      const captured = await observePage(page, { status: "not-configured" });
      if (captured.version !== 2) throw new Error("expected v2");
      const parsed = observationArtifactSchema.parse(
        captured,
      ) as ObservationArtifactV2;
      for (const selector of [
        "#closed-a",
        "#closed-b",
        "#idref-a",
        "#opacity-a",
        "#hidden-a",
        "#transform-a",
        "#translate-a",
        "#below-transformed-a",
      ]) {
        expect(
          parsed.elements.find((entry) => entry.selector === selector)
            ?.adjacentGapExcluded,
          selector,
        ).toBeDefined();
      }
      for (const selector of ["#partial-a", "#below-a"])
        expect(
          parsed.elements.find((entry) => entry.selector === selector)
            ?.adjacentGapExcluded,
          selector,
        ).toBeUndefined();
      const checked = adjacentGapCheck.run(context(parsed)).candidates;
      for (const prefix of [
        "closed-",
        "idref-",
        "opacity-",
        "hidden-",
        "transform-",
        "translate-",
        "below-transformed-",
      ])
        expect(
          checked.filter((candidate) =>
            candidate.explanation.includes(`#${prefix}`),
          ),
          `${focus} ${prefix}`,
        ).toEqual([]);
      for (const selector of ["#partial-a", "#below-a"])
        expect(
          checked.some((candidate) => candidate.explanation.includes(selector)),
          `${focus ?? "rest"}: ${selector}`,
        ).toBe(true);
    }
    await page
      .locator("[aria-controls]")
      .evaluate((element) => element.setAttribute("aria-expanded", "true"));
    const open = await observePage(page, { status: "not-configured" });
    if (open.version !== 2) throw new Error("expected v2");
    expect(
      open.elements.find((entry) => entry.selector === "#closed-a")
        ?.adjacentGapExcluded,
    ).toBeUndefined();
    expect(
      adjacentGapCheck
        .run(context(open))
        .candidates.some((entry) => entry.explanation.includes("#closed-a")),
    ).toBe(true);
    // Legacy replay uses stored styles/paint reasons when the new capture fact
    // is absent, including causal hiding supported by stored ancestry.
    for (const painted of [true, false]) {
      const legacy = structuredClone(open);
      for (const element of legacy.elements) {
        delete element.adjacentGapExcluded;
        if (!painted) delete element.painted;
      }
      const checked = adjacentGapCheck.run(context(legacy)).candidates;
      expect(
        checked.filter((entry) => entry.explanation.includes("#opacity-a")),
      ).toEqual([]);
    }
  } finally {
    await page.close();
  }
});

test("label text geometry round-trips without changing layout members", async () => {
  const { tuples } = await review("labels");
  const observation = tuples[0]?.observations;
  if (observation?.version !== 2) throw new Error("expected v2");
  const parsed = observationArtifactSchema.parse(
    observation,
  ) as ObservationArtifactV2;
  for (const selector of ["#external", "#wrapping", "#multiline"]) {
    const group = parsed.fieldGroups?.find(
      (entry) => entry.members[0]?.selector === selector,
    );
    const caption = group?.members[0];
    const control = group?.members[1];
    if (!caption?.textRect || !control) throw new Error("missing geometry");
    expect(control.rect.y - caption.rect.y - caption.rect.height).toBe(0);
    expect(control.rect.y - caption.textRect.y - caption.textRect.height).toBe(
      6,
    );
  }
});

test.each([false, true])(
  "delayed disclosure, popper=%s, records paired geometry independently of revealed observation",
  async (popper) => {
    const page = await browser.newPage({
      viewport: { width: 800, height: 900 },
    });
    let markup = await html("flyout");
    if (!popper)
      markup = markup.replace(
        "data-radix-popper-content-wrapper",
        "data-plain-wrapper",
      );
    try {
      await page.setContent(markup);
      const probe = await probeControls({
        page,
        skip: [],
        maxControls: 20,
        waitMs: 500,
        restore: async () => {
          await page.setContent(markup);
        },
      });
      const result = probe.results.find(
        (entry) => entry.selector === "#settings",
      );
      expect(
        result?.effects.some((effect) => effect === "aria" || effect === "dom"),
      ).toBe(true);
      expect(result?.menu?.items).toHaveLength(6);
      expect(result?.revealed).toBeUndefined();
      expect(result?.openedDisclosure).toMatchObject({
        kind: "expanded",
        trigger: { y: 8, height: 40 },
        panel: { y: 208 },
      });
      const captured = await observePage(page, { status: "not-configured" });
      if (captured.version !== 2) throw new Error("expected v2");
      captured.probe = probe;
      const parsed = observationArtifactSchema.parse(
        captured,
      ) as ObservationArtifactV2;
      const detached = detachedFlyoutCheck.run(context(parsed)).candidates;
      expect(detached).toHaveLength(1);
      expect(detached[0]).toMatchObject({
        severity: "minor",
        verification: { params: { distance: 160, maximum: 24 } },
      });
      const dead = deadControlCheck.run(context(parsed)).candidates;
      expect(dead.some((entry) => entry.selectorHint === "#settings")).toBe(
        false,
      );
      expect(dead.some((entry) => entry.selectorHint === "#noop")).toBe(true);
    } finally {
      await page.close();
    }
  },
  60_000,
);

test("nested disclosure geometry survives scrolling and tooltip-only clicks stay dead", async () => {
  const markup = `<!doctype html><style>body{margin:0;height:1800px}#outer{position:absolute;top:1000px;left:20px;background:white}#nested{height:40px}#child{position:absolute;top:64px;left:0;background:white;width:120px;height:80px}</style>
    <button id=parent aria-expanded=false aria-controls=outer>Parent</button><div id=outer hidden data-radix-popper-content-wrapper><button id=nested aria-expanded=false aria-controls=child>Settings</button><div id=child hidden>Preferences</div></div>
    <div data-radix-popper-content-wrapper><button id=status>Show status</button><div role=tooltip hidden>Unrelated tooltip</div></div>
    <button id=pretend aria-expanded=false aria-controls=never>Asserted only</button><div id=never hidden>Still closed</div>
    <button id=tooltip>No effect</button><div data-radix-popper-content-wrapper><div role=tooltip hidden id=tip>Tooltip</div></div>
    <script>statusButton=document.querySelector('#status');statusButton.onclick=()=>{const message=document.createElement('p');message.textContent='Ready';statusButton.parentElement.append(message)};pretend.onclick=()=>pretend.setAttribute('aria-expanded','true');parentButton=document.querySelector('#parent');parentButton.onclick=()=>{parentButton.setAttribute('aria-expanded','true');outer.hidden=false};nested.onclick=()=>setTimeout(()=>{nested.setAttribute('aria-expanded','true');child.hidden=false},150);tooltip.onclick=()=>{tip.hidden=false}</script>`;
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  try {
    await page.setContent(markup);
    const probe = await probeControls({
      page,
      skip: [],
      maxControls: 12,
      waitMs: 500,
      restore: async () => {
        await page.setContent(markup);
      },
    });
    const nested = probe.results.find((entry) => entry.selector === "#nested");
    expect(nested?.name).toBe("Parent › Settings");
    expect(
      probe.results.find((entry) => entry.selector === "#status")?.effects,
    ).toContain("dom");
    expect(
      probe.results.find((entry) => entry.selector === "#pretend")
        ?.openedDisclosure,
    ).toBeUndefined();
    expect(nested?.openedDisclosure).toMatchObject({
      trigger: { y: 1000, height: 40 },
      panel: { y: 1064 },
    });
    const captured = await observePage(page, { status: "not-configured" });
    if (captured.version !== 2) throw new Error("expected v2");
    captured.probe = probe;
    const detached = detachedFlyoutCheck.run(context(captured)).candidates;
    expect(
      detached.filter((entry) => entry.selectorHint === "#nested"),
    ).toEqual([]);
    expect(
      detached.filter((entry) => entry.selectorHint === "#parent"),
    ).toHaveLength(1);
    expect(
      deadControlCheck
        .run(context(captured))
        .candidates.some((entry) => entry.selectorHint === "#tooltip"),
    ).toBe(true);
    expect(
      deadControlCheck
        .run(context(captured))
        .candidates.some((entry) => entry.selectorHint === "#nested"),
    ).toBe(false);
  } finally {
    await page.close();
  }
}, 60_000);

test.each([1440, 390])(
  "ambiguous repeated cards report once as info at %ipx",
  async (width) => {
    const markup = await html("ambiguous-cards");
    const { findings, tuples } = await reviewStates(
      browser,
      [{ state: "cards", html: markup }],
      { viewport: { width, height: 900 } },
    );
    const overlaps = findings.filter(({ candidate }) =>
      ["idiom:elements-overlap", "idiom:interactive-overlap"].includes(
        candidate.rule,
      ),
    );
    expect(overlaps).toHaveLength(1);
    expect(overlaps[0]?.candidate).toMatchObject({
      severity: "info",
      verification: { params: { affectedCards: 3 } },
    });
    const observation = tuples[0]?.observations;
    expect(observationArtifactSchema.parse(observation)).toEqual(observation);
  },
);

test("below-fold card evidence preserves proven absolute actions, buried controls and uncertainty", async () => {
  const { findings } = await reviewStates(browser, [
    {
      state: "below-fold",
      html: `<!doctype html><style>body{font:16px Arial}.cards{margin-top:2000px;display:flex;gap:30px}article{position:relative;width:200px;height:160px}a{display:block;width:200px;height:160px;background:#eee}button{position:absolute;right:0;top:0;width:40px;height:40px}#buried{z-index:-1}#grid{display:grid}#grid>*{grid-area:1/1}#grid button{position:static;justify-self:end}</style><div class=cards><article><a href=/old>Old card</a><button id=old>⋯</button></article><article><a href=/buried>Buried card</a><button id=buried>⋯</button></article><article id=grid><a href=/grid>Grid card</a><button id=uncertain>⋯</button></article></div>`,
    },
  ]);
  const overlaps = findings
    .map(({ candidate }) => candidate)
    .filter((candidate) =>
      ["idiom:elements-overlap", "idiom:interactive-overlap"].includes(
        candidate.rule,
      ),
    );
  expect(overlaps).toHaveLength(2);
  expect(
    overlaps.find((candidate) => candidate.selectorHint.includes("#buried"))
      ?.severity,
  ).toBe("minor");
  expect(
    overlaps.find((candidate) => candidate.severity === "info")?.verification
      .params,
  ).toMatchObject({ affectedCards: 1 });
  expect(
    overlaps.filter((candidate) => candidate.selectorHint.includes("#old")),
  ).toEqual([]);
});

test.each([1440, 390])(
  "corner-action cards with multiple actions, internal lists, action bars or link actions stay intentional at %ipx",
  async (width) => {
    for (const name of [
      "card-multiple-actions",
      "card-tag-list",
      "card-nested-list-action",
      "card-linked-tag-list",
      "card-action-bar-repeated",
      "card-link-action",
    ]) {
      const { findings, tuples } = await reviewStates(
        browser,
        [{ state: name, html: await html(name) }],
        { viewport: { width, height: 900 } },
      );
      const overlaps = findings.filter(({ candidate }) =>
        ["idiom:elements-overlap", "idiom:interactive-overlap"].includes(
          candidate.rule,
        ),
      );
      expect(overlaps, name).toEqual([]);
      const observation = tuples[0]?.observations;
      if (observation?.version !== 2) throw new Error("expected v2");
      const pairs = observation.overlaps?.filter(
        (pair) => pair.a === "#feature" || pair.b === "#feature",
      );
      const actions = pairs?.filter((pair) =>
        [pair.a, pair.b].some((selector) =>
          ["#like", "#more"].includes(selector),
        ),
      );
      expect(actions, name).toHaveLength(
        ["card-multiple-actions", "card-action-bar-repeated"].includes(name)
          ? 2
          : 1,
      );
      expect(
        actions?.every((pair) => pair.cardAction?.status === "intentional"),
        name,
      ).toBe(true);
    }
  },
);

test.each([1440, 390])(
  "buttons colliding with a small title link in the same card still report major at %ipx",
  async (width) => {
    for (const [name, count] of [
      ["card-title-link-collision", 3],
      ["wrapper-link-collision", 1],
    ] as const) {
      const { findings, tuples } = await reviewStates(
        browser,
        [{ state: name, html: await html(name) }],
        { viewport: { width, height: 900 } },
      );
      // Wrapped narrow titles report through elements-overlap instead.
      const overlaps = findings.filter(({ candidate }) =>
        ["idiom:elements-overlap", "idiom:interactive-overlap"].includes(
          candidate.rule,
        ),
      );
      expect(overlaps, name).toHaveLength(count);
      expect(
        overlaps.every(({ candidate }) => candidate.severity === "major"),
        name,
      ).toBe(true);
      const observation = tuples[0]?.observations;
      if (observation?.version !== 2) throw new Error("expected v2");
      expect(
        observation.overlaps?.filter((pair) => pair.cardAction !== undefined),
        name,
      ).toEqual([]);
    }
  },
);

test.each([false, true])(
  "Radix tooltip removal preserves a real click effect only when present: %s",
  async (changesStatus) => {
    const page = await browser.newPage();
    const markup = await html("radix-tooltip");
    try {
      const render = async () => {
        await page.setContent(markup);
        if (changesStatus)
          await page.evaluate(() => {
            document.querySelector("#icon")?.addEventListener("click", () => {
              const status = document.createElement("p");
              status.textContent = "Ready";
              document.body.append(status);
            });
          });
      };
      await render();
      const probe = await probeControls({
        page,
        skip: [],
        maxControls: 1,
        waitMs: 100,
        restore: render,
      });
      const result = probe.results.find((entry) => entry.selector === "#icon");
      expect(result?.status).toBe("completed");
      if (changesStatus) expect(result?.effects).toContain("dom");
      else expect(result?.effects).toEqual([]);
      const captured = await observePage(page, { status: "not-configured" });
      if (captured.version !== 2) throw new Error("expected v2");
      captured.probe = probe;
      expect(
        deadControlCheck
          .run(context(captured))
          .candidates.some((candidate) => candidate.selectorHint === "#icon"),
      ).toBe(!changesStatus);
    } finally {
      await page.close();
    }
  },
);

test.each([false, true])(
  "legacy corner proof retains below-fold cards and buried actions: buried=%s",
  async (buried) => {
    const markup = `${await html("card-linked-tag-list")}<style>body{margin-top:2024px}${buried ? "#more{z-index:-1}" : ""}</style>`;
    const { findings } = await reviewStates(browser, [
      { state: "legacy-card", html: markup },
    ]);
    const overlaps = findings
      .map(({ candidate }) => candidate)
      .filter((candidate) =>
        ["idiom:elements-overlap", "idiom:interactive-overlap"].includes(
          candidate.rule,
        ),
      );
    expect(overlaps).toHaveLength(buried ? 1 : 0);
    if (buried)
      expect(overlaps[0]).toMatchObject({
        severity: "minor",
        rule: "idiom:elements-overlap",
      });
  },
);

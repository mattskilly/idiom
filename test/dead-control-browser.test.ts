import type { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { type Browser, chromium, type Page } from "playwright";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { probeControls } from "../src/capture/probe.js";
import { observationArtifactSchema } from "../src/checks/artifact-schema.js";
import { deadControlCheck } from "../src/checks/dead-control.js";
import { observePage } from "../src/checks/observe.js";
import type { ObservationArtifact, ProbeResult } from "../src/checks/types.js";
import { type ReviewedFixture, reviewFixture } from "./benchmark-support.js";

let browser: Browser;
let results: ProbeResult[] = [];
let observations: ObservationArtifact;
let findings: ReviewedFixture;
const html = await readFile(
  join(import.meta.dirname, "fixtures/dead-control/intent.html"),
  "utf8",
);
const selected = [
  "desktop",
  "light",
  "default",
  "colors",
  "home",
  "radio",
  "live-radio",
  "role-tab",
  "role-radio",
];
const handles = [
  "draggable",
  "description",
  "move",
  "drag",
  "reorder",
  "menu-move",
];
const dead = [
  "color-cancel",
  "color-ancestor",
  "color-disabled",
  "color-fieldset",
  "color-inert",
  "date-disabled",
  "text-picker",
  "dead",
  "false-current",
  "empty-current",
  "false-drag",
  "whole-word",
];
const listenerCount = (page: Page, event: string) =>
  (page as unknown as EventEmitter).listenerCount(event);
const result = (id: string) =>
  results.find((entry) => entry.selector === `#${id}`);
const deadFindings = () =>
  findings
    .map(({ candidate }) => candidate)
    .filter((candidate) => candidate.category === "dead-control");

beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
  findings = await reviewFixture(browser, html, {
    probe: true,
    checks: { probe: { respectControlIntent: true } },
    onObservations: (captured) => {
      observations = captured;
      if (captured.version === 2) results = captured.probe?.results ?? [];
    },
  });
}, 60_000);
afterAll(async () => {
  await browser.close();
});

test("records selected controls and drag handles as explicit skips (#54)", () => {
  for (const id of selected) {
    expect(result(id)?.skipped, id).toMatch(/already selected/);
    expect(result(id)).toMatchObject({
      effects: [],
      persistent: true,
      region: 'main "Editor"',
    });
  }
  for (const id of handles) {
    expect(result(id)?.skipped, id).toMatch(/drag handle/);
    expect(result(id)?.effects).toEqual([]);
  }
  expect(result("menu-light")).toMatchObject({
    name: "Account › Light",
    persistent: false,
    region: 'menu "Account"',
    skipped: "already selected: aria-checked",
    effects: [],
  });
  expect(result("menu-move")).toMatchObject({
    name: "Account › Move item",
    persistent: false,
    region: 'menu "Account"',
  });
  expect(result("desktop")?.repeated).toBe(true);
  for (const id of [...selected, ...handles, "menu-light"])
    expect(
      deadFindings().some((candidate) => candidate.selectorHint === `#${id}`),
      id,
    ).toBe(false);
  for (const id of ["unselected-radio", "unselected-tab", "current-link"])
    expect(result(id), id).toBeUndefined();
  expect(new Set(results.map((entry) => entry.selector)).size).toBe(
    results.length,
  );
});

test("records real file choosers and native pickers while inert openers remain dead (#54)", () => {
  expect(result("upload")).toMatchObject({
    effects: expect.arrayContaining(["filechooser"]),
    primary: true,
  });
  for (const id of ["date-open", "select-open", "color-open", "color-second"])
    expect(result(id), id).toMatchObject({
      effects: expect.arrayContaining(["picker"]),
      primary: true,
    });
  for (const id of [
    "upload",
    "date-open",
    "select-open",
    "color-open",
    "color-second",
  ]) {
    expect(result(id)?.skipped, id).toBeUndefined();
    expect(result(id)?.signature, id).toBeUndefined();
    expect(
      deadFindings().some((candidate) => candidate.selectorHint === `#${id}`),
      id,
    ).toBe(false);
  }
  for (const id of dead) {
    expect(result(id), id).toMatchObject({ effects: [], primary: false });
    expect(result(id)?.skipped, id).toBeUndefined();
    expect(
      deadFindings().some((candidate) => candidate.selectorHint === `#${id}`),
      id,
    ).toBe(true);
  }
  expect(
    deadFindings().find(
      (candidate) => candidate.selectorHint === "#false-toggle",
    )?.rule,
  ).toBe("idiom:toggle-without-state");
});

test("stored skip and picker evidence round-trips and suppresses findings without capture settings", () => {
  const stored = observationArtifactSchema.parse(
    JSON.parse(JSON.stringify(observations)),
  );
  const replay = deadControlCheck.run({
    tuple: { observations: stored },
  } as Parameters<typeof deadControlCheck.run>[0]);
  expect(
    replay.candidates.map((candidate) => [
      candidate.selectorHint,
      candidate.rule,
    ]),
  ).toEqual(
    deadFindings().map((candidate) => [candidate.selectorHint, candidate.rule]),
  );
  expect(
    replay.candidates.find((candidate) => candidate.selectorHint === "#dead")
      ?.rule,
  ).toBe("idiom:control-does-nothing");
});

test("skips never hover or click, including live radio state and reopened menu items", async () => {
  const page = await browser.newPage();
  const actions: Array<{ kind: string; id: string }> = [];
  await page.exposeFunction("recordIntent", (kind: string, id: string) =>
    actions.push({ kind, id }),
  );
  const tracked = html
    .replace(
      "window.intentActions.push(event.target.id)",
      "window.recordIntent('click', event.target.id)",
    )
    .replace(
      "(window.intentHovers ??= []).push(event.target.id)",
      "window.recordIntent('hover', event.target.id)",
    );
  await page.setContent(tracked);
  try {
    const artifact = await probeControls({
      page,
      skip: [],
      maxControls: 80,
      waitMs: 20,
      respectControlIntent: true,
      restore: async () => {
        await page.setContent(tracked);
      },
    });
    expect(artifact.status).toBe("ran");
    for (const id of [...selected, ...handles, "menu-light"])
      expect(
        actions.filter((action) => action.id === id),
        id,
      ).toEqual([]);
    expect(actions).toContainEqual({ kind: "click", id: "dead" });
  } finally {
    await page.close();
  }
}, 60_000);

test.each([undefined, false])(
  "omitted/false intent retains classification with unconditional chooser protection (%s)",
  async (respectControlIntent) => {
    const page = await browser.newPage();
    await page.setContent(html);
    try {
      const artifact = await probeControls({
        page,
        skip: [],
        maxControls: 80,
        waitMs: 20,
        ...(respectControlIntent === undefined ? {} : { respectControlIntent }),
        restore: async () => {
          await page.setContent(html);
        },
      });
      expect(artifact.status).toBe("ran");
      for (const id of [
        "desktop",
        "light",
        "default",
        "colors",
        "home",
        "move",
        "menu-light",
        "date-open",
        "color-open",
      ])
        expect(
          artifact.results.find((entry) => entry.selector === `#${id}`),
          id,
        ).toMatchObject({ effects: [] });
      expect(
        artifact.results.find((entry) => entry.selector === "#upload")?.effects,
      ).toContain("filechooser");
      expect(
        artifact.results.every((entry) => entry.skipped === undefined),
      ).toBe(true);
      for (const id of ["radio", "live-radio", "role-tab", "role-radio"])
        expect(
          artifact.results.find((entry) => entry.selector === `#${id}`),
          id,
        ).toBeUndefined();
    } finally {
      await page.close();
    }
  },
  60_000,
);

test("native color activation bypasses showPicker and repeated probes restore wrappers and listeners", async () => {
  const page = await browser.newPage();
  await page.setContent(html);
  await page.evaluate(() => {
    const originalInput = HTMLInputElement.prototype.showPicker;
    const originalSelect = HTMLSelectElement.prototype.showPicker;
    let calls = 0;
    const forwarding = function (this: HTMLInputElement) {
      calls += 1;
      return originalInput.call(this);
    };
    HTMLInputElement.prototype.showPicker = forwarding;
    const active = new Set<EventListenerOrEventListenerObject>();
    const add = document.addEventListener;
    const remove = document.removeEventListener;
    document.addEventListener = function (
      type: string,
      listener: EventListenerOrEventListenerObject,
      options?: boolean | AddEventListenerOptions,
    ) {
      if (type === "click" && options === true && listener)
        active.add(listener);
      return add.call(this, type, listener, options);
    };
    document.removeEventListener = function (
      type: string,
      listener: EventListenerOrEventListenerObject,
      options?: boolean | AddEventListenerOptions,
    ) {
      if (type === "click" && options === true && listener)
        active.delete(listener);
      return remove.call(this, type, listener, options);
    };
    Object.assign(window, {
      intentCleanup: () => ({
        calls,
        active: active.size,
        inputRestored: HTMLInputElement.prototype.showPicker === forwarding,
        selectRestored:
          HTMLSelectElement.prototype.showPicker === originalSelect,
        value: (document.getElementById("color") as HTMLInputElement).value,
      }),
    });
  });
  const baseline = ["request", "dialog", "popup", "filechooser"].map((event) =>
    listenerCount(page, event),
  );
  const skip = [
    "button:not(#color-open):not(#color-second):not(#dead)",
    "[role=tab]",
    "[role=radio]",
    "input[type=radio]",
  ];
  const before = await page.content();
  try {
    for (let run = 0; run < 2; run++) {
      const artifact = await probeControls({
        page,
        skip,
        maxControls: 80,
        waitMs: 20,
        respectControlIntent: true,
        restore: async () => {},
      });
      expect(artifact.status).toBe("ran");
      expect(artifact.results.map((entry) => entry.selector)).toEqual([
        "#color-open",
        "#color-second",
        "#dead",
      ]);
      expect(
        artifact.results
          .slice(0, 2)
          .every((entry) => entry.effects.includes("picker") && entry.primary),
      ).toBe(true);
      expect(artifact.results[2]).toMatchObject({
        effects: [],
        primary: false,
      });
      expect(
        await page.evaluate(() =>
          (window as unknown as { intentCleanup(): unknown }).intentCleanup(),
        ),
      ).toEqual({
        calls: 0,
        active: 0,
        inputRestored: true,
        selectRestored: true,
        value: "#123456",
      });
      expect(await page.content()).toBe(before);
      expect(
        ["request", "dialog", "popup", "filechooser"].map((event) =>
          listenerCount(page, event),
        ),
      ).toEqual(baseline);
    }
  } finally {
    await page.close();
  }
}, 30_000);

test("failed clicks remove the chooser listener and picker wrappers", async () => {
  const page = await browser.newPage();
  await page.setContent(
    '<button id="failed" style="pointer-events:none">Unavailable</button><button id="dead">Inert</button>',
  );
  const before = await page.evaluate(() => {
    Object.assign(window, {
      originalPicker: HTMLInputElement.prototype.showPicker,
    });
    return Object.keys(window).filter((key) => key.startsWith("__idiom"));
  });
  const baseline = listenerCount(page, "filechooser");
  try {
    const artifact = await probeControls({
      page,
      skip: [],
      maxControls: 80,
      waitMs: 20,
      respectControlIntent: true,
      restore: async () => {},
    });
    expect(artifact.results[0]?.skipped).toMatch(/not clickable/);
    expect(artifact.results[1]).toMatchObject({ effects: [] });
    expect(listenerCount(page, "filechooser")).toBe(baseline);
    expect(
      await page.evaluate(
        () =>
          HTMLInputElement.prototype.showPicker ===
          (window as unknown as { originalPicker: unknown }).originalPicker,
      ),
    ).toBe(true);
    expect(
      await page.evaluate(() =>
        Object.keys(window).filter((key) =>
          /__idiom(?:Cleanup|PickerCount|Motion)$/.test(key),
        ),
      ),
    ).toEqual(before);
  } finally {
    await page.close();
  }
}, 30_000);

test("observation exceptions still dismiss native pickers and clean up instrumentation", async () => {
  const page = await browser.newPage();
  await page.setContent(
    '<input id="color" type="color" hidden><button onclick="document.getElementById(\'color\').click()">Choose color</button>',
  );
  await page.evaluate(() => {
    Object.assign(window, {
      originalPicker: HTMLInputElement.prototype.showPicker,
    });
  });
  const baseline = listenerCount(page, "filechooser");
  const wait = page.waitForTimeout.bind(page);
  const spy = vi
    .spyOn(page, "waitForTimeout")
    .mockImplementation(async (ms) => {
      if (ms === 37) throw new Error("observation interrupted");
      await wait(ms);
    });
  const press = vi.spyOn(page.keyboard, "press");
  try {
    const artifact = await probeControls({
      page,
      skip: [],
      maxControls: 80,
      waitMs: 37,
      respectControlIntent: true,
      restore: async () => {},
    });
    expect(artifact).toMatchObject({
      status: "partial",
      reason: "probe stopped early: observation interrupted",
    });
    expect(listenerCount(page, "filechooser")).toBe(baseline);
    expect(
      await page.evaluate(
        () =>
          HTMLInputElement.prototype.showPicker ===
          (window as unknown as { originalPicker: unknown }).originalPicker,
      ),
    ).toBe(true);
    expect(press).toHaveBeenCalledWith("Escape");
  } finally {
    spy.mockRestore();
    press.mockRestore();
    await page.close();
  }
}, 30_000);

test("classification reads restored state and skipped candidates retain coverage limits", async () => {
  const page = await browser.newPage();
  const content =
    '<button id="first" onclick="document.body.dataset.changed=\'yes\'">First action</button><button id="choice" aria-pressed="false">Current choice</button><button id="last">Last</button>';
  await page.setContent(content);
  try {
    const artifact = await probeControls({
      page,
      skip: [],
      maxControls: 2,
      waitMs: 20,
      respectControlIntent: true,
      restore: async () => {
        await page.setContent(
          content.replace('aria-pressed="false"', 'aria-pressed="true"'),
        );
      },
    });
    expect(artifact).toMatchObject({
      status: "partial",
      reason: "probed 2 of 3 controls (checks.probe.maxControls)",
    });
    expect(artifact.results).toHaveLength(2);
    expect(artifact.results[1]).toMatchObject({
      selector: "#choice",
      effects: [],
      skipped: "already selected: aria-pressed",
    });
  } finally {
    await page.close();
  }
});

test("picker methods are feature-detected and supported datalist calls use the native API", async () => {
  const page = await browser.newPage();
  await page.setContent(`<input id="suggestions" list="choices" aria-label="Suggestion"><datalist id="choices"><option value="Example"></datalist>
    <button id="datalist-open" onclick="document.getElementById('suggestions').showPicker()">Choose suggestion</button>
    <button id="dead">Inert</button>`);
  try {
    const artifact = await probeControls({
      page,
      skip: [],
      maxControls: 80,
      waitMs: 20,
      respectControlIntent: true,
      restore: async () => {},
    });
    expect(artifact.results[0]).toMatchObject({
      selector: "#datalist-open",
      effects: expect.arrayContaining(["picker"]),
      primary: true,
    });
    expect(artifact.results[1]).toMatchObject({
      selector: "#dead",
      effects: [],
    });
    await page.evaluate(() => {
      Reflect.deleteProperty(HTMLInputElement.prototype, "showPicker");
      Reflect.deleteProperty(HTMLSelectElement.prototype, "showPicker");
    });
    await page.setContent(`<input id="date" type="date" hidden>
      <button id="missing" onclick="try { document.getElementById('date').showPicker() } catch {}">Unavailable picker</button>`);
    const unavailable = await probeControls({
      page,
      skip: [],
      maxControls: 80,
      waitMs: 20,
      respectControlIntent: true,
      restore: async () => {},
    });
    expect(unavailable.results[0]).toMatchObject({
      selector: "#missing",
      effects: [],
      primary: false,
    });
    expect(
      await page.evaluate(() => [
        typeof HTMLInputElement.prototype.showPicker,
        typeof HTMLSelectElement.prototype.showPicker,
      ]),
    ).toEqual(["undefined", "undefined"]);
  } finally {
    await page.close();
  }
}, 30_000);

test("non-opening range and listbox showPicker calls remain dead controls", async () => {
  const content = await readFile(
    join(import.meta.dirname, "fixtures/dead-control/non-opening-pickers.html"),
    "utf8",
  );
  const page = await browser.newPage();
  const attempts: Array<{ id: string; open: boolean; focusOnOpener: boolean }> =
    [];
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.exposeFunction(
    "recordPickerAttempt",
    (attempt: (typeof attempts)[number]) => attempts.push(attempt),
  );
  await page.setContent(content);
  try {
    const captured = await observePage(page, { status: "not-configured" });
    const probe = await probeControls({
      page,
      skip: [],
      maxControls: 80,
      waitMs: 20,
      respectControlIntent: true,
      restore: async () => {
        await page.setContent(content);
      },
    });
    expect(probe.status).toBe("ran");
    expect(errors).toEqual([]);
    expect(attempts).toEqual(
      ["range", "multiple", "listbox", "dropdown"].map((id) => ({
        id,
        open: id === "dropdown",
        focusOnOpener: true,
      })),
    );
    const stored = observationArtifactSchema.parse(
      JSON.parse(JSON.stringify({ ...captured, probe })),
    );
    const replay = deadControlCheck.run({
      tuple: { observations: stored },
    } as Parameters<typeof deadControlCheck.run>[0]);
    expect(
      probe.results.find((entry) => entry.selector === "#dropdown-open"),
    ).toMatchObject({ effects: ["picker"], primary: true });
    expect(
      replay.candidates.some(
        (candidate) => candidate.selectorHint === "#dropdown-open",
      ),
    ).toBe(false);
    for (const id of ["range", "multiple", "listbox"]) {
      const selector = `#${id}-open`;
      const result = probe.results.find((entry) => entry.selector === selector);
      expect.soft(result, id).toMatchObject({ effects: [], primary: false });
      expect.soft(result?.skipped, id).toBeUndefined();
      expect
        .soft(
          replay.candidates.find(
            (candidate) => candidate.selectorHint === selector,
          )?.rule,
          id,
        )
        .toBe("idiom:control-does-nothing");
    }
  } finally {
    await page.close();
  }
}, 30_000);

test("intent lookup on a control missing after restore does not stop the probe", async () => {
  const page = await browser.newPage();
  await page.setContent(`<main>
    <button id="hide" onclick="document.getElementById('gone').remove()">Hide B</button>
    <button id="gone">Bravo</button>
    <button id="after">Charlie</button>
  </main>`);
  try {
    const started = Date.now();
    const probe = await probeControls({
      page,
      skip: [],
      maxControls: 80,
      waitMs: 20,
      respectControlIntent: true,
      restore: async () => {},
    });
    expect(probe.status).toBe("ran");
    expect(Date.now() - started).toBeLessThan(15_000);
    // Positional paths shift once B is removed, so the last path is missing.
    expect(probe.results.map((entry) => entry.selector)).toEqual([
      "#hide",
      "#gone",
      "#after",
    ]);
    expect(probe.results[2]?.skipped).toMatch(/^not clickable/);
  } finally {
    await page.close();
  }
}, 30_000);

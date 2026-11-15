import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { type Browser, chromium } from "playwright";
import { afterAll, beforeAll, expect, test } from "vitest";
import { scrollbarLaunchOptions } from "../src/capture/scrollbars.js";
import {
  loadTokenDeclarations,
  type TokenDeclarations,
} from "../src/checks/observe.js";
import type { ObservationArtifact } from "../src/checks/types.js";
import {
  type ReviewOptions,
  reviewFixture,
  reviewStates,
} from "./benchmark-support.js";

let browser: Browser;
beforeAll(async () => {
  // Classic scrollbars must be able to show for the gutter measurement.
  browser = await chromium.launch(scrollbarLaunchOptions);
});
afterAll(async () => {
  await browser?.close();
});

const fixtureDir = fileURLToPath(
  new URL("./fixtures/chrome-defaults/", import.meta.url),
);
const desktop = { width: 1280, height: 800 };
const rules = new Set([
  "idiom:native-scrollbar",
  "idiom:browser-default-style",
  "idiom:unused-token",
]);
const html = (name: string) =>
  readFile(
    new URL(`./fixtures/chrome-defaults/${name}.html`, import.meta.url),
    "utf8",
  );
const tokens = (file: string): Promise<TokenDeclarations> =>
  loadTokenDeclarations(fixtureDir, file);

async function review(
  name: string,
  options: ReviewOptions = {},
  target: Browser = browser,
) {
  const found = await reviewFixture(target, await html(name), {
    viewport: desktop,
    scrollbars: true,
    ...options,
  });
  return found
    .map((f) => f.candidate)
    .filter((candidate) => rules.has(candidate.rule));
}
const summary = (found: Awaited<ReturnType<typeof review>>) =>
  found.map((c) => [c.rule, c.severity, c.selectorHint]).sort();

test("an unstyled scroller in a rounded panel shows the browser's own track", async () => {
  let observations: ObservationArtifact | undefined;
  const found = await review("unstyled-rounded", {
    onObservations: (value) => {
      observations = value;
    },
  });
  expect(summary(found)).toEqual([
    ["idiom:native-scrollbar", "minor", "div.panel-body"],
  ]);
  expect(found[0]?.explanation).toBe(
    "div.panel-body shows the browser's own 15px scrollbar track inside a rounded box (section.panel, 12px radius); no scrollbar-color, scrollbar-width or ::-webkit-scrollbar styling applies to it.",
  );
  expect(found[0]?.acceptance).toEqual([
    "div.panel-body styles its scrollbar (scrollbar-color, scrollbar-width or ::-webkit-scrollbar) to match section.panel, or shows no space-taking scrollbar track.",
  ]);
  expect(found[0]?.fingerprintHint).toBe("native-scrollbar:div.panel-body");
  expect(found[0]?.verification.params).toEqual({
    selector: "div.panel-body",
    kind: "scroller",
    axes: ["vertical"],
    gutter: 15,
    box: "section.panel",
    boxReason: "radius",
    radius: 12,
    viewportWidth: 1280,
  });
  expect(
    observations?.version === 2 ? observations.nativeScrollbars?.status : "",
  ).toBe("ran");
});

test("scrollers styled with scrollbar-color or ::-webkit-scrollbar pass", async () => {
  expect(await review("styled-scroller")).toEqual([]);
  expect(await review("webkit-styled-scroller")).toEqual([]);
  expect(await review("descendant-webkit-scroller")).toEqual([]);
});

test("plain, non-overflowing, hidden-bar and document scrollers do not fire", async () => {
  let observations: ObservationArtifact | undefined;
  expect(
    await review("plain-scroller", {
      onObservations: (value) => {
        observations = value;
      },
    }),
  ).toEqual([]);
  expect(
    observations?.version === 2 ? observations.nativeScrollbars : undefined,
  ).toEqual({ status: "ran", records: [] });
});

test("a rounded textarea is filled to overflow, measured, and put back as it was", async () => {
  const page = await browser.newPage({ viewport: desktop });
  try {
    const found = await review("textarea");
    expect(summary(found)).toEqual([
      ["idiom:native-scrollbar", "minor", "#comment"],
    ]);
    expect(found[0]?.explanation).toBe(
      "#comment shows the browser's own 15px scrollbar track once its text overflows inside a rounded box (10px radius); no scrollbar-color, scrollbar-width or ::-webkit-scrollbar styling applies to it.",
    );
    expect(found[0]?.verification.params).toMatchObject({
      kind: "textarea",
      box: "#comment",
    });

    // The same measurement on a page we keep, to read the restored state.
    const { ScrollbarController } = await import(
      "../src/capture/scrollbars.js"
    );
    const { measureNativeScrollbars } = await import(
      "../src/capture/native-scrollbars.js"
    );
    const { observePage } = await import("../src/checks/observe.js");
    await page.setContent(await html("textarea"));
    await page.evaluate(() => {
      const area = document.querySelector("textarea") as HTMLTextAreaElement;
      area.value = `${area.value}\nSecond line`;
      area.setSelectionRange(3, 9, "backward");
    });
    const read = () =>
      page.evaluate(() => {
        const area = document.querySelector("textarea") as HTMLTextAreaElement;
        return {
          value: area.value,
          start: area.selectionStart,
          end: area.selectionEnd,
          direction: area.selectionDirection,
          top: area.scrollTop,
        };
      });
    const before = await read();
    const controller = await ScrollbarController.create(page);
    await observePage(page, { status: "not-configured" }, undefined, [], {
      chromeDefaults: {
        nativeScrollbar: true,
        browserDefaultStyle: false,
        unusedToken: false,
      },
    });
    const measured = await measureNativeScrollbars(page, controller);
    expect(measured.restored).toBe(true);
    expect(measured.scan.records.map((r) => [r.selector, r.filled])).toEqual([
      ["#comment", true],
    ]);
    expect(await read()).toEqual(before);
  } finally {
    await page.close();
  }
});

test("a browser that cannot show classic scrollbars reports a partial scan, not a pass", async () => {
  const hidden = await chromium.launch({ headless: true });
  try {
    let observations: ObservationArtifact | undefined;
    expect(
      await review(
        "unstyled-rounded",
        {
          onObservations: (value) => {
            observations = value;
          },
        },
        hidden,
      ),
    ).toEqual([]);
    expect(
      observations?.version === 2 ? observations.nativeScrollbars : undefined,
    ).toEqual({
      status: "partial",
      reason: "the browser did not show classic scrollbars",
      records: [],
    });
  } finally {
    await hidden.close();
  }
});

test("default-blue links fail when the tokens define an accent colour", async () => {
  const found = await review("default-link", {
    tokens: await tokens("tokens.css"),
  });
  expect(summary(found)).toEqual([
    [
      "idiom:browser-default-style",
      "minor",
      "body > main > p > a:nth-of-type(1)",
    ],
  ]);
  expect(found[0]?.explanation).toBe(
    "2 links use the browser's default link colour (body > main > p > a:nth-of-type(1), body > main > p > a:nth-of-type(2)), though the design tokens define `--accent`.",
  );
  expect(found[0]?.acceptance).toEqual([
    "Links in this state use the project's link or accent colour (`--accent`), not the browser default.",
  ]);
  expect(found[0]?.fingerprintHint).toBe("browser-default-style:link");
  expect(found[0]?.verification.params).toMatchObject({
    count: 2,
    colors: ["rgb(0, 0, 238)"],
    tokens: ["--accent"],
  });
});

test("accent-coloured and deliberately blue links pass; no tokens means no judgement", async () => {
  expect(
    await review("accent-link", { tokens: await tokens("tokens.css") }),
  ).toEqual([]);
  expect(await review("default-link")).toEqual([]);
});

test("a borderless fieldset and a floated legend are styled headings, not notched defaults", async () => {
  let observations: ObservationArtifact | undefined;
  expect(
    await review("styled-fieldset", {
      onObservations: (value) => {
        observations = value;
      },
    }),
  ).toEqual([]);
  expect(
    observations?.version === 2
      ? observations.browserDefaultLegends
      : undefined,
  ).toEqual({ count: 0, records: [] });
});

test("chrome tokens no applied rule uses are listed once", async () => {
  const found = await review("tokens-unused", {
    tokens: await tokens("tokens-chrome.css"),
  });
  expect(summary(found)).toEqual([
    ["idiom:unused-token", "info", ":root"],
    ["idiom:unused-token", "info", ":root"],
    ["idiom:unused-token", "info", ":root"],
  ]);
  expect(found.map((c) => c.fingerprintHint).sort()).toEqual([
    "unused-token:--focus-ring",
    "unused-token:--scrollbar-thumb",
    "unused-token:--selection-bg",
  ]);
  expect(
    found.find((c) => c.fingerprintHint === "unused-token:--scrollbar-thumb")
      ?.explanation,
  ).toBe(
    "`--scrollbar-thumb` is defined in tokens-chrome.css but no rule that applies to any captured element uses it, so whatever it styles (scrollbars) still shows the browser default.",
  );
  expect(
    await review("tokens-used", { tokens: await tokens("tokens-chrome.css") }),
  ).toEqual([]);
});

test("across states unused-token reports once, and a token used only in a later state is used", async () => {
  const { findings } = await reviewStates(
    browser,
    [
      { state: "inbox", html: await html("tokens-unused") },
      { state: "settings", html: await html("tokens-focus-only") },
    ],
    {
      viewport: desktop,
      tokens: await tokens("tokens-chrome.css"),
    },
  );
  const unused = findings.filter(
    ({ candidate }) => candidate.rule === "idiom:unused-token",
  );
  expect(
    unused.map(({ state, candidate }) => [state, candidate.fingerprintHint]),
  ).toEqual([
    ["inbox", "unused-token:--scrollbar-thumb"],
    ["inbox", "unused-token:--selection-bg"],
  ]);
});

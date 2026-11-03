import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { type Browser, chromium, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { probeControls } from "../src/capture/probe.js";
import { revealedObserver } from "../src/capture/revealed.js";
import { observePage } from "../src/checks/observe.js";
import type { ObservationArtifactV2 } from "../src/checks/types.js";
import { reviewStates } from "./benchmark-support.js";

let browser: Browser;
let attachHtml: string;
let goodHtml: string;
beforeAll(async () => {
  browser = await chromium.launch();
  const fixture = (name: string) =>
    readFile(
      join(import.meta.dirname, `fixtures/disclosures/${name}.html`),
      "utf8",
    );
  attachHtml = await fixture("attach-menu");
  goodHtml = await fixture("menu-good");
});
afterAll(async () => {
  await browser.close();
});

const newRules = [
  "idiom:native-control-unstyled",
  "idiom:adjacent-elements-touch",
  "idiom:popover-covers-control",
];

describe("revealed disclosures through a review", () => {
  test("the Attach menu reports its file input, its touching options and the field it covers", async () => {
    const { findings } = await reviewStates(
      browser,
      [{ state: "panel", html: attachHtml }],
      { probe: true },
    );
    const revealed = findings
      .map(({ candidate }) => candidate)
      .filter((candidate) => candidate.verification.params?.revealed)
      .map((candidate) => ({
        rule: candidate.rule,
        severity: candidate.severity,
        revealed: candidate.verification.params?.revealed,
      }));
    expect(revealed).toEqual(
      expect.arrayContaining([
        {
          rule: "idiom:adjacent-elements-touch",
          severity: "major",
          revealed: { state: "panel", disclosure: "Attach", kind: "popup" },
        },
        {
          rule: "idiom:native-control-unstyled",
          severity: "major",
          revealed: { state: "panel", disclosure: "Attach", kind: "popup" },
        },
        {
          rule: "idiom:popover-covers-control",
          severity: "major",
          revealed: {
            state: "panel",
            disclosure: "Attach › Link",
            kind: "mode",
          },
        },
      ]),
    );
    expect(revealed).toHaveLength(3);
    const touch = findings.find(
      ({ candidate }) => candidate.rule === "idiom:adjacent-elements-touch",
    )?.candidate;
    expect(touch?.explanation).toMatch(
      /^panel › Attach: #attach-image and #attach-link/,
    );
  }, 60_000);

  test("a well-built menu reports none of them, opened or not", async () => {
    const { findings, tuples } = await reviewStates(
      browser,
      [{ state: "panel", html: goodHtml }],
      { probe: true },
    );
    expect(
      findings
        .map(({ candidate }) => candidate)
        .filter((candidate) => newRules.includes(candidate.rule))
        .map((candidate) => candidate.explanation),
    ).toEqual([]);
    const observations = tuples[0]?.observations as ObservationArtifactV2;
    const results = observations.probe?.results ?? [];
    // The menu and the details were both opened and observed.
    expect(
      results
        .filter((result) => result.revealed?.status === "observed")
        .map((result) => [result.name, result.revealed?.kind]),
    ).toEqual(
      expect.arrayContaining([
        ["Attach", "popup"],
        ["Tips", "details"],
        ["Attach › Link", "mode"],
      ]),
    );
  }, 60_000);
});

const probePage = `<!doctype html><html><body style="font:15px sans-serif">
<details id="more"><summary>More</summary><button type="button">Inside details</button></details>
<button id="toggle" type="button" aria-expanded="false" aria-controls="panel">Filters</button>
<div id="panel" hidden><button type="button">Apply</button></div>
<div style="position:relative">
  <button id="menu-button" type="button" aria-haspopup="true">Options</button>
  <div id="pop" hidden style="position:absolute;top:100%;left:0;background:#fff;padding:8px"><button type="button">First</button><button type="button">Second</button></div>
</div>
<script>(() => {
  const toggle = document.getElementById("toggle");
  toggle.onclick = () => {
    const panel = document.getElementById("panel");
    panel.hidden = !panel.hidden;
    toggle.setAttribute("aria-expanded", String(!panel.hidden));
  };
  document.getElementById("menu-button").onclick = () => {
    const pop = document.getElementById("pop");
    pop.hidden = !pop.hidden;
  };
})();</script></body></html>`;

async function probed(options: { hook?: boolean; maxRevealed?: number } = {}) {
  const page = await browser.newPage();
  try {
    const load = async (target: Page) => {
      await target.setContent(probePage);
    };
    await load(page);
    return await probeControls({
      page,
      skip: [],
      maxControls: 20,
      waitMs: 100,
      restore: load,
      ...(options.hook === false
        ? {}
        : {
            observeRevealed: revealedObserver({
              tokens: { status: "not-configured" },
            }),
          }),
      ...(options.maxRevealed === undefined
        ? {}
        : { maxRevealed: options.maxRevealed }),
    });
  } finally {
    await page.close();
  }
}

describe("the probe opens disclosures", () => {
  test("details, expanders and a plain positioned popup are opened, observed and explored", async () => {
    const probe = await probed();
    const byName = new Map(
      probe.results.map((result) => [result.name, result]),
    );
    expect(byName.get("More")?.revealed).toMatchObject({
      kind: "details",
      status: "observed",
    });
    expect(byName.get("Filters")?.revealed).toMatchObject({
      kind: "expanded",
      status: "observed",
      root: expect.stringContaining("div:nth-of-type(1)"),
    });
    expect(byName.get("Options")?.revealed).toMatchObject({
      kind: "popup",
      status: "observed",
    });
    // The popup is a plain div: its root still supplies the nested items.
    expect(byName.get("Options › First")?.status).toBe("completed");
    expect(byName.get("Options › Second")?.status).toBe("completed");
    expect(byName.get("More › Inside details")?.status).toBe("completed");
    expect(
      byName.get("Options")?.revealed?.observations?.probe,
    ).toBeUndefined();
  }, 60_000);

  test("the per-state cap records the rest as unavailable; no hook records nothing", async () => {
    const capped = await probed({ maxRevealed: 1 });
    const states = capped.results.flatMap((result) =>
      result.revealed === undefined ? [] : [result.revealed],
    );
    expect(states.filter((state) => state.status === "observed")).toHaveLength(
      1,
    );
    expect(
      states.filter((state) => state.status === "unavailable")[0]?.reason,
    ).toBe("revealed-state limit (checks.probe.maxRevealed)");
    const bare = await probed({ hook: false });
    expect(bare.results.some((result) => result.revealed)).toBe(false);
    // Without the hook the plain popup's items are still explored.
    expect(bare.results.map((result) => result.name)).toContain(
      "Options › First",
    );
  }, 60_000);
});

describe("observations", () => {
  test("the disclosure inventory carries the probe's paths", async () => {
    const page = await browser.newPage();
    try {
      await page.setContent(goodHtml);
      const observations = (await observePage(page, {
        status: "not-configured",
      })) as ObservationArtifactV2;
      expect(observations.disclosures).toEqual([
        {
          selector: "#attach",
          path: "html > body:nth-of-type(1) > main:nth-of-type(1) > div:nth-of-type(1) > div:nth-of-type(1) > button:nth-of-type(1)",
          id: "#attach",
          name: "Attach",
          kind: "popup",
          open: false,
        },
        expect.objectContaining({
          path: "html > body:nth-of-type(1) > main:nth-of-type(1) > div:nth-of-type(1) > div:nth-of-type(1) > details:nth-of-type(1) > summary:nth-of-type(1)",
          name: "Tips",
          kind: "details",
          open: false,
        }),
      ]);
      expect(observations.popoverCovers).toEqual([]);
      const file = observations.elements.find(
        (element) => element.selector === "#attach-file",
      );
      // Hidden behind its styled label: not painted, no signals.
      expect(file?.signals?.nativeControl).toBeUndefined();
    } finally {
      await page.close();
    }
  });

  test("an open popover over a field is recorded; abutting its trigger is not", async () => {
    const page = await browser.newPage();
    try {
      await page.setContent(attachHtml);
      await page.locator("#attach").click();
      await page.locator("#attach-link").click();
      const observations = (await observePage(page, {
        status: "not-configured",
      })) as ObservationArtifactV2;
      const covers = observations.popoverCovers ?? [];
      expect(
        covers.map((cover) => [cover.overlay, cover.target, cover.targetRole]),
      ).toEqual([["#attach-menu", "#link-url", "field"]]);
      expect(covers[0]?.hits ?? 0).toBeGreaterThanOrEqual(
        Math.ceil((covers[0]?.samples ?? 0) / 2),
      );
      expect(
        observations.elements.find(
          (element) => element.selector === "#attach-file",
        )?.signals?.nativeControl,
      ).toEqual({ type: "file", defaultStyled: true });
      expect(observations.disclosures?.[0]).toMatchObject({
        selector: "#attach",
        open: true,
      });
    } finally {
      await page.close();
    }
  });

  test("a popover laid over its own trigger is recorded as covering it", async () => {
    const page = await browser.newPage();
    try {
      await page.setContent(`<div style="position:relative;margin:40px">
        <button id="t" type="button" aria-expanded="true" aria-controls="m" style="padding:12px 24px">Open</button>
        <div id="m" style="position:absolute;top:0;left:0;width:200px;height:120px;background:#fff;border:1px solid #ccc"><button type="button">One</button></div>
      </div>`);
      const observations = (await observePage(page, {
        status: "not-configured",
      })) as ObservationArtifactV2;
      expect(
        (observations.popoverCovers ?? []).map((cover) => [
          cover.target,
          cover.targetRole,
        ]),
      ).toEqual([["#t", "trigger"]]);
    } finally {
      await page.close();
    }
  });
});

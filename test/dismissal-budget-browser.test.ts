import { type Browser, chromium, type Page } from "playwright";
import { afterAll, beforeAll, expect, test } from "vitest";
import { MAX_DISMISSALS } from "../src/capture/dismissal.js";
import { probeControls } from "../src/capture/probe.js";
import { computeProbeCoverage } from "../src/coverage/probe.js";

let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
});
afterAll(async () => {
  await browser.close();
});

/** `count` menu buttons whose menus close on Escape and outside clicks. */
const menus = (count: number) => `<!doctype html>
<style>
  body { margin: 0; font: 14px system-ui; }
  .bar { display: flex; gap: 8px; padding: 8px; position: relative; }
  [role="menu"] { position: absolute; top: 48px; left: 8px; width: 160px; background: #fff; border: 1px solid #ccc; margin: 0; padding: 8px; }
  [role="menu"][hidden] { display: none; }
  main { height: 400px; }
</style>
<div class="bar">
${Array.from(
  { length: count },
  (_, index) =>
    `<button id="m${index}" aria-haspopup="menu" aria-expanded="false" aria-controls="p${index}">Menu ${index}</button><div id="p${index}" role="menu" hidden>Panel ${index}</div>`,
).join("\n")}
</div>
<main></main>
<script>
  const pairs = [...document.querySelectorAll("[aria-haspopup]")].map((trigger) => [trigger, document.getElementById(trigger.getAttribute("aria-controls"))]);
  const close = (trigger, menu) => { menu.hidden = true; trigger.setAttribute("aria-expanded", "false"); };
  for (const [trigger, menu] of pairs)
    trigger.addEventListener("click", () => {
      const open = menu.hidden;
      for (const [other, panel] of pairs) close(other, panel);
      menu.hidden = !open;
      trigger.setAttribute("aria-expanded", String(open));
    });
  document.addEventListener("pointerdown", (event) => {
    for (const [trigger, menu] of pairs)
      if (!menu.contains(event.target) && !trigger.contains(event.target)) close(trigger, menu);
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") for (const [trigger, menu] of pairs) { if (!menu.hidden) trigger.focus(); close(trigger, menu); }
  });
</script>`;

async function probe(html: string, controlTimeoutMs: number) {
  const context = await browser.newContext({
    viewport: { width: 1600, height: 600 },
  });
  try {
    const page = await context.newPage();
    const restore = async (target: Page) => {
      await target.setContent(html);
    };
    await restore(page);
    return await probeControls({
      page,
      restore,
      skip: [],
      maxControls: 30,
      waitMs: 30,
      controlTimeoutMs,
      stateTimeoutMs: 120_000,
      dismissal: { explicit: [] },
    });
  } finally {
    await context.close();
  }
}

test("dismissal tests past the control's budget are recorded as not reached", async () => {
  const artifact = await probe(menus(1), 1000);
  const block = artifact.results.find(
    (result) => result.selector === "#m0",
  )?.dismissal;
  expect(block?.status).toBe("not-reached");
  expect(block?.tests.map((entry) => entry.outcome)).toEqual([
    "not-reached",
    "not-reached",
    "not-tested",
  ]);
  expect(block?.tests[0]?.reason).toMatch(/^probe budget/);
  expect(artifact.dismissal).toEqual({
    tested: 0,
    notReached: 1,
    limit: MAX_DISMISSALS,
  });
  const coverage = computeProbeCoverage({
    tuples: [
      {
        state: "home",
        viewport: "desktop",
        observations: { version: 2, probe: artifact } as never,
      },
    ],
  });
  expect(coverage?.states[0]?.dismissal).toMatchObject({
    tested: 0,
    notReached: 1,
    topNotReached: { reason: "probe budget", count: 1 },
  });
}, 60_000);

test(`overlays past the ${MAX_DISMISSALS}-per-state limit are not reached`, async () => {
  const artifact = await probe(menus(MAX_DISMISSALS + 1), 5000);
  const blocks = artifact.results.flatMap((result) =>
    result.dismissal ? [result.dismissal] : [],
  );
  expect(blocks).toHaveLength(MAX_DISMISSALS + 1);
  expect(
    blocks.slice(0, MAX_DISMISSALS).every((block) => block.status === "tested"),
  ).toBe(true);
  expect(blocks.at(-1)?.status).toBe("not-reached");
  expect(blocks.at(-1)?.reason).toMatch(/^dismissal limit/);
  expect(artifact.dismissal).toEqual({
    tested: MAX_DISMISSALS,
    notReached: 1,
    limit: MAX_DISMISSALS,
  });
}, 120_000);

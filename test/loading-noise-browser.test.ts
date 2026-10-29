import { type Browser, chromium, type Page } from "playwright";
import { afterAll, beforeAll, expect, test } from "vitest";
import { installNoiseRecorder } from "../src/capture/loading.js";

let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch();
});
afterAll(async () => {
  await browser.close();
});

async function fixture() {
  const page = await browser.newPage();
  await page.clock.install({ time: new Date(0) });
  await page.addInitScript(installNoiseRecorder);
  await page.goto(
    'data:text/html,<main><button>Start</button><span id="ticker">Initial</span><ul id="list"></ul><div id="other">Other</div></main>',
  );
  await page.clock.pauseAt(new Date(1000));
  return page;
}
async function schedule(page: Page, entries: Array<[number, string]>) {
  await page.evaluate((entries) => {
    for (const [at, selector] of entries)
      setTimeout(() => {
        const element = document.querySelector(selector);
        if (element) element.textContent = String(performance.now());
      }, at);
  }, entries);
}
async function snapshot(page: Page, anchors: number[] = []) {
  return page.evaluate((anchors) => {
    const log = (
      window as unknown as Window & {
        __idiomNoiseLog: {
          periodic(anchors: number[]): Element[];
          provisional(
            anchors: number[],
          ): Array<{ root: Element; deadline: number }>;
        };
      }
    ).__idiomNoiseLog;
    return {
      periodic: log.periodic(anchors).map((e) => e.id || e.tagName),
      provisional:
        log.provisional?.(anchors).map(({ root, deadline }) => ({
          root: root.id || root.tagName,
          deadline,
        })) ?? [],
      now: performance.now(),
    };
  }, anchors);
}

test.each([0, 50])(
  "independent tasks %ims apart cannot consume the ticker's third sample",
  async (gap) => {
    const page = await fixture();
    try {
      await schedule(page, [
        [300, "#ticker"],
        [1000, "#ticker"],
        [1700 - gap, "#list"],
        [1700, "#ticker"],
      ]);
      await page.clock.runFor(1850);
      expect((await snapshot(page)).periodic).toEqual(["ticker"]);
    } finally {
      await page.close();
    }
  },
);
test("quiet regular batches classify only their own narrow root, without startup samples", async () => {
  const page = await fixture();
  try {
    await schedule(page, [
      [300, "#ticker"],
      [1000, "#ticker"],
      [1700, "#ticker"],
    ]);
    await page.clock.runFor(1450);
    const pending = await snapshot(page);
    expect(pending.periodic).toEqual([]);
    expect(pending.provisional).toEqual([
      { root: "ticker", deadline: expect.any(Number) },
    ]);
    expect(pending.provisional[0]?.deadline).toBeGreaterThan(pending.now);
    await page.clock.runFor(250);
    // The third sample exists, but its batch has not closed yet.
    expect((await snapshot(page)).periodic).toEqual([]);
    expect((await snapshot(page)).provisional).toHaveLength(1);
    await page.clock.runFor(150);
    expect((await snapshot(page)).periodic).toEqual(["ticker"]);
    expect((await snapshot(page)).provisional).toEqual([]);
  } finally {
    await page.close();
  }
});
test("an irregular third sample is reconsidered and expires without becoming noise", async () => {
  const page = await fixture();
  try {
    await schedule(page, [
      [300, "#ticker"],
      [1000, "#ticker"],
      [1400, "#ticker"],
    ]);
    await page.clock.runFor(1550);
    expect((await snapshot(page)).periodic).toEqual([]);
    await page.clock.runFor(1000);
    expect((await snapshot(page)).provisional).toEqual([]);
  } finally {
    await page.close();
  }
});
test("a multi-target delivery cannot manufacture narrow periodic histories or exempt main/body", async () => {
  const page = await fixture();
  try {
    await page.evaluate(() => {
      for (const at of [300, 1000, 1700])
        setTimeout(() => {
          document
            .querySelector("#ticker")
            ?.setAttribute("data-tick", String(at));
          document
            .querySelector("#list")
            ?.setAttribute("data-tick", String(at));
          document.body.setAttribute("data-tick", String(at));
        }, at);
    });
    await page.clock.runFor(1850);
    const result = await snapshot(page);
    expect(result.periodic).not.toContain("MAIN");
    expect(result.periodic).not.toContain("BODY");
    expect(result.provisional).toEqual([]);
  } finally {
    await page.close();
  }
});
test.each(["input", "response"])(
  "%s-started periodic progress remains feedback",
  async (anchor) => {
    const page = await fixture();
    try {
      let released = 0;
      if (anchor === "input") {
        await page.evaluate(() =>
          document.querySelector("button")?.addEventListener("click", () => {
            for (const at of [0, 700, 1400])
              setTimeout(() => {
                document
                  .querySelector("#ticker")
                  ?.setAttribute("data-tick", String(at));
              }, at);
          }),
        );
        await page.locator("button").click();
      } else {
        released = await page.evaluate(() => performance.now());
        await schedule(page, [
          [0, "#ticker"],
          [700, "#ticker"],
          [1400, "#ticker"],
        ]);
      }
      await page.clock.runFor(1550);
      expect(
        (await snapshot(page, anchor === "response" ? [released] : []))
          .periodic,
      ).toEqual([]);
      expect(
        (await snapshot(page, anchor === "response" ? [released] : []))
          .provisional,
      ).toEqual([]);
    } finally {
      await page.close();
    }
  },
);

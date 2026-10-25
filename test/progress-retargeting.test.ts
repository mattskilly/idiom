import { type Browser, chromium } from "playwright";
import { afterAll, beforeAll, expect, test } from "vitest";
import { ProgressCollector } from "../src/capture/progress.js";
import { WebStepRunner } from "../src/capture/web-steps.js";
import { runDeterministicChecks } from "../src/checks/registry.js";
import type { WebStep } from "../src/schemas/flow.js";
import { emptyObservation, required, tupleFor } from "./motion-support.js";

let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch();
});
afterAll(async () => {
  await browser.close();
});

test.each([
  {
    action: "fill",
    selector: "label",
    feedback: false,
    nested: false,
    replace: false,
  },
  {
    action: "fill",
    selector: "label",
    feedback: true,
    nested: false,
    replace: false,
  },
  {
    action: "fill",
    selector: "text=Search",
    feedback: false,
    nested: false,
    replace: false,
  },
  {
    action: "fill",
    selector: "text=Search",
    feedback: true,
    nested: false,
    replace: false,
  },
  {
    action: "select",
    selector: "label",
    feedback: false,
    nested: false,
    replace: false,
  },
  {
    action: "select",
    selector: "text=Search",
    feedback: true,
    nested: false,
    replace: false,
  },
  {
    action: "fill",
    selector: "text=Search",
    feedback: false,
    nested: true,
    replace: false,
  },
  {
    action: "fill",
    selector: "#query",
    feedback: false,
    nested: false,
    replace: false,
  },
  {
    action: "fill",
    selector: "text=Search",
    feedback: true,
    nested: false,
    replace: true,
  },
] as const)(
  "$action via $selector, feedback=$feedback, nested=$nested, replace=$replace",
  async ({ action, selector, feedback, nested, replace }) => {
    const page = await browser.newPage();
    const collector = new ProgressCollector(page, 1000);
    const runner = new WebStepRunner(
      page,
      { allow: { urls: [], console: [] } },
      {},
      undefined,
      collector,
    );
    try {
      const control =
        action === "select"
          ? '<select id="query"><option value="one">One</option><option value="two">Two</option></select>'
          : `<input id="query"${replace ? " disabled" : ""}>`;
      await page.route("http://fixture.test/", (route) =>
        route.fulfill({
          contentType: "text/html",
          body: `<!doctype html><label for="query">${nested ? "<span>Search</span>" : "Search"}</label>${control}<main>Ready</main><script>
      ${replace ? "setTimeout(()=>{const old=document.querySelector('#query');old.replaceWith(old.cloneNode(true));},300);setTimeout(()=>document.querySelector('#query').disabled=false,1600);" : ""}
      document.addEventListener('input',async(event)=>{
        if(event.target.id!=='query')return;
        ${feedback ? "document.querySelector('main').setAttribute('aria-busy','true');" : ""}
        await fetch('/result');document.querySelector('main').textContent='Result';
      });
    </script>`,
        }),
      );
      await page.route("http://fixture.test/result", async (route) => {
        await new Promise((resolve) => setTimeout(resolve, 1500));
        await route.fulfill({ body: "Result" });
      });
      const step: WebStep = {
        action,
        selector,
        value: action === "fill" ? "hello" : "two",
        longRunning: true,
      };
      await runner.reach("http://fixture.test/", [
        step,
        { action: "expectText", text: "Result" },
      ]);
      expect(await page.locator("#query").inputValue()).toBe(
        action === "fill" ? "hello" : "two",
      );
      const evidence = required(collector.evidence().steps[0]);
      expect(evidence.status).toBe("ran");
      expect(evidence.observedMs).toBeGreaterThanOrEqual(1000);
      if (feedback) {
        expect(evidence.affordance?.kind).toBe("busy");
        expect(evidence.firstMs).toBeLessThan(100);
      } else expect(evidence.firstMs).toBeNull();
      const findings = runDeterministicChecks([
        tupleFor({ ...emptyObservation, progress: collector.evidence() }),
      ]).candidates.filter(
        ({ candidate }) => candidate.category === "progress-affordance",
      );
      expect(findings).toHaveLength(feedback ? 0 : 1);
      if (!feedback)
        expect(findings[0]?.candidate).toMatchObject({
          severity: "major",
          selectorHint: selector,
        });
      expect(await page.evaluate(() => "__idiomProgress" in window)).toBe(
        false,
      );
    } finally {
      await runner.dispose();
      await page.close();
    }
  },
  10_000,
);

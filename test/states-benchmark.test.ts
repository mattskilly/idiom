import { createServer } from "node:http";
import { type Browser, chromium } from "playwright";
import { afterAll, beforeAll, expect, test } from "vitest";
import { createBrowserLauncher } from "../src/capture/browser.js";
import { ProgressCollector } from "../src/capture/progress.js";
import { observationArtifactSchema } from "../src/checks/artifact-schema.js";
import { runDeterministicChecks } from "../src/checks/registry.js";
import type { EmptyRegionsObservation } from "../src/checks/types.js";
import { flowSchema } from "../src/schemas/flow.js";
import { projectSchema } from "../src/schemas/project.js";
import { fixture, reviewFixture } from "./benchmark-support.js";
import { emptyObservation, required, tupleFor } from "./motion-support.js";

let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch();
});
afterAll(async () => {
  await browser.close();
});

test("empty-state benchmark reports the empty canvas and list and passes fixed fixtures", async () => {
  const checks = {
    emptyState: { regions: [{ selector: "main.canvas", items: ".block" }] },
  };
  const before = await reviewFixture(
    browser,
    await fixture("empty-state-before.html"),
    { checks },
  );
  expect(
    before
      .filter(({ candidate }) => candidate.category === "empty-state")
      .map(({ candidate }) => [candidate.selectorHint, candidate.severity]),
  ).toEqual([
    ["main.canvas", "major"],
    ["table.leads", "minor"],
  ]);
  const after = await reviewFixture(
    browser,
    await fixture("empty-state-after.html"),
    { checks },
  );
  expect(
    after.filter(({ candidate }) => candidate.category === "empty-state"),
  ).toEqual([]);
});

test("empty-region observation excludes populated and utility regions; captures only usable CTA and prose", async () => {
  let evidence: EmptyRegionsObservation | undefined;
  await reviewFixture(
    browser,
    `<!doctype html><style>ul,table,[role=grid]{min-height:40px;width:200px}</style>
    <nav><ul></ul></nav><div aria-live="polite"><ul></ul></div><ul style="min-height:0;height:0"></ul>
    <ul><li>Real item<ul></ul></li></ul><table><tr><td>Real row</td></tr></table>
    <ul class="ignored"></ul><div id="canvas"><h2>Empty canvas</h2><button disabled>Add block</button><span hidden>No blocks yet</span></div>`,
    {
      checks: {
        emptyState: {
          regions: [{ selector: "#canvas", items: ".block" }],
          ignore: [".ignored"],
        },
      },
      onObservations: (value) => {
        evidence = value.version === 2 ? value.emptyRegions : undefined;
      },
    },
  );
  expect(evidence).toMatchObject({
    regions: [{ selector: "#canvas", cta: [], text: "Empty canvas" }],
  });
  expect(required<EmptyRegionsObservation>(evidence).regions).toHaveLength(1);
});

test("longRunning capture records progress, round-trips offline, and discloses navigation", async () => {
  const pages = new Map([
    ["/before", await fixture("progress-before.html")],
    ["/after", await fixture("progress-after.html")],
    [
      "/navigate",
      '<button id="generate" onclick="location.href=\'/done\'">Go</button>',
    ],
    ["/done", "<p>Result</p>"],
  ]);
  const server = createServer((request, response) => {
    response.setHeader("Content-Type", "text/html");
    response.end(pages.get(request.url ?? "") ?? "");
  });
  await new Promise<void>((accept) => server.listen(0, "127.0.0.1", accept));
  const address = server.address();
  if (!address || typeof address === "string") throw Error("no port");
  const url = `http://127.0.0.1:${address.port}`;
  const session = await createBrowserLauncher({
    createAxe: () => ({ analyze: async () => ({ violations: [] }) }),
  })();
  try {
    const project = projectSchema.parse({
      version: 1,
      app: { name: "Progress", framework: "other" },
      server: {
        build: "node -e 0",
        start: "node -e 0",
        readyUrl: url,
        port: address.port,
        env: {},
      },
      viewports: [{ name: "desktop", width: 800, height: 600 }],
      capture: { settleMs: 0 },
      design: {},
      model: { provider: "anthropic", model: "unused", maxFindings: 5 },
    });
    for (const name of ["before", "after", "navigate", "unmarked"]) {
      const flow = flowSchema.parse({
        id: "progress",
        title: "Progress",
        intent: [],
        setup: [],
        states: [
          {
            id: name,
            description: name,
            url: `/${name}`,
            steps: [
              {
                action: "click",
                selector: "#generate",
                ...(name === "unmarked" ? {} : { longRunning: true }),
              },
              { action: "expectText", text: "Result" },
            ],
            expect: {},
          },
        ],
      });
      const result = await session.capture({
        project,
        state: required(flow.states[0]),
        viewport: required(project.viewports[0]),
        navigationUrl: `${url}/${name === "unmarked" ? "after" : name}`,
        probe: name === "after",
      });
      expect(result.ok).toBe(true);
      if (result.observations?.version !== 2) throw Error("missing evidence");
      const observation = result.observations;
      expect(
        observationArtifactSchema.parse(
          JSON.parse(JSON.stringify(observation)),
        ),
      ).toEqual(observation);
      const candidates = runDeterministicChecks([
        tupleFor(observation),
      ]).candidates.filter(
        ({ candidate }) => candidate.category === "progress-affordance",
      );
      expect(candidates).toHaveLength(name === "before" ? 1 : 0);
      if (name === "after") {
        expect(observation.progress?.steps).toHaveLength(1);
        expect(observation.progress?.steps[0]?.firstMs).toBeLessThan(1000);
        expect(observation.progress?.steps[0]?.affordance?.kind).toBe("busy");
      } else if (name === "navigate")
        expect(observation.progress?.steps[0]).toMatchObject({
          status: "unavailable",
          reason: expect.stringContaining("navigation"),
        });
      else if (name === "unmarked")
        expect(observation).not.toHaveProperty("progress");
      else
        expect(observation.progress?.steps[0]).toMatchObject({
          status: "ran",
          firstMs: null,
        });
    }
  } finally {
    await session.close();
    await new Promise<void>((accept) => server.close(() => accept()));
  }
}, 30_000);

test.each([
  [
    "progressbar",
    "document.body.insertAdjacentHTML('beforeend','<progress></progress>')",
  ],
  ["busy", "document.body.setAttribute('aria-busy','true')"],
  [
    "status-text",
    "document.querySelector('[role=status]').textContent='Working'",
  ],
  ["control-text", "document.querySelector('button').textContent='Working'"],
  [
    "progress-text",
    "document.body.insertAdjacentHTML('beforeend','<p>Loading…</p>')",
  ],
  [
    "spinner",
    "document.body.insertAdjacentHTML('beforeend','<div style=\"width:20px;height:20px;animation:spin 1s infinite\"></div>')",
  ],
])("progress detects a newly appearing %s", async (kind, action) => {
  const page = await browser.newPage();
  try {
    await page.setContent(
      '<style>@keyframes spin{to{transform:rotate(360deg)}}</style><button>Generate</button><p role="status">AI ready</p>',
    );
    const collector = new ProgressCollector(page, 100);
    const watch = await collector.start({
      stepIndex: 1,
      action: "click",
      selector: "button",
    });
    await page.evaluate((script) => {
      new Function(script)();
    }, action);
    await watch.finish();
    await watch.dispose();
    expect(collector.evidence().steps[0]?.affordance?.kind).toBe(kind);
  } finally {
    await page.close();
  }
});

test("pre-existing progress signals do not pass an inactive action", async () => {
  const page = await browser.newPage();
  try {
    await page.setContent(
      '<style>@keyframes spin{to{transform:rotate(360deg)}}</style><button>Generate</button><progress></progress><p role="status">Loading…</p><div aria-busy="true" style="width:20px;height:20px;animation:spin 1s infinite"></div>',
    );
    const collector = new ProgressCollector(page, 100);
    const watch = await collector.start({
      stepIndex: 1,
      action: "click",
      selector: "button",
    });
    await page.locator("button").click();
    await watch.finish();
    expect(collector.evidence().steps[0]).toMatchObject({
      status: "ran",
      firstMs: null,
    });
  } finally {
    await page.close();
  }
});

test("explicit empty regions cover zero-height voids and honor ignores and item selectors", async () => {
  let evidence: EmptyRegionsObservation | undefined;
  const result = await reviewFixture(
    browser,
    '<main id="void"></main><main id="ignored"></main><main id="full"><div class="block">Content</div></main><main id="invalid"></main>',
    {
      checks: {
        emptyState: {
          auto: false,
          regions: [
            { selector: "#void", items: ".block" },
            { selector: "#ignored", items: ".block" },
            { selector: "#full", items: ".block" },
            { selector: "#invalid", items: "[" },
            { selector: "[", items: ".block" },
          ],
          ignore: ["#ignored"],
        },
      },
      onObservations: (value) => {
        evidence = value.version === 2 ? value.emptyRegions : undefined;
      },
    },
  );
  expect(
    result
      .filter(({ candidate }) => candidate.category === "empty-state")
      .map(({ candidate }) => candidate.selectorHint),
  ).toEqual(["#void"]);
  expect(evidence).toMatchObject({
    configured: [
      { selector: "#void", matched: 1 },
      { selector: "#ignored", matched: 1 },
      { selector: "#full", matched: 1 },
      { selector: "#invalid", matched: 1 },
      { selector: "[", matched: 0 },
    ],
  });
});

test("a pre-existing busy element can expose progress again after resetting", async () => {
  const page = await browser.newPage();
  try {
    await page.setContent(
      '<button>Generate</button><main aria-busy="true">Content</main>',
    );
    const collector = new ProgressCollector(page, 100);
    const watch = await collector.start({
      stepIndex: 1,
      action: "click",
      selector: "button",
    });
    await page.locator("main").evaluate((element) => {
      element.setAttribute("aria-busy", "false");
    });
    await page.locator("main").evaluate((element) => {
      element.setAttribute("aria-busy", "true");
    });
    await watch.finish();
    expect(collector.evidence().steps[0]?.affordance?.kind).toBe("busy");
  } finally {
    await page.close();
  }
});

test("visible empty-state prose survives display: contents wrappers", async () => {
  let evidence: EmptyRegionsObservation | undefined;
  const findings = await reviewFixture(
    browser,
    await fixture("empty-state-contents-after.html"),
    {
      checks: {
        emptyState: { regions: [{ selector: "#canvas", items: ".block" }] },
      },
      onObservations: (observation) => {
        evidence =
          observation.version === 2 ? observation.emptyRegions : undefined;
      },
    },
  );
  expect(evidence?.regions[0]?.text).toBe("Canvas heading No blocks yet");
  expect(
    findings.filter(({ candidate }) => candidate.category === "empty-state"),
  ).toEqual([]);
});

test.each([0, 1200])(
  "progress deadline excludes waiting for an enabled control (feedback delay %sms)",
  async (delay) => {
    const page = await browser.newPage();
    const { WebStepRunner } = await import("../src/capture/web-steps.js");
    const collector = new ProgressCollector(page, 1000);
    const runner = new WebStepRunner(
      page,
      { allow: { urls: [], console: [] } },
      {},
      undefined,
      collector,
    );
    try {
      await page.route("http://fixture.test/", (route) =>
        route.fulfill({
          contentType: "text/html",
          body: `<!doctype html><button id="generate" disabled>Generate</button><main id="panel">Results</main><script>
      setTimeout(()=>document.querySelector('button').disabled=false,1600);
      document.querySelector('button').onclick=()=>{${delay === 0 ? "document.querySelector('main').setAttribute('aria-busy','true')" : `setTimeout(()=>document.querySelector('main').setAttribute('aria-busy','true'),${delay})`}};
    </script>`,
        }),
      );
      await runner.reach("http://fixture.test/", [
        { action: "click", selector: "#generate", longRunning: true },
      ]);
      const evidence = collector.evidence();
      const result = runDeterministicChecks([
        tupleFor({ ...emptyObservation, progress: evidence }),
      ]);
      expect(evidence.steps[0]?.status).toBe("ran");
      expect(evidence.steps[0]?.observedMs).toBeGreaterThanOrEqual(1000);
      expect(
        result.candidates.filter(
          ({ candidate }) => candidate.category === "progress-affordance",
        ),
      ).toHaveLength(delay === 0 ? 0 : 1);
      if (delay === 0) {
        expect(evidence.steps[0]?.firstMs).toBeLessThan(100);
        expect(evidence.steps[0]?.settledMs).toBeLessThan(1000);
      }
    } finally {
      await runner.dispose();
      await page.close();
    }
  },
  10_000,
);

test.each([
  {
    name: "fill",
    action: "fill",
    selector: "input",
    value: "hello",
    html: "<input>",
  },
  {
    name: "clear",
    action: "fill",
    selector: "input",
    value: "",
    html: '<input value="hello">',
  },
  {
    name: "date fill",
    action: "fill",
    selector: "input",
    value: "2026-10-23",
    html: '<input type="date">',
  },
  {
    name: "select",
    action: "select",
    selector: "select",
    value: "two",
    html: '<select><option value="one">One</option><option value="two">Two</option></select>',
  },
  {
    name: "press",
    action: "press",
    selector: "input",
    value: "Enter",
    html: "<input>",
  },
  {
    name: "Playwright selector click",
    action: "click",
    selector: "role=button[name=Generate]",
    value: "",
    html: "<button>Generate</button>",
  },
] as const)(
  "dispatch timing supports $name",
  async ({ action, selector, value, html }) => {
    const page = await browser.newPage();
    try {
      await page.setContent(
        `${html}<main>Result</main><script>for(const event of ['input','keydown','click'])document.addEventListener(event,()=>document.querySelector('main').setAttribute('aria-busy','true'));</script>`,
      );
      const collector = new ProgressCollector(page, 100);
      const watch = await collector.start(
        { stepIndex: 1, action, selector },
        { waitForAction: true },
      );
      if (action === "fill") await page.locator(selector).fill(value);
      else if (action === "press") await page.locator(selector).press(value);
      else if (action === "select")
        await page.locator(selector).selectOption(value);
      else await page.locator(selector).click();
      await watch.markSettled();
      await watch.finish();
      expect(collector.evidence().steps[0]).toMatchObject({
        status: "ran",
        affordance: { kind: "busy" },
      });
      expect(collector.evidence().steps[0]?.firstMs).toBeLessThan(100);
    } finally {
      await page.close();
    }
  },
);

test("progress changes before input dispatch are baselined instead of passing the action", async () => {
  const page = await browser.newPage();
  try {
    await page.setContent(
      '<button>Generate</button><p role="status">Ready</p>',
    );
    const collector = new ProgressCollector(page, 100);
    const watch = await collector.start(
      { stepIndex: 1, action: "click", selector: "button" },
      { waitForAction: true },
    );
    await page.locator("p").evaluate((element) => {
      element.textContent = "Preparing…";
    });
    await page.locator("button").click();
    await watch.finish();
    expect(collector.evidence().steps[0]).toMatchObject({
      status: "ran",
      firstMs: null,
    });
  } finally {
    await page.close();
  }
});

test("missing dispatch is unavailable and disposes its watcher", async () => {
  const page = await browser.newPage();
  try {
    await page.setContent("<button>Generate</button>");
    const collector = new ProgressCollector(page, 100);
    const watch = await collector.start(
      { stepIndex: 1, action: "click", selector: "button" },
      { waitForAction: true },
    );
    await watch.finish();
    expect(collector.evidence().steps[0]).toMatchObject({
      status: "unavailable",
      reason: expect.stringContaining("action dispatch was not observed"),
    });
    expect(await page.evaluate(() => "__idiomProgress" in window)).toBe(false);
  } finally {
    await page.close();
  }
});

test.each(["visible", "display:none", "visibility:hidden", "opacity:0"])(
  "boxless items count as populated only when their content is rendered: %s",
  async (visibility) => {
    let evidence: EmptyRegionsObservation | undefined;
    let html = await fixture("empty-state-populated-contents.html");
    if (visibility !== "visible")
      html = html.replace(
        "display:contents}",
        `display:contents;${visibility}}`,
      );
    const findings = await reviewFixture(browser, html, {
      checks: {
        emptyState: { regions: [{ selector: "#canvas", items: ".block" }] },
      },
      onObservations: (observation) => {
        evidence =
          observation.version === 2 ? observation.emptyRegions : undefined;
      },
    });
    expect(evidence?.regions).toHaveLength(visibility === "visible" ? 0 : 4);
    expect(
      findings.filter(({ candidate }) => candidate.category === "empty-state"),
    ).toHaveLength(visibility === "visible" ? 0 : 4);
  },
);

test.each([
  { selector: "button", feedback: false },
  { selector: "role=button[name=Generate]", feedback: false },
  { selector: "role=button[name=Generate]", feedback: true },
])(
  "progress follows a replaced control ($selector, feedback=$feedback)",
  async ({ selector, feedback }) => {
    const page = await browser.newPage();
    const { WebStepRunner } = await import("../src/capture/web-steps.js");
    const collector = new ProgressCollector(page, 1000);
    const runner = new WebStepRunner(
      page,
      { allow: { urls: [], console: [] } },
      {},
      undefined,
      collector,
    );
    try {
      await page.route("http://fixture.test/", (route) =>
        route.fulfill({
          contentType: "text/html",
          body: `<!doctype html><button disabled>Generate</button><main>Ready</main><script>
      setTimeout(()=>{
        const replacement=document.createElement('button');replacement.textContent='Generate';
        replacement.onclick=async()=>{${feedback ? "document.querySelector('main').setAttribute('aria-busy','true');" : ""}await fetch('/result');document.querySelector('main').textContent='Result';};
        document.querySelector('button').replaceWith(replacement);
      },300);
    </script>`,
        }),
      );
      await page.route("http://fixture.test/result", async (route) => {
        await new Promise((resolve) => setTimeout(resolve, 1500));
        await route.fulfill({ body: "Result" });
      });
      await runner.reach("http://fixture.test/", [
        { action: "click", selector, longRunning: true },
        { action: "expectText", text: "Result" },
      ]);
      expect(collector.evidence().steps[0]?.status).toBe("ran");
      expect(collector.evidence().steps[0]?.observedMs).toBeGreaterThanOrEqual(
        1000,
      );
      const findings = runDeterministicChecks([
        tupleFor({ ...emptyObservation, progress: collector.evidence() }),
      ]).candidates.filter(
        ({ candidate }) => candidate.category === "progress-affordance",
      );
      expect(findings).toHaveLength(feedback ? 0 : 1);
      if (feedback)
        expect(collector.evidence().steps[0]?.firstMs).toBeLessThan(100);
      else expect(collector.evidence().steps[0]?.firstMs).toBeNull();
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

test("native and ARIA headings can explain empty states", async () => {
  let evidence: EmptyRegionsObservation | undefined;
  const findings = await reviewFixture(
    browser,
    await fixture("empty-state-heading-after.html"),
    {
      checks: {
        emptyState: { regions: [{ selector: "#canvas", items: ".block" }] },
      },
      onObservations: (observation) => {
        evidence =
          observation.version === 2 ? observation.emptyRegions : undefined;
      },
    },
  );
  expect(
    evidence?.regions.map(({ selector, text }) => ({ selector, text })),
  ).toEqual([
    { selector: "#canvas", text: "No blocks yet" },
    { selector: "#leads", text: "No leads yet" },
  ]);
  expect(
    findings.filter(({ candidate }) => candidate.category === "empty-state"),
  ).toEqual([]);
});

test("hidden, CTA and utility text cannot substitute for an empty-state explanation", async () => {
  let evidence: EmptyRegionsObservation | undefined;
  const findings = await reviewFixture(
    browser,
    '<main id="canvas"><h2 hidden>No blocks yet</h2><button><span role="heading">Add your first block</span></button><label><span role="heading">No label yet</span></label><table><caption>No caption yet</caption><tr><th><span role="heading">No columns yet</span></th></tr></table></main>',
    {
      checks: {
        emptyState: {
          auto: false,
          regions: [{ selector: "#canvas", items: ".block" }],
        },
      },
      onObservations: (observation) => {
        evidence =
          observation.version === 2 ? observation.emptyRegions : undefined;
      },
    },
  );
  expect(evidence?.regions[0]?.text).toBe("");
  expect(
    findings.filter(({ candidate }) => candidate.category === "empty-state"),
  ).toHaveLength(1);
});

test.each([
  { initial: "visibility:hidden", revealAfter: 0, hit: true },
  { initial: "opacity:0", revealAfter: 0, hit: true },
  { initial: "display:none", revealAfter: 0, hit: true },
  { initial: "visibility:hidden", revealAfter: 1200, hit: true },
  { initial: "visibility:visible", revealAfter: 0, hit: false },
  { initial: "opacity:0", revealAfter: null, hit: false },
])(
  "spinner visibility after dispatch: $initial, reveal=$revealAfter",
  async ({ initial, revealAfter, hit }) => {
    const page = await browser.newPage();
    const { WebStepRunner } = await import("../src/capture/web-steps.js");
    const collector = new ProgressCollector(page, 1000);
    const runner = new WebStepRunner(
      page,
      { allow: { urls: [], console: [] } },
      {},
      undefined,
      collector,
    );
    try {
      await page.route("http://fixture.test/", (route) =>
        route.fulfill({
          contentType: "text/html",
          body: `<!doctype html><style>@keyframes spin{to{transform:rotate(360deg)}}#spinner{width:24px;height:24px;border:2px solid gray;border-top-color:blue;border-radius:50%;animation:spin 1s linear infinite;${initial}}</style><button id="generate">Generate</button><div id="spinner"></div><main>Ready</main><script>
      const spinner=document.querySelector('#spinner');
      document.querySelector('button').onclick=async()=>{
        const reveal=()=>{const animation=spinner.getAnimations()[0];spinner.style.visibility='visible';spinner.style.opacity='1';spinner.style.display='block';document.body.dataset.sameAnimation=String(animation===spinner.getAnimations()[0]);};
        ${revealAfter === null ? "" : revealAfter === 0 ? "reveal();" : `setTimeout(reveal,${revealAfter});`}
        await fetch('/result');document.querySelector('main').textContent='Result';
      };
    </script>`,
        }),
      );
      await page.route("http://fixture.test/result", async (route) => {
        await new Promise((resolve) => setTimeout(resolve, 1500));
        await route.fulfill({ body: "Result" });
      });
      await runner.reach("http://fixture.test/", [
        { action: "click", selector: "#generate", longRunning: true },
        { action: "expectText", text: "Result" },
      ]);
      const step = required(collector.evidence().steps[0]);
      expect(step.status).toBe("ran");
      if (hit) {
        expect(step.affordance?.kind).toBe("spinner");
        if (revealAfter === 0) expect(step.firstMs).toBeLessThan(100);
        else expect(step.firstMs).toBeGreaterThan(1000);
      } else expect(step.firstMs).toBeNull();
      const findings = runDeterministicChecks([
        tupleFor({ ...emptyObservation, progress: collector.evidence() }),
      ]).candidates.filter(
        ({ candidate }) => candidate.category === "progress-affordance",
      );
      expect(findings).toHaveLength(hit && revealAfter === 0 ? 0 : 1);
      if (hit && initial !== "display:none")
        expect(
          await page.locator("body").getAttribute("data-same-animation"),
        ).toBe("true");
    } finally {
      await runner.dispose();
      await page.close();
    }
  },
  10_000,
);

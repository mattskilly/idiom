import { type Browser, chromium, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { probeControls, probeRequestAllowed } from "../src/capture/probe.js";
import { TimelineCollector, withTimelineIds } from "../src/capture/timeline.js";
import { actionTimelineArtifactSchema } from "../src/checks/artifact-schema.js";
import { observePage } from "../src/checks/observe.js";
import { elementMovements, scrollDuring } from "../src/checks/timeline.js";
import type { ActionTimelineArtifact } from "../src/checks/types.js";

let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch();
});
afterAll(async () => {
  await browser.close();
});

function roundTrip(artifact: ActionTimelineArtifact) {
  expect(
    actionTimelineArtifactSchema.parse(JSON.parse(JSON.stringify(artifact))),
  ).toEqual(JSON.parse(JSON.stringify(artifact)));
}

/** Click `selector` inside a timeline window, the way the probe clicks. */
async function clickTimeline(
  page: Page,
  selector: string,
  waitMs = 300,
): Promise<ActionTimelineArtifact> {
  const collector = new TimelineCollector(page);
  const window = await collector.start({
    source: "probe-click",
    kind: "click",
    selector,
    name: selector,
  });
  try {
    await page.locator(selector).first().click({ noWaitAfter: true });
    await page.waitForTimeout(waitMs);
    await window.finish();
  } finally {
    await window.dispose();
  }
  const artifact = collector.evidence();
  roundTrip(artifact);
  return artifact;
}

function only(artifact: ActionTimelineArtifact) {
  expect(artifact.actions).toHaveLength(1);
  const action = artifact.actions[0];
  if (!action) throw new Error("no action");
  return action;
}

test("a click that inserts a banner above content records the shift, the insert and the movement", async () => {
  const page = await browser.newPage();
  try {
    await page.setContent(`
      <style>body{margin:0;font:16px sans-serif} #banner{height:120px;background:#fc0}</style>
      <main id="content">
        <button id="go">Show banner</button>
        <p id="para">Paragraph of content that will be pushed down.</p>
      </main>
      <script>
        go.onclick = () => {
          const banner = document.createElement("div");
          banner.id = "banner";
          banner.textContent = "Banner";
          content.insertBefore(banner, para);
        };
      </script>`);
    const action = only(await clickTimeline(page, "#go"));
    expect(action.status).toBe("ran");
    expect(action.settled).toBe(true);
    const shift = action.shifts.find((entry) =>
      entry.sources.some((source) => source.selector === "#para"),
    );
    expect(shift?.hadRecentInput).toBe(true);
    const insert = action.mutations.find(
      (mutation) => mutation.type === "insert",
    );
    expect(insert?.selector).toBe("#banner");
    expect(insert?.rect?.height).toBeCloseTo(120, 0);
    const para = elementMovements(action).find(
      (movement) => movement.selector === "#para",
    );
    expect(para?.dy).toBeCloseTo(120, 0);
    expect(para?.dx).toBeCloseTo(0, 0);
    expect(action.effectRegion.control).toBe("#go");
    expect(action.effectRegion.commonAncestor).toBe("#content");
  } finally {
    await page.close();
  }
});

test("a below-the-fold click compensates Playwright's scroll into view", async () => {
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  try {
    const paragraphs = Array.from(
      { length: 24 },
      (_, index) =>
        `<p id="p${index}" style="height:90px;margin:0">P${index}</p>`,
    ).join("");
    await page.setContent(`
      <style>body{margin:0;padding-top:60px} header{position:fixed;top:0;left:0;right:0;height:60px;background:#eee} .banner{height:120px;background:#fc0}</style>
      <header id="top">Header</header>
      <section id="list">${paragraphs}<button id="go" style="height:40px">Insert</button><p id="after" style="height:90px;margin:0">After</p></section>
      <script>
        go.onclick = () => {
          const banner = document.createElement("div");
          banner.className = "banner";
          list.insertBefore(banner, after);
        };
      </script>`);
    const action = only(await clickTimeline(page, "#go"));
    expect(scrollDuring(action).dy).toBeGreaterThan(1000);
    const movements = elementMovements(action);
    const after = movements.find((movement) => movement.selector === "#after");
    expect(after?.dy).toBeCloseTo(120, 0);
    // #after was outside the viewport band; the area around the control is
    // tracked from the start because Playwright scrolls there to click.
    expect(
      action.frames[0]?.elements.some((e) => e.selector === "#after"),
    ).toBe(true);
    for (const selector of ["#top", "#p0", "#p5", "#p23", "#go"])
      expect(movements.map((movement) => movement.selector)).not.toContain(
        selector,
      );
  } finally {
    await page.close();
  }
});

test("a nested scroller's scroll is compensated and recorded", async () => {
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  try {
    const rows = Array.from(
      { length: 20 },
      (_, index) =>
        `<div id="r${index}" style="height:60px">Row ${index}</div>`,
    ).join("");
    await page.setContent(`
      <style>body{margin:0} #pane{height:300px;overflow:auto} .banner{height:50px;background:#fc0}</style>
      <div id="pane">${rows}<button id="go">Insert</button><div id="tail" style="height:60px">Tail</div></div>
      <script>
        go.onclick = () => {
          const banner = document.createElement("div");
          banner.className = "banner";
          pane.insertBefore(banner, tail);
        };
      </script>`);
    const action = only(await clickTimeline(page, "#go"));
    expect(
      action.frames.some((frame) =>
        frame.scrollers.some(
          (scroller) => scroller.selector === "#pane" && scroller.y > 0,
        ),
      ),
    ).toBe(true);
    const movements = elementMovements(action);
    for (const selector of ["#r0", "#r3", "#r19", "#go"])
      expect(movements.map((movement) => movement.selector)).not.toContain(
        selector,
      );
    expect(
      movements.find((movement) => movement.selector === "#tail")?.dy,
    ).toBeCloseTo(50, 0);
  } finally {
    await page.close();
  }
});

test("a CSS transition yields an animation record", async () => {
  const page = await browser.newPage();
  try {
    await page.setContent(`
      <style>#panel{width:200px;height:100px;background:#09f;transition:transform 200ms linear} #panel.open{transform:translateX(100px)}</style>
      <button id="go">Open</button><div id="panel"></div>
      <script>go.onclick = () => panel.classList.add("open");</script>`);
    const action = only(await clickTimeline(page, "#go", 400));
    const record = action.animations.find(
      (animation) => animation.target === "#panel",
    );
    expect(record).toMatchObject({
      kind: "transition",
      durationMs: 200,
      iterations: 1,
    });
    expect(record?.properties).toContain("transform");
    expect(record?.endTime).not.toBeNull();
    expect((record?.endTime ?? 0) - (record?.startTime ?? 0)).toBeGreaterThan(
      100,
    );
  } finally {
    await page.close();
  }
});

test("View Transition usage is detected without replacing the app API", async () => {
  const page = await browser.newPage();
  try {
    await page.setContent(`
      <style>::view-transition-old(root), ::view-transition-new(root) { animation-duration: 200ms; }</style>
      <button id="go">Change</button><p id="copy">Before</p>
      <script>
        window.originalTransition = document.startViewTransition;
        go.onclick = () => document.startViewTransition(() => copy.textContent = "After");
      </script>`);
    const action = only(await clickTimeline(page, "#go", 400));
    expect(action.viewTransition).toEqual({
      used: true,
      kind: "same-document",
    });
    expect(
      await page.evaluate(
        () =>
          document.startViewTransition ===
          Reflect.get(window, "originalTransition"),
      ),
    ).toBe(true);
  } finally {
    await page.close();
  }
});

test("a delayed fetch yields a timed network record without its query", async () => {
  const page = await browser.newPage();
  try {
    await page.route("http://idiom.test/**", async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === "/api/slow") {
        await new Promise((resolve) => setTimeout(resolve, 200));
        return route.fulfill({ status: 200, body: "{}" });
      }
      return route.fulfill({
        status: 200,
        contentType: "text/html",
        body: `<button id="go">Load</button><script>go.onclick = () => fetch("/api/slow?x=1");</script>`,
      });
    });
    await page.goto("http://idiom.test/");
    const action = only(await clickTimeline(page, "#go", 500));
    expect(action.requests).toHaveLength(1);
    const request = action.requests[0];
    expect(request).toMatchObject({
      method: "GET",
      path: "/api/slow",
      resourceType: "fetch",
      status: 200,
      outcome: "ok",
    });
    expect((request?.endTime ?? 0) - (request?.startTime ?? 0)).toBeGreaterThan(
      150,
    );
    expect(action.url).toBe("/");
  } finally {
    await page.close();
  }
});

test("a request blocked by the probe policy is recorded once, as blocked", async () => {
  const page = await browser.newPage();
  try {
    let posts = 0;
    await page.route("http://idiom.test/**", async (route) => {
      if (route.request().method() === "POST") {
        posts += 1;
        return route.fulfill({ status: 204 });
      }
      return route.fulfill({
        status: 200,
        contentType: "text/html",
        body: `<button id="go">Save</button><script>go.onclick = () => fetch("/api/save", { method: "POST" }).catch(() => {});</script>`,
      });
    });
    await page.goto("http://idiom.test/");
    // The probe's read-only policy, layered on top as the probe does.
    await page.route("**/*", (route) =>
      probeRequestAllowed(route.request())
        ? route.fallback()
        : route.abort("blockedbyclient"),
    );
    const action = only(await clickTimeline(page, "#go"));
    expect(action.requests).toEqual([
      expect.objectContaining({
        method: "POST",
        path: "/api/save",
        outcome: "blocked",
      }),
    ]);
    expect(posts).toBe(0);
  } finally {
    await page.close();
  }
});

test("caps truncate visibly, never silently", async () => {
  const page = await browser.newPage();
  try {
    await page.setContent(`
      <button id="go">Many</button><div id="host"></div>
      <script>go.onclick = () => { for (let i = 0; i < 200; i++) { const d = document.createElement("div"); d.textContent = "n" + i; host.appendChild(d); } };</script>`);
    const artifact = await clickTimeline(page, "#go");
    const action = only(artifact);
    expect(action.truncated).toContain("mutations");
    expect(action.mutations.length).toBe(artifact.limits.mutations);
    expect(action.status).toBe("partial");
    expect(action.reason).toMatch(/timeline truncated: .*mutations/);
    expect(artifact.status).toBe("partial");
    for (const frame of action.frames.slice(1))
      expect(frame.elements.length).toBeLessThanOrEqual(
        artifact.limits.changesPerFrame,
      );
  } finally {
    await page.close();
  }
});

test("disposing an interrupted action removes its network listeners", async () => {
  const page = await browser.newPage();
  try {
    await page.setContent('<button id="go">Go</button>');
    const events = [
      "request",
      "requestfinished",
      "requestfailed",
      "framenavigated",
    ] as const;
    const emitter = page as unknown as { listenerCount(event: string): number };
    const before = events.map((event) => emitter.listenerCount(event));
    const collector = new TimelineCollector(page);
    const handle = await collector.start({
      source: "probe-click",
      kind: "click",
      name: "Interrupted",
      selector: "#go",
    });
    expect(events.map((event) => emitter.listenerCount(event))).toEqual(
      before.map((count) => count + 1),
    );
    await handle.dispose();
    await handle.dispose();
    expect(events.map((event) => emitter.listenerCount(event))).toEqual(before);
    expect(await page.evaluate(() => "__idiomTimeline" in window)).toBe(false);
  } finally {
    await page.close();
  }
});

test("a non-HTML load keeps request evidence without recording document geometry", async () => {
  const page = await browser.newPage();
  try {
    await page.route("http://idiom.test/**", (route) =>
      route.fulfill({ contentType: "text/plain", body: "Plain text document" }),
    );
    const collector = new TimelineCollector(page);
    await collector.beginLoad({
      source: "load",
      kind: "navigation",
      name: "/",
    });
    await page.goto("http://idiom.test/");
    await collector.finishLoad("non-html document", false);
    const action = only(collector.evidence());
    expect(action.status).toBe("unavailable");
    expect(action.reason).toContain("non-html document");
    expect(action.frames).toEqual([]);
    expect(action.requests).toEqual([
      expect.objectContaining({ path: "/", status: 200 }),
    ]);
  } finally {
    await page.close();
  }
});

test("painted descendants of an inserted subtree join geometry tracking", async () => {
  const page = await browser.newPage();
  try {
    await page.setContent(`
      <button id="go">Insert</button><main id="host"></main>
      <script>
        go.onclick = () => {
          const section = document.createElement("section");
          section.id = "inserted";
          section.innerHTML = '<div id="child" style="height:20px">Child</div>';
          host.appendChild(section);
          setTimeout(() => child.style.transform = "translateX(60px)", 100);
        };
      </script>`);
    const action = only(await clickTimeline(page, "#go"));
    expect(action.mutations.map((mutation) => mutation.selector)).toEqual([
      "#inserted",
    ]);
    expect(
      elementMovements(action).find(
        (movement) => movement.selector === "#child",
      )?.dx,
    ).toBeCloseTo(60, 0);
  } finally {
    await page.close();
  }
});

test("a load timeline records content popping in after load", async () => {
  const page = await browser.newPage();
  try {
    await page.route("http://idiom.test/**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "text/html",
        body: `<body style="margin:0"><main id="main"><p id="lead" style="margin:0">Lead paragraph</p></main>
          <script>setTimeout(() => { const d = document.createElement("div"); d.id = "late"; d.style.height = "80px"; d.textContent = "Late"; main.insertBefore(d, lead); }, 100);</script></body>`,
      }),
    );
    const collector = new TimelineCollector(page);
    await collector.beginLoad({
      source: "load",
      kind: "navigation",
      name: "/",
    });
    await page.goto("http://idiom.test/?token=secret");
    await page.waitForTimeout(400);
    await collector.finishLoad(undefined, true);
    const artifact = withTimelineIds(collector.evidence());
    if (!artifact) throw new Error("no artifact");
    roundTrip(artifact);
    const action = only(artifact);
    expect(action).toMatchObject({ id: "load", source: "load", url: "/" });
    expect(action.mutations).toEqual([
      expect.objectContaining({ type: "insert", selector: "#late" }),
    ]);
    expect(action.shifts.length).toBeGreaterThan(0);
    expect(action.shifts.every((shift) => !shift.hadRecentInput)).toBe(true);
    expect(
      elementMovements(action).find((movement) => movement.selector === "#lead")
        ?.dy,
    ).toBeCloseTo(80, 0);
    expect(action.requests.some((request) => request.path === "/")).toBe(true);
    // The load recorder is gone: a later navigation records nothing.
    await page.goto("http://idiom.test/again");
    expect(await page.evaluate(() => "__idiomTimeline" in window)).toBe(false);
  } finally {
    await page.close();
  }
});

test("load tracking begins before DOMContentLoaded on a streaming document", async () => {
  let releaseStream: (() => void) | undefined;
  const server = createServer((request, response) => {
    if (request.url === "/release") {
      response.writeHead(204).end();
      releaseStream?.();
      return;
    }
    response.writeHead(200, { "content-type": "text/html" });
    releaseStream = () => {
      response.end(`<script>
        window.changedWhileLoading = document.readyState === "loading";
        const early = document.createElement("div");
        early.id = "early";
        early.style.height = "80px";
        early.textContent = "Streaming insert";
        main.insertBefore(early, lead);
      </script></body>`);
    };
    response.write(
      `<style>body,p{margin:0}</style><body><main id="main"><p id="lead">Lead</p></main>
      <script>requestAnimationFrame(() => requestAnimationFrame(() => fetch("/release")))</script>`,
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("missing server port");
  const page = await browser.newPage();
  try {
    const collector = new TimelineCollector(page);
    await collector.beginLoad({
      source: "load",
      kind: "navigation",
      name: "/",
    });
    await page.goto(`http://127.0.0.1:${address.port}/`);
    await collector.finishLoad(undefined, true);
    const action = only(collector.evidence());
    expect(
      await page.evaluate(() => Reflect.get(window, "changedWhileLoading")),
    ).toBe(true);
    expect(action.mutations).toContainEqual(
      expect.objectContaining({ type: "insert", selector: "#early" }),
    );
    expect(
      elementMovements(action).find((movement) => movement.selector === "#lead")
        ?.dy,
    ).toBeCloseTo(80, 0);
  } finally {
    await page.close();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test("timeline selectors equal observation selectors", async () => {
  const page = await browser.newPage();
  try {
    await page.setContent(`
      <main><section class="card hero"><h1>Title</h1><p>One</p><p>Two</p></section>
      <nav aria-label="Primary"><a href="#a">A</a><a href="#b">B</a></nav>
      <div data-testid="panel"><span class="tag">x</span></div><button id="go">Go</button></main>`);
    const observations = await observePage(page, { status: "not-configured" });
    if (observations.version !== 2) throw new Error("v2 required");
    const observed = new Set(
      observations.elements.map((element) => element.selector),
    );
    const action = only(await clickTimeline(page, "#go", 50));
    const tracked = action.frames[0]?.elements.map((e) => e.selector) ?? [];
    expect(tracked.length).toBeGreaterThan(5);
    const shared = tracked.filter((selector) => observed.has(selector));
    // Every element both sides know about resolves to the same selector.
    for (const selector of shared)
      expect(await page.locator(selector).count()).toBe(1);
    for (const selector of [
      "main > section",
      'nav[aria-label="Primary"]',
      'div[data-testid="panel"]',
      "#go",
    ])
      if (observed.has(selector)) expect(tracked).toContain(selector);
    expect(shared.length).toBeGreaterThan(3);
  } finally {
    await page.close();
  }
});

test("the probe records one timeline per click and recording never changes its results", async () => {
  const html = `<button id="open" aria-controls="menu" onclick="menu.hidden=!menu.hidden">Open menu</button>
    <ul id="menu" hidden><li>One</li><li>Two</li></ul>
    <button id="grow" onclick="const p=document.createElement('p');p.textContent='Added';document.body.insertBefore(p,document.body.firstChild)">Grow</button>
    <button id="noop">Nothing</button>`;
  const probe = async (stub: boolean) => {
    const page = await browser.newPage();
    const restore = vi
      .spyOn(TimelineCollector.prototype, "start")
      .mockImplementation(async () => ({
        key: "test",
        finishVisual: async () => undefined,
        finish: async () => undefined,
        dispose: async () => undefined,
      }));
    if (!stub) restore.mockRestore();
    try {
      await page.setContent(html);
      let timelines: ActionTimelineArtifact | undefined;
      const artifact = await probeControls({
        page,
        restore: async () => {
          await page.setContent(html);
        },
        skip: [],
        maxControls: 10,
        waitMs: 200,
        onTimelines: (recorded) => {
          timelines = recorded;
        },
      });
      return { ...artifact, timelines };
    } finally {
      restore.mockRestore();
      await page.close();
    }
  };
  const recorded = await probe(false);
  const stubbed = await probe(true);
  const summary = (artifact: Awaited<ReturnType<typeof probe>>) =>
    artifact.results.map(({ selector, effects, signature, skipped }) => ({
      selector,
      effects: [...effects].sort(),
      signature,
      skipped,
    }));
  expect(summary(recorded)).toEqual(summary(stubbed));
  expect(stubbed.timelines).toBeUndefined();
  const clicked = recorded.results.filter((result) => !result.skipped);
  expect(clicked.length).toBeGreaterThanOrEqual(3);
  const allActions = withTimelineIds(recorded.timelines)?.actions ?? [];
  expect(allActions.filter((a) => a.source === "probe-hover")).toHaveLength(
    clicked.length,
  );
  const actions = allActions.filter((a) => a.source === "probe-click");
  // One per click; hover and restore navigations are not user actions here.
  expect(actions).toHaveLength(clicked.length);
  expect(actions.every((action) => action.source === "probe-click")).toBe(true);
  expect(actions.map((action) => action.id)).toEqual(
    clicked.map((_, index) => `probe-${index + 1}`),
  );
  const open = actions.find(
    (action) => action.effectRegion.control === "#open",
  );
  expect(open?.effectRegion.controls).toEqual(["#menu"]);
  const grow = actions.find(
    (action) => action.effectRegion.control === "#grow",
  );
  expect(grow?.mutations).toEqual([
    expect.objectContaining({ type: "insert" }),
  ]);
  if (recorded.timelines) roundTrip(recorded.timelines);
});

test("an app scroll re-derives the tracked band so newly visible content is tracked", async () => {
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  try {
    const filler = Array.from(
      { length: 30 },
      (_, index) => `<p style="height:100px;margin:0">F${index}</p>`,
    ).join("");
    await page.setContent(`
      <style>body{margin:0} .banner{height:120px;background:#fc0}</style>
      <button id="go">Jump</button><section id="list">${filler}<p id="target" style="height:90px;margin:0">Target</p><p id="next" style="height:90px;margin:0">Next</p></section>
      <script>
        go.onclick = () => {
          window.scrollTo(0, 2600);
          setTimeout(() => {
            const banner = document.createElement("div");
            banner.className = "banner";
            list.insertBefore(banner, next);
          }, 120);
        };
      </script>`);
    const action = only(await clickTimeline(page, "#go", 500));
    expect(scrollDuring(action).dy).toBeGreaterThan(2000);
    expect(
      action.frames[0]?.elements.some(
        (element) => element.selector === "#next",
      ),
    ).toBe(false);
    const movements = elementMovements(action);
    expect(
      movements.find((movement) => movement.selector === "#next")?.dy,
    ).toBeCloseTo(120, 0);
    expect(movements.map((movement) => movement.selector)).not.toContain(
      "#target",
    );
  } finally {
    await page.close();
  }
});

import { createServer } from "node:http";

describe("visible changes for motion snaps", () => {
  const changesOf = async (
    html: string,
    selector: string,
    options: { reducedMotion?: "reduce" | "no-preference" } = {},
  ) => {
    const page = await browser.newPage();
    try {
      if (options.reducedMotion)
        await page.emulateMedia({ reducedMotion: options.reducedMotion });
      await page.setContent(html);
      return only(await clickTimeline(page, selector));
    } finally {
      await page.close();
    }
  };
  const kinds = (action: {
    visibleChanges?: Array<{ key: string }> | undefined;
  }) => [...new Set(action.visibleChanges?.map((change) => change.key))];
  test("a hidden tab panel shown is a content swap in its slot", async () => {
    const action = await changesOf(
      `<div role="tablist"><button role="tab" id="t1" aria-controls="p1">A</button><button role="tab" id="t2" aria-controls="p2">B</button></div>
      <div id="slot"><div role="tabpanel" id="p1" style="height:200px">One</div><div role="tabpanel" id="p2" hidden style="height:200px">Two</div></div>
      <script>t2.onclick=()=>{p1.hidden=true;p2.hidden=false}</script>`,
      "#t2",
    );
    expect(action.fromUrl).toBe(action.url);
    expect(action.reducedMotion).toBe(false);
    expect(action.visibleChanges).toEqual([
      expect.objectContaining({
        selector: "#p2",
        kind: "content-swap",
        container: "#slot",
        direction: "in",
        extent: 200,
        textOnly: false,
      }),
      expect.objectContaining({ selector: "#p1", direction: "out" }),
    ]);
  });
  test("list inserts, status messages and pushState routes are classified", async () => {
    const list = await changesOf(
      `<button id="add">Add</button><ul id="l"><li>a</li><li>b</li></ul>
      <script>add.onclick=()=>{const li=document.createElement('li');li.textContent='c';li.style.height='40px';l.append(li)}</script>`,
      "#add",
    );
    expect(kinds(list)).toEqual(["list-item|#l"]);
    const toast = await changesOf(
      `<button id="go">Save</button><div id="host"></div>
      <script>go.onclick=()=>{const d=document.createElement('div');d.setAttribute('role','status');d.textContent='Saved';d.style.cssText='height:56px;width:300px';host.append(d)}</script>`,
      "#go",
    );
    expect(kinds(toast)).toEqual(["status|#host"]);
    const page = await browser.newPage();
    try {
      await page.route("http://idiom.test/**", (route) =>
        route.fulfill({
          contentType: "text/html",
          body: `<nav><button id="go">Reports</button></nav><main><section style="height:300px"><p>Home</p></section></main>
          <script>go.onclick=()=>{history.pushState({},'','/reports');document.querySelector('main').innerHTML='<section style="height:320px"><p>Reports</p></section><p>More</p>'}</script>`,
        }),
      );
      await page.goto("http://idiom.test/home");
      const route = only(await clickTimeline(page, "#go"));
      expect(route.fromUrl).toBe("/home");
      expect(route.visibleChanges).toEqual([
        expect.objectContaining({
          kind: "route",
          container: "body > main",
          extent: 320,
        }),
      ]);
    } finally {
      await page.close();
    }
  });
  test("overlays, the trigger and text-only changes stay out", async () => {
    const dialog = await changesOf(
      `<button id="go">Open</button><dialog id="d"><p style="height:100px">Hi</p></dialog><script>go.onclick=()=>d.showModal()</script>`,
      "#go",
    );
    expect(dialog.visibleChanges).toEqual([]);
    const details = await changesOf(
      `<details><summary id="s">More</summary><p style="height:100px">Body</p></details>`,
      "#s",
    );
    expect(details.visibleChanges).toEqual([]);
    const counter = await changesOf(
      `<button id="go">+1</button> <span id="n" style="font-size:40px">9</span><script>go.onclick=()=>{n.textContent='10'}</script>`,
      "#go",
    );
    expect(counter.visibleChanges?.every((change) => change.textOnly)).toBe(
      true,
    );
  });
  test("text filled into an existing unpainted leaf is text-only; a painted or inserted box is not", async () => {
    // An empty flex item has no width until its text arrives.
    const status = `<form id="f" style="display:flex;gap:16px"><button id="go" type="button">Save profile</button><p id="s" aria-live="polite" style="min-height:24px;margin:0;color:#1d6b3a"></p></form>`;
    const filled = await changesOf(
      `${status}<script>go.onclick=()=>{s.textContent='Profile saved.';s.className='ok'}</script>`,
      "#go",
    );
    expect(filled.visibleChanges?.length).toBeGreaterThan(0);
    expect(filled.visibleChanges?.every((change) => change.textOnly)).toBe(
      true,
    );
    const toast = await changesOf(
      `<div style="display:flex"><button id="go">Save</button><div id="t" role="status" style="min-height:48px;background:#1c2430;color:white"></div></div>
      <script>go.onclick=()=>{t.textContent='Saved'}</script>`,
      "#go",
    );
    expect(toast.visibleChanges).toEqual([
      expect.objectContaining({ kind: "status", textOnly: false }),
    ]);
    const inserted = await changesOf(
      `<button id="go">Save</button><div id="host"></div>
      <script>go.onclick=()=>{const p=document.createElement('p');p.setAttribute('role','status');p.style.cssText='height:48px;margin:0';p.textContent='Saved';host.append(p)}</script>`,
      "#go",
    );
    expect(inserted.visibleChanges).toEqual([
      expect.objectContaining({ kind: "status", textOnly: false }),
    ]);
  });
  test("floating layers, swapped controls, offscreen and earlier entrances are not the action's changes", async () => {
    const dropdown = await changesOf(
      `<div style="position:relative"><button id="go">Theme</button><ul id="m" hidden style="position:absolute;top:40px;height:120px;width:160px"><li>Light</li><li>Dark</li></ul></div>
      <script>go.onclick=()=>{m.hidden=false}</script>`,
      "#go",
    );
    expect(dropdown.visibleChanges).toEqual([]);
    const control = await changesOf(
      `<div id="bar"><button id="go">Run</button><a id="dl" href="#x" style="display:inline-block;height:30px;width:60px">Download</a></div>
      <script>go.onclick=()=>{const b=document.createElement('button');b.style.cssText='height:30px;width:60px';b.textContent='Save';dl.replaceWith(b)}</script>`,
      "#go",
    );
    expect(control.visibleChanges).toEqual([]);
    const offscreen = await changesOf(
      `<div style="height:700px">Top</div><button id="go" style="position:fixed;top:0">Add</button><ul id="l"><li>a</li></ul>
      <script>go.onclick=()=>{const li=document.createElement('li');li.style.height='60px';li.textContent='b';l.append(li)}</script>`,
      "#go",
    );
    expect(offscreen.visibleChanges).toEqual([]);
    const entrance = await changesOf(
      `<style>@keyframes in{0%,60%{opacity:0}to{opacity:1}} .row{height:60px;animation:in 1200ms}</style>
      <button id="go">Noop</button><div class="row" id="r">Row</div>`,
      "#go",
    );
    expect(entrance.visibleChanges).toEqual([]);
  });
  test("a persistent region resizing in place is an expand-collapse", async () => {
    const action = await changesOf(
      `<style>.c{height:40px;overflow:hidden}.c.open{height:100px}</style>
      <div role="region" aria-label="Bio"><p class="c" id="p">Lorem ipsum</p><button id="go">more</button></div>
      <script>go.onclick=()=>p.classList.add('open')</script>`,
      "#go",
    );
    expect(action.visibleChanges).toEqual([
      expect.objectContaining({
        selector: "#p",
        kind: "expand-collapse",
        direction: "resize",
        extent: 60,
        textOnly: false,
      }),
    ]);
  });
  test("an ancestor transition is recorded against the change", async () => {
    const action = await changesOf(
      `<style>#wrap{transition:opacity 200ms} #wrap.on{opacity:.99}</style>
      <button id="go">Show</button><div id="wrap"><div id="sec" hidden style="height:160px">More</div></div>
      <script>go.onclick=()=>{wrap.classList.add('on');sec.hidden=false}</script>`,
      "#go",
    );
    const change = action.visibleChanges?.[0];
    expect(change?.animations.length).toBeGreaterThan(0);
    expect(action.animations[change?.animations[0] ?? -1]?.target).toBe(
      "#wrap",
    );
  });
  test("the preference is recorded, and load windows have no changes", async () => {
    const reduced = await changesOf(`<button id="go">Go</button>`, "#go", {
      reducedMotion: "reduce",
    });
    expect(reduced.reducedMotion).toBe(true);
    const page = await browser.newPage();
    try {
      const collector = new TimelineCollector(page);
      await collector.beginLoad({
        source: "load",
        kind: "navigation",
        name: "/",
      });
      await page.setContent("<p>Loaded</p>");
      await collector.finishLoad(undefined, true);
      expect(collector.evidence().actions[0]?.visibleChanges).toBeUndefined();
    } finally {
      await page.close();
    }
  });
  test("the visible-change cap marks the window truncated", async () => {
    const action = await changesOf(
      `<button id="go">Add</button><div id="host"><p>Rows</p></div>
      <script>go.onclick=()=>{for(let i=0;i<60;i++){const s=document.createElement('section');s.style.height='10px';host.append(s)}}</script>`,
      "#go",
    );
    expect(action.visibleChanges).toHaveLength(40);
    expect(action.truncated).toContain("visibleChanges");
  });
});

describe("normal-motion snap confirmation in the probe", () => {
  const tabs = (count: number, css = "") => `<style>${css}</style>
    <div role="tablist">${Array.from({ length: count }, (_, i) => `<button role="tab" id="t${i}" aria-controls="p${i}">Tab ${i}</button>`).join("")}</div>
    ${Array.from({ length: count }, (_, i) => `<div id="slot${i}"><h2>Slot ${i}</h2><div role="tabpanel" id="p${i}" hidden style="height:120px">Panel ${i}</div></div>`).join("")}
    <script>for (const tab of document.querySelectorAll('[role=tab]')) tab.onclick = () => { const panel = document.getElementById(tab.getAttribute('aria-controls')); panel.hidden = !panel.hidden; };</script>`;
  const probe = async (html: string) => {
    const context = await browser.newContext({ reducedMotion: "reduce" });
    const page = await context.newPage();
    try {
      await page.setContent(html);
      let timelines: ActionTimelineArtifact | undefined;
      const artifact = await probeControls({
        page,
        restore: async () => {
          await page.setContent(html);
        },
        skip: [],
        maxControls: 20,
        waitMs: 150,
        reducedMotion: true,
        onTimelines: (recorded) => {
          timelines = recorded;
        },
      });
      const reduced = await page.evaluate(
        () => matchMedia("(prefers-reduced-motion: reduce)").matches,
      );
      return {
        artifact,
        actions: withTimelineIds(timelines)?.actions ?? [],
        reduced,
      };
    } finally {
      await context.close();
    }
  };
  test("one replay per snapping group, emulation restored, motion untouched", async () => {
    // Every tab toggles its own slot: eight groups, capped at six replays.
    const { artifact, actions, reduced } = await probe(tabs(8));
    expect(reduced).toBe(true);
    const confirmations = actions.filter((action) => action.confirmation);
    expect(confirmations).toHaveLength(6);
    for (const confirmation of confirmations)
      expect(confirmation.reducedMotion).toBe(false);
    expect(new Set(confirmations.map((action) => action.selector)).size).toBe(
      6,
    );
    expect(
      artifact.motion?.actions.filter(
        (action) => action.source === "probe-click",
      ),
    ).toHaveLength(8);
    // Clicks after a replay ran under reduce again.
    expect(
      actions
        .filter((action) => !action.confirmation)
        .every((action) => action.reducedMotion === true),
    ).toBe(true);
  }, 60_000);
  test("a reduce-honouring transition clears its group", async () => {
    const { actions } = await probe(
      tabs(
        1,
        "@media (prefers-reduced-motion: no-preference) { [role=tabpanel] { animation: f 200ms } } @keyframes f { from { opacity: 0 } }",
      ),
    );
    const confirmation = actions.find((action) => action.confirmation);
    expect(confirmation?.animations.length).toBeGreaterThan(0);
  }, 60_000);
});

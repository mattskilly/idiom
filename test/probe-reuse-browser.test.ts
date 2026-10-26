import { createServer, type Server } from "node:http";
import { type Browser, chromium, type Page } from "playwright";
import { afterAll, beforeAll, expect, test } from "vitest";
import { probeControls } from "../src/capture/probe.js";
import { createProbeLedger } from "../src/capture/probe-ledger.js";
import type { ProbeArtifact } from "../src/checks/types.js";

let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch();
});
afterAll(async () => {
  await browser.close();
});

const find = (artifact: ProbeArtifact, selector: string) =>
  artifact.results.find((result) => result.selector === selector);

/** A page whose clicks are recorded host-side, with a counted replay. */
async function harness(html: string) {
  const context = await browser.newContext();
  const clicks: string[] = [];
  const notes: unknown[] = [];
  await context.exposeFunction("recordClick", (id: string) => clicks.push(id));
  await context.exposeFunction("note", (value: unknown) => notes.push(value));
  const page = await context.newPage();
  await page.setContent(html);
  let replays = 0;
  const restore = async (active: Page) => {
    replays += 1;
    await active.setContent(html);
  };
  return {
    page,
    clicks,
    notes,
    restore,
    replays: () => replays,
    close: () => context.close(),
  };
}

const probe = (
  page: Page,
  restore: (page: Page) => Promise<void>,
  extra: Partial<Parameters<typeof probeControls>[0]> = {},
) =>
  probeControls({
    page,
    restore,
    skip: [],
    maxControls: 20,
    waitMs: 100,
    controlTimeoutMs: 3000,
    stateTimeoutMs: 20000,
    ...extra,
  });

test("a control shared across states is probed once and reused, after the state's own controls", async () => {
  const chrome =
    '<header><div role="toolbar" aria-label="Editor"><button id="tool" onclick="window.recordClick(\'tool\')">Tool</button></div></header>';
  const ledger = createProbeLedger();
  const first = await harness(
    `${chrome}<main><button id="alpha" onclick="window.recordClick('alpha')">Alpha</button></main>`,
  );
  const second = await harness(
    `${chrome}<main><button id="beta" onclick="window.recordClick('beta')">Beta</button></main>`,
  );
  try {
    const a = await probe(first.page, first.restore, {
      ledger,
      stateId: "a",
      ledgerPartition: "desktop\0light",
    });
    const b = await probe(second.page, second.restore, {
      ledger,
      stateId: "b",
      ledgerPartition: "desktop\0light",
    });
    // State-specific controls run before shared chrome.
    expect(first.clicks).toEqual(["alpha", "tool"]);
    expect(second.clicks).toEqual(["beta"]);
    expect(find(a, "#tool")).toMatchObject({ status: "completed" });
    expect(find(a, "#tool")?.reusedFrom).toBeUndefined();
    expect(find(b, "#tool")).toMatchObject({
      status: "completed",
      reusedFrom: "a",
      region: 'toolbar "Editor"',
    });
    expect(find(b, "#tool")?.elapsedMs).toBeUndefined();
    // Published in DOM order whatever order they ran in.
    expect(a.results.map((result) => result.selector)).toEqual([
      "#tool",
      "#alpha",
    ]);
    // Without a ledger the same page is probed in DOM order, as before.
    const plain = await harness(
      `${chrome}<main><button id="alpha" onclick="window.recordClick('alpha')">Alpha</button></main>`,
    );
    try {
      await probe(plain.page, plain.restore);
      expect(plain.clicks).toEqual(["tool", "alpha"]);
    } finally {
      await plain.close();
    }
  } finally {
    await first.close();
    await second.close();
  }
}, 30_000);

test.each([
  {
    name: "no-op and self-reverting controls",
    html: `<button id="one">One</button><button id="two" onclick="this.classList.add('ripple');setTimeout(()=>this.classList.remove('ripple'),180)">Ripple</button><button id="hot" onmouseenter="this.classList.add('hot')" onmouseleave="this.classList.remove('hot')">Hot</button>`,
    replays: 0,
  },
  {
    name: "a dialog Escape closes",
    html: `<button id="open" onclick="document.getElementById('dialog').showModal()">Open</button><dialog id="dialog" aria-label="Details"><p>Details</p></dialog><button id="after">After</button>`,
    replays: 0,
  },
  {
    name: "a persistent text rewrite",
    html: `<button id="rename" onclick="document.getElementById('title').textContent='Renamed'">Rename</button><h1 id="title">Draft</h1><button id="after">After</button>`,
    replays: 1,
  },
])(
  "restore ladder replays only when needed: $name",
  async (scenario) => {
    const fixture = await harness(scenario.html);
    try {
      const result = await probe(fixture.page, fixture.restore);
      expect(result.status, result.reason).toBe("ran");
      expect(
        result.results.every((control) => control.status === "completed"),
      ).toBe(true);
      expect(fixture.replays()).toBe(scenario.replays);
    } finally {
      await fixture.close();
    }
  },
  30_000,
);

test("a class-only panel toggle costs exactly one replay and never leaks into the next control", async () => {
  const fixture = await harness(
    `<style>.panel{display:none}.panel.is-open{display:block}</style><button id="toggle" onclick="document.querySelector('.panel').classList.add('is-open')">Panel</button><div class="panel"><p>Panel content</p></div><button id="next" onclick="window.note(document.querySelector('.panel').classList.contains('is-open'))">Next</button>`,
  );
  try {
    const result = await probe(fixture.page, fixture.restore);
    expect(result.status, result.reason).toBe("ran");
    expect(fixture.replays()).toBe(1);
    expect(fixture.notes).toEqual([false]);
  } finally {
    await fixture.close();
  }
}, 30_000);

test("the ladder's close control and Escape never send mutating requests; full replays still may", async () => {
  const posts: string[] = [];
  const server: Server = createServer((request, response) => {
    if (request.method === "POST") posts.push(request.url ?? "");
    response.setHeader("content-type", "text/html");
    response.end(
      `<button id="open" onclick="document.getElementById('panel').hidden=false">Open settings</button>
      <div id="panel" role="dialog" aria-label="Settings" hidden><p>Settings</p>
        <button id="close" onclick="document.getElementById('panel').hidden=true;fetch('/close',{method:'POST'})">Close</button></div>
      <button id="rename" onclick="document.getElementById('title').textContent='Renamed'">Rename</button><h1 id="title">Draft</h1>`,
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("no port");
  const url = `http://127.0.0.1:${address.port}/`;
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.goto(url);
    let replays = 0;
    const result = await probe(page, async (active) => {
      replays += 1;
      await active.goto(url);
      // Declared state steps may mutate, as before.
      await active.evaluate(() => fetch("/replay", { method: "POST" }));
    });
    expect(result.status, result.reason).toBe("ran");
    expect(find(result, "#open")?.signature).toBe("open:dialog:Settings");
    // The close control restored the state: only the rename needed a replay.
    expect(replays).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(posts).toEqual(["/replay"]);
  } finally {
    await context.close();
    await new Promise((resolve) => server.close(resolve));
  }
}, 30_000);

test("nested menu items share a budget; later top-level controls still run", async () => {
  const items = Array.from(
    { length: 20 },
    (_, index) =>
      `<button role="menuitem" id="item-${index}">Item ${index}</button>`,
  ).join("");
  const fixture = await harness(
    `<button id="menu" onclick="document.getElementById('items').hidden=false">Tools</button><div id="items" role="menu" aria-label="Tools" hidden>${items}</div><button id="last" onclick="this.textContent='worked'">Last</button>`,
  );
  try {
    const result = await probe(fixture.page, fixture.restore, {
      waitMs: 150,
      stateTimeoutMs: 20000,
    });
    const nested = result.results.filter((control) =>
      control.name.startsWith("Tools › "),
    );
    expect(nested).toHaveLength(20);
    const cut = nested.filter((control) => control.status === "not-reached");
    expect(cut.length).toBeGreaterThan(0);
    expect(
      cut.every(
        (control) => control.skipped === "not reached: nested-menu budget",
      ),
    ).toBe(true);
    expect(find(result, "#last")).toMatchObject({
      status: "completed",
      effects: expect.arrayContaining(["dom"]),
    });
  } finally {
    await fixture.close();
  }
}, 30_000);

test("maxControls overflow and state expiry report one not-reached row per unprobed control", async () => {
  const buttons = Array.from(
    { length: 5 },
    (_, index) => `<button id="b${index}">Button ${index}</button>`,
  ).join("");
  const capped = await harness(buttons);
  try {
    const result = await probe(capped.page, capped.restore, { maxControls: 2 });
    expect(result.reason).toContain("probed 2 of 5 controls");
    expect(result.results.map((control) => control.status)).toEqual([
      "completed",
      "completed",
      "not-reached",
      "not-reached",
      "not-reached",
    ]);
    expect(
      result.results
        .slice(2)
        .every(
          (control) =>
            control.skipped === "not reached: checks.probe.maxControls" &&
            control.elapsedMs === undefined,
        ),
    ).toBe(true);
  } finally {
    await capped.close();
  }
  const slow = await harness(buttons);
  try {
    const result = await probe(slow.page, slow.restore, {
      waitMs: 600,
      stateTimeoutMs: 1500,
    });
    expect(result.status).toBe("timed-out");
    const reached = result.results.filter(
      (control) => control.status !== "not-reached",
    );
    const unreached = result.results.filter(
      (control) => control.status === "not-reached",
    );
    expect(reached.length + unreached.length).toBe(5);
    expect(unreached.length).toBeGreaterThan(0);
    expect(
      unreached.every(
        (control) => control.skipped === "not reached: state budget",
      ),
    ).toBe(true);
  } finally {
    await slow.close();
  }
}, 30_000);

test("an entry point reused from shared chrome still counts toward the view's duplicate entries", async () => {
  const { observePage } = await import("../src/checks/observe.js");
  const { duplicateEntryCheck } = await import(
    "../src/checks/duplicate-entry.js"
  );
  const dialog =
    '<div id="settings" role="dialog" aria-label="Page settings" hidden><p>Page settings</p></div>';
  const open = "document.getElementById('settings').hidden=false";
  const chrome = `<header><button id="gear" aria-label="Page settings" onclick="${open}">⚙</button></header>`;
  const ledger = createProbeLedger();
  const a = await harness(`${chrome}<main><p>Start</p></main>${dialog}`);
  const b = await harness(
    `${chrome}<main><button id="inline" onclick="${open}">Page settings</button></main><aside aria-label="Inspector"><button id="side" onclick="${open}">Page settings</button></aside>${dialog}`,
  );
  try {
    await probe(a.page, a.restore, {
      ledger,
      stateId: "a",
      ledgerPartition: "desktop\0light",
    });
    const artifact = await probe(b.page, b.restore, {
      ledger,
      stateId: "b",
      ledgerPartition: "desktop\0light",
    });
    expect(b.clicks).toEqual([]);
    expect(find(artifact, "#gear")?.reusedFrom).toBe("a");
    const observations = await observePage(b.page, {
      status: "not-configured",
    });
    if (observations.version !== 2) throw new Error("missing V2 evidence");
    observations.probe = artifact;
    const candidates = duplicateEntryCheck.run({
      tuple: { observations },
    } as Parameters<typeof duplicateEntryCheck.run>[0]).candidates;
    expect(candidates).toHaveLength(1);
    for (const selector of ["#gear", "#inline", "#side"])
      expect(JSON.stringify(candidates[0])).toContain(selector);
  } finally {
    await a.close();
    await b.close();
  }
}, 30_000);

test("completed intent skips are reused instead of spending the next state's budget", async () => {
  const ledger = createProbeLedger();
  for (const stateId of ["a", "b"]) {
    const fixture = await harness(
      '<button id="selected" aria-pressed="true">Selected</button>',
    );
    try {
      const result = await probe(fixture.page, fixture.restore, {
        ledger,
        stateId,
        respectControlIntent: true,
      });
      expect(find(result, "#selected")).toMatchObject({
        status: "completed",
        skipped: "already selected: aria-pressed",
        ...(stateId === "b" ? { reusedFrom: "a" } : {}),
      });
      expect(fixture.replays()).toBe(0);
    } finally {
      await fixture.close();
    }
  }
});

test("controls behind a modal are reported without spending the control budget", async () => {
  const fixture = await harness(
    '<button id="behind">Behind</button><dialog id="modal"><button id="inside">Inside</button></dialog><script>document.querySelector("dialog").showModal()</script>',
  );
  try {
    const result = await probe(fixture.page, fixture.restore, {
      ledger: createProbeLedger(),
      stateId: "modal",
      maxControls: 1,
    });
    expect(find(result, "#behind")).toMatchObject({
      status: "not-reached",
      skipped: "not reached: blocked by modal",
    });
    expect(find(result, "#inside")).toMatchObject({ status: "completed" });
    expect(fixture.replays()).toBe(0);
  } finally {
    await fixture.close();
  }
});

test("newly revealed panels and their tabs expose nested controls under the same budget", async () => {
  const fixture =
    await harness(`<button id="open" onclick="document.querySelector('aside').hidden=false">History</button>
    <aside hidden aria-label="History"><button id="versions" onclick="document.querySelector('[role=tabpanel]').hidden=false">Versions</button>
    <div role="tabpanel" aria-label="Versions" hidden><button id="name">Name this version</button></div></aside>`);
  try {
    const result = await probe(fixture.page, fixture.restore);
    expect(
      result.results.find(
        (control) => control.name === "History › Versions › Name this version",
      ),
    ).toMatchObject({
      status: "completed",
      effects: [],
      primary: false,
      persistent: false,
    });
  } finally {
    await fixture.close();
  }
}, 30_000);

test("two menus share the state's nested budget", async () => {
  const menu = (name: string) =>
    `<button id="${name}" onclick="document.getElementById('${name}-items').hidden=false">${name}</button><div id="${name}-items" role="menu" aria-label="${name}" hidden>${Array.from({ length: 20 }, (_, i) => `<button role="menuitem">${name} ${i}</button>`).join("")}</div>`;
  const fixture = await harness(
    `${menu("First")}${menu("Second")}<button id="last">Last</button>`,
  );
  try {
    const result = await probe(fixture.page, fixture.restore, {
      waitMs: 150,
      stateTimeoutMs: 10000,
    });
    const second = result.results.filter((control) =>
      control.name.startsWith("Second › "),
    );
    expect(second).toHaveLength(20);
    expect(
      second.every(
        (control) =>
          control.status === "not-reached" &&
          control.skipped === "not reached: nested-menu budget",
      ),
    ).toBe(true);
    expect(find(result, "#last")?.status).toBe("completed");
  } finally {
    await fixture.close();
  }
}, 30_000);

test("accessible names survive framework id changes and reused selectors and explanations stay local", async () => {
  const ledger = createProbeLedger();
  const first = await harness(
    '<span id="label-a">Help</span><button id=":r123:" aria-labelledby="label-a" class="tool" onclick="window.recordClick(\'help\')">?</button>',
  );
  const second = await harness(
    '<p>Moved</p><span id="label-b">Help</span><button id="_r_456_" aria-labelledby="label-b" class="tool" onclick="window.recordClick(\'help\')">?</button>',
  );
  try {
    await probe(first.page, first.restore, { ledger, stateId: "a" });
    const result = await probe(second.page, second.restore, {
      ledger,
      stateId: "b",
    });
    expect(first.clicks).toEqual(["help"]);
    expect(second.clicks).toEqual([]);
    expect(result.results).toEqual([
      expect.objectContaining({
        selector: "#_r_456_",
        name: "Help",
        reusedFrom: "a",
      }),
    ]);
    expect(result.explanations?.records).toHaveLength(2);
    for (const record of result.explanations?.records ?? []) {
      expect(record.controlId).toBeTruthy();
      expect(
        await second.page
          .locator(record.selector)
          .evaluate((element) => element.id),
      ).toBe("_r_456_");
    }
  } finally {
    await first.close();
    await second.close();
  }
});

test.each(["visibility", "opacity"])(
  "an inline %s reveal cannot leak into the next control",
  async (property) => {
    const initial = property === "visibility" ? "hidden" : "0";
    const opened = property === "visibility" ? "visible" : "1";
    const fixture = await harness(
      `<button id="reveal" onclick="document.getElementById('panel').style.${property}='${opened}'">Reveal</button><div id="panel" style="${property}:${initial}">Panel</div><button id="next" onclick="window.note(document.getElementById('panel').style.${property})">Next</button>`,
    );
    try {
      const result = await probe(fixture.page, fixture.restore);
      expect(find(result, "#next")?.status).toBe("completed");
      expect(fixture.replays()).toBe(1);
      expect(fixture.notes).toEqual([initial]);
    } finally {
      await fixture.close();
    }
  },
  30_000,
);

test("planned sampling preserves navigation actions and separates repeated rows by region", async () => {
  // Ordinary rows are sampled; the probe's own check candidates never are.
  const rows = (prefix: string) =>
    Array.from(
      { length: 5 },
      (_, index) =>
        `<li><button class="row" role="switch" aria-checked="false">${prefix} ${index}</button></li><li><button class="action">Open ${prefix} ${index}</button></li>`,
    ).join("");
  const fixture = await harness(
    `<!doctype html><nav>${["Add", "Layers", "Page settings", "History", "Help"].map((name) => `<button>${name}</button>`).join("")}</nav><section aria-label="First"><ul>${rows("First")}</ul></section><section aria-label="Second"><ul>${rows("Second")}</ul></section>`,
  );
  try {
    const enumeration = await probe(fixture.page, fixture.restore, {
      enumerateOnly: true,
    });
    const candidates = enumeration.candidates ?? [];
    expect(
      candidates
        .filter((candidate) => candidate.region === "navigation")
        .every((candidate) => !candidate.repeatedGroup),
    ).toBe(true);
    const ledger = createProbeLedger();
    ledger.plan("p", [{ state: "a", candidates }]);
    // Five navigation actions, two switch rows in each region, and all ten
    // text actions in repeated rows.
    expect(ledger.assignedCount("p", "a")).toBe(19);
  } finally {
    await fixture.close();
  }
});

test("planned menus probe text actions and revealed own controls before repeated options", async () => {
  const fixture = await harness(`<!doctype html>
    <button id="menu" onclick="document.querySelector('#choices').hidden=false">Shared menu</button>
    <div id="choices" role="menu" aria-label="Actions" hidden>
      ${[1, 2, 3].map((index) => `<button role="menuitemradio" onclick="recordClick('option ${index}')">Option ${index}</button>`).join("")}
      <button role="menuitem" id="versions" onclick="recordClick('versions');document.querySelector('#choices').hidden=true;document.querySelector('#panel').hidden=false">Versions</button>
    </div>
    <div role="region" aria-label="Versions" id="panel" hidden><button id="name" onclick="recordClick('name')">Name this version</button></div>
    <script>document.addEventListener('keydown',e=>{if(e.key==='Escape'){document.querySelector('#choices').hidden=true;document.querySelector('#panel').hidden=true}})</script>`);
  try {
    const enumeration = await probe(fixture.page, fixture.restore, {
      enumerateOnly: true,
    });
    const ledger = createProbeLedger();
    ledger.plan("p", [
      { state: "a", candidates: enumeration.candidates ?? [] },
    ]);
    const artifact = await probe(fixture.page, fixture.restore, {
      ledger,
      ledgerPartition: "p",
      stateId: "a",
    });
    expect(fixture.clicks[0]).toBe("versions");
    expect(fixture.clicks.indexOf("name")).toBeLessThan(
      fixture.clicks.indexOf("option 1"),
    );
    expect(
      artifact.results.find((result) =>
        result.name.endsWith(" › Name this version"),
      ),
    ).toMatchObject({ status: "completed", primary: false });
    expect(
      artifact.results.find((result) => result.name.endsWith(" › Option 3")),
    ).toMatchObject({
      status: "not-reached",
      skipped: "not reached: repeated-row sample",
    });
  } finally {
    await fixture.close();
  }
});

test("planned parallel contexts sample a shared glyph before ordinary own work and join saved identities", async () => {
  const ledger = createProbeLedger();
  const fixtures = await Promise.all(
    ["a", "b"].map((id) =>
      harness(`<!doctype html>
    <header><details><summary aria-label="Layers keyboard help" title="Layers keyboard help" class="help">?</summary><button id="hidden-${id}">Hidden action</button></details></header>
    <main><button id="own-${id}" role="tab">Ordinary own control</button></main>`),
    ),
  );
  try {
    const enumerations = await Promise.all(
      fixtures.map((fixture) =>
        probe(fixture.page, fixture.restore, { enumerateOnly: true }),
      ),
    );
    expect(
      enumerations.every(
        (entry) =>
          !entry.candidates?.some((item) => item.name === "Hidden action"),
      ),
    ).toBe(true);
    ledger.plan(
      "p",
      enumerations.map((entry, index) => ({
        state: ["a", "b"][index]!,
        candidates: entry.candidates ?? [],
      })),
    );
    const artifacts = await Promise.all(
      fixtures.map((fixture, index) =>
        probe(fixture.page, fixture.restore, {
          ledger,
          ledgerPartition: "p",
          stateId: ["a", "b"][index],
          maxControls: 1,
        }),
      ),
    );
    const records = artifacts
      .flatMap((entry) => entry.explanations?.records ?? [])
      .filter((record) => record.selector.includes("summary"));
    expect(
      records
        .filter((record) => record.status === "absent")
        .map((record) => record.trigger)
        .sort(),
    ).toEqual(["focus", "hover"]);
    expect(
      records
        .filter((record) => record.status === "absent")
        .every((record) => record.controlId),
    ).toBe(true);
  } finally {
    await Promise.all(fixtures.map((fixture) => fixture.close()));
  }
}, 30000);

test("planned nested check candidates are bounded by the state deadline, not the nested budget", async () => {
  // Ordinary switches exhaust the nested budget; the text action and the
  // duplicate-named entry revealed by the second menu still run.
  const menu = (name: string, extra = "") =>
    `<button id="${name}" onclick="document.getElementById('${name}-items').hidden=false">${name}</button><div id="${name}-items" role="menu" aria-label="${name}" hidden>${Array.from({ length: 6 }, (_, i) => `<button role="menuitemcheckbox" aria-checked="false">${name} ${i}</button>`).join("")}${extra}</div>`;
  const html = `<nav><button id="settings" aria-label="Settings" onclick="window.recordClick('nav')">S</button></nav>${menu("First")}${menu("Third")}${menu("Fourth")}${menu("Second", '<button role="menuitem" onclick="window.recordClick(\'entry\')">Settings</button><button role="menuitem" onclick="window.recordClick(\'name\')">Name this version</button>')}`;
  const ledger = createProbeLedger();
  const fixture = await harness(html);
  try {
    const enumeration = await probe(fixture.page, fixture.restore, {
      enumerateOnly: true,
    });
    ledger.plan("p", [
      { state: "a", candidates: enumeration.candidates ?? [] },
    ]);
    const result = await probe(fixture.page, fixture.restore, {
      ledger,
      ledgerPartition: "p",
      stateId: "a",
      waitMs: 150,
      stateTimeoutMs: 20000,
    });
    const nested = (name: string) =>
      result.results.find((control) => control.name === name);
    expect(
      result.results.some(
        (control) => control.skipped === "not reached: nested-menu budget",
      ),
    ).toBe(true);
    expect(nested("Second › Settings")?.status).toBe("completed");
    expect(nested("Second › Name this version")?.status).toBe("completed");
  } finally {
    await fixture.close();
  }
}, 30_000);

test("planned nested actions wait for equally ranked top-level controls", async () => {
  const fixture = await harness(`<!doctype html>
    <button id="menu" onclick="document.querySelector('#items').hidden=false">Actions</button>
    <div id="items" role="menu" hidden>
      <button role="menuitem" id="nested" onclick="recordClick('nested')">Nested action</button>
    </div>
    <button id="own" onclick="recordClick('own')">Own action</button>
    <script>document.addEventListener('keydown', e => {if(e.key === 'Escape') document.querySelector('#items').hidden=true})</script>`);
  try {
    const enumeration = await probe(fixture.page, fixture.restore, {
      enumerateOnly: true,
    });
    const ledger = createProbeLedger();
    ledger.plan("p", [
      { state: "a", candidates: enumeration.candidates ?? [] },
    ]);
    const artifact = await probe(fixture.page, fixture.restore, {
      ledger,
      ledgerPartition: "p",
      stateId: "a",
    });
    expect(fixture.clicks).toEqual(["own", "nested"]);
    expect(find(artifact, "#own")?.status).toBe("completed");
    expect(find(artifact, "#nested")?.status).toBe("completed");
    // Nested work is still published with its revealing control, in DOM order.
    expect(artifact.results.map((row) => row.name)).toEqual([
      "Actions",
      "Actions › Nested action",
      "Own action",
    ]);
  } finally {
    await fixture.close();
  }
});

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import type { ObservationArtifact } from "../src/checks/types.js";
import { runQuick } from "../src/quick/run.js";

type Logged = { method: string; url: string };

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function serve(
  handler: (
    url: string,
    respond: (body: string, type?: string) => void,
  ) => unknown,
): Promise<{ origin: string; log: Logged[] }> {
  const log: Logged[] = [];
  const server: Server = createServer((request, response) => {
    log.push({ method: request.method ?? "", url: request.url ?? "" });
    request.resume();
    handler(request.url ?? "/", (body, type = "text/html") => {
      response.setHeader("content-type", type);
      response.end(body);
    });
    if (!response.writableEnded) {
      response.setHeader("content-type", "text/plain");
      response.end("ok");
    }
  });
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  const { port } = server.address() as AddressInfo;
  return { origin: `http://127.0.0.1:${port}`, log };
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "idiom-quick-probe-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function observations(
  runDirectory: string,
  scheme: "light" | "dark",
): Promise<ObservationArtifact> {
  return JSON.parse(
    await readFile(
      join(runDirectory, "page-1", "desktop", scheme, "observations.json"),
      "utf8",
    ),
  ) as ObservationArtifact;
}

const SAFE = new Set(["GET", "HEAD", "OPTIONS"]);

test("quick review probes a third-party page without letting anything leave", async () => {
  const partner = await serve((_url, respond) =>
    respond("<!doctype html><title>Partner</title><h1>Partner</h1>"),
  );
  const page = `<!doctype html><html lang="en"><head><title>Hazards</title></head><body>
<main>
  <h1>Hazards</h1>
  <button id="toggle" aria-expanded="false" onfocus="document.getElementById('search').submit();Notification.requestPermission();window.open('/help');fetch('/focus',{method:'POST'})" onclick="const open=this.getAttribute('aria-expanded')==='true';this.setAttribute('aria-expanded',String(!open));document.getElementById('panel').hidden=open">Details</button>
  <div id="panel" hidden><p>More detail</p></div>
  <button id="save" onclick="console.error('Probe error');fetch('/notes',{method:'POST',body:'x'})">Save note</button>
  <button id="styles" onclick="fetch('/_next/static/hot-update.json',{method:'POST'})">Refresh styles</button>
  <button id="partner" onclick="location.href='${partner.origin}/welcome'">Partner site</button>
  <form id="search" action="/search" method="get"><input name="q" aria-label="Query" value="x"><button type="submit">Search</button></form>
  <button id="script-submit" type="button" onclick="document.getElementById('search').requestSubmit()">Search by script</button>
  <button id="opener" onclick="window.open('/help')">Open help</button>
  <button id="file" onclick="const link=document.createElement('a');link.href='/file.txt';link.download='file.txt';document.body.append(link);link.click();link.remove()">Get file</button>
  <button id="other" onclick="location.href='/other'">Other page</button>
  <button id="danger" onclick="fetch('/account',{method:'DELETE'})">Delete account</button>
  <button id="notify" onclick="Notification.requestPermission()">Enable notifications</button>
  <button id="locate" onclick="navigator.geolocation.getCurrentPosition(()=>{},()=>{})">Find me</button>
</main>
<script>console.error('Static error');window.addEventListener('beforeunload',(event)=>{event.preventDefault();event.returnValue='';});</script>
</body></html>`;
  const site = await serve((url, respond) => {
    if (url === "/" || url.startsWith("/?")) return respond(page);
    if (url.startsWith("/file.txt")) {
      respond("file", "application/octet-stream");
      return;
    }
    if (url.startsWith("/other") || url.startsWith("/help"))
      return respond("<!doctype html><title>Other</title><h1>Other</h1>");
  });
  const directory = await temporaryDirectory();
  const result = await runQuick({
    urls: [`${site.origin}/`],
    literal: true,
    viewports: ["desktop"],
    cwd: directory,
    out: join(directory, "run"),
  });

  // Nothing but safe-method requests reached either server, and no form
  // submission reached the site.
  expect(site.log.filter((entry) => !SAFE.has(entry.method))).toEqual([]);
  expect(site.log.filter((entry) => entry.url.startsWith("/search"))).toEqual(
    [],
  );
  expect(partner.log).toEqual([]);
  expect(site.log.filter((entry) => entry.url.startsWith("/help"))).toEqual([]);

  const light = await observations(result.runDirectory, "light");
  const dark = await observations(result.runDirectory, "dark");
  if (light.version !== 2 || dark.version !== 2)
    throw new Error("expected version 2 observations");
  expect(dark.probe).toBeUndefined();
  const probe = light.probe;
  expect(probe?.safety).toBeDefined();
  const safety = probe?.safety;
  if (!probe || !safety) throw new Error("no probe safety ledger");
  expect(safety.policy).toBe("third-party");
  expect(safety.origins).toContain(site.origin);
  expect(safety.blocked.crossOriginNavigation).toBeGreaterThanOrEqual(1);
  expect(safety.blocked.formSubmission).toBeGreaterThanOrEqual(1);
  expect(safety.blocked.download).toBeGreaterThanOrEqual(1);
  expect(
    safety.blocked.windowOpen + safety.blocked.popup,
  ).toBeGreaterThanOrEqual(1);
  expect(safety.blocked.permission).toBeGreaterThanOrEqual(2);
  expect(safety.skipped.destructive).toBe(1);
  expect(safety.blocked.beforeunload).toBeGreaterThanOrEqual(1);
  // Save note and the dev-server-looking hot-update path are both blocked.
  expect(safety.requests.blocked.POST).toBeGreaterThanOrEqual(3);
  expect(
    Object.keys(safety.requests.sent).filter((method) => !SAFE.has(method)),
  ).toEqual([]);

  const byName = (name: string) =>
    probe.results.find((entry) => entry.name === name);
  expect(byName("Details")?.effects).toContain("dom");
  expect(byName("Save note")?.effects).toContain("network");
  expect(byName("Get file")?.effects).toContain("download");
  expect(byName("Partner site")?.effects).toContain("navigation");
  expect(byName("Delete account")?.skipped).toBe("destructive name");

  expect(result.interaction.status).toBe("probed");
  if (result.interaction.status !== "probed") return;
  expect(result.interaction.totals.nonSafeSent).toBe(0);
  expect(result.interaction.totals.probed).toBeGreaterThan(5);
  const report = await readFile(result.reportPath, "utf8");
  expect(report).toContain("Idiom interacted with this page");
  expect(report).toContain("1 destructive-looking control");
  expect(report).toContain("none left the browser");
  const consoleLog = await readFile(
    join(result.runDirectory, "page-1", "desktop", "light", "console.jsonl"),
    "utf8",
  );
  expect(consoleLog).toContain("Static error");
  expect(consoleLog).not.toContain("Probe error");
  expect(consoleLog).not.toContain("ERR_BLOCKED_BY_CLIENT");
}, 180_000);

test("an exhausted quick probe budget reports the controls it never reached", async () => {
  const buttons = Array.from(
    { length: 60 },
    (_, index) =>
      `<button onclick="this.dataset.n=(+(this.dataset.n||0)+1)">Item ${index + 1}</button>`,
  ).join("");
  const site = await serve((_url, respond) =>
    respond(
      `<!doctype html><html lang="en"><title>Many</title><body><main><h1>Many</h1>${buttons}</main></body></html>`,
    ),
  );
  const directory = await temporaryDirectory();
  const result = await runQuick({
    urls: [`${site.origin}/`],
    literal: true,
    viewports: ["desktop"],
    probeBudgetMs: 1500,
    cwd: directory,
    out: join(directory, "run"),
  });
  if (result.interaction.status !== "probed")
    throw new Error("expected a probe");
  const [page] = result.interaction.pages;
  expect(["partial", "timed-out"]).toContain(page?.probeStatus);
  expect(result.interaction.totals.notReached).toBeGreaterThan(0);
  const report = await readFile(result.reportPath, "utf8");
  expect(report).toMatch(/\d+ controls were not probed/);
}, 180_000);

test("quick review with the probe off records no probe evidence", async () => {
  const site = await serve((_url, respond) =>
    respond(
      `<!doctype html><html lang="en"><title>Static</title><body><main><h1>Static</h1><button>Go</button></main></body></html>`,
    ),
  );
  const directory = await temporaryDirectory();
  const result = await runQuick({
    urls: [`${site.origin}/`],
    literal: true,
    viewports: ["desktop"],
    probe: false,
    cwd: directory,
    out: join(directory, "run"),
  });
  for (const scheme of ["light", "dark"] as const) {
    const artifact = await observations(result.runDirectory, scheme);
    if (artifact.version !== 2) throw new Error("expected version 2");
    expect(artifact.probe).toBeUndefined();
  }
  expect(result.interaction).toEqual({ status: "off" });
}, 180_000);

test("the quick focus sweep blocks cross-origin navigation", async () => {
  const partner = await serve((_url, respond) => respond("Partner"));
  const site = await serve((_url, respond) =>
    respond(
      `<!doctype html><html lang="en"><title>Focus navigation</title><body><main><h1>Focus navigation</h1><button onfocus="location.href='${partner.origin}/focus'">Focus me</button></main></body></html>`,
    ),
  );
  const directory = await temporaryDirectory();
  const result = await runQuick({
    urls: [`${site.origin}/`],
    literal: true,
    viewports: ["desktop"],
    cwd: directory,
    out: join(directory, "run"),
  });
  expect(partner.log).toEqual([]);
  const light = await observations(result.runDirectory, "light");
  if (light.version !== 2) throw new Error("expected version 2 observations");
  expect(
    light.probe?.safety?.blocked.crossOriginNavigation,
  ).toBeGreaterThanOrEqual(1);
}, 180_000);

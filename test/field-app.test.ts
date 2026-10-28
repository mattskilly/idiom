import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { DESTRUCTIVE_ACTION_PATTERN } from "../src/copy-policy.js";
// @ts-expect-error The field app server is plain Node ESM without declarations.
import * as server from "./fixtures/field-app/server.mjs";

const { fieldAppServer, ROUTES, SHIFT_LATENCY_MS } = server;
const root = join(import.meta.dirname, "fixtures", "field-app");
const FEEL_RULES = [
  "idiom:loading-state-missing",
  "idiom:double-submit",
  "idiom:interaction-shift",
  "idiom:motion-snap",
  "idiom:error-state-missing",
  "idiom:retry-blocked",
];
type Case = {
  id: string;
  route: string;
  trigger: string;
  request: string;
  implementation: string;
  intended: string[];
  twinOf: string[];
};
let cases: Case[];
let app: {
  url: string;
  address: { address: string };
  requests: Array<{ method: string; path: string }>;
  close(): Promise<void>;
};
beforeAll(async () => {
  cases = JSON.parse(await readFile(join(root, "cases.json"), "utf8")).cases;
  app = await fieldAppServer();
});
afterAll(async () => {
  await app.close();
});

describe("field app server", () => {
  test("binds 127.0.0.1 and serves the SPA for every case route", async () => {
    expect(app.address.address).toBe("127.0.0.1");
    for (const route of new Set([...ROUTES, ...cases.map((c) => c.route)])) {
      const response = await fetch(`${app.url}${route}`);
      expect(response.status, route).toBe(200);
      expect(await response.text()).toContain('<script src="/app.js"');
    }
    expect((await fetch(`${app.url}/nowhere`)).status).toBe(404);
  });
  test("every case's GET endpoint answers JSON; shift cases arrive after 600ms", async () => {
    // interaction-shift reports late arrivals (> 500ms after input); every
    // other endpoint answers fast, because the held replay times response
    // adjacency from the moment it forwards a request.
    const shift = new Set(
      cases
        .filter((c) => c.intended.includes("idiom:interaction-shift"))
        .map((c) => c.id),
    );
    expect(SHIFT_LATENCY_MS).toBeGreaterThanOrEqual(600);
    for (const item of cases.filter((c) => c.request.startsWith("GET "))) {
      const path = item.request.slice(4);
      const started = performance.now();
      const response = await fetch(`${app.url}${path}`);
      const elapsed = performance.now() - started;
      expect(response.status, path).toBe(200);
      expect(response.headers.get("content-type")).toContain(
        "application/json",
      );
      await response.json();
      if (shift.has(item.id)) expect(elapsed, path).toBeGreaterThanOrEqual(590);
    }
  });
  test("counts API requests by method and path", async () => {
    const before = app.requests.length;
    await fetch(`${app.url}/api/profile`, { method: "POST", body: "{}" });
    expect(app.requests.slice(before)).toEqual([
      { method: "POST", path: "/api/profile" },
    ]);
  });
});

describe("cases.json", () => {
  test("each feel rule has at least 5 bad cases and 3 good twins", () => {
    for (const rule of FEEL_RULES) {
      const bad = cases.filter((c) => c.intended.includes(rule));
      const good = cases.filter((c) => c.twinOf.includes(rule));
      expect(bad.length, rule).toBeGreaterThanOrEqual(5);
      expect(good.length, rule).toBeGreaterThanOrEqual(3);
      expect(new Set(bad.map((c) => c.trigger)).size).toBe(bad.length);
      expect(new Set(good.map((c) => c.trigger)).size).toBe(good.length);
    }
  });
  test("ids and triggers are unique and every case is wired in app.js", async () => {
    const source = await readFile(join(root, "app.js"), "utf8");
    expect(new Set(cases.map((c) => c.id)).size).toBe(cases.length);
    expect(new Set(cases.map((c) => c.trigger)).size).toBe(cases.length);
    for (const item of cases) {
      expect(source, item.id).toContain(item.id.replace(/^[a-z]+-/, ""));
      expect(source, item.trigger).toContain(item.trigger);
      expect(
        item.intended.filter((rule) => item.twinOf.includes(rule)),
      ).toEqual([]);
    }
  });
  test("no route has more than 6 network-sending cases (the replay caps)", () => {
    const perRoute = new Map<string, number>();
    for (const item of cases)
      perRoute.set(item.route, (perRoute.get(item.route) ?? 0) + 1);
    for (const [route, count] of perRoute)
      expect(count, route).toBeLessThanOrEqual(6);
  });
  test("no trigger is skipped by the probe as destructive", () => {
    for (const item of cases)
      expect(DESTRUCTIVE_ACTION_PATTERN.test(item.trigger), item.trigger).toBe(
        false,
      );
  });
});

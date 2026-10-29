import { describe, expect, test } from "vitest";
import { cleanupReports } from "../src/hosted/cleanup.js";
import { LIMITS } from "../src/hosted/config.js";
import { renderHostedReport, reportHeaders } from "../src/hosted/render.js";
import { prefixFor, Reports } from "../src/hosted/reports.js";
import { HASH, ID, MemoryBlob, png, report } from "./hosted-helpers.js";

describe("private report lifecycle and markup", () => {
  test("publishes manifest last, escapes hostile text, uses gated evidence and noindex", async () => {
    const store = new MemoryBlob();
    const reports = new Reports(store, { delivery: async () => {} });
    const saved = await reports.publish(
      ID,
      report(),
      new Map([["asset-0.png", png]]),
    );
    const puts = store.calls.filter((call) => call.startsWith("put:"));
    expect(puts.at(-1)).toBe(`put:${prefixFor(ID)}manifest.json`);
    expect(saved.url).not.toContain(saved.deleteToken);
    const hostile = report();
    hostile.target = 'https://example.com/<script>alert("x")</script>';
    const [first] = hostile.issues;
    if (first) first.detail = '<img onerror="alert(1)">';
    const html = renderHostedReport(ID, hostile, saved.expiresAt);
    for (const title of [
      "Top issues",
      "Between states",
      "Design drift",
      "Coverage",
      "idiom_quick",
      "npm install -g @mattskilly/idiom",
    ])
      expect(html).toContain(title);
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<img onerror=");
    expect(html).toContain(`/api/hosted-asset?id=${ID}&amp;name=asset-0.png`);
    expect(html).not.toMatch(/blob\.vercel|\/tmp\//);
    expect(reportHeaders["cache-control"]).toContain("no-store");
    expect(reportHeaders["x-robots-tag"]).toContain("noindex");
    expect(reportHeaders["content-security-policy"]).toContain(
      "script-src 'self'",
    );
    expect(html).not.toContain(saved.deleteToken);
  });
  test("read and image access end at exact seven-day expiry before physical deletion", async () => {
    let now = 1000;
    const store = new MemoryBlob();
    let deliveries = 0;
    const reports = new Reports(
      store,
      {
        delivery: async () => {
          deliveries++;
        },
      },
      () => now,
    );
    await reports.publish(ID, report(), new Map([["asset-0.png", png]]));
    now += LIMITS.retentionMs - 1;
    await reports.read(ID);
    await reports.asset(ID, "asset-0.png");
    expect(deliveries).toBe(2);
    now++;
    await expect(reports.read(ID)).rejects.toMatchObject({ code: "gone" });
    await expect(reports.asset(ID, "asset-0.png")).rejects.toMatchObject({
      code: "gone",
    });
    expect(store.objects.size).toBeGreaterThan(0);
    expect(await cleanupReports(reports, store, now)).toEqual({
      purged: 1,
      failed: 0,
    });
    expect(store.objects.size).toBe(0);
  });
  test("separate deletion capability, tombstone before partial deletion, safe retries", async () => {
    const store = new MemoryBlob();
    const reports = new Reports(store, { delivery: async () => {} });
    const saved = await reports.publish(
      ID,
      report(),
      new Map([["asset-0.png", png]]),
    );
    await expect(reports.delete(ID, HASH)).rejects.toMatchObject({
      code: "gone",
    });
    await reports.read(ID);
    store.failedDeletes = 1;
    await expect(reports.delete(ID, saved.deleteToken)).rejects.toThrow();
    await expect(reports.read(ID)).rejects.toMatchObject({ code: "gone" });
    await expect(reports.asset(ID, "asset-0.png")).rejects.toMatchObject({
      code: "gone",
    });
    await reports.delete(ID, saved.deleteToken);
    await reports.delete(ID, saved.deleteToken);
    expect(
      [...store.objects.keys()].filter((key) => key.startsWith(prefixFor(ID))),
    ).toEqual([`${prefixFor(ID)}manifest.json`]);
  });
  test("checks deletion again after an in-flight asset read", async () => {
    const store = new MemoryBlob();
    const reports = new Reports(store, { delivery: async () => {} });
    await reports.publish(ID, report(), new Map([["asset-0.png", png]]));
    const get = store.get.bind(store);
    store.get = async (path, max) => {
      const result = await get(path, max);
      if (path.endsWith("asset-0.png")) {
        const item = store.objects.get(`${prefixFor(ID)}manifest.json`);
        if (!item) throw new Error("manifest missing");
        const manifest = JSON.parse(item.bytes.toString());
        manifest.deleted = true;
        item.bytes = Buffer.from(JSON.stringify(manifest));
      }
      return result;
    };
    await expect(reports.asset(ID, "asset-0.png")).rejects.toMatchObject({
      code: "gone",
    });
  });
  test("delivery denial occurs before content reads; orphan and partial upload cleanup paginates", async () => {
    const store = new MemoryBlob();
    const reports = new Reports(
      store,
      {
        delivery: async () => {
          throw new Error("credits exhausted");
        },
      },
      () => 0,
    );
    await reports.publish(ID, report(), new Map([["asset-0.png", png]]));
    store.calls = [];
    await expect(reports.read(ID)).rejects.toThrow();
    expect(store.calls.some((call) => call.endsWith("/report.json"))).toBe(
      false,
    );
    await store.put(
      `hosted/expiry/${HASH}.json`,
      Buffer.from(
        JSON.stringify({
          id: HASH,
          createdAt: 0,
          expiresAt: LIMITS.retentionMs,
        }),
      ),
    );
    for (let i = 0; i < 7; i++)
      await store.put(`${prefixFor(HASH)}asset-${i}.png`, png);
    expect(await cleanupReports(reports, store, LIMITS.runMs + 60_001)).toEqual(
      { purged: 1, failed: 0 },
    );
    expect([...store.objects.keys()].some((key) => key.includes(HASH))).toBe(
      false,
    );
  });
  test("invalid/missing/oversized evidence cannot be published, partial writes roll back", async () => {
    const store = new MemoryBlob();
    const reports = new Reports(store, { delivery: async () => {} });
    await expect(reports.publish(ID, report(), new Map())).rejects.toThrow();
    expect(store.objects.size).toBe(0);
    await expect(
      reports.publish(
        ID,
        report(),
        new Map([["asset-0.png", Buffer.from("not png")]]),
      ),
    ).rejects.toThrow();
    const original = store.put.bind(store);
    store.put = async (path, bytes, options) => {
      if (path.endsWith("/report.json")) throw new Error("provider offline");
      await original(path, bytes, options);
    };
    await expect(
      reports.publish(ID, report(), new Map([["asset-0.png", png]])),
    ).rejects.toThrow();
    expect(store.objects.size).toBe(0);
  });
});

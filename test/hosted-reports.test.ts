import { randomBytes } from "node:crypto";
import { PNG } from "pngjs";
import { describe, expect, test } from "vitest";
import { cleanupReports } from "../src/hosted/cleanup.js";
import { LIMITS } from "../src/hosted/config.js";
import { RUN_RESERVATION } from "../src/hosted/cost.js";
import { AdmissionLedger, LEDGER_PATH } from "../src/hosted/ledger.js";
import { renderHostedReport, reportHeaders } from "../src/hosted/render.js";
import { prefixFor, Reports } from "../src/hosted/reports.js";
import {
  editLedger,
  HASH,
  ID,
  MemoryBlob,
  png,
  report,
  runState,
} from "./hosted-helpers.js";

describe("private report lifecycle and markup", () => {
  test("publishes manifest last, escapes hostile text, uses gated evidence and noindex", async () => {
    const store = new MemoryBlob();
    const reports = new Reports(store, {
      delivery: async () => {},
      assetDelivery: async () => {},
    });
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
        assetDelivery: async () => {},
      },
      () => now,
    );
    await reports.publish(ID, report(), new Map([["asset-0.png", png]]));
    now += LIMITS.retentionMs - 1;
    await reports.read(ID);
    await reports.asset(ID, "asset-0.png");
    expect(deliveries).toBe(1);
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
    const reports = new Reports(store, {
      delivery: async () => {},
      assetDelivery: async () => {},
    });
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
    const reports = new Reports(store, {
      delivery: async () => {},
      assetDelivery: async () => {},
    });
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
        assetDelivery: async () => {
          throw new Error("bytes exhausted");
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
    const reports = new Reports(store, {
      delivery: async () => {},
      assetDelivery: async () => {},
    });
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

const unmetered = { delivery: async () => {}, assetDelivery: async () => {} };
async function meteredReport() {
  const store = new MemoryBlob();
  const ledger = new AdmissionLedger(store, "s".repeat(32));
  await ledger.admit("8.8.8.8", ID, RUN_RESERVATION);
  const reports = new Reports(store, ledger);
  await reports.publish(ID, report(), new Map([["asset-0.png", png]]));
  store.calls = [];
  store.reads = [];
  return { store, ledger, reports };
}
test("trusted manifest sizes bound PNG reads before transfer; old manifests charge the maximum", async () => {
  const { store, reports } = await meteredReport();
  const metadata = await reports.assetMetadata(ID, "asset-0.png");
  expect(metadata).toEqual({ byteLength: png.length, exact: true });
  expect(store.calls).toEqual([`get:${prefixFor(ID)}manifest.json`]);
  await reports.asset(ID, "asset-0.png");
  expect(
    store.reads.find((read) => read.path.endsWith("asset-0.png"))?.maxBytes,
  ).toBe(png.length);
  expect(runState(store)).toMatchObject({
    deliveries: 128,
    resources: { imageBytes: LIMITS.deliveryImageBytes - png.length },
  });
  const stored = store.objects.get(`${prefixFor(ID)}manifest.json`);
  if (!stored) throw new Error("missing fixture");
  const manifest = JSON.parse(stored.bytes.toString());
  delete manifest.assetSizes;
  stored.bytes = Buffer.from(JSON.stringify(manifest));
  expect(await reports.assetMetadata(ID, "asset-0.png")).toEqual({
    byteLength: LIMITS.assetBytes,
    exact: false,
  });
  await reports.asset(ID, "asset-0.png");
  expect(runState(store).resources?.imageBytes).toBe(
    LIMITS.deliveryImageBytes - png.length - LIMITS.assetBytes,
  );
});
test.each([
  { "asset-0.png": 0 },
  { "asset-0.png": LIMITS.assetBytes + 1 },
  { "asset-0.png": 1.5 },
  {},
  null,
  { "asset-0.png": 50, "asset-1.png": 50 },
])(
  "present invalid asset size metadata fails before quota/content reads: %j",
  async (sizes) => {
    const { store, reports } = await meteredReport();
    const stored = store.objects.get(`${prefixFor(ID)}manifest.json`);
    if (!stored) throw new Error("missing fixture");
    const manifest = JSON.parse(stored.bytes.toString());
    manifest.assetSizes = sizes;
    stored.bytes = Buffer.from(JSON.stringify(manifest));
    await expect(reports.asset(ID, "asset-0.png")).rejects.toThrow();
    expect(store.calls).toEqual([`get:${prefixFor(ID)}manifest.json`]);
  },
);
test("duplicate members and aggregate oversize manifest sizes fail closed", async () => {
  const { store, reports } = await meteredReport();
  const stored = store.objects.get(`${prefixFor(ID)}manifest.json`);
  if (!stored) throw new Error("missing fixture");
  const manifest = JSON.parse(stored.bytes.toString());
  manifest.assets.push("asset-0.png");
  stored.bytes = Buffer.from(JSON.stringify(manifest));
  await expect(reports.assetMetadata(ID, "asset-0.png")).rejects.toThrow();
  manifest.assets = Array.from({ length: 5 }, (_, i) => `asset-${i}.png`);
  manifest.assetSizes = Object.fromEntries(
    manifest.assets.map((name: string) => [name, LIMITS.assetBytes]),
  );
  stored.bytes = Buffer.from(JSON.stringify(manifest));
  await expect(reports.manifest(ID)).rejects.toThrow();
  expect(store.calls.every((call) => call.endsWith("manifest.json"))).toBe(
    true,
  );
});
test("exact new sizes reject truncated/enlarged images and claims are never refunded", async () => {
  const { store, reports } = await meteredReport();
  const image = store.objects.get(`${prefixFor(ID)}asset-0.png`);
  if (!image) throw new Error("missing fixture");
  for (const bytes of [
    png.subarray(0, -1),
    Buffer.concat([png, Buffer.from([0])]),
  ]) {
    image.bytes = bytes;
    await expect(reports.asset(ID, "asset-0.png")).rejects.toThrow();
  }
  expect(runState(store).resources?.imageBytes).toBe(
    LIMITS.deliveryImageBytes - 2 * png.length,
  );
});
test.each(["imageBytes", "ledgerBytes", "attempts"] as const)(
  "%s denial precedes PNG reads; work denial also precedes JSON",
  async (field) => {
    const { store, reports } = await meteredReport();
    editLedger(store, (state) => {
      const run = state.runs[0];
      if (run?.resources) run.resources[field] = 0;
    });
    await expect(reports.asset(ID, "asset-0.png")).rejects.toMatchObject({
      code: "cap-reached",
    });
    if (field !== "imageBytes")
      await expect(reports.read(ID)).rejects.toMatchObject({
        code: "cap-reached",
      });
    else await reports.read(ID); // Image exhaustion does not consume page capacity.
    expect(store.calls.some((call) => call.endsWith("asset-0.png"))).toBe(
      false,
    );
    if (field !== "imageBytes")
      expect(store.calls.some((call) => call.endsWith("report.json"))).toBe(
        false,
      );
  },
);
test("old zero-credit runs gain no resources, missing runs gain no access", async () => {
  const { store, reports } = await meteredReport();
  editLedger(store, (state) => {
    const run = state.runs[0];
    if (run) {
      run.deliveries = 0;
      delete run.resources;
    }
  });
  await expect(reports.asset(ID, "asset-0.png")).rejects.toMatchObject({
    code: "cap-reached",
  });
  expect(runState(store).resources).toBeUndefined();
  editLedger(store, (state) => {
    state.runs = [];
  });
  await expect(reports.read(ID)).rejects.toMatchObject({ code: "cap-reached" });
  expect(
    store.calls.some(
      (call) => call.endsWith("report.json") || call.endsWith("asset-0.png"),
    ),
  ).toBe(false);
});
test("a successful page claim survives failed JSON reads and post-read deletion", async () => {
  const { store, reports } = await meteredReport();
  const get = store.get.bind(store);
  store.get = async (path, maxBytes) => {
    if (path.endsWith("report.json")) throw new Error("offline");
    return get(path, maxBytes);
  };
  await expect(reports.read(ID)).rejects.toThrow();
  expect(runState(store).deliveries).toBe(127);
  store.get = async (path, maxBytes) => {
    const result = await get(path, maxBytes);
    if (path.endsWith("report.json")) {
      const stored = store.objects.get(`${prefixFor(ID)}manifest.json`);
      if (!stored) throw new Error("missing fixture");
      const manifest = JSON.parse(stored.bytes.toString());
      manifest.deleted = true;
      stored.bytes = Buffer.from(JSON.stringify(manifest));
    }
    return result;
  };
  await expect(reports.read(ID)).rejects.toMatchObject({ code: "gone" });
  expect(runState(store).deliveries).toBe(126);
});
test("supported maximal renderer fits the conservative 3MiB HTML resource ceiling", async () => {
  const data = report();
  const text = "&".repeat(4096); // Largest escapeHtml expansion (five UTF-8 bytes).
  data.target = text;
  data.issues = Array.from({ length: 5 }, () => ({
    title: text,
    severity: "major",
    detail: text,
    assets: Array(8).fill("asset-0.png"),
  }));
  data.filmstrips = Array(24).fill("asset-0.png");
  data.design.detail = text;
  data.design.assets = Array(8).fill("asset-0.png");
  data.coverage = Array(100).fill(text);
  const store = new MemoryBlob();
  await new Reports(store, unmetered).publish(
    ID,
    data,
    new Map([["asset-0.png", png]]),
  );
  const jsonBytes = Buffer.byteLength(JSON.stringify(data));
  const html = renderHostedReport(ID, data, Date.now());
  const htmlBytes = Buffer.byteLength(html);
  expect(jsonBytes).toBeLessThanOrEqual(LIMITS.reportBytes);
  expect(html.match(/<img /g)).toHaveLength(72);
  expect(html.match(/<li>/g)).toHaveLength(100);
  expect(htmlBytes).toBeLessThan(5 * jsonBytes + 64 * 1024);
  expect(5 * LIMITS.reportBytes + 64 * 1024).toBeLessThan(3 * 1024 * 1024);
  expect(htmlBytes).toBeLessThan(3 * 1024 * 1024);
  expect(store.objects.has(LEDGER_PATH)).toBe(false);
});

test("repeated large new PNG downloads exhaust trusted byte resources without consuming page credits", async () => {
  const image = new PNG({ width: 900, height: 860 });
  image.data = randomBytes(image.width * image.height * 4);
  const bytes = PNG.sync.write(image);
  expect(bytes.length).toBeGreaterThan(0.9 * LIMITS.assetBytes);
  expect(bytes.length).toBeLessThanOrEqual(LIMITS.assetBytes);
  const data = report();
  data.assets = [{ name: "asset-0.png", bytes: bytes.length }];
  const store = new MemoryBlob();
  const ledger = new AdmissionLedger(store, "s".repeat(32));
  await ledger.admit("8.8.8.8", ID, RUN_RESERVATION);
  const reports = new Reports(store, ledger);
  await reports.publish(ID, data, new Map([["asset-0.png", bytes]]));
  const allowed = Math.floor(LIMITS.deliveryImageBytes / bytes.length);
  for (let i = 0; i < allowed; i++)
    expect((await reports.asset(ID, "asset-0.png")).length).toBe(bytes.length);
  expect(runState(store)).toMatchObject({
    deliveries: 128,
    resources: {
      imageBytes: LIMITS.deliveryImageBytes - allowed * bytes.length,
    },
  });
  store.calls = [];
  await expect(reports.asset(ID, "asset-0.png")).rejects.toMatchObject({
    code: "cap-reached",
  });
  expect(store.calls.some((call) => call.endsWith("asset-0.png"))).toBe(false);
  await reports.read(ID);
  expect(runState(store).deliveries).toBe(127);
});

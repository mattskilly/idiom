import { describe, expect, test } from "vitest";
import { LIMITS, microdollars } from "../src/hosted/config.js";
import { PRICES, RUN_RESERVATION } from "../src/hosted/cost.js";
import { AdmissionLedger, LEDGER_PATH } from "../src/hosted/ledger.js";
import {
  editLedger,
  ID,
  ledgerState,
  MemoryBlob,
  runState,
} from "./hosted-helpers.js";

const secret = "secret".repeat(8);
describe("atomic private admission", () => {
  test("same-IP contention admits exactly three, and stores no raw IP", async () => {
    const store = new MemoryBlob();
    const ledger = new AdmissionLedger(store, secret);
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, (_, i) =>
        ledger.admit("8.8.8.8", String(i), 100 * RUN_RESERVATION),
      ),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(3);
    expect(store.objects.get(LEDGER_PATH)?.bytes.toString()).not.toContain(
      "8.8.8.8",
    );
    expect(
      JSON.parse(store.objects.get(LEDGER_PATH)?.bytes.toString() ?? "{}")
        .charged,
    ).toBe(3 * RUN_RESERVATION);
  });
  test("concurrent last-slot claims never exceed exact microdollar cap", async () => {
    const ledger = new AdmissionLedger(new MemoryBlob(), secret);
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, (_, i) =>
        ledger.admit(`8.8.8.${i + 1}`, String(i), RUN_RESERVATION),
      ),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    await expect(
      ledger.admit("1.1.1.1", "next", RUN_RESERVATION),
    ).rejects.toMatchObject({ code: "cap-reached" });
  });
  test("canonical IPv6 shares a rate key, UTC day resets, cap reduction is immediate", async () => {
    let now = Date.parse("2026-10-31T23:59:59Z");
    const ledger = new AdmissionLedger(new MemoryBlob(), secret, () => now);
    for (const [i, ip] of [
      "2606:4700:4700::1111",
      "2606:4700:4700:0:0:0:0:1111",
      "2606:4700:4700::1111",
    ].entries())
      await ledger.admit(ip, `opaque-${i}`, 10 * RUN_RESERVATION);
    await expect(
      ledger.admit("2606:4700:4700::1111", "four", 10 * RUN_RESERVATION),
    ).rejects.toMatchObject({ code: "rate-limit" });
    now += 2000;
    await ledger.admit("2606:4700:4700::1111", "new-month", RUN_RESERVATION);
    await expect(
      ledger.admit("8.8.8.8", "reduced", RUN_RESERVATION - 1),
    ).rejects.toMatchObject({ code: "cap-reached" });
    await ledger.delivery("new-month"); // Prior-month retention liabilities were charged in full.
  });
  test("failed work has no refund and delivery credits survive month rotation", async () => {
    let now = Date.parse("2026-10-31T23:59:59Z");
    const ledger = new AdmissionLedger(new MemoryBlob(), secret, () => now);
    await ledger.admit("8.8.8.8", "crashed", RUN_RESERVATION);
    now += 2000;
    for (let i = 0; i < LIMITS.deliveries; i++)
      await ledger.delivery("crashed");
    await expect(ledger.delivery("crashed")).rejects.toMatchObject({
      code: "cap-reached",
    });
  });
  test("CAS exhaustion, missing IP, malformed prices/cap and failed reads fail closed", async () => {
    const store = new MemoryBlob();
    store.conflicts = 50;
    const ledger = new AdmissionLedger(store, secret);
    await expect(
      ledger.admit("8.8.8.8", "x", RUN_RESERVATION),
    ).rejects.toMatchObject({ code: "unavailable" });
    expect(store.objects.size).toBe(0);
    await expect(
      ledger.admit(undefined, "x", RUN_RESERVATION),
    ).rejects.toThrow();
    await expect(ledger.admit("8.8.8.8", "x", Number.NaN)).rejects.toThrow();
    store.get = async () => {
      throw new Error("provider offline");
    };
    await expect(
      ledger.admit("8.8.8.8", "x", RUN_RESERVATION),
    ).rejects.toMatchObject({ code: "unavailable" });
    expect(microdollars("0.500001")).toBe(500001);
    for (const input of [undefined, "0", "-1", "Infinity", "1e2", "1.0000001"])
      expect(() => microdollars(input)).toThrow();
  });
});

describe("prefix rate identity", () => {
  test.each([false, true])(
    "hosts in one /64 share the daily limit (concurrent=%s)",
    async (concurrent) => {
      const store = new MemoryBlob();
      const ledger = new AdmissionLedger(store, secret);
      const ips = [
        "2606:4700:ABCD:1234::1",
        "2606:4700:abcd:1234:ffff:ffff:ffff:ffff",
        "2606:4700:abcd:1234:0:0:0:1234",
        "2606:4700:abcd:1234::8888",
        "2606:4700:abcd:1234::9999",
      ];
      const admit = (ip: string, i: number) =>
        ledger.admit(ip, `opaque-${i}`, 100 * RUN_RESERVATION);
      const results = concurrent
        ? await Promise.allSettled(ips.map(admit))
        : await (async () => {
            const outcomes: PromiseSettledResult<unknown>[] = [];
            for (const [i, ip] of ips.entries())
              outcomes.push(...(await Promise.allSettled([admit(ip, i)])));
            return outcomes;
          })();
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(3);
      for (const outcome of results)
        if (outcome.status === "rejected")
          expect(outcome.reason).toMatchObject({ code: "rate-limit" });
      for (let i = 0; i < 3; i++)
        await ledger.admit(
          "2606:4700:abcd:1235::1",
          `other-${i}`,
          100 * RUN_RESERVATION,
        );
      expect(Object.values(ledgerState(store).ips).sort()).toEqual([3, 3]);
      const document = store.objects.get(LEDGER_PATH)?.bytes.toString();
      for (const ip of ips) expect(document).not.toContain(ip);
      expect(document).not.toContain("/64");
      expect(document).not.toContain("2606:");
    },
  );
  test("mapped IPv4 preserves the existing IPv4 key and other IPv4 clients are independent", async () => {
    const ledger = new AdmissionLedger(new MemoryBlob(), secret);
    for (const [i, ip] of [
      "8.8.8.8",
      "::ffff:8.8.8.8",
      "::FFFF:808:808",
    ].entries())
      await ledger.admit(ip, `opaque-${i}`, 100 * RUN_RESERVATION);
    await expect(
      ledger.admit("8.8.8.8", "fourth", 100 * RUN_RESERVATION),
    ).rejects.toMatchObject({ code: "rate-limit" });
    await ledger.admit("8.8.8.9", "independent", 100 * RUN_RESERVATION);
    for (const ip of ["invalid", "2606:4700::1%en0", "8.8.8.8%eth0"])
      await expect(
        ledger.admit(ip, "bad", 100 * RUN_RESERVATION),
      ).rejects.toMatchObject({ code: "unavailable" });
  });
});

describe("finite page and image resources", () => {
  async function fixture() {
    const store = new MemoryBlob();
    const ledger = new AdmissionLedger(store, secret);
    await ledger.admit("8.8.8.8", ID, RUN_RESERVATION);
    store.reads = [];
    return { store, ledger };
  }
  test("pages and repeated images consume independent allowances with actual ledger read sizes", async () => {
    const { store, ledger } = await fixture();
    await ledger.delivery(ID);
    await ledger.assetDelivery(ID, 19);
    await ledger.assetDelivery(ID, 19);
    const run = runState(store);
    expect(run.deliveries).toBe(127);
    expect(run.resources).toEqual({
      imageBytes: LIMITS.deliveryImageBytes - 38,
      ledgerBytes:
        LIMITS.deliveryLedgerBytes -
        store.reads.reduce((sum, r) => sum + r.bytes, 0),
      attempts: LIMITS.deliveryAttempts - 3,
    });
  });
  test("exact byte allowance, invalid sizes and final-slot contention fail closed", async () => {
    const { store, ledger } = await fixture();
    for (const size of [
      0,
      -1,
      1.1,
      NaN,
      Infinity,
      LIMITS.assetBytes + 1,
      Number.MAX_SAFE_INTEGER + 1,
    ])
      await expect(ledger.assetDelivery(ID, size)).rejects.toMatchObject({
        code: "unavailable",
      });
    expect(store.reads).toHaveLength(0);
    editLedger(store, (state) => {
      const run = state.runs[0];
      if (run?.resources) {
        run.deliveries = 1;
        run.resources.imageBytes = 5;
      }
    });
    const images = await Promise.allSettled([
      ledger.assetDelivery(ID, 5),
      ledger.assetDelivery(ID, 5),
    ]);
    expect(images.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const pages = await Promise.allSettled([
      ledger.delivery(ID),
      ledger.delivery(ID),
    ]);
    expect(pages.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(runState(store)).toMatchObject({
      deliveries: 0,
      resources: { imageBytes: 0 },
    });
    await expect(ledger.assetDelivery("missing", 1)).rejects.toMatchObject({
      code: "cap-reached",
    });
  });
  test.each(["ledgerBytes", "attempts"] as const)(
    "exact %s work boundary denies subsequent pages and images",
    async (field) => {
      const { store, ledger } = await fixture();
      editLedger(store, (state) => {
        const run = state.runs[0];
        if (run?.resources)
          run.resources[field] = field === "attempts" ? 1 : 1000;
      });
      // Keep the encoded length stable while choosing precisely one read's bytes.
      if (field === "ledgerBytes") {
        for (let i = 0; i < 3; i++)
          editLedger(store, (state) => {
            const run = state.runs[0];
            if (run?.resources)
              run.resources.ledgerBytes =
                store.objects.get(LEDGER_PATH)?.bytes.length ?? 0;
          });
      }
      await ledger.assetDelivery(ID, 1);
      expect(runState(store).resources?.[field]).toBe(0);
      await expect(ledger.delivery(ID)).rejects.toMatchObject({
        code: "cap-reached",
      });
      await expect(ledger.assetDelivery(ID, 1)).rejects.toMatchObject({
        code: "cap-reached",
      });
      expect(runState(store).deliveries).toBe(128);
    },
  );
  test("a winning retry charges all actual reads/attempts against fresh balances once", async () => {
    const { store, ledger } = await fixture();
    editLedger(store, (state) => {
      const run = state.runs[0];
      if (run?.resources) run.resources.imageBytes = 100_000_000;
    });
    const original = store.put.bind(store);
    let competed = false;
    store.put = async (path, bytes, options) => {
      if (!competed && path === LEDGER_PATH) {
        competed = true;
        // A competing successful claim both changes document length and spends resources.
        await new AdmissionLedger(store, secret).assetDelivery(ID, 7);
      }
      await original(path, bytes, options);
    };
    await ledger.assetDelivery(ID, 11);
    expect(new Set(store.reads.map((read) => read.bytes)).size).toBeGreaterThan(
      1,
    );
    expect(runState(store)).toMatchObject({
      deliveries: 128,
      resources: {
        imageBytes: 100_000_000 - 18,
        ledgerBytes:
          LIMITS.deliveryLedgerBytes -
          store.reads.reduce((sum, r) => sum + r.bytes, 0),
        attempts: LIMITS.deliveryAttempts - 3,
      },
    });
  });
  test("conflicts cannot overdraw resources, and exhausted retries/store failures spend no durable quota", async () => {
    const { store, ledger } = await fixture();
    editLedger(store, (state) => {
      const run = state.runs[0];
      if (run?.resources) run.resources.attempts = 1;
    });
    store.conflicts = 1;
    const before = runState(store);
    await expect(ledger.delivery(ID)).rejects.toMatchObject({
      code: "cap-reached",
    });
    expect(runState(store)).toEqual(before);
    editLedger(store, (state) => {
      const run = state.runs[0];
      if (run?.resources) run.resources.attempts = LIMITS.deliveryAttempts;
    });
    store.conflicts = LIMITS.casAttempts;
    const fresh = runState(store);
    await expect(ledger.assetDelivery(ID, 1)).rejects.toMatchObject({
      code: "unavailable",
    });
    expect(runState(store)).toEqual(fresh);
    store.put = async () => {
      throw new Error("offline");
    };
    await expect(ledger.delivery(ID)).rejects.toMatchObject({
      code: "unavailable",
    });
    expect(runState(store)).toEqual(fresh);
  });
  test("legacy resources initialize conservatively only once across retries, restarts and UTC rotation", async () => {
    let now = Date.parse("2026-10-31T23:59:59Z");
    const store = new MemoryBlob();
    const ledger = new AdmissionLedger(store, secret, () => now);
    await ledger.admit("8.8.8.8", ID, RUN_RESERVATION);
    editLedger(store, (state) => {
      const run = state.runs[0];
      if (run) {
        delete run.resources;
        run.deliveries = 2;
      }
    });
    store.conflicts = 1;
    store.reads = [];
    await ledger.assetDelivery(ID, 3);
    expect(runState(store)).toMatchObject({
      deliveries: 2,
      resources: {
        imageBytes: 2 * LIMITS.assetBytes - 3,
        ledgerBytes:
          2 * LIMITS.casAttempts * LIMITS.ledgerBytes -
          store.reads.reduce((sum, r) => sum + r.bytes, 0),
        attempts: 2 * LIMITS.casAttempts - 2,
      },
    });
    const before = runState(store).resources;
    now += 2000;
    const restarted = new AdmissionLedger(store, secret, () => now);
    await restarted.capacity(RUN_RESERVATION);
    expect(runState(store).resources).toEqual(before);
    await restarted.delivery(ID);
    expect(runState(store).resources?.imageBytes).toBe(before?.imageBytes);
    expect(runState(store).resources?.attempts).toBe(
      (before?.attempts ?? 0) - 1,
    );
    now = runState(store).expires;
    await expect(restarted.assetDelivery(ID, 1)).rejects.toMatchObject({
      code: "cap-reached",
    });
  });
  test.each([
    null,
    {},
    { imageBytes: 1 },
    { imageBytes: 1, ledgerBytes: 1, attempts: -1 },
    { imageBytes: LIMITS.deliveryImageBytes + 1, ledgerBytes: 1, attempts: 1 },
  ])("malformed present resources fail closed: %j", async (bad) => {
    const { store, ledger } = await fixture();
    const stored = store.objects.get(LEDGER_PATH);
    if (!stored) throw new Error("missing fixture");
    const data = JSON.parse(stored.bytes.toString());
    data.runs[0].resources = bad;
    stored.bytes = Buffer.from(JSON.stringify(data));
    await expect(ledger.delivery(ID)).rejects.toMatchObject({
      code: "unavailable",
    });
    await expect(ledger.assetDelivery(ID, 1)).rejects.toMatchObject({
      code: "unavailable",
    });
  });
  test("many tiny images exhaust the finite attempt allowance while page/image capacity remains", async () => {
    const { store, ledger } = await fixture();
    for (let i = 0; i < LIMITS.deliveryAttempts; i++)
      await ledger.assetDelivery(ID, 1);
    expect(runState(store)).toMatchObject({
      deliveries: 128,
      resources: {
        imageBytes: LIMITS.deliveryImageBytes - LIMITS.deliveryAttempts,
        attempts: 0,
      },
    });
    await expect(ledger.assetDelivery(ID, 1)).rejects.toMatchObject({
      code: "cap-reached",
    });
    await expect(ledger.delivery(ID)).rejects.toMatchObject({
      code: "cap-reached",
    });
  });
  test("a near-4MiB populated ledger exhausts 1GiB including retries, within the resource cost envelope", async () => {
    const { store, ledger } = await fixture();
    editLedger(store, (state) => {
      const run = state.runs[0];
      if (!run) throw new Error("missing fixture");
      state.runs.push(
        ...Array.from({ length: 19500 }, (_, i) => ({
          ...run,
          id: String(i).padStart(64, "0"),
        })),
      );
    });
    const initial = store.objects.get(LEDGER_PATH)?.bytes.length ?? 0;
    expect(initial).toBeGreaterThan(0.9 * LIMITS.ledgerBytes);
    expect(initial).toBeLessThan(LIMITS.ledgerBytes);
    let successes = 0;
    let chargedBytes = 0;
    let chargedAttempts = 0;
    // Each invocation conflicts once before winning: the retry budget is already charged.
    for (;;) {
      store.conflicts = 1;
      store.reads = [];
      try {
        await ledger.assetDelivery(ID, 1);
      } catch (error) {
        expect(error).toMatchObject({ code: "cap-reached" });
        break;
      }
      successes++;
      chargedBytes += store.reads.reduce((sum, read) => sum + read.bytes, 0);
      chargedAttempts += store.reads.length;
    }
    expect(successes).toBeGreaterThan(100);
    expect(chargedBytes).toBeLessThanOrEqual(LIMITS.deliveryLedgerBytes);
    expect(chargedAttempts).toBeLessThanOrEqual(LIMITS.deliveryAttempts);
    const remaining = runState(store).resources;
    expect(remaining?.ledgerBytes).toBe(
      LIMITS.deliveryLedgerBytes - chargedBytes,
    );
    expect(remaining?.attempts).toBe(LIMITS.deliveryAttempts - chargedAttempts);
    expect(runState(store).deliveries).toBe(128);
    const gb = 1e9;
    const origin = 0.06;
    const subtotal =
      (LIMITS.deliveryLedgerBytes / gb) * (PRICES.blobTransferGb + origin) +
      (LIMITS.deliveryImageBytes / gb) *
        (PRICES.blobTransferGb + PRICES.functionTransferGb + 2 * origin) +
      (LIMITS.deliveries / gb) *
        (LIMITS.reportBytes * (PRICES.blobTransferGb + origin) +
          3 * 1024 * 1024 * (PRICES.functionTransferGb + origin)) +
      ((2 * LIMITS.deliveryAttempts * 8192) / gb) *
        (PRICES.blobTransferGb + origin) +
      LIMITS.deliveryAttempts * PRICES.blobAdvancedOperation +
      4 * LIMITS.deliveryAttempts * PRICES.blobSimpleOperation;
    expect(subtotal).toBeCloseTo(0.37331533824, 10);
    expect(subtotal).toBeLessThan(RUN_RESERVATION / 1e6);
  }, 60_000);
});

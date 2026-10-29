import { describe, expect, test } from "vitest";
import { LIMITS, microdollars } from "../src/hosted/config.js";
import { RUN_RESERVATION } from "../src/hosted/cost.js";
import { AdmissionLedger, LEDGER_PATH } from "../src/hosted/ledger.js";
import { MemoryBlob } from "./hosted-helpers.js";

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
    for (const ip of [
      "2606:4700:4700::1111",
      "2606:4700:4700:0:0:0:0:1111",
      "2606:4700:4700::1111",
    ])
      await ledger.admit(ip, ip, 10 * RUN_RESERVATION);
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

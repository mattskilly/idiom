import { LIMITS } from "./config.js";

// USD rates/assumptions, iad1, recorded 2026-10-28. See docs/hosted-review.md.
// Fixed charges include failures and retention crossing a month boundary.
export const PRICES = {
  cpuHour: 0.128,
  memoryGbHour: 0.0212,
  creation: 0.0000006,
  sandboxEgressGb: 0.15,
  blobGbMonth: 0.023,
  blobTransferGb: 0.05,
  blobAdvancedOperation: 0.000005,
  blobSimpleOperation: 0.0000004,
  functionCpuHour: 0.128,
  functionMemoryGbHour: 0.0106,
  functionTransferGb: 0.15,
  invocation: 0.0000006,
} as const;
export function estimateCost(
  elapsedMs: number,
  bytes: number,
  outputBytes: number,
) {
  const hours = elapsedMs / 3_600_000;
  const gb = 1_000_000_000;
  return {
    sandbox:
      2 * hours * PRICES.cpuHour +
      4 * hours * PRICES.memoryGbHour +
      PRICES.creation +
      (bytes / gb) * PRICES.sandboxEgressGb,
    storage: (outputBytes / gb) * (7 / 30) * PRICES.blobGbMonth,
    operations:
      64 * PRICES.blobAdvancedOperation + 40 * PRICES.blobSimpleOperation,
    function:
      hours * (PRICES.functionCpuHour + 2 * PRICES.functionMemoryGbHour) +
      PRICES.invocation,
    view:
      (outputBytes / gb) * (PRICES.blobTransferGb + PRICES.functionTransferGb) +
      30 * PRICES.blobSimpleOperation,
  };
}
// Historical local-run estimates above remain unchanged; they are not cloud measurements.
// $0.50 reserves 128 page GETs, 384MiB PNGs, 1GiB actual delivery-ledger
// reads and 4096 CAS attempts (preceding conflicts included, not multiplied
// by the eight-attempt retry bound). Content/accounting is <=$0.373316 at
// the documented rates, including both private delivery origin legs.
// The remainder covers sandbox/review/admission/publication/lifecycle/snapshot
// costs, delivery Function invocations/compute, CDN requests and margin.
// Resource safeguards can exhaust before 128 complete large-report views.
export const RUN_RESERVATION = 500_000;
export function validPrices() {
  return (
    Object.values(PRICES).every(
      (price) => Number.isFinite(price) && price > 0,
    ) && LIMITS.deliveries === 128
  );
}

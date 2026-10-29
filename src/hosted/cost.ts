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
// $0.50 includes 128 individually metered <=3MiB responses, 8-attempt CAS,
// <=10k-entry ledger I/O, lifecycle operations, snapshot amortisation and margin.
export const RUN_RESERVATION = 500_000;
export function validPrices() {
  return (
    Object.values(PRICES).every(
      (price) => Number.isFinite(price) && price > 0,
    ) && LIMITS.deliveries === 128
  );
}

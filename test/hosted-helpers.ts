import { PNG } from "pngjs";
import {
  Conflict,
  type PrivateStore,
  type Stored,
} from "../src/hosted/blob.js";
import { LEDGER_PATH } from "../src/hosted/ledger.js";
import type { HostedReport } from "../src/hosted/schema.js";

export const HASH = "a".repeat(64);
export const ID = "b".repeat(64);
export const png = PNG.sync.write(new PNG({ width: 8, height: 8 }));
export function report(): HostedReport {
  return {
    version: 1,
    target: "https://example.com/",
    runtimeHash: HASH,
    issues: [
      {
        title: "Measured defect",
        severity: "major",
        detail: "The button is too small.",
        assets: ["asset-0.png"],
      },
    ],
    filmstrips: ["asset-0.png"],
    design: {
      status: "compared",
      detail: "Image regions compared.",
      assets: ["asset-0.png"],
    },
    coverage: ["No model critique. Authentication not checked."],
    metrics: { elapsedMs: 100, networkBytes: 40, requests: 2, findings: 1 },
    assets: [{ name: "asset-0.png", bytes: png.length }],
  };
}
/** Contract-faithful strong reads and atomic ETags; writes never last-write-win. */
export class MemoryBlob implements PrivateStore {
  objects = new Map<string, Stored>();
  calls: string[] = [];
  reads: { path: string; maxBytes: number; bytes: number }[] = [];
  version = 0;
  conflicts = 0;
  failedDeletes = 0;
  async get(path: string, maxBytes: number) {
    this.calls.push(`get:${path}`);
    const item = this.objects.get(path);
    this.reads.push({ path, maxBytes, bytes: item?.bytes.length ?? 0 });
    if (!item) return null;
    if (item.bytes.length > maxBytes) throw new Error("oversize");
    return { bytes: Buffer.from(item.bytes), etag: item.etag };
  }
  async put(
    path: string,
    bytes: Buffer,
    options?: { etag?: string; contentType?: string },
  ) {
    this.calls.push(`put:${path}`);
    if (this.conflicts-- > 0) throw new Conflict();
    const existing = this.objects.get(path);
    if (
      options?.etag ? existing?.etag !== options.etag : existing !== undefined
    )
      throw new Conflict();
    this.objects.set(path, {
      bytes: Buffer.from(bytes),
      etag: String(++this.version),
    });
  }
  async del(paths: string[]) {
    this.calls.push(`del:${paths.join(",")}`);
    if (this.failedDeletes-- > 0) throw new Error("transient deletion failure");
    for (const path of paths) this.objects.delete(path);
  }
  async list(prefix: string, cursor?: string) {
    const paths = [...this.objects.keys()]
      .filter((p) => p.startsWith(prefix))
      .sort();
    const start = cursor ? paths.findIndex((p) => p > cursor) : 0;
    if (start < 0) return { paths: [] };
    const selected = paths.slice(start, start + 2);
    return {
      paths: selected,
      ...(start + 2 < paths.length
        ? { cursor: selected[selected.length - 1] as string }
        : {}),
    };
  }
}

// Read/edit durable fixtures without bypassing ETags in the code under test.
type TestRun = {
  id: string;
  expires: number;
  deliveries: number;
  amount: number;
  resources?: { imageBytes: number; ledgerBytes: number; attempts: number };
};
export function ledgerState(store: MemoryBlob) {
  const stored = store.objects.get(LEDGER_PATH);
  if (!stored) throw new Error("missing ledger fixture");
  return JSON.parse(stored.bytes.toString()) as {
    version: 1;
    month: string;
    day: string;
    charged: number;
    admissions: number;
    ips: Record<string, number>;
    runs: TestRun[];
  };
}
export function editLedger(
  store: MemoryBlob,
  change: (state: ReturnType<typeof ledgerState>) => void,
) {
  const state = ledgerState(store);
  change(state);
  store.objects.set(LEDGER_PATH, {
    bytes: Buffer.from(JSON.stringify(state)),
    etag: String(++store.version),
  });
}
export function runState(store: MemoryBlob, id = ID) {
  const run = ledgerState(store).runs.find((entry) => entry.id === id);
  if (!run) throw new Error("missing run fixture");
  return run;
}

import { PNG } from "pngjs";
import {
  Conflict,
  type PrivateStore,
  type Stored,
} from "../src/hosted/blob.js";
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
  version = 0;
  conflicts = 0;
  failedDeletes = 0;
  async get(path: string, maxBytes: number) {
    this.calls.push(`get:${path}`);
    const item = this.objects.get(path);
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

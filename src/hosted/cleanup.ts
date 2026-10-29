import type { PrivateStore } from "./blob.js";
import { allPaths } from "./blob.js";
import { LIMITS } from "./config.js";
import type { Reports } from "./reports.js";
import { idPattern } from "./schema.js";

export async function cleanupReports(
  reports: Reports,
  store: PrivateStore,
  now = Date.now(),
) {
  let purged = 0;
  let failed = 0;
  const indexes = await allPaths(store, "hosted/expiry/");
  for (const path of indexes) {
    try {
      const stored = await store.get(path, 1024);
      if (!stored) continue;
      const entry = JSON.parse(stored.bytes.toString()) as {
        id: string;
        createdAt: number;
        expiresAt: number;
      };
      if (
        !idPattern.test(entry.id) ||
        !Number.isFinite(entry.expiresAt) ||
        !Number.isFinite(entry.createdAt)
      ) {
        failed++;
        continue;
      }
      // A never-published prefix may be reclaimed after the request deadline.
      const published = await store.get(
        `hosted/reports/${entry.id}/manifest.json`,
        8192,
      );
      const deleted = published
        ? JSON.parse(published.bytes.toString()).deleted === true
        : false;
      if (
        now >= entry.expiresAt ||
        (!published && now > entry.createdAt + LIMITS.runMs + 60_000)
      ) {
        await reports.purge(entry.id);
        purged++;
      } else if (deleted) {
        const remaining = (
          await allPaths(store, `hosted/reports/${entry.id}/`)
        ).filter((item) => !item.endsWith("/manifest.json"));
        await store.del(remaining);
      }
    } catch {
      failed++;
    }
  }
  return { purged, failed };
}

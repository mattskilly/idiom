import type { CDPSession, Page } from "playwright";
import { redactUrlSecrets } from "./server-diagnosis.js";
import type { ConsoleRecord } from "./types.js";

type NetworkEntry = {
  timestamp: number;
  text: string;
  url: string;
  requestId: string;
  consumed: boolean;
};

type RequestEntry = {
  type: string;
  frameId: string;
  method: string;
  url: string;
  /** Epoch ms the request started. */
  wallTimeMs?: number | undefined;
  /** CDP monotonic seconds the request started. */
  monotonic?: number | undefined;
  status?: number | undefined;
  /** CDP monotonic seconds the response ended. */
  endMonotonic?: number | undefined;
};

/** Epoch ms a request's response ended, from its monotonic start/end pair. */
export function requestEndAt(entry: {
  wallTimeMs?: number | undefined;
  monotonic?: number | undefined;
  endMonotonic?: number | undefined;
}): number | undefined {
  if (
    entry.wallTimeMs === undefined ||
    entry.monotonic === undefined ||
    entry.endMonotonic === undefined
  )
    return undefined;
  return Math.max(
    entry.wallTimeMs,
    entry.wallTimeMs + (entry.endMonotonic - entry.monotonic) * 1000,
  );
}

/**
 * Chromium reports a failed document and a failed same-URL subresource with
 * byte-identical console messages. The CDP log entry behind each one names its
 * request, so a second session records each request's type, method, URL,
 * status and timing and joins them back onto Playwright's records by their
 * shared timestamp, text and URL.
 */
export class ConsoleProvenance {
  private readonly requests = new Map<string, RequestEntry>();
  private readonly entries: NetworkEntry[] = [];

  private constructor(
    private readonly session: CDPSession,
    private readonly mainFrameId: string,
  ) {}

  static async create(page: Page): Promise<ConsoleProvenance> {
    const session = await page.context().newCDPSession(page);
    try {
      const { frameTree } = await session.send("Page.getFrameTree");
      const provenance = new ConsoleProvenance(session, frameTree.frame.id);
      // Subscribe before enabling so no early request or entry is missed.
      session.on("Network.requestWillBeSent", (event) => {
        // Redirects reuse the request id; the last hop produced the response.
        provenance.requests.set(event.requestId, {
          type: event.type ?? "Other",
          frameId: event.frameId ?? "",
          method: event.request.method,
          url: event.request.url,
          wallTimeMs:
            typeof event.wallTime === "number"
              ? event.wallTime * 1000
              : undefined,
          monotonic:
            typeof event.timestamp === "number" ? event.timestamp : undefined,
        });
      });
      session.on("Network.responseReceived", (event) => {
        const request = provenance.requests.get(event.requestId);
        if (request === undefined) return;
        request.status = event.response.status;
        request.endMonotonic = event.timestamp;
      });
      const ended = (event: { requestId: string; timestamp: number }) => {
        const request = provenance.requests.get(event.requestId);
        if (request !== undefined && typeof event.timestamp === "number")
          request.endMonotonic = event.timestamp;
      };
      session.on("Network.loadingFinished", ended);
      session.on("Network.loadingFailed", ended);
      session.on("Log.entryAdded", ({ entry }) => {
        if (entry.source !== "network" || entry.networkRequestId === undefined)
          return;
        provenance.entries.push({
          timestamp: entry.timestamp,
          text: entry.text,
          url: entry.url ?? "",
          requestId: entry.networkRequestId,
          consumed: false,
        });
      });
      await session.send("Network.enable");
      await session.send("Log.enable");
      return provenance;
    } catch (error) {
      await session.detach().catch(() => undefined);
      throw error;
    }
  }

  /** Must run after settling, never inside the console handler: the streams race. */
  annotate(
    records: ConsoleRecord[],
    timestamps: ReadonlyMap<ConsoleRecord, number>,
  ): ConsoleRecord[] {
    return records.map((record) => {
      const timestamp = timestamps.get(record);
      if (record.location === undefined || timestamp === undefined)
        return record;
      const url = record.location.url;
      const entry = this.entries.find(
        (candidate) =>
          !candidate.consumed &&
          candidate.timestamp === timestamp &&
          candidate.text === record.text &&
          candidate.url === url &&
          this.requests.has(candidate.requestId),
      );
      const request =
        entry === undefined ? undefined : this.requests.get(entry.requestId);
      if (entry === undefined || request === undefined) return record;
      entry.consumed = true;
      const endAt = requestEndAt(request);
      return {
        ...record,
        request: {
          resourceType: request.type.toLowerCase(),
          mainFrame: request.frameId === this.mainFrameId,
          method: request.method,
          url: redactUrlSecrets(request.url),
          ...(request.status === undefined ? {} : { status: request.status }),
          ...(request.wallTimeMs === undefined
            ? {}
            : { at: Math.round(request.wallTimeMs) }),
          ...(endAt === undefined ? {} : { endAt: Math.round(endAt) }),
        },
      };
    });
  }

  async dispose(): Promise<void> {
    await this.session.detach().catch(() => undefined);
  }
}

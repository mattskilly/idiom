import type { CDPSession, Page } from "playwright";
import type { ConsoleRecord } from "./types.js";

type NetworkEntry = {
  timestamp: number;
  text: string;
  url: string;
  requestId: string;
  consumed: boolean;
};

/**
 * Chromium reports a failed document and a failed same-URL subresource with
 * byte-identical console messages. The CDP log entry behind each one names its
 * request, so a second session records request types and joins them back onto
 * Playwright's records by their shared timestamp, text and URL.
 */
export class ConsoleProvenance {
  private readonly requests = new Map<
    string,
    { type: string; frameId: string }
  >();
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
        // Redirects reuse the request id; the last hop's type is the same.
        provenance.requests.set(event.requestId, {
          type: event.type ?? "Other",
          frameId: event.frameId ?? "",
        });
      });
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
      return {
        ...record,
        request: {
          resourceType: request.type.toLowerCase(),
          mainFrame: request.frameId === this.mainFrameId,
        },
      };
    });
  }

  async dispose(): Promise<void> {
    await this.session.detach().catch(() => undefined);
  }
}

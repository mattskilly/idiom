import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CDPSession, Page } from "playwright";
import { PNG } from "pngjs";
import {
  FILMSTRIP_LIMITS,
  type FilmstripConfig,
  type FilmstripFrame,
  type FilmstripManifest,
} from "../checks/filmstrip-schema.js";
import { layoutShiftScore } from "../checks/layout-shift.js";
import { runDeterministicChecks } from "../checks/registry.js";
import {
  actionIdentity,
  linkRecording,
  recordingKey,
  sameAction,
  temporalAction,
  temporalCandidates,
} from "../checks/temporal-evidence.js";
import type {
  ActionTimeline,
  ChecksConfig,
  CheckTuple,
  MotionArtifact,
  Rect,
} from "../checks/types.js";

type Paint = {
  data: string;
  timestamp: number;
  document: number;
  geometry: NonNullable<FilmstripFrame["geometry"]>;
};
type Recording = {
  key: string;
  page: Page;
  streamPage: Page;
  source: ActionTimeline["source"];
  anchor?: number | undefined;
  document: number;
  candidates: Array<Paint | undefined>;
  baseline?: Paint | undefined;
  settle?: Paint;
  action?: ActionTimeline;
  nativeAt?: number;
  invalidAt?: number;
  confirmedAt?: number;
  reason?: string;
  visualFrames?:
    | Array<{ time: number; elements: Array<{ selector: string; rect: Rect }> }>
    | undefined;
  requested?: boolean;
  selected: boolean;
  truncated: boolean;
};
type Stream = {
  session: CDPSession;
  document: number;
  last?: Paint | undefined;
  active?: Recording | undefined;
  failure?: string;
  dispose(): Promise<void>;
};
const binding = "__idiomFilmstripMark";
type MarkWindow = Window & {
  __idiomFilmstripArm?: { token: string; dispose(): void };
  __idiomFilmstripMark?: (token: string, time: number) => Promise<void>;
};
/** Runs before input. A passive event observes dispatch, after Playwright's actionability waits. */
function arm(config: {
  token: string;
  source: string;
  kind: string;
  selector?: string | undefined;
}): void {
  const scope = window as MarkWindow;
  scope.__idiomFilmstripArm?.dispose();
  if (config.source === "load") {
    if (window === window.top)
      void scope.__idiomFilmstripMark?.(config.token, performance.timeOrigin);
    return;
  }
  const event = (
    {
      click: "click",
      hover: "pointerover",
      fill: "input",
      select: "change",
      press: "keydown",
      submit: "submit",
    } as Record<string, string>
  )[config.kind];
  const dispose = () => {
    if (event) document.removeEventListener(event, mark, true);
    if (scope.__idiomFilmstripArm?.token === config.token)
      delete scope.__idiomFilmstripArm;
  };
  const mark = (e?: Event) => {
    if (config.selector && e) {
      let target: Element | null;
      try {
        target = document.querySelector(config.selector);
      } catch {
        return;
      }
      if (!target || !(e.target instanceof Node) || !target.contains(e.target))
        return;
    }
    void scope.__idiomFilmstripMark?.(
      config.token,
      performance.timeOrigin + performance.now(),
    );
    dispose();
  };
  scope.__idiomFilmstripArm = { token: config.token, dispose };
  if (event)
    document.addEventListener(event, mark, { capture: true, passive: true });
  else mark();
}

/** A capture lane also accounts for earlier tuples awaiting artifact publication. */
export class FilmstripBudget {
  readonly captures = new Set<FilmstripCapture>();
  get bytes(): number {
    return [...this.captures].reduce((n, c) => n + c.retainedBytes, 0);
  }
}

/** Transient PNG strings only: no image processing or writes on the interaction path. */
export class FilmstripCapture {
  private streams = new Map<Page, Stream>();
  private records = new Map<string, Recording>();
  private disposed = false;
  constructor(
    readonly config: FilmstripConfig,
    private checks: ChecksConfig,
    private motion?: () => MotionArtifact | undefined,
    private requests: import("../checks/filmstrip-schema.js").FilmstripIdentity[] = [],
    private budget = new FilmstripBudget(),
  ) {
    this.budget.captures.add(this);
  }
  get retainedBytes(): number {
    return this.bytes();
  }
  private async stream(page: Page): Promise<Stream> {
    const existing = this.streams.get(page);
    if (existing) return existing;
    const session = await page.context().newCDPSession(page);
    const stream: Stream = {
      session,
      document: 0,
      dispose: async () => {
        stream.active = undefined;
        stream.last = undefined;
        session.off("Page.screencastFrame", onFrame);
        page.off("framenavigated", onNavigation);
        await session.send("Page.stopScreencast").catch(() => undefined);
        await session.detach().catch(() => undefined);
      },
    };
    const onNavigation = (frame: { parentFrame(): unknown }) => {
      if (frame.parentFrame() === null) {
        stream.document++;
        stream.last = undefined;
        if (stream.active?.source === "load") {
          stream.active.document = stream.document;
          // Keep the displayed pre-navigation baseline for the load zero slot.
        } else if (stream.active) {
          stream.active.reason = "document changed during the visual window";
          stream.active.invalidAt = Date.now();
        }
      }
    };
    let firstPaint: (() => void) | undefined;
    const ready = new Promise<void>((resolve) => {
      firstPaint = resolve;
    });
    const onFrame = (event: {
      data: string;
      sessionId: number;
      metadata: {
        timestamp?: number;
        deviceWidth: number;
        deviceHeight: number;
        pageScaleFactor: number;
        scrollOffsetX: number;
        scrollOffsetY: number;
      };
    }) => {
      void session
        .send("Page.screencastFrameAck", { sessionId: event.sessionId })
        .catch(() => undefined);
      const m = event.metadata;
      if (!Number.isFinite(m.timestamp)) {
        if (stream.active)
          stream.active.reason = "compositor timestamp unavailable";
        return;
      }
      if (
        Math.ceil((event.data.length * 3) / 4) > FILMSTRIP_LIMITS.actionBytes
      ) {
        if (stream.active) {
          stream.active.reason = "compressed frame memory limit reached";
          stream.active.truncated = true;
        }
        return;
      }
      const previousPaint = stream.last;
      const paint: Paint = {
        data: event.data,
        timestamp: (m.timestamp as number) * 1000,
        document: stream.document,
        geometry: {
          width: m.deviceWidth / m.pageScaleFactor,
          height: m.deviceHeight / m.pageScaleFactor,
          scrollX: m.scrollOffsetX,
          scrollY: m.scrollOffsetY,
          scale: 1,
          pageScale: m.pageScaleFactor,
        },
      };
      stream.last = paint;
      firstPaint?.();
      firstPaint = undefined;
      const record = stream.active;
      if (!record || record.truncated) {
        if (this.budget.bytes > FILMSTRIP_LIMITS.laneBytes)
          stream.last = previousPaint;
        return;
      }
      if (record.anchor === undefined) {
        record.baseline = paint;
      } else this.accept(record, paint);
      if (
        this.bytes(record) > FILMSTRIP_LIMITS.actionBytes ||
        this.budget.bytes > FILMSTRIP_LIMITS.laneBytes
      ) {
        record.truncated = true;
        record.reason = "compressed frame memory limit reached";
        stream.last = previousPaint;
        if (record.baseline === paint) record.baseline = undefined;
        if (record.settle === paint) delete record.settle;
        // The last arriving frame is released; already sampled slots remain available.
        for (let i = 0; i < record.candidates.length; i++)
          if (record.candidates[i] === paint) record.candidates[i] = undefined;
      }
    };
    this.streams.set(page, stream);
    page.on("framenavigated", onNavigation);
    page.once("close", () => {
      void stream.dispose();
      this.streams.delete(page);
    });
    session.on("Page.screencastFrame", onFrame);
    await page.exposeBinding(
      binding,
      (_source, token: string, time: number) => {
        const record = this.records.get(token);
        if (!record || record.anchor !== undefined || !Number.isFinite(time))
          return;
        record.anchor = time;
        record.document = stream.document;
        if (record.baseline) this.accept(record, record.baseline);
        if (stream.last) this.accept(record, stream.last);
      },
    );
    const size = page.viewportSize() ?? { width: 1280, height: 720 };
    await session.send("Page.startScreencast", {
      format: "png",
      maxWidth: size.width,
      maxHeight: size.height,
      everyNthFrame: 1,
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        ready,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, 150);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
    return stream;
  }
  private accept(record: Recording, paint: Paint) {
    if (record.anchor === undefined) return;
    for (let i = 0; i < this.config.offsetsMs.length; i++) {
      if (
        paint.document !== record.document &&
        !(
          record.source === "load" &&
          i === 0 &&
          paint.timestamp <= record.anchor
        )
      )
        continue;
      const target = record.anchor + (this.config.offsetsMs[i] ?? 0);
      if (
        paint.timestamp <= target &&
        (!record.candidates[i] ||
          paint.timestamp > (record.candidates[i]?.timestamp ?? 0))
      )
        record.candidates[i] = paint;
    }
    if (
      record.nativeAt !== undefined &&
      paint.timestamp <= record.nativeAt &&
      (!record.settle || paint.timestamp > record.settle.timestamp)
    )
      record.settle = paint;
  }
  private bytes(record?: Recording): number {
    const paints = new Set<Paint>();
    for (const r of record ? [record] : this.records.values())
      for (const p of [...r.candidates, r.baseline, r.settle])
        if (p) paints.add(p);
    if (record) {
      const stream = this.streams.get(record.streamPage);
      if (stream?.active === record && stream.last) paints.add(stream.last);
    } else
      for (const stream of this.streams.values())
        if (stream.last) paints.add(stream.last);
    return [...paints].reduce(
      (sum, p) => sum + Math.ceil((p.data.length * 3) / 4),
      0,
    );
  }
  async start(
    page: Page,
    identity: Pick<ActionTimeline, "source" | "kind" | "selector">,
    token: string,
    streamPage = page,
  ): Promise<(() => Promise<void>) | undefined> {
    if (!this.config.enabled || this.disposed) return;
    const record: Recording = {
      key: token,
      page,
      streamPage,
      source: identity.source,
      document: 0,
      candidates: Array.from({ length: this.config.offsetsMs.length }),
      selected: false,
      truncated: false,
    };
    this.records.set(token, record);
    try {
      const stream = await this.stream(streamPage);
      stream.active = record;
      record.document = stream.document;
      record.baseline = stream.last;
      if (identity.selector && this.config.actions.length)
        record.requested = await page.evaluate(
          ({ selector, requests }) => {
            let target: Element | null;
            try {
              target = document.querySelector(selector);
            } catch {
              return false;
            }
            return (
              !!target &&
              requests.some((request) => {
                try {
                  return [...document.querySelectorAll(request)].includes(
                    target,
                  );
                } catch {
                  return false;
                }
              })
            );
          },
          {
            selector: identity.selector,
            requests: this.config.actions.filter((a) => a !== "load"),
          },
        );
      const config = { token, ...identity };
      if (identity.source === "load") {
        const script = await page.addInitScript(arm, config);
        return () => script.dispose();
      }
      await page.evaluate(arm, config);
    } catch (error) {
      record.reason = `screencast unavailable: ${String(error).split("\n")[0]}`;
    }
  }
  freeze(action: ActionTimeline): void {
    const token = recordingKey(action);
    const record = token ? this.records.get(token) : undefined;
    if (!record) return;
    record.nativeAt = action.startedAt + action.durationMs;
    const last = this.streams.get(record.streamPage)?.last;
    if (last) this.accept(record, last);
  }
  /** Called only after the ordinary timeline and motion windows have been frozen. */
  async finish(
    action: ActionTimeline,
    motion = this.motion?.(),
  ): Promise<void> {
    const token = recordingKey(action);
    const record = token ? this.records.get(token) : undefined;
    if (!record || record.action) return;
    record.action = action;
    record.nativeAt ??= action.startedAt + action.durationMs;
    const stream = this.streams.get(record.streamPage);
    if (stream?.last) this.accept(record, stream.last);
    const selected =
      this.explicit(action) ||
      action.source === "load" ||
      this.selected(this.tuple(action, motion), action);
    if (!selected) {
      this.records.delete(record.key);
      if (stream?.active === record) stream.active = undefined;
      return;
    }
    record.selected = true;
    try {
      const remaining =
        record.anchor === undefined
          ? 0
          : record.anchor + (this.config.offsetsMs.at(-1) ?? 0) - Date.now();
      if (remaining > 0 && !record.reason)
        record.visualFrames = await record.page.evaluate(
          async ({ selectors, until, origin }) => {
            type Sample = {
              time: number;
              elements: Array<{
                selector: string;
                rect: { x: number; y: number; width: number; height: number };
              }>;
            };
            const frames: Sample[] = [];
            const previous = new Map<string, string>();
            return new Promise<Sample[]>((resolve) => {
              let raf = 0;
              let done = false;
              const finish = () => {
                if (done) return;
                done = true;
                cancelAnimationFrame(raf);
                clearTimeout(timer);
                resolve(frames);
              };
              const tick = () => {
                if (done) return;
                const elements: Sample["elements"] = [];
                for (const selector of selectors) {
                  let element: Element | null;
                  try {
                    element = document.querySelector(selector);
                  } catch {
                    continue;
                  }
                  if (!element) continue;
                  const r = element.getBoundingClientRect();
                  const rect = {
                    x: r.x,
                    y: r.y,
                    width: r.width,
                    height: r.height,
                  };
                  const signature = JSON.stringify(rect);
                  if (previous.get(selector) !== signature) {
                    previous.set(selector, signature);
                    elements.push({ selector, rect });
                  }
                }
                if (elements.length && frames.length < 120)
                  frames.push({
                    time: performance.timeOrigin + performance.now() - origin,
                    elements,
                  });
                if (performance.timeOrigin + performance.now() >= until)
                  finish();
                else raf = requestAnimationFrame(tick);
              };
              const timer = setTimeout(
                finish,
                Math.max(
                  0,
                  until - (performance.timeOrigin + performance.now()),
                ) + 100,
              );
              tick();
            });
          },
          {
            selectors: [
              ...new Set(
                action.frames.flatMap((f) => f.elements.map((e) => e.selector)),
              ),
            ].slice(0, 250),
            until:
              (record.anchor ?? 0) +
              (this.config.offsetsMs.at(-1) ?? 0) +
              FILMSTRIP_LIMITS.toleranceMs,
            origin: record.anchor ?? action.startedAt,
          },
        );
      // A round trip after a rendering opportunity confirms the stream's unchanged interval.
      const confirmed = await record.page.evaluate(() => ({
        time: performance.timeOrigin + performance.now(),
      }));
      record.confirmedAt = confirmed.time;
      if (stream?.last) this.accept(record, stream.last);
    } catch (error) {
      record.reason ??= `visual window interrupted: ${String(error).split("\n")[0]}`;
    }
    if (stream?.active === record) stream.active = undefined;
    record.baseline = undefined;
  }
  private tuple(action: ActionTimeline, motion?: MotionArtifact): CheckTuple {
    return {
      flow: "",
      state: "",
      viewport: "",
      width: 1,
      height: 1,
      metadataPath: "",
      artifactPaths: [],
      commit: "",
      createdAt: "",
      console: [],
      mismatches: [],
      timelines: {
        version: 1,
        status: "ran",
        limits: {
          frames: 60,
          elements: 250,
          changesPerFrame: 80,
          shifts: 50,
          mutations: 60,
          animations: 40,
          requests: 60,
          actions: 120,
        },
        truncated: { actions: 0 },
        actions: [
          linkRecording({ ...action, id: "pending" }, recordingKey(action)),
        ],
      },
      observations: {
        version: 2,
        elements: [],
        motion,
        layoutShift: {
          status: "ran",
          score: layoutShiftScore(
            action.shifts.map((s) => ({ ...s, startTime: s.time })),
          ),
          entries: [],
        },
      } as unknown as CheckTuple["observations"],
    };
  }
  private selected(tuple: CheckTuple, action: ActionTimeline): boolean {
    return temporalCandidates(tuple, this.checks).some((candidate) => {
      const found = temporalAction(tuple, candidate);
      return found && recordingKey(found) === recordingKey(action);
    });
  }
  private explicit(action: ActionTimeline): boolean {
    return (
      !!this.records.get(recordingKey(action) ?? "")?.requested ||
      this.requests.some((r) => sameAction(r, actionIdentity(action))) ||
      this.config.actions.includes(
        action.source === "load" ? "load" : (action.selector ?? ""),
      )
    );
  }
  async dispose(): Promise<void> {
    this.disposed = true;
    await Promise.all([...this.streams.values()].map((s) => s.dispose()));
    this.streams.clear();
  }
  merge(other: FilmstripCapture | undefined): this {
    if (other && other !== this) {
      for (const [k, r] of other.records) this.records.set(k, r);
      other.records.clear();
      other.budget.captures.delete(other);
      if (this.budget.bytes > FILMSTRIP_LIMITS.laneBytes)
        for (const record of this.records.values()) {
          if (this.budget.bytes <= FILMSTRIP_LIMITS.laneBytes) break;
          record.candidates = [];
          record.baseline = undefined;
          delete record.settle;
          record.truncated = true;
          record.reason = "compressed lane memory limit reached during merge";
        }
    }
    return this;
  }
  clear(): void {
    this.records.clear();
    this.budget.captures.delete(this);
  }
  finalCandidates(
    tuple: CheckTuple,
  ): import("../checks/types.js").FindingCandidate[] {
    return runDeterministicChecks(
      [tuple],
      undefined,
      this.checks,
    ).candidates.map((entry) => entry.candidate);
  }
  /** Publication runs after final checks, outside the measured interaction. */
  async publish(
    directory: string,
    tuple: CheckTuple,
    candidates = temporalCandidates(tuple, this.checks),
  ): Promise<FilmstripManifest> {
    const selected = new Set(
      candidates.flatMap((c) => {
        const a = temporalAction(tuple, c);
        const k = a && recordingKey(a);
        return k ? [k] : [];
      }),
    );
    const manifest: FilmstripManifest = {
      version: 1,
      offsetsMs: this.config.offsetsMs,
      limits: { ...FILMSTRIP_LIMITS },
      actions: [],
    };
    for (const action of tuple.timelines?.actions ?? []) {
      const token = recordingKey(action);
      if (!token || (!selected.has(token) && !this.explicit(action))) continue;
      const record = this.records.get(token);
      const size = record?.candidates.find((p) => p)?.geometry ?? {
        width: tuple.width,
        height: tuple.height,
      };
      const region = filmstripRegion(
        action,
        size.width,
        size.height,
        record?.visualFrames,
      );
      const entry: FilmstripManifest["actions"][number] = {
        id: action.id ?? token,
        identity: actionIdentity(action),
        status: "unavailable",
        timelineOrigin: action.clockOrigin ?? action.startedAt,
        settleMs: Math.max(
          0,
          (record?.nativeAt ?? action.startedAt) -
            (record?.anchor ?? action.startedAt),
        ),
        settled: action.settled,
        region,
        ...(record?.visualFrames === undefined
          ? {}
          : { visualFrames: record.visualFrames }),
        ...(record?.anchor === undefined ? {} : { anchor: record.anchor }),
        frames: [],
        ...(region.width === size.width && region.height === size.height
          ? {
              regionReason:
                "effect geometry unknown or spans viewport; full viewport",
            }
          : {}),
      };
      const slots: Array<number | "settle"> = [
        ...this.config.offsetsMs,
        "settle",
      ];
      for (const [i, slot] of slots.entries()) {
        const requestedMs = slot === "settle" ? entry.settleMs : slot;
        const frame: FilmstripFrame = { slot, requestedMs };
        const paint =
          slot === "settle" ? record?.settle : record?.candidates[i];
        const target = (record?.anchor ?? 0) + requestedMs;
        if (
          !record ||
          record.anchor === undefined ||
          !paint ||
          (paint.document !== record.document &&
            !(
              action.source === "load" &&
              slot === 0 &&
              paint.timestamp <= record.anchor
            )) ||
          (record.confirmedAt ?? 0) < target ||
          (record.invalidAt !== undefined && target >= record.invalidAt)
        )
          frame.reason =
            record?.reason ??
            "action dispatch or compositor coverage unavailable";
        else if (
          target - paint.timestamp > FILMSTRIP_LIMITS.toleranceMs &&
          visualChangeTimes(action, record.visualFrames, record.anchor).some(
            (t) =>
              t > paint.timestamp + FILMSTRIP_LIMITS.toleranceMs && t <= target,
          )
        )
          frame.reason =
            "compositor sample misses a known visual change by more than 35ms";
        else {
          const path = `filmstrips/${entry.id}/${slot}.png`;
          try {
            const png = decodeFrame(Buffer.from(paint.data, "base64"));
            const sx = png.width / paint.geometry.width;
            const sy = png.height / paint.geometry.height;
            const x = Math.max(0, Math.floor(region.x * sx));
            const y = Math.max(0, Math.floor(region.y * sy));
            const width = Math.min(png.width - x, Math.ceil(region.width * sx));
            const height = Math.min(
              png.height - y,
              Math.ceil(region.height * sy),
            );
            if (width <= 0 || height <= 0)
              throw new Error("effect region outside viewport");
            const cropped = new PNG({ width, height });
            PNG.bitblt(png, cropped, x, y, width, height, 0, 0);
            await mkdir(join(directory, "filmstrips", entry.id), {
              recursive: true,
            });
            await writeFile(join(directory, path), PNG.sync.write(cropped));
            Object.assign(frame, {
              path,
              timestamp: paint.timestamp,
              actualMs: paint.timestamp - record.anchor,
              geometry: { ...paint.geometry, scale: sx },
            });
          } catch (error) {
            frame.reason = `frame unavailable: ${String(error)}`;
          }
        }
        entry.frames.push(frame);
      }
      const available = entry.frames.filter((f) => f.path).length;
      entry.status =
        available === 0
          ? "unavailable"
          : available === slots.length && !record?.reason
            ? "complete"
            : "partial";
      if (entry.status !== "complete")
        entry.reason =
          record?.reason ?? "one or more sampled slots unavailable";
      manifest.actions.push(entry);
      this.records.delete(token);
    }
    this.clear();
    await writeFile(
      join(directory, "filmstrips.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
    );
    return manifest;
  }
}

/** Reject oversized raster headers before pngjs allocates decoded storage. */
export function decodeFrame(bytes: Buffer): PNG {
  if (
    bytes.length < 24 ||
    !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    throw new Error("invalid PNG");
  const pixels = bytes.readUInt32BE(16) * bytes.readUInt32BE(20);
  if (pixels <= 0 || pixels > FILMSTRIP_LIMITS.decodedPixels)
    throw new Error("decoded PNG pixel limit exceeded");
  return PNG.sync.read(bytes);
}
/** All geometry here is viewport-relative, including both ends of movements. */
export function filmstripRegion(
  action: ActionTimeline,
  width: number,
  height: number,
  tail: Recording["visualFrames"] = [],
): Rect {
  const changed = new Set(
    action.frames.slice(1).flatMap((f) => f.elements.map((e) => e.selector)),
  );
  const subjects = new Set([
    ...changed,
    ...action.effectRegion.controls,
    ...(action.effectRegion.commonAncestor
      ? [action.effectRegion.commonAncestor]
      : []),
  ]);
  const rects = [
    ...tail.flatMap((f) =>
      f.elements.filter((e) => subjects.has(e.selector)).map((e) => e.rect),
    ),
    ...action.frames.flatMap((f) =>
      f.elements.filter((e) => subjects.has(e.selector)).map((e) => e.rect),
    ),
    ...action.mutations.flatMap((m) => (m.rect ? [m.rect] : [])),
    ...action.shifts.flatMap((s) =>
      s.sources.flatMap((s) => [s.previousRect, s.currentRect]),
    ),
  ].filter((r) => r.width > 0 && r.height > 0);
  if (!rects.length) return { x: 0, y: 0, width, height };
  const x = Math.max(0, Math.floor(Math.min(...rects.map((r) => r.x)) - 24));
  const y = Math.max(0, Math.floor(Math.min(...rects.map((r) => r.y)) - 24));
  const right = Math.min(
    width,
    Math.ceil(Math.max(...rects.map((r) => r.x + r.width)) + 24),
  );
  const bottom = Math.min(
    height,
    Math.ceil(Math.max(...rects.map((r) => r.y + r.height)) + 24),
  );
  return right > x && bottom > y
    ? { x, y, width: right - x, height: bottom - y }
    : { x: 0, y: 0, width, height };
}

/** Final snapshots do not imply a new paint: compare geometry before reporting a miss. */
function visualChangeTimes(
  action: ActionTimeline,
  tail: Recording["visualFrames"],
  anchor: number,
): number[] {
  const positions = new Map<string, Rect>();
  const times: number[] = [];
  const sample = (
    elements: Array<{ selector: string; rect: Rect }>,
    time: number,
    initial: boolean,
  ) => {
    let changed = false;
    for (const e of elements) {
      const previous = positions.get(e.selector);
      if (
        !initial &&
        (!previous ||
          (["x", "y", "width", "height"] as const).some(
            (k) => Math.abs(e.rect[k] - previous[k]) > 0.5,
          ))
      )
        changed = true;
      positions.set(e.selector, e.rect);
    }
    if (changed) times.push(time);
  };
  for (const [i, f] of action.frames.entries())
    sample(
      f.elements,
      (action.clockOrigin ?? action.startedAt) + f.time,
      i === 0,
    );
  for (const f of tail ?? []) sample(f.elements, anchor + f.time, false);
  return [
    ...times,
    ...action.mutations.map(
      (m) => (action.clockOrigin ?? action.startedAt) + m.time,
    ),
  ];
}

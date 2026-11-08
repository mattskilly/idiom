import { expect, test } from "vitest";
import {
  type HostRecord,
  measureReadyUrl,
  pressureReasons,
} from "../src/capture/host-pressure.js";

const host: HostRecord = {
  loadStart: [16.5, 0, 0],
  loadEnd: [0, 0, 0],
  coreCount: 11,
  threshold: 1.5,
  readyStartMs: 2,
  readyEndMs: 20,
  pressureReasons: [],
};
test("pressure uses strict ratios and either recorded load sample", () => {
  expect(pressureReasons(host)).toEqual([]);
  expect(pressureReasons({ ...host, loadEnd: [17, 0, 0] })).toEqual(["load"]);
  expect(pressureReasons({ ...host, loadStart: [64, 0, 0] })).toEqual(["load"]);
  expect(pressureReasons({ ...host, readyEndMs: 21 })).toEqual([
    "ready-url-slowdown",
  ]);
  expect(
    pressureReasons({
      ...host,
      loadStart: null,
      loadEnd: null,
      readyStartMs: null,
      readyEndMs: 1000,
    }),
  ).toEqual([]);
  expect(pressureReasons({ ...host, threshold: 1 })).toEqual(["load"]);
});
test("ready sampler disposes bodies and records only successful bounded measurements", async () => {
  const controller = new AbortController();
  let tick = 0;
  let cancelled = false;
  const result = await measureReadyUrl("http://app/ready", {
    signal: controller.signal,
    monotonicNow: () => ++tick,
    fetch: async (_url, options) => {
      expect(options?.signal).toBeInstanceOf(AbortSignal);
      return new Response(
        new ReadableStream({
          cancel() {
            cancelled = true;
          },
        }),
      );
    },
  });
  expect(result).toBe(1);
  expect(cancelled).toBe(true);
  for (const fetch of [
    async () => new Response("no", { status: 503 }),
    async () => {
      throw new Error("offline");
    },
  ])
    expect(
      await measureReadyUrl("http://app/ready", {
        signal: controller.signal,
        fetch,
      }),
    ).toBeNull();
  controller.abort(new Error("capture cancelled"));
  await expect(
    measureReadyUrl("http://app/ready", {
      signal: controller.signal,
      fetch: async () => {
        controller.signal.throwIfAborted();
        return new Response();
      },
    }),
  ).rejects.toThrow("capture cancelled");
});

test("only readiness-origin Playwright timeout errors acquire retry diagnostics", async () => {
  const { errors } = await import("playwright");
  const { runAction } = await import("../src/capture/web-steps.js");
  const { TupleTimeoutError } = await import("../src/capture/timeouts.js");
  const error = new errors.TimeoutError("expired");
  const page = {
    locator: () => ({
      click: async () => {
        throw error;
      },
      waitFor: async () => {
        throw error;
      },
    }),
  } as unknown as import("playwright").Page;
  await expect(
    runAction(page, { action: "click", selector: "#target" }),
  ).rejects.toBe(error);
  await expect(
    runAction(
      page,
      { action: "waitFor", selector: "#target", state: "visible" },
      123,
    ),
  ).rejects.toMatchObject({
    timeout: { kind: "readiness", timeoutMs: 123 },
    cause: error,
  });
  expect(error).not.toBeInstanceOf(TupleTimeoutError);
});

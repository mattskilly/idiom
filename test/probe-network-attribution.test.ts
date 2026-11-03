import { expect, test } from "vitest";
import {
  backgroundRequestLabels,
  clickNetworkEffect,
  type InitiatedRequest,
} from "../src/capture/probe-network.js";
import { deadControlCheck } from "../src/checks/dead-control.js";
import type { ObservationArtifact, ProbeResult } from "../src/checks/types.js";

const page = "http://app.test/editor";
const fetched = (method: string, path: string): InitiatedRequest => ({
  method,
  url: `http://app.test${path}`,
  via: "fetch",
});

test("only requests the click started count, and only when visible or non-safe", () => {
  const effect = (
    initiated: InitiatedRequest[],
    visible: boolean,
    navigations: Array<{ method: string; url: string }> = [],
  ) => clickNetworkEffect({ initiated, navigations, visible });
  expect(effect([], true)).toBe(false);
  expect(effect([fetched("GET", "/api/item")], false)).toBe(false);
  expect(effect([fetched("GET", "/api/item")], true)).toBe(true);
  expect(effect([fetched("post", "/api/save")], false)).toBe(true);
  expect(effect([fetched("DELETE", "/api/save")], false)).toBe(true);
  expect(
    effect(
      [{ method: "POST", url: "http://app.test/api/track", via: "beacon" }],
      true,
    ),
  ).toBe(false);
  expect(
    effect(
      [
        {
          method: "POST",
          url: "https://www.google-analytics.com/g/collect",
          via: "xhr",
        },
      ],
      true,
    ),
  ).toBe(false);
  expect(effect([fetched("POST", "/main.hot-update.json")], true)).toBe(false);
  expect(
    effect([], false, [{ method: "POST", url: "http://app.test/book" }]),
  ).toBe(true);
});

test("background labels drop query and fragment, match the click's own once, and cap", () => {
  const record = (method: string, url: string) => ({ method, url });
  expect(
    backgroundRequestLabels(
      [
        record("GET", "http://app.test/api/poll?t=1"),
        record("GET", "http://app.test/api/poll?t=1"),
        record("POST", "http://app.test/api/autosave#x"),
        record("GET", "https://cdn.other.test/a/b?q=1"),
      ],
      [record("GET", "http://app.test/api/poll?t=1")],
      page,
    ),
  ).toEqual(["GET /api/poll", "POST /api/autosave", "GET cdn.other.test/a/b"]);
  expect(
    backgroundRequestLabels(
      [record("GET", "http://app.test/api/poll?t=1")],
      [record("get", "http://app.test/api/poll?t=1#frag")],
      page,
    ),
  ).toEqual([]);
  expect(
    backgroundRequestLabels(
      Array.from({ length: 8 }, (_, index) =>
        record("GET", `http://app.test/api/${index}`),
      ),
      [],
      page,
    ),
  ).toHaveLength(5);
});

const observation = (result: Partial<ProbeResult>) =>
  ({
    version: 2,
    elements: [],
    probe: {
      status: "ran",
      results: [
        {
          selector: "#name-version",
          name: "Name this version",
          effects: [],
          persistent: false,
          ...result,
        },
      ],
    },
  }) as unknown as ObservationArtifact;

const explain = (result: Partial<ProbeResult>) =>
  deadControlCheck.run({
    tuple: { observations: observation(result) },
  } as Parameters<typeof deadControlCheck.run>[0]).candidates[0]?.explanation;

test("dead-control names the background requests it saw", () => {
  const text = explain({
    backgroundRequests: ["GET /api/poll", "POST /api/autosave"],
  });
  expect(text).toContain("only background requests observed");
  expect(text).toContain("GET /api/poll, POST /api/autosave");
  expect(explain({})).toBe(
    `"Name this version" (#name-version) is enabled, but clicking it changed nothing observable: no DOM change, focus move, navigation, dialog, network request or clipboard write within the probe window.`,
  );
});

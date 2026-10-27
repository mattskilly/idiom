import { describe, expect, test } from "vitest";
import { createLinkChecker, type LinkRequester } from "../src/capture/links.js";
import { observationArtifactSchema } from "../src/checks/artifact-schema.js";
import { brokenImageCheck } from "../src/checks/broken-image.js";
import { brokenLinkCheck } from "../src/checks/broken-link.js";
import { focusVisibleCheck } from "../src/checks/focus-visible.js";
import { fontLoadingCheck } from "../src/checks/font-loading.js";
import {
  distortionPixelError,
  imageDistortionCheck,
} from "../src/checks/image-distortion.js";
import {
  layoutShiftCheck,
  layoutShiftScore,
} from "../src/checks/layout-shift.js";
import { lineLengthCheck } from "../src/checks/line-length.js";
import { orphanWordCheck } from "../src/checks/orphan-word.js";
import { checksConfigFrom } from "../src/checks/registry.js";
import type {
  CheckTuple,
  DeterministicCheck,
  FontObservation,
  ImageRenderObservation,
  LinkObservation,
} from "../src/checks/types.js";
import { checksConfigSchema } from "../src/schemas/project.js";

const rect = { x: 0, y: 0, width: 100, height: 40 };

function tuple(extra: Record<string, unknown> | undefined): CheckTuple {
  return {
    flow: "f",
    state: "s",
    viewport: "desktop",
    width: 1440,
    height: 900,
    metadataPath: "m.json",
    artifactPaths: [],
    commit: "c",
    createdAt: "2026-10-25T00:00:00.000Z",
    observations: {
      version: 2,
      viewport: { width: 1440, height: 900 },
      document: {
        scrollWidth: 1440,
        scrollHeight: 900,
        clientWidth: 1440,
        clientHeight: 900,
      },
      elements: [],
      maskMembership: [],
      headings: [],
      tokens: { status: "not-configured" },
      ...extra,
    } as CheckTuple["observations"],
    axe: { violations: [] },
    console: [],
    mismatches: [],
  };
}

function run(
  check: DeterministicCheck,
  extra: Record<string, unknown> | undefined,
  checks: unknown = {},
) {
  return check.run({
    tuple: tuple(extra),
    narrowViewport: false,
    config: checksConfigFrom(checksConfigSchema.parse(checks)),
  });
}

const allChecks: Array<[DeterministicCheck, string, string]> = [
  [fontLoadingCheck, "fonts", "fonts"],
  [brokenLinkCheck, "links", "links"],
  [focusVisibleCheck, "focusVisible", "focusVisible"],
  [lineLengthCheck, "lineLength", "lineLengths"],
  [orphanWordCheck, "orphanWord", "orphanWords"],
  [imageDistortionCheck, "images", "imageRenders"],
  [brokenImageCheck, "images", "imageRenders"],
  [layoutShiftCheck, "layoutShift", "layoutShift"],
];

describe("craft checks: coverage", () => {
  for (const [check, key] of allChecks) {
    test(`${check.id} is skipped when checks.${key}.enabled is false`, () => {
      expect(run(check, {}, { [key]: { enabled: false } }).coverage).toEqual({
        check: check.id,
        status: "skipped",
        reason: `checks.${key} is not enabled`,
      });
    });
    test(`${check.id} is unavailable without evidence`, () => {
      expect(run(check, {}).coverage.status).toBe("unavailable");
      const v1 = check.run({
        tuple: {
          ...tuple({}),
          observations: {
            version: 1,
            viewport: { width: 1, height: 1 },
            document: {
              scrollWidth: 1,
              scrollHeight: 1,
              clientWidth: 1,
              clientHeight: 1,
            },
            elements: [],
            headings: [],
            tokens: { status: "not-configured" },
          } as unknown as CheckTuple["observations"],
        },
        narrowViewport: false,
        config: checksConfigFrom(),
      });
      expect(v1.coverage.status).toBe("unavailable");
    });
  }

  test("a partial scan keeps its candidates but reports unavailable coverage", () => {
    const result = run(lineLengthCheck, {
      lineLengths: {
        status: "partial",
        reason: "Line length record limit (200) reached",
        records: [
          {
            selector: "p",
            chars: 120,
            width: 900,
            charWidth: 7.5,
            lines: 4,
            text: "x",
          },
        ],
      },
    });
    expect(result.candidates).toHaveLength(1);
    expect(result.coverage).toEqual({
      check: "line-length",
      status: "unavailable",
      reason: "Line length record limit (200) reached",
    });
  });
});

describe("line-length", () => {
  const record = (chars: number) => ({
    selector: "p.body",
    chars,
    width: chars * 7,
    charWidth: 7,
    lines: 3,
    text: "x",
  });
  test("90 passes, 91 is reported, max is configurable", () => {
    const at = (chars: number, checks: unknown = {}) =>
      run(
        lineLengthCheck,
        { lineLengths: { status: "ran", records: [record(chars)] } },
        checks,
      ).candidates;
    expect(at(90)).toEqual([]);
    const [candidate] = at(91);
    expect(candidate?.severity).toBe("minor");
    expect(candidate?.rule).toBe("idiom:line-too-long");
    expect(at(91, { lineLength: { max: 100 } })).toEqual([]);
  });
  test("single rendered lines are exempt even above a configured maximum", () => {
    const result = run(
      lineLengthCheck,
      {
        lineLengths: { status: "ran", records: [{ ...record(120), lines: 1 }] },
      },
      { lineLength: { max: 40 } },
    );
    expect(result.candidates).toEqual([]);
    expect(result.coverage.status).toBe("ran");
  });
  test("configured low maxima use measured counts without a capture cutoff", () => {
    const result = run(
      lineLengthCheck,
      {
        lineLengths: { status: "ran", records: [record(40), record(41)] },
      },
      { lineLength: { max: 40 } },
    );
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]?.explanation).toContain("41 characters");
  });
});

describe("orphan-word", () => {
  const scan = (word: string) => ({
    orphanWords: {
      status: "ran",
      records: [{ selector: "h1", word, lines: 2, text: `Plan a ${word}` }],
    },
  });
  test("short words are reported up to maxChars", () => {
    expect(run(orphanWordCheck, scan("now")).candidates).toHaveLength(1);
    expect(run(orphanWordCheck, scan("seventy")).candidates).toHaveLength(1);
    expect(run(orphanWordCheck, scan("eighteen")).candidates).toEqual([]);
    expect(
      run(orphanWordCheck, scan("now"), { orphanWord: { maxChars: 2 } })
        .candidates,
    ).toEqual([]);
  });
  test("the explanation names the viewport width", () => {
    expect(run(orphanWordCheck, scan("now")).candidates[0]?.explanation).toBe(
      "h1 leaves “now” alone on its last line (2 lines) at 1440px.",
    );
  });
  const record = (patch: Record<string, unknown>) => ({
    orphanWords: {
      status: "ran",
      records: [
        { selector: "h1", word: "now", lines: 2, text: "Plan a now", ...patch },
      ],
    },
  });
  test("a stranded word with no ink in the screenshot is skipped and counted", () => {
    const result = run(
      orphanWordCheck,
      record({ ink: { status: "measured", share: 0 } }),
    );
    expect(result.candidates).toEqual([]);
    expect(result.coverage.inkSkipped).toEqual({ "idiom:orphan-word": 1 });
  });
  test("inked, unmeasured and legacy records are reported without an ink count", () => {
    for (const ink of [
      { status: "measured", share: 0.3 },
      { status: "unavailable", reason: "rect outside screenshot" },
      undefined,
    ]) {
      const result = run(
        orphanWordCheck,
        ink === undefined ? scan("now") : record({ ink }),
      );
      expect(result.candidates).toHaveLength(1);
      expect(result.coverage.inkSkipped).toBeUndefined();
    }
  });
  test("the measured text rect becomes the crop subject", () => {
    const rect = { x: 10, y: 20, width: 300, height: 80 };
    expect(
      run(orphanWordCheck, record({ rect })).candidates[0]?.verification.params
        ?.rect,
    ).toEqual(rect);
    expect(
      run(orphanWordCheck, scan("now")).candidates[0]?.verification.params,
    ).not.toHaveProperty("rect");
  });
});

describe("image checks", () => {
  const image = (
    overrides: Partial<ImageRenderObservation>,
  ): ImageRenderObservation => ({
    selector: "img.hero",
    src: "/hero.png",
    naturalWidth: 400,
    naturalHeight: 200,
    rendered: { x: 0, y: 0, width: 200, height: 200 },
    objectFit: "fill",
    distortion: 1,
    broken: false,
    ...overrides,
  });
  const scan = (...records: ImageRenderObservation[]) => ({
    imageRenders: { status: "ran", records },
  });
  test("distortion is judged against the tolerance with fill only", () => {
    expect(
      run(imageDistortionCheck, scan(image({ distortion: 0.03 }))).candidates,
    ).toEqual([]);
    const [candidate] = run(
      imageDistortionCheck,
      scan(image({ distortion: 0.031 })),
    ).candidates;
    expect(candidate?.severity).toBe("major");
    expect(candidate?.explanation).toContain("400×200");
    expect(
      run(
        imageDistortionCheck,
        scan(image({ distortion: 0.5, objectFit: "cover" })),
      ).candidates,
    ).toEqual([]);
    expect(
      run(imageDistortionCheck, scan(image({ distortion: 0.5 })), {
        images: { distortionTolerance: 0.6 },
      }).candidates,
    ).toEqual([]);
  });
  test("distortion under a visible pixel is not reported", () => {
    const icon = image({
      selector: "img.icon",
      naturalWidth: 24,
      naturalHeight: 13,
      rendered: { x: 0, y: 0, width: 20, height: 11 },
      distortion: 0.037,
    });
    expect(distortionPixelError(icon)).toBeCloseTo(0.108, 3);
    expect(run(imageDistortionCheck, scan(icon)).candidates).toEqual([]);
    const narrow = image({
      naturalWidth: 24,
      naturalHeight: 10,
      rendered: { x: 0, y: 0, width: 20, height: 8.75 },
      distortion: 0.0476,
    });
    expect(distortionPixelError(narrow)).toBeCloseTo(0.294, 3);
    expect(run(imageDistortionCheck, scan(narrow)).candidates).toEqual([]);
    const [photo] = run(
      imageDistortionCheck,
      scan(
        image({
          naturalWidth: 2400,
          naturalHeight: 1300,
          rendered: { x: 0, y: 0, width: 2000, height: 1100 },
          distortion: 0.037,
        }),
      ),
    ).candidates;
    expect(photo?.severity).toBe("major");
    expect(
      run(
        imageDistortionCheck,
        scan(
          image({
            naturalWidth: 569,
            naturalHeight: 1024,
            rendered: { x: 0, y: 0, width: 371, height: 642 },
            distortion: 0.042,
          }),
        ),
      ).candidates,
    ).toHaveLength(1);
    expect(
      distortionPixelError(
        image({ naturalWidth: 0, naturalHeight: 0, distortion: 0 }),
      ),
    ).toBe(0);
  });
  test("broken images are their own rule", () => {
    const records = scan(
      image({ broken: true, naturalWidth: 0, naturalHeight: 0 }),
    );
    expect(run(imageDistortionCheck, records).candidates).toEqual([]);
    const [candidate] = run(brokenImageCheck, records).candidates;
    expect(candidate?.rule).toBe("idiom:image-broken");
    expect(candidate?.severity).toBe("major");
  });
});

describe("layout-shift", () => {
  test("the score is the largest session window", () => {
    expect(layoutShiftScore([])).toBe(0);
    // Two shifts 500 ms apart share a window; a 1 s gap starts a new one.
    expect(
      layoutShiftScore([
        { value: 0.05, startTime: 100 },
        { value: 0.04, startTime: 600 },
        { value: 0.06, startTime: 1700 },
      ]),
    ).toBe(0.09);
    // A window closes after 5 s even without a gap.
    expect(
      layoutShiftScore(
        Array.from({ length: 12 }, (_, index) => ({
          value: 0.01,
          startTime: index * 500,
        })),
      ),
    ).toBe(0.1);
    expect(
      layoutShiftScore([
        { value: 0.5, startTime: 0, hadRecentInput: true },
        { value: 0.02, startTime: 10 },
      ]),
    ).toBe(0.02);
  });
  const shift = (score: number) => ({
    layoutShift: {
      status: "ran",
      score,
      entries: [
        { value: score, startTime: 150, sources: ["main > h1", "section"] },
        { value: 0, startTime: 160, sources: ["section"] },
      ],
    },
  });
  test("0.1 passes, 0.11 is reported naming the shifting elements", () => {
    expect(run(layoutShiftCheck, shift(0.1)).candidates).toEqual([]);
    const [candidate] = run(layoutShiftCheck, shift(0.11)).candidates;
    expect(candidate?.severity).toBe("major");
    expect(candidate?.selectorHint).toBe("section");
    expect(candidate?.explanation).toContain("main > h1");
  });
});

describe("font-loading", () => {
  const fonts = (overrides: Partial<FontObservation>): FontObservation => ({
    status: "ran",
    faces: [
      {
        family: "brand",
        status: "loaded",
        weight: "400",
        style: "normal",
        urls: ["https://example.test/brand.woff2"],
      },
    ],
    used: [{ family: "brand", selectors: ["h1", "h2"], fallback: false }],
    failedRequests: [],
    ...overrides,
  });
  const face = (status: "unloaded" | "loading" | "loaded" | "error") => ({
    family: "brand",
    status,
    weight: "700",
    style: "normal",
    urls: ["https://example.test/brand-bold.woff2"],
  });
  test("decision table", () => {
    const found = (value: FontObservation) =>
      run(fontLoadingCheck, { fonts: value }).candidates.length;
    expect(found(fonts({}))).toBe(0);
    expect(found(fonts({ faces: [face("error")] }))).toBe(1);
    expect(found(fonts({ faces: [face("unloaded")] }))).toBe(1);
    expect(found(fonts({ faces: [face("loaded"), face("error")] }))).toBe(1);
    expect(
      found(
        fonts({
          used: [{ family: "brand", selectors: ["h1"], fallback: true }],
        }),
      ),
    ).toBe(1);
    // A family without declared faces is a local or system font: not ours.
    expect(
      found(
        fonts({
          used: [{ family: "other", selectors: ["p"], fallback: true }],
        }),
      ),
    ).toBe(0);
  });
  test("the explanation prefers the failed URL", () => {
    const [candidate] = run(fontLoadingCheck, {
      fonts: fonts({
        faces: [
          {
            ...face("error"),
            urls: ["https://a.test/1.woff2", "https://a.test/2.woff"],
          },
        ],
        failedRequests: [{ url: "https://a.test/2.woff", reason: "HTTP 404" }],
      }),
    }).candidates;
    expect(candidate?.explanation).toContain("https://a.test/2.woff;");
    expect(candidate?.explanation).not.toContain("1.woff2");
    expect(candidate?.fingerprintHint).toBe("brand");
  });
  test("a loaded face rendering in the fallback is not called a failed load", () => {
    const [candidate] = run(fontLoadingCheck, {
      fonts: fonts({
        faces: [{ ...face("loaded"), urls: [] }],
        used: [{ family: "brand", selectors: ["h1"], fallback: true }],
      }),
    }).candidates;
    expect(candidate?.explanation).toBe(
      "The web font “brand” loaded but text renders in the fallback font from a source that is not readable (an inline data URI or a cross-origin stylesheet); it is used by h1.",
    );
  });
});

describe("broken-link", () => {
  const link = (overrides: Partial<LinkObservation>): LinkObservation => ({
    selector: "a.pricing",
    text: "Pricing",
    href: "http://127.0.0.1:4100/missing?plan=pro",
    sameOrigin: true,
    result: { status: "broken", code: 404, reason: "HTTP 404" },
    ...overrides,
  });
  const scan = (...records: LinkObservation[]) => ({
    links: { status: "ran", records },
  });
  test("same-origin is major and keeps the port out of identity", () => {
    const [candidate] = run(brokenLinkCheck, scan(link({}))).candidates;
    expect(candidate?.severity).toBe("major");
    expect(candidate?.fingerprintHint).toBe("a.pricing|/missing?plan=pro");
    expect(candidate?.explanation).toBe(
      "The link “Pricing” points at /missing?plan=pro, which answers HTTP 404.",
    );
  });
  test("external is minor; unchecked and ok links are not findings", () => {
    const [candidate] = run(
      brokenLinkCheck,
      scan(
        link({
          sameOrigin: false,
          href: "https://gone.invalid/",
          result: { status: "broken", code: null, reason: "DNS lookup failed" },
        }),
        link({ selector: "a.a", result: { status: "ok", code: 200 } }),
        link({
          selector: "a.b",
          result: { status: "unchecked", reason: "HTTP 403" },
        }),
      ),
    ).candidates;
    expect(candidate?.severity).toBe("minor");
    expect(candidate?.explanation).toContain("DNS lookup failed");
    expect(run(brokenLinkCheck, scan()).coverage.status).toBe("ran");
  });
});

describe("focus-visible", () => {
  test("only stops with no visible change are reported, on the proxy", () => {
    const result = run(focusVisibleCheck, {
      focusVisible: {
        status: "ran",
        records: [
          { selector: "#ok", name: "Ok", rect, changed: ["self.outlineStyle"] },
          { selector: "#save", name: "Save", rect, changed: [] },
          {
            selector: "#agree",
            name: "",
            rect: { x: 0, y: 0, width: 1, height: 1 },
            changed: [],
            proxy: "label.agree",
          },
        ],
      },
    });
    expect(result.candidates.map((c) => c.selectorHint)).toEqual([
      "#save",
      "label.agree",
    ]);
    expect(result.candidates[0]?.severity).toBe("major");
  });
});

describe("artifact schema", () => {
  test("a v2 observation with every craft field validates, and without them", () => {
    const base = tuple({}).observations;
    expect(observationArtifactSchema.safeParse(base).success).toBe(true);
    const full = tuple({
      fonts: {
        status: "ran",
        faces: [
          {
            family: "brand",
            status: "error",
            weight: "400",
            style: "normal",
            urls: [],
          },
        ],
        used: [{ family: "brand", selectors: ["h1"], fallback: true }],
        failedRequests: [{ url: "https://a.test/b.woff2", reason: "HTTP 404" }],
      },
      links: {
        status: "partial",
        reason: "link check time budget (30s) exhausted",
        records: [
          {
            selector: "a",
            text: "Docs",
            href: "https://a.test/docs",
            sameOrigin: false,
            result: { status: "unchecked", reason: "budget" },
          },
        ],
      },
      focusVisible: {
        status: "ran",
        records: [
          { selector: "#a", name: "A", rect, changed: [], proxy: "label" },
        ],
      },
      lineLengths: {
        status: "ran",
        records: [
          {
            selector: "p",
            chars: 99,
            width: 700,
            charWidth: 7,
            lines: 3,
            text: "t",
          },
        ],
      },
      orphanWords: {
        status: "ran",
        records: [{ selector: "h1", word: "now", lines: 2, text: "Go now" }],
      },
      imageRenders: {
        status: "ran",
        records: [
          {
            selector: "img",
            src: "/a.png",
            naturalWidth: 40,
            naturalHeight: 20,
            rendered: rect,
            objectFit: "fill",
            distortion: 0.2,
            broken: false,
          },
        ],
      },
      layoutShift: {
        status: "ran",
        score: 0.2,
        entries: [{ value: 0.2, startTime: 150, sources: ["main"] }],
      },
    }).observations;
    const parsed = observationArtifactSchema.safeParse(full);
    expect(parsed.error).toBeUndefined();
  });
});

type Answer = number | Error;

function fakeRequester(
  answers: Record<string, { head?: Answer; get?: Answer }>,
) {
  const calls: string[] = [];
  let active = 0;
  let peak = 0;
  const respond = async (method: "head" | "get", url: string) => {
    calls.push(`${method.toUpperCase()} ${url}`);
    active++;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active--;
    const answer = answers[url]?.[method] ?? answers[url]?.head ?? 200;
    if (answer instanceof Error) throw answer;
    return { status: () => answer, dispose: async () => {} };
  };
  const requester = {
    head: (url: string) => respond("head", url),
    get: (url: string) => respond("get", url),
  } as unknown as LinkRequester;
  return { requester, calls, peak: () => peak };
}

const linkOptions = {
  external: false,
  timeoutMs: 1000,
  budgetMs: 30000,
  concurrency: 2,
  ignore: [] as string[],
};

const link = (href: string, sameOrigin = true): LinkObservation => ({
  selector: `a[href="${href}"]`,
  text: href,
  href,
  sameOrigin,
});

describe("createLinkChecker", () => {
  test("each URL is requested once per run, across tuples", async () => {
    const fake = fakeRequester({});
    const checker = createLinkChecker({
      ...linkOptions,
      request: async () => fake.requester,
    });
    await checker.check([link("http://a.test/x")]);
    const second = await checker.check([link("http://a.test/x")]);
    expect(fake.calls).toEqual(["HEAD http://a.test/x"]);
    expect(second.records[0]?.result).toEqual({ status: "ok", code: 200 });
  });

  test("classification", async () => {
    const fake = fakeRequester({
      "http://a.test/head-405": { head: 405, get: 200 },
      "http://a.test/gone": { head: 404, get: 404 },
      "http://a.test/private": { head: 403, get: 403 },
      "http://a.test/slow": {
        head: new Error("Timeout 1000ms exceeded"),
        get: new Error("Timeout 1000ms exceeded"),
      },
      "http://dns.invalid/": {
        head: new Error("getaddrinfo ENOTFOUND dns.invalid"),
      },
    });
    const checker = createLinkChecker({
      ...linkOptions,
      external: true,
      request: async () => fake.requester,
    });
    const scan = await checker.check([
      link("http://a.test/head-405"),
      link("http://a.test/gone"),
      link("http://a.test/private"),
      link("http://a.test/slow"),
      link("http://dns.invalid/", false),
    ]);
    expect(scan.status).toBe("ran");
    expect(scan.records.map((record) => record.result)).toEqual([
      { status: "ok", code: 200 },
      { status: "broken", code: 404, reason: "HTTP 404" },
      {
        status: "unchecked",
        reason: "HTTP 403: requires authentication or is rate limited",
      },
      { status: "unchecked", reason: "Timeout 1000ms exceeded" },
      { status: "broken", code: null, reason: "DNS lookup failed" },
    ]);
    // DNS failures are conclusive; HEAD errors otherwise fall back to GET.
    expect(fake.calls).toContain("GET http://a.test/head-405");
    expect(fake.calls).not.toContain("GET http://dns.invalid/");
  });

  test("external links and ignored prefixes are never requested", async () => {
    const fake = fakeRequester({});
    const checker = createLinkChecker({
      ...linkOptions,
      ignore: ["/logout", "http://a.test/admin"],
      request: async () => fake.requester,
    });
    const scan = await checker.check([
      link("https://elsewhere.test/", false),
      link("http://a.test/logout?next=/"),
      link("http://a.test/admin/users"),
    ]);
    expect(fake.calls).toEqual([]);
    expect(scan.records.map((record) => record.result?.status)).toEqual([
      "unchecked",
      "unchecked",
      "unchecked",
    ]);
  });

  test("concurrency never exceeds the limit", async () => {
    const fake = fakeRequester({});
    const checker = createLinkChecker({
      ...linkOptions,
      concurrency: 2,
      request: async () => fake.requester,
    });
    await checker.check(
      Array.from({ length: 9 }, (_, index) => link(`http://a.test/${index}`)),
    );
    expect(fake.calls).toHaveLength(9);
    expect(fake.peak()).toBe(2);
  });

  test("an exhausted budget leaves later links unchecked and the scan partial", async () => {
    const fake = fakeRequester({});
    let clock = 0;
    const checker = createLinkChecker({
      ...linkOptions,
      concurrency: 1,
      budgetMs: 1000,
      monotonicNow: () => clock,
      request: async () => ({
        ...fake.requester,
        head: (...args: Parameters<LinkRequester["head"]>) => {
          clock += 600;
          return fake.requester.head(...args);
        },
      }),
    });
    const scan = await checker.check([
      link("http://a.test/1"),
      link("http://a.test/2"),
      link("http://a.test/3"),
    ]);
    expect(scan).toMatchObject({
      status: "partial",
      reason: "link check time budget (1s) exhausted",
    });
    // The deadline starts with the first request: 0 and 600 ms start in
    // budget, 1200 ms does not.
    expect(scan.records.map((record) => record.result?.status)).toEqual([
      "ok",
      "ok",
      "unchecked",
    ]);
  });
});

import { describe, expect, test } from "vitest";
import { requestEndAt } from "../src/capture/console-provenance.js";
import { matchesCspConsoleLine } from "../src/capture/csp-violations.js";
import { redactUrlSecrets } from "../src/capture/server-diagnosis.js";
import { ServerLog, type ServerLogLine } from "../src/capture/server-log.js";
import type { ConsoleRecord } from "../src/capture/types.js";
import { consoleErrorCheck } from "../src/checks/console-error.js";
import type { CheckTuple, FindingCandidate } from "../src/checks/types.js";
import { parseConsole, parseServerLog } from "../src/review/artifacts.js";

function tuple(overrides: Partial<CheckTuple> = {}): CheckTuple {
  return {
    flow: "booking",
    state: "ready",
    viewport: "phone",
    width: 320,
    height: 600,
    metadataPath: "ready/phone/metadata.json",
    artifactPaths: ["ready/phone/metadata.json"],
    commit: "abc123",
    createdAt: "2026-11-06T12:00:00.000Z",
    console: [],
    mismatches: [],
    ...overrides,
  };
}

const findings = (value: CheckTuple): FindingCandidate[] =>
  consoleErrorCheck.run({ tuple: value } as Parameters<
    typeof consoleErrorCheck.run
  >[0]).candidates;

const T = Date.parse("2026-11-06T12:00:00.000Z");
const failed =
  "Failed to load resource: the server responded with a status of 500 (Internal Server Error)";

function failedRequest(
  request: Partial<NonNullable<ConsoleRecord["request"]>> = {},
): ConsoleRecord {
  return {
    type: "error",
    text: failed,
    location: {
      url: "http://127.0.0.1:3100/preview/123?thumbnail=1",
      lineNumber: 0,
      columnNumber: 0,
    },
    request: {
      resourceType: "image",
      mainFrame: true,
      method: "GET",
      url: "http://127.0.0.1:3100/preview/123?thumbnail=1",
      status: 500,
      at: T,
      ...request,
    },
  };
}

const logLine = (offsetMs: number, text = `line at ${offsetMs}`) =>
  ({ at: T + offsetMs, stream: "stderr", text }) satisfies ServerLogLine;

describe("redactUrlSecrets", () => {
  test("redacts secret-named query values and keeps everything else", () => {
    expect(redactUrlSecrets("http://a.test/p?token=abc&page=2")).toBe(
      "http://a.test/p?token=[redacted]&page=2",
    );
    expect(
      redactUrlSecrets(
        "http://a.test/p?api_key=1&X-Api-Key=2&client_secret=3&keyboard=1",
      ),
    ).toBe(
      "http://a.test/p?api_key=[redacted]&X-Api-Key=[redacted]&client_secret=[redacted]&keyboard=1",
    );
  });

  test("keeps encoding, drops the fragment and leaves unparseable input", () => {
    expect(redactUrlSecrets("http://a.test/p?q=a%20b&x=%2F#frag")).toBe(
      "http://a.test/p?q=a%20b&x=%2F",
    );
    expect(redactUrlSecrets("not a url ?token=1")).toBe("not a url ?token=1");
    expect(redactUrlSecrets("http://a.test/p#x")).toBe("http://a.test/p");
  });
});

describe("ServerLog", () => {
  test("splits lines across chunks, stamps and redacts them, flushes the tail", () => {
    let now = 1_000;
    const log = new ServerLog({ API_TOKEN: "s3cret" }, 1024, () => now);
    log.append("stdout", "hel");
    now = 2_000;
    log.append("stdout", "lo\nworld s3cret\nparti");
    log.append("stderr", "boom\r\n");
    log.flush();
    expect(log.lines()).toEqual([
      { at: 2_000, stream: "stdout", text: "hello" },
      { at: 2_000, stream: "stdout", text: "world [redacted API_TOKEN]" },
      { at: 2_000, stream: "stderr", text: "boom" },
      { at: 2_000, stream: "stdout", text: "parti" },
    ]);
    expect(log.render()).toContain(
      `${new Date(2_000).toISOString()} stderr boom\n`,
    );
  });

  test("drops the oldest lines first past the byte cap", () => {
    const log = new ServerLog({}, 100, () => 0);
    for (let index = 0; index < 10; index += 1)
      log.append("stdout", `line ${index}\n`);
    const lines = log.lines();
    expect(lines.at(-1)?.text).toBe("line 9");
    expect(lines[0]?.text).not.toBe("line 0");
    expect(Buffer.byteLength(log.render())).toBeLessThanOrEqual(100);
    const huge = new ServerLog({}, 100, () => 0);
    huge.append("stdout", `${"x".repeat(500)}\n`);
    expect(Buffer.byteLength(huge.render())).toBeLessThanOrEqual(100);
  });

  test("round-trips through server.log parsing", () => {
    const log = new ServerLog({}, 1024, () => T);
    log.append("stderr", "render timed out for preview 123\n");
    expect(parseServerLog(`${log.render()}garbage\n`)).toEqual([
      { at: T, stream: "stderr", text: "render timed out for preview 123" },
    ]);
  });
});

describe("requestEndAt", () => {
  test("converts the monotonic end to wall time", () => {
    expect(
      requestEndAt({ wallTimeMs: 1_000_000, monotonic: 50, endMonotonic: 55 }),
    ).toBe(1_005_000);
    expect(
      requestEndAt({ wallTimeMs: 1_000_000, monotonic: 50 }),
    ).toBeUndefined();
    expect(
      requestEndAt({ wallTimeMs: 1_000_000, monotonic: 50, endMonotonic: 49 }),
    ).toBe(1_000_000);
  });
});

describe("matchesCspConsoleLine", () => {
  const explicit = `Refused to apply inline style because it violates the following Content Security Policy directive: "style-src-attr 'none'". Either the 'unsafe-inline' keyword, a hash ('sha256-…'), or a nonce ('nonce-...') is required to enable inline execution. Note that hashes do not apply to event handlers, style attributes and javascript: navigations unless the 'unsafe-hashes' keyword is present.`;
  const fallback = `Refused to apply inline style because it violates the following Content Security Policy directive: "style-src 'self'". Either the 'unsafe-inline' keyword, a hash ('sha256-…'), or a nonce ('nonce-...') is required to enable inline execution. Note that 'style-src-attr' was not explicitly set, so 'style-src' is used as a fallback.`;

  // Verbatim from the srcdoc fixture's console.jsonl (Chromium 14x).
  const current = `Applying inline style violates the following Content Security Policy directive 'style-src-attr 'none''. Either the 'unsafe-inline' keyword, a hash ('sha256-8f935d27GvUutRyY9yWScUMiFUk4WTdZURISiYfPOeQ='), or a nonce ('nonce-...') is required to enable inline execution. Note that hashes do not apply to event handlers, style attributes and javascript: navigations unless the 'unsafe-hashes' keyword is present. The action has been blocked.`;

  test("matches the current Chromium wording", () => {
    expect(
      matchesCspConsoleLine(current, {
        effectiveDirective: "style-src-attr",
        violatedDirective: "style-src-attr",
      }),
    ).toBe(true);
    expect(
      matchesCspConsoleLine(current, {
        effectiveDirective: "style-src",
        violatedDirective: "style-src",
      }),
    ).toBe(false);
  });

  test("matches the explicitly set directive", () => {
    expect(
      matchesCspConsoleLine(explicit, {
        effectiveDirective: "style-src-attr",
        violatedDirective: "style-src-attr",
      }),
    ).toBe(true);
  });

  test("matches through either directive on a fallback note", () => {
    expect(
      matchesCspConsoleLine(fallback, {
        effectiveDirective: "style-src-attr",
        violatedDirective: "style-src",
      }),
    ).toBe(true);
  });

  test("respects token boundaries and needs a CSP directive message", () => {
    expect(
      matchesCspConsoleLine(explicit, {
        effectiveDirective: "style-src",
        violatedDirective: "style-src",
      }),
    ).toBe(false);
    expect(
      matchesCspConsoleLine(`Something "style-src-attr" happened`, {
        effectiveDirective: "style-src-attr",
        violatedDirective: "style-src-attr",
      }),
    ).toBe(false);
  });
});

describe("console-error findings", () => {
  test("name the failed request by method, path and status", () => {
    const [finding] = findings(
      tuple({
        documentUrl: "http://127.0.0.1:3100/",
        console: [failedRequest()],
      }),
    );
    expect(finding?.explanation).toMatch(
      /^GET \/preview\/123\?thumbnail=1 returned 500\. console\.error occurred during capture: Failed to load resource/,
    );
    expect(finding?.verification.params).toMatchObject({
      method: "GET",
      url: "http://127.0.0.1:3100/preview/123?thumbnail=1",
      status: 500,
    });
  });

  test("names a cross-origin request by its full URL and a failure without status", () => {
    const [finding] = findings(
      tuple({
        documentUrl: "http://127.0.0.1:3100/",
        console: [
          failedRequest({
            url: "https://cdn.test/a.png",
            status: undefined,
          }),
        ],
      }),
    );
    expect(finding?.explanation).toMatch(
      /^GET https:\/\/cdn\.test\/a\.png failed\./,
    );
  });

  test("attach server log lines within 2 s of the request", () => {
    const lines = [
      logLine(-3_000),
      logLine(-1_500),
      logLine(1_500),
      logLine(3_000),
    ];
    const [finding] = findings(
      tuple({ console: [failedRequest()], serverLog: lines }),
    );
    expect(finding?.serverLogExcerpt?.split("\n")).toEqual([
      `${new Date(T - 1_500).toISOString()} stderr line at -1500`,
      `${new Date(T + 1_500).toISOString()} stderr line at 1500`,
    ]);
    expect(finding?.explanation).toContain("server.log has 2 lines");
  });

  test("caps the excerpt at 20 lines", () => {
    const lines = Array.from({ length: 30 }, (_, index) => logLine(index * 10));
    const [finding] = findings(
      tuple({ console: [failedRequest()], serverLog: lines }),
    );
    expect(finding?.serverLogExcerpt?.split("\n")).toHaveLength(20);
  });

  test("extends the window to 2 s after a slow response ends", () => {
    const lines = [logLine(6_000), logLine(7_500)];
    const [slow] = findings(
      tuple({
        console: [failedRequest({ endAt: T + 5_000 })],
        serverLog: lines,
      }),
    );
    expect(slow?.serverLogExcerpt).toContain("line at 6000");
    expect(slow?.serverLogExcerpt).not.toContain("line at 7500");
    const [unknownEnd] = findings(
      tuple({ console: [failedRequest()], serverLog: lines }),
    );
    expect(unknownEnd?.serverLogExcerpt).toBeUndefined();
  });

  test("attach no server log to a 4xx", () => {
    const [finding] = findings(
      tuple({
        console: [failedRequest({ status: 404 })],
        serverLog: [logLine(0)],
      }),
    );
    expect(finding?.serverLogExcerpt).toBeUndefined();
    expect(finding?.explanation).not.toContain("server.log");
  });

  test("name the CSP directive, element and owner iframe", () => {
    const [finding] = findings(
      tuple({
        console: [
          {
            type: "error",
            text: "Refused to apply inline style because …",
            location: { url: "about:srcdoc", lineNumber: 1, columnNumber: 0 },
            csp: {
              directive: "style-src-attr",
              violatedDirective: "style-src-attr",
              blocked: "inline",
              element: "html > body > div:nth-of-type(1)",
              frame: "#preview",
              documentUrl: "about:srcdoc",
            },
          },
        ],
      }),
    );
    expect(finding?.explanation).toMatch(
      /^Content Security Policy blocked inline style on html > body > div:nth-of-type\(1\) \(style-src-attr\) inside iframe #preview\. console\.error occurred during capture: Refused to apply inline style/,
    );
    expect(finding?.selectorHint).toBe(
      "csp | style-src-attr | #preview | html > body > div:nth-of-type(1) | inline",
    );
  });

  test("render legacy records exactly as before", () => {
    const [finding] = findings(
      tuple({
        console: [
          {
            type: "error",
            text: failed,
            location: {
              url: "http://127.0.0.1:3100/preview/123",
              lineNumber: 0,
              columnNumber: 0,
            },
            request: { resourceType: "image", mainFrame: true },
          },
        ],
      }),
    );
    expect(finding?.explanation).toBe(
      `console.error occurred during capture: ${failed}`,
    );
    expect(finding?.selectorHint).toBe(
      `error | http://127.0.0.1:3100/preview/123:0:0 | ${failed}`,
    );
  });
});

describe("console.jsonl parsing", () => {
  test("accepts the new fields, rejects mistyped ones and keeps old records", () => {
    const parse = (...records: unknown[]) =>
      parseConsole(
        records.map((record) => JSON.stringify(record)).join("\n"),
        "console.jsonl",
      );
    expect(
      parse(failedRequest({ endAt: T + 10 }), { type: "error", text: "old" }),
    ).toHaveLength(2);
    expect(() =>
      parse(failedRequest({ status: "500" as unknown as number })),
    ).toThrow(/request must be/);
    expect(() =>
      parse({ type: "error", text: "x", csp: { directive: "style-src-attr" } }),
    ).toThrow(/csp must be/);
  });
});

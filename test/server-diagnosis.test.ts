import { describe, expect, test } from "vitest";
import {
  missingEnvironmentVariable,
  serverFailureHint,
  stderrTail,
} from "../src/capture/server-diagnosis.js";
import { projectSchema } from "../src/schemas/project.js";

function project(server: Record<string, unknown> = {}) {
  return projectSchema.parse({
    version: 1,
    app: { name: "hints", framework: "other" },
    server: {
      build: "true",
      start: "npm start",
      readyUrl: "http://127.0.0.1:3100/",
      port: 3100,
      env: {},
      ...server,
    },
    viewports: [{ name: "desktop", width: 800, height: 600 }],
    capture: {},
    design: {},
    model: { provider: "anthropic", model: "unused" },
  });
}

describe("stderrTail", () => {
  test("keeps the last two non-empty lines, joined", () => {
    expect(stderrTail("one\n\ntwo\nthree\n\n", "", {})).toBe("two / three");
  });
  test("caps a long line", () => {
    const tail = stderrTail("x".repeat(500), "", {});
    expect(tail).toHaveLength(240);
    expect(tail.endsWith("…")).toBe(true);
  });
  test("redacts secret-named variables", () => {
    expect(stderrTail("token abc123", "", { API_TOKEN: "abc123" })).toBe(
      "token [redacted API_TOKEN]",
    );
  });
  test("falls back to combined output, then to 'no output'", () => {
    expect(stderrTail("", "listening\n", {})).toBe("listening");
    expect(stderrTail("", "", {})).toBe("no output");
  });
});

describe("missingEnvironmentVariable", () => {
  test.each([
    ["Error: DATABASE_URL is not set", "DATABASE_URL"],
    ["ERROR: SESSION_SECRET is required", "SESSION_SECRET"],
    ["`STRIPE_KEY` must be set", "STRIPE_KEY"],
    [
      "Missing required environment variable: NEXT_PUBLIC_API",
      "NEXT_PUBLIC_API",
    ],
    ["Cannot read properties of undefined (reading 'x')", undefined],
    ["ERROR is not set", undefined],
  ])("%s", (output, expected) => {
    expect(missingEnvironmentVariable(output)).toBe(expected);
  });
});

describe("serverFailureHint", () => {
  test("a missing variable points at server.env", () => {
    expect(
      serverFailureHint({
        cause: "server-exited",
        output: "Error: DATABASE_URL is not set",
        project: project(),
      }),
    ).toBe("add DATABASE_URL to server.env in .idiom/project.json");
  });
  test("a variable already in server.env says so", () => {
    expect(
      serverFailureHint({
        cause: "server-exited",
        output: "DATABASE_URL is not set",
        project: project({ env: { DATABASE_URL: "x" } }),
      }),
    ).toMatch(/^DATABASE_URL is already in server\.env/);
  });
  test("a pinned port suggests fixedPort or --port", () => {
    expect(
      serverFailureHint({
        cause: "port-pinned",
        output: "",
        project: project(),
        configuredPort: 3100,
      }),
    ).toBe(
      'set "server.fixedPort": true in .idiom/project.json, or pass --port 3100',
    );
  });
  test("a port in use names the port", () => {
    expect(
      serverFailureHint({
        cause: "port-in-use",
        output: "",
        project: project(),
        port: 4200,
      }),
    ).toBe("stop the process on port 4200, or change server.port");
    expect(
      serverFailureHint({
        cause: "server-exited",
        output: "Error: listen EADDRINUSE: address already in use :::5173",
        project: project(),
      }),
    ).toBe("stop the process on port 5173, or change server.port");
  });
  test("a timeout with a different reported URL suspects readyUrl", () => {
    expect(
      serverFailureHint({
        cause: "server-timeout",
        output: "  ➜  Local:   http://localhost:5173/",
        project: project(),
      }),
    ).toBe(
      "server.readyUrl may be wrong: the server reported http://localhost:5173",
    );
  });
  test("a silent timeout asks for a 200 readiness URL", () => {
    expect(
      serverFailureHint({
        cause: "server-timeout",
        output: "",
        project: project(),
      }),
    ).toBe(
      "make server.readyUrl (http://127.0.0.1:3100/) return 200 once the app is up, or raise server.startupTimeoutMs",
    );
  });
  test("a generic exit suggests running the start command or doctor", () => {
    expect(
      serverFailureHint({
        cause: "server-exited",
        output: "segfault",
        project: project(),
      }),
    ).toMatch(/idiom doctor/);
  });
});

import { readFile } from "node:fs/promises";
import { type Browser, chromium } from "playwright";
import { afterAll, beforeAll, expect, test } from "vitest";
import { checksConfigHash } from "../src/baseline/config-hash.js";
import {
  classifyDevServer,
  type DevServerFacts,
  detectDevServer,
  devServerWarning,
} from "../src/capture/dev-server.js";
import { devServerRecord } from "../src/capture/run.js";
import { runRecordSchema } from "../src/capture/run-record.js";
import { skipped } from "../src/capture/timings.js";
import { projectSchema } from "../src/schemas/project.js";
import { readTemplate } from "../src/templates.js";

const production: DevServerFacts = {
  scriptSrcs: ["http://localhost:3000/assets/index-4f9c2b1a.js"],
  overlays: [],
  nextBuildId: "a1b2c3",
  reactDevelopment: false,
};

test("each development-server sign is classified, first match wins", () => {
  expect(classifyDevServer(production)).toBeUndefined();
  expect(
    classifyDevServer({
      ...production,
      scriptSrcs: ["http://localhost:5173/@vite/client"],
      reactDevelopment: true,
    }),
  ).toEqual({ kind: "vite-client", evidence: "script /@vite/client" });
  expect(
    classifyDevServer({
      ...production,
      scriptSrcs: ["http://localhost:8080/webpack-dev-server.js"],
    }),
  ).toEqual({
    kind: "webpack-dev-server",
    evidence: "script /webpack-dev-server.js",
  });
  expect(
    classifyDevServer({ ...production, overlays: ["vite-error-overlay"] }),
  ).toEqual({
    kind: "error-overlay",
    evidence: "<vite-error-overlay> element",
  });
  expect(
    classifyDevServer({
      ...production,
      overlays: ["#webpack-dev-server-client-overlay"],
    }),
  ).toEqual({
    kind: "error-overlay",
    evidence: "#webpack-dev-server-client-overlay overlay element",
  });
  expect(
    classifyDevServer({ ...production, nextBuildId: "development" }),
  ).toMatchObject({ kind: "next-development" });
  expect(
    classifyDevServer({
      ...production,
      scriptSrcs: ["/_next/static/development/_buildManifest.js"],
    }),
  ).toMatchObject({ kind: "next-development" });
  expect(
    classifyDevServer({
      ...production,
      scriptSrcs: [
        "https://unpkg.com/react-dom@18/umd/react-dom.development.js",
      ],
    }),
  ).toEqual({
    kind: "react-development",
    evidence: "script /react-dom@18/umd/react-dom.development.js",
  });
  expect(classifyDevServer({ ...production, reactDevelopment: true })).toEqual({
    kind: "react-development",
    evidence: "React development build (fiber debug fields)",
  });
  // Production React builds are not development builds.
  expect(
    classifyDevServer({
      ...production,
      scriptSrcs: [
        "https://unpkg.com/react-dom@18/umd/react-dom.production.min.js",
      ],
    }),
  ).toBeUndefined();
});

let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch();
});
afterAll(async () => {
  await browser.close();
});

async function detectFixture(name: string) {
  const html = await readFile(
    new URL(`./fixtures/dev-server/${name}`, import.meta.url),
    "utf8",
  );
  const page = await browser.newPage();
  try {
    await page.route("http://idiom.test/**", async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === "/")
        await route.fulfill({ contentType: "text/html", body: html });
      else if (url.pathname.endsWith(".css"))
        await route.fulfill({ contentType: "text/css", body: "" });
      // Scripts resolve to empty modules: a dev client never runs here.
      else await route.fulfill({ contentType: "text/javascript", body: "" });
    });
    await page.goto("http://idiom.test/");
    return await detectDevServer(page);
  } finally {
    await page.close();
  }
}

test("a Vite dev page is detected in the browser; a production page is not", async () => {
  expect(await detectFixture("vite-dev.html")).toEqual({
    kind: "vite-client",
    evidence: "script /@vite/client",
  });
  expect(await detectFixture("production.html")).toBeUndefined();
});

test("a React development build is detected from its fiber debug fields", async () => {
  const page = await browser.newPage();
  try {
    await page.setContent("<main><button>Book</button></main>");
    // A development fiber carries _debugOwner; production fibers do not.
    await page.evaluate(() => {
      const button = document.querySelector("button") as unknown as Record<
        string,
        unknown
      >;
      button.__reactFiber$abc = { _debugOwner: null, tag: 5 };
    });
    expect(await detectDevServer(page)).toMatchObject({
      kind: "react-development",
    });
    await page.evaluate(() => {
      const button = document.querySelector("button") as unknown as Record<
        string,
        unknown
      >;
      button.__reactFiber$abc = { tag: 5 };
    });
    expect(await detectDevServer(page)).toBeUndefined();
  } finally {
    await page.close();
  }
});

test("detection never throws", async () => {
  const failing = {
    evaluate: async () => {
      throw new Error("Execution context was destroyed");
    },
  } as unknown as Parameters<typeof detectDevServer>[0];
  expect(await detectDevServer(failing)).toBeUndefined();
});

const minimalRun = {
  version: 1,
  flow: "booking",
  source: { commit: "abc1234", dirty: false },
  declared: [{ state: "home", viewport: "desktop", colorScheme: "light" }],
  selected: [{ state: "home", viewport: "desktop", colorScheme: "light" }],
  viewports: [{ name: "desktop", width: 1440, height: 900 }],
  probe: {
    policy: "once-per-state",
    fallback: false,
    intended: [],
    executed: [],
  },
  timings: {
    build: skipped(),
    start: skipped(),
    tuples: [
      {
        state: "home",
        viewport: "desktop",
        colorScheme: "light",
        total: skipped(),
        probe: skipped(),
      },
    ],
    probe: skipped(),
    checks: skipped(),
  },
};

test("run.json records the dev-server sign optionally", () => {
  expect(runRecordSchema.safeParse(minimalRun).success).toBe(true);
  const recorded = {
    kind: "vite-client",
    evidence: "script /@vite/client",
    state: "home",
    viewport: "desktop",
    colorScheme: "light",
  };
  expect(
    runRecordSchema.parse({ ...minimalRun, devServer: recorded }).devServer,
  ).toEqual(recorded);
  expect(
    runRecordSchema.safeParse({
      ...minimalRun,
      devServer: { ...recorded, kind: "parcel" },
    }).success,
  ).toBe(false);
});

test("the first sign in selected-tuple order is recorded", () => {
  const tuple = (
    state: string,
    viewport: string,
    devServer?: { kind: "vite-client"; evidence: string },
  ) => ({
    state: { id: state },
    viewport: { name: viewport },
    colorScheme: "light" as const,
    result: { ok: true, ...(devServer ? { devServer } : {}) },
  });
  const selected = [
    { state: "home", viewport: "desktop", colorScheme: "light" as const },
    { state: "home", viewport: "mobile", colorScheme: "light" as const },
    { state: "book", viewport: "desktop", colorScheme: "light" as const },
  ];
  const sign = {
    kind: "vite-client" as const,
    evidence: "script /@vite/client",
  };
  const tuples = [
    tuple("book", "desktop", { ...sign, evidence: "later" }),
    tuple("home", "desktop"),
    tuple("home", "mobile", sign),
  ] as unknown as Parameters<typeof devServerRecord>[0];
  expect(devServerRecord(tuples, selected)).toEqual({
    devServer: {
      ...sign,
      state: "home",
      viewport: "mobile",
      colorScheme: "light",
    },
  });
  expect(
    devServerRecord(
      [tuple("home", "desktop")] as unknown as Parameters<
        typeof devServerRecord
      >[0],
      selected,
    ),
  ).toEqual({});
});

test("the warning names the sign, server.build and checks.devServer", () => {
  const line = devServerWarning("booking", {
    kind: "vite-client",
    evidence: "script /@vite/client",
    state: "home",
    viewport: "mobile",
  });
  expect(line).toMatch(/^Warning: booking looks like/);
  expect(line).toContain("script /@vite/client on home/mobile");
  expect(line).toContain("server.build");
  expect(line).toContain('checks.devServer to "allow"');
});

test("checks.devServer is allow or warn, and never changes the config hash", async () => {
  const base = JSON.parse(await readTemplate("project.json"));
  const plain = projectSchema.parse(base);
  const allowed = projectSchema.parse({
    ...base,
    checks: { ...base.checks, devServer: "allow" },
  });
  expect(allowed.checks.devServer).toBe("allow");
  expect(plain.checks.devServer).toBeUndefined();
  expect(checksConfigHash(allowed.checks)).toBe(checksConfigHash(plain.checks));
  expect(
    projectSchema.safeParse({ ...base, checks: { devServer: "off" } }).success,
  ).toBe(false);
});

import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { type Browser, chromium, request } from "playwright";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createLinkChecker } from "../src/capture/links.js";
import type {
  FontObservation,
  LinkObservation,
  ObservationArtifact,
} from "../src/checks/types.js";
import { type ReviewOptions, reviewFixture } from "./benchmark-support.js";

/**
 * Craft rules (file-170): each rule has a defect page that must produce the
 * finding and a fixed page that must produce no finding from any craft rule.
 * Pages are served over local HTTP so fonts and links resolve as in capture.
 */
const craftCategories = [
  "font-loading",
  "broken-link",
  "focus-visible",
  "line-length",
  "orphan-word",
  "image-distortion",
  "broken-image",
  "layout-shift",
] as const;

const directory = join(import.meta.dirname, "fixtures/craft-rules");
let server: Server;
let origin: string;
let browser: Browser;

beforeAll(async () => {
  server = createServer(async (req, res) => {
    const path = new URL(req.url ?? "/", "http://localhost").pathname;
    if (path === "/pricing") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<!doctype html><title>Pricing</title><h1>Pricing</h1>");
      return;
    }
    if (path === "/fonts/latin.ttf") {
      res.writeHead(200, { "content-type": "font/ttf" });
      res.end(await readFile(join(directory, "fonts/latin.ttf")));
      return;
    }
    if (/^\/[a-z-]+\.html$/.test(path)) {
      try {
        const body = await readFile(join(directory, path.slice(1)));
        res.writeHead(200, { "content-type": "text/html" });
        res.end(body);
        return;
      } catch {}
    }
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  browser = await chromium.launch();
});

afterAll(async () => {
  await browser?.close();
  await new Promise((resolve) => server?.close(resolve));
});

const linkChecker = (external = false) =>
  createLinkChecker({
    external,
    timeoutMs: 5000,
    budgetMs: 30000,
    concurrency: 4,
    ignore: [],
    request: () => request.newContext(),
  });

async function review(name: string, options: Omit<ReviewOptions, "url"> = {}) {
  const checker = options.links ?? linkChecker();
  try {
    return await reviewFixture(browser, "", {
      url: `${origin}/${name}`,
      settleMs: 500,
      focusSweep: true,
      ...options,
      links: checker,
    });
  } finally {
    if (options.links === undefined) await checker.dispose();
  }
}

const expected: Record<
  (typeof craftCategories)[number],
  { severity: "major" | "minor"; mentions: string[] }
> = {
  "font-loading": {
    severity: "major",
    mentions: ["brand display", "/fonts/missing.woff2", "h1"],
  },
  "broken-link": {
    severity: "major",
    mentions: ["Pricing", "/missing", "404"],
  },
  "focus-visible": { severity: "major", mentions: ["Save changes"] },
  "line-length": { severity: "minor", mentions: ["p.long"] },
  "orphan-word": { severity: "minor", mentions: ["“now”"] },
  "image-distortion": { severity: "major", mentions: ["40×20"] },
  "broken-image": { severity: "major", mentions: ["broken image"] },
  "layout-shift": { severity: "minor", mentions: ["cumulative layout shift"] },
};

describe("craft rule fixture pairs", () => {
  for (const category of craftCategories) {
    test(`${category}: the defect is found and the fix is clean`, async () => {
      const before = await review(`${category}-before.html`);
      const hits = before.filter(
        ({ candidate }) => candidate.category === category,
      );
      expect(hits.length, JSON.stringify(before, null, 2)).toBeGreaterThan(0);
      const [hit] = hits;
      expect(hit?.candidate.severity).toBe(expected[category].severity);
      for (const mention of expected[category].mentions)
        expect(hit?.candidate.explanation).toContain(mention);

      const after = await review(`${category}-after.html`);
      expect(
        after
          .filter(({ candidate }) =>
            (craftCategories as readonly string[]).includes(candidate.category),
          )
          .map(({ candidate }) => candidate.explanation),
      ).toEqual([]);
    });
  }

  test("external links are unchecked by default and judged when opted in", async () => {
    let links: LinkObservation[] = [];
    const capture = (observations: ObservationArtifact) => {
      if (observations.version === 2) links = observations.links?.records ?? [];
    };
    const defaults = await review("broken-link-before.html", {
      onObservations: capture,
    });
    const external = links.find((link) => !link.sameOrigin);
    expect(external?.result).toEqual({
      status: "unchecked",
      reason: "external links are not checked (checks.links.external)",
    });
    expect(
      defaults.filter(
        ({ candidate }) =>
          candidate.category === "broken-link" &&
          candidate.explanation.includes("invalid"),
      ),
    ).toEqual([]);

    const checker = linkChecker(true);
    try {
      const opted = await review("broken-link-before.html", {
        links: checker,
        checks: { links: { external: true } },
      });
      const dns = opted.find(
        ({ candidate }) =>
          candidate.category === "broken-link" &&
          candidate.explanation.includes("docs.idiom-broken.invalid"),
      );
      expect(dns?.candidate.severity).toBe("minor");
      expect(dns?.candidate.explanation).toContain("DNS lookup failed");
    } finally {
      await checker.dispose();
    }
  });
});

describe("craft rule regressions", () => {
  test("font-loading: a loaded font is not a fallback for text it has no glyphs for", async () => {
    let fonts: FontObservation | undefined;
    const findings = await review("font-loading-after.html", {
      onObservations: (observations) => {
        if (observations.version === 2) fonts = observations.fonts;
      },
    });
    expect(fonts?.faces).toEqual([
      expect.objectContaining({ family: "brand display", status: "loaded" }),
    ]);
    expect(fonts?.used).toEqual([
      {
        family: "brand display",
        selectors: ["span.brand", "body > main > h1"],
        fallback: false,
      },
    ]);
    expect(
      findings.filter(({ candidate }) => candidate.category === "font-loading"),
    ).toEqual([]);
  });

  const page = (style: string, body: string) =>
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Craft rules</title><style>body{margin:0;padding:32px;font:16px/1.5 system-ui,sans-serif}button{font:inherit;padding:8px 16px;border:1px solid #1f2933;background:#fff}button:focus{outline:none}${style}</style></head><body>${body}</body></html>`;
  const named = (
    findings: Awaited<ReturnType<typeof review>>,
    category: string,
  ) =>
    findings
      .filter(({ candidate }) => candidate.category === category)
      .map(({ candidate }) => candidate.explanation)
      .join("\n");

  test("focus-visible: scrolling does not count as an indicator", async () => {
    const findings = await reviewFixture(
      browser,
      page(
        ".bar{position:fixed;bottom:0;left:0;right:0;padding:8px;background:#eee}.box{height:100px;overflow:auto}.box div{height:400px}",
        '<main><button type="button">Top</button><div style="height:3000px"></div><button type="button">Bottom</button><div class="box"><div></div><button type="button">Scrolled</button></div></main><div class="bar"><button type="button">Fixed CTA</button></div>',
      ),
      { focusSweep: true },
    );
    const explanations = named(findings, "focus-visible");
    for (const name of ["Top", "Bottom", "Scrolled", "Fixed CTA"])
      expect(explanations).toContain(`“${name}”`);
  });

  test("focus-visible: a skip link revealed on focus is visible", async () => {
    const findings = await reviewFixture(
      browser,
      page(
        ".skip{position:absolute;left:-9999px;top:0}.skip:focus{left:8px;outline:none}",
        '<a class="skip" href="#main">Skip to content</a><main id="main"><button type="button" style="outline:2px solid transparent">Plain</button></main>',
      ),
      { focusSweep: true },
    );
    const explanations = named(findings, "focus-visible");
    expect(explanations).not.toContain("Skip to content");
  });

  test("orphan-word: copy inside block card links is not a label", async () => {
    const cards = Array.from(
      { length: 12 },
      () =>
        '<a class="card" href="#plan"><h3>Starter</h3><p>aaaa bbbb cccc dddd eeeeeeeeeeeeeeeeee now</p></a>',
    ).join("");
    const findings = await reviewFixture(
      browser,
      page(
        ".card{display:block;width:20ch;margin:8px 0;font:16px/1.5 monospace}",
        `<main>${cards}</main>`,
      ),
      { focusSweep: true },
    );
    expect(named(findings, "orphan-word")).toBe("");
  });

  test("orphan-word: a button-like link label is still judged", async () => {
    const findings = await reviewFixture(
      browser,
      page(
        ".cta{display:inline-block;width:20ch;font:16px/1.5 monospace}",
        '<main><a class="cta" href="#plan"><span>aaaa bbbb cccc dddd</span> eeeeeeeeeeeeeeeeee now</a></main>',
      ),
      { focusSweep: true },
    );
    expect(named(findings, "orphan-word")).toContain("“now”");
  });
});

import type { Page } from "playwright";

/**
 * Signs that a captured page came from a development server. Dev servers add
 * overlays, unminified timing and dev-only warnings, which produce findings a
 * production build will not have.
 */
export const devServerKinds = [
  "vite-client",
  "webpack-dev-server",
  "error-overlay",
  "next-development",
  "react-development",
] as const;
export type DevServerKind = (typeof devServerKinds)[number];

export type DevServerSign = {
  kind: DevServerKind;
  /** A short phrase naming what was seen, e.g. `script /@vite/client`. */
  evidence: string;
};

/** Raw in-page facts; classified in Node so the rules are unit-testable. */
export type DevServerFacts = {
  scriptSrcs: string[];
  /** Overlay element names present: a tag name or `#id`. */
  overlays: string[];
  nextBuildId?: string | undefined;
  /** A React fiber carries development-only debug fields. */
  reactDevelopment: boolean;
};

/** Overlay elements framework dev servers mount; tag names or `#id`. */
export const DEV_OVERLAYS = [
  "vite-error-overlay",
  "nextjs-portal",
  "#webpack-dev-server-client-overlay",
  "#react-refresh-overlay",
] as const;

/** One self-contained evaluate: no closures over Node values. */
export async function collectDevServerFacts(
  page: Pick<Page, "evaluate">,
): Promise<DevServerFacts> {
  return page.evaluate((overlaySelectors: readonly string[]) => {
    const scriptSrcs: string[] = [];
    for (const script of Array.from(document.scripts)) {
      if (script.src) scriptSrcs.push(script.src);
      const attribute = script.getAttribute("src");
      if (attribute && attribute !== script.src) scriptSrcs.push(attribute);
    }
    const overlays = overlaySelectors.filter(
      (selector) => document.querySelector(selector) !== null,
    );
    let nextBuildId: string | undefined;
    const nextData = document.getElementById("__NEXT_DATA__");
    if (nextData?.textContent) {
      try {
        const parsed = JSON.parse(nextData.textContent) as {
          buildId?: unknown;
        };
        if (typeof parsed.buildId === "string") nextBuildId = parsed.buildId;
      } catch {
        // Unreadable data is no sign either way.
      }
    }
    let reactDevelopment = false;
    const elements = document.querySelectorAll("*");
    const limit = Math.min(elements.length, 200);
    for (let index = 0; index < limit && !reactDevelopment; index += 1) {
      const element = elements[index] as unknown as Record<string, unknown>;
      for (const key of Object.keys(element)) {
        if (!key.startsWith("__reactFiber$")) continue;
        const fiber = element[key];
        if (
          fiber !== null &&
          typeof fiber === "object" &&
          (Object.hasOwn(fiber, "_debugOwner") ||
            Object.hasOwn(fiber, "_debugSource"))
        ) {
          reactDevelopment = true;
          break;
        }
      }
    }
    return {
      scriptSrcs,
      overlays,
      ...(nextBuildId === undefined ? {} : { nextBuildId }),
      reactDevelopment,
    };
  }, DEV_OVERLAYS);
}

function scriptPath(src: string): string {
  try {
    return new URL(src, "http://localhost/").pathname;
  } catch {
    return src;
  }
}

/** The first development-server sign in the facts, or undefined. */
export function classifyDevServer(
  facts: DevServerFacts,
): DevServerSign | undefined {
  const vite = facts.scriptSrcs.find((src) =>
    scriptPath(src).endsWith("/@vite/client"),
  );
  if (vite !== undefined)
    return { kind: "vite-client", evidence: `script ${scriptPath(vite)}` };
  const webpack = facts.scriptSrcs.find((src) =>
    /webpack-dev-server|__webpack_hmr|webpack-hot-middleware/.test(src),
  );
  if (webpack !== undefined)
    return {
      kind: "webpack-dev-server",
      evidence: `script ${scriptPath(webpack)}`,
    };
  const overlay = facts.overlays[0];
  if (overlay !== undefined)
    return {
      kind: "error-overlay",
      evidence: overlay.startsWith("#")
        ? `${overlay} overlay element`
        : `<${overlay}> element`,
    };
  if (facts.nextBuildId === "development")
    return {
      kind: "next-development",
      evidence: "Next.js development build (__NEXT_DATA__ buildId)",
    };
  const nextScript = facts.scriptSrcs.find((src) =>
    src.includes("/_next/static/development/"),
  );
  if (nextScript !== undefined)
    return {
      kind: "next-development",
      evidence: `script ${scriptPath(nextScript)}`,
    };
  const reactScript = facts.scriptSrcs.find((src) =>
    /react(-dom)?\.development(\.min)?\.js/.test(src),
  );
  if (reactScript !== undefined)
    return {
      kind: "react-development",
      evidence: `script ${scriptPath(reactScript)}`,
    };
  if (facts.reactDevelopment)
    return {
      kind: "react-development",
      evidence: "React development build (fiber debug fields)",
    };
  return undefined;
}

/** Collect then classify; detection never fails a capture. */
export async function detectDevServer(
  page: Pick<Page, "evaluate">,
): Promise<DevServerSign | undefined> {
  try {
    return classifyDevServer(await collectDevServerFacts(page));
  } catch {
    return undefined;
  }
}

/** The one warning line `capture` and `check` print. */
export function devServerWarning(
  flow: string,
  recorded: DevServerSign & { state: string; viewport: string },
): string {
  return `Warning: ${flow} looks like it was captured from a development server (${recorded.evidence} on ${recorded.state}/${recorded.viewport}). Dev servers add overlays, unminified timing and dev-only warnings that produce findings production won't have. Set server.build and a production start command in .idiom/project.json (see docs/configuration.md#production-builds), or set checks.devServer to "allow" to silence this.`;
}

import { IdiomError } from "../errors.js";
import type { DesignLocation } from "../schemas/design.js";
import { flowSchema, isWebFlow, type WebFlow } from "../schemas/flow.js";
import {
  type ChecksSettings,
  type ColorScheme,
  type Project,
  projectSchema,
} from "../schemas/project.js";

export type QuickConfiguration = {
  urls: string[];
  project: Project;
  flow: WebFlow;
};

export function normalizeQuickUrls(values: string[]): string[] {
  if (values.length === 0) {
    throw new IdiomError("quick review requires at least one URL");
  }
  const urls: URL[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new IdiomError(
        `quick review URL must be an absolute HTTP(S) URL: ${JSON.stringify(value)}`,
      );
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new IdiomError(
        `quick review URL must use HTTP or HTTPS: ${JSON.stringify(value)}`,
      );
    }
    if (url.username !== "" || url.password !== "") {
      throw new IdiomError(
        `quick review URL must not contain credentials: ${JSON.stringify(value)}`,
      );
    }
    if (seen.has(url.href)) {
      throw new IdiomError(`duplicate quick review URL: ${url.href}`);
    }
    seen.add(url.href);
    urls.push(url);
  }
  const origin = urls[0]?.origin;
  for (const url of urls.slice(1)) {
    if (url.origin !== origin) {
      throw new IdiomError(
        `quick review URLs must share one origin; received ${origin} and ${url.origin}`,
      );
    }
  }
  return urls.map((url) => url.href);
}

/**
 * A synthetic project and flow for literal URLs. Defaults are quick review's;
 * page review passes its own flow id, light-only capture and the user's
 * checks so configured selectors resolve at capture.
 */
export function createQuickConfiguration(
  values: string[],
  options: {
    design?: DesignLocation | undefined;
    flowId?: string | undefined;
    title?: string | undefined;
    colorSchemes?: ColorScheme[] | undefined;
    statePrefix?: string | undefined;
    checks?: ChecksSettings | undefined;
    viewports?: Array<"desktop" | "mobile"> | undefined;
  } = {},
): QuickConfiguration {
  const urls = normalizeQuickUrls(values);
  const colorSchemes = options.colorSchemes ?? ["light", "dark"];
  const title = options.title ?? "Quick review";
  const origin = new URL(urls[0] as string).origin;
  const project = projectSchema.parse({
    version: 1,
    app: { name: title, framework: "other" },
    server: {
      build: "",
      start: "",
      readyUrl: `${origin}/`,
      port: 0,
      env: {},
      startupTimeoutMs: 60_000,
    },
    viewports: [
      { name: "desktop", width: 1440, height: 900 },
      { name: "mobile", width: 390, height: 844 },
    ].filter(
      (viewport) =>
        options.viewports === undefined ||
        options.viewports.includes(viewport.name as "desktop" | "mobile"),
    ),
    colorSchemes,
    capture: {
      timezoneId: "America/New_York",
      locale: "en-US",
      colorScheme: "light",
      reducedMotion: true,
      fullPage: true,
      settleMs: 250,
    },
    design: {},
    model: {
      provider: "claude-code",
      model: "unavailable-in-quick-review",
      maxFindings: 5,
    },
    ...(options.checks === undefined ? {} : { checks: options.checks }),
  });
  const flow = flowSchema.parse({
    id: options.flowId ?? "quick-review",
    title,
    intent: [],
    setup: [],
    states: urls.map((url, index) => ({
      id: `${options.statePrefix ?? "page"}-${index + 1}`,
      description: url,
      ...(options.design === undefined ? {} : { design: options.design }),
      url,
      expect: { status: 200 },
      mask: [],
    })),
    viewports: options.viewports ?? ["desktop", "mobile"],
    colorSchemes,
  });
  if (!isWebFlow(flow)) throw new Error("quick flow must be web");
  return { urls, project, flow };
}

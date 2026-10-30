import {
  lstat,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { chromium, request } from "playwright";
import { summarizeFinding } from "../baseline/summary.js";
import { createBrowserLauncher } from "../capture/browser.js";
import { scrollbarLaunchOptions } from "../capture/scrollbars.js";
import type { CaptureActivity } from "../capture/types.js";
import { tupleDesigns } from "../design/evidence.js";
import { createQuickConfiguration } from "../quick/config.js";
import { renderInteractionSentences } from "../quick/interaction.js";
import { runQuick } from "../quick/run.js";
import { buildReviewCoverage } from "../report/coverage.js";
import { loadCaptureRun } from "../review/artifacts.js";
import { composeFilmstrip } from "../review/filmstrips.js";
import { LIMITS } from "./config.js";
import { HostedError } from "./errors.js";
import {
  guardContext,
  guardedLinkRequester,
  NetworkBudget,
} from "./network.js";
import { type Dialer, startProxy } from "./proxy.js";
import { validateOutput } from "./reports.js";
import {
  type HostedReport,
  imageInput,
  type ReviewInput,
  reportSchema,
} from "./schema.js";
import { type Resolver, resolvePublic } from "./ssrf.js";

/** Only code-injected seams for the maintained local harness; no env/request switch. */
export async function runWorker(
  input: ReviewInput,
  options: {
    runtimeHash: string;
    signal: AbortSignal;
    resolver?: Resolver;
    dial?: Dialer;
    onActivity?: (stage: CaptureActivity) => void;
  },
) {
  const started = performance.now();
  const budget = new NetworkBudget(options.signal);
  await resolvePublic(input.target, options.resolver, options.signal);
  if (input.reference)
    await resolvePublic(input.reference, options.resolver, options.signal);
  const directory = await mkdtemp(join(tmpdir(), "idiom-hosted-"));
  const proxy = await startProxy(budget, {
    ...(options.resolver ? { resolver: options.resolver } : {}),
    ...(options.dial ? { dial: options.dial } : {}),
  });
  try {
    let design: string | undefined;
    if (input.image) {
      const image = imageInput(input.image.bytes);
      design = join(directory, `design.${image.extension}`);
      await writeFile(design, image.bytes);
    }
    const launcher = createBrowserLauncher({
      launch: () =>
        chromium.launch({
          ...scrollbarLaunchOptions,
          proxy: { server: proxy.url, bypass: "<-loopback>" },
          args: [
            "--disable-quic",
            "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
            "--proxy-bypass-list=<-loopback>",
          ],
        }),
      contextOptions: { serviceWorkers: "block", acceptDownloads: false },
      prepareContext: (context, tuple) =>
        guardContext(context, tuple, budget, options.resolver),
      createLinkRequester: async () =>
        guardedLinkRequester(
          await request.newContext({
            proxy: { server: proxy.url },
            ignoreHTTPSErrors: false,
          }),
          budget,
          options.resolver,
        ),
    });
    const result = await runQuick({
      urls: [input.target],
      ...(design
        ? { designLocation: design }
        : input.reference
          ? { designLocation: { site: input.reference } }
          : {}),
      literal: true,
      materializeAllDeterministic: true,
      viewports: ["desktop", "mobile"],
      probe: true,
      probeBudgetMs: LIMITS.probeMs,
      cwd: directory,
      out: join(directory, "run"),
      dependencies: {
        browserLauncher: launcher,
        signal: options.signal,
        environment: {},
        onActivity: options.onActivity,
      },
    });
    options.signal.throwIfAborted();
    const loaded = await loadCaptureRun({
      runDirectory: result.runDirectory,
      expectedFlow: "quick-review",
    });
    if (
      loaded.tuples.every(
        (tuple) =>
          tuple.failure || (tuple.documentResponse?.actualStatus ?? 200) >= 400,
      )
    )
      throw new HostedError("failed");
    const assets = new Map<string, Buffer>();
    const sources = new Map<string, string>();
    const asset = async (source: string): Promise<string> => {
      const existing = sources.get(source);
      if (existing) return existing;
      if (
        !source.endsWith(".png") ||
        source.includes("\\") ||
        source.includes("\0")
      )
        throw new HostedError("failed");
      const root = await realpath(result.runDirectory);
      const path = resolve(root, source);
      const rel = relative(root, path);
      if (rel === ".." || rel.startsWith(`..${sep}`) || rel.startsWith(sep))
        throw new HostedError("failed");
      // Reject symlink components as well as a symlink leaf.
      let part = root;
      for (const component of rel.split(sep)) {
        part = join(part, component);
        if ((await lstat(part)).isSymbolicLink())
          throw new HostedError("failed");
      }
      const stat = await lstat(path);
      if (
        !stat.isFile() ||
        stat.size > LIMITS.assetBytes ||
        assets.size >= LIMITS.assets
      )
        throw new HostedError("report-too-large");
      const name = `asset-${assets.size}.png`;
      assets.set(name, await readFile(path));
      sources.set(source, name);
      return name;
    };
    const findings = new Map(
      result.findings?.map((finding) => [finding.id, finding]),
    );
    const groups = new Map(result.groups?.map((group) => [group.id, group]));
    const issues: HostedReport["issues"] = [];
    const filmstrips = new Set<string>();
    for (const issue of (result.issues ?? []).slice(0, 5)) {
      const finding = findings.get(
        groups.get(issue.groups[0] ?? "")?.representative ?? "",
      );
      const evidence: string[] = [];
      if (finding) {
        const crops =
          finding.evidence.designDrift?.crops?.map((crop) => crop.path) ??
          finding.evidence.screenshots.filter((path) =>
            path.includes("/crops/"),
          );
        for (const source of crops) evidence.push(await asset(source));
        if (!evidence.length && finding.evidence.screenshots[0])
          evidence.push(await asset(finding.evidence.screenshots[0]));
        if (finding.evidence.filmstrip?.sheet)
          filmstrips.add(await asset(finding.evidence.filmstrip.sheet));
      }
      issues.push({
        title: issue.rules.join(", ") || issue.category,
        severity: issue.severity,
        detail: finding
          ? summarizeFinding(
              finding,
              { runDirectory: result.runDirectory },
              directory,
            ).problem
          : `${issue.elements} measured elements in ${issue.places} places.`,
        assets: evidence,
      });
    }
    const designs = loaded.tuples.flatMap(tupleDesigns);
    if (!filmstrips.size) {
      for (const tuple of loaded.tuples) {
        const visual = tuple.filmstrips?.actions.find(
          (action) => action.status !== "unavailable",
        );
        const timeline = tuple.timelines?.actions.find(
          (action) => action.id === visual?.id,
        );
        if (!visual || !timeline) continue;
        const sheet = await composeFilmstrip({
          runDirectory: result.runDirectory,
          tuple,
          action: visual,
          timeline,
          selector: "",
          path: "hosted-filmstrip.png",
        });
        if (sheet.sheet) filmstrips.add(await asset(sheet.sheet));
        break;
      }
    }
    const available = designs.filter(
      (item) => item.descriptor.status === "captured" && !item.unavailable,
    );
    const designAssets: string[] = [];
    if (available.length) {
      const tuple = loaded.tuples.find((item) =>
        tupleDesigns(item).some((d) => available.includes(d)),
      );
      if (tuple?.screenshotPath)
        designAssets.push(await asset(tuple.screenshotPath));
      if (available[0]?.screenshotPath)
        designAssets.push(await asset(available[0].screenshotPath));
    }
    const configuration = createQuickConfiguration([input.target]);
    const engineCoverage = buildReviewCoverage({
      flow: configuration.flow,
      project: configuration.project,
      tuples: loaded.tuples,
      commit: loaded.commit,
      interaction: result.interaction,
    });
    const coverage = [
      "One submitted page; no crawl. At most three distinct external documents including reference, redirect and iframe pages.",
      "Desktop 1440×900 and mobile 390×844; light and dark; reduced motion. No model critique, accounts or authenticated states.",
      "Only GET, HEAD and OPTIONS permitted from initial load through teardown. Service workers, WebSockets, downloads and popups blocked.",
      "Strict third-party probe: 15 seconds on the desktop/light target only. Replays depend on eligible actions; other controls and variants are unmeasured.",
      ...renderInteractionSentences(result.interaction),
      ...engineCoverage.limitations,
      ...loaded.tuples.map(
        (tuple) =>
          `${tuple.viewport}/${tuple.colorScheme}: ${tuple.failure ? "capture unavailable" : "captured"}${tuple.failure ? "; findings for this surface are unmeasured" : ""}.`,
      ),
      ...budget.coverage(),
    ];
    if (budget.blocked.size)
      coverage.push(
        "Blocked resources can change appearance. Resource failures caused by hosted restrictions are omitted from Top issues; unaffected measured findings may still depend on the reduced page.",
      );
    // A blocked optional asset must not become a broken-resource finding.
    const filtered = budget.blocked.size
      ? issues.filter(
          (issue) =>
            !/broken|font-not-loaded|resource|console|uncaught|page.error/i.test(
              issue.title,
            ),
        )
      : issues;
    const comparison = available[0];
    const designDetail = comparison?.regions
      ? `${comparison.regions.regions.length} changed image regions; ${comparison.regions.uncompared.length} unmeasured regions; ${comparison.regions.omitted} changed regions omitted by engine limits. Image comparison cannot check semantic elements.`
      : comparison?.matches
        ? `${comparison.matches.pairs.length} matched reference elements; ${comparison.matches.unmatchedApp.length} unmatched app elements and ${comparison.matches.unmatchedDesign.length} unmatched reference elements.`
        : "Comparison evidence is available; unmeasured areas are not covered.";
    const report = reportSchema.parse({
      version: 1,
      target: input.target,
      runtimeHash: options.runtimeHash,
      issues: filtered,
      filmstrips: [...filmstrips],
      design: {
        status:
          input.reference || input.image
            ? available.length
              ? "compared"
              : "unavailable"
            : "none",
        detail:
          input.reference || input.image
            ? available.length
              ? designDetail
              : "Design input was unavailable; design drift was not checked."
            : "No design input supplied. Design drift was not checked.",
        assets: designAssets,
      },
      coverage,
      metrics: {
        elapsedMs: performance.now() - started,
        networkBytes: budget.bytes,
        requests: budget.requests,
        findings: result.findingCount,
      },
      assets: [...assets].map(([name, bytes]) => ({
        name,
        bytes: bytes.length,
      })),
    });
    validateOutput(report, assets);
    return { report, assets };
  } finally {
    await proxy.close();
    await rm(directory, { recursive: true, force: true });
  }
}

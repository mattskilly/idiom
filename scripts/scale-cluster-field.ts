// Field evidence for design-system questions (scale-conformance clusters).
// Usage: bun scripts/scale-cluster-field.ts <field-test scratch dir> --out <dir>
//
// Field targets declare no checks.scales, so a plain run cannot raise a
// declared-scale question. This replays each retained capture with the scale
// `idiom system --learn` drafts from the site's own CSS tokens (stylesheets
// the captured page loads; a repo target's own sources), then records every
// qualifying cluster with crops of its examples for rating. General evidence
// from each site's tokens, never per-site settings.
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import type { PNG } from "pngjs";
import {
  checksConfigFrom,
  runDeterministicChecks,
} from "../src/checks/registry.js";
import { scaleQuestions } from "../src/checks/scale-conformance.js";
import type {
  ChecksConfig,
  CheckTuple,
  ObservationArtifact,
} from "../src/checks/types.js";
import { initProject } from "../src/commands/init.js";
import { cropToFile, screenshotPlacement } from "../src/review/crops.js";
import { checksConfigSchema } from "../src/schemas/project.js";
import { draftSystemLearning } from "../src/system/learn/draft.js";
import { extractSources } from "../src/system/learn/extract.js";

const args = process.argv.slice(2);
const scratch = args.find((arg) => !arg.startsWith("--"));
const outIndex = args.indexOf("--out");
const out = outIndex >= 0 ? args[outIndex + 1] : undefined;
if (scratch === undefined || out === undefined) {
  process.stderr.write(
    "usage: bun scripts/scale-cluster-field.ts <scratch> --out <dir>\n",
  );
  process.exit(1);
}
await mkdir(out, { recursive: true });

async function files(directory: string, name: string): Promise<string[]> {
  const found: string[] = [];
  const visit = async (current: string) => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        if (!["node_modules", ".git"].includes(entry.name)) await visit(path);
      } else if (entry.name === name) found.push(path);
    }
  };
  await visit(directory);
  return found.sort();
}

/** Every captured tuple under a run directory, as the checks see them. */
async function tuplesOf(runDirectory: string): Promise<CheckTuple[]> {
  const tuples: CheckTuple[] = [];
  for (const path of await files(runDirectory, "observations.json")) {
    const directory = join(path, "..");
    const observations = JSON.parse(
      await readFile(path, "utf8"),
    ) as ObservationArtifact;
    const metadata = JSON.parse(
      await readFile(join(directory, "metadata.json"), "utf8"),
    );
    const parts = relative(runDirectory, directory).split("/");
    const scheme = ["light", "dark"].includes(parts.at(-1) ?? "")
      ? (parts.at(-1) as "light" | "dark")
      : undefined;
    const state = parts[0] as string;
    const viewport = metadata.viewport?.name ?? parts[1];
    tuples.push({
      flow: "field",
      state,
      viewport,
      ...(scheme === undefined
        ? {}
        : { colorScheme: scheme, colorSchemeAxis: true }),
      width: observations.viewport.width,
      height: observations.viewport.height,
      metadataPath: `${relative(runDirectory, directory)}/metadata.json`,
      screenshotPath: `${relative(runDirectory, directory)}/screenshot.png`,
      artifactPaths: [],
      commit: "field",
      createdAt: metadata.timestamps?.startedAt ?? "",
      observations,
      console: [],
      mismatches: [],
    });
  }
  return tuples;
}

/** Stylesheets and inline styles the captured page loaded. */
async function pageCss(runDirectory: string, into: string): Promise<number> {
  await mkdir(into, { recursive: true });
  let written = 0;
  const seen = new Set<string>();
  for (const path of await files(runDirectory, "dom.html")) {
    const html = await readFile(path, "utf8");
    const metadata = JSON.parse(
      await readFile(join(path, "..", "metadata.json"), "utf8"),
    );
    const base: string = metadata.url?.url ?? metadata.url ?? "";
    for (const match of html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)) {
      const text = match[1] ?? "";
      if (seen.has(text)) continue;
      seen.add(text);
      await writeFile(join(into, `inline-${written++}.css`), text);
    }
    for (const match of html.matchAll(/<link\b[^>]*>/gi)) {
      const tag = match[0];
      if (!/rel=["']?stylesheet/i.test(tag)) continue;
      const href = /href=["']([^"']+)["']/i.exec(tag)?.[1];
      if (href === undefined) continue;
      let url: string;
      try {
        url = new URL(href.replaceAll("&amp;", "&"), base).href;
      } catch {
        continue;
      }
      if (seen.has(url)) continue;
      seen.add(url);
      try {
        const response = await fetch(url, {
          signal: AbortSignal.timeout(20_000),
        });
        if (!response.ok) continue;
        await writeFile(
          join(into, `sheet-${written++}.css`),
          await response.text(),
        );
      } catch {}
    }
  }
  return written;
}

async function learnedScales(sourceRoot: string) {
  const project = await mkdtemp(join(tmpdir(), "idiom-scale-learn-"));
  await initProject({ project, yes: true });
  const before = await readFile(
    join(project, ".idiom", "project.json"),
    "utf8",
  );
  const extraction = await extractSources(sourceRoot);
  // Site CSS carries blank custom properties (`--x: ;`); they are not tokens.
  extraction.tokens = extraction.tokens.filter(
    (token) => token.value.trim() !== "",
  );
  const draft = await draftSystemLearning(before, extraction);
  return {
    sources: extraction.sources.length,
    tokens: extraction.tokens.length,
    scales: (JSON.parse(draft.after).checks?.scales ?? {}) as Record<
      string,
      unknown
    >,
  };
}

const report: unknown[] = [];
for (const entry of (await readdir(scratch, { withFileTypes: true })).sort(
  (a, b) => a.name.localeCompare(b.name),
)) {
  if (!entry.isDirectory()) continue;
  const repo = !entry.name.includes("-mcp-") && !entry.name.includes("-cli-");
  if (!repo && !entry.name.includes("-mcp-")) continue;
  const target = entry.name.replace(/-mcp-.*$/, "");
  const root = join(scratch, entry.name);
  const reportsRoot = repo
    ? join(root, ".idiom", "reports")
    : join(root, "idiom-quick-reports");
  if (!existsSync(reportsRoot)) continue;
  const runs = (await readdir(reportsRoot, { withFileTypes: true }))
    .filter((item) => item.isDirectory())
    .map((item) => item.name)
    .sort();
  const run = runs.at(-1);
  if (run === undefined) continue;
  const runDirectory = join(reportsRoot, run);
  const tuples = await tuplesOf(runDirectory);
  const cssRoot = join(out, target, "css");
  const sheets = repo ? 0 : await pageCss(runDirectory, cssRoot);
  let learned: Awaited<ReturnType<typeof learnedScales>>;
  try {
    learned = await learnedScales(repo ? root : cssRoot);
  } catch (error) {
    report.push({ target, run, error: String(error).slice(0, 400) });
    process.stderr.write(`[scale-cluster-field] ${target}: learn failed\n`);
    continue;
  }
  const settings = checksConfigSchema.parse({ scales: learned.scales });
  const today = checksConfigFrom(settings);
  const asked: ChecksConfig = {
    ...checksConfigFrom(settings),
    scaleQuestions: { rulings: [] },
  };
  const scaleFindings = (config: ChecksConfig) =>
    runDeterministicChecks(tuples, undefined, config).candidates.filter(
      ({ candidate }) => candidate.category === "scale-conformance",
    );
  const before = scaleFindings(today);
  const after = scaleFindings(asked);
  const clusters = scaleQuestions(tuples, asked);
  const images = new Map<string, PNG | undefined>();
  const rows = [];
  for (const [index, cluster] of clusters.entries()) {
    const crops: string[] = [];
    for (const [n, example] of cluster.examples.entries()) {
      const observations = example.tuple.observations;
      if (
        observations === undefined ||
        example.tuple.screenshotPath === undefined
      )
        continue;
      const placement = screenshotPlacement(observations);
      const relativePath = `${target}/cluster-${index + 1}-${n + 1}.png`;
      const absolute = join(out, relativePath);
      if (
        await cropToFile({
          runDirectory,
          screenshotPath: example.tuple.screenshotPath,
          images,
          viewportWidth: example.tuple.width,
          ...(observations.version === 2
            ? {
                viewport: {
                  ...observations.viewport,
                  documentWidth: observations.document.scrollWidth,
                },
              }
            : {}),
          scale: placement.scale,
          rect: placement.rect(example.element),
          padding: 24,
          relativePath: relative(runDirectory, absolute),
        })
      )
        crops.push(relativePath);
    }
    rows.push({
      id: `${target}#${index + 1}`,
      fingerprint: cluster.fingerprint,
      question: cluster.question,
      property: cluster.property,
      value: cluster.value,
      count: cluster.count,
      distinctStates: cluster.distinctStates,
      distinctElements: cluster.distinctElements,
      context: cluster.context,
      nearestSteps: cluster.nearestSteps,
      suggestedToken: cluster.suggestedToken,
      examples: cluster.examples.map(({ tuple, element, longhand }) => ({
        tuple: `${tuple.state}/${tuple.viewport}${tuple.colorScheme ? `/${tuple.colorScheme}` : ""}`,
        selector: element.selector,
        longhand,
      })),
      crops,
    });
  }
  const entryReport = {
    target,
    run,
    tuples: tuples.length,
    learned: {
      stylesheets: sheets,
      sources: learned.sources,
      tokens: learned.tokens,
      scales: learned.scales,
    },
    scaleFindings: { today: before.length, asked: after.length },
    clusters: rows,
  };
  report.push(entryReport);
  process.stderr.write(
    `[scale-cluster-field] ${target}: ${tuples.length} tuples, ${learned.tokens} tokens, ${before.length}→${after.length} scale findings, ${rows.length} question(s)\n`,
  );
}
await writeFile(
  join(out, "scale-cluster-field.json"),
  `${JSON.stringify(report, null, 2)}\n`,
);
process.stderr.write(
  `[scale-cluster-field] wrote ${join(out, "scale-cluster-field.json")}\n`,
);

import { readFile, rename, writeFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import type { CheckTuple } from "../checks/types.js";
import {
  escapeHtml,
  escapeHtmlAttribute,
  pngDataUri,
  renderHtmlDocument,
  writeHtmlReport,
} from "../report/html.js";
import {
  type ExplorationRunResolution,
  explorationRunSchema,
  normalizeExplorationKey,
} from "../schemas/exploration.js";
import type { RenderedCandidate } from "./types.js";

export type ExplorationReportData = {
  flow: string;
  state: string;
  question: string;
  baselineRun: string;
  baseline: CheckTuple[];
  candidates: RenderedCandidate[];
  selected?: string | undefined;
  refined?: string | undefined;
  steering?:
    | { decision: string; fingerprint: string; choiceKey: string }
    | undefined;
};

async function atomic(path: string, source: string): Promise<void> {
  const temporary = `${path}.tmp`;
  await writeFile(temporary, source);
  await rename(temporary, path);
}

function tupleKey(tuple: CheckTuple): string {
  return `${tuple.state}/${tuple.viewport}/${tuple.colorScheme ?? "light"}`;
}

async function image(run: string, tuple: CheckTuple): Promise<string> {
  if (tuple.screenshotPath === undefined) return "";
  return pngDataUri(await readFile(join(run, tuple.screenshotPath)));
}

export async function writeExplorationReport(
  runDirectory: string,
  data: ExplorationReportData,
): Promise<{
  jsonPath: string;
  markdownPath: string;
  htmlPath: string;
}> {
  const jsonPath = join(runDirectory, "exploration.json");
  let resolution: ExplorationRunResolution | undefined;
  try {
    const existing = explorationRunSchema.safeParse(
      JSON.parse(await readFile(jsonPath, "utf8")),
    );
    if (existing.success) resolution = existing.data.resolution;
  } catch {
    resolution = undefined;
  }
  const serializable = {
    version: 1,
    flow: data.flow,
    state: data.state,
    question: data.question,
    candidates: data.candidates.map((item) => {
      const { edits: _temporaryCode, ...candidate } = item.candidate;
      return {
        ...candidate,
        label: normalizeExplorationKey(candidate.label).toUpperCase(),
        capture: relative(runDirectory, item.runDirectory).split(sep).join("/"),
        refined: item.refined === true,
      };
    }),
    ...(data.selected === undefined
      ? {}
      : { selected: normalizeExplorationKey(data.selected).toUpperCase() }),
    ...(data.refined === undefined ? {} : { refined: data.refined }),
    ...(data.steering === undefined ? {} : { steering: data.steering }),
    ...(resolution === undefined ? {} : { resolution }),
  };
  await atomic(jsonPath, `${JSON.stringify(serializable, null, 2)}\n`);
  const markdown = [
    `# Design exploration: ${data.flow}/${data.state}`,
    "",
    data.question,
    "",
    ...data.candidates.flatMap((item) => [
      `## ${item.candidate.label}: ${item.candidate.direction}${item.refined === true ? " (refined winner)" : ""}`,
      "",
      `Proposed rule: ${item.candidate.rule}`,
      "",
      `Reason: ${item.candidate.reason}`,
      "",
      `References: ${item.candidate.references.join(", ") || "none available"}`,
      "",
    ]),
  ].join("\n");
  const markdownPath = join(runDirectory, "exploration.md");
  await atomic(markdownPath, `${markdown}\n`);

  const baselineByKey = new Map(
    data.baseline.map((tuple) => [tupleKey(tuple), tuple]),
  );
  const sections: string[] = [];
  let imageIndex = 0;
  for (const item of data.candidates) {
    const figures: string[] = [];
    for (const tuple of item.tuples) {
      const baseline = baselineByKey.get(tupleKey(tuple));
      if (baseline === undefined) continue;
      const [before, after] = await Promise.all([
        image(data.baselineRun, baseline),
        image(item.runDirectory, tuple),
      ]);
      imageIndex += 1;
      figures.push(
        `<article class="panel"><h3>${escapeHtml(tupleKey(tuple))}</h3><div class="comparison-pair"><figure><figcaption>Baseline</figcaption><img class="screenshot" src="${escapeHtmlAttribute(before)}" alt="Baseline ${imageIndex}"></figure><figure><figcaption>${escapeHtml(item.candidate.label)}</figcaption><img class="screenshot" src="${escapeHtmlAttribute(after)}" alt="Candidate ${imageIndex}"></figure></div></article>`,
      );
    }
    sections.push(
      `<section><h2>${escapeHtml(item.candidate.label)}: ${escapeHtml(item.candidate.direction)}${item.refined === true ? " — refined winner" : ""}</h2><p>${escapeHtml(item.candidate.rule)}</p><p><strong>Reason:</strong> ${escapeHtml(item.candidate.reason)}</p><p><strong>References:</strong> ${escapeHtml(item.candidate.references.join(", ") || "none available")}</p>${figures.join("")}</section>`,
    );
  }
  const html = renderHtmlDocument({
    title: `Design exploration: ${data.flow}/${data.state}`,
    body: `<header><h1>Design exploration</h1><p>${escapeHtml(data.flow)}/${escapeHtml(data.state)}</p><p>${escapeHtml(data.question)}</p></header>${sections.join("")}`,
    printable: true,
  });
  const htmlPath = await writeHtmlReport(runDirectory, html);
  return { jsonPath, markdownPath, htmlPath };
}

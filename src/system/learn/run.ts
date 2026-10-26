import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import { chromium } from "playwright";
import type { FigmaDependencies } from "../../design/figma/client.js";
import type { FigmaRef } from "../../design/figma/url.js";
import { IdiomError } from "../../errors.js";
import type { BrowserLaunch } from "../../learn/target.js";
import { collectSystemPage, type SystemDependencies } from "../collect.js";
import { compareValueDrift, type DriftResult } from "../drift.js";
import type { SystemPageModel } from "../types.js";
import {
  applySystemDraft,
  draftSystemLearning,
  type SystemDraft,
} from "./draft.js";
import { extractSources } from "./extract.js";
import { extractFigmaVariables } from "./figma.js";
import { inlineDeclarations } from "./inline.js";
import { normalizeCssValues } from "./normalize.js";
import { tokenIdentity } from "./schema.js";

export type SystemLearningDependencies = SystemDependencies & {
  /** Recorded Figma API responses in tests. */
  figma?: FigmaDependencies | undefined;
  confirm?: ((diff: string) => Promise<boolean>) | undefined;
  launchBrowser?: BrowserLaunch | undefined;
  isTTY?: boolean | undefined;
  write?: ((message: string) => void) | undefined;
};
export type SystemLearningResult = {
  outcome: "applied" | "declined" | "preview" | "no-changes" | "no-sources";
  draft: SystemDraft;
  model: SystemPageModel;
  drift: DriftResult;
};
export type LearningSource = {
  /** A Figma file URL: learn tokens from its variables instead of code. */
  figma?: FigmaRef | undefined;
  refresh?: boolean | undefined;
};
async function prepareLearning(
  projectDirectory: string,
  dependencies: SystemLearningDependencies = {},
  source: LearningSource = {},
) {
  const model = await collectSystemPage({
    project: projectDirectory,
    dependencies,
  });
  const figma = source.figma
    ? await extractFigmaVariables(projectDirectory, source.figma, {
        refresh: source.refresh,
        deps: dependencies.figma,
      })
    : undefined;
  const extraction = figma ?? (await extractSources(projectDirectory));
  const before = await readFile(
    join(projectDirectory, ".idiom", "project.json"),
    "utf8",
  );
  const draft = await draftSystemLearning(before, extraction, {
    rootFontSizes: model.drift?.contexts.flatMap((c) =>
      c.rootFontSize === undefined ? [] : [c.rootFontSize],
    ),
    launch: dependencies.launchBrowser,
  });
  if (figma) draft.summary.unshift(figma.summary);
  if (model.drift) {
    const proposed = inlineDeclarations(
      JSON.parse(draft.after).design?.tokens ?? [],
    );
    const identities = new Set(proposed.map(tokenIdentity));
    const extracted = new Map(
      extraction.tokens.map((t) => [tokenIdentity(t), t]),
    );
    model.drift = {
      ...model.drift,
      proposed: true,
      declarations: [
        ...model.drift.declarations.filter(
          (t) => !identities.has(tokenIdentity(t)),
        ),
        ...proposed.map((t) => {
          const original = extracted.get(tokenIdentity(t));
          return original?.value === t.value && original.reason
            ? { ...t, reason: original.reason }
            : t;
        }),
      ],
    };
  }
  let drift: DriftResult = {
    uncovered: [],
    notObserved: [],
    unconfigured: [],
    unresolved: ["No complete capture: drift unavailable."],
  };
  if (model.drift && extraction.tokens.length) {
    const browser = await (
      dependencies.launchBrowser ?? (() => chromium.launch({ headless: true }))
    )();
    try {
      const page = await browser.newPage();
      await page.route("**/*", (route) => route.abort());
      await page.setContent("<!doctype html><body></body>");
      drift = (await page.evaluate(
        `(${compareValueDrift.toString()})(${JSON.stringify(model.drift)},${normalizeCssValues.toString()})`,
      )) as DriftResult;
    } finally {
      await browser.close();
    }
  }
  return { draft, model, drift };
}
export async function prepareSystemLearning(
  projectDirectory: string,
  dependencies: SystemLearningDependencies = {},
  source: LearningSource = {},
) {
  try {
    return await prepareLearning(projectDirectory, dependencies, source);
  } catch (error) {
    throw error instanceof IdiomError
      ? error
      : new IdiomError(
          `Cannot learn design system: ${error instanceof Error ? error.message : String(error)}`,
        );
  }
}
export function printSystemProposal(
  prepared: Awaited<ReturnType<typeof prepareSystemLearning>>,
  write: (message: string) => void,
): void {
  write(`${prepared.draft.summary.join("\n")}\n`);
  for (const [key, label] of [
    ["uncovered", "Uncovered values"],
    ["notObserved", "Not observed in this capture"],
    ["unresolved", "Unresolved / coverage"],
    ["unconfigured", "Unconfigured"],
  ] as const)
    write(`${label}:\n${prepared.drift[key].join("\n") || "None"}\n`);
  write(prepared.draft.diff || "No configuration changes.\n");
}
async function confirm(): Promise<boolean> {
  const readline = createInterface({ input: stdin, output: stdout });
  try {
    return /^(?:y|yes)$/i.test(
      (await readline.question("Apply this learning? [y/N] ")).trim(),
    );
  } finally {
    readline.close();
  }
}
export async function runSystemLearning(
  projectDirectory: string,
  options: {
    yes?: boolean | undefined;
    dependencies?: SystemLearningDependencies | undefined;
    source?: LearningSource | undefined;
  },
): Promise<SystemLearningResult> {
  const deps = options.dependencies ?? {};
  const prepared = await prepareSystemLearning(
    projectDirectory,
    deps,
    options.source,
  );
  const write = deps.write ?? ((message: string) => stdout.write(message));
  printSystemProposal(prepared, write);
  let outcome: SystemLearningResult["outcome"];
  if (!prepared.draft.extraction.sources.length) {
    write("No design-token sources found.\n");
    outcome = "no-sources";
  } else if (!prepared.draft.diff) outcome = "no-changes";
  else if (!options.yes && !deps.confirm && !(deps.isTTY ?? stdin.isTTY)) {
    write(
      "Preview only. Apply with idiom system --learn --yes, or run interactively.\n",
    );
    outcome = "preview";
  } else if (
    options.yes ||
    (await (deps.confirm ?? confirm)(prepared.draft.diff))
  ) {
    await applySystemDraft(
      join(projectDirectory, ".idiom", "project.json"),
      prepared.draft,
    );
    write(
      "Applied design-token learning. Recapture before checking the new rules; old captures retain historical token evidence.\n",
    );
    outcome = "applied";
  } else outcome = "declined";
  if (outcome === "applied") {
    prepared.model = await collectSystemPage({
      project: projectDirectory,
      dependencies: deps,
    });
  }
  return { ...prepared, outcome };
}

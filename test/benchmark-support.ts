import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { AxeBuilder } from "@axe-core/playwright";
import type { Browser } from "playwright";
import { PNG } from "pngjs";
import {
  ExplanationCollector,
  mergeExplanations,
} from "../src/capture/explanations.js";
import { sweepFocusVisible } from "../src/capture/focus.js";
import type { LinkChecker } from "../src/capture/links.js";
import { sampleMediaFrames } from "../src/capture/media-bands.js";
import { mergeMotion } from "../src/capture/motion.js";
import { probeControls } from "../src/capture/probe.js";
import { createProbeLedger } from "../src/capture/probe-ledger.js";
import {
  inferDesignComponents,
  inferredComponentInputs,
  mergeInferredComponents,
} from "../src/checks/design-components.js";
import { observePage } from "../src/checks/observe.js";
import {
  checksConfigFrom,
  runDeterministicChecks,
} from "../src/checks/registry.js";
import type {
  CheckTuple,
  FindingCandidate,
  ObservationArtifact,
} from "../src/checks/types.js";
import {
  effectiveInvariants,
  type InvariantInput,
  invariantSchema,
} from "../src/schemas/invariant.js";
import type { ColorScheme } from "../src/schemas/project.js";
import { checkMarks, checksConfigSchema } from "../src/schemas/project.js";

const directory = join(import.meta.dirname, "fixtures/benchmark");

export async function fixture(name: string): Promise<string> {
  const css = await readFile(join(directory, "chrome.css"), "utf8");
  return (await readFile(join(directory, name), "utf8")).replace(
    "/*CSS*/",
    css,
  );
}

export type ReviewedFixture = Array<{
  candidate: FindingCandidate;
  state: string;
}>;

export type ReviewOptions = {
  shell?: string;
  state?: string;
  invariants?: InvariantInput[];
  colorScheme?: ColorScheme;
  colorSchemes?: readonly ColorScheme[];
  focus?: string;
  probe?: boolean;
  reducedMotion?: boolean;
  fresh?: boolean;
  checks?: unknown;
  /** DESIGN.md text; stated component sizes are inferred as capture does. */
  design?: string;
  /** Page review brief text; merged into checks.page after parsing. */
  brief?: string;
  /** Run axe as capture does instead of recording no violations. */
  axe?: boolean;
  onObservations?: (observations: ObservationArtifact) => void;
  viewport?: { width: number; height: number };
  /** Treat the tuple as a published page (the published-budget check runs). */
  published?: CheckTuple["published"];
  /** Record `<img>` observations, as capture does for published flows. */
  images?: boolean;
  /** Navigate to this URL instead of setting the fixture HTML as content. */
  url?: string;
  /** Wait this long after load, as capture's settle does. */
  settleMs?: number;
  /** Run the keyboard focus sweep (also on whenever `probe` is true). */
  focusSweep?: boolean;
  /** Check observed links with this checker, as web capture does. */
  links?: LinkChecker;
};

/**
 * Observe a fixture the way capture does (signals, declared components, the
 * optional focus and interaction probe), then run every deterministic check.
 */
export async function reviewFixture(
  browser: Browser,
  html: string,
  options: ReviewOptions = {},
): Promise<ReviewedFixture> {
  const { state, focus, url, ...shared } = options;
  return (
    await reviewStates(
      browser,
      [
        {
          state: state ?? "editor",
          html,
          ...(focus === undefined ? {} : { focus }),
          ...(url === undefined ? {} : { url }),
        },
      ],
      shared,
    )
  ).findings;
}

/**
 * Observe several states with the same settings and run the deterministic
 * checks once over all of them, as a multi-state capture would.
 */
export async function reviewStates(
  browser: Browser,
  states: Array<{
    state: string;
    html: string;
    focus?: string;
    siblings?: string;
    url?: string;
  }>,
  options: Omit<ReviewOptions, "state" | "focus"> = {},
): Promise<{ findings: ReviewedFixture; tuples: CheckTuple[] }> {
  const settings = checksConfigSchema.parse(options.checks ?? {});
  const inferredComponents = inferredComponentInputs(
    options.design === undefined
      ? []
      : mergeInferredComponents(
          settings.components,
          inferDesignComponents(options.design, "DESIGN.md"),
        ),
  );
  const viewport = options.viewport ?? { width: 1440, height: 900 };
  const tuples: CheckTuple[] = [];
  // One flow-scoped ledger, as a real capture run has: a control probed at an
  // earlier state is reused at later ones.
  const probeLedger = createProbeLedger();
  for (const { state, html, focus, siblings, url } of states) {
    for (const colorScheme of options.colorSchemes ?? [options.colorScheme]) {
      const context = await browser.newContext({
        viewport,
        reducedMotion:
          options.reducedMotion === false ? "no-preference" : "reduce",
        ...(colorScheme === undefined ? {} : { colorScheme }),
        permissions: ["clipboard-read", "clipboard-write"],
      });
      const page = await context.newPage();
      // Scheme pairs need distinct artifacts; single-scheme paths are unchanged.
      const tupleDirectory =
        options.colorSchemes === undefined
          ? `${state}/desktop`
          : `${state}/desktop/${colorScheme}`;
      try {
        const load = async () => {
          if (url === undefined) await page.setContent(html);
          else await page.goto(url);
          if (options.settleMs !== undefined)
            await page.waitForTimeout(options.settleMs);
        };
        await load();
        const explanations =
          settings.explanation === "visible"
            ? new ExplanationCollector(page, "capture", settings.probe.waitMs)
            : undefined;
        if (focus !== undefined) {
          const window = await explanations?.start();
          try {
            await page.locator(focus).focus();
            await window?.finish();
          } finally {
            await window?.dispose();
          }
        }
        let observations = await observePage(
          page,
          { status: "not-configured" },
          undefined,
          [],
          {
            shell: options.shell,
            floatingOverlays: settings.shellVisibility?.floatingOverlays,
            components: settings.components,
            inferredComponents,
            invariants: effectiveInvariants(
              {
                id: "studio-lab",
                invariants: (options.invariants ?? []).map((value) =>
                  invariantSchema.parse(value),
                ),
              },
              { id: state },
            ),
            fresh: options.fresh,
            marks: checkMarks(settings),
            ...(options.images === true ? { images: true } : {}),
            emptyState: settings.emptyState,
            mediaFill: settings.mediaFill,
            ...(settings.collections.length === 0
              ? {}
              : {
                  collections: settings.collections.map(({ selector }) => ({
                    selector,
                  })),
                }),
            bandEdges: settings.bandEdges?.enabled === true,
            wordBreak: settings.wordBreak?.enabled === true,
            fonts: true,
            lineLength: true,
            orphanWord: true,
            imageRenders: true,
            layoutShift: true,
            links: options.links !== undefined,
          },
        );
        if (
          observations.version === 2 &&
          observations.links !== undefined &&
          options.links !== undefined
        )
          observations = {
            ...observations,
            links: await options.links.check(observations.links.records),
          };
        if (
          observations.version === 2 &&
          observations.mediaFrames !== undefined &&
          observations.mediaFrames.length > 0
        ) {
          const screenshot = await page.screenshot({ fullPage: true });
          observations = {
            ...observations,
            mediaFill: { tolerance: settings.mediaFill.tolerance },
            mediaFrames: sampleMediaFrames(
              observations.mediaFrames,
              () => PNG.sync.read(screenshot),
              viewport.width,
              settings.mediaFill.tolerance,
            ),
          };
        }
        if (observations.version === 2 && explanations)
          observations = {
            ...observations,
            explanations: explanations.evidence(),
          };
        if ((options.probe || options.focusSweep) && observations.version === 2)
          observations = {
            ...observations,
            focusVisible: await sweepFocusVisible(page, {
              maxStops: settings.probe.maxControls,
              ignore: [...settings.focusVisible.ignore, ...settings.probe.skip],
            }),
          };
        if (options.probe && observations.version === 2) {
          const probe = await probeControls({
            page,
            skip: settings.probe.skip,
            respectControlIntent: settings.probe.respectControlIntent,
            maxControls: settings.probe.maxControls,
            waitMs: 150,
            motionSelectors: settings.motion.selectors,
            explanation: settings.explanation,
            collections: settings.collections.map(({ selector }) => selector),
            ledger: probeLedger,
            stateId: state,
            ledgerPartition: `desktop\0${colorScheme ?? "light"}`,
            restore: load,
          });
          observations = {
            ...observations,
            probe,
            motion: mergeMotion(observations.motion, probe.motion),
            explanations: mergeExplanations(
              observations.explanations,
              probe.explanations,
            ),
          };
        }
        options.onObservations?.(observations);
        tuples.push({
          flow: "studio-lab",
          colorScheme,
          ...(options.colorSchemes === undefined
            ? {}
            : { colorSchemeAxis: true }),
          state,
          ...(siblings === undefined ? {} : { siblings }),
          viewport: "desktop",
          width: viewport.width,
          height: viewport.height,
          metadataPath: `${tupleDirectory}/metadata.json`,
          artifactPaths: [`${tupleDirectory}/observations.json`],
          commit: "fixture",
          createdAt: "2026-10-22T00:00:00.000Z",
          observations,
          axe:
            options.axe === true
              ? await new AxeBuilder({ page }).analyze()
              : { violations: [] },
          console: [],
          mismatches: [],
          ...(options.published === undefined
            ? {}
            : { published: options.published }),
        });
      } finally {
        await context.close();
      }
    }
  }
  const config = checksConfigFrom(settings);
  if (options.brief !== undefined && config.page !== undefined)
    config.page = { ...config.page, brief: { text: options.brief } };
  const findings = runDeterministicChecks(
    tuples,
    undefined,
    config,
  ).candidates.map(({ candidate, tuple }) => ({
    candidate,
    state: tuple.state,
  }));
  return { findings, tuples };
}

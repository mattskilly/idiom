import { defaultChecksSettings } from "../schemas/project.js";
import { ran, skipped, unavailable, v2Observations, verify } from "./shared.js";
import type { CheckTuple, DeterministicCheck } from "./types.js";

const RULE = "idiom:unused-token";

const chromeTokenName = /scrollbar|selection|caret|focus/i;

/** What a chrome token name says it styles, for the explanation. */
function chromePart(name: string): string {
  if (/scrollbar/i.test(name)) return "scrollbars";
  if (/selection/i.test(name)) return "text selection";
  if (/caret/i.test(name)) return "the text caret";
  return "focus indicators";
}

/** Declared token names that suggest browser chrome. */
export function chromeTokenNames(declarations: Record<string, string>) {
  return Object.keys(declarations)
    .filter((name) => chromeTokenName.test(name))
    .sort();
}

type Analysis = {
  home: CheckTuple | undefined;
  unused: string[];
  incomplete: boolean;
};

const analyses = new WeakMap<readonly CheckTuple[], Analysis>();

function analyse(tuples: readonly CheckTuple[]): Analysis {
  let home: CheckTuple | undefined;
  let incomplete = false;
  const used = new Set<string>();
  for (const tuple of tuples) {
    const use = v2Observations(tuple)?.chromeTokenUse;
    if (use === undefined) continue;
    home ??= tuple;
    if (!use.complete) incomplete = true;
    for (const name of use.used) used.add(name);
  }
  const candidates =
    v2Observations(home ?? { observations: undefined })?.chromeTokenUse
      ?.candidates ?? [];
  return {
    home,
    unused: candidates.filter((name) => !used.has(name)),
    incomplete,
  };
}

function analysisFor(tuples: readonly CheckTuple[]): Analysis {
  let analysis = analyses.get(tuples);
  if (!analysis) {
    analysis = analyse(tuples);
    analyses.set(tuples, analysis);
  }
  return analysis;
}

/**
 * Chrome tokens (scrollbar, selection, caret, focus) that the tokens file
 * defines but no rule applying to any captured element uses. Reported once
 * per run, at the first state that recorded token use.
 */
export const unusedTokenCheck: DeterministicCheck = {
  id: "unused-token",
  run({ tuple, tuples, config }) {
    const settings = config.unusedToken ?? defaultChecksSettings.unusedToken;
    if (!settings.enabled) return skipped(this.id, "unusedToken");
    const observation = v2Observations(tuple);
    if (observation === undefined)
      return unavailable(this.id, "observations.json is unavailable");
    const tokens = observation.tokens;
    if (tokens.status !== "configured" || tokens.source === "design.tokens")
      return {
        coverage: {
          check: this.id,
          status: "skipped",
          reason: "design.tokensFile is not configured",
        },
        candidates: [],
      };
    const analysis = analysisFor(tuples?.includes(tuple) ? tuples : [tuple]);
    if (analysis.home === undefined)
      return unavailable(
        this.id,
        "observations predate the chrome-token scan (recapture)",
      );
    if (analysis.incomplete)
      return {
        coverage: {
          check: this.id,
          status: "ran",
          reason:
            "some stylesheets could not be read, so token use cannot be ruled out",
        },
        candidates: [],
      };
    if (analysis.home !== tuple) return ran(this.id, []);
    return ran(
      this.id,
      analysis.unused.map((name) => ({
        category: this.id,
        severity: "info" as const,
        rule: RULE,
        selectorHint: ":root",
        fingerprintHint: `unused-token:${name}`,
        explanation: `\`${name}\` is defined in ${tokens.source} but no rule that applies to any captured element uses it, so whatever it styles (${chromePart(name)}) still shows the browser default.`,
        acceptance: [
          `Apply \`${name}\` where it belongs, or remove it from the tokens file.`,
        ],
        verification: verify(this.id, {
          token: name,
          tokensFile: tokens.source,
        }),
      })),
    );
  },
};

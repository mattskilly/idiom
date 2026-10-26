import { defaultChecksSettings } from "../schemas/project.js";
import {
  scanResult,
  skipped,
  unavailable,
  v2Observations,
  verify,
} from "./shared.js";
import type {
  DeterministicCheck,
  FindingCandidate,
  LinkObservation,
} from "./types.js";

/** Path and query only, so a served port never reaches a finding's identity. */
function shownHref(link: LinkObservation): string {
  if (!link.sameOrigin) return link.href;
  try {
    const url = new URL(link.href);
    return `${url.pathname}${url.search}`;
  } catch {
    return link.href;
  }
}

export const brokenLinkCheck: DeterministicCheck = {
  id: "broken-link",
  run({ tuple, config }) {
    if (!(config.links ?? defaultChecksSettings.links).enabled)
      return skipped(this.id, "links");
    const scan = v2Observations(tuple)?.links;
    if (scan === undefined)
      return unavailable(this.id, "link evidence requires a web capture");
    const candidates: FindingCandidate[] = [];
    const seen = new Set<string>();
    for (const link of scan.records) {
      const result = link.result;
      if (result?.status !== "broken") continue;
      const href = shownHref(link);
      const key = `${link.selector}|${href}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const status =
        result.code === null ? result.reason : `HTTP ${result.code}`;
      const text = link.text === "" ? link.selector : `“${link.text}”`;
      candidates.push({
        category: this.id,
        severity: link.sameOrigin ? "major" : "minor",
        rule: "idiom:broken-link",
        selectorHint: link.selector,
        fingerprintHint: link.sameOrigin ? key : link.href,
        explanation: `The link ${text} points at ${href}, which answers ${status}.`,
        acceptance: [
          `${link.selector} points at a page that answers below 400, or is removed.`,
        ],
        verification: verify(this.id, {
          selector: link.selector,
          href,
          code: result.code,
        }),
      });
    }
    return scanResult(this.id, candidates, scan);
  },
};

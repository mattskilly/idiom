import { axeSelector, axeViolations, verify } from "./shared.js";
import type { DeterministicCheck, FindingCandidate } from "./types.js";

const gatedImpacts = new Set(["serious", "critical"]);

function percent(ratio: number): string {
  return `${(ratio * 100).toFixed(2)}%`;
}

/**
 * The hard budget a published page is held to: no horizontal document
 * overflow, no broken images, no serious or critical axe violations, and
 * (when a pixel baseline is committed) no drift beyond `maxDiffRatio`.
 */
export const publishedBudgetCheck: DeterministicCheck = {
  id: "published-budget",
  run({ tuple }) {
    const published = tuple.published;
    if (published === undefined)
      return {
        coverage: {
          check: this.id,
          status: "skipped",
          reason: "flow is not published",
        },
        candidates: [],
      };
    const observation = tuple.observations;
    if (observation === undefined)
      return {
        coverage: {
          check: this.id,
          status: "unavailable",
          reason: "observations.json is unavailable",
        },
        candidates: [],
      };
    const candidates: FindingCandidate[] = [];
    const missing: string[] = [];

    const { scrollWidth, clientWidth } = observation.document;
    if (scrollWidth > clientWidth + 1)
      candidates.push({
        category: this.id,
        severity: "blocker",
        rule: "published:document-overflow",
        selectorHint: "document",
        explanation: `The page is ${scrollWidth}px wide at the ${tuple.width}px viewport (${clientWidth}px client width).`,
        acceptance: [
          `The document's scroll width is at most its ${clientWidth}px client width at the ${tuple.viewport} viewport.`,
        ],
        verification: verify(this.id, {
          rule: "document-overflow",
          scrollWidth,
          clientWidth,
        }),
      });

    const reported = new Set<string>();
    const images = observation.version === 2 ? observation.images : undefined;
    if (images === undefined) missing.push("image signal (recapture)");
    for (const image of images ?? []) {
      const url = image.currentSrc || image.src;
      if (!image.complete || image.naturalWidth !== 0 || url === "") continue;
      if (reported.has(url)) continue;
      reported.add(url);
      candidates.push({
        category: this.id,
        severity: "blocker",
        rule: "published:broken-image",
        selectorHint: image.selector,
        fingerprintHint: `img:${url}`,
        explanation: `Image ${url} did not load (naturalWidth 0).`,
        acceptance: [`Image ${url} loads with a nonzero natural width.`],
        verification: verify(this.id, { rule: "broken-image", url }),
      });
    }
    const failed =
      observation.version === 2 ? observation.failedImageRequests : undefined;
    for (const request of failed ?? []) {
      if (reported.has(request.url)) continue;
      reported.add(request.url);
      candidates.push({
        category: this.id,
        severity: "blocker",
        rule: "published:broken-image",
        selectorHint: "document",
        fingerprintHint: `img:${request.url}`,
        explanation: `Image request ${request.url} failed: ${request.reason}.`,
        acceptance: [`Image request ${request.url} succeeds.`],
        verification: verify(this.id, {
          rule: "broken-image",
          url: request.url,
        }),
      });
    }

    if (tuple.axe === undefined) missing.push("axe results (axe.json)");
    for (const violation of axeViolations(tuple.axe)) {
      if (!gatedImpacts.has(violation.impact ?? "")) continue;
      const first = violation.nodes[0];
      const selector = first === undefined ? "document" : axeSelector(first);
      candidates.push({
        category: this.id,
        severity: "blocker",
        rule: `published:axe:${violation.id}`,
        selectorHint: selector,
        explanation: `axe rule ${violation.id} (${violation.impact}) fails on ${violation.nodes.length} element(s), first ${selector}.`,
        acceptance: [`axe rule ${violation.id} reports no violations.`],
        verification: verify(this.id, {
          rule: "axe",
          axeRule: violation.id,
        }),
        axeNodes: violation.nodes.slice(0, 5),
        ...(typeof first?.html === "string" ? { domSnippet: first.html } : {}),
      });
    }

    const pixel = published.pixel;
    const max = published.maxDiffRatio;
    if (pixel?.status === "unavailable")
      missing.push(`pixel difference (${pixel.reason})`);
    if (pixel?.status === "measured" && max !== undefined && pixel.ratio > max)
      candidates.push({
        category: this.id,
        severity: "blocker",
        rule: "published:pixel-budget",
        selectorHint: "document",
        explanation: `${percent(pixel.ratio)} of pixels differ from the recorded baseline (budget ${percent(max)}).`,
        acceptance: [
          `At most ${percent(max)} of pixels differ from the recorded baseline, or the baseline is re-recorded deliberately.`,
        ],
        verification: verify(this.id, {
          rule: "pixel-budget",
          maxDiffRatio: max,
        }),
      });

    return {
      coverage:
        missing.length === 0
          ? { check: this.id, status: "ran" }
          : {
              check: this.id,
              status: "unavailable",
              reason: `could not measure: ${missing.join("; ")}`,
            },
      candidates,
    };
  },
};

import { defaultChecksSettings } from "../schemas/project.js";
import {
  scanResult,
  skipped,
  unavailable,
  v2Observations,
  verify,
} from "./shared.js";
import type { DeterministicCheck, FindingCandidate } from "./types.js";

export const fontLoadingCheck: DeterministicCheck = {
  id: "font-loading",
  run({ tuple, config }) {
    if (!(config.fonts ?? defaultChecksSettings.fonts).enabled)
      return skipped(this.id, "fonts");
    const fonts = v2Observations(tuple)?.fonts;
    if (fonts === undefined)
      return unavailable(
        this.id,
        "font evidence is unavailable (recapture with this version)",
      );
    if (fonts.status !== "ran")
      return unavailable(
        this.id,
        fonts.reason ?? "font evidence is unavailable",
      );
    const failed = new Set(fonts.failedRequests.map(({ url }) => url));
    const candidates: FindingCandidate[] = [];
    for (const used of fonts.used) {
      const faces = fonts.faces.filter((face) => face.family === used.family);
      if (faces.length === 0) continue;
      const failing =
        faces.some((face) => face.status === "error") ||
        !faces.some((face) => face.status === "loaded") ||
        used.fallback;
      if (!failing) continue;
      const urls = [...new Set(faces.flatMap((face) => face.urls))];
      const failedUrls = urls.filter((url) => failed.has(url));
      const shown = failedUrls.length > 0 ? failedUrls : urls;
      const selector = used.selectors[0] ?? "body";
      const statuses = [...new Set(faces.map((face) => face.status))];
      const loaded = statuses.length === 1 && statuses[0] === "loaded";
      candidates.push({
        category: this.id,
        severity: "major",
        rule: "idiom:font-not-loaded",
        selectorHint: selector,
        fingerprintHint: used.family,
        explanation: `The web font “${used.family}” ${loaded ? "loaded but text renders in the fallback font" : `did not load (${statuses.join(", ")}${used.fallback ? "; text renders in the fallback font" : ""})`} from ${shown.length > 0 ? shown.join(", ") : "a source that is not readable (an inline data URI or a cross-origin stylesheet)"}; it is used by ${used.selectors.join(", ")}.`,
        acceptance: [
          `“${used.family}” loads and renders the text in ${used.selectors.join(", ")}, or the font stack names a font that is available.`,
        ],
        verification: verify(this.id, {
          family: used.family,
          urls: shown,
          selectors: used.selectors,
        }),
      });
    }
    return scanResult(this.id, candidates, fonts);
  },
};

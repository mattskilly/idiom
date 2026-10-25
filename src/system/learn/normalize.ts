import { chromium } from "playwright";
import type { BrowserLaunch } from "../../learn/target.js";
import type { NormalizationInput, NormalizedValue } from "./types.js";

/** Self-contained: also embedded verbatim in the offline system report. */
export function normalizeCssValues(
  inputs: NormalizationInput[],
): NormalizedValue[] {
  const documentRoot = document.documentElement;
  const originalFont = documentRoot.style.getPropertyValue("font-size");
  const originalPriority = documentRoot.style.getPropertyPriority("font-size");
  const host = document.createElement("div");
  host.style.cssText =
    "all:initial!important;position:fixed!important;left:-10000px!important;visibility:hidden!important;";
  document.body.append(host);
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 1;
  const context = canvas.getContext("2d", {
    willReadFrequently: true,
    colorSpace: "srgb",
  });
  const results: NormalizedValue[] = [];
  try {
    for (const input of inputs) {
      if (input.rootFontSize !== undefined)
        documentRoot.style.setProperty(
          "font-size",
          `${input.rootFontSize}px`,
          "important",
        );
      else if (originalFont)
        documentRoot.style.setProperty(
          "font-size",
          originalFont,
          originalPriority,
        );
      else documentRoot.style.removeProperty("font-size");
      if (input.kind === "other") {
        results.push({ reason: "Display-only declaration" });
        continue;
      }
      if (
        /\b(?:currentcolor|inherit|unset|revert|initial)\b/i.test(
          input.value,
        ) ||
        /(?:^|[^\w-])(?:env|url)\(/i.test(input.value)
      ) {
        results.push({ reason: "Context-dependent CSS value" });
        continue;
      }
      const probes = ["rgb(1, 2, 3)", "rgb(4, 5, 6)"].map((sentinel, index) => {
        const parent = document.createElement("div");
        parent.style.cssText = `all:initial!important;display:block!important;width:${index ? 257 : 131}px!important;color:${sentinel}!important;`;
        const probe = document.createElement("div");
        probe.style.cssText = `all:initial!important;display:block!important;position:static!important;box-sizing:content-box!important;color-scheme:${input.scheme ?? "light"}!important;`;
        for (const [name, value] of Object.entries(input.environment ?? {}))
          if (/^--[-\w]+$/.test(name)) probe.style.setProperty(name, value);
        parent.append(probe);
        host.append(parent);
        return { parent, probe };
      });
      try {
        if (input.kind === "color") {
          const colors = probes.map(({ probe }) => {
            probe.style.setProperty("color", input.value, "important");
            return probe.style.color
              ? getComputedStyle(probe).color
              : undefined;
          });
          if (!colors[0] || colors[0] !== colors[1] || !context) {
            results.push({ reason: "Unresolved or context-dependent colour" });
            continue;
          }
          context.clearRect(0, 0, 1, 1);
          context.fillStyle = colors[0];
          context.fillRect(0, 0, 1, 1);
          const [r, g, b, a] = context.getImageData(0, 0, 1, 1).data;
          const alpha = Math.round(((a ?? 255) / 255) * 10000) / 10000;
          results.push({
            value:
              alpha === 1
                ? `rgb(${r}, ${g}, ${b})`
                : `rgba(${r}, ${g}, ${b}, ${alpha})`,
          });
        } else {
          // Relative layout lengths cannot be compared without their containing box.
          probes[0]?.probe.style.setProperty("--idiom-candidate", input.value);
          const referenced = probes[0]
            ? getComputedStyle(probes[0].probe).getPropertyValue(
                "--idiom-candidate",
              )
            : input.value;
          if (
            /%|(?:\d|\))\s*(?:em|ex|ch|lh|vw|vh|vmin|vmax|cqw|cqh)\b/i.test(
              referenced,
            )
          ) {
            results.push({
              reason: "Relative or elliptical length needs element context",
            });
            continue;
          }
          const values = probes.map(({ probe }) => {
            probe.style.setProperty("width", input.value, "important");
            return probe.style.width
              ? getComputedStyle(probe).width
              : undefined;
          });
          const value = values[0];
          if (!value || value !== values[1] || !/^-?[\d.]+px$/.test(value)) {
            results.push({ reason: "Unresolved or unsupported CSS length" });
            continue;
          }
          const px = Number(value.slice(0, -2));
          if (!Number.isFinite(px) || px < 0)
            results.push({ reason: "Negative or invalid scale length" });
          else
            results.push({
              value: input.kind === "radius" && px >= 9999 ? "full" : `${px}px`,
              px,
            });
        }
      } finally {
        for (const { parent } of probes) parent.remove();
      }
    }
  } finally {
    host.remove();
    if (originalFont)
      documentRoot.style.setProperty(
        "font-size",
        originalFont,
        originalPriority,
      );
    else documentRoot.style.removeProperty("font-size");
  }
  return results;
}

export async function normalizeInBrowser(
  inputs: NormalizationInput[],
  launch?: BrowserLaunch,
): Promise<NormalizedValue[]> {
  const browser = await (
    launch ?? (() => chromium.launch({ headless: true }))
  )();
  try {
    const page = await browser.newPage();
    await page.route("**/*", (route) => route.abort());
    await page.setContent(
      "<!doctype html><html><head><meta http-equiv='Content-Security-Policy' content=\"default-src 'none'; style-src 'unsafe-inline'\"></head><body></body></html>",
    );
    return await page.evaluate(normalizeCssValues, inputs);
  } finally {
    await browser.close();
  }
}
export const pixelTolerance = 0.5;
export function spacingOnScale(
  value: number,
  scale: ReadonlyArray<number | { multipleOf: number }>,
): boolean {
  return scale.some((entry) =>
    typeof entry === "number"
      ? Math.abs(value - entry) <= pixelTolerance
      : Math.abs(
          value - Math.round(value / entry.multipleOf) * entry.multipleOf,
        ) <= pixelTolerance,
  );
}

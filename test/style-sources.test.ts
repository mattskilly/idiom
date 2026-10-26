import { chromium } from "playwright";
import { expect, test } from "vitest";
import { observationArtifactSchema } from "../src/checks/artifact-schema.js";
import { observePage } from "../src/checks/observe.js";
import type { ObservedElementV2 } from "../src/checks/types.js";

const markup = `<!doctype html><html><head><style>
:root { --sp: 8px; }
.pad { padding: var(--sp); }
.broken { border-radius: var(--missing, 4px); border: 1px solid #000; }
#winner { padding: 12px; }
.loser { padding: 2px; }
.imp { padding: 5px !important; }
.weak { margin: 3px; }
:where(.zero) { margin: 1px; }
</style></head><body>
<div id="shorthand" class="pad">a</div>
<div id="unresolved" class="broken">b</div>
<div id="winner" class="loser">c</div>
<div id="inline" class="pad" style="padding: 3px">d</div>
<div id="important" class="imp" style="padding: 7px">e</div>
<div id="where" class="zero weak">f</div>
</body></html>`;

test("styleSources record the winning declaration, its tokens and unresolved custom properties", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({
      viewport: { width: 640, height: 480 },
    });
    await page.setContent(markup);
    const observations = await observePage(page, { status: "not-configured" });
    expect(() => observationArtifactSchema.parse(observations)).not.toThrow();
    const element = (id: string) =>
      (observations.elements as ObservedElementV2[]).find(
        (candidate) => candidate.selector === `#${id}`,
      );
    // A shorthand var() leaves the longhands pending; the shorthand is read.
    expect(element("shorthand")?.styleSources?.paddingTop).toEqual({
      sheet: "<style>[0]",
      selector: ".pad",
      tokens: ["--sp"],
    });
    expect(element("unresolved")?.styleSources?.borderTopLeftRadius).toEqual({
      sheet: "<style>[0]",
      selector: ".broken",
      tokens: ["--missing"],
      unresolved: ["--missing"],
    });
    // Specificity beats order; inline beats normal rules; !important beats inline.
    expect(element("winner")?.styleSources?.paddingLeft?.selector).toBe(
      "#winner",
    );
    expect(element("inline")?.styleSources?.paddingTop).toEqual({
      sheet: "inline",
      selector: "[style]",
    });
    expect(element("important")?.styleSources?.paddingTop?.selector).toBe(
      ".imp",
    );
    // :where() adds no specificity, so the earlier class rule still wins.
    expect(element("where")?.styleSources?.marginTop?.selector).toBe(".weak");
    // Unauthored properties carry no source.
    expect(element("shorthand")?.styleSources?.boxShadow).toBeUndefined();
  } finally {
    await browser.close();
  }
}, 30_000);

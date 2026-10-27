import { readFile } from "node:fs/promises";
import { type Browser, chromium } from "playwright";
import { afterAll, beforeAll, expect, test } from "vitest";
import { observationArtifactSchema } from "../src/checks/artifact-schema.js";
import { clippedTextCheck } from "../src/checks/clipped-text.js";
import { observePage } from "../src/checks/observe.js";
import { checksConfigSchema } from "../src/schemas/project.js";

const font = (
  await readFile(
    new URL("./fixtures/overlap-clipped/descender.ttf", import.meta.url),
  )
).toString("base64");
const fontCss = `@font-face { font-family: Field; src:url(data:font/ttf;base64,${font}); }`;
let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch();
});
afterAll(async () => {
  await browser.close();
});

const phrase = "Fresh curry made daily for everyone ";
function tickerHtml(
  css = "",
  content = `<span id="text">${phrase}</span><span>${phrase}</span>`,
  animation = "",
) {
  return `<!doctype html><style>
    body { margin:40px; font:20px/30px Arial; }
    #strip { width:180px; overflow:hidden; }
    #track { display:flex; width:max-content; animation: ticker 1000s linear infinite; }
    #track span { flex:none; white-space:nowrap; }
    @keyframes ticker { from { transform:translateX(0%); } to { transform:translateX(-50%); } }
    ${css}
  </style><div id="strip"><div id="track">${content}</div></div>
  <script>${animation}</script>`;
}

async function inspect(html: string, phase = 0.2) {
  const page = await browser.newPage();
  try {
    await page.setContent(html);
    await page.evaluate(async (phase) => {
      await document.fonts.ready;
      for (const animation of document.getAnimations()) {
        await animation.ready;
        animation.currentTime =
          phase * Number(animation.effect?.getTiming().duration);
      }
    }, phase);
    const evidence = await page.evaluate(() => {
      const text = document.querySelector("#text") as Element;
      const range = document.createRange();
      range.selectNodeContents(text);
      const strip = document.querySelector("#strip")?.getBoundingClientRect();
      const style = getComputedStyle(text);
      const canvas = document.createElement("canvas").getContext("2d");
      if (canvas === null) throw new Error("missing canvas");
      canvas.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
      const metrics = canvas.measureText(text.textContent ?? "");
      return {
        descent: metrics.fontBoundingBoxDescent,
        inkDescent: metrics.actualBoundingBoxDescent,
        rects: [...range.getClientRects()].map((r) => ({
          top: r.top,
          bottom: r.bottom,
          left: r.left,
          right: r.right,
        })),
        strip: strip?.toJSON(),
        animations: document.getAnimations().map((a) => a.playState),
      };
    });
    const observation = observationArtifactSchema.parse(
      await observePage(page, { status: "not-configured" }),
    );
    if (observation.version !== 2)
      throw new Error("expected current observation");
    // Exercise the unchanged consumer as well as capture, with the normal settings.
    const result = clippedTextCheck.run({
      tuple: {
        observations: observation,
        flow: "field",
        state: "field",
        viewport: "desktop",
        width: 1280,
        height: 720,
        metadataPath: "",
        artifactPaths: [],
        commit: "test",
        createdAt: "",
        console: [],
        mismatches: [],
      },
      config: checksConfigSchema.parse({}),
      narrowViewport: false,
    });
    return { observation, result, evidence };
  } finally {
    await page.close();
  }
}

test.each([0.1, 0.3])(
  "repeated translating sibling track is quiet at phase %s",
  async (phase) => {
    const { observation, result, evidence } = await inspect(
      tickerHtml(),
      phase,
    );
    expect(evidence.animations).toEqual(["running"]);
    expect(evidence.rects[0]?.right).toBeGreaterThan(evidence.strip.right);
    expect(
      observation.elements.find((e) => e.selector === "#text")?.painted?.value,
    ).toBe(true);
    expect(observation.clippedText).toEqual([]);
    expect(result.candidates).toEqual([]);
  },
);

test.each([20, 40])(
  "small readable top overrun at %spx is quiet with contained lowercase ink",
  async (size) => {
    const { observation, result } =
      await inspect(`<!doctype html><style>${fontCss}
    body{margin:40px} #strip{overflow:hidden;width:400px;height:${size * 2.5}px}
    #text{font:${size}px/${size}px Field; position:relative;top:${-size * 0.28}px}
    </style><div id="strip"><div id="text">gypsy curry<br>gypsy curry</div></div>`);
    expect(observation.clippedText).toEqual([]);
    expect(result.candidates).toEqual([]);
  },
);

function paragraph(size = 20, text = "HELLO THERE", cut = 2.5, extra = "") {
  // Place the test clip relative to the final line rectangle, before observation.
  return `<!doctype html><style>${fontCss}
    body{margin:40px} #strip{overflow:hidden;width:400px}
    #text{font:${size}px/${size}px Field;padding-top:5px}
    ${extra}</style><div id="strip"><div id="text">${text}<br>${text}</div></div>
    <script>document.fonts.ready.then(() => {
      const range=document.createRange(); range.selectNodeContents(document.querySelector('#text'));
      const rect=[...range.getClientRects()].at(-1);
      document.querySelector('#strip').style.height=(rect.bottom - rect.height*.2 - ${cut} - document.querySelector('#strip').getBoundingClientRect().top)+'px';
    });</script>`;
}

test.each([
  [20, 2.5],
  [40, 5],
] as const)(
  "two lines with harmless bottom overrun at %ipx (%spx) are quiet",
  async (size, cut) => {
    const { observation, result, evidence } = await inspect(
      paragraph(size, "HELLO THERE", cut),
    );
    const last = evidence.rects.at(-1);
    if (last === undefined) throw new Error("missing line");
    expect(
      last.bottom - (last.bottom - last.top) * 0.2 - evidence.strip.bottom,
    ).toBeCloseTo(cut, 1);
    expect(cut).toBeLessThan(evidence.descent);
    expect(
      observation.elements.find((e) => e.selector === "#text")?.painted?.value,
    ).toBe(true);
    expect(observation.clippedText).toEqual([]);
    expect(result.candidates).toEqual([]);
  },
);

test.each([
  ["descender ink", "gypsy curry", 2.5, ""],
  ["equal font descent", "HELLO THERE", 10, ""],
  ["above font descent", "HELLO THERE", 11, ""],
  [
    "uppercase ink at upper edge",
    "HELLO THERE",
    2.5,
    "#text{position:relative;top:-12px}",
  ],
  ["hidden wrapped lines", "HELLO THERE", 24, ""],
  [
    "unsupported scaled geometry",
    "HELLO THERE",
    2.5,
    "#strip{transform:scale(.9)}",
  ],
] as const)("retains %s", async (_name, text, cut, extra) => {
  const { observation, result } = await inspect(
    paragraph(20, text, cut, extra),
  );
  expect(
    observation.clippedText?.find((c) => c.selector === "#text")?.axis,
  ).toBe("y");
  expect(result.candidates.some((c) => c.rule === "idiom:text-clipped")).toBe(
    true,
  );
});

test("horizontal cut survives the font-space exemption", async () => {
  const { observation } = await inspect(
    paragraph(
      20,
      "HELLO THERE",
      2.5,
      "#strip{width:65px} #text{white-space:nowrap}",
    ),
  );
  expect(observation.clippedText?.[0]).toMatchObject({
    axis: "x",
    owner: "#strip",
    overflow: { y: 0 },
    cut: "mid-word",
  });
});

test.each([
  [
    "inline complete copies",
    "",
    `<span id="text">${phrase}${phrase}</span>`,
    "",
  ],
  [
    "duplicated child sequence",
    "",
    `<span id="text">Fresh curry </span><span>made daily for everyone </span><span>Fresh curry </span><span>made daily for everyone </span>`,
    "",
  ],
  [
    "individual translate",
    "@keyframes ticker {from{translate:0% 0}to{translate:-50% 0}}",
    undefined,
    "",
  ],
  [
    "translate3d",
    "@keyframes ticker {from{transform:translate3d(0%,0,0)}to{transform:translate3d(-50%,0,0)}}",
    undefined,
    "",
  ],
  [
    "equivalent matrices",
    "@keyframes ticker {from{transform:matrix(1,0,0,1,0,0)}to{transform:matrix(1,0,0,1,-100,0)}}",
    undefined,
    "",
  ],
  [
    "Web Animations",
    "#track{animation:none}",
    undefined,
    "document.querySelector('#track').animate([{transform:'translateX(0px)'},{transform:'translateX(-100px)'}], {duration:1000000,iterations:Infinity});",
  ],
  [
    "active finite animation",
    "#track{animation-iteration-count:1}",
    undefined,
    "",
  ],
] as const)("recognizes %s", async (_name, css, content, script) => {
  for (const phase of [0.1, 0.3]) {
    const { observation, result, evidence } = await inspect(
      tickerHtml(css, content, script),
      phase,
    );
    expect(evidence.animations).toEqual(["running"]);
    expect(observation.clippedText).toEqual([]);
    expect(result.candidates).toEqual([]);
  }
});

test.each([
  ["static repeated row", "#track{animation:none}", undefined, ""],
  [
    "static transform",
    "#track{animation:none;transform:translateX(-30px)}",
    undefined,
    "",
  ],
  ["missing animation", "#track{animation-name:missing}", undefined, ""],
  ["paused effect", "#track{animation-play-state:paused}", undefined, ""],
  [
    "zero playback rate",
    "",
    undefined,
    "document.querySelector('#track').getAnimations()[0].playbackRate=0",
  ],
  [
    "opacity",
    "@keyframes ticker {from{opacity:1}to{opacity:.8}}",
    undefined,
    "",
  ],
  [
    "rotation",
    "@keyframes ticker {from{transform:rotate(0deg)}to{transform:rotate(2deg)}}",
    undefined,
    "",
  ],
  ["statically rotated track", "#track{rotate:2deg}", undefined, ""],
  ["statically scaled track", "#track{scale:1.05}", undefined, ""],
  [
    "moving nonrepeated label",
    "",
    `<span id="text">${phrase}A unique ending</span>`,
    "",
  ],
  [
    "repeated individual words",
    "",
    `<span id="text">Fresh curry curry made daily</span>`,
    "",
  ],
  [
    "ancestor outside strip",
    "#track{animation:none}body{animation:ticker 1000s infinite}",
    undefined,
    "",
  ],
  [
    "pseudo-element effect",
    "#track{animation:none}#track::before{content:'';animation:ticker 1000s infinite}",
    undefined,
    "",
  ],
  ["nested clipped label", "#text{width:110px;overflow:hidden}", undefined, ""],
] as const)("retains %s", async (_name, css, content, script) => {
  const { observation, result } = await inspect(
    tickerHtml(css, content, script),
  );
  expect(observation.clippedText?.some((c) => c.selector === "#text")).toBe(
    true,
  );
  expect(result.candidates.some((c) => c.rule === "idiom:text-clipped")).toBe(
    true,
  );
});

test("ticker horizontal exemption preserves vertical owner and sliced-line classification", async () => {
  const { observation, result } = await inspect(
    tickerHtml("#strip{height:18px}"),
  );
  expect(observation.clippedText?.[0]).toMatchObject({
    selector: "#text",
    axis: "y",
    owner: "#strip",
    overflow: { x: 0 },
    cut: "sliced-line",
  });
  expect(result.candidates).toHaveLength(1);
});

test("uppercase transformation measures the painted capitals at the upper clip", async () => {
  const { observation, result } =
    await inspect(`<!doctype html><style>${fontCss}
    body{margin:40px} #strip{overflow:hidden;width:400px;height:60px}
    #text{font:20px/20px Field;position:relative;top:-5.6px;text-transform:uppercase}
    </style><div id="strip"><div id="text">gypsy curry<br>gypsy curry</div></div>`);
  expect(observation.clippedText?.[0]).toMatchObject({
    axis: "y",
    cut: "sliced-line",
  });
  expect(result.candidates).toHaveLength(1);
});

test("incomplete character sampling cannot grant the font-space exemption", async () => {
  const { observation } = await inspect(
    paragraph(
      20,
      "HELLO ".repeat(90),
      2.5,
      "#strip{width:10000px}#text{white-space:nowrap}",
    ),
  );
  expect(observation.clippedText?.[0]).toMatchObject({ axis: "y" });
});

test("ticker horizontal exemption names a separate vertical clipping owner", async () => {
  const content = `<div id="vertical"><span id="text">${phrase}</span></div><span>${phrase}</span>`;
  const { observation } = await inspect(
    tickerHtml("#vertical{height:18px;overflow:hidden;flex:none}", content),
  );
  expect(observation.clippedText?.[0]).toMatchObject({
    selector: "#text",
    axis: "y",
    owner: "#vertical",
    overflow: { x: 0 },
  });
});

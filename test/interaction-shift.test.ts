import { describe, expect, test } from "vitest";
import {
  attributeShift,
  interactionShiftCheck,
  interactionShifts,
  isLate,
  type ShiftCause,
  shiftFix,
} from "../src/checks/interaction-shift.js";
import { layoutShiftCheck } from "../src/checks/layout-shift.js";
import { checksConfigFrom } from "../src/checks/registry.js";
import type {
  ActionTimeline,
  ActionTimelineArtifact,
  CheckTuple,
} from "../src/checks/types.js";
import { checksConfigSchema } from "../src/schemas/project.js";

type Box = [x: number, y: number, width: number, height: number];
type Sample = Record<string, Box>;
const rect = ([x, y, width, height]: Box) => ({ x, y, width, height });
const viewport = { width: 1440, height: 900 };
const settings = { minDistance: 4 };

/** A synthetic action: `frames` maps time to the samples recorded then. */
function action(
  frames: Array<[time: number, elements: Sample, scroll?: number]>,
  extra: Partial<ActionTimeline> = {},
): ActionTimeline {
  return {
    id: "probe-1",
    source: "probe-click",
    kind: "click",
    selector: "button#show",
    name: "Show notice",
    url: "/",
    startedAt: 0,
    durationMs: 400,
    settled: true,
    status: "ran",
    truncated: [],
    shifts: [],
    frames: frames.map(([time, elements, scroll = 0]) => ({
      time,
      scroll: { x: 0, y: scroll },
      scrollers: [],
      elements: Object.entries(elements).map(([selector, box]) => ({
        selector,
        rect: { ...rect(box), y: box[1] - scroll },
        offset: { x: 0, y: scroll },
      })),
    })),
    mutations: [],
    animations: [],
    requests: [],
    viewTransition: { used: false },
    effectRegion: { control: "button#show", controls: [] },
    ...extra,
  };
}

const insert = (selector: string, time: number, box: Box) => ({
  time,
  type: "insert" as const,
  selector,
  rect: rect(box),
});

/** Three baseline blocks pushed 48px down by a banner inserted at the top. */
const banner = (time = 30, extra: Partial<ActionTimeline> = {}) =>
  action(
    [
      [
        0,
        {
          "button#show": [24, 16, 120, 32],
          "main > h2": [0, 64, 1440, 40],
          "div.summary": [0, 104, 1440, 200],
          footer: [0, 304, 1440, 80],
        },
      ],
      [
        time + 5,
        {
          "div.banner": [0, 0, 1440, 48],
          "button#show": [24, 64, 120, 32],
          "main > h2": [0, 112, 1440, 40],
          "div.summary": [0, 152, 1440, 200],
          footer: [0, 352, 1440, 80],
        },
      ],
    ],
    { mutations: [insert("div.banner", time, [0, 0, 1440, 48])], ...extra },
  );

const candidate = (start: Box, end: Box, peakAt = 50) => ({
  start: rect(start),
  end: rect(end),
  peakAt,
  peakDx: end[0] - start[0],
  peakDy: end[1] - start[1],
});
const cause = (
  kind: ShiftCause["kind"],
  box: Box,
  final: Box = box,
  extra: Partial<ShiftCause> = {},
): ShiftCause => ({
  selector: `div.${kind}`,
  kind,
  time: 20,
  rect: rect(box),
  final: rect(final),
  ...extra,
});

describe("attributeShift", () => {
  test("a 48px insert at y=0 pushes content that started at y=0", () => {
    const insert = cause("insert", [0, 0, 1440, 48]);
    expect(
      attributeShift(candidate([0, 0, 1440, 40], [0, 48, 1440, 40]), [insert]),
    ).toBe(insert);
  });
  test("a box at 0..100 that grows to 148 pushes content at y=100", () => {
    const resize = cause("resize", [0, 0, 1440, 100], [0, 0, 1440, 148], {
      delta: { dw: 0, dh: 48 },
    });
    expect(
      attributeShift(candidate([0, 100, 1440, 40], [0, 148, 1440, 40]), [
        resize,
      ]),
    ).toBe(resize);
  });
  test("a removed 40px row above pulls content up", () => {
    const remove = cause("remove", [0, 60, 1440, 40]);
    expect(
      attributeShift(candidate([0, 100, 1440, 40], [0, 60, 1440, 40]), [
        remove,
      ]),
    ).toBe(remove);
  });
  test("an insert below the candidate is not its cause", () => {
    expect(
      attributeShift(candidate([0, 100, 1440, 40], [0, 148, 1440, 40]), [
        cause("insert", [0, 300, 1440, 48]),
      ]),
    ).toBeUndefined();
  });
  test("an insert that ends up containing the candidate is not its cause", () => {
    expect(
      attributeShift(candidate([0, 100, 400, 40], [0, 148, 400, 40]), [
        cause("insert", [0, 0, 1440, 300]),
      ]),
    ).toBeUndefined();
  });
  test("a resize that only grew sideways does not push content down", () => {
    expect(
      attributeShift(candidate([0, 100, 1440, 40], [0, 148, 1440, 40]), [
        cause("resize", [0, 0, 1440, 100], [0, 0, 1400, 100], {
          delta: { dw: -40, dh: 0 },
        }),
      ]),
    ).toBeUndefined();
  });
  test("a column beside the content that grew taller pushes nothing down", () => {
    expect(
      attributeShift(candidate([400, 300, 800, 40], [400, 338, 800, 40]), [
        cause("resize", [0, 0, 320, 4000], [0, 0, 320, 4038], {
          delta: { dw: 0, dh: 38 },
        }),
      ]),
    ).toBeUndefined();
  });
  test("causes too small to account for the distance explain nothing", () => {
    expect(
      attributeShift(candidate([0, 100, 1440, 40], [0, 2100, 1440, 40]), [
        cause("resize", [0, 0, 120, 20], [0, 0, 120, 24], {
          delta: { dw: 0, dh: 4 },
        }),
      ]),
    ).toBeUndefined();
  });
  test("a cause after the movement is not its cause", () => {
    expect(
      attributeShift(candidate([0, 100, 1440, 40], [0, 148, 1440, 40], 50), [
        cause("insert", [0, 0, 1440, 48], [0, 0, 1440, 48], { time: 200 }),
      ]),
    ).toBeUndefined();
  });
});

describe("interactionShifts", () => {
  test("a banner inserted at the top displaces the content below it", () => {
    const [shift, ...rest] = interactionShifts(banner(), viewport, settings);
    expect(rest).toEqual([]);
    expect(shift?.cause.selector).toBe("div.banner");
    expect(shift?.late).toBe(false);
    // The control is the effect region; ranked by area × distance.
    expect(shift?.moved.map((entry) => entry.selector)).toEqual([
      "div.summary",
      "footer",
      "main > h2",
    ]);
  });

  const local = (time: number) =>
    action(
      [
        [
          0,
          {
            "section.panel": [0, 100, 1440, 400],
            "p.lede": [0, 120, 1440, 40],
          },
        ],
        [
          time + 5,
          {
            "p.news": [0, 120, 1440, 40],
            "p.lede": [0, 160, 1440, 40],
          },
        ],
      ],
      {
        mutations: [insert("p.news", time, [0, 120, 1440, 40])],
        effectRegion: {
          control: "button#show",
          controls: [],
          commonAncestor: "section.panel",
        },
      },
    );
  test("late content inside the local effect region is still reported", () => {
    const [shift] = interactionShifts(local(700), viewport, settings);
    expect(shift?.late).toBe(true);
    expect(shift?.moved.map((entry) => entry.selector)).toEqual(["p.lede"]);
  });
  test("the same content within 500ms inside the region is the action's effect", () => {
    expect(interactionShifts(local(200), viewport, settings)).toEqual([]);
  });

  const batches = (times: number[]) =>
    action(
      [
        [
          0,
          { "section.panel": [0, 100, 1440, 700], footer: [0, 300, 1440, 80] },
        ],
        ...times.map((time, index): [number, Sample] => [
          time + 10,
          {
            ...Object.fromEntries(
              times
                .slice(0, index + 1)
                .map((_, item) => [
                  `li.batch-${item}`,
                  [0, 300 + item * 50, 1440, 50] as Box,
                ]),
            ),
            footer: [0, 350 + index * 50, 1440, 80],
          },
        ]),
      ],
      {
        mutations: times.map((time, index) =>
          insert(`li.batch-${index}`, time, [0, 300 + index * 50, 1440, 50]),
        ),
        effectRegion: { controls: [], commonAncestor: "section.panel" },
      },
    );

  test.each([2, 3])(
    "%i staggered late inserts each report their own jump",
    (count) => {
      const times = [690, 990, 1290].slice(0, count);
      const shifts = interactionShifts(batches(times), viewport, settings);
      expect(shifts).toHaveLength(count);
      expect(
        shifts.map(({ cause, late, moved }) => ({
          cause: cause.selector,
          time: cause.time,
          late,
          moved: moved.map(({ selector, peak }) => ({ selector, peak })),
        })),
      ).toEqual(
        times.map((time, index) => ({
          cause: `li.batch-${index}`,
          time,
          late: true,
          moved: [{ selector: "footer", peak: 50 }],
        })),
      );
      const findings = run(
        tuple({ timelines: artifact([batches(times)]) }),
      ).candidates;
      expect(findings).toHaveLength(count);
      for (const finding of findings) {
        expect(finding).toMatchObject({
          severity: "major",
          timeline: "probe-1",
        });
        expect(finding.explanation).toContain("content moved 50px down");
        expect(finding.fix).toContain("min-height: 50px");
      }
    },
  );

  test("a late batch is reported after an immediate batch inside the effect region", () => {
    const shifts = interactionShifts(batches([190, 990]), viewport, settings);
    expect(shifts).toHaveLength(1);
    expect(shifts[0]?.cause.selector).toBe("li.batch-1");
    expect(shifts[0]?.late).toBe(true);
    expect(shifts[0]?.moved[0]?.peak).toBe(50);
  });

  test("staggered inserts with animated displacement remain excluded", () => {
    const timeline = batches([690, 990, 1290]);
    timeline.animations = [
      {
        target: "footer",
        kind: "transition",
        properties: ["transform"],
        durationMs: 800,
        delayMs: 0,
        iterations: 1,
        startTime: 680,
        endTime: 1480,
      },
    ];
    expect(interactionShifts(timeline, viewport, settings)).toEqual([]);
  });

  test("a body or viewport-tall common ancestor is not an effect region", () => {
    for (const commonAncestor of ["body", "div.page"]) {
      const timeline = banner(30, {
        effectRegion: { control: "button#show", controls: [], commonAncestor },
      });
      timeline.frames[0]?.elements.push({
        selector: "div.page",
        rect: rect([0, 0, 1440, 2000]),
        offset: { x: 0, y: 0 },
      });
      expect(interactionShifts(timeline, viewport, settings)).toHaveLength(1);
    }
  });

  test("scrolling moves nothing once offsets are compensated", () => {
    const timeline = action([
      [0, { "main > h2": [0, 64, 1440, 40], footer: [0, 304, 1440, 80] }],
      [40, { "main > h2": [0, 64, 1440, 40], footer: [0, 304, 1440, 80] }, 300],
    ]);
    timeline.mutations.push(insert("div.banner", 10, [0, 0, 1440, 48]));
    expect(interactionShifts(timeline, viewport, settings)).toEqual([]);
  });

  test("content inside the control or its controlled target is its own effect", () => {
    const timeline = banner(30, {
      effectRegion: { control: "button#show", controls: ["div.wrap"] },
    });
    timeline.frames[0]?.elements.push({
      selector: "div.wrap",
      rect: rect([0, 60, 1440, 400]),
      offset: { x: 0, y: 0 },
    });
    expect(interactionShifts(timeline, viewport, settings)).toEqual([]);
  });

  const rows = (order: string[], y0 = 100) =>
    Object.fromEntries(
      order.map((name, index) => [
        `div.row-${name}`,
        [0, y0 + index * 40, 600, 40] as Box,
      ]),
    );
  test("sorting rows inside a list is not a shift", () => {
    const timeline = action(
      [
        [0, rows(["c", "a", "b"])],
        [30, rows(["a", "b", "c"])],
      ],
      {
        mutations: [
          {
            time: 20,
            type: "remove",
            selector: "div.row-x",
            rect: rect([0, 100, 600, 40]),
          },
        ],
      },
    );
    expect(interactionShifts(timeline, viewport, settings)).toEqual([]);
  });
  test("filtering rows that close up is not a shift", () => {
    const timeline = action(
      [
        [0, rows(["a", "b", "c", "d"])],
        [30, rows(["a", "c", "d"])],
      ],
      {
        mutations: [
          {
            time: 20,
            type: "remove",
            selector: "div.row-b",
            rect: rect([0, 140, 600, 40]),
          },
        ],
      },
    );
    expect(interactionShifts(timeline, viewport, settings)).toEqual([]);
  });
  test("a banner pushing a list breaks closure and is reported", () => {
    const timeline = action(
      [
        [0, rows(["a", "b", "c"])],
        [
          30,
          { "div.banner": [0, 100, 600, 40], ...rows(["a", "b", "c"], 140) },
        ],
      ],
      { mutations: [insert("div.banner", 20, [0, 100, 600, 40])] },
    );
    const [shift] = interactionShifts(timeline, viewport, settings);
    expect(shift?.moved).toHaveLength(3);
  });

  test("gradual movement is a transition, not a shift", () => {
    const timeline = banner();
    const frames = timeline.frames;
    timeline.frames = [
      frames[0] as ActionTimeline["frames"][number],
      ...[16, 32].map((y, index) => ({
        time: 40 + index * 16,
        scroll: { x: 0, y: 0 },
        scrollers: [],
        elements: [
          {
            selector: "footer",
            rect: rect([0, 304 + y, 1440, 80]),
            offset: { x: 0, y: 0 },
          },
        ],
      })),
      { ...(frames[1] as ActionTimeline["frames"][number]), time: 90 },
    ];
    const moved = interactionShifts(timeline, viewport, settings).flatMap(
      (shift) => shift.moved.map((entry) => entry.selector),
    );
    expect(moved).not.toContain("footer");
    expect(moved).toContain("div.summary");
  });

  const animation = (properties: string[]) => ({
    target: "div.banner",
    kind: "transition" as const,
    properties,
    durationMs: 200,
    delayMs: 0,
    iterations: 1,
    startTime: 30,
    endTime: 230,
  });
  test("an animated height on the cause is a transition", () => {
    expect(
      interactionShifts(
        banner(30, { animations: [animation(["height"])] }),
        viewport,
        settings,
      ),
    ).toEqual([]);
  });
  test("an opacity-only animation does not excuse a push", () => {
    expect(
      interactionShifts(
        banner(30, { animations: [animation(["opacity"])] }),
        viewport,
        settings,
      ),
    ).toHaveLength(1);
  });

  test("movement entirely below the fold is not seen", () => {
    const timeline = action(
      [
        [0, { "section.later": [0, 1100, 1440, 200] }],
        [
          30,
          {
            "div.entry": [0, 1000, 1440, 100],
            "section.later": [0, 1200, 1440, 200],
          },
        ],
      ],
      { mutations: [insert("div.entry", 20, [0, 1000, 1440, 100])] },
    );
    expect(interactionShifts(timeline, viewport, settings)).toEqual([]);
  });

  test("pinned content that kept its place on screen is not displaced", () => {
    // A sticky header follows a 106px scroll clamp in document coordinates
    // but never moves on screen; the table below it really shrank.
    const timeline = action([
      [
        0,
        {
          "header.sticky": [0, 500, 1440, 60],
          "div.table": [0, 560, 1440, 400],
        },
        500,
      ],
      [
        30,
        {
          "header.sticky": [0, 394, 1440, 60],
          "div.table": [0, 560, 1440, 294],
        },
        394,
      ],
    ]);
    // A removal above it would otherwise account for the movement.
    timeline.mutations.push({
      time: 20,
      type: "remove",
      selector: "tr.row",
      rect: { x: 0, y: -120, width: 1440, height: 106 },
    });
    expect(interactionShifts(timeline, viewport, settings)).toEqual([]);
  });

  test("a container that collapsed to nothing was emptied, not displaced", () => {
    const timeline = banner();
    const footer = timeline.frames[1]?.elements.find(
      (element) => element.selector === "footer",
    );
    if (footer) footer.rect = { ...footer.rect, height: 0 };
    const [shift] = interactionShifts(timeline, viewport, settings);
    expect(shift?.moved.map((entry) => entry.selector)).toEqual([
      "div.summary",
      "main > h2",
    ]);
  });

  test("closing what the user clicked in lets the page close up behind it", () => {
    // Unpinning a sidebar panel removes it and narrows the header search,
    // which moves the tools beside it.
    const unpin = (control: Box) =>
      action(
        [
          [
            0,
            {
              "button#show": control,
              "div.panel": [1100, 200, 200, 400],
              "div.search": [240, 16, 954, 32],
              "nav.tools": [1194, 16, 200, 32],
            },
          ],
          [
            30,
            {
              "div.search": [240, 16, 914, 32],
              "nav.tools": [1154, 16, 200, 32],
            },
          ],
        ],
        {
          mutations: [
            {
              time: 20,
              type: "remove",
              selector: "div.panel",
              rect: rect([1100, 200, 200, 400]),
            },
          ],
        },
      );
    expect(
      interactionShifts(unpin([1110, 210, 120, 32]), viewport, settings),
    ).toEqual([]);
    // The same removal from a control outside the panel moves the tools.
    expect(
      interactionShifts(unpin([24, 600, 120, 32]), viewport, settings),
    ).toHaveLength(1);
  });

  test("a cause that was itself pushed joins the shift that pushed it", () => {
    // Table columns: the first widens and pushes the second, which then
    // widens too and pushes the third.
    const timeline = action([
      [
        0,
        {
          "th.a": [0, 0, 100, 40],
          "th.b": [100, 0, 100, 40],
          "th.c": [200, 0, 100, 40],
        },
      ],
      [
        20,
        {
          "th.a": [0, 0, 140, 40],
          "th.b": [140, 0, 100, 40],
          "th.c": [240, 0, 100, 40],
        },
      ],
      [
        40,
        {
          "th.a": [0, 0, 140, 40],
          "th.b": [140, 0, 130, 40],
          "th.c": [270, 0, 100, 40],
        },
      ],
    ]);
    const shifts = interactionShifts(timeline, viewport, settings);
    expect(shifts).toHaveLength(1);
    expect(shifts[0]?.cause.selector).toBe("th.a");
    expect(shifts[0]?.moved.map((entry) => entry.selector).sort()).toEqual([
      "th.b",
      "th.c",
    ]);
  });

  test("movement with no cause is not reported", () => {
    const timeline = banner();
    timeline.mutations = [];
    expect(interactionShifts(timeline, viewport, settings)).toEqual([]);
  });

  test("an html or body resize is not a cause", () => {
    const timeline = action([
      [0, { body: [0, 0, 1440, 400], "main > h2": [8, 100, 1424, 40] }],
      [30, { body: [0, 0, 1425, 400], "main > h2": [0, 100, 1409, 40] }],
    ]);
    expect(interactionShifts(timeline, viewport, settings)).toEqual([]);
  });

  test("3px is under the default threshold; minDistance 2 reports it", () => {
    const timeline = action(
      [
        [0, { "p.after": [0, 100, 1440, 40] }],
        [
          30,
          { "span.badge": [0, 80, 1440, 23], "p.after": [0, 103, 1440, 40] },
        ],
      ],
      { mutations: [insert("span.badge", 20, [0, 80, 1440, 23])] },
    );
    expect(interactionShifts(timeline, viewport, settings)).toEqual([]);
    expect(
      interactionShifts(timeline, viewport, { minDistance: 2 }),
    ).toHaveLength(1);
  });

  test("joined elements are never displaced; an excursion that returns is", () => {
    const timeline = action(
      [
        [0, { "p.after": [0, 100, 1440, 40] }],
        [
          30,
          { "div.toast": [0, 100, 1440, 48], "p.after": [0, 148, 1440, 40] },
        ],
        [
          300,
          { "div.toast": [0, 300, 1440, 48], "p.after": [0, 100, 1440, 40] },
        ],
      ],
      {
        mutations: [
          insert("div.toast", 20, [0, 100, 1440, 48]),
          {
            time: 290,
            type: "remove",
            selector: "div.toast",
            rect: rect([0, 100, 1440, 48]),
          },
        ],
      },
    );
    const [shift, ...rest] = interactionShifts(timeline, viewport, settings);
    expect(rest).toEqual([]);
    expect(shift?.moved.map((entry) => entry.selector)).toEqual(["p.after"]);
    expect(shift?.moved[0]?.peak).toBe(48);
  });
});

describe("isLate", () => {
  test("a resize is late only when it provably happened after 500ms", () => {
    // Sampled at 3ms and next at 1183ms: the change may have been immediate.
    const sparse = cause("resize", [0, 0, 27, 8], [0, 0, 23, 8], {
      time: 1183,
      since: 3,
    });
    expect(isLate(sparse)).toBe(false);
    expect(isLate({ ...sparse, since: 700 })).toBe(true);
    expect(
      isLate(cause("insert", [0, 0, 10, 10], undefined, { time: 620 })),
    ).toBe(true);
  });
});

describe("shiftFix", () => {
  test("media gets its intrinsic size", () => {
    expect(
      shiftFix(
        { ...cause("insert", [0, 0, 640, 360]), selector: "figure > img" },
        true,
        [],
      ),
    ).toContain("aspect-ratio: 640 / 360");
  });
  test("late content reserves its measured height or renders a skeleton", () => {
    const fix = shiftFix(cause("insert", [0, 0, 720, 120]), true, ["p"]);
    expect(fix).toContain("min-height: 120px");
    expect(fix).toContain("skeleton at 720×120px");
  });
  test("an immediate insert overlays instead of pushing", () => {
    expect(
      shiftFix(cause("insert", [0, 0, 1440, 48]), false, ["main"]),
    ).toContain("Overlay instead of pushing");
  });
  test("a removal keeps its space while it leaves", () => {
    expect(shiftFix(cause("remove", [0, 0, 1440, 40]), false, [])).toContain(
      "Keep div.remove's 40px",
    );
  });
  test("a sideways resize gets a stable width; a shrink keeps its height", () => {
    const wider = cause("resize", [0, 0, 120, 40], [0, 0, 180, 40], {
      delta: { dw: 60, dh: 0 },
    });
    expect(shiftFix(wider, false, ["div.next"])).toContain(
      "stable width (min-width: 180px) so new content does not resize it by 60px",
    );
    expect(
      shiftFix({ ...wider, selector: "table > thead > tr > th" }, false, [
        "th.next",
      ]),
    ).toContain(
      "stable width (fixed column widths with table-layout: fixed, so it keeps its 120px)",
    );
    const shorter = cause("resize", [0, 0, 600, 400], [0, 0, 600, 294], {
      delta: { dw: 0, dh: -106 },
    });
    expect(shiftFix(shorter, false, ["nav.pages"])).toContain(
      "min-height: 400px), so nav.pages does not jump up by 106px",
    );
  });
  test("a resize uses the measured height change", () => {
    const resize = cause("resize", [0, 0, 600, 100], [0, 0, 600, 172], {
      delta: { dw: 0, dh: 72 },
    });
    expect(shiftFix(resize, false, ["section.next"])).toContain("72px");
    expect(shiftFix(resize, true, ["section.next"])).toContain(
      "min-height: 72px",
    );
  });
});

const artifact = (
  actions: ActionTimeline[],
  extra: Partial<ActionTimelineArtifact> = {},
): ActionTimelineArtifact => ({
  version: 1,
  status: "ran",
  limits: {
    frames: 60,
    elements: 250,
    changesPerFrame: 80,
    shifts: 50,
    mutations: 60,
    animations: 40,
    requests: 60,
    actions: 120,
  },
  truncated: { actions: 0 },
  actions,
  ...extra,
});

function tuple(extra: Partial<CheckTuple> = {}): CheckTuple {
  return {
    flow: "f",
    state: "s",
    viewport: "desktop",
    width: 1440,
    height: 900,
    metadataPath: "m.json",
    artifactPaths: [],
    commit: "c",
    createdAt: "2026-10-27T00:00:00.000Z",
    axe: { violations: [] },
    console: [],
    mismatches: [],
    ...extra,
  };
}

const run = (subject: CheckTuple, checks: unknown = {}) =>
  interactionShiftCheck.run({
    tuple: subject,
    narrowViewport: false,
    config: checksConfigFrom(checksConfigSchema.parse(checks)),
  });

describe("interaction-shift check", () => {
  test("a banner is one major finding naming the cause, distance, time and moved content", () => {
    const result = run(tuple({ timelines: artifact([banner()]) }));
    expect(result.coverage).toEqual({
      check: "interaction-shift",
      status: "ran",
    });
    const [finding, ...rest] = result.candidates;
    expect(rest).toEqual([]);
    expect(finding).toMatchObject({
      severity: "major",
      rule: "idiom:interaction-shift",
      selectorHint: "div.banner",
      fingerprintHint: "interaction-shift:div.banner",
      timeline: "probe-1",
    });
    expect(finding?.explanation).toBe(
      'After clicking "Show notice" (button#show), content moved 48px down 30ms after input because div.banner was inserted: div.summary (48px), footer (48px), main > h2 (48px).',
    );
    expect(finding?.fix).toContain("Overlay instead of pushing");
  });

  test("more than five moved elements are summarised", () => {
    const timeline = banner();
    for (let index = 0; index < 4; index += 1) {
      timeline.frames[0]?.elements.push({
        selector: `p.extra-${index}`,
        rect: rect([0, 400 + index * 40, 100, 40]),
        offset: { x: 0, y: 0 },
      });
      timeline.frames[1]?.elements.push({
        selector: `p.extra-${index}`,
        rect: rect([0, 448 + index * 40, 100, 40]),
        offset: { x: 0, y: 0 },
      });
    }
    expect(
      run(tuple({ timelines: artifact([timeline]) })).candidates[0]
        ?.explanation,
    ).toContain(", and 2 more.");
  });

  test("late content gets the late wording and acceptance", () => {
    const [finding] = run(
      tuple({ timelines: artifact([banner(700)]) }),
    ).candidates;
    expect(finding?.explanation).toContain(
      "700ms after input because div.banner was inserted (late: async content arrived after the reader had started)",
    );
    expect(finding?.acceptance[0]).toContain(
      "content that arrives later reserves its space",
    );
  });

  test("load actions belong to layout-shift", () => {
    const load = { ...banner(), id: "load", source: "load" as const };
    expect(run(tuple({ timelines: artifact([load]) })).candidates).toEqual([]);
  });

  test("motion confirmation replays do not duplicate interaction shifts", () => {
    const original = banner(30, { reducedMotion: true });
    const confirmation = banner(30, {
      id: "probe-2",
      confirmation: true,
      reducedMotion: false,
    });
    const result = run(
      tuple({ timelines: artifact([original, confirmation]) }),
    );
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]?.timeline).toBe(original.id);
    expect(
      run(tuple({ timelines: artifact([confirmation]) })).candidates,
    ).toEqual([]);
  });

  test("held replays do not turn artificial response delays into interaction shifts", () => {
    const replay = banner(1500, {
      id: "slow-probe-1",
      source: "slow-replay",
    });
    expect(run(tuple({ timelines: artifact([replay]) })).candidates).toEqual(
      [],
    );
    const step = banner(1500, { id: "step-1", source: "web-step" });
    expect(run(tuple({ timelines: artifact([step]) })).candidates).toHaveLength(
      1,
    );
  });

  test("captures without timelines need a recapture", () => {
    expect(run(tuple()).coverage).toEqual({
      check: "interaction-shift",
      status: "unavailable",
      reason: "unavailable: recapture (no action timelines in this capture)",
    });
  });

  test("an unavailable timeline artifact is unavailable", () => {
    expect(
      run(
        tuple({
          timelines: artifact([], {
            status: "unavailable",
            reason: "no recorded actions",
          }),
        }),
      ).coverage,
    ).toMatchObject({ status: "unavailable", reason: "no recorded actions" });
  });

  test("a truncated action still reports, with incomplete coverage", () => {
    const timeline = {
      ...banner(),
      status: "partial" as const,
      reason: "timeline truncated: frames",
      truncated: ["frames" as const],
    };
    const result = run(tuple({ timelines: artifact([timeline]) }));
    expect(result.candidates).toHaveLength(1);
    expect(result.coverage).toMatchObject({
      status: "unavailable",
      reason: "timeline truncated: frames",
    });
  });

  test("disabled is skipped", () => {
    expect(
      run(tuple({ timelines: artifact([banner()]) }), {
        interactionShift: { enabled: false },
      }).coverage,
    ).toEqual({
      check: "interaction-shift",
      status: "skipped",
      reason: "checks.interactionShift is not enabled",
    });
  });
});

describe("layout-shift names the late content", () => {
  const observations = {
    version: 2,
    viewport,
    document: {
      scrollWidth: 1440,
      scrollHeight: 900,
      clientWidth: 1440,
      clientHeight: 900,
    },
    elements: [],
    maskMembership: [],
    headings: [],
    tokens: { status: "not-configured" },
    layoutShift: {
      status: "ran",
      score: 0.14,
      entries: [
        { value: 0.02, startTime: 200, sources: ["header"] },
        { value: 0.12, startTime: 1240, sources: ["body > main"] },
      ],
    },
  } as unknown as CheckTuple["observations"];
  const load = action(
    [
      [0, { "body > main": [0, 0, 1440, 600] }],
      [
        1245,
        { "div.promo": [0, 0, 1440, 360], "body > main": [0, 360, 1440, 600] },
      ],
    ],
    {
      id: "load",
      source: "load",
      kind: "navigation",
      name: "/",
      effectRegion: { controls: [] },
      mutations: [insert("div.promo", 1230, [0, 0, 1440, 360])],
      shifts: [
        {
          time: 1240,
          value: 0.12,
          hadRecentInput: false,
          sources: [
            {
              selector: "body > main",
              previousRect: rect([0, 0, 1440, 600]),
              currentRect: rect([0, 360, 1440, 600]),
            },
          ],
        },
      ],
    },
  );
  const runLayout = (subject: CheckTuple) =>
    layoutShiftCheck.run({
      tuple: subject,
      narrowViewport: false,
      config: checksConfigFrom(checksConfigSchema.parse({})),
    });

  test("the largest shift's cause is named with a fix and the load timeline", () => {
    const [finding] = runLayout(
      tuple({ observations, timelines: artifact([load]) }),
    ).candidates;
    expect(finding?.severity).toBe("major");
    expect(finding?.explanation).toBe(
      "Content moves after load: cumulative layout shift is 0.14 (above 0.1), shifting header, body > main. The largest shift (0.12 at 1240ms) came from late content: div.promo was inserted (360px).",
    );
    expect(finding?.timeline).toBe("load");
    expect(finding?.fix).toContain("min-height: 360px");
  });

  test("without a load timeline the text is unchanged", () => {
    const [finding] = runLayout(tuple({ observations })).candidates;
    expect(finding?.severity).toBe("major");
    expect(finding?.explanation).toBe(
      "Content moves after load: cumulative layout shift is 0.14 (above 0.1), shifting header, body > main.",
    );
    expect(finding?.fix).toBeUndefined();
    expect(finding?.timeline).toBeUndefined();
  });

  test("a source leaving the viewport does not falsely name nearby content as its cause", () => {
    const leaving = structuredClone(load);
    leaving.mutations = [insert("#toc", 1230, [20, 20, 260, 625])];
    const source = leaving.shifts[0]?.sources[0];
    if (!source) throw new Error("load fixture has no shift source");
    source.previousRect = rect([100, 100, 1440, 600]);
    source.currentRect = rect([0, 0, 0, 0]);
    const [finding] = runLayout(
      tuple({ observations, timelines: artifact([leaving]) }),
    ).candidates;
    expect(finding?.severity).toBe("major");
    expect(finding?.explanation).toBe(
      "Content moves after load: cumulative layout shift is 0.14 (above 0.1), shifting header, body > main.",
    );
    expect(finding?.fix).toBeUndefined();
    expect(finding?.timeline).toBeUndefined();
  });
});

import type {
  CritiqueEvidenceKind,
  CritiqueEvidenceLimits,
  CritiqueInput,
  CropRef,
  DesignImageRef,
  DomExcerpt,
  ReferenceRef,
  ScreenshotRef,
} from "./types.js";

/**
 * Per-session evidence budget for the Claude Code provider. Every image in a
 * session's readable path manifest counts against the image limits (captured
 * screenshots, zoomed crops, intended design images and image references);
 * the count matches the Anthropic API adapter's per-request batch. Bytes are
 * on-disk file sizes, a deterministic proxy: no model context size is
 * guaranteed. DOM characters are the summed excerpt content in one session.
 */
export const CLAUDE_CODE_MAX_SESSION_IMAGES = 20;
export const CLAUDE_CODE_MAX_SESSION_IMAGE_BYTES = 20 * 1024 * 1024;
export const CLAUDE_CODE_MAX_SESSION_DOM_CHARS = 60_000;

export type ClaudeCodeSessionLimits = {
  images: number;
  imageBytes: number;
  domChars: number;
};

export const claudeCodeSessionLimits: ClaudeCodeSessionLimits = {
  images: CLAUDE_CODE_MAX_SESSION_IMAGES,
  imageBytes: CLAUDE_CODE_MAX_SESSION_IMAGE_BYTES,
  domChars: CLAUDE_CODE_MAX_SESSION_DOM_CHARS,
};

export type ImageReference = Extract<ReferenceRef, { kind: "image" }>;

export type ClaudeCodeSession = {
  screenshots: ScreenshotRef[];
  crops: CropRef[];
  designImages: DesignImageRef[];
  references: ImageReference[];
  domExcerpts: DomExcerpt[];
};

export type OmittedEvidence = CritiqueEvidenceLimits["omitted"][number];

type Unit = {
  screenshots: ScreenshotRef[];
  crops: CropRef[];
  designImages: DesignImageRef[];
  domExcerpts: DomExcerpt[];
};

type Capacity = { images: number; bytes: number; domChars: number };

const MIB = 1024 * 1024;

export function formatMegabytes(bytes: number): string {
  return `${Number((bytes / MIB).toFixed(1))} MB`;
}

function imageReferences(input: CritiqueInput): ImageReference[] {
  return input.references.filter(
    (reference): reference is ImageReference => reference.kind === "image",
  );
}

function sizeOf(sizes: Map<string, number>, readPath: string): number {
  return sizes.get(readPath) ?? 0;
}

function domChars(excerpts: DomExcerpt[]): number {
  return excerpts.reduce((total, excerpt) => total + excerpt.content.length, 0);
}

function unitCost(unit: Unit, sizes: Map<string, number>): Capacity {
  const images = [...unit.screenshots, ...unit.crops, ...unit.designImages];
  return {
    images: images.length,
    bytes: images.reduce(
      (total, item) => total + sizeOf(sizes, item.readPath),
      0,
    ),
    domChars: domChars(unit.domExcerpts),
  };
}

function within(cost: Capacity, capacity: Capacity): boolean {
  return (
    cost.images <= capacity.images &&
    cost.bytes <= capacity.bytes &&
    cost.domChars <= capacity.domChars
  );
}

/** True when the whole input fits one session; the adapter's prompt is then unchanged. */
export function fitsOneSession(
  input: CritiqueInput,
  sizes: Map<string, number>,
  limits: ClaudeCodeSessionLimits = claudeCodeSessionLimits,
): boolean {
  const images = [
    ...input.screenshots,
    ...imageReferences(input),
    ...(input.crops ?? []),
    ...(input.designImages ?? []),
  ];
  return within(
    {
      images: images.length,
      bytes: images.reduce(
        (total, item) => total + sizeOf(sizes, item.readPath),
        0,
      ),
      domChars: domChars(input.domExcerpts),
    },
    {
      images: limits.images,
      bytes: limits.imageBytes,
      domChars: limits.domChars,
    },
  );
}

function unitFor(
  screenshots: ScreenshotRef[],
  input: CritiqueInput,
  domByLabel: Map<string, DomExcerpt[]>,
): Unit {
  const labels = new Set(screenshots.map((item) => item.label));
  return {
    screenshots,
    crops: (input.crops ?? []).filter((crop) => labels.has(crop.screenshot)),
    designImages: (input.designImages ?? []).filter((design) =>
      labels.has(design.designFor),
    ),
    domExcerpts: screenshots.flatMap(
      (item) => domByLabel.get(item.label) ?? [],
    ),
  };
}

/**
 * Split a critique input into Claude Code sessions that each fit the limits.
 * Units are one state's screenshots with their crops, design images and DOM
 * excerpts, packed greedily in input order; image references ride in every
 * session. A unit too big for an empty session is split per screenshot, then
 * loses crops, then its design image, then a DOM excerpt over the DOM limit;
 * a screenshot whose own file is over the byte budget is omitted. Every drop
 * is returned in `omitted`. Pure and deterministic: no I/O.
 */
export function planClaudeCodeSessions(
  input: CritiqueInput,
  sizes: Map<string, number>,
  limits: ClaudeCodeSessionLimits = claudeCodeSessionLimits,
): { sessions: ClaudeCodeSession[]; omitted: OmittedEvidence[] } {
  const omitted: OmittedEvidence[] = [];
  const omit = (label: string, kind: CritiqueEvidenceKind, reason: string) =>
    omitted.push({ label, kind, reason });
  const byteBudget = `session image budget is ${formatMegabytes(limits.imageBytes)}`;

  // Reserve image references in every session, dropping from the end until
  // the smallest screenshot that can fit at all has room beside them.
  const references = imageReferences(input);
  const fittable = input.screenshots
    .map((item) => sizeOf(sizes, item.readPath))
    .filter((bytes) => bytes <= limits.imageBytes);
  if (fittable.length > 0 && limits.images > 0) {
    const smallest = Math.min(...fittable);
    const referenceBytes = () =>
      references.reduce(
        (total, item) => total + sizeOf(sizes, item.readPath),
        0,
      );
    while (
      references.length > 0 &&
      (references.length + 1 > limits.images ||
        referenceBytes() + smallest > limits.imageBytes)
    ) {
      const dropped = references.pop() as ImageReference;
      omit(
        dropped.label,
        dropped.polarity,
        `no room for a captured screenshot beside the references (per session: ${limits.images} images, ${formatMegabytes(limits.imageBytes)})`,
      );
    }
  }
  const capacity: Capacity = {
    images: limits.images - references.length,
    bytes:
      limits.imageBytes -
      references.reduce(
        (total, item) => total + sizeOf(sizes, item.readPath),
        0,
      ),
    domChars: limits.domChars,
  };

  const screenshotLabels = new Set(input.screenshots.map((item) => item.label));
  const domByLabel = new Map<string, DomExcerpt[]>();
  const orphans: DomExcerpt[] = [];
  for (const excerpt of input.domExcerpts) {
    if (!screenshotLabels.has(excerpt.label)) {
      orphans.push(excerpt);
      continue;
    }
    domByLabel.set(excerpt.label, [
      ...(domByLabel.get(excerpt.label) ?? []),
      excerpt,
    ]);
  }

  const states: string[] = [];
  const byState = new Map<string, ScreenshotRef[]>();
  for (const screenshot of input.screenshots) {
    if (!byState.has(screenshot.state)) {
      states.push(screenshot.state);
      byState.set(screenshot.state, []);
    }
    byState.get(screenshot.state)?.push(screenshot);
  }

  const units: Unit[] = [];
  for (const state of states) {
    const unit = unitFor(byState.get(state) ?? [], input, domByLabel);
    if (within(unitCost(unit, sizes), capacity)) {
      units.push(unit);
      continue;
    }
    for (const screenshot of unit.screenshots) {
      const single = unitFor([screenshot], input, domByLabel);
      const bytes = sizeOf(sizes, screenshot.readPath);
      if (capacity.images < 1 || bytes > capacity.bytes) {
        omit(
          screenshot.label,
          "captured-screenshot",
          bytes > limits.imageBytes
            ? `file is ${formatMegabytes(bytes)}; ${byteBudget}`
            : `file is ${formatMegabytes(bytes)}; ${formatMegabytes(Math.max(capacity.bytes, 0))} of the ${formatMegabytes(limits.imageBytes)} session image budget is left beside the references`,
        );
        for (const crop of single.crops)
          omit(
            crop.label,
            "zoomed-crop",
            `its screenshot ${screenshot.label} was omitted`,
          );
        for (const design of single.designImages)
          omit(
            design.label,
            "intended-design-image",
            `its screenshot ${screenshot.label} was omitted`,
          );
        // Its DOM excerpt still describes the state; place it like an orphan.
        orphans.push(...single.domExcerpts);
        continue;
      }
      const imagesFit = () => {
        const cost = unitCost(single, sizes);
        return cost.images <= capacity.images && cost.bytes <= capacity.bytes;
      };
      while (single.crops.length > 0 && !imagesFit()) {
        const crop = single.crops.pop() as CropRef;
        omit(
          crop.label,
          "zoomed-crop",
          `${screenshot.label} with its crops exceeds one session's image budget`,
        );
      }
      while (single.designImages.length > 0 && !imagesFit()) {
        const design = single.designImages.pop() as DesignImageRef;
        omit(
          design.label,
          "intended-design-image",
          `${screenshot.label} with its intended design exceeds one session's image budget`,
        );
      }
      let keptDomChars = 0;
      single.domExcerpts = single.domExcerpts.filter((excerpt) => {
        if (keptDomChars + excerpt.content.length <= capacity.domChars) {
          keptDomChars += excerpt.content.length;
          return true;
        }
        omit(
          excerpt.label,
          "dom-excerpt",
          `excerpt is ${excerpt.content.length.toLocaleString("en-US")} characters; session DOM budget is ${limits.domChars.toLocaleString("en-US")}`,
        );
        return false;
      });
      units.push(single);
    }
  }

  const sessions: ClaudeCodeSession[] = [];
  let current: ClaudeCodeSession | undefined;
  let used: Capacity = { images: 0, bytes: 0, domChars: 0 };
  for (const unit of units) {
    const cost = unitCost(unit, sizes);
    const fits = within(
      {
        images: used.images + cost.images,
        bytes: used.bytes + cost.bytes,
        domChars: used.domChars + cost.domChars,
      },
      capacity,
    );
    if (current === undefined || !fits) {
      current = {
        screenshots: [],
        crops: [],
        designImages: [],
        references: [...references],
        domExcerpts: [],
      };
      sessions.push(current);
      used = { images: 0, bytes: 0, domChars: 0 };
    }
    current.screenshots.push(...unit.screenshots);
    current.crops.push(...unit.crops);
    current.designImages.push(...unit.designImages);
    current.domExcerpts.push(...unit.domExcerpts);
    used = {
      images: used.images + cost.images,
      bytes: used.bytes + cost.bytes,
      domChars: used.domChars + cost.domChars,
    };
  }

  for (const excerpt of orphans) {
    const sameState = sessions.find((session) =>
      session.screenshots.some((item) => item.state === excerpt.state),
    );
    const candidates = [sameState, sessions[0]].filter(
      (session): session is ClaudeCodeSession => session !== undefined,
    );
    const target = candidates.find(
      (session) =>
        domChars(session.domExcerpts) + excerpt.content.length <=
        limits.domChars,
    );
    if (target === undefined) {
      omit(
        excerpt.label,
        "dom-excerpt",
        sessions.length === 0
          ? "no session has a captured screenshot to review"
          : `no session had room in its ${limits.domChars.toLocaleString("en-US")}-character DOM budget`,
      );
      continue;
    }
    target.domExcerpts.push(excerpt);
  }
  const domOrder = new Map(
    input.domExcerpts.map((excerpt, index) => [excerpt, index]),
  );
  for (const session of sessions)
    session.domExcerpts.sort(
      (a, b) => (domOrder.get(a) ?? 0) - (domOrder.get(b) ?? 0),
    );

  return { sessions, omitted };
}

const MAX_DESCRIBED_OMISSIONS = 10;

/** The one report sentence for a limited Claude Code critique. */
export function describeEvidenceLimits(limits: CritiqueEvidenceLimits): string {
  const budget = `per session: ${limits.limits.images} images, ${formatMegabytes(limits.limits.imageBytes)} of images, ${limits.limits.domChars.toLocaleString("en-US")} DOM characters`;
  const parts = [
    limits.sessions === 1
      ? "ran in 1 session"
      : `split across ${limits.sessions} sessions`,
  ];
  if (limits.omitted.length > 0) {
    const listed = limits.omitted
      .slice(0, MAX_DESCRIBED_OMISSIONS)
      .map((item) => `${item.label} (${item.kind}: ${item.reason})`);
    const rest = limits.omitted.length - listed.length;
    parts.push(
      `omitted ${listed.join(", ")}${rest > 0 ? `, and ${rest} more` : ""}`,
    );
  }
  return `Claude Code critique evidence was limited (${budget}): ${parts.join("; ")}.`;
}

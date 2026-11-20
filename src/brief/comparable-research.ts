import { lstat } from "node:fs/promises";
import { join } from "node:path";
import {
  captureReferenceUrl,
  ReferenceNavigationError,
} from "../capture/browser.js";
import { IdiomError } from "../errors.js";
import { referenceRoot } from "../references/catalog.js";
import { addReference } from "../references/run.js";
import { briefSettings, type Project } from "../schemas/project.js";
import { referenceNameSchema } from "../schemas/reference.js";
import {
  type ComparablePage,
  formatNumber,
  type Measurement,
  type ProposedCriterion,
  proposeCriteria,
  readProductComparables,
  requestTerms,
  selectComparables,
} from "./comparables.js";
import {
  detectSignIn,
  measureComparablePage,
  SignInWallError,
} from "./measure.js";

export type ComparableCapture = (options: {
  url: string;
  project: Project;
  viewport: Project["viewports"][number];
  terms: string[];
}) => Promise<{
  image: Buffer;
  measurements: Measurement[];
  unmatched: string[];
}>;

export type ComparableResearchDependencies = {
  now?: (() => Date) | undefined;
  captureComparable?: ComparableCapture | undefined;
};

export type ResearchedComparable = {
  name: string;
  tier: string;
  reason: string;
  page?: ComparablePage | undefined;
  status: "captured" | "not-reachable" | "no-public-page";
  reference?:
    | {
        label: string;
        name: string;
        source: string;
        capturedAt: string;
        viewport: { name: string; width: number; height: number };
      }
    | undefined;
  measurements: Measurement[];
  unmatched: string[];
  notReachable?: string | undefined;
};

export type ComparableResearch = {
  request: string;
  terms: string[];
  /** Where the list came from: project.json or PRODUCT.md. */
  listSource: "project" | "product";
  warnings: string[];
  comparables: ResearchedComparable[];
  criteria: ProposedCriterion[];
};

/** Public pages only: a fresh context, no stored sign-in, nothing submitted. */
export const defaultCaptureComparable: ComparableCapture = async (options) => {
  let measured:
    | { measurements: Measurement[]; unmatched: string[] }
    | undefined;
  const image = await captureReferenceUrl({
    url: options.url,
    project: options.project,
    viewport: options.viewport,
    inspect: async (page) => {
      await detectSignIn(page, options.url);
      measured = await measureComparablePage(page, options.terms, {
        url: page.url(),
        viewport: options.viewport.name,
      });
    },
  });
  return {
    image,
    measurements: measured?.measurements ?? [],
    unmatched: measured?.unmatched ?? options.terms,
  };
};

function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/** `<comparable>-<surface or first three words>`, suffixed until it is free. */
async function referenceName(
  projectDirectory: string,
  comparable: string,
  page: ComparablePage,
  terms: string[],
): Promise<string> {
  const topic = slug(page.surface ?? terms.slice(0, 3).join(" "));
  const base =
    [slug(comparable) || "comparable", topic]
      .filter((part) => part !== "")
      .join("-")
      .slice(0, 60)
      .replace(/-+$/, "") || "comparable";
  if (!referenceNameSchema.safeParse(base).success)
    throw new Error(`unreachable: invalid reference name ${base}`);
  const root = referenceRoot(projectDirectory, "reference");
  let name = base;
  for (let suffix = 2; await exists(join(root, name)); suffix++)
    name = `${base}-${suffix}`;
  return name;
}

function signInStatus(error: unknown): boolean {
  if (error instanceof SignInWallError) return true;
  return (
    error instanceof ReferenceNavigationError &&
    error.status !== undefined &&
    [401, 403, 407].includes(error.status)
  );
}

function measurementPhrase(measurement: Measurement): string {
  return `${measurement.subject} ${measurement.property} ${formatNumber(measurement.value)}${measurement.unit} (${measurement.selector})`;
}

/**
 * Picks two or three comparables for a request, captures each one's
 * equivalent public screen as a managed reference (measured in the same page
 * load), and proposes criteria with a floor and a cap citing each reference.
 */
export async function runComparableResearch(options: {
  projectDirectory: string;
  project: Project;
  cwd: string;
  request: string;
  viewport?: string | undefined;
  dependencies?: ComparableResearchDependencies | undefined;
}): Promise<ComparableResearch> {
  const request = options.request.trim();
  if (request === "") throw new IdiomError("pass the request text to research");
  const viewport =
    options.viewport === undefined
      ? options.project.viewports[0]
      : options.project.viewports.find(
          (candidate) => candidate.name === options.viewport,
        );
  if (viewport === undefined)
    throw new IdiomError(
      `unknown project viewport ${JSON.stringify(options.viewport)}`,
    );
  const configured = briefSettings(options.project).references;
  const warnings: string[] = [];
  let references = configured;
  let listSource: ComparableResearch["listSource"] = "project";
  if (configured.length === 0) {
    const parsed = await readProductComparables(
      options.projectDirectory,
      options.project.design.productFile,
    );
    warnings.push(
      ...parsed.warnings.map(
        (warning) => `${options.project.design.productFile}: ${warning}`,
      ),
    );
    references = parsed.references;
    listSource = "product";
  }
  const selected = selectComparables(references, request);
  warnings.push(...selected.warnings);
  const terms = requestTerms(request);
  const now = options.dependencies?.now ?? (() => new Date());
  const capture =
    options.dependencies?.captureComparable ?? defaultCaptureComparable;

  const comparables: ResearchedComparable[] = [];
  for (const selection of selected.selections) {
    const base = {
      name: selection.name,
      tier: selection.tier,
      reason: selection.reason,
      ...(selection.page === undefined ? {} : { page: selection.page }),
    };
    if (selection.page === undefined) {
      comparables.push({
        ...base,
        status: "no-public-page",
        measurements: [],
        unmatched: [],
      });
      continue;
    }
    const url = selection.page.url;
    let captured: Awaited<ReturnType<ComparableCapture>>;
    try {
      captured = await capture({
        url,
        project: options.project,
        viewport,
        terms,
      });
    } catch (error) {
      comparables.push({
        ...base,
        status: "not-reachable",
        measurements: [],
        unmatched: [],
        notReachable: signInStatus(error)
          ? "sign-in required; not logged into"
          : error instanceof Error
            ? error.message
            : String(error),
      });
      continue;
    }
    const capturedAt = now();
    const measured =
      captured.measurements.length === 0
        ? "no request words matched an element"
        : captured.measurements.map(measurementPhrase).join("; ");
    const note = `Comparable for "${request}" — ${selection.reason}. Measured at ${url} (${viewport.name} ${viewport.width}×${viewport.height}, ${capturedAt.toISOString().slice(0, 10)}): ${measured}.`;
    const name = await referenceName(
      options.projectDirectory,
      selection.name,
      selection.page,
      terms,
    );
    const stored = await addReference({
      projectDirectory: options.projectDirectory,
      project: options.project,
      cwd: options.cwd,
      name,
      note,
      polarity: "reference",
      url,
      viewport: viewport.name,
      dependencies: {
        now: () => capturedAt,
        captureUrl: async () => captured.image,
      },
    });
    const metadata = stored.metadata;
    comparables.push({
      ...base,
      status: "captured",
      reference: {
        label: stored.label,
        name: metadata.name,
        source: metadata.source,
        capturedAt:
          metadata.sourceKind === "url"
            ? metadata.capturedAt
            : capturedAt.toISOString(),
        viewport: {
          name: viewport.name,
          width: viewport.width,
          height: viewport.height,
        },
      },
      measurements: captured.measurements,
      unmatched: captured.unmatched,
    });
  }

  const criteria = proposeCriteria(
    comparables.flatMap((comparable) =>
      comparable.reference === undefined
        ? []
        : [
            {
              comparable: comparable.name,
              reference: comparable.reference.label,
              measurements: comparable.measurements,
            },
          ],
    ),
  );
  if (!comparables.some((comparable) => comparable.status === "captured"))
    warnings.push(
      "no comparable could be captured; list a public page for each (a url, or pages with a surface and url)",
    );
  return {
    request,
    terms,
    listSource,
    warnings,
    comparables,
    criteria,
  };
}

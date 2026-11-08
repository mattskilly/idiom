import { createHash, randomUUID } from "node:crypto";
import {
  access,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { IdiomError } from "../errors.js";
import {
  type BriefInput,
  type BriefOption,
  type BriefTriageResult,
  briefInputSchema,
  briefSlugSchema,
  briefTriageIdSchema,
  formatBriefIssues,
  isCompleteBrief,
  type ResearchRun,
  type StoredBrief,
  type StoredTriage,
  storedBriefSchema,
  storedTriageSchema,
} from "../schemas/brief.js";
import type { BriefSettings } from "../schemas/project.js";
import type { FlowRecord } from "../validation.js";
import {
  type BriefCheck,
  briefCheckFrom,
  hasBriefAssertions,
  validateBriefAssertions,
} from "./assertions.js";
import { readDesignAssets } from "./design-asset.js";
import { renderBrief } from "./render.js";

export function briefsDirectory(projectDirectory: string): string {
  return join(projectDirectory, ".idiom", "briefs");
}

export function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/, "");
}

async function writeAtomic(path: string, contents: string): Promise<void> {
  const staging = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(staging, contents, "utf8");
    await rename(staging, path);
  } catch (error) {
    await rm(staging, { force: true });
    throw error;
  }
}

async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}

function parseStored(text: string, slug: string): StoredBrief {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw new IdiomError(
      `brief ${slug} is not valid JSON: ${(error as Error).message}`,
    );
  }
  const parsed = storedBriefSchema.safeParse(json);
  if (!parsed.success)
    throw new IdiomError(
      `brief ${slug} is invalid: ${formatBriefIssues(parsed.error).join("; ")}`,
    );
  return parsed.data;
}

export type RecordedBrief = {
  slug: string;
  outcome: "created" | "updated";
  jsonPath: string;
  markdownPath: string;
  brief: StoredBrief;
};

/**
 * Reads any prior record for `createdAt`, validates the stored shape and
 * writes JSON and Markdown atomically. Shared by `record` and `--research`.
 */
async function writeStoredBrief(options: {
  projectDirectory: string;
  slug: string;
  fields: Record<string, unknown>;
  now: Date;
  rubricVersion: number;
  settings: BriefSettings;
  /** Fields carried over from the prior record of the same slug. */
  carry?: ((prior: StoredBrief) => Record<string, unknown>) | undefined;
}): Promise<RecordedBrief> {
  const { slug } = options;
  const directory = briefsDirectory(options.projectDirectory);
  const jsonPath = join(directory, `${slug}.json`);
  const markdownPath = join(directory, `${slug}.md`);
  let createdAt = options.now.toISOString();
  let outcome: RecordedBrief["outcome"] = "created";
  let carried: Record<string, unknown> = {};
  try {
    const prior = parseStored(await readFile(jsonPath, "utf8"), slug);
    createdAt = prior.createdAt;
    outcome = "updated";
    carried = options.carry?.(prior) ?? {};
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const brief = storedBriefSchema.parse({
    version: 1,
    ...carried,
    ...options.fields,
    slug,
    rubricVersion: options.rubricVersion,
    createdAt,
    updatedAt: options.now.toISOString(),
  });
  await writeBrief(directory, brief, options.settings);
  return { slug, outcome, jsonPath, markdownPath, brief };
}

/**
 * Validates the agent's research and options and stores the brief. Recording
 * the same slug again updates it — that is how a proposed brief is decided.
 */
export async function recordBrief(options: {
  projectDirectory: string;
  input: unknown;
  now: Date;
  rubricVersion: number;
  settings: BriefSettings;
  /** Loaded only when a criterion carries assertions, to validate them. */
  flows?: (() => Promise<readonly FlowRecord[]>) | undefined;
}): Promise<RecordedBrief> {
  const parsed = briefInputSchema.safeParse(options.input);
  if (!parsed.success)
    throw new IdiomError(
      [
        "brief rejected:",
        ...formatBriefIssues(parsed.error).map((issue) => `  ${issue}`),
      ].join("\n"),
    );
  const input = parsed.data;
  await checkAssertions(input, options.flows);
  const slug = input.slug ?? slugify(input.title);
  if (slug === "")
    throw new IdiomError(
      "brief rejected: the title makes no slug; add an explicit slug",
    );
  if (input.supersededBy === slug)
    throw new IdiomError(
      "brief rejected: supersededBy: a brief cannot supersede itself",
    );
  const directory = briefsDirectory(options.projectDirectory);
  if (
    input.supersededBy !== undefined &&
    !(await exists(join(directory, `${input.supersededBy}.json`)))
  )
    throw new IdiomError(
      `brief rejected: supersededBy: no brief named ${input.supersededBy}; record it first`,
    );
  return writeStoredBrief({
    ...options,
    slug,
    fields: input,
    // Deciding a researched brief keeps what the research cost; an
    // incomplete run no longer describes a complete brief recorded over it.
    carry: (prior) => ({
      ...(prior.researchRun !== undefined &&
      prior.researchRun.incomplete === undefined
        ? { researchRun: prior.researchRun }
        : {}),
      ...(prior.tickets === undefined ? {} : { tickets: prior.tickets }),
    }),
  });
}

/** The request's own first line, when research never produced a title. */
export function requestTitle(request: string): string {
  const first =
    request
      .split(/\r?\n/)
      .map((text) => text.trim())
      .find((text) => text !== "") ?? "";
  return first.slice(0, 120).trim();
}

/**
 * Stores what an `idiom brief "<request>" --research` run validated: a
 * complete brief input, or an incomplete candidate, plus the run's cost.
 */
export async function storeResearchedBrief(options: {
  projectDirectory: string;
  brief: BriefInput | IncompleteResearchedBrief;
  researchRun: ResearchRun;
  now: Date;
  rubricVersion: number;
  settings: BriefSettings;
}): Promise<RecordedBrief> {
  const slug = options.brief.slug ?? (slugify(options.brief.title) || "brief");
  return writeStoredBrief({
    ...options,
    slug,
    fields: { ...options.brief, researchRun: options.researchRun },
  });
}

type OptionStageField =
  | "decision"
  | "requestNamedIdea"
  | "options"
  | "recommendation"
  | "acceptanceCriteria";

/** A research run that stopped early: options-stage fields may be absent. */
export type IncompleteResearchedBrief = Omit<BriefInput, OptionStageField> &
  Partial<Pick<BriefInput, OptionStageField>>;

/** Rejects assertions naming a flow or state the project does not declare. */
async function checkAssertions(
  brief: Pick<StoredBrief, "acceptanceCriteria">,
  flows: (() => Promise<readonly FlowRecord[]>) | undefined,
): Promise<void> {
  if (flows === undefined || !hasBriefAssertions(brief)) return;
  const issues = validateBriefAssertions(brief, await flows());
  if (issues.length > 0)
    throw new IdiomError(
      ["brief rejected:", ...issues.map((issue) => `  ${issue}`)].join("\n"),
    );
}

async function writeBrief(
  directory: string,
  brief: StoredBrief,
  settings: BriefSettings,
): Promise<void> {
  await mkdir(directory, { recursive: true });
  await writeAtomic(
    join(directory, `${brief.slug}.json`),
    `${JSON.stringify(brief, null, 2)}\n`,
  );
  await writeAtomic(
    join(directory, `${brief.slug}.md`),
    renderBrief(brief, settings),
  );
}

export type DecidedBrief = {
  slug: string;
  outcome: "decided" | "re-decided";
  brief: StoredBrief;
  markdownPath: string;
  chosen: BriefOption;
  recommended: BriefOption;
  /** Set when the human chose something other than the recommendation. */
  criteriaWarning?: string | undefined;
};

/** Records the human's choice and re-renders the ticket-ready Markdown. */
export async function decideBrief(options: {
  projectDirectory: string;
  slug: string;
  option: string;
  by?: string | undefined;
  now: Date;
  settings: BriefSettings;
  /** Flows may have changed since record, so assertions are checked again. */
  flows?: (() => Promise<readonly FlowRecord[]>) | undefined;
}): Promise<DecidedBrief> {
  const { brief: prior } = await readBrief(
    options.projectDirectory,
    options.slug,
  );
  if (prior.status === "superseded")
    throw new IdiomError(
      `brief ${prior.slug} is superseded by ${prior.supersededBy}; decide ${prior.supersededBy} instead`,
    );
  if (!isCompleteBrief(prior))
    throw new IdiomError(
      `brief ${prior.slug} has incomplete research and no options to decide; record a complete brief first`,
    );
  const chosen = prior.options.find((option) => option.id === options.option);
  if (chosen === undefined)
    throw new IdiomError(
      `brief ${prior.slug} has no option ${JSON.stringify(options.option)}; choose one of ${prior.options.map((option) => option.id).join(", ")}`,
    );
  const by = options.by?.trim();
  if (options.by !== undefined && by === "")
    throw new IdiomError("--by must name who decided");
  await checkAssertions(prior, options.flows);
  const brief = storedBriefSchema.parse({
    ...prior,
    status: "decided",
    decidedBy: by ?? "requester",
    chosenOption: chosen.id,
    supersededBy: undefined,
    updatedAt: options.now.toISOString(),
  });
  const directory = briefsDirectory(options.projectDirectory);
  await writeBrief(directory, brief, options.settings);
  const recommended = prior.options.find(
    (option) => option.id === prior.recommendation.option,
  ) as BriefOption;
  return {
    slug: brief.slug,
    outcome: prior.status === "decided" ? "re-decided" : "decided",
    brief,
    markdownPath: join(directory, `${brief.slug}.md`),
    chosen,
    recommended,
    criteriaWarning:
      chosen.id === recommended.id
        ? undefined
        : chosen.kind === "dont-build"
          ? `the decision is not to build it; ${brief.slug}.md says there is nothing to build, so do not write a ticket from it`
          : `the acceptance criteria were written for the recommendation (${recommended.id}); re-record the brief with criteria for ${chosen.id} before using it as a ticket`,
  };
}

/**
 * Records that the brief was attached to an autobuild ticket. Attaching is
 * not a decision change, so `updatedAt` (and `brief list` order) stays put.
 */
export async function recordBriefTicket(options: {
  projectDirectory: string;
  slug: string;
  ticket: string;
  settings: BriefSettings;
}): Promise<StoredBrief> {
  const { brief: prior } = await readBrief(
    options.projectDirectory,
    options.slug,
  );
  const tickets = prior.tickets ?? [];
  if (tickets.includes(options.ticket)) return prior;
  const brief = storedBriefSchema.parse({
    ...prior,
    tickets: [...tickets, options.ticket],
  });
  await writeBrief(
    briefsDirectory(options.projectDirectory),
    brief,
    options.settings,
  );
  return brief;
}

export function triagesDirectory(projectDirectory: string): string {
  return join(briefsDirectory(projectDirectory), "triage");
}

/** Stable per request and rubric, so re-triaging overwrites its own record. */
export function triageId(rubricVersion: number, request: string): string {
  return `triage-${createHash("sha256")
    .update(`${rubricVersion}\n${request}`)
    .digest("hex")
    .slice(0, 10)}`;
}

export async function saveTriage(options: {
  projectDirectory: string;
  request: string;
  rubricVersion: number;
  result: BriefTriageResult;
  now: Date;
}): Promise<StoredTriage> {
  const record = storedTriageSchema.parse({
    version: 1,
    id: triageId(options.rubricVersion, options.request),
    request: options.request,
    rubricVersion: options.rubricVersion,
    createdAt: options.now.toISOString(),
    verdict: options.result.verdict,
    reason: options.result.reason,
    questions: options.result.questions,
  });
  const directory = triagesDirectory(options.projectDirectory);
  await mkdir(directory, { recursive: true });
  await writeAtomic(
    join(directory, `${record.id}.json`),
    `${JSON.stringify(record, null, 2)}\n`,
  );
  return record;
}

export async function readTriage(
  projectDirectory: string,
  id: string,
): Promise<StoredTriage> {
  if (!briefTriageIdSchema.safeParse(id).success)
    throw new IdiomError(
      `invalid triage id ${JSON.stringify(id)}; run idiom brief triage first`,
    );
  let text: string;
  try {
    text = await readFile(
      join(triagesDirectory(projectDirectory), `${id}.json`),
      "utf8",
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      throw new IdiomError(
        `no triage named ${id}; run idiom brief triage first`,
      );
    throw error;
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw new IdiomError(
      `triage ${id} is not valid JSON: ${(error as Error).message}`,
    );
  }
  const parsed = storedTriageSchema.safeParse(json);
  if (!parsed.success)
    throw new IdiomError(
      `triage ${id} is invalid: ${formatBriefIssues(parsed.error).join("; ")}`,
    );
  return parsed.data;
}

export type ListedBrief =
  | { slug: string; brief: StoredBrief }
  | { slug: string; error: string };

export async function listBriefs(
  projectDirectory: string,
): Promise<ListedBrief[]> {
  const directory = briefsDirectory(projectDirectory);
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const entries = await Promise.all(
    names
      .filter((name) => name.endsWith(".json"))
      .map(async (name): Promise<ListedBrief> => {
        const slug = name.slice(0, -".json".length);
        try {
          return {
            slug,
            brief: parseStored(
              await readFile(join(directory, name), "utf8"),
              slug,
            ),
          };
        } catch (error) {
          return { slug, error: (error as Error).message };
        }
      }),
  );
  const updated = (entry: ListedBrief) =>
    "brief" in entry ? entry.brief.updatedAt : "";
  return entries.sort(
    (left, right) =>
      updated(right).localeCompare(updated(left)) ||
      left.slug.localeCompare(right.slug),
  );
}

function checkedSlug(slug: string): string {
  if (!briefSlugSchema.safeParse(slug).success)
    throw new IdiomError(
      `invalid brief name ${JSON.stringify(slug)}; run idiom brief list`,
    );
  return slug;
}

export async function readBrief(
  projectDirectory: string,
  slug: string,
): Promise<{ brief: StoredBrief; markdown: string | undefined }> {
  const directory = briefsDirectory(projectDirectory);
  const name = checkedSlug(slug);
  let text: string;
  try {
    text = await readFile(join(directory, `${name}.json`), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      throw new IdiomError(`no brief named ${name}; run idiom brief list`);
    throw error;
  }
  const brief = parseStored(text, name);
  const markdown = await readFile(join(directory, `${name}.md`), "utf8").catch(
    () => undefined,
  );
  return { brief, markdown };
}

/**
 * Every decided brief in the project, plus every Idiom design asset pinned
 * to the build, sorted by slug. The asset is the contract the ticket was
 * claimed with, so it replaces a stored brief of the same slug. Briefs that
 * fail to parse are left to `idiom brief list`, which already reports them.
 */
export async function loadBriefChecks(
  projectDirectory: string,
): Promise<BriefCheck[]> {
  const assets = await readDesignAssets(projectDirectory);
  const pinned = new Set(assets.map((brief) => brief.slug));
  return [
    ...(await listBriefs(projectDirectory)).flatMap((entry) =>
      "brief" in entry &&
      entry.brief.status === "decided" &&
      isCompleteBrief(entry.brief) &&
      !pinned.has(entry.slug)
        ? [briefCheckFrom(entry.brief)]
        : [],
    ),
    ...assets,
  ].sort((left, right) => left.slug.localeCompare(right.slug));
}

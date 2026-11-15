import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { IdiomError } from "../errors.js";
import { electronStateSchema, webStateSchema } from "../schemas/flow.js";
import type { LearnedPlacement } from "../schemas/learned.js";
import type { FlowRecord } from "../validation.js";
import { sentence } from "./candidate.js";
import { type ListedStateCapture, listStateCaptures } from "./capture.js";
import { subjectTokens } from "./interpret.js";
import {
  type Confidence,
  matchScreenshot,
  type ScoredCandidate,
} from "./match.js";

/** Words too common to place an observation on a state. */
const fillerWords = new Set([
  "a",
  "all",
  "and",
  "are",
  "as",
  "at",
  "be",
  "but",
  "by",
  "can",
  "do",
  "doe",
  "for",
  "from",
  "ha",
  "have",
  "here",
  "i",
  "in",
  "into",
  "is",
  "it",
  "its",
  "look",
  "make",
  "more",
  "much",
  "must",
  "need",
  "not",
  "of",
  "on",
  "one",
  "or",
  "our",
  "should",
  "so",
  "than",
  "there",
  "they",
  "to",
  "too",
  "very",
  "wa",
  "we",
  "when",
  "with",
  "would",
  "you",
]);

/** The observation's content words: lowercase, singular, no filler. */
export function contentTokens(text: string): string[] {
  return subjectTokens(text).filter((token) => !fillerWords.has(token));
}

type Candidate = ListedStateCapture & { key: string };

export type MatchedPlacement = {
  flow: FlowRecord;
  state: string;
  capture?: ListedStateCapture | undefined;
  placement: LearnedPlacement;
  /** One line for the human: where the observation was placed and why. */
  message: string;
};

export type StateProposal = {
  path: string;
  displayPath: string;
  content: string;
};

export type ProposedPlacement = {
  flowId: string;
  flow?: FlowRecord | undefined;
  stateId: string;
  proposal: StateProposal;
  placement: LearnedPlacement;
  message: string;
};

export type Placement =
  | { matched: MatchedPlacement; proposed?: undefined }
  | { proposed: ProposedPlacement; matched?: undefined };

const percent = (value: number) => `${Math.round(value * 100)}%`;

function tupleLabel(capture: ListedStateCapture): string {
  return `${capture.flow}/${capture.state} @ ${capture.viewport}${capture.colorScheme === undefined ? "" : ` (${capture.colorScheme})`}`;
}

/** The one declared state the words name, if exactly one. */
function wordMatch(
  flows: FlowRecord[],
  observation: string,
): { flow: FlowRecord; state: string; tokens: string[] } | undefined {
  const tokens = new Set(contentTokens(observation));
  const states = flows.flatMap((flow) =>
    flow.flow.states.map((state) => ({ flow, state })),
  );
  // A state whose whole id appears in the words; the most specific wins.
  const named = states
    .map(({ flow, state }) => ({
      flow,
      state: state.id,
      tokens: subjectTokens(state.id.replace(/[-.]/g, " ")),
    }))
    .filter(
      (item) =>
        item.tokens.length > 0 &&
        item.tokens.every((token) => tokens.has(token)),
    )
    .sort((a, b) => b.tokens.length - a.tokens.length);
  const [first, second] = named;
  if (first !== undefined)
    return second === undefined || second.tokens.length < first.tokens.length
      ? first
      : undefined;
  // Else the only state sharing two or more content words with its description.
  const described = states
    .map(({ flow, state }) => ({
      flow,
      state: state.id,
      tokens: [
        ...new Set(
          contentTokens(state.description).filter((token) => tokens.has(token)),
        ),
      ],
    }))
    .filter((item) => item.tokens.length >= 2);
  return described.length === 1 ? described[0] : undefined;
}

function slug(tokens: string[]): string {
  return tokens
    .slice(0, 4)
    .join("-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

async function proposedStateIds(
  directory: string,
  ownProposal?: string | undefined,
): Promise<Set<string>> {
  const ids = new Set<string>();
  let names: string[];
  try {
    names = await readdir(directory);
  } catch {
    return ids;
  }
  for (const name of names.filter(
    (name) => name.endsWith(".json") && name !== `${ownProposal}.json`,
  ))
    try {
      const value = JSON.parse(await readFile(join(directory, name), "utf8"));
      if (typeof value?.state?.id === "string") ids.add(value.state.id);
    } catch {
      /* An unreadable proposal reserves nothing. */
    }
  return ids;
}

/**
 * The draft state id: the observation's first content words, unique against
 * the flow's declared states and earlier proposals, else the learned id.
 */
export async function proposalSlug(options: {
  observation: string;
  learnedId: string;
  declared: ReadonlySet<string>;
  proposalsDirectory: string;
  /** State ids proposed earlier in the same pass, not yet on disk. */
  reserved?: ReadonlySet<string> | undefined;
  /** The learned id whose own proposal file does not reserve its id. */
  ownProposal?: string | undefined;
}): Promise<string> {
  const taken = new Set([
    ...options.declared,
    ...(options.reserved ?? []),
    ...(await proposedStateIds(
      options.proposalsDirectory,
      options.ownProposal,
    )),
  ]);
  const base = slug(contentTokens(options.observation)) || options.learnedId;
  if (!taken.has(base)) return base;
  for (let suffix = 2; ; suffix += 1)
    if (!taken.has(`${base}-${suffix}`)) return `${base}-${suffix}`;
}

/**
 * Where an observation with no named state applies: the stored capture its
 * screenshot matches, else the one state its words name, else the only
 * declared state, else a draft state the project can add. Never throws for a
 * missing state.
 */
export async function placeObservation(options: {
  projectDirectory: string;
  flows: FlowRecord[];
  flowId?: string | undefined;
  observation: string;
  screenshot?: string | undefined;
  from?: string | undefined;
  learnedId: string;
  /** State ids proposed earlier in the same pass (`learn --import`). */
  reserved?: ReadonlySet<string> | undefined;
  /** Re-placing this learned id: its own proposal file reserves nothing. */
  ownProposal?: string | undefined;
  /** The words a draft state records, when `observation` adds a state hint. */
  text?: string | undefined;
  /**
   * An explicit draft state description (`NEW: …` in an import): skip
   * matching and draft this state.
   */
  proposeState?: string | undefined;
}): Promise<Placement> {
  const { projectDirectory } = options;
  if (
    options.flowId !== undefined &&
    !options.flows.some((record) => record.flow.id === options.flowId)
  )
    throw new IdiomError(`no flow ${JSON.stringify(options.flowId)}`);
  const flows = options.flows.filter(
    (record) =>
      options.flowId === undefined || record.flow.id === options.flowId,
  );
  const flowById = new Map(flows.map((record) => [record.flow.id, record]));
  const declared = new Map(
    flows.map((record) => [
      record.flow.id,
      new Set(record.flow.states.map((state) => state.id)),
    ]),
  );

  let nearest: ScoredCandidate<Candidate> | undefined;
  let screenshotTried = false;
  const explicit = options.proposeState;
  if (options.screenshot !== undefined && explicit === undefined) {
    let bytes: Buffer;
    try {
      bytes = await readFile(options.screenshot);
    } catch (error) {
      throw new IdiomError(
        `cannot read --screenshot ${options.screenshot}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const candidates = (
      await listStateCaptures({
        projectDirectory,
        declared,
        flow: options.flowId,
        from: options.from,
      })
    ).map((capture) => ({
      ...capture,
      key: `${capture.flow}/${capture.state}`,
    }));
    if (candidates.length > 0) {
      screenshotTried = true;
      const match = await matchScreenshot({
        screenshot: bytes,
        label: options.screenshot,
        candidates,
      });
      nearest = match.ranked[0];
      const flow =
        match.best === undefined
          ? undefined
          : flowById.get(match.best.candidate.flow);
      if (match.best !== undefined && flow !== undefined) {
        const { candidate, similarity, confidence } = match.best;
        const runnerUp = match.runnerUp;
        return {
          matched: {
            flow,
            state: candidate.state,
            capture: candidate,
            placement: placementFor(candidate, similarity, confidence),
            message: `Matched screenshot to ${tupleLabel(candidate)} (run ${candidate.runId}), ${percent(similarity)} similar, ${confidence} confidence${runnerUp === undefined ? "" : `; next closest ${tupleLabel(runnerUp.candidate)}, ${percent(runnerUp.similarity)}`}.`,
          },
        };
      }
    }
  }

  if (!screenshotTried && explicit === undefined) {
    const words = wordMatch(flows, options.observation);
    if (words !== undefined)
      return {
        matched: {
          flow: words.flow,
          state: words.state,
          placement: { via: "words", tokens: words.tokens },
          message: `Placed on ${words.flow.flow.id}/${words.state} from the words (${words.tokens.join(", ")}).`,
        },
      };
    const all = flows.flatMap((flow) =>
      flow.flow.states.map((state) => ({ flow, state: state.id })),
    );
    const only = all[0];
    if (all.length === 1 && only !== undefined)
      return {
        matched: {
          ...only,
          placement: { via: "only-state" },
          message: `Placed on ${only.flow.flow.id}/${only.state}, the only declared state.`,
        },
      };
  }

  // Nothing matches: a draft flow state the project can add.
  const flow =
    (nearest === undefined
      ? undefined
      : flowById.get(nearest.candidate.flow)) ?? flows[0];
  const flowId = flow?.flow.id ?? "unplaced";
  const proposalsDirectory = join(
    projectDirectory,
    ".idiom",
    "proposals",
    "states",
  );
  const stateId = await proposalSlug({
    observation: explicit ?? options.observation,
    learnedId: options.learnedId,
    declared: declared.get(flowId) ?? new Set(),
    proposalsDirectory,
    reserved: options.reserved,
    ownProposal: options.ownProposal,
  });
  const path = join(proposalsDirectory, `${options.learnedId}.json`);
  const displayPath = relative(projectDirectory, path);
  const state = draftState({
    flow,
    stateId,
    description: explicit ?? options.text ?? options.observation,
    nearest:
      nearest !== undefined && nearest.candidate.flow === flowId
        ? nearest.candidate.state
        : undefined,
  });
  const flowFile =
    flow === undefined ? undefined : relative(projectDirectory, flow.file);
  const content = `${JSON.stringify(
    {
      version: 1,
      learned: options.learnedId,
      flow: flowId,
      ...(flowFile === undefined ? {} : { file: flowFile }),
      observation: options.text ?? options.observation,
      ...(nearest === undefined
        ? {}
        : {
            nearest: {
              flow: nearest.candidate.flow,
              state: nearest.candidate.state,
              viewport: nearest.candidate.viewport,
              runId: nearest.candidate.runId,
              similarity: Math.round(nearest.similarity * 1000) / 1000,
            },
          }),
      state,
      next: `Add \`state\` to ${flowFile === undefined ? "a flow's states" : `the states in ${flowFile}`}, keep its id, fill in the steps that reach it, then idiom capture ${flow === undefined ? "<flow>" : flowId}.`,
    },
    null,
    2,
  )}\n`;
  const why =
    explicit !== undefined
      ? "The state cell asks for a new state"
      : options.screenshot === undefined
        ? "No declared state matches the words"
        : !screenshotTried
          ? "No stored capture to match the screenshot against, and no declared state matches the words"
          : `No captured state matches the screenshot well enough${nearest === undefined ? "" : ` (closest ${tupleLabel(nearest.candidate)}, ${percent(nearest.similarity)})`}`;
  return {
    proposed: {
      flowId,
      flow,
      stateId,
      proposal: { path, displayPath, content },
      placement: { via: "proposed", proposal: displayPath },
      message: `${why}; recording the miss as open against a draft state ${flowId}/${stateId} — ${displayPath}.`,
    },
  };
}

function placementFor(
  capture: ListedStateCapture,
  similarity: number,
  confidence: Confidence,
): LearnedPlacement {
  return {
    via: "screenshot",
    similarity: Math.round(similarity * 1000) / 1000,
    confidence,
    viewport: capture.viewport,
    ...(capture.colorScheme === undefined
      ? {}
      : { colorScheme: capture.colorScheme }),
    runId: capture.runId,
  };
}

/**
 * The draft state: reached `from` the nearest captured state with steps to
 * fill in, else the flow's first URL, else its first state. Validated against
 * the flow's own state schema so pasting it yields a valid manifest.
 */
function draftState(options: {
  flow: FlowRecord | undefined;
  stateId: string;
  description: string;
  nearest: string | undefined;
}): Record<string, unknown> {
  const { flow } = options;
  const base = {
    id: options.stateId,
    description: sentence(options.description),
  };
  if (flow !== undefined && flow.flow.target.kind === "electron") {
    const state = { ...base, steps: [], expect: {} };
    electronStateSchema.parse(state);
    return state;
  }
  const states = flow?.flow.states ?? [];
  const firstUrl = states.find((state) => state.url !== undefined)?.url;
  const reach =
    options.nearest !== undefined
      ? { from: options.nearest }
      : firstUrl !== undefined
        ? { url: firstUrl }
        : states[0] !== undefined
          ? { from: states[0].id }
          : { url: "/" };
  const state = { ...base, ...reach, steps: [], expect: {} };
  webStateSchema.parse(state);
  return state;
}

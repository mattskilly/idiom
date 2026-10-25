import type { CheckTuple } from "../checks/types.js";
import type { ReferenceRef } from "../critique/types.js";
import type {
  ExplorationCandidate,
  ExplorationRefinement,
} from "../schemas/exploration.js";
import type { Flow } from "../schemas/flow.js";
import type { Project } from "../schemas/project.js";
import type { RulingResolution, UnruledDecision } from "../schemas/ruling.js";

export type ExplorationContext = {
  projectDirectory: string;
  project: Project;
  flow: Flow;
  state: Flow["states"][number];
  question: string;
  decision?: UnruledDecision | undefined;
  productMd: string;
  designMd: string;
  rulings: RulingResolution[];
  references: ReferenceRef[];
  tuples: Array<{
    state: string;
    viewport: string;
    colorScheme: "light" | "dark";
  }>;
};

export type ExplorationEvidence = {
  mirrorRoot: string;
  readablePaths: string[];
  baselineTuples: CheckTuple[];
  runDirectory: string;
};

export type CandidateRequest = {
  context: ExplorationContext;
  evidence: ExplorationEvidence;
  rejected?: { candidate: ExplorationCandidate; issues: string[] } | undefined;
};

export type RefinementRequest = {
  context: ExplorationContext;
  evidence: ExplorationEvidence;
  candidate: ExplorationCandidate;
  instruction: string;
  rejected?:
    | { refinement: ExplorationRefinement; issues: string[] }
    | undefined;
};

export interface ExplorationAdapter {
  preflight(): Promise<void>;
  proposeCandidates(input: CandidateRequest): Promise<ExplorationCandidate[]>;
  refineCandidate(input: RefinementRequest): Promise<ExplorationRefinement>;
}

export type RenderedCandidate = {
  candidate: ExplorationCandidate;
  cloneDirectory: string;
  mirrorDirectory: string;
  runDirectory: string;
  tuples: CheckTuple[];
  refined?: boolean | undefined;
};

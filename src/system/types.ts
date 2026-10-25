import type { StandingProhibition } from "../decisions/prohibitions.js";
import type { ReportCoverage } from "../report/coverage.js";
import type { RulingResolution } from "../schemas/ruling.js";

export type TokenResolution =
  | { status: "available" }
  | { status: "unavailable"; reason: string };

export type SystemToken = {
  base?: boolean | undefined;
  kind?: import("./learn/schema.js").TokenKind | undefined;
  source?: import("./learn/schema.js").DesignToken["source"] | undefined;
  theme?: string | undefined;
  resolved?: string | undefined;
  environment?: Record<string, string> | undefined;
  name: string;
  value: string;
  resolution: TokenResolution;
};

export type SystemTokens =
  | { status: "not-configured" }
  | {
      status: "configured";
      source: string;
      tokens: SystemToken[];
      declarations?: import("./learn/types.js").ExtractedToken[] | undefined;
      environment: Record<string, string>;
    };

export type EvidenceCoordinate = {
  flow: string;
  state: string;
  viewport: string;
  colorScheme: "light" | "dark";
};

export type ObservedValue = {
  value: string;
  coordinates: EvidenceCoordinate[];
};

export type SystemObserved =
  | { status: "unavailable"; reason: string }
  | {
      status: "available";
      runId: string;
      capturedAt: string;
      colors: ObservedValue[];
      fontFamilies: ObservedValue[];
      fontSizes: ObservedValue[];
      fontWeights: ObservedValue[];
      typographyAvailable: boolean;
    };

export type SystemProhibition = StandingProhibition & {
  images?: Array<{ path: string; dataUri: string }>;
};

export type SystemCoverage =
  | { status: "unavailable"; reason: string }
  | {
      status: "available";
      runId: string;
      reviewedAt: string;
      value: ReportCoverage;
    };

export type SystemPageModel = {
  drift?: import("./drift.js").DriftInput | undefined;
  projectName: string;
  generatedAt: string;
  tokens: SystemTokens;
  observed: SystemObserved;
  designLaw: string;
  rulings: RulingResolution[];
  decisionsAvailable: boolean;
  prohibitions: SystemProhibition[];
  coverage: SystemCoverage;
};

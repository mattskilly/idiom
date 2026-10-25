import { readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { IdiomError } from "../errors.js";
import type { Finding } from "../schemas/finding.js";
import {
  type RuleOverride,
  type Rules,
  rulesSchema,
} from "../schemas/rules.js";

export const emptyRules: Rules = { version: 1, overrides: [] };

function fieldPath(path: PropertyKey[]): string {
  let rendered = "";
  for (const segment of path) {
    if (typeof segment === "number") rendered += `[${segment}]`;
    else rendered += rendered === "" ? String(segment) : `.${String(segment)}`;
  }
  return rendered || "<root>";
}

export async function readRules(projectDirectory: string): Promise<Rules> {
  const path = join(projectDirectory, ".idiom", "rules.json");
  const display = relative(projectDirectory, path);
  let source: string;
  try {
    source = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyRules;
    throw new IdiomError(
      `${display}: could not be read: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch (error) {
    throw new IdiomError(
      `${display}: malformed JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const parsed = rulesSchema.safeParse(value);
  if (!parsed.success) {
    throw new IdiomError(
      parsed.error.issues
        .map(
          (issue) => `${display}: ${fieldPath(issue.path)}: ${issue.message}`,
        )
        .join("\n"),
    );
  }
  return parsed.data;
}

export type RuleSubject = Pick<
  Finding,
  "fingerprint" | "category" | "flow" | "state" | "rule"
> & { fingerprintAliases?: string[] | undefined };

export function ruleMatches(
  override: RuleOverride,
  subject: RuleSubject,
): boolean {
  const match = override.match;
  const fingerprints = new Set([
    subject.fingerprint,
    ...(subject.fingerprintAliases ?? []),
  ]);
  return (
    (match.fingerprint === undefined || fingerprints.has(match.fingerprint)) &&
    (match.category === undefined || match.category === subject.category) &&
    (match.flow === undefined || match.flow === subject.flow) &&
    (match.state === undefined || match.state === subject.state) &&
    (match.rule === undefined || match.rule === subject.rule)
  );
}

export type RulePolicy = {
  suppression?: RuleOverride | undefined;
  severity?:
    | {
        override: RuleOverride;
        original: Finding["severity"];
        effective: Finding["severity"];
      }
    | undefined;
};

export function evaluateRules(
  rules: Rules,
  subject: RuleSubject & Pick<Finding, "severity">,
): RulePolicy {
  let suppression: RuleOverride | undefined;
  let severityOverride: RuleOverride | undefined;
  for (const override of rules.overrides) {
    if (!ruleMatches(override, subject)) continue;
    if (override.action === "suppress") suppression = override;
    else severityOverride = override;
  }
  return {
    ...(suppression === undefined ? {} : { suppression }),
    ...(severityOverride?.severity === undefined
      ? {}
      : {
          severity: {
            override: severityOverride,
            original: subject.severity,
            effective: severityOverride.severity,
          },
        }),
  };
}

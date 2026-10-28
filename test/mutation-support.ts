import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { type Browser, type BrowserContext, chromium } from "playwright";
import { tupleCoordinateKey } from "../src/baseline/coordinate.js";
import { largestShiftCause } from "../src/checks/layout-shift.js";
import {
  checksConfigFrom,
  runDeterministicChecks,
} from "../src/checks/registry.js";
import type { CheckTuple } from "../src/checks/types.js";
import {
  buildDeterministicDrafts,
  type FindingDraft,
  finalizeFindings,
} from "../src/review/findings.js";
import { coordinateIndex } from "../src/review/groups.js";
import {
  affectedCounts,
  buildIssueRankingContext,
  scoreGroup,
} from "../src/review/ranking.js";
import type { Finding } from "../src/schemas/finding.js";
import { checksConfigSchema } from "../src/schemas/project.js";
import { type ReviewOptions, reviewStates } from "./benchmark-support.js";
import {
  capabilityFor,
  type ExpectedIdentity,
  type MutationAudit,
  type MutationOperator,
  matchesExpected,
  mutationProgram,
  operators,
} from "./fixtures/mutations/catalog.js";

export const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
export const caseId = (operator: string, page: string) =>
  `${operator}::${page}`;

export async function discoverPages(root: string): Promise<string[]> {
  const walk = async (directory: string): Promise<string[]> =>
    (
      await Promise.all(
        (
          await readdir(directory, { withFileTypes: true })
        ).map(async (entry) => {
          const path = join(directory, entry.name);
          return entry.isDirectory() ? walk(path) : [path];
        }),
      )
    ).flat();
  const benchmark = await walk(join(root, "test/fixtures/benchmark"));
  const clean = await walk(join(root, "test/fixtures/mutations/clean"));
  return [
    ...benchmark.filter((path) => /(?:\/after|-after)\.html$/.test(path)),
    ...clean.filter((path) => path.endsWith(".html")),
  ]
    .map((path) => relative(root, path).split("\\").join("/"))
    .sort();
}

export function profileFor(
  operator: MutationOperator,
  page: string,
): ReviewOptions {
  return {
    serve: true,
    axe: operator.axe === true,
    probe: operator.probe === true,
    viewport: { width: operator.narrow ? 390 : 1000, height: 900 },
    settleMs: operator.capability === "load" ? 800 : 0,
    checks: {
      scales: {
        spacing: [0, 4, 8, 12, 16, 24, 32, 48, 64],
        radius: { control: [0, 4, 6, 8, 12, 16] },
      },
      copy: { retired: [{ term: "Style guide", preferred: "Brand" }] },
      ...(operator.capability === "dead"
        ? { probe: { skip: ["#icon", "#search", "#query"] } }
        : {}),
    },
    ...(page.includes("interaction-shift-late/") ? { settleMs: 0 } : {}),
  };
}

export async function prepareFixture(
  context: BrowserContext,
  html: string,
  page: string,
  errors: string[],
  input?: {
    operator: MutationOperator;
    apply: boolean;
    audits: MutationAudit[];
  },
): Promise<void> {
  await context.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== "http://idiom.test") {
      await route.abort();
      return;
    }
    const path = url.pathname;
    if (path === "/" || ["/next", "/orders"].includes(path)) {
      await route.fulfill({ contentType: "text/html", body: html });
      return;
    }
    if (
      ["/api/items", "/api/save", "/api/page", "/results"].includes(path) ||
      /^\/batch\/\d+$/.test(path)
    ) {
      if (path === "/results" || path.startsWith("/batch/"))
        await new Promise((resolve) => setTimeout(resolve, 700));
      const body =
        path === "/api/page"
          ? { title: "Orders", body: "Three orders are ready." }
          : path === "/api/save"
            ? { ok: true }
            : ["Avery", "Blair", "Casey"];
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify(body),
      });
      return;
    }
    errors.push(
      `Missing local route: ${route.request().method()} ${path} (${page})`,
    );
    await route.abort();
  });
  if (input) {
    await context.exposeBinding(
      "__mutationAudit",
      (_source, audit: MutationAudit) => {
        input.audits.push(audit);
      },
    );
    const capability = input.operator.capability
      ? capabilityFor(page, input.operator.capability)
      : undefined;
    // Function source is self-contained; this runs on every replacement page too.
    const source = `addEventListener('DOMContentLoaded',()=>{try{globalThis.__mutationAudit((${mutationProgram.toString()})(${JSON.stringify({ operator: input.operator, apply: input.apply, ...(capability ? { capability } : {}) })}));}catch(error){globalThis.__mutationAudit({error:String(error)});}}, {once:true});`;
    await context.addInitScript({ content: source });
  }
}

export type Capture = {
  tuples: CheckTuple[];
  entries: ReturnType<typeof runDeterministicChecks>["candidates"];
  coverage: ReturnType<typeof runDeterministicChecks>["coverage"];
  drafts: FindingDraft[];
  findings: Finding[];
  audits: MutationAudit[];
};

export async function capturePage(
  browser: Browser,
  html: string,
  page: string,
  profile: ReviewOptions,
  input?: { operator: MutationOperator; apply: boolean },
): Promise<Capture> {
  const audits: MutationAudit[] = [];
  const errors: string[] = [];
  const prepared = profile.prepareContext;
  const { tuples } = await reviewStates(
    browser,
    [{ state: "mutation", html }],
    {
      ...profile,
      prepareContext: async (context) => {
        await prepareFixture(
          context,
          html,
          page,
          errors,
          input ? { ...input, audits } : undefined,
        );
        await prepared?.(context);
      },
    },
  );
  if (errors.length) throw new Error([...new Set(errors)].join("; "));
  if (audits.some((audit) => "error" in audit || !audit.pure))
    throw new Error(
      "Mutation program failed or changed content outside its declared locus",
    );
  if (input && !audits.length)
    throw new Error("Mutation preparation did not run");
  return reviewTuples(tuples, profile, audits);
}

function reviewTuples(
  tuples: CheckTuple[],
  profile: ReviewOptions,
  audits: MutationAudit[] = [],
): Capture {
  const result = runDeterministicChecks(
    tuples,
    undefined,
    checksConfigFrom(checksConfigSchema.parse(profile.checks ?? {})),
  );
  const drafts = buildDeterministicDrafts({
    runId: "mutation",
    entries: result.candidates,
  });
  return {
    tuples,
    entries: result.candidates,
    coverage: result.coverage,
    drafts,
    findings: finalizeFindings({ runId: "mutation", drafts }),
    audits,
  };
}

export function stableSignatures(capture: Capture): string[] {
  return capture.drafts
    .map((draft) => {
      // Timing/rect magnitudes are evidence, not identity. Keep exact rule targets.
      const params =
        draft.finding.verification.kind === "deterministic-check"
          ? (draft.finding.verification.params ?? {})
          : {};
      const identityParams = Object.fromEntries(
        [
          "selector",
          "neighbour",
          "surface",
          "property",
          "role",
          "value",
          "requests",
          "kind",
          "targets",
        ]
          .filter((key) => params[key] !== undefined)
          .map((key) => [key, params[key]]),
      );
      return JSON.stringify([
        draft.finding.fingerprint,
        draft.finding.rule,
        draft.selectorHint,
        draft.finding.severity,
        identityParams,
      ]);
    })
    .sort();
}

export function rankFindings(
  capture: Pick<Capture, "tuples" | "drafts" | "findings">,
) {
  const context = buildIssueRankingContext(capture.tuples);
  const coordinates = coordinateIndex(capture.drafts);
  const severity = { blocker: 0, major: 1, minor: 2 };
  return capture.findings
    .map((finding) => {
      const draft = capture.drafts.find(
        (item) => item.finding.fingerprint === finding.fingerprint,
      );
      if (!draft) throw new Error(`Missing draft for ${finding.id}`);
      const keys = (coordinates.get(finding.fingerprint) ?? []).map(
        tupleCoordinateKey,
      );
      const score = scoreGroup(
        {
          category: finding.category,
          rule: finding.rule,
          selector: draft.selectorHint,
          coordinates: keys,
        },
        affectedCounts(keys, context),
        context,
      );
      return {
        finding,
        selector: draft.selectorHint,
        score: score.score,
        salience: score.salience,
        prominence: score.prominence,
        stableOrder: draft.stableOrder,
      };
    })
    .sort(
      (a, b) =>
        b.score - a.score ||
        severity[a.finding.severity] - severity[b.finding.severity] ||
        a.stableOrder - b.stableOrder,
    );
}

export function matchingFingerprints(
  capture: Capture,
  expected: ExpectedIdentity,
): Set<string> {
  return new Set(
    capture.entries
      .filter(({ candidate, tuple }) => {
        const shift =
          tuple.observations?.version === 2
            ? tuple.observations.layoutShift
            : undefined;
        const cause =
          candidate.category === "layout-shift" && shift
            ? largestShiftCause(tuple, shift.entries)?.cause.selector
            : undefined;
        return matchesExpected(candidate, expected, cause);
      })
      .flatMap((entry) =>
        buildDeterministicDrafts({ runId: "mutation", entries: [entry] }).map(
          (draft) => draft.finding.fingerprint,
        ),
      ),
  );
}

export function evaluateSeed(
  clean: Capture,
  mutant: Capture,
  expected: ExpectedIdentity,
) {
  if (matchingFingerprints(clean, expected).size)
    throw new Error(
      "Control invalid: the exact expected defect is already present on the clean page",
    );
  const fingerprints = matchingFingerprints(mutant, expected);
  const ranked = rankFindings(mutant);
  const matches = ranked.flatMap((item, index) =>
    fingerprints.has(item.finding.fingerprint)
      ? [
          {
            id: item.finding.id,
            fingerprint: item.finding.fingerprint,
            rank: index + 1,
          },
        ]
      : [],
  );
  return {
    caught: matches.length > 0,
    rank: matches[0]?.rank ?? null,
    expectedFindings: matches,
    findingCount: ranked.length,
    otherFindings: ranked.length - matches.length,
  };
}

export function evidenceOf(capture: Capture) {
  return capture.tuples.map((tuple) => {
    const observations = tuple.observations;
    const probe = observations?.version === 2 ? observations.probe : undefined;
    return {
      actions: (tuple.timelines?.actions ?? []).map(
        ({ frames, ...action }) => ({
          ...action,
          frameCount: frames.length,
        }),
      ),
      probe: probe ?? null,
      motion:
        observations?.version === 2 ? (observations.motion ?? null) : null,
    };
  });
}

export type CaseResult = {
  id: string;
  operator: string;
  page: string;
  rule: string;
  status: "evaluated" | "error";
  expected?: ExpectedIdentity;
  caught: boolean;
  rank: number | null;
  expectedFindings: Array<{ id: string; fingerprint: string; rank: number }>;
  findingCount: number;
  otherFindings: number;
  diagnostic: string;
  candidates?: Array<{
    rule: string;
    selector: string;
    fingerprintHint: string | null;
    params: Record<string, unknown>;
  }>;
  coverage?: Array<{
    check: string;
    status: string;
    reason?: string | undefined;
  }>;
  evidence?: ReturnType<typeof evidenceOf>;
  mutation?: { pure: boolean; applications: number; changed: boolean };
};
export function summarize(cases: CaseResult[]) {
  const measure = (items: CaseResult[]) => {
    const valid = items.filter((item) => item.status === "evaluated");
    const caught = valid.filter((item) => item.caught);
    const ranks = caught
      .flatMap((item) => (item.rank === null ? [] : [item.rank]))
      .sort((a, b) => a - b);
    const middle = Math.floor(ranks.length / 2);
    const medianRank = ranks.length
      ? ranks.length % 2
        ? (ranks[middle] ?? null)
        : ((ranks[middle - 1] ?? 0) + (ranks[middle] ?? 0)) / 2
      : null;
    return {
      attempted: valid.length,
      caught: caught.length,
      missed: valid.length - caught.length,
      errors: items.length - valid.length,
      recall: valid.length ? caught.length / valid.length : null,
      medianRank,
      top3: ranks.filter((rank) => rank <= 3).length,
      top10: ranks.filter((rank) => rank <= 10).length,
    };
  };
  return {
    overall: measure(cases),
    perRule: Object.fromEntries(
      [...new Set(cases.map((item) => item.rule))]
        .sort()
        .map((rule) => [
          rule,
          measure(cases.filter((item) => item.rule === rule)),
        ]),
    ),
    misses: cases
      .filter((item) => item.status === "evaluated" && !item.caught)
      .map(({ id, operator, page, rule, expected, diagnostic }) => ({
        id,
        operator,
        page,
        rule,
        expected,
        diagnostic,
      })),
  };
}

export async function loadFixture(root: string, page: string): Promise<string> {
  return (await readFile(join(root, page), "utf8")).replace(
    "/*CSS*/",
    await readFile(join(root, "test/fixtures/benchmark/chrome.css"), "utf8"),
  );
}

export async function runMutationBench(options: {
  root: string;
  caseIds?: string[];
  verifyIsolation?: boolean;
  onCase?: (message: string) => void;
}) {
  const started = performance.now();
  const pages = await discoverPages(options.root);
  const cases: CaseResult[] = [];
  const skipped: Array<{
    id: string;
    operator: string;
    page: string;
    reason: string;
  }> = [];
  const sourceHashes: Record<string, string> = {};
  const profiles: Record<string, ReviewOptions> = {};
  const browser = await chromium.launch({ headless: true });
  const chromiumVersion = browser.version();
  const cleanCache = new Map<string, Capture>();
  let isolation: {
    noOp: boolean;
    freshControl: boolean;
    signatures: string[];
  } | null = null;
  try {
    for (const page of pages) {
      const html = await loadFixture(options.root, page);
      sourceHashes[page] = hash(
        await readFile(join(options.root, page), "utf8"),
      );
      for (const operator of operators) {
        const id = caseId(operator.id, page);
        if (options.caseIds && !options.caseIds.includes(id)) continue;
        if (operator.capability && !capabilityFor(page, operator.capability)) {
          skipped.push({
            id,
            operator: operator.id,
            page,
            reason: `Fixture has no declared ${operator.capability} capability`,
          });
          continue;
        }
        const profile = profileFor(operator, page);
        profiles[hash(JSON.stringify(profile)).slice(0, 12)] = profile;
        options.onCase?.(id);
        const base = {
          id,
          operator: operator.id,
          page,
          rule: operator.rule,
          caught: false,
          rank: null,
          expectedFindings: [],
          findingCount: 0,
          otherFindings: 0,
        };
        let expected: ExpectedIdentity | undefined;
        try {
          // Select structurally, without running checks or looking at reviewer output.
          const context = await browser.newContext({
            viewport: profile.viewport ?? { width: 1000, height: 900 },
            serviceWorkers: "block",
            reducedMotion: "reduce",
          });
          let audit: MutationAudit;
          try {
            const errors: string[] = [];
            await prepareFixture(context, html, page, errors);
            const targetPage = await context.newPage();
            await targetPage.goto("http://idiom.test/");
            audit = await targetPage.evaluate(mutationProgram, {
              operator,
              apply: false,
              ...(operator.capability
                ? { capability: capabilityFor(page, operator.capability) }
                : {}),
            });
            if (errors.length) throw new Error(errors.join("; "));
          } finally {
            await context.close();
          }
          if (!audit.applicable) {
            if (operator.capability)
              throw new Error(
                `Declared ${operator.capability} capability has no mutation target`,
              );
            skipped.push({
              id,
              operator: operator.id,
              page,
              reason: audit.reason,
            });
            continue;
          }
          expected = {
            check: operator.check,
            rule: operator.rule,
            selectors: audit.selectors,
            ...(operator.property
              ? { property: operator.property, value: operator.value }
              : {}),
            ...(operator.request ? { request: operator.request } : {}),
            ...(operator.property
              ? {
                  targetProperty:
                    operator.property === "spacing"
                      ? "paddingLeft"
                      : "borderTopLeftRadius",
                }
              : {}),
            ...(operator.capability === "motion"
              ? { kind: "expand-collapse", actionName: "Show more" }
              : {}),
          };
          const key = `${page}:${JSON.stringify(profile)}`;
          // Control and mutant own fresh contexts. Their replay waits can
          // overlap without sharing page state, keeping the CI selection's
          // combined browser/launcher budget as temporal coverage grows.
          const [clean, mutant] = await Promise.all([
            cleanCache.get(key) ?? capturePage(browser, html, page, profile),
            capturePage(browser, html, page, profile, {
              operator,
              apply: true,
            }),
          ]);
          cleanCache.set(key, clean);
          const identity = expected;
          if (
            mutant.audits.some(
              (entry) =>
                !entry.applicable ||
                JSON.stringify(entry.selectors) !==
                  JSON.stringify(identity.selectors),
            )
          )
            throw new Error(
              "Mutation target changed or disappeared during restore",
            );
          if (
            options.verifyIsolation &&
            isolation === null &&
            page.endsWith("/clean/static.html") &&
            !operator.axe &&
            !operator.narrow
          ) {
            const noOp = await capturePage(browser, html, page, profile, {
              operator,
              apply: false,
            });
            const fresh = await capturePage(browser, html, page, profile);
            const direct = await reviewStates(
              browser,
              [{ state: "mutation", html }],
              profile,
            );
            const signatures = stableSignatures(
              reviewTuples(direct.tuples, profile),
            );
            isolation = {
              noOp:
                JSON.stringify(signatures) ===
                JSON.stringify(stableSignatures(noOp)),
              freshControl:
                JSON.stringify(signatures) ===
                JSON.stringify(stableSignatures(fresh)),
              signatures,
            };
            if (!isolation.noOp || !isolation.freshControl)
              throw new Error(
                "Preparation or mutation leaked into the clean control",
              );
          }
          const verdict = evaluateSeed(clean, mutant, expected);
          const coverage = mutant.coverage.map(({ coverage }) => coverage);
          const temporal = evidenceOf(mutant);
          if (
            coverage.find((item) => item.check === operator.check)?.status ===
            "unavailable"
          )
            throw new Error("Expected check has unavailable evidence");
          if (
            operator.probe &&
            !temporal.some((item) => item.probe?.results.length)
          )
            throw new Error("Missing real probe evidence");
          if (
            operator.capability === "load" &&
            !temporal.some((item) =>
              item.actions.some((action) => action.source === "load"),
            )
          )
            throw new Error("Missing real load timeline");
          if (
            operator.capability === "loading" &&
            !temporal.some(
              (item) =>
                item.probe?.heldReplay?.ran &&
                item.actions.some(
                  (action) =>
                    action.source === "slow-replay" &&
                    action.held?.requests.some(
                      (request) => request.path === "/api/items",
                    ),
                ),
            )
          )
            throw new Error("Missing held-response replay evidence");
          if (
            operator.capability === "motion" &&
            !temporal.some((item) =>
              item.actions.some(
                (action) =>
                  action.confirmation === true &&
                  action.reducedMotion === false &&
                  (action.visibleChanges?.length ?? 0) > 0,
              ),
            )
          )
            throw new Error("Missing normal-motion confirmation evidence");
          cases.push({
            ...base,
            ...verdict,
            expected,
            status: "evaluated",
            diagnostic: verdict.caught
              ? "Exact seeded identity reported"
              : `Expected identity absent; ${coverage.find((item) => item.check === operator.check)?.status ?? "unavailable"} check`,
            coverage,
            candidates: mutant.entries
              .filter(({ candidate }) => candidate.category === operator.check)
              .map(({ candidate }) => ({
                rule: candidate.rule,
                selector: candidate.selectorHint,
                fingerprintHint: candidate.fingerprintHint ?? null,
                params: candidate.verification.params ?? {},
              })),
            evidence: temporal,
            mutation: {
              pure: mutant.audits.every((item) => item.pure),
              applications: mutant.audits.length,
              changed: mutant.audits.some((item) => item.before !== item.after),
            },
          });
        } catch (error) {
          cases.push({
            ...base,
            ...(expected ? { expected } : {}),
            status: "error",
            diagnostic: String(error),
          });
        }
      }
    }
  } finally {
    await browser.close();
  }
  for (const id of options.caseIds ?? [])
    if (!cases.some((item) => item.id === id))
      cases.push({
        id,
        operator: id.split("::")[0] ?? "unknown",
        page: id.split("::")[1] ?? "unknown",
        rule:
          operators.find((operator) => id.startsWith(`${operator.id}::`))
            ?.rule ?? "unknown",
        status: "error",
        caught: false,
        rank: null,
        expectedFindings: [],
        findingCount: 0,
        otherFindings: 0,
        diagnostic: "Requested case was unknown or inapplicable",
      });
  const changedSources = await Promise.all(
    Object.entries(sourceHashes).map(async ([page, original]) =>
      hash(await readFile(join(options.root, page), "utf8")) === original
        ? []
        : [page],
    ),
  );
  if (changedSources.flat().length)
    throw new Error(
      `Fixture sources changed: ${changedSources.flat().join(", ")}`,
    );
  let revision = "unknown";
  try {
    revision = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: options.root,
      encoding: "utf8",
    }).trim();
  } catch {
    /* Source archive without Git. */
  }
  const catalogErrors = options.caseIds
    ? []
    : operators
        .filter(
          (operator) => !cases.some((item) => item.operator === operator.id),
        )
        .map((operator) => `Operator has no applicable case: ${operator.id}`);
  cases.sort((a, b) => a.id.localeCompare(b.id));
  return {
    version: 1,
    scope: options.caseIds ? "selection" : "full-catalog",
    status:
      catalogErrors.length || cases.some((item) => item.status === "error")
        ? "incomplete"
        : "complete",
    source: {
      revision,
      toolVersion: JSON.parse(
        await readFile(join(options.root, "package.json"), "utf8"),
      ).version as string,
      harnessHash: hash(
        await readFile(join(options.root, "test/mutation-support.ts"), "utf8"),
      ),
      operatorHashes: Object.fromEntries(
        operators.map((operator) => [
          operator.id,
          hash(JSON.stringify(operator)),
        ]),
      ),
      chromium: chromiumVersion,
      fixtureHashes: sourceHashes,
      catalogHash: hash(
        await readFile(
          join(options.root, "test/fixtures/mutations/catalog.ts"),
          "utf8",
        ),
      ),
      chromeCssHash: hash(
        await readFile(
          join(options.root, "test/fixtures/benchmark/chrome.css"),
          "utf8",
        ),
      ),
    },
    profiles,
    cases,
    catalogErrors,
    skipped: skipped.sort((a, b) => a.id.localeCompare(b.id)),
    ...summarize(cases),
    isolation,
    elapsedMs: performance.now() - started,
  };
}

export type MutationReport = Awaited<ReturnType<typeof runMutationBench>>;

export type RecallBaseline = {
  caseIds: string[];
  membership: Record<string, string>;
  caughtCaseIds: string[];
  overall: { attempted: number; caught: number; recall: number | null };
  perRule: Record<
    string,
    { attempted: number; caught: number; recall: number | null }
  >;
};
export function assertBaseline(
  cases: CaseResult[],
  baseline: RecallBaseline,
): void {
  if (
    JSON.stringify(cases.map((item) => item.id).sort()) !==
    JSON.stringify([...baseline.caseIds].sort())
  )
    throw new Error("CI case selection changed");
  for (const item of cases)
    if (
      item.status !== "evaluated" ||
      baseline.membership[item.id] !== item.rule
    )
      throw new Error(`Invalid case or rule membership: ${item.id}`);
  const summary = summarize(cases);
  if (
    JSON.stringify(Object.keys(summary.perRule).sort()) !==
    JSON.stringify(Object.keys(baseline.perRule).sort())
  )
    throw new Error("CI rule selection changed");
  for (const [rule, recorded] of Object.entries({
    ...baseline.perRule,
    overall: baseline.overall,
  })) {
    const current =
      rule === "overall" ? summary.overall : summary.perRule[rule];
    if (
      !current ||
      current.attempted !== recorded.attempted ||
      (current.recall ?? -1) < (recorded.recall ?? -1)
    )
      throw new Error(`Recall regression for ${rule}`);
  }
  for (const id of baseline.caughtCaseIds)
    if (!cases.find((item) => item.id === id)?.caught)
      throw new Error(`Previously caught seed missed: ${id}`);
}

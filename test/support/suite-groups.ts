import { configDefaults } from "vitest/config";

export const suiteNames = { unit: "unit", heavy: "heavy" } as const;
export const suiteInclude = [...configDefaults.include];
export const suiteExclude = [...configDefaults.exclude, "**/.autobuild/**"];

/**
 * Files that start Chromium, a built CLI, a fixture server or a child Idiom
 * process share this many forks. Almost all of the suite's time is in them,
 * so two forks on a large machine left most cores idle; more than four
 * oversubscribes a host that runs two gates at once. A small host (four
 * cores or fewer) keeps the original two.
 */
export function heavyForks(cores: number): number {
  return Math.max(2, Math.min(4, Math.floor(cores / 2)));
}

// Admission is deliberate: every unknown file runs in the bounded heavy pool.
// The dependency guard checks this reviewed list, including indirect launch seams.
export const unitFiles = [
  "test/acceptance.test.ts",
  "test/authored-rule-index.test.ts",
  "test/autobuild-wiring.test.ts",
  "test/band-edge-wordbreak.test.ts",
  "test/brief-ask.test.ts",
  "test/dismissal-unit.test.ts",
  "test/brief-eval.test.ts",
  "test/brief-gate.test.ts",
  "test/brief-mismatch.test.ts",
  "test/brief-model.test.ts",
  "test/brief-plan.test.ts",
  "test/brief-research-model.test.ts",
  "test/brief-research.test.ts",
  "test/brief-rubric.test.ts",
  "test/brief-schema.test.ts",
  "test/brief-store.test.ts",
  "test/brief-triage.test.ts",
  "test/capture-deadline.test.ts",
  "test/capture-process-host.test.ts",
  "test/check-timing.test.ts",
  "test/console-findings.test.ts",
  "test/checks.test.ts",
  "test/claude-code-sessions.test.ts",
  "test/collection-actions-unit.test.ts",
  "test/craft-rules-unit.test.ts",
  "test/critique-codex.test.ts",
  "test/critique-provider.test.ts",
  "test/critique-redaction.test.ts",
  "test/critique.test.ts",
  "test/design-components.test.ts",
  "test/design-image-diff.test.ts",
  "test/deterministic-bound.test.ts",
  "test/digest.test.ts",
  "test/disabled-highlight-unit.test.ts",
  "test/disclosure-coverage.test.ts",
  "test/disguised-fresh.test.ts",
  "test/document.test.ts",
  "test/duplicate-entry-menu-unit.test.ts",
  "test/empty-container-coverage.test.ts",
  "test/exploration-content.test.ts",
  "test/exploration-provider.test.ts",
  "test/exploration-schema.test.ts",
  "test/exploration-session.test.ts",
  "test/exploration-validate.test.ts",
  "test/failure-unit.test.ts",
  "test/frame-ornament-unit.test.ts",
  "test/field-test.test.ts",
  "test/figma-client.test.ts",
  "test/figma-normalize.test.ts",
  "test/figma-url.test.ts",
  "test/fixture-server-usage.test.ts",
  "test/gate-estimate.test.ts",
  "test/gate-server.test.ts",
  "test/gate-trim.test.ts",
  "test/github-action-presentation.test.ts",
  "test/group-invariants.test.ts",
  "test/hosted-api.test.ts",
  "test/hosted-ledger.test.ts",
  "test/hosted-reports.test.ts",
  "test/hosted-sandbox.test.ts",
  "test/hosted-ssrf.test.ts",
  "test/interaction-shift.test.ts",
  "test/issues.test.ts",
  "test/layout-invariants.test.ts",
  "test/learn-interpret.test.ts",
  "test/loading-unit.test.ts",
  "test/luminance-unit.test.ts",
  "test/media-fill-unit.test.ts",
  "test/mirrored-control.test.ts",
  "test/model-evaluation.test.ts",
  "test/motion-snap.test.ts",
  "test/motion.test.ts",
  "test/navigation-semantics-unit.test.ts",
  "test/nested-border-unit.test.ts",
  "test/orphan-ink.test.ts",
  "test/overlap-clipped.test.ts",
  "test/page-content.test.ts",
  "test/page-critique.test.ts",
  "test/parent-selection-unit.test.ts",
  "test/probe-budget.test.ts",
  "test/probe-ledger.test.ts",
  "test/probe-merge.test.ts",
  "test/probe-network-attribution.test.ts",
  "test/probe-safety.test.ts",
  "test/published-budget.test.ts",
  "test/quick-interaction.test.ts",
  "test/ranking.test.ts",
  "test/reference-bound.test.ts",
  "test/replay-ledger.test.ts",
  "test/request-policy.test.ts",
  "test/revealed-checks.test.ts",
  "test/review-crops.test.ts",
  "test/review-decisions.test.ts",
  "test/root-causes.test.ts",
  "test/rules-doc.test.ts",
  "test/run-record.test.ts",
  "test/scale-anatomy-unit.test.ts",
  "test/scale-clusters.test.ts",
  "test/schemas-doc.test.ts",
  "test/schemas.test.ts",
  "test/selection-dialog-unit.test.ts",
  "test/selection-outline-unit.test.ts",
  "test/self-update.test.ts",
  "test/server-diagnosis.test.ts",
  "test/setup-agents.test.ts",
  "test/setup-prompt.test.ts",
  "test/shell-visibility-unit.test.ts",
  "test/stability-doc.test.ts",
  "test/states-unit.test.ts",
  "test/structural-unit.test.ts",
  "test/subscription-environment.test.ts",
  "test/suite-groups.test.ts",
  "test/sweep-geometry.test.ts",
  "test/sweep-group.test.ts",
  "test/target-size-defaults.test.ts",
  "test/target-size-exemptions.test.ts",
  "test/timeline.test.ts",
  "test/touch-liveness-unit.test.ts",
  "test/version.test.ts",
  "test/visible-explanations-unit.test.ts",
] as const;

export function suiteFor(file: string): "unit" | "heavy" {
  return (unitFiles as readonly string[]).includes(file)
    ? suiteNames.unit
    : suiteNames.heavy;
}

// Only these reviewed files replace the indicated production process boundary.
// Direct child_process/browser/fixture-server imports are never exempted.
export const injectedResources: Array<{
  test: string;
  file: string;
  resource: string;
  reason: string;
}> = [
  {
    test: "test/brief-model.test.ts",
    file: "src/critique/process.ts",
    resource: "node:child_process",
    reason:
      "Every process runner exercised by this adapter suite is injected; real runner tests remain heavy.",
  },
  {
    test: "test/brief-research-model.test.ts",
    file: "src/critique/process.ts",
    resource: "node:child_process",
    reason:
      "Every process runner exercised by this adapter suite is injected; real runner tests remain heavy.",
  },
  {
    test: "test/capture-process-host.test.ts",
    file: "src/capture/process.ts",
    resource: "node:child_process",
    reason:
      "Fake child with no PID, injected spawn/fetch and mocked TCP boundary; no server is registered.",
  },
  {
    test: "test/capture-process-host.test.ts",
    file: "src/capture/server-registry.ts",
    resource: "node:child_process",
    reason:
      "Fake child with no PID, injected spawn/fetch and mocked TCP boundary; no server is registered.",
  },
  {
    test: "test/digest.test.ts",
    file: "src/capture/server-registry.ts",
    resource: "node:child_process",
    reason:
      "Run listing inspects an owner process only for a running record; these fixtures write none.",
  },
  {
    test: "test/gate-estimate.test.ts",
    file: "src/capture/server-registry.ts",
    resource: "node:child_process",
    reason:
      "Run listing inspects an owner process only for a running record; these fixtures write none.",
  },
  {
    test: "test/run-record.test.ts",
    file: "src/capture/server-registry.ts",
    resource: "node:child_process",
    reason:
      "Run listing inspects an owner process only for a running record; these fixtures write none.",
  },
  {
    test: "test/critique-codex.test.ts",
    file: "src/critique/process.ts",
    resource: "node:child_process",
    reason:
      "Every process runner exercised by this adapter suite is injected; real runner tests remain heavy.",
  },
  {
    test: "test/critique-provider.test.ts",
    file: "src/critique/process.ts",
    resource: "node:child_process",
    reason:
      "Every process runner exercised by this adapter suite is injected; real runner tests remain heavy.",
  },
  {
    test: "test/critique-redaction.test.ts",
    file: "src/critique/process.ts",
    resource: "node:child_process",
    reason:
      "Every process runner exercised by this adapter suite is injected; real runner tests remain heavy.",
  },
  {
    test: "test/critique.test.ts",
    file: "src/critique/process.ts",
    resource: "node:child_process",
    reason:
      "Every process runner exercised by this adapter suite is injected; real runner tests remain heavy.",
  },
  {
    test: "test/exploration-provider.test.ts",
    file: "src/critique/process.ts",
    resource: "node:child_process",
    reason:
      "Every process runner exercised by this adapter suite is injected; real runner tests remain heavy.",
  },
  {
    test: "test/self-update.test.ts",
    file: "src/update/self-update.ts",
    resource: "node:child_process",
    reason:
      "Registry fetch and every command runner are injected; no package manager or restart is executed.",
  },
  {
    test: "test/setup-agents.test.ts",
    file: "src/critique/process.ts",
    resource: "node:child_process",
    reason:
      "Every process runner exercised by this adapter suite is injected; real runner tests remain heavy.",
  },
];

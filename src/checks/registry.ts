import { defaultChecksSettings } from "../schemas/project.js";
import { a11yLabelCheck } from "./a11y-label.js";
import { adjacentGapCheck } from "./adjacent-gap.js";
import { alarmAtRestCheck } from "./alarm-at-rest.js";
import { bandEdgesCheck } from "./band-edges.js";
import { brokenImageCheck } from "./broken-image.js";
import { brokenLinkCheck } from "./broken-link.js";
import { clippedTextCheck } from "./clipped-text.js";
import { collectionActionsCheck } from "./collection-actions.js";
import { componentSizeCheck } from "./component-size.js";
import { compoundControlCheck } from "./compound-control.js";
import { consoleErrorCheck } from "./console-error.js";
import { contrastCheck } from "./contrast.js";
import { controlAnatomyCheck } from "./control-anatomy.js";
import { copyLintCheck } from "./copy-lint.js";
import { crossSurfaceNamingCheck } from "./cross-surface-naming.js";
import { deadAffordanceCheck } from "./dead-affordance.js";
import { deadControlCheck } from "./dead-control.js";
import { designDriftCheck } from "./design-drift.js";
import { dialogShellCheck } from "./dialog-shell.js";
import { disguisedControlCheck } from "./disguised-control.js";
import { duplicateEntryCheck } from "./duplicate-entry.js";
import { elementOverlapCheck } from "./element-overlap.js";
import { emptyStateCheck } from "./empty-state.js";
import { errorTextCheck } from "./error-text.js";
import { fieldGroupCheck } from "./field-group.js";
import { focusVisibleCheck } from "./focus-visible.js";
import { fontLoadingCheck } from "./font-loading.js";
import { frameCheck } from "./frame.js";
import { freshStateCheck } from "./fresh-state.js";
import { glyphIconCheck } from "./glyph-icon.js";
import { groupInvariantsCheck } from "./group-invariants.js";
import { headingStructureCheck } from "./heading-structure.js";
import { imageDistortionCheck } from "./image-distortion.js";
import { interactionShiftCheck } from "./interaction-shift.js";
import { layoutInvariantsCheck } from "./layout-invariants.js";
import { layoutShiftCheck } from "./layout-shift.js";
import { lineLengthCheck } from "./line-length.js";
import { livenessCheck } from "./liveness.js";
import {
  doubleSubmitCheck,
  loadingStateMissingCheck,
} from "./loading-state.js";
import { luminanceParityCheck } from "./luminance-parity.js";
import { mediaFillCheck } from "./media-fill.js";
import { mirroredControlCheck } from "./mirrored-control.js";
import {
  missingColorSchemeCandidates,
  missingStateCheck,
} from "./missing-state.js";
import { motionCheck } from "./motion.js";
import { nativeControlCheck } from "./native-control.js";
import { orphanWordCheck } from "./orphan-word.js";
import { overflowClipCheck } from "./overflow-clip.js";
import { pageContentCheck } from "./page-content.js";
import { primaryRegionCheck } from "./primary-region.js";
import { progressAffordanceCheck } from "./progress-affordance.js";
import { publishedBudgetCheck } from "./published-budget.js";
import { responsiveBreakCheck } from "./responsive-break.js";
import { scaleConformanceCheck } from "./scale-conformance.js";
import { selectedStateCheck } from "./selected-state.js";
import { shellVisibilityCheck } from "./shell-visibility.js";
import { siblingChromeCheck } from "./sibling-chrome.js";
import { spacingRhythmCheck } from "./spacing-rhythm.js";
import { targetSizeCheck } from "./target-size.js";
import { textCenteringCheck } from "./text-centering.js";
import { tokenDriftCheck } from "./token-drift.js";
import { touchReachabilityCheck } from "./touch-reachability.js";
import type {
  CheckCoverage,
  ChecksConfig,
  CheckTuple,
  DeterministicCheck,
  FindingCandidate,
} from "./types.js";
import { deterministicCheckIds } from "./types.js";
import { unexplainedControlCheck } from "./unexplained-control.js";
import { wordBreakCheck } from "./word-break.js";

export const deterministicChecks: DeterministicCheck[] = [
  overflowClipCheck,
  responsiveBreakCheck,
  contrastCheck,
  a11yLabelCheck,
  targetSizeCheck,
  headingStructureCheck,
  tokenDriftCheck,
  consoleErrorCheck,
  missingStateCheck,
];

/**
 * Checks added in 0.3 run after the original ten so existing finding order
 * (and therefore existing finding names) is unchanged for prior captures.
 */
export const signalChecks: DeterministicCheck[] = [
  unexplainedControlCheck,
  textCenteringCheck,
  adjacentGapCheck,
  deadAffordanceCheck,
  deadControlCheck,
  duplicateEntryCheck,
  componentSizeCheck,
  copyLintCheck,
  glyphIconCheck,
  errorTextCheck,
  nativeControlCheck,
  layoutInvariantsCheck,
  groupInvariantsCheck,
  selectedStateCheck,
  dialogShellCheck,
  disguisedControlCheck,
  freshStateCheck,
  mirroredControlCheck,
  motionCheck,
  elementOverlapCheck,
  clippedTextCheck,
  fieldGroupCheck,
  scaleConformanceCheck,
  controlAnatomyCheck,
  luminanceParityCheck,
  frameCheck,
  primaryRegionCheck,
  alarmAtRestCheck,
  crossSurfaceNamingCheck,
  publishedBudgetCheck,
  emptyStateCheck,
  progressAffordanceCheck,
  pageContentCheck,
  bandEdgesCheck,
  wordBreakCheck,
  shellVisibilityCheck,
  compoundControlCheck,
  siblingChromeCheck,
  touchReachabilityCheck,
  livenessCheck,
  mediaFillCheck,
  collectionActionsCheck,
  fontLoadingCheck,
  brokenLinkCheck,
  focusVisibleCheck,
  lineLengthCheck,
  orphanWordCheck,
  imageDistortionCheck,
  brokenImageCheck,
  layoutShiftCheck,
  interactionShiftCheck,
  designDriftCheck,
  loadingStateMissingCheck,
  doubleSubmitCheck,
];

export function checksConfigFrom(
  settings: Partial<typeof defaultChecksSettings> = defaultChecksSettings,
): ChecksConfig {
  const merged = { ...defaultChecksSettings, ...settings };
  return {
    fonts: { ...merged.fonts },
    links: { ...merged.links, ignore: [...merged.links.ignore] },
    focusVisible: {
      enabled: merged.focusVisible.enabled,
      ignore: [...merged.focusVisible.ignore],
    },
    lineLength: { ...merged.lineLength },
    orphanWord: { ...merged.orphanWord },
    images: { ...merged.images },
    layoutShift: { ...merged.layoutShift },
    interactionShift: { ...merged.interactionShift },
    designDrift: merged.designDrift,
    shellVisibility: merged.shellVisibility,
    ...(merged.compoundControls === undefined
      ? {}
      : { compoundControls: { ...merged.compoundControls } }),
    siblingChrome: { regions: [...merged.siblingChrome.regions] },
    touchReachability: merged.touchReachability,
    liveness: merged.liveness,
    mediaFill: {
      auto: merged.mediaFill.auto,
      bandThreshold: merged.mediaFill.bandThreshold,
      tolerance: merged.mediaFill.tolerance,
      ignore: [...merged.mediaFill.ignore],
    },
    collections: merged.collections.map(({ selector, name, actions }) => ({
      selector,
      ...(name === undefined ? {} : { name }),
      actions: [...actions],
    })),
    explanation: merged.explanation,
    ...(merged.bandEdges === undefined
      ? {}
      : { bandEdges: { ...merged.bandEdges } }),
    ...(merged.wordBreak === undefined
      ? {}
      : { wordBreak: { ...merged.wordBreak } }),
    motion: merged.motion,
    luminanceParity: merged.luminanceParity,
    frame: merged.frame,
    minGap: merged.minGap,
    adjacentGap: { indicatorMax: merged.adjacentGap.indicatorMax },
    centeringTolerance: merged.centeringTolerance,
    copy: merged.copy,
    glyphAllow: merged.glyphAllow,
    errorPatterns: merged.errorPatterns,
    selectedState: merged.selectedState,
    disguisedControl: {
      placeholderPatterns: merged.disguisedControl.placeholderPatterns,
    },
    freshState: {
      historyNames: merged.freshState.historyNames,
      unsavedPatterns: merged.freshState.unsavedPatterns,
    },
    mirrored: merged.mirrored.map(({ name, a, b, axis }) => ({
      name,
      a,
      b,
      axis,
    })),
    fieldGroups: {
      inner: merged.fieldGroups.inner,
      between: merged.fieldGroups.between,
    },
    scales: {
      spacing: [...merged.scales.spacing],
      controlHeights: [...merged.scales.controlHeights],
      radius: {
        control: [...merged.scales.radius.control],
        card: [...merged.scales.radius.card],
        panel: [...merged.scales.radius.panel],
        chip: [...merged.scales.radius.chip],
      },
      border: {
        divider: [...merged.scales.border.divider],
        control: [...merged.scales.border.control],
      },
      roles: {
        control: [...merged.scales.roles.control],
        card: [...merged.scales.roles.card],
        panel: [...merged.scales.roles.panel],
        chip: [...merged.scales.roles.chip],
        divider: [...merged.scales.roles.divider],
      },
    },
    ...(merged.targetSize === undefined
      ? {}
      : { targetSize: { ...merged.targetSize } }),
    ...(merged.primaryRegion === undefined
      ? {}
      : {
          primaryRegion: {
            selector: merged.primaryRegion.selector,
            minShare:
              typeof merged.primaryRegion.minShare === "number"
                ? merged.primaryRegion.minShare
                : { ...merged.primaryRegion.minShare },
          },
        }),
    alarm: {
      colors: [...merged.alarm.colors],
      brand: [...merged.alarm.brand],
    },
    naming: { surfaces: { ...merged.naming.surfaces } },
    progressWithinMs: merged.progressWithinMs,
    loading: { delayMs: merged.loading.delayMs },
    emptyState: {
      regions: merged.emptyState.regions.map(({ selector, items }) => ({
        selector,
        items,
      })),
      auto: merged.emptyState.auto,
      ignore: [...merged.emptyState.ignore],
    },
    ...(merged.page === undefined
      ? {}
      : {
          page: {
            ctaSelectors: [...merged.page.ctaSelectors],
            placeholderPatterns: [...merged.page.placeholderPatterns],
            claimsAllow: [...merged.page.claimsAllow],
          },
        }),
  };
}

export function minimumCapturedWidth(tuples: CheckTuple[]): number | undefined {
  return tuples.length === 0
    ? undefined
    : Math.min(...tuples.map((tuple) => tuple.width));
}

export function runDeterministicChecks(
  tuples: CheckTuple[],
  expectedTupleKeys?: readonly string[],
  config: ChecksConfig = checksConfigFrom(),
): {
  candidates: Array<{
    tuple: CheckTuple;
    candidate: FindingCandidate;
    checkOrder: number;
  }>;
  coverage: Array<{ tuple: CheckTuple; coverage: CheckCoverage }>;
  captureCoverage: CheckCoverage[];
  narrowWidth?: number | undefined;
} {
  const narrowWidth = minimumCapturedWidth(tuples);
  const captureCoverage =
    tuples.length === 0
      ? deterministicCheckIds.map((check) => ({
          check,
          status: "unavailable" as const,
          reason: "the capture has no viewport tuples",
        }))
      : [];
  const candidates = [];
  const coverage = [];
  for (const tuple of tuples) {
    for (const [checkOrder, check] of deterministicChecks.entries()) {
      const result = check.run({
        tuple,
        narrowViewport: tuple.width === narrowWidth,
        config,
        tuples,
      });
      coverage.push({ tuple, coverage: result.coverage });
      candidates.push(
        ...result.candidates.map((candidate) => ({
          tuple,
          candidate,
          checkOrder,
        })),
      );
    }
  }
  const spacing = spacingRhythmCheck.run(tuples);
  coverage.push(...spacing.coverage);
  candidates.push(
    ...spacing.candidates.map(({ tuple, candidate }) => ({
      tuple,
      candidate,
      checkOrder: deterministicChecks.length,
    })),
  );
  candidates.push(...missingColorSchemeCandidates(tuples, expectedTupleKeys));
  for (const tuple of tuples) {
    for (const [order, check] of signalChecks.entries()) {
      const result = check.run({
        tuple,
        narrowViewport: tuple.width === narrowWidth,
        config,
        tuples,
      });
      coverage.push({ tuple, coverage: result.coverage });
      candidates.push(
        ...result.candidates.map((candidate) => ({
          tuple,
          candidate,
          checkOrder: deterministicChecks.length + 1 + order,
        })),
      );
    }
  }
  return {
    candidates,
    coverage,
    captureCoverage,
    ...(narrowWidth === undefined ? {} : { narrowWidth }),
  };
}

import type { Page } from "playwright";
import {
  type ObserveOptions,
  observePage,
  type TokenDeclarations,
} from "../checks/observe.js";
import type { ObservationArtifact } from "../checks/types.js";
import { DEFAULT_MAX_REVEALED, type ProbeOptions } from "./probe.js";

/**
 * The probe's revealed-state observer: a lean observation of the page as the
 * disclosure left it. Only what the revealed-state checks read is recorded
 * (geometry, gaps, overlaps, native controls); liveness, design comparison,
 * images, links and declared regions stay with the state's own observation.
 */
export function revealedObserver(options: {
  tokens: TokenDeclarations;
  masks?: string[] | undefined;
  marks?: ObserveOptions["marks"];
}): (
  page: Page,
  revealed: { root?: string | undefined; trigger: string },
) => Promise<ObservationArtifact> {
  return (page, revealed) =>
    observePage(page, options.tokens, undefined, options.masks ?? [], {
      ...(options.marks === undefined ? {} : { marks: options.marks }),
      revealedRoot: revealed.root,
      revealedTrigger: revealed.trigger,
    });
}

/** Probe options for revealed states from `checks.probe` settings. */
export function revealedProbeOptions(
  settings: {
    disclosures?: boolean | undefined;
    maxRevealed?: number | undefined;
  },
  observer: ReturnType<typeof revealedObserver>,
): Pick<ProbeOptions, "observeRevealed" | "maxRevealed"> {
  if (settings.disclosures === false) return {};
  return {
    observeRevealed: observer,
    maxRevealed: settings.maxRevealed ?? DEFAULT_MAX_REVEALED,
  };
}

/**
 * Probe options for the dismissal pass: on with disclosures
 * (`checks.probe.disclosures`), exempting the flow's `explicitDismiss`.
 */
export function dismissalProbeOptions(
  settings: { disclosures?: boolean | undefined },
  explicit?: string[] | undefined,
): Pick<ProbeOptions, "dismissal"> {
  if (settings.disclosures === false) return {};
  return { dismissal: { explicit: explicit ?? [] } };
}

import type { PNG } from "pngjs";
import type { ScaleCluster } from "../checks/scale-clusters.js";
import type { CheckTuple } from "../checks/types.js";
import type { AggregatedDecision } from "../rulings/aggregate.js";
import type {
  RulingCoordinate,
  ScaleClusterDecision,
  UnruledDecision,
} from "../schemas/ruling.js";
import { cropToFile, screenshotPlacement } from "./crops.js";

/** The screenshot label decisions cite: `state/viewport[/scheme]`. */
function screenshotLabel(tuple: CheckTuple): string {
  return tuple.colorSchemeAxis
    ? `${tuple.state}/${tuple.viewport}/${tuple.colorScheme}`
    : `${tuple.state}/${tuple.viewport}`;
}

function coordinate(tuple: CheckTuple): RulingCoordinate {
  return {
    state: tuple.state,
    viewport: tuple.viewport,
    ...(tuple.colorScheme === undefined
      ? {}
      : { colorScheme: tuple.colorScheme }),
    screenshot: screenshotLabel(tuple),
  };
}

const PADDING = 12;

/**
 * Turn the run's unanswered scale clusters into unruled decisions, each with
 * a padded crop of up to three representative occurrences. A crop that
 * cannot be cut (no screenshot, legacy geometry) is omitted, never fatal.
 */
export async function scaleQuestionDecisions(options: {
  runDirectory: string;
  clusters: ScaleCluster[];
  resolvedFingerprints: ReadonlySet<string>;
}): Promise<AggregatedDecision[]> {
  const images = new Map<string, PNG | undefined>();
  const decisions: AggregatedDecision[] = [];
  for (const cluster of [...options.clusters].sort(
    (left, right) =>
      right.count - left.count || left.choiceKey.localeCompare(right.choiceKey),
  )) {
    if (options.resolvedFingerprints.has(cluster.fingerprint)) continue;
    const coordinates = new Map<string, RulingCoordinate>();
    for (const { tuple } of cluster.occurrences) {
      const item = coordinate(tuple);
      coordinates.set(
        `${item.state}\0${item.viewport}\0${item.colorScheme ?? ""}\0${item.screenshot}`,
        item,
      );
    }
    const examples: ScaleClusterDecision["examples"] = [];
    for (const [index, example] of cluster.examples.entries()) {
      const { tuple, element } = example;
      const observations = tuple.observations;
      let crop: string | undefined;
      if (tuple.screenshotPath !== undefined && observations !== undefined) {
        const placement = screenshotPlacement(observations);
        const relativePath = `crops/scale-question-${cluster.fingerprint.slice(0, 8)}-${index + 1}.png`;
        try {
          if (
            await cropToFile({
              runDirectory: options.runDirectory,
              screenshotPath: tuple.screenshotPath,
              images,
              viewportWidth: tuple.width,
              ...(observations.version === 2
                ? {
                    viewport: {
                      ...observations.viewport,
                      documentWidth: observations.document.scrollWidth,
                    },
                  }
                : {}),
              scale: placement.scale,
              rect: placement.rect(element),
              padding: PADDING,
              relativePath,
            })
          )
            crop = relativePath;
        } catch {
          crop = undefined;
        }
      }
      examples.push({
        state: tuple.state,
        viewport: tuple.viewport,
        ...(tuple.colorScheme === undefined
          ? {}
          : { colorScheme: tuple.colorScheme }),
        screenshot: screenshotLabel(tuple),
        selector: element.selector,
        ...(crop === undefined ? {} : { crop }),
      });
    }
    decisions.push({
      fingerprint: cluster.fingerprint,
      choiceKey: cluster.choiceKey,
      question: cluster.question,
      nearestLawExcerpt: `${cluster.scaleSource}: [${cluster.nearestSteps.steps.join(", ")}]`,
      occurrences: [...coordinates.values()].sort(
        (left, right) =>
          left.state.localeCompare(right.state) ||
          left.viewport.localeCompare(right.viewport) ||
          (left.colorScheme ?? "").localeCompare(right.colorScheme ?? "") ||
          left.screenshot.localeCompare(right.screenshot),
      ),
      candidates: [],
      scaleCluster: {
        property: cluster.property,
        value: cluster.value,
        count: cluster.count,
        distinctStates: cluster.distinctStates,
        distinctElements: cluster.distinctElements,
        context: cluster.context,
        componentLabel: cluster.componentLabel,
        nearestSteps: cluster.nearestSteps,
        suggestedToken: cluster.suggestedToken,
        examples,
      },
    });
  }
  return decisions;
}

export function isScaleQuestion(decision: UnruledDecision): boolean {
  return decision.scaleCluster !== undefined;
}

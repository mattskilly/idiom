import {
  animatedKeys,
  isSnapCandidate,
  snapCandidateKeys,
} from "./motion-snap.js";
import { timelineEvidence, unavailable, verify } from "./shared.js";
import { linkRecording, recordingKey } from "./temporal-evidence.js";
import type {
  ActionTimeline,
  ChecksConfig,
  CheckTuple,
  DeterministicCheck,
  FindingCandidate,
  MotionArtifact,
  VisibleChange,
} from "./types.js";

type Acceptance = "snap" | "reduced" | "duration";
const acceptances: Record<Acceptance, string> = {
  snap: "Animate the surface's open/close with a transition within checks.motion duration policy.",
  reduced:
    "Disable geometric and opacity motion when prefers-reduced-motion is reduce.",
  duration:
    "Animate chrome state changes within checks.motion duration policy and honor reduced motion.",
};

/** Pure policy over persisted action windows; declarations alone are never evidence. */
export const motionCheck: DeterministicCheck = {
  id: "motion",
  run({ tuple, config }) {
    const observation = tuple.observations;
    const recorded =
      observation?.version === 2 ? observation.motion : undefined;
    const motion =
      recorded?.version === 1 && recorded.status !== "unavailable"
        ? recorded
        : undefined;
    const timeline = timelineEvidence(tuple);
    const snaps =
      timeline.status === "ran"
        ? contentSnaps(tuple, timeline.timelines.actions, config, recorded)
        : undefined;
    if (!motion && !snaps?.supported)
      return unavailable(
        this.id,
        recorded?.reason ??
          "temporal motion evidence unavailable; recapture with the interaction probe or declared web steps",
      );
    const candidates: FindingCandidate[] = [];
    const seen = new Set<string>();
    const notes = new Set<string>(motion?.reason ? [motion.reason] : []);
    let supported =
      !!snaps?.supported ||
      (motion?.actions.length === 0 && motion.status === "ran");
    for (const action of motion?.actions ?? []) {
      if (action.reason) notes.add(action.reason);
      if (action.status === "unavailable") continue;
      supported = true;
      for (const change of action.changes) {
        if (change.reason) notes.add(change.reason);
        const surface = change.ownerName || change.name || change.tag;
        const identity = `${change.ownerSelector}|${change.direction}`;
        // Probe paths may be structurally selected, while static observations use IDs.
        // Prefer a surface/control still present in the captured state for crops.
        const visible = observation?.elements.filter((e) => e.visible) ?? [];
        const target =
          visible.find((e) => e.selector === change.ownerSelector) ??
          visible.find(
            (e) =>
              e.selector === action.selector ||
              ("structuralPath" in e && e.structuralPath === action.selector),
          );
        const selectorHint =
          target?.selector ??
          (action.source === "web-step"
            ? action.selector
            : change.ownerSelector);
        const emit = (
          rule: string,
          explanation: string,
          effect: string,
          params: Record<string, unknown>,
          acceptance: Acceptance,
        ) => {
          const major = acceptance !== "duration";
          const key = `${identity}|${rule}|${effect}`;
          if (seen.has(key)) return;
          seen.add(key);
          candidates.push(
            linkRecording(
              {
                category: "motion",
                ...(action.timelineId ? { timeline: action.timelineId } : {}),
                severity: major ? "major" : "minor",
                rule,
                selectorHint,
                fingerprintHint: key,
                explanation,
                acceptance: [acceptances[acceptance]],
                verification: verify("motion", {
                  surface: change.ownerSelector,
                  action: action.name,
                  actionSelector: action.selector,
                  source: action.source,
                  ...(action.stepIndex ? { stepIndex: action.stepIndex } : {}),
                  direction: change.direction,
                  ...params,
                }),
              },
              recordingKey(action),
            ),
          );
        };
        if (
          !motion?.reducedMotion &&
          action.status === "ran" &&
          change.surface &&
          change.toggled &&
          change.animated === false
        )
          emit(
            "idiom:motion-no-transition",
            `${surface} ${change.direction}: no transition (${action.name})`,
            "",
            { animated: false },
            "snap",
          );
        if (
          motion?.reducedMotion &&
          change.animated === true &&
          change.selector === change.ownerSelector &&
          change.reason?.startsWith("progressive geometry/opacity")
        )
          emit(
            "idiom:motion-reduced",
            `${surface} geometry/opacity motion runs with prefers-reduced-motion: reduce; duration unavailable (${action.name})`,
            "sampled",
            { animated: true, durationAssessment: "unavailable" },
            "reduced",
          );
        for (const effect of change.effects) {
          if (
            !effect.started ||
            (effect.timing === "finite" && (effect.durationMs ?? 0) <= 0)
          )
            continue;
          const effectKey = `${change.selector}|${effect.kind}|${effect.property}|${effect.name}`;
          const duration =
            effect.timing === "infinite"
              ? "infinite"
              : effect.durationMs === null
                ? undefined
                : `${Math.round(effect.durationMs * 1000) / 1000}ms`;
          const violations: string[] = [];
          if (
            effect.timing === "infinite" ||
            (effect.durationMs !== null &&
              effect.durationMs - config.motion.maxMs > 0.1)
          )
            violations.push(`exceeds ${config.motion.maxMs}ms limit`);
          if (
            effect.durationMs !== null &&
            config.motion.durations.length &&
            !config.motion.durations.some(
              (ms) => Math.abs(ms - (effect.durationMs ?? 0)) <= 0.1,
            )
          )
            violations.push(
              `is outside configured durations [${config.motion.durations.join(", ")}]ms`,
            );
          const effectName =
            effect.property === "opacity" ? "fade" : effect.property;
          const measured = {
            effect,
            maxMs: config.motion.maxMs,
            durations: config.motion.durations,
          };
          if (violations.length)
            emit(
              "idiom:motion-duration",
              `${surface} ${effectName} ${duration} ${violations.join(" and ")} (${action.name})`,
              effectKey,
              measured,
              "duration",
            );
          if (effect.timing === "unsupported")
            notes.add(`${surface}: effect duration unavailable`);
          if (
            motion?.reducedMotion &&
            (effect.timing === "infinite" ||
              (effect.durationMs !== null && effect.durationMs > 0))
          )
            emit(
              "idiom:motion-reduced",
              `${surface} ${effectName} ${duration} runs with prefers-reduced-motion: reduce (${action.name})`,
              effectKey,
              measured,
              "reduced",
            );
        }
      }
    }
    for (const note of snaps?.notes ?? []) notes.add(note);
    candidates.push(...(snaps?.candidates ?? []));
    if (!supported)
      return unavailable(
        this.id,
        [...notes].join("; ") || "no supported motion windows (recapture)",
      );
    return {
      coverage: {
        check: this.id,
        status: "ran",
        ...(notes.size ? { reason: [...notes].join("; ") } : {}),
      },
      candidates,
    };
  },
};

const kindPhrases: Record<VisibleChange["kind"], string> = {
  "content-swap": "content swaps",
  "expand-collapse": "expands/collapses",
  "list-item": "list items appear/disappear",
  status: "status message appears",
  route: "route change swaps the main content",
};

/** The transition a fix recommends, from the project's duration policy. */
export function snapDuration(motion: ChecksConfig["motion"]): number {
  const durations = [...motion.durations].sort((a, b) => a - b);
  if (durations.length === 0) return Math.min(250, Math.max(150, motion.maxMs));
  return (
    durations.filter((ms) => ms <= motion.maxMs).at(-1) ?? durations[0] ?? 150
  );
}

function snapFix(kind: VisibleChange["kind"], ms: number): string {
  const timing = `${ms}ms ease-out`;
  const motion =
    kind === "expand-collapse"
      ? `Transition \`grid-template-rows: 0fr → 1fr\` on the wrapper (or \`height\`) over ${timing}, with \`overflow: hidden\` on the inner element`
      : kind === "route"
        ? `Wrap the swap in a same-document View Transition (\`document.startViewTransition\`), or crossfade the main region's \`opacity\` over ${timing}`
        : `Animate \`opacity\` 0→1 with \`transform: translateY(4px)\` → none over ${timing} on enter, and the reverse on exit`;
  return `${motion}. Under \`@media (prefers-reduced-motion: reduce)\`, make it instant or a plain crossfade.`;
}

type SnapAction = {
  name: string;
  selector?: string | undefined;
  source: ActionTimeline["source"];
  stepIndex?: number | undefined;
  timeline?: string | undefined;
};

/**
 * Content snaps from action timelines: visible changes (swaps, expanders,
 * list items, status messages, route changes) with no transition. Only
 * windows recorded under normal motion are judged; under reduced motion an
 * instant change is correct, so reduce windows only add locations to a
 * group a normal-motion window showed snapping. One finding per
 * `kind|container`, listing every action that produced it.
 */
export function contentSnaps(
  tuple: CheckTuple,
  actions: ActionTimeline[],
  config: ChecksConfig,
  motion?: MotionArtifact,
): { candidates: FindingCandidate[]; notes: string[]; supported: boolean } {
  const minExtentPx = config.motion.minExtentPx;
  const windows = actions.filter(
    (action) =>
      // Held-network replays belong to loading checks, not motion evidence.
      action.source !== "load" &&
      action.source !== "slow-replay" &&
      action.source !== "failure-replay" &&
      action.status !== "unavailable" &&
      action.visibleChanges !== undefined,
  );
  const notes: string[] = [];
  if (windows.some((action) => action.truncated.includes("visibleChanges")))
    notes.push("timeline truncated: visibleChanges");
  const reduced = (action: ActionTimeline) =>
    action.reducedMotion ?? motion?.reducedMotion ?? true;
  const judging = windows.filter((action) => !reduced(action));
  const snapping = new Map<string, ActionTimeline>();
  const cleared = new Set<string>();
  for (const action of judging) {
    for (const key of snapCandidateKeys(action, minExtentPx))
      if (!snapping.has(key)) snapping.set(key, action);
    for (const key of animatedKeys(action, minExtentPx)) cleared.add(key);
  }
  const identity = (action: ActionTimeline) =>
    `${action.source}|${action.selector ?? ""}|${action.stepIndex ?? ""}|${action.name}`;
  const located = new Map<string, Map<string, SnapAction>>();
  let unjudged = 0;
  for (const action of windows) {
    for (const key of snapCandidateKeys(action, minExtentPx)) {
      if (!snapping.has(key)) {
        if (reduced(action) && !cleared.has(key)) unjudged += 1;
        continue;
      }
      const list = located.get(key) ?? new Map<string, SnapAction>();
      located.set(key, list);
      const id = identity(action);
      // A confirmation replays the user-facing click; list that click once.
      const existing = list.get(id);
      if (existing && action.confirmation === true) continue;
      list.set(id, {
        name: action.name,
        ...(action.selector ? { selector: action.selector } : {}),
        source: action.source,
        ...(action.stepIndex ? { stepIndex: action.stepIndex } : {}),
        ...(action.id ? { timeline: action.id } : {}),
      });
    }
  }
  if (unjudged > 0)
    notes.push(
      `${unjudged} content change(s) seen only under prefers-reduced-motion: reduce were not judged (probe confirmation budget, a route change, or web steps); set capture.reducedMotion to false to judge them`,
    );
  const observation = tuple.observations;
  const visible =
    observation?.version === 2
      ? observation.elements.filter((element) => element.visible)
      : [];
  const ms = snapDuration(config.motion);
  const candidates: FindingCandidate[] = [];
  for (const [key, evidence] of snapping) {
    const change = (evidence.visibleChanges ?? [])
      .filter(
        (candidate) =>
          candidate.key === key &&
          isSnapCandidate(candidate, evidence, minExtentPx),
      )
      .sort((a, b) => b.extent - a.extent)[0];
    if (!change) continue;
    const list = [...(located.get(key)?.values() ?? [])];
    const first = list[0];
    const target =
      visible.find((element) => element.selector === change.container) ??
      visible.find(
        (element) =>
          element.selector === first?.selector ||
          ("structuralPath" in element &&
            element.structuralPath === first?.selector),
      );
    const names = list.map((action) => action.name);
    const shown =
      names.slice(0, 3).join(", ") + (names.length > 3 ? ", …" : "");
    const surface = change.containerName || change.container;
    candidates.push({
      category: "motion",
      severity: "major",
      rule: "idiom:motion-snap",
      selectorHint: target?.selector ?? change.container,
      fingerprintHint: `motion-snap|${change.kind}|${change.container}`,
      ...(evidence.id ? { timeline: evidence.id } : {}),
      explanation: `${surface} ${kindPhrases[change.kind]} with no transition under normal motion (${list.length} action${list.length === 1 ? "" : "s"}: ${shown})`,
      acceptance: [
        `${surface} ${kindPhrases[change.kind]} with a ${ms}ms ease-out transition, and is instant or a crossfade under prefers-reduced-motion: reduce.`,
      ],
      fix: snapFix(change.kind, ms),
      verification: verify("motion", {
        surface: change.container,
        kind: change.kind,
        minExtentPx,
        extent: change.extent,
        actions: list,
      }),
    });
  }
  return { candidates, notes, supported: windows.length > 0 };
}

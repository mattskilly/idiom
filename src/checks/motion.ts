import { unavailable, verify } from "./shared.js";
import type { DeterministicCheck, FindingCandidate } from "./types.js";

/** Pure policy over persisted action windows; declarations alone are never evidence. */
export const motionCheck: DeterministicCheck = {
  id: "motion",
  run({ tuple, config }) {
    const observation = tuple.observations;
    const motion = observation?.version === 2 ? observation.motion : undefined;
    if (motion?.version !== 1 || motion.status === "unavailable")
      return unavailable(
        this.id,
        motion?.reason ??
          "temporal motion evidence unavailable; recapture with the interaction probe or declared web steps",
      );
    const candidates: FindingCandidate[] = [];
    const seen = new Set<string>();
    const notes = new Set<string>(motion.reason ? [motion.reason] : []);
    let supported = motion.actions.length === 0 && motion.status === "ran";
    for (const action of motion.actions) {
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
          major = false,
        ) => {
          const key = `${identity}|${rule}|${effect}`;
          if (seen.has(key)) return;
          seen.add(key);
          candidates.push({
            category: "motion",
            severity: major ? "major" : "minor",
            rule,
            selectorHint,
            fingerprintHint: key,
            explanation,
            acceptance: [
              major
                ? "Disable geometric and opacity motion when prefers-reduced-motion is reduce."
                : "Animate chrome state changes within checks.motion duration policy and honor reduced motion.",
            ],
            verification: verify("motion", {
              surface: change.ownerSelector,
              action: action.name,
              actionSelector: action.selector,
              source: action.source,
              ...(action.stepIndex ? { stepIndex: action.stepIndex } : {}),
              direction: change.direction,
              ...params,
            }),
          });
        };
        if (
          !motion.reducedMotion &&
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
          );
        if (
          motion.reducedMotion &&
          change.animated === true &&
          change.selector === change.ownerSelector &&
          change.reason?.startsWith("progressive geometry/opacity")
        )
          emit(
            "idiom:motion-reduced",
            `${surface} geometry/opacity motion runs with prefers-reduced-motion: reduce; duration unavailable (${action.name})`,
            "sampled",
            { animated: true, durationAssessment: "unavailable" },
            true,
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
            );
          if (effect.timing === "unsupported")
            notes.add(`${surface}: effect duration unavailable`);
          if (
            motion.reducedMotion &&
            (effect.timing === "infinite" ||
              (effect.durationMs !== null && effect.durationMs > 0))
          )
            emit(
              "idiom:motion-reduced",
              `${surface} ${effectName} ${duration} runs with prefers-reduced-motion: reduce (${action.name})`,
              effectKey,
              measured,
              true,
            );
        }
      }
    }
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

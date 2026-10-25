import { ran, unavailable, verify } from "./shared.js";
import type { DeterministicCheck, FindingCandidate } from "./types.js";

export const shellVisibilityCheck: DeterministicCheck = {
  id: "shell-visibility",
  run({ tuple, config }) {
    const observation = tuple.observations;
    const evidence =
      observation?.version === 2 ? observation.shellVisibility : undefined;
    if (!evidence)
      return unavailable(
        this.id,
        "shell visibility evidence is unavailable (recapture)",
      );
    const declarations = config.shellVisibility?.floatingOverlays ?? [];
    if (evidence.shell.status === "not-configured" && declarations.length === 0)
      return {
        coverage: {
          check: this.id,
          status: "skipped",
          reason: "no shell or floating overlays declared",
        },
        candidates: [],
      };
    const candidates: FindingCandidate[] = [];
    const notes: string[] = [];
    const emit = (
      kind: string,
      selector: string,
      identity: string,
      explanation: string,
      acceptance: string,
      params: Record<string, unknown>,
    ) =>
      candidates.push({
        category: this.id,
        severity: "major",
        rule: `idiom:shell-visibility-${kind}`,
        selectorHint: selector,
        fingerprintHint: identity,
        explanation,
        acceptance: [acceptance],
        verification: verify(this.id, params),
      });
    const shell = evidence.shell;
    if (shell.status !== "not-configured") {
      if (shell.status !== "measured")
        emit(
          "declaration",
          shell.selector,
          `shell:${shell.selector}`,
          `Required shell ${shell.selector} is ${shell.status} (${shell.count} matches).`,
          "The shell selector matches exactly one element.",
          { shell },
        );
      else {
        const mismatch = shell.scrollHeight !== shell.clientHeight;
        const escapesViewport =
          shell.rect.y < shell.viewport.y ||
          shell.rect.y + shell.rect.height >
            shell.viewport.y + shell.viewport.height;
        if (mismatch || escapesViewport)
          emit(
            "shell",
            shell.selector,
            `shell:${shell.selector}`,
            `${shell.selector}: scrollHeight ${shell.scrollHeight}px, clientHeight ${shell.clientHeight}px${escapesViewport ? `; shell box y=${shell.rect.y} height=${shell.rect.height} extends past viewport height ${shell.viewport.height}px` : ""}. ${shell.extending.length ? `Extending elements: ${shell.extending.map((e) => `${e.selector}${e.description ? ` [${e.description}]` : ""} (y=${e.rect.y}, height=${e.rect.height})`).join(", ")}.` : "Overflow attribution unavailable: no extending DOM box explains the measured excess."}`,
            "The shell scrollHeight equals clientHeight and its vertical box stays within the viewport.",
            { shell },
          );
      }
    }
    const active = declarations.flatMap((selector) => {
      const entries = evidence.overlays.filter((e) => e.selector === selector);
      const entry = entries[0];
      if (entries.length !== 1 || !entry || entry.status === "invalid") {
        notes.push(
          `${selector}: ${entry?.status === "invalid" ? "invalid CSS selector" : "overlay measurement missing (recapture)"}`,
        );
        return [];
      }
      return entry.matches.filter(
        (m) => m.rendered && m.visible.width > 0 && m.visible.height > 0,
      );
    });
    const seen = new Set<string>();
    for (const a of active)
      for (const b of active) {
        if (
          a.selector === b.selector ||
          a.ancestors.includes(b.selector) ||
          b.ancestors.includes(a.selector)
        )
          continue;
        const pair = [a.selector, b.selector].sort();
        const identity = JSON.stringify(pair);
        if (seen.has(identity)) continue;
        seen.add(identity);
        const width =
          Math.min(
            a.visible.x + a.visible.width,
            b.visible.x + b.visible.width,
          ) - Math.max(a.visible.x, b.visible.x);
        const height =
          Math.min(
            a.visible.y + a.visible.height,
            b.visible.y + b.visible.height,
          ) - Math.max(a.visible.y, b.visible.y);
        if (width > 0 && height > 0)
          emit(
            "overlay",
            pair[0] as string,
            `overlays:${identity}`,
            `Declared floating overlays ${pair.join(" and ")} intersect by ${width}×${height}px.`,
            "Declared peer overlays have no positive-area intersection.",
            { pair, width, height },
          );
      }
    if (notes.length)
      return {
        coverage: {
          check: this.id,
          status: "unavailable",
          reason: notes.join("; "),
        },
        candidates,
      };
    return ran(this.id, candidates);
  },
};

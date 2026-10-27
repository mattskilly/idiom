import { describe, expect, test } from "vitest";
import {
  animatedKeys,
  isAnimated,
  isSnapCandidate,
  snapCandidateKeys,
} from "../src/checks/motion-snap.js";
import type { VisibleChange } from "../src/checks/types.js";
import { type Animation, fade, swap } from "./motion-support.js";

const action = (
  changes: VisibleChange[],
  animations: Animation[] = [],
  viewTransition = false,
) => ({
  animations,
  viewTransition: { used: viewTransition },
  visibleChanges: changes,
});

describe("snap predicate shared by probe and check", () => {
  test("threshold, text-only and view transitions", () => {
    expect(isSnapCandidate({ ...swap, extent: 23 }, action([]), 24)).toBe(
      false,
    );
    expect(isSnapCandidate({ ...swap, extent: 24 }, action([]), 24)).toBe(true);
    expect(isSnapCandidate(swap, action([]), 240)).toBe(false);
    expect(isSnapCandidate({ ...swap, textOnly: true }, action([]), 24)).toBe(
      false,
    );
    expect(isSnapCandidate(swap, action([], [], true), 24)).toBe(false);
  });
  test("only relevant, running properties animate a change", () => {
    const covered = { ...swap, animations: [0] };
    expect(isAnimated(covered, action([], [fade]))).toBe(true);
    expect(
      isAnimated(
        covered,
        action([], [{ ...fade, properties: ["background-color"] }]),
      ),
    ).toBe(false);
    expect(isAnimated(covered, action([], [{ ...fade, durationMs: 0 }]))).toBe(
      false,
    );
    expect(
      isAnimated(
        covered,
        action([], [{ ...fade, durationMs: 0, iterations: "infinite" }]),
      ),
    ).toBe(true);
    expect(isAnimated({ ...swap, progressive: true }, action([]))).toBe(true);
    expect(isAnimated({ ...swap, animations: [3] }, action([], [fade]))).toBe(
      false,
    );
  });
  test("a group animated by any of its changes is not a snap", () => {
    const out: VisibleChange = {
      ...swap,
      selector: "#panel-1",
      direction: "out",
      before: swap.after,
      after: null,
    };
    const both = action([{ ...swap, animations: [0] }, out], [fade]);
    expect(snapCandidateKeys(both, 24)).toEqual([]);
    expect(animatedKeys(both, 24)).toEqual([swap.key]);
    expect(snapCandidateKeys(action([swap, out]), 24)).toEqual([swap.key]);
    // A small change riding along with a large animated one is part of it.
    const title: VisibleChange = {
      ...swap,
      selector: "h1",
      kind: "expand-collapse",
      key: "expand-collapse|header",
      extent: 28,
    };
    expect(
      snapCandidateKeys(
        action([{ ...swap, extent: 900, animations: [0] }, title], [fade]),
        24,
      ),
    ).toEqual([]);
    expect(
      snapCandidateKeys(
        action([{ ...swap, extent: 100, animations: [0] }, title], [fade]),
        24,
      ),
    ).toEqual([title.key]);
    expect(
      snapCandidateKeys({ ...action([]), visibleChanges: undefined }, 24),
    ).toEqual([]);
  });
});

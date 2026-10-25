import {
  colorDelta,
  isPainted,
  isVisuallyHidden,
  px,
  ran,
  type SignalledElement,
  signalledElements,
  unavailable,
  verify,
} from "./shared.js";
import type {
  CheckTuple,
  DeterministicCheck,
  DialogObservation,
  FindingCandidate,
  ObservedElementV2,
  Rect,
} from "./types.js";

const closeName =
  /^(?:[×✕✖╳xX]|close\b.*|dismiss\b.*|cancel|done|not now|back)$/i;

/** Within this distance of the dialog's top edge, two title-level headings read as one doubled title. */
const titleBand = 96;

type Shell = {
  dialog: DialogObservation;
  element: ObservedElementV2;
  members: SignalledElement[];
  headings: SignalledElement[];
  title?: { element: SignalledElement; size: number; text: string } | undefined;
};

const normalize = (value: string) =>
  value.replace(/\s+/g, " ").trim().toLowerCase();

const levelOf = (element: ObservedElementV2) =>
  element.headingLevel ?? (Number(element.attributes["aria-level"]) || 2);

const textOf = (element: SignalledElement) =>
  normalize(element.signals.name || element.text);

function intersect(a: Rect, b: Rect): Rect {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  return {
    x,
    y,
    width: Math.max(0, Math.min(a.x + a.width, b.x + b.width) - x),
    height: Math.max(0, Math.min(a.y + a.height, b.y + b.height) - y),
  };
}

const analyses = new WeakMap<CheckTuple, Shell[] | { reason: string }>();

/** Qualifying dialog shells in one tuple, memoized for run-wide comparison. */
function shellsOf(tuple: CheckTuple): Shell[] | { reason: string } {
  const cached = analyses.get(tuple);
  if (cached !== undefined) return cached;
  const result = analyse(tuple);
  analyses.set(tuple, result);
  return result;
}

function analyse(tuple: CheckTuple): Shell[] | { reason: string } {
  const signalled = signalledElements(tuple);
  if ("reason" in signalled) return signalled;
  const observation = tuple.observations;
  if (observation?.version !== 2 || observation.dialogs === undefined)
    return { reason: "observations predate dialog signals (recapture)" };
  const shells: Shell[] = [];
  for (const dialog of observation.dialogs) {
    const element = observation.elements.find(
      (candidate) => candidate.selector === dialog.selector,
    );
    if (element === undefined || !element.visible) continue;
    const members = signalled.elements.filter(
      (candidate) =>
        candidate.ancestorSelectors.includes(dialog.selector) &&
        !isVisuallyHidden(candidate),
    );
    const labels = dialog.labelledBy.flatMap((selector) => {
      const target = members.find(
        (candidate) => candidate.selector === selector,
      );
      return target === undefined || isVisuallyHidden(target) ? [] : [target];
    });
    const headings = [
      ...new Map(
        [
          ...members.filter(
            (candidate) =>
              (candidate.headingLevel !== undefined ||
                candidate.signals.role === "heading") &&
              !isVisuallyHidden(candidate),
          ),
          ...labels,
        ].map((heading) => [heading.selector, heading]),
      ).values(),
    ];
    const qualifies =
      dialog.modal ||
      (element.rect.width >= 320 && element.rect.height >= 160) ||
      headings.length > 0;
    if (!qualifies) continue;
    const ranked = headings
      .filter((heading) => !labels.includes(heading))
      .sort((a, b) => levelOf(a) - levelOf(b));
    const title = labels[0] ?? ranked[0];
    shells.push({
      dialog,
      element,
      members,
      headings,
      ...(title === undefined
        ? {}
        : {
            title: {
              element: title,
              size: Math.round(px(title.styles.fontSize) * 2) / 2,
              text: textOf(title),
            },
          }),
    });
  }
  return shells;
}

const identity = (shell: Shell) =>
  `${shell.dialog.selector}\u0000${shell.title?.text ?? ""}`;

const isClose = (element: SignalledElement) =>
  element.interactive &&
  element.enabled &&
  (closeName.test(element.signals.name.trim()) ||
    /close|dismiss/i.test(element.attributes["aria-label"] ?? ""));

export const dialogShellCheck: DeterministicCheck = {
  id: "dialog-shell",
  run({ tuple, tuples }) {
    const shells = shellsOf(tuple);
    if ("reason" in shells) return unavailable(this.id, shells.reason);
    const observation = tuple.observations;
    if (observation?.version !== 2) return ran(this.id, []);
    const bySelector = new Map(
      observation.elements.map((element) => [element.selector, element]),
    );
    const viewport: Rect = {
      x: 0,
      y: 0,
      width: observation.viewport.width,
      height: observation.viewport.height,
    };
    const population = new Map<string, { size: number; text: string }>();
    for (const other of tuples ?? [tuple]) {
      if (other.viewport !== tuple.viewport) continue;
      const otherShells = shellsOf(other);
      if ("reason" in otherShells) continue;
      for (const shell of otherShells)
        if (shell.title !== undefined && !population.has(identity(shell)))
          population.set(identity(shell), {
            size: shell.title.size,
            text: shell.title.text,
          });
    }
    const counts = new Map<number, number>();
    for (const { size } of population.values())
      counts.set(size, (counts.get(size) ?? 0) + 1);
    const reference = [...counts.entries()].sort(
      ([sizeA, countA], [sizeB, countB]) => countB - countA || sizeB - sizeA,
    )[0]?.[0];
    const candidates: FindingCandidate[] = [];
    for (const shell of shells) {
      const { dialog, element, members, headings, title } = shell;
      const emit = (
        suffix: string,
        severity: FindingCandidate["severity"],
        selectorHint: string,
        explanation: string,
        acceptance: string,
      ) =>
        candidates.push({
          category: this.id,
          severity,
          rule: `idiom:dialog-${suffix}`,
          selectorHint,
          explanation,
          acceptance: [acceptance],
          verification: verify(this.id, {
            dialog: dialog.selector,
            rule: suffix,
          }),
        });
      if (headings.length === 0)
        emit(
          "heading-missing",
          "major",
          dialog.selector,
          `${dialog.selector} has no visible heading${element.attributes["aria-label"] ? ` (aria-label ${JSON.stringify(element.attributes["aria-label"])} names it for assistive technology only)` : ""}.`,
          "The dialog shows one visible title.",
        );
      const duplicate = headings.find((heading, index) =>
        headings
          .slice(0, index)
          .some(
            (earlier) =>
              (textOf(earlier) !== "" && textOf(earlier) === textOf(heading)) ||
              (title !== undefined &&
                levelOf(earlier) === levelOf(title.element) &&
                levelOf(heading) === levelOf(title.element) &&
                earlier.rect.y - element.rect.y < titleBand &&
                heading.rect.y - element.rect.y < titleBand),
          ),
      );
      if (duplicate !== undefined)
        emit(
          "heading-duplicated",
          "minor",
          duplicate.selector,
          `${dialog.selector} shows ${headings.length} headings where one title is expected: ${headings.map((heading) => JSON.stringify(heading.signals.name || heading.text)).join(", ")}.`,
          "The dialog shows a single title; no second heading repeats or competes with it.",
        );
      // Keep rendered off-screen members for primary-action analysis, but a
      // close control must actually intersect the captured visible region.
      const regionFor = (member: SignalledElement): Rect => {
        let region = intersect(viewport, element.rect);
        for (const ancestor of member.ancestorSelectors) {
          if (ancestor === dialog.selector) break;
          const entry = bySelector.get(ancestor);
          if (entry === undefined) continue;
          region = intersect(region, {
            x: entry.styles.overflowX === "visible" ? region.x : entry.rect.x,
            y: entry.styles.overflowY === "visible" ? region.y : entry.rect.y,
            width:
              entry.styles.overflowX === "visible"
                ? region.width
                : entry.rect.width,
            height:
              entry.styles.overflowY === "visible"
                ? region.height
                : entry.rect.height,
          });
        }
        return region;
      };
      const closeControls = members.filter(isClose);
      if (
        closeControls.some(
          (member) => member.signals.viewportIntersection === undefined,
        )
      )
        return unavailable(
          this.id,
          "dialog-control viewport intersections are unavailable (recapture)",
        );
      const close = closeControls.filter((member) => {
        const visible = member.signals.viewportIntersection;
        return visible !== undefined && visible.width > 0 && visible.height > 0;
      });
      if (close.length === 0)
        emit(
          "close-missing",
          "major",
          dialog.selector,
          `${dialog.selector} has no visible close control (×, Close, Cancel or Done).`,
          "The dialog has a visible, labelled close control.",
        );
      const memberSelectors = new Set(members.map((member) => member.selector));
      const submits = dialog.submit
        .filter((selector) => memberSelectors.has(selector))
        .map((selector) =>
          members.find((member) => member.selector === selector),
        )
        .filter(
          (member): member is SignalledElement =>
            member !== undefined && !isClose(member),
        );
      const primary =
        submits.at(-1) ??
        [...members]
          .reverse()
          .find(
            (member: SignalledElement) =>
              member.signals.role === "button" &&
              member.enabled &&
              !isClose(member) &&
              !member.signals.repeatedItem &&
              isPainted(member.styles.backgroundColor) &&
              colorDelta(
                member.styles.backgroundColor,
                element.styles.backgroundColor,
              ) >= 24,
          );
      if (primary !== undefined) {
        const region = regionFor(primary);
        let pinned = ["sticky", "fixed"].includes(primary.styles.position);
        for (const ancestor of primary.ancestorSelectors) {
          if (ancestor === dialog.selector) break;
          const entry = bySelector.get(ancestor);
          if (entry === undefined) continue;
          if (["sticky", "fixed"].includes(entry.styles.position))
            pinned = true;
        }
        const x = primary.rect.x + primary.rect.width / 2;
        const y = primary.rect.y + primary.rect.height / 2;
        const outside =
          x < region.x ||
          x > region.x + region.width ||
          y < region.y ||
          y > region.y + region.height;
        if (outside && !pinned)
          emit(
            "primary-offscreen",
            "major",
            primary.selector,
            `the primary action ${JSON.stringify(primary.signals.name)} (${primary.selector}) in ${dialog.selector} is outside the visible area of the dialog and is not in a sticky footer.`,
            "The dialog's primary action is visible without scrolling, or sits in a sticky footer.",
          );
      }
      if (
        title !== undefined &&
        reference !== undefined &&
        population.size >= 2 &&
        Math.abs(title.size - reference) > 0.5
      ) {
        const others = [...population.values()]
          .filter(({ text }) => text !== title.text)
          .map(({ text, size }) => `${JSON.stringify(text)} ${size}px`);
        emit(
          "title-size",
          "minor",
          dialog.selector,
          `${dialog.selector} title ${JSON.stringify(title.text)} is ${title.size}px; other dialogs in this run use ${reference}px (${population.size} dialogs: ${others.join(", ")}).`,
          `The dialog title uses the run's dialog title size (${reference}px).`,
        );
      }
    }
    return ran(this.id, candidates);
  },
};

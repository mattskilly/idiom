import type { IntroductionCause, RecordedIntroduction } from "./record.js";

const short = (sha: string) => sha.slice(0, 7);
const ticketsText = (cause: IntroductionCause) =>
  cause.tickets.length === 0 ? "" : ` (${cause.tickets.join(", ")})`;

/** `appeared between abc1234 and def5678 (4 commits)`, with its qualifiers. */
export function rangeText(
  introduction: Pick<RecordedIntroduction, "range"> & {
    configChanged?: boolean | undefined;
  },
): string {
  const { range } = introduction;
  const count = !range.linear
    ? "not a linear range"
    : range.commits === 0
      ? "no commits between runs"
      : range.commits === null
        ? "commits unknown"
        : `${range.commits} commit${range.commits === 1 ? "" : "s"}`;
  return `appeared between ${short(range.from)} and ${short(range.to)} (${count})${range.toDirty ? "; plus uncommitted changes" : ""}${introduction.configChanged === true ? "; checks configuration changed between runs" : ""}`;
}

/** The likely cause, the candidates, or why there are none. */
export function causeText(
  introduction: Pick<
    RecordedIntroduction,
    "likely" | "candidates" | "candidatesOmitted"
  >,
): string {
  if (introduction.likely !== undefined)
    return `likely introduced by ${short(introduction.likely.commit)} "${introduction.likely.subject}"${ticketsText(introduction.likely)}`;
  if (introduction.candidatesOmitted !== undefined)
    return introduction.candidatesOmitted;
  const candidates = introduction.candidates ?? [];
  if (candidates.length === 0)
    return "no commit in range touched this state's files";
  const shown = candidates
    .slice(0, 5)
    .map((cause) => `${short(cause.commit)}${ticketsText(cause)}`)
    .join(", ");
  return `commits touching this state: ${shown}${candidates.length > 5 ? ` +${candidates.length - 5}` : ""}`;
}

/** `Appeared: <range>; <cause>.` — one line under a finding. */
export function appearedLine(introduction: RecordedIntroduction): string {
  return `Appeared: ${rangeText(introduction)}; ${causeText(introduction)}.`;
}

import { skillIdentity } from "../skills/merge.js";
import { markers, replaceSection, sectionSpan } from "./sections.js";
import type { Writer } from "./types.js";

/** Live repository customizations. Autobuild alone owns .ab-pristine. */
export const AUTOBUILD_SKILLS = [
  {
    surface: "autobuild-plan",
    path: ".agents/skills/ab-plan/SKILL.md",
    identity: "ab-plan",
    label: "Autobuild plan skill",
    body: `## Idiom

If the ticket changes UI, read \`idiom context\` and any Idiom design export in \`.ab/assets/design/\`.
Name the applicable Idiom checks the implementation is expected to pass.`,
  },
  {
    surface: "autobuild-implement",
    path: ".agents/skills/ab-implement/SKILL.md",
    identity: "ab-implement",
    label: "Autobuild implement skill",
    body: `## Idiom

For UI work, before finishing run \`idiom check --changed --fail-on major\`, inspect its evidence, and fix reported findings within the authorized change.
If the check or repair cannot be completed, record why and what remains; do not claim a skipped check passed or suppress findings.`,
  },
  {
    surface: "autobuild-code-review",
    path: ".agents/skills/ab-code-review/SKILL.md",
    identity: "ab-code-review",
    label: "Autobuild code review skill",
    body: `## Idiom

When the ticket has an Idiom design asset in \`.ab/assets/design/\`, compare the change with that asset's criteria.
Cite any mismatch in the normal review.`,
  },
] as const;

export type AutobuildSkill = (typeof AUTOBUILD_SKILLS)[number];

export function autobuildSkillWriter(
  source: string,
  target: AutobuildSkill,
): Writer {
  if (skillIdentity(source) !== target.identity)
    throw new Error(
      `Repair ${target.path} by hand: expected complete frontmatter with name: ${target.identity} and a nonempty body`,
    );
  const pair = markers(target.surface, "html");
  const span = sectionSpan(source, pair);
  if (span)
    for (const marker of pair) {
      const index = source.indexOf(marker);
      const lineStart = source.lastIndexOf("\n", index - 1) + 1;
      if (
        source.slice(lineStart, index).trim() ||
        !/^(?:\r?\n|$)/.test(source.slice(index + marker.length))
      )
        throw new Error(
          `Repair ${target.path} by hand: Idiom markers must occupy their own lines`,
        );
    }
  const bodyStart = /^---\r?\n[\s\S]*?\r?\n---\r?\n/.exec(source)?.[0].length;
  if (span && (bodyStart === undefined || span.start < bodyStart))
    throw new Error(
      `Repair ${target.path} by hand: Idiom markers must be outside frontmatter`,
    );
  return {
    candidate: replaceSection(source, target.surface, target.body, {
      format: "html",
    }),
  };
}

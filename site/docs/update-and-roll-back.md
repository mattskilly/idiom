---
title: Update and roll back
description: Update or pin the Idiom CLI, merge new skill guidance without losing project customization, handle conflicts and roll back safely.
---

# Update and roll back

Run `idiom upgrade` in each project. For a global npm or bun install it first updates the CLI to the latest release, then brings the project's vendored skills to that version; other installs update the CLI their own way first. Commit the skills and their pristine records together so the next update can distinguish your customization from upstream guidance.

## Update or pin the CLI

For a global npm or bun install, `idiom upgrade` updates the CLI itself: it checks the npm registry, runs `npm install -g @mattskilly/idiom@<latest>` or `bun add -g @mattskilly/idiom@<latest>`, checks the new version, then merges skills with the new release. If the install fails or the new CLI reports the wrong version, it stops before touching any skill and names the command. Plugin, `npx` and `bunx` installs print their update command instead, and a source checkout or project dependency prints how to update it. To install by hand:

```sh
npm install -g @mattskilly/idiom@latest
idiom --version
```

`idiom upgrade` needs 0.16.0 or later. Read the [changelog](https://github.com/mattskilly/idiom/blob/main/CHANGELOG.md) when choosing a version. [Upgrading](/docs/upgrading#action-required-by-release) lists what each release asks you to do.

For a project dependency, pin an exact version and commit the package manifest and lockfile:

```sh
npm install --save-dev --save-exact @mattskilly/idiom@0.21.0
npx --no-install idiom --version
```

Every release's tarball is also attached to its [GitHub release](https://github.com/mattskilly/idiom/releases) (`mattskilly-idiom-<version>.tgz`), and `npm install` accepts that URL too. Do not assume an unreleased version exists on npm. Use the project's installed CLI when upgrading that project's skills.

## Update each project's skills

From the project root:

```sh
idiom upgrade --dry-run
idiom upgrade
# For a pinned project dependency: npx --no-install idiom upgrade
```

`--project <dir>` chooses an explicit directory. Without it, the command finds an initialized ancestor of the current directory, or uses the current directory for a new installation. In the project it upgrades Idiom skill files, pristine state and owned discovery links. With `autobuild.toml`, an interactive run also offers the default UI gate and legacy verifier rename through an exact diff and confirmation; declining leaves those destinations untouched. Noninteractive/JSON runs report availability, and dry runs write nothing. Its first step updates a global npm or bun CLI, as above; `--no-self-update` skips that step and merges the installed CLI's skills, and `--dry-run` names the CLI install it would run without running it. The optional `idiom-verify` skill participates only if already installed or recorded in pristine state; detecting `autobuild.toml` alone does not install it.

The report names the installed CLI version and previous per-file versions. Legacy files with identical bytes in several releases report candidate versions; partial upgrades may report mixed versions. Each skill starts with one summary line, such as `idiom: merged (2 files)` or `idiom-verify: current`: the highest outcome among its files, in the order conflicted, merged, resolved, adopted, installed, removed, kept, current, and how many files carry it. Its files follow, indented. The outcomes are:

| Outcome | Meaning |
| --- | --- |
| `current` | Upstream is unchanged or the live file already matches. Your customization stays. |
| `adopted` | An untouched old file takes the installed release's content, a file new in this release is added, or a missing tracked file is restored. |
| `merged` | Independent local and upstream changes combine cleanly. |
| `resolved` | The configured model proposed conflict-hunk replacements that passed validation. |
| `conflicted` | The live file and its pristine entry remain unchanged; review the reported paths and the printed conflict. |
| `installed` | A first install: the file is installed and recorded. |
| `removed` | A retired, unedited upstream file and its ownership record are removed. |
| `kept` | A customized retired file becomes local, or a foreign/unsafe entry stays protected. |

For an overlapping edit, the report also prints the three-way merge with each side marked (`<<<<<<< local`, `||||||| base`, `=======`, `>>>>>>> incoming`), labelled as not written to disk. The preview stops at 80 lines; `--json` carries the whole text as `conflictText`, and the report's `skills` array carries each skill's summary.

Successful files advance even when another conflicts. Content conflicts and protected discovery collisions return exit status 1 after printing the whole report. A second successful run is a no-op. Foreign skills, user support files, and differently targeted symlinks stay untouched.

```sh
idiom upgrade --no-agent           # overlapping edits stay conflicted
idiom upgrade --dry-run            # inspect only; no model, writes or links
idiom upgrade --json --no-agent    # one structured report on stdout
```

Dry run reports deterministic outcomes and marks overlaps as needing resolution; it cannot predict whether a later model proposal will be accepted. Git must be on PATH for divergent text merges, even outside a Git checkout. Equal-byte adoption needs no Git. Missing Git becomes a per-file conflict.

## Pristine records and conflicts

`idiom init` records exact upstream bytes at `.agents/skills/.idiom-pristine/idiom/SKILL.md` and `.agents/skills/.idiom-pristine/idiom/init.md`, plus `.agents/skills/.idiom-pristine/idiom-verify/SKILL.md` when the verifier is installed. `.agents/skills/.idiom-pristine/manifest.json` records schema, version and SHA-256 digest for each file. These are tracked project files; commit them alongside `.agents/skills/idiom/` and any installed verifier. Keep the discovery links under `.claude/skills/` in the same commit. Running `idiom init` again on an existing skill that differs never offers to replace it: init merges it with the same rules as `idiom upgrade`, without a model, and leaves an overlap untouched for `idiom upgrade` to resolve.

For a project predating pristine records, exact known released templates can be adopted offline. Unknown customized copies conflict because their original upstream bytes cannot be proved. The report gives the expected pristine path and the installed incoming template path; an unavailable base is not fabricated.

For overlapping edits, Idiom uses the same `model.provider` and `model.model` in `.idiom/project.json` as review. The default Claude Code provider uses your subscription and needs no API key (`claude auth login` if needed); an explicit Anthropic provider requires `ANTHROPIC_API_KEY`. The resolver has no tools and a two-minute deadline. An unavailable provider, ambiguous choice, timeout, malformed response or failed validation leaves that file and baseline untouched. Clean upgrades never load model configuration or request credentials.

Code retains clean merge regions exactly, including independent upstream changes. A proposal supplies replacements only for actual conflict hunks. Validation rejects missing/extra hunks, new conflict markers, and changes to the skill's frontmatter `name`. No conflict markers are written into live skills.

For a manual conflict, use the two paths printed in the report. The printed conflict preview already shows the local, base and incoming sides of each overlap:

1. Review the live, pristine (if available), and incoming files. Save your reviewed merged result **outside the managed trees**, for example `/tmp/idiom-skill-reviewed.md`. Keep that saved copy until the workflow is complete.
2. Copy the reported incoming template bytes into the live file. Leave the pristine directory alone.
3. Run `idiom upgrade --no-agent`. Because the live file now matches incoming, the command can record the incoming bytes as provenance.
4. Copy the saved reviewed merge back into the live file. Your edits are now visible as local customization against a correct upstream baseline.
5. Review and commit the live skill and pristine records together.

Never put the manually merged result into pristine state: that would hide your edits from the next upgrade. If a path is a foreign occupant or symlink, move it yourself before following the workflow.

## Roll back

Install or pin an earlier **upgrade-capable** CLI, verify it with `idiom --version`, and run `idiom upgrade --no-self-update` again in the project (releases through 0.18.0 have no such flag and never update the CLI, so run plain `idiom upgrade` there). Without the flag, a global install would update straight back to the latest release. Idiom never rolls the CLI back itself; pin it with the install command:

```sh
npm install -g @mattskilly/idiom@<version>    # or: bun add -g @mattskilly/idiom@<version>
idiom --version
idiom upgrade --no-self-update
```

 The same three-way merge rules apply in either version direction, preserving local edits and reporting overlaps for review.

Already-published releases that predate this command cannot run it. To restore their guidance, restore the desired committed skill **and pristine** files from Git, or use an upgrade-capable installed release. Keep a commit of your customized skill state before changing versions so you can restore that project state too.

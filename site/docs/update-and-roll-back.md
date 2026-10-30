---
title: Update and roll back
description: Update or pin the Idiom CLI, merge new skill guidance without losing project customization, handle conflicts and roll back safely.
---

# Update and roll back

Update the CLI once, then run `idiom upgrade` in each project to bring its vendored skills to that installed version. Commit the skills and their pristine records together so the next update can distinguish your customization from upstream guidance.

## Update or pin the CLI

While npm publication is on hold, the latest released CLI is available from its GitHub Release tarball:

```sh
npm install -g https://github.com/mattskilly/idiom/releases/download/v0.16.1/mattskilly-idiom-0.16.1.tgz
idiom --version
```

`idiom upgrade` needs 0.16.0 or later. Read the [changelog](https://github.com/mattskilly/idiom/blob/main/CHANGELOG.md) when choosing a version.

For a project dependency, pin the release tarball and commit the package manifest and lockfile:

```sh
npm install --save-dev --save-exact https://github.com/mattskilly/idiom/releases/download/v0.16.1/mattskilly-idiom-0.16.1.tgz
npx --no-install idiom --version
```

Once the desired release is published to npm, a registry pin such as `@mattskilly/idiom@<version>` is another option. Do not assume an unreleased version exists on npm. Use the project's installed CLI when upgrading that project's skills.

## Update each project's skills

From the project root:

```sh
idiom upgrade --dry-run
idiom upgrade
# For a pinned project dependency: npx --no-install idiom upgrade
```

`--project <dir>` chooses an explicit directory. Without it, the command finds an initialized ancestor of the current directory, or uses the current directory for a new installation. It changes only Idiom's skill files, pristine state, and owned discovery links. It does not update the CLI or other project configuration. The optional `ab-verify-idiom` skill participates only if already installed or recorded in pristine state; detecting `autobuild.toml` alone does not install it.

The report names the installed CLI version and previous per-file versions. Legacy files with identical bytes in several releases report candidate versions; partial upgrades may report mixed versions. The outcomes are:

| Outcome | Meaning |
| --- | --- |
| `current` | Upstream is unchanged or the live file already matches. Your customization stays. |
| `adopted` | An untouched old file takes the installed release's content, or a missing tracked file is restored. |
| `merged` | Independent local and upstream changes combine cleanly. |
| `resolved` | The configured model proposed conflict-hunk replacements that passed validation. |
| `conflicted` | The live file and its pristine entry remain unchanged; review the reported paths. |
| `installed` | A new upstream file is installed and recorded. |
| `removed` | A retired, unedited upstream file and its ownership record are removed. |
| `kept` | A customized retired file becomes local, or a foreign/unsafe entry stays protected. |

Successful files advance even when another conflicts. Content conflicts and protected discovery collisions return exit status 1 after printing the whole report. A second successful run is a no-op. Foreign skills, user support files, and differently targeted symlinks stay untouched.

```sh
idiom upgrade --no-agent           # overlapping edits stay conflicted
idiom upgrade --dry-run            # inspect only; no model, writes or links
idiom upgrade --json --no-agent    # one structured report on stdout
```

Dry run reports deterministic outcomes and marks overlaps as needing resolution; it cannot predict whether a later model proposal will be accepted. Git must be on PATH for divergent text merges, even outside a Git checkout. Equal-byte adoption needs no Git. Missing Git becomes a per-file conflict.

## Pristine records and conflicts

`idiom init` records exact upstream bytes at `.agents/skills/.idiom-pristine/idiom/SKILL.md` and `.agents/skills/.idiom-pristine/idiom/init.md`, plus `.agents/skills/.idiom-pristine/ab-verify-idiom/SKILL.md` when the verifier is installed. `.agents/skills/.idiom-pristine/manifest.json` records schema, version and SHA-256 digest for each file. These are tracked project files; commit them alongside `.agents/skills/idiom/` and any installed verifier. Keep the discovery links under `.claude/skills/` in the same commit.

For a project predating pristine records, exact known released templates can be adopted offline. Unknown customized copies conflict because their original upstream bytes cannot be proved. The report gives the expected pristine path and the installed incoming template path; an unavailable base is not fabricated.

For overlapping edits, Idiom uses the same `model.provider` and `model.model` in `.idiom/project.json` as review. The default Claude Code provider uses your subscription and needs no API key (`claude auth login` if needed); an explicit Anthropic provider requires `ANTHROPIC_API_KEY`. The resolver has no tools and a two-minute deadline. An unavailable provider, ambiguous choice, timeout, malformed response or failed validation leaves that file and baseline untouched. Clean upgrades never load model configuration or request credentials.

Code retains clean merge regions exactly, including independent upstream changes. A proposal supplies replacements only for actual conflict hunks. Validation rejects missing/extra hunks, new conflict markers, and changes to the skill's frontmatter `name`. No conflict markers are written into live skills.

For a manual conflict, use the two paths printed in the report:

1. Review the live, pristine (if available), and incoming files. Save your reviewed merged result **outside the managed trees**, for example `/tmp/idiom-skill-reviewed.md`. Keep that saved copy until the workflow is complete.
2. Copy the reported incoming template bytes into the live file. Leave the pristine directory alone.
3. Run `idiom upgrade --no-agent`. Because the live file now matches incoming, the command can record the incoming bytes as provenance.
4. Copy the saved reviewed merge back into the live file. Your edits are now visible as local customization against a correct upstream baseline.
5. Review and commit the live skill and pristine records together.

Never put the manually merged result into pristine state: that would hide your edits from the next upgrade. If a path is a foreign occupant or symlink, move it yourself before following the workflow.

## Roll back

Install or pin an earlier **upgrade-capable** CLI, verify it with `idiom --version`, and run `idiom upgrade` again in the project. The same three-way merge rules apply in either version direction, preserving local edits and reporting overlaps for review.

Already-published releases that predate this command cannot run it. To restore their guidance, restore the desired committed skill **and pristine** files from Git, or use an upgrade-capable installed release. Keep a commit of your customized skill state before changing versions so you can restore that project state too.

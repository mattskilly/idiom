# Migrating to 1.0

This page is for anyone on a 0.x release of Idiom. It says what 1.0 promises, what was removed or changed since the last 0.x release, and how to move each project, plugin and MCP client. Work through it in order: check what changed, update the CLI and each project, update plugins and MCP, and know how to roll back before you start.

## What 1.0 promises

Every surface Idiom offers has a [status](stability.md#statuses). A **stable** surface (a command, its options, an exit code, a JSON payload, an MCP tool or a project file) does not change incompatibly. A **stable-additive** surface makes the same promise, but new fields may appear at any time, so ignore fields you do not know.

Breaks are tracked by the interface version, separate from the package version. 1.0 is at interface version 1. Read it from `idiom --version`, from the `interfaceVersion` key on every `--json` payload, or from the MCP server's initialize result ([how to detect a break](stability.md#how-to-detect-a-break)).

During 0.x, a minor release could break a stable surface as long as the interface version moved with it. From 1.0, a breaking change to a stable surface also needs a major release, and a deprecated stable surface is removed only in a major release ([deprecation policy](stability.md#deprecation-policy)).

Experimental surfaces stay experimental: they may change in any release. If you automate on one, pin the package version. The [command table](stability.md#cli-commands) says which surfaces are which.

## Before you start

Run `idiom --version` to see which release you are on. If it is older than 0.23.0, first work through every entry in [Action required by release](upgrading.md#action-required-by-release) between your version and 0.23.0. Those entries are not repeated here.

## Removed or changed since 0.23.0

| Surface | What changed | Use instead |
| --- | --- | --- |
| `idiom brief list --json --array` | Removed. It was deprecated in 0.23.0. Passing `--array` now exits 1 with a message naming the replacement. | `idiom brief list --json`, and read `.briefs` from `{ interfaceVersion, briefs }`. |
| `idiom baseline advance --json` | The experimental payload changed shape. It now returns `{ target, commit, fetched?, cachePath, flows: [...] }` with a per-flow `status`, instead of one flow's fields at the top level. The payload is experimental, so the interface version did not move. | Read each flow's entry from `.flows[]`. |

The commands promoted to stable since 0.23.0 (`fix`, `ruling`, `baseline advance`, `design` and `reference`) are additive and need no action. See the [command table](stability.md#cli-commands) for what each promises.

## Update the CLI and each project

From each project root:

```sh
idiom upgrade --dry-run
idiom upgrade
# For a pinned project dependency: npx --no-install idiom upgrade
```

For a global npm or bun install, `idiom upgrade` updates the CLI to the latest release itself, then updates the project. For any other install, update the CLI first with the line for your [install kind](upgrading.md#update-by-install-kind). Check the result with `idiom --version`.

## What idiom upgrade migrates in .idiom/

`idiom upgrade` brings every versioned `.idiom/` file to the format the installed release writes, one format at a time. Before it rewrites a file, it copies the original to `.idiom/backups/upgrade-<UTC timestamp>/`. A file already at the current format is left byte-identical. A file on a newer format than the installed Idiom understands is reported `refused`, and upgrade exits 1. No migrations are currently needed: every versioned file is at format version 1. The [format-version table](stability.md#format-versions-and-upgrade) lists each file.

It does not migrate:

- `.idiom/learned.jsonl`, an append-only log. Old records stay as written and are still read; upgrade reports the log as `kept`.
- `.idiom/decisions.jsonl`, also append-only. New record types are additive, and an older Idiom skips the ones it does not know ([records a newer Idiom wrote](stability.md#records-a-newer-idiom-wrote)). Move every machine that shares the log to 1.0 together.
- Flow manifests under `.idiom/flows/`, and `.idiom/glossary.json`.
- Run outputs and caches, such as `.idiom/reports/` and `.idiom/cache/`.
- A `baselines.directory` configured outside `.idiom/`.

Upgrade also merges the release's skill templates into the project and keeps your local edits. Commit the skills together with their `.agents/skills/.idiom-pristine/` records ([Update and roll back](https://idiom.build/docs/update-and-roll-back)).

When upgrade has migrated anything, commit the migrated files, then delete the backup directory.

## Update plugins and MCP

**Claude Code plugin.** Run `/plugin marketplace update idiom`, then `/plugin update idiom@idiom`, then `/reload-plugins` or start a new session.

**Codex plugin.** Run `codex plugin marketplace upgrade idiom`, then `codex plugin add idiom@idiom`. Rerun the `codex mcp add` line with the new release, replacing `<version>` with it, and start a new session:

```sh
codex mcp add idiom -- npx -y --package=https://github.com/mattskilly/idiom/releases/download/v<version>/mattskilly-idiom-<version>.tgz idiom mcp
```

**Any other MCP client.** Point its `idiom mcp` command at the new release and restart the client. Confirm that the initialize result reports `capabilities.experimental.idiom.interfaceVersion`. Client setup is in [MCP](mcp.md).

## Roll back

Pin the earlier 0.x release, check it with `idiom --version`, and run `idiom upgrade --no-self-update` so the skills match it. The exact commands for each install kind are in [Roll back to a pinned version](upgrading.md#roll-back-to-a-pinned-version).

What is specific to 1.0:

- If upgrade migrated any `.idiom/` file, restore the originals from `.idiom/backups/upgrade-<UTC timestamp>/`. An older Idiom reports a file on a newer format as refused.
- Records a 1.0 machine appended to `.idiom/decisions.jsonl` that the older release does not know are skipped with a note, not lost ([records a newer Idiom wrote](stability.md#records-a-newer-idiom-wrote)).
- For the Codex plugin, rerun the earlier release's `codex mcp add` line. For the Claude Code plugin, pin the plugin marketplace back to the earlier release.

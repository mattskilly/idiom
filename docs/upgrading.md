# Upgrading

Update the CLI, run `idiom upgrade` in each project (for a global npm or bun install, that one command does both), then work through the [action-required items](#action-required-by-release) for every release you skipped.

## Update by install kind

For a global npm or bun install, `idiom upgrade` installs the latest release itself and then updates the project's skills; see [upgrade](commands.md#upgrade). The commands below choose a specific release. Replace `<version>` with the release you want, without the `v`. The [changelog](../CHANGELOG.md) lists every release.

| Install | Update |
| --- | --- |
| npm, global | `idiom upgrade` for the latest release. For a specific one: `npm install -g https://github.com/mattskilly/idiom/releases/download/v<version>/mattskilly-idiom-<version>.tgz`, or `npm install -g @mattskilly/idiom@<version>` once npm serves that release |
| npm, project dependency | `npm install --save-dev --save-exact` with the same tarball URL, then commit the manifest and lockfile |
| bun | `idiom upgrade` for the latest global release. For a specific one: `bun add -g` with the same tarball URL, or `bun add -g @mattskilly/idiom@<version>` once npm serves it; `bun add -d --exact` for a project dependency |
| Claude Code plugin | `/plugin marketplace update idiom`, then `/plugin update idiom@idiom`, then `/reload-plugins` or a new session |
| Codex plugin | `codex plugin marketplace upgrade idiom`, then `codex plugin add idiom@idiom`, then rerun the `codex mcp add` line with the new release and start a new session |

The Codex line names the exact release:

```sh
codex mcp add idiom -- npx -y --package=https://github.com/mattskilly/idiom/releases/download/v<version>/mattskilly-idiom-<version>.tgz idiom mcp
```

Check the result with `idiom --version`, which prints `<version> (<short source commit>) · interface <n>` (releases before the interface version print only the first two parts). The [interface version](stability.md) moves only when a stable command, flag, JSON field, MCP tool or project file changes incompatibly. If the new release pins a different Playwright version, install its Chromium build too ([Troubleshooting](troubleshooting.md#playwright-chromium-is-missing-or-the-wrong-version)).

## Update project skills

From each project root:

```sh
idiom upgrade --dry-run
idiom upgrade
# For a pinned project dependency: npx --no-install idiom upgrade
```

`idiom upgrade` (0.16.0 and later) merges the installed release's skill templates into the project and keeps your local edits. For a global npm or bun install it first updates the CLI to the latest release and merges that release's templates; other installs print the command that updates them and merge with the installed templates. `--no-self-update` merges skills only. Commit the skills and their `.agents/skills/.idiom-pristine/` records together. Outcomes, conflicts and the manual merge workflow are in [Update and roll back](https://idiom.build/docs/update-and-roll-back) and [upgrade](commands.md#upgrade).

## Roll back to a pinned version

Install or pin the earlier release the same way, check it with `idiom --version`, and run `idiom upgrade` again so the skills match it. On a release that updates the CLI itself (after 0.18.0), add `--no-self-update`, or a global install moves straight back to the latest release:

```sh
npm install --save-dev --save-exact https://github.com/mattskilly/idiom/releases/download/v<version>/mattskilly-idiom-<version>.tgz
npx --no-install idiom --version
npx --no-install idiom upgrade
```

For a global install:

```sh
npm install -g @mattskilly/idiom@<version>   # or: bun add -g @mattskilly/idiom@<version>
idiom --version
idiom upgrade --no-self-update   # releases through 0.18.0: idiom upgrade
```

Releases before 0.16.0 cannot run `idiom upgrade`. To go back to one of them, restore the committed skill and pristine files from Git.

## Action required by release

What you must do after moving past each release, newest first. Everything else in the [changelog](../CHANGELOG.md) works without action. **Config** covers keys that were added or renamed or whose defaults changed, **Recapture** covers stored runs that lack new evidence ([why](troubleshooting.md#findings-need-a-recapture-after-an-upgrade)), and **Skills** means run `idiom upgrade`. Each release adds its own entry here ([release process](releases.md#prepare-the-tag)).

### Unreleased

None.

### v0.22.0

- **Shared decision logs:** this release can append attribution corrections (`idiom decide --reattribute`). Idiom 0.21.0 and older skip those records with a "written by a newer Idiom" note and show the original actor, so upgrade every machine that shares the log.
- **Autobuild gates:** none required. To keep gates from capturing the base branch, optionally run `idiom baseline advance` after merges or nightly ([Gate a build](commands.md#gate-a-build)).

### v0.21.0

- **Shared decision logs:** upgrade every machine and CI runner that reads `.idiom/decisions.jsonl` before anyone runs `idiom decide --ack`. Idiom 0.20.0 and older refuse a log that contains an acknowledgement; 0.21.0 and later skip record types they don't know.
- **Autobuild:** run `idiom upgrade` (or `idiom init`) and accept the shown diff to replace the old `ab-verify-idiom` agent step with the UI gate (`idiom check --gate --fail-on major --deferred warn`) and rename the verifier skill to `idiom-verify`. Until then, autobuild builds that change UI mostly skip Idiom.
- **Scripts reading results:** findings can now have severity `info`, which never counts toward a gate; `check` can exit `3` (deferred on a busy host) or `4` (a decision is needed). Accept these if your script checks a fixed list.
- **Skills:** run `idiom upgrade` so the `idiom-verify` skill checks builds that carry an Idiom design asset instead of skipping them ([attach to an autobuild ticket](brief.md#attach-to-an-autobuild-ticket)).
- **Scripts:** `idiom init --yes` now also applies the default wiring plan: a marked Design QA section in `AGENTS.md` (created if absent) and an existing `CLAUDE.md`, `.cursor/rules/idiom.mdc` when `.cursor/` exists, and `.github/workflows/idiom.yml` when `.github/workflows/` exists. Hooks, the nightly schedule, the Autobuild gate and landing rule stay off under bare `--yes`. To keep a script's old behavior, add `--skip-wiring agents --skip-wiring claude --skip-wiring cursor --skip-wiring github`, or preview first with `idiom init --dry-run`. Interactive init now asks once (`Apply all selected wiring shown above?`) instead of separately for the brief line, the Autobuild gate and the optional verifier. See [init wiring](commands.md#wire-agents-ci-hooks-and-autobuild).

### v0.20.0

- **Runtime:** Idiom now requires Node 22.12 or newer (the CLI library requires it). On older Node every entry point (CLI, `idiom mcp`, plugin and `npx`) exits 2 with a message naming both versions. Check with `node --version` before updating.

### v0.19.0

- **Scripts:** `idiom --version` now ends with ` · interface 1`; a script comparing the whole line should take the first word. Every `--json` payload except `brief list` gains a first key, `interfaceVersion`; a test comparing a whole payload should ignore it.
- **Decisions:** `brief-mismatch` findings accepted before this release reappear once, because their rule id now carries a hash of the assertion. Decide them again.
- **Behaviour:** `idiom upgrade` now updates the CLI before merging skills. A script or CI job that installs Idiom itself should run `idiom upgrade --no-self-update`. Update notices are off when `CI` is set; elsewhere, turn them off with `IDIOM_NO_UPDATE_CHECK=1` or `"updateCheck": false`.
- **Skills:** run `idiom upgrade` for the setup-handoff and `idiom init --validate` guidance in the Idiom skill.

### v0.18.0

- **Recapture:** to pick up the new disclosure, nested-border, empty-container, redundant-entry-point, control-selects-parent and token-resolution checks, the probe coverage counts, and the probe fingerprints `idiom check --gate` compares against. Recapture after recording a brief with assertions.
- **Config:** `idiom check --gate` reads the optional `checks.gate` block (`budgetMs`, default three minutes; `nonUi`). `capture.hideWebdriver` and `checks.probe.disclosures` / `checks.probe.maxRevealed` are new.
- **Behaviour:** a native `title` now explains a control for `unexplained-control` by default; set `checks.explanation: "visible"` to keep requiring a painted explanation.
- **Skills:** run `idiom upgrade` for the brief guidance in the Idiom skill and the before/after evidence in `idiom-verify`.

### v0.16.1

- **Codex:** the Codex plugin no longer starts the MCP server. Run `codex plugin marketplace upgrade idiom`, `codex plugin add idiom@idiom`, then the `codex mcp add` line for this release.

### v0.16.0

- **Skills:** first release with `idiom upgrade`. Run it once in each project so its pristine records exist for the next update.
- **Config:** new projects default `model.model` to `claude-sonnet-5-5`; existing projects keep theirs, so change it yourself if you want the newer model. `model.provider: "codex"` and `model.fallback` are new.
- **Behaviour:** a capture now fails when a stylesheet declares colour tokens and none of them resolves. Fix the token names it lists in `design.tokensFile`.

### v0.15.0

- **Skills:** the Idiom skill gained an explicit UI review and completion policy. Run `idiom upgrade` once you are on 0.16.0 or later.

### v0.14.0

- **Gates:** severity gates count measured and observed findings only. If a gate relied on judged model findings, add `--fail-on-judged`.
- **Recapture:** runs from before this release report reduced motion as missing in `idiom coverage --states`.

### v0.13.0

- **Gates:** `error-state-missing` and `retry-blocked` are new major checks, on by default, and can fail a `--fail-on major` gate. Configure them with `checks.failure`.
- **Config:** a repeated off-scale value now becomes one design-system question at `checks.scales.suggestAfter` occurrences (default 5). Answer it with `idiom ruling`.
- **Behaviour:** a malformed ruling block in `DESIGN.md` now fails `idiom check`. Fix the block.
- **Recapture:** the failure checks need a fresh capture.

### v0.12.0

- **Gates:** `interaction-shift`, `loading-state-missing`, `double-submit` and `motion-snap` are new major rules, on by default, and `layout-shift` and overlay snaps are now major. Each can fail a `--fail-on major` gate.
- **Config:** new `checks.interactionShift`, `checks.loading.delayMs` (default 1500ms), `checks.motion.minExtentPx` (default 24px), `capture.filmstrips`, and `agent.uiGlobs` / `agent.hooks` for the Claude Code reminders.
- **Behaviour:** `idiom quick` now runs the interaction probe; pass `--no-probe` for the static review.
- **Recapture:** timelines and filmstrips exist only in new captures; older runs report the timeline checks unavailable.

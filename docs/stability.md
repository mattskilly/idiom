# Stability

Scripts, CI jobs and coding agents depend on Idiom's commands, flags, exit codes, JSON output, MCP tools and project files. This page lists each of those surfaces with its status and says what may change between releases. It also says how you can tell when a release has made a breaking change.

## How to detect a break

Idiom has an **interface version**, separate from the package version. It is a single integer, currently interface version 1, and it changes only when a stable surface changes incompatibly. It appears in three places:

- `idiom --version` prints `<version> (<short source commit>) · interface <n>`, for example `0.17.0 (abc1234) · interface 1`. Scripts that want the package version alone should take the first word.
- Every `--json` payload is an object whose first key is `"interfaceVersion": 1`. The one exception is `idiom brief list --json`, which prints a bare array (see [JSON output](#json-output)).
- The MCP server's initialize result carries it under `capabilities.experimental.idiom.interfaceVersion`. Clients read it with their SDK's server-capabilities accessor, for example `client.getServerCapabilities()`.

Pin the interface version you were built against. If it moves, read the **Interface** heading in the [changelog](../CHANGELOG.md) for that release before upgrading.

## What 0.x means

Idiom is 0.x until the [1.0 gates](roadmap.md#toward-10-decided-2026-10-29) hold. During 0.x the package version alone does not signal breaking changes: a minor release such as 0.17.0 can contain one. The interface version is the promise instead. A stable surface changes incompatibly only together with an interface version bump, and every interface change is listed under an **Interface** heading in that release's changelog section.

After 1.0, a breaking change to a stable surface also needs a major package release.

## Statuses

- **stable**: will not change incompatibly without an interface version bump. A stable command keeps its name, its options and its arguments.
- **stable-additive**: as stable, and new fields may appear at any time. Existing fields are never removed or retyped. Ignore fields you do not know.
- **experimental**: may change or disappear in any release. The changelog still records the change, but no interface bump is needed. Do not build automation on it without pinning the package version.

A surface can be promoted from experimental to stable in any release. Demoting or removing a stable surface is a breaking change.

## Compatibility rules

These are the rules the contract test applies (see [How the promise is enforced](#how-the-promise-is-enforced)).

**Output** (Idiom writes it, you read it: `--json` payloads, `findings.json`). Properties may be added. An existing property stays, keeps its type and never becomes a wider type. A property that is always present stays always present. New enum values may appear, and a property that is already a union may gain variants, so a consumer must tolerate values it does not recognise. A property that is not a union never becomes one that admits other types (`string` to `string | null` is breaking).

**Input** (you write it, Idiom reads it: `.idiom/project.json`, flow manifests, `decisions.jsonl`, baselines, MCP tool inputs, flags). Optional properties may be added. Existing properties stay accepted with the same type or a wider one. Nothing that was optional becomes required. Enum values and variants may be added, never removed.

**Commands.** A stable command never disappears. Its existing options keep their long name and short flag, keep whether they take a value, and never become mandatory. Its positional arguments are never removed, never become required and never stop accepting several values. New options are never mandatory, and new arguments are always optional.

**Not frozen**, even on stable surfaces: descriptions and help text, human-readable output and report wording, finding text, numeric bounds and patterns in schemas (limits and validation detail), default values, and the order of lists that are not ranked. Finding ranking can change between releases; it is described in [ranking](ranking.md).

## CLI commands

A command's status covers its flags and positional arguments. It is not a promise about its human-readable output, and its `--json` payload has its own status below. The global `--project <path>` option is stable.

| Command | Status |
| --- | --- |
| `init` | stable |
| `upgrade` | stable |
| `mcp` | stable |
| `quick` | stable |
| `validate` | stable |
| `doctor` | stable |
| `capture` | stable |
| `check` | stable |
| `baseline` | stable |
| `baseline record` | stable |
| `baseline accept` | stable |
| `review` | stable |
| `report` | stable |
| `decide` | stable |
| `verify` | stable |
| `context` | stable |
| `fix` | experimental |
| `sweep` | experimental |
| `coverage` | experimental |
| `explore` | experimental |
| `explore resolve` | experimental |
| `compare` | experimental |
| `brief` | experimental |
| `brief triage` | experimental |
| `brief gate` | experimental |
| `brief plan` | experimental |
| `brief record` | experimental |
| `brief decide` | experimental |
| `brief list` | experimental |
| `brief show` | experimental |
| `ruling` | experimental |
| `learn` | experimental |
| `instruction` | experimental |
| `tickets` | experimental |
| `system` | experimental |
| `design` | experimental |
| `design add` | experimental |
| `reference` | experimental |
| `reference add` | experimental |
| `reference list` | experimental |
| `reference remove` | experimental |

The full flag reference is [commands](commands.md).

## Exit codes

Stable. The meanings are in [Exit codes and setup failures](commands.md#exit-codes-and-setup-failures).

- `0`: the command succeeded and nothing blocks.
- `1`: blocking findings, a failed gate or verification, or a usage or other error.
- `2`: the run could not happen (a refused precondition, a server that never became ready, or a capture that could not start).

## JSON output

Every payload except `brief list` is an object that starts with `"interfaceVersion": 1`. The stable-additive payloads promise the fields named here; anything else in them is experimental until it is named.

| Payload | Command | Status |
| --- | --- | --- |
| `check` | `check` | stable-additive |
| `run-failure` | `check` | stable-additive |
| `init --validate` | `init` | stable-additive |
| `doctor` | `doctor` | stable-additive |
| `check --gate` | `check` | experimental |
| `check --changed` | `check` | experimental |
| `upgrade` | `upgrade` | experimental |
| `baseline record` | `baseline record` | experimental |
| `baseline accept` | `baseline accept` | experimental |
| `review` | `review` | experimental |
| `review --page` | `review` | experimental |
| `sweep` | `sweep` | experimental |
| `coverage` | `coverage` | experimental |
| `coverage --states` | `coverage` | experimental |
| `compare` | `compare` | experimental |
| `brief research` | `brief` | experimental |
| `brief triage` | `brief triage` | experimental |
| `brief gate` | `brief gate` | experimental |
| `brief plan` | `brief plan` | experimental |
| `brief record` | `brief record` | experimental |
| `brief decide` | `brief decide` | experimental |
| `brief list` | `brief list` | experimental |
| `brief show` | `brief show` | experimental |

The stable fields:

- **`check`**, a full run's summary: `flow`, `runDirectory`, `reportPath`, `blocking`, and `findings[]` with `id`, `severity`, `category`, `rule` (when the finding came from a rule), `where`, `problem` and `fix[]`.
- **`run-failure`**, printed instead by `check` and `baseline record|accept` when the run could not happen: `flow` (when one was named) and `failure` with `stage` (`preflight`, `server` or `capture`), `cause`, `hint`, `message` and, when relevant, `paths`.
- **`init --validate`**: `ready`, `validate.ok`, and `doctor`, which is the `doctor` payload without `interfaceVersion`, or `null`.
- **`doctor`**: `flow` (when there is one), `ok`, `steps[]` with `id`, `status`, `ms` and optional `detail` and `hint`, `leftovers[]` with `pid`, `port`, `command` and `outcome` (`stopped` or `failed`) when doctor found application servers an earlier, killed run left behind, and `failure` (the `run-failure` object) when the boot failed.

`brief list --json` prints a bare array, so it cannot carry `interfaceVersion` without changing its shape. It stays an array and experimental until 1.0.

## MCP

Tool names and input schemas are stable for the tools marked stable. The tools declare no output schema yet, so their outputs (`structuredContent`) are experimental, except `structuredContent.failure`, which is the stable-additive `run-failure` object. The `capabilities.experimental.idiom.interfaceVersion` key is stable. Setup and inputs are described in [MCP](mcp.md).

| Tool | Status |
| --- | --- |
| `idiom_quick` | stable |
| `idiom_check` | stable |
| `idiom_issue` | stable |
| `idiom_fix_plan` | stable |
| `idiom_verify` | stable |
| `idiom_context` | stable |
| `idiom_flows` | stable |
| `idiom_decide` | stable |
| `idiom_init` | stable |
| `idiom_doctor` | stable |
| `idiom_baseline` | stable |
| `idiom_design_add` | experimental |
| `idiom_choose` | experimental |
| `idiom_tickets` | experimental |
| `idiom_sweep` | experimental |
| `idiom_coverage` | experimental |
| `idiom_brief_triage` | experimental |
| `idiom_brief_plan` | experimental |
| `idiom_brief_record` | experimental |
| `idiom_brief_decide` | experimental |
| `idiom_setup_prompt` | experimental |
| `idiom_ready` | experimental |

## Files

Field-by-field definitions are in [record schemas](schemas.md).

| File | Direction | Status |
| --- | --- | --- |
| `.idiom/project.json` | input | stable-additive |
| `.idiom/flows/<id>.json` (flow manifests) | input | stable-additive |
| `.idiom/decisions.jsonl` (one decision per line) | input | stable-additive |
| `.idiom/baselines/<flow>.json` (or the configured `baselines.directory`) | input | stable-additive |
| `.idiom/rules.json` (rule overrides) | input | stable-additive |
| `.idiom/finding-names.json` (the finding-name registry) | input | stable-additive |
| `findings.json` in a run directory | output | stable-additive |
| The names `report.md`, `report.html` and `findings.json` in a run directory | output | stable |
| Decision briefs under `.idiom/briefs/` | output | experimental |
| Rulings that `idiom ruling` writes to `DESIGN.md` | output | experimental |
| Every other capture artifact in a run directory (`dom.html`, `axe.json`, `observations.json`, timelines, crops, …) and the layout of `.idiom/reports/` beyond the three names | output | experimental |

Commit `.idiom/project.json`, the flow manifests, `decisions.jsonl`, baselines, rule overrides and the finding-name registry. A newer Idiom with the same interface version keeps reading what an older one wrote.

## Ids

- **Rule ids**, the check ids listed in [rules](rules.md) such as `adjacent-gap`, are stable-additive. New ones can appear in any release. Removing or renaming one is a breaking change, because `checks.*` configuration and rule overrides refer to it. The contract snapshot records them.
- **Finding rule names**, the `rule` value on a finding such as `idiom:elements-overlap`, follow the same promise, because decisions match findings by them. They have no central list yet, so they are reviewed by hand rather than by the contract test.
- **Finding names** (`finding-N`) never change once the registry assigns them. A finding keeps its name across runs, and a name is never reused.
- **Finding ids within a run** are stable as a format only: which finding receives which id can change from one run to the next.

## Deprecation policy

A stable surface that is going away is deprecated first:

1. It keeps working, and using it prints a warning: on stderr for the CLI, and in the tool description for MCP. The warning names the replacement.
2. The deprecation is listed under **Interface** in the changelog, and the docs name the replacement.
3. It keeps working for at least one minor release after the release that deprecated it.
4. Before 1.0 it is removed only together with an interface version bump. After 1.0 it is removed only in a major release.

## How the promise is enforced

This section is for contributors.

- `INTERFACE_VERSION` and the exit codes are defined once, in `src/interface/version.ts`. Every `--json` emitter goes through its `jsonPayload` helper, and a source guard test fails on a pretty-printed `JSON.stringify` written straight to stdout.
- `src/interface/surfaces.ts` records the status of every command, `--json` payload, MCP tool and file. It also holds the Zod contracts for the stable-additive payloads, and `bun run typecheck` fails if a payload's type stops satisfying its contract. Tests fail when a new command, `--json` flag or MCP tool has no status, and when this page's tables disagree with the registry.
- `test/contract/interface.json` is a snapshot of the stable surfaces: commands and flags, exit codes, JSON Schemas for the stable `--json` payloads and files (generated from the Zod schemas), the MCP tool list and input schemas, and the rule ids. `test/interface-contract.test.ts` rebuilds it from the code and compares the two with the rules above. Additive changes pass. A breaking change fails, with a message that points here, until `INTERFACE_VERSION` moves.
- After an additive change, or after a deliberate bump, run `bun run contract:update` to record the new snapshot and commit it. It refuses to record a breaking change while the interface version is unchanged. At release time, every change in the snapshot's diff is listed under **Interface** in the changelog ([releases](releases.md#prepare-the-tag)).

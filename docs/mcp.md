# Idiom tools for coding agents

`idiom mcp` exposes fifteen tools over stdio using the official TypeScript MCP SDK. It works with Claude Code, Codex, Cursor, Claude Desktop and other local MCP clients. No HTTP service or repair agent is required. Only model-enabled `idiom_sweep` needs model credentials, and only Figma references need `FIGMA_TOKEN`; both come from the server's environment, never from tool arguments (see [Credentials](#credentials)).

Install Node 20 or newer and the matching Playwright Chromium browser. Run `npx playwright@1.62.1 install chromium`. The application must be reachable for quick review; configured flows use their normal setup/build/server settings.

The portable Agent Skill installs with `npx skills add mattskilly/idiom --skill idiom` once the public snapshot contains it. See [distribution and registry preparation](distribution.md) for the prepared manifest and publication prerequisites; this does not announce a live registry listing. The [Claude Code how-to](https://idiom.build/docs/design-qa-for-claude-code) walks through setup and the repair loop.

## Install the plugin

The plugin includes the MCP server and Idiom skill; Claude Code also includes the UI-edit reminders described below. It needs Node 20 or newer, npm/npx and the matching browser, but no globally installed Idiom. The first launch downloads the exact versioned GitHub release tarball named by the plugin, and MCP initialization reports that release as `serverInfo.version`. It binds to the application's working directory. Codex starts a plugin's MCP servers in the installed plugin directory and passes no project, so the Codex plugin ships only the skill and the server is registered with `codex mcp add`, which Codex starts in each thread's project directory. If any host starts the server inside Idiom's plugin directory, it uses the client's MCP root that contains `.idiom/project.json` (or its first file root) when the client offers roots, and otherwise project tools return an error rather than reading or writing the plugin directory.

In a Claude Code session:

```text
/plugin marketplace add mattskilly/idiom
/plugin install idiom@idiom
```

Or from the application directory in your shell:

```sh
claude plugin marketplace add mattskilly/idiom
claude plugin install idiom@idiom
```

For Codex (see [plugin packaging and marketplaces](https://developers.openai.com/plugins/build/plugins)):

```sh
codex plugin marketplace add mattskilly/idiom
codex plugin add idiom@idiom
codex mcp add idiom -- npx -y --package=https://github.com/mattskilly/idiom/releases/download/v0.16.1/mattskilly-idiom-0.16.1.tgz idiom mcp
```

Codex starts a plugin's MCP server inside the plugin's own directory rather than your project, so the Codex plugin supplies the Idiom skill and `codex mcp add` registers the MCP server, which Codex starts in each thread's project directory.

Update Claude Code with `/plugin marketplace update idiom`, then `/plugin update idiom@idiom`. Run `/reload-plugins` or start a new session to apply it. For Codex, run `codex plugin marketplace upgrade idiom`, then `codex plugin add idiom@idiom`, rerun the `codex mcp add` line above with the new release (it replaces the entry), and start a new session.

Remove an existing standalone server when switching to the plugin (`claude mcp remove idiom` in Claude Code, or remove the corresponding server entry in another client) to avoid duplicate tools. For long captures or optional model/Figma integrations, keep the [timeout](#codex) and [credential guidance](#credentials) below in mind. Plugin installation and tool discovery need no model credentials.

## Standalone MCP setup

These registrations are useful without a plugin, or to bind a fixed project root. Install the [CLI release](https://idiom.build/docs/getting-started) first so `idiom mcp` runs that installed version. An unversioned `npx -y @mattskilly/idiom mcp` selects npm's current release, which may lag GitHub.

### Claude Code

Run from the application directory:

```sh
claude mcp add idiom -- idiom mcp
```

To bind a fixed root:

```sh
claude mcp add idiom -- idiom mcp --project /path/to/project
```

See [Claude Code MCP configuration](https://code.claude.com/docs/en/mcp).

### Codex

Add to `~/.codex/config.toml`:

```toml
[mcp_servers.idiom]
command = "idiom"
args = ["mcp", "--project", "/absolute/path/to/project"]
tool_timeout_sec = 3900
# Optional: only for Figma references and idiom_sweep.
env = { FIGMA_TOKEN = "figd_…", ANTHROPIC_API_KEY = "sk-ant-…" }
```

[Codex MCP configuration](https://developers.openai.com/codex/mcp) defaults tool calls to 60 seconds. Full-flow captures and two-pass verification may take longer; the example allows two default 30-minute capture budgets plus processing. Adjust this for your project. Client timeouts can cancel work before the capture budget expires. Progress notifications do not extend every client's timeout.

### Cursor

Create `.cursor/mcp.json` in the application:

```json
{
  "mcpServers": {
    "idiom": {
      "command": "idiom",
      "args": ["mcp", "--project", "/absolute/path/to/project"]
    }
  }
}
```

See [Cursor MCP configuration](https://cursor.com/docs/mcp).

### Claude Desktop

Open Settings → Developer → Edit Config and add this to `claude_desktop_config.json`, then restart Desktop:

```json
{
  "mcpServers": {
    "idiom": {
      "command": "idiom",
      "args": ["mcp", "--project", "/absolute/path/to/project"]
    }
  }
}
```

To fetch Figma frames or run `idiom_sweep`, add `"env": { "FIGMA_TOKEN": "…", "ANTHROPIC_API_KEY": "…" }` beside `args`. Use an absolute project path because the desktop process may start in an unrelated directory. Ensure its environment can find Node and `idiom`. See [local server setup](https://modelcontextprotocol.io/docs/2026-07-28/develop/connect-local-servers).

### Credentials

Tools never accept credentials as arguments. `FIGMA_TOKEN` (for Figma frames in `idiom_design_add`, captures and comparisons) and model credentials for `idiom_sweep` (`ANTHROPIC_API_KEY`, or the authentication of the project's configured Claude Code or Codex CLI) are read from the MCP server process's environment. Claude Code and Cursor pass the environment they were launched with; Codex and Claude Desktop take an `env` entry as shown above. Restart the server after changing it. A missing `FIGMA_TOKEN` is an actionable tool error and nothing is written; a missing or failing model degrades the sweep to deterministic findings with the reason, rather than failing it. When the project configures `model.fallback`, the sweep text says which provider completed the critique after the primary failed.

## Project roots and evidence

The server resolves `--project` relative to its launch directory once; without it, the launch directory is the root. Configured operations search upward for `.idiom/project.json`. Tool arguments cannot switch projects. Quick review always reviews the explicit URL with literal defaults, including inside configured projects, and never substitutes a flow or reads its configuration. It writes under the bound root's `idiom-quick-reports/`.

The server starts without `.idiom`. Quick and `idiom_init` work there; configured tools return an actionable initialization error that points at `idiom_init`. Paths a tool accepts (`out`, `emitTickets`, local design sources) are relative to the bound root and must stay inside it, including through symlinks; ticket destinations configured by a file tracker must also resolve inside the bound project. All returned report and crop paths are absolute. `idiom_issue` returns its text/detail, then a temporal contact-sheet PNG when available, then the existing static crop (or full-page screenshot). Structured `filmstrip` detail includes the sheet and manifest paths, action identity, completeness, actual size and configured caps. A finding with no visual evidence says so; missing or unreadable referenced images are errors.

Configured findings and groups keep their canonical IDs. Quick IDs are opaque and qualified, for example `quick:<runId>:finding-1`; they can be read again after restarting the server at the same root. Quick evidence cannot receive project decisions or calibrated flow verification. Group decisions apply only to that group's members, even when a presentation issue contains several sibling groups.

## Tools and inputs

Every input is a strict JSON object. Lists, when present, must be nonempty and duplicate-free. Flow/run identifiers cannot contain path separators or equal `.` or `..`. The server advertises the complete JSON schemas through MCP discovery.

| Tool | Input | Result |
| --- | --- | --- |
| `idiom_quick` | `{"url":"https://example.com","viewports":["desktop","mobile"],"probe":true,"probeBudgetMs":45000}`; all but `url` optional | Ranked Top 5, all deterministic findings, counts, `interaction` and Markdown/HTML/findings paths. Presets are 1440×900 and 390×844, both by default, in light/dark. The safe interaction probe runs once per page at the first viewport in light unless `probe:false`; `probeBudgetMs` (positive integer, at most 600000) cannot be combined with `probe:false`. `interaction` reports per page what was clicked, skipped, not reached and blocked, or `{"status":"off"}`. |
| `idiom_check` | `{"flow":"checkout","states":["cart"],"viewports":["mobile"],"all":false}` or `{"changed":true}` / `{"changed":"main"}`; flow required unless changed is supplied | Top issues with selectors, measurements, fixes, crops, counts, baseline new/fixed/pre-existing collections and coverage. `all:true` returns complete live findings and bypasses baseline bootstrap/comparison. Changed calls return the shared selection envelope and per-flow rich results; skipped flows have no run or evidence. Repeated off-scale values held as questions come back as `designSystemQuestions` (ruling id, question, count, suggested token) instead of findings. |
| `idiom_issue` | `{"id":"group-…"}` | Full original record(s), coordinates, group members/siblings, verification references and crop image content. |
| `idiom_fix_plan` | `{"flow":"checkout","top":5}`; top optional positive integer | Exact `idiom fix` repair prompt, selected original findings, source run and next verification arguments. A clean snapshot has an empty prompt and no next call. |
| `idiom_verify` | `{"flow":"checkout","findings":[{"id":"finding-1","runId":"…"}]}` | Two full-flow recaptures, calibrated per-finding verdicts, all-severity introduced findings, coverage, report paths, target `passed`, separate `regressionFree` and combined `success`. |
| `idiom_context` | `{}` | Bounded design brief: tokens, scales, rules, craft checks, prohibitions and accepted work. |
| `idiom_flows` | `{}` | Sorted validated flows with ordered states, selected viewports and schemes; suggests `idiom_init` with `flows:true` if empty. |
| `idiom_decide` | `{"id":"finding-1","decision":"accept","reason":"Intentional product choice"}` or `{"id":"ruling-3","decision":"add-step","token":"space-row","reason":"Dense rows"}` | Accept/reject counts and decision log path. Reason must be nonblank and is preserved verbatim; instance scope only. For a design system question from `idiom_check`, `add-step` records the step in the design file (`token` is optional and defaults to the suggestion), and `drift` keeps it reported as one grouped finding. |
| `idiom_init` | `{"flows":false,"surface":"web"}`; both optional | Non-interactive `idiom init`: files created/replaced/unchanged/preserved, Autobuild and design-token learning availability, the generated site-flow outcome with `flows:true`, and next steps. Never overwrites changed files or wires Autobuild. |
| `idiom_design_add` | `{"state":"cart","source":"https://www.figma.com/design/…?node-id=1-2","flow":"checkout","name":"figma","viewport":"desktop"}`; flow/name/viewport optional | Same as `idiom design add`: the flow manifest written, whether it changed, the stored source and whether it is Figma. Figma sources without `FIGMA_TOKEN` in the server env fail before writing. |
| `idiom_choose` | `{"id":"finding-3","reference":"figma","reason":"Figma is the source of truth"}` | Same as `idiom decide --choose`: records the human's chosen reference for one `idiom:design-decision` finding. Reason preserved verbatim; groups and quick evidence are refused. |
| `idiom_tickets` | `{"findings":["finding-1"],"out":"tickets/triage"}`; both optional | Same as `idiom tickets --cluster`: accepted findings clustered into triage proposals, absolute created paths and per-finding outcomes. Never writes to ready. |
| `idiom_sweep` | `{"flow":"checkout","latest":false,"emitTickets":".autobuild/tickets/triage"}`; from/latest/emitTickets optional | Same as `idiom sweep`: every ranked deterministic and model finding, per-surface status, report paths, optional ticket outcomes and `degraded` with the reason when the critique could not run. Choose exactly one of optional `flow` or `all:true`. `deterministicOnly:true` skips model credentials; `maxTickets` is a positive safe integer (default 10). All-mode makes fresh captures and rejects `from`/`latest`; its typed `scope:"all"` result includes flow/probe/check coverage, bounded cross-flow root-cause proposals, omission counts and Markdown/HTML/JSON polish paths. |
| `idiom_coverage` | `{"crawl":"http://localhost:3000"}` or `{"states":true}`; both optional | Same as `idiom coverage`: every discovered route with the flows/states that capture it, exclusions and unmatched runtime-URL states, plus `states` (each flow's state coverage, as `idiom coverage --states --json`) and one state-coverage line per flow. `states:true` returns only the state coverage and skips route discovery. |
| `idiom_baseline` | `{"action":"show","flow":"checkout"}`; `{"action":"record","flow":"checkout","latest":true}` | `show`: recorded commits with counts and which record applies at HEAD. `record`: same as `idiom baseline record`, with the file path and the deliberate-commit guidance. |

Changed checking accepts `changed:true` for the default merge base or a nonempty base string. Omit `flow` to consider every validated flow. `states` requires a named flow and intersects the inferred scope. Selection, Git bases, import/global fallbacks, no-op behavior and baseline rules match [the CLI](commands.md#check-only-changed-states). Each checked flow returns its ordinary top issues, counts, baseline comparison, coverage, report paths and verification references; not-checked flows register no evidence. Partial checking never records a new baseline or marks omitted findings fixed. A zero selection or failed/aborted batch does not acknowledge hook success.

After an autonomous build, once a batch lands, call
`idiom_sweep` with `{"all":true,"emitTickets":".autobuild/tickets/triage"}`
(or add `"deterministicOnly":true` without model credentials). Inspect the polish
reports and omitted count, then groom proposals manually. Ticket caps apply after
finding-id deduplication; shared causes include all flows and occurrence evidence.
Probe budgets, unavailable temporal evidence, model failures and failed/unreviewed
flows remain explicit coverage limitations. Partial results are degraded, never a
clean-product claim. Use every printed sidecar verify command after repairs.
The tool never promotes tickets, dispatches builds or accepts findings for you.

Captures, fix-plan, verify, sweep and baseline record write reports and may start the configured app. Decide and choose write judgment; init, design add and tickets write project files; context/flows/issue/coverage and baseline show are read-only. None changes Git or launches a coding agent.

## Repair sequence

1. Read `idiom_context` and `idiom_flows` before building UI.
2. Call `idiom_check` for the flow. The default preserves recorded-baseline semantics, including an automatically recorded first baseline on clean committed HEAD; its response explains this. Commit that baseline deliberately. Use `all:true` for the complete live issue list without baseline changes.
3. Inspect issues with `idiom_issue`, then call `idiom_fix_plan`. The plan takes a fresh full snapshot and excludes rejected findings. Use its exact source references for verification.
4. Edit the application source as requested. The caller owns repairs and human judgment.
5. Pass the returned `next.arguments` to `idiom_verify`. Verification resolves original records from that exact run even if another check has happened. It never accepts caller-authored finding bodies. Scoped/incomplete or failed source coverage must be replaced by a full successful check/fix-plan first.

Reproduced/unverifiable targets and introduced findings are completed verification results, not tool execution errors. `success` requires every target fixed and no introduced finding at any severity. Failed calibration yields no claim of regression freedom (`regressionFree:null`). Capture/startup/invalid-input failures return MCP tool errors with recovery instructions; the next call can still run. Report the error instead of silently rerunning via the CLI.

When a flow's states declare a Figma frame, `idiom_check`, `idiom_fix_plan` and `idiom_verify` compare against it like any other design reference. When Figma's own MCP server is connected, use it to read the frame for intent and context, and pass the frame URL (with `node-id`) to Idiom for the measured comparison through `idiom_design_add`; never transcribe Figma values by hand. The first fetch needs `FIGMA_TOKEN` in the server's environment; later runs reuse the pinned cache. When references disagree, ask the human which one is intended and record it with `idiom_choose` and their reason. See the [design comparison guide](design-compare.md) for all reference sources, attachment, auth and a worked example; MCP `idiom_quick` has no design input.

This deterministic loop complements model review: `idiom_sweep` runs the model critique over a flow. The commands that stay CLI-only, and why, are listed under [CLI parity](#cli-parity).

## Progress, cancellation and limits

Captures emit increasing progress notifications when the request supplies a progress token, including setup, tuple and probe activity; `idiom_quick` reports its probe activity the same way. Verification keeps one increasing sequence across both captures. Counters describe activity, not percentages. Calls are serialized to avoid concurrent report/decision writes; discovery stays immediate. Cancelling queued work skips it; active cancellation aborts capture resources and guards later publication. Disconnect, stdin EOF, SIGINT and SIGTERM abort work and close the session. Cleanup has a five-second grace for capture-owned resources, including late-acquired browsers/workspaces.

The existing capture limits apply: `capture.maxMinutes` defaults to 30 per capture, probe control/state budgets default to 5000/60000 milliseconds. `idiom_quick` uses its own probe limits: 45000 milliseconds per page for the focus sweep and the click probe together, and at most 40 controls. Its probe only lets `GET`, `HEAD` and `OPTIONS` requests leave the browser and blocks cross-origin navigation, form submission, downloads, new windows and permission prompts ([quick](commands.md#the-interaction-probe)). Missing Chromium errors suggest `npx playwright install chromium`; pinned-port errors tell you to free the port or correct server settings. Stdout is reserved for protocol JSON; diagnostics go to stderr.

## CLI parity

Every CLI command is either reachable as an MCP tool or deliberately CLI-only. A test keeps this table in step with `idiom --help` and the advertised tools, so a new command or tool cannot ship without a row here.

| CLI command | MCP tool | Reason |
| --- | --- | --- |
| `init` | `idiom_init` | Non-interactive; Autobuild wiring and design-token learning need the interactive CLI. |
| `upgrade` | CLI-only | Maintaining the agent’s vendored skills is an explicit project maintenance operation, separate from design checks. |
| `mcp` | CLI-only | It is the MCP server itself. |
| `quick` | `idiom_quick` | `--design` and `--out` are CLI-only; MCP writes under the bound root. |
| `capture` | CLI-only | Raw capture without review; MCP captures run inside check, fix-plan, verify, sweep and baseline record. |
| `reference add` | CLI-only | Curating liked and disliked examples with notes is a human taste step; `idiom_sweep` reads the catalog. |
| `reference list` | CLI-only | Part of human reference curation; see `reference add`. |
| `reference remove` | CLI-only | Part of human reference curation; see `reference add`. |
| `design add` | `idiom_design_add` | |
| `baseline record` | `idiom_baseline` | `action:"record"`; `action:"show"` reads the file. `--out`, `--prod` and `--port` are CLI-only. |
| `baseline accept` | `idiom_baseline` | Alias of `baseline record`. |
| `review` | CLI-only | Page review with interactive page and brief options; use `idiom_check` (deterministic) or `idiom_sweep` (model) for flows. |
| `fix` | `idiom_fix_plan` | MCP returns the repair prompt and selected findings; launching a repair agent is CLI-only. |
| `check` | `idiom_check`, `idiom_issue` | `idiom_issue` reads the full evidence for findings `idiom_check` returns. |
| `sweep` | `idiom_sweep` | `--prod`, `--port` and `--fail-on` are CLI-only. |
| `coverage` | `idiom_coverage` | |
| `explore` | CLI-only | Renders design directions and asks a human to rule interactively. |
| `explore resolve` | CLI-only | Records a human's choice against an exploration run, which only the CLI creates. |
| `verify` | `idiom_verify` | MCP verifies returned finding references; spec-file verification is CLI-only. |
| `compare` | CLI-only | Writes composites between two stored captures for a human to look at. |
| `report` | CLI-only | Opens a report in a browser; MCP tools return report paths. |
| `decide` | `idiom_decide`, `idiom_choose` | The interactive walk, `--list` and rule-scope rejections are CLI-only. |
| `ruling` | CLI-only | Records a design-law ruling after interactive human confirmation. |
| `learn` | CLI-only | Proposes rules as a diff a human confirms interactively. |
| `instruction` | CLI-only | Produces a paste-ready handoff for a human. |
| `tickets` | `idiom_tickets` | Clustered proposals only; per-finding tickets are CLI-only. |
| `context` | `idiom_context` | |
| `system` | CLI-only | Opens the design-system page in a browser and learns interactively. |
| `validate` | `idiom_flows` | `idiom_flows` lists validated manifests; every configured tool validates first and returns validation errors as tool errors. |

## Local plugin development

From a source checkout or unpacked package, validate and load the local Claude Code plugin:

```sh
claude plugin validate /path/to/checkout
claude --plugin-dir /path/to/checkout
```

The skill is namespaced as `/idiom:idiom`, for example `/idiom:idiom check checkout`. The release manifest still starts its pinned release server even with `--plugin-dir`. To develop changed MCP code, build the checkout with `bun run build` and register it separately with `claude mcp add idiom-dev -- node /path/to/checkout/dist/cli.js mcp`, using one MCP connection at a time. See the [plugin manifest reference](https://code.claude.com/docs/en/plugins/manifest-reference).

## Claude Code reminders

The plugin also enables two lightweight Node hooks by default:

- After `Edit`, `Write` or legacy `MultiEdit` changes a UI file, a short context line names the file and suggests `idiom check --changed` or `idiom_check` with `changed:true` for the configured flows. The check validates flows and resolves route ownership and static imports; global or unresolved changes fall back to all candidate states with an explanation. Hooks only read a bounded manifest list and never run that analysis themselves. Large lists explicitly include remaining flows. With no usable flows, the reminder directs the agent to `idiom_flows` or initialization first.
- Before stopping, if the UI contents differ from the last successful live `idiom check <flow>` or `idiom_check`, the hook blocks once and asks the agent to check or explain why checking is impractical. Further edits do not reset that session's reminder. A successful check starts a new epoch; another session can receive its own reminder. Claude's `stop_hook_active` continuation always passes. The hook does not judge the agent's explanation.

These hooks never start captures. Disable both hooks and their bookkeeping in `.idiom/project.json`:

```json
{ "agent": { "hooks": false } }
```

`agent.uiGlobs` replaces the default UI patterns. An empty array selects no files. For example:

```json
{ "agent": { "uiGlobs": ["apps/web/**/*.tsx", "packages/theme/**/*.css"] } }
```

Patterns are relative to the project containing `.idiom/project.json`. Both slash styles are normalized. Supported syntax is `*` (within one segment), `?` (one non-slash character), and whole-segment `**` (any depth, including zero directories in `**/`). Brackets such as `[id]` are literal route names. Braces, negation and extglobs are unsupported; use individual patterns for alternatives. Absolute paths and `..` segments are rejected. Paths and symlinks outside the project are excluded.

The exact default patterns are:

```text
**/*.jsx        **/*.tsx        **/*.vue        **/*.svelte
**/*.astro      **/*.css        **/*.scss       **/*.sass
**/*.less       **/*.html       **/*.mdx        **/*.hbs
**/*.handlebars **/*.ejs        **/*.liquid     **/*.pug
**/components/**/*.js          **/pages/**/*.js
**/app/**/page.js              **/app/**/layout.js
**/components/**/*.ts          **/pages/**/*.ts
**/app/**/page.ts              **/app/**/layout.ts
```

Dependency, Git, Idiom metadata/report and generated-output directories are excluded before matching (`node_modules`, `vendor`, `.git`, `.idiom`, `dist`, `build`, `out`, `.next`, `.nuxt`, `.output`, `coverage`, `.svelte-kit`, `.astro`, `.turbo`).

Working-tree evidence is local in `.idiom/agent-hooks/state.json`. Initialization ignores `/agent-hooks/` in `.idiom/.gitignore`; existing projects get that missing rule on their first state write, preserving existing lines. State contains a content digest, project/worktree and glob identities, check start/completion times, flow/scope metadata, bounded observed path examples and session reminders. It stores no source contents. Linked worktrees keep independent state, and an uninitialized worktree cannot borrow its parent's configuration.

A completed scoped live check counts even when it finds design problems or the CLI exits for findings: this records that checking happened. Failed/incomplete captures, cancellation, stored `--from`/`--latest` reviews, repair snapshots, and UI changes during the check do not advance the record. Staging identical contents, touching files or changing backend files does not invalidate it. Before the first check, tracked UI differences from HEAD, untracked UI files or observed hook edits establish work to check; a clean tree without observed edits passes.

Hooks use a short internal deadline (140ms of work, targeting complete Node invocations below 200ms), with a two-second provider timeout as a secondary guard. Malformed input/configuration, contention, unavailable Git, an oversized tree or deadline expiry allow the agent to continue quietly and never publish partial check evidence. A mutation lock left by an interrupted process is reclaimed once it is at least five seconds old; the next writer retries once without waiting. Without Git, a bounded filesystem snapshot is used; before the first check only observed edits trigger a reminder. Metadata and pending paths are bounded; if path examples overflow, snapshots conservatively walk the project with the same exclusions.


Finding projections in check/quick/sweep, evidence and fix plans include `basis`, `basisDetails`, and the versioned `acceptance` contract alongside evidence paths and verification references. Group representatives carry their basis; members retain individual acceptance contracts, including separate action identities. `idiom_verify` returns the same per-finding `{ contract, status, reason }` acceptance results as the CLI and reports. A not-recheckable machine acceptance on an otherwise fixed historical or judged finding does not introduce a failure cause or independently fail the repair loop; existing finding verdicts and regression checks determine success. See [verification semantics](commands.md#finding-basis-severity-gates-and-acceptance-verification).

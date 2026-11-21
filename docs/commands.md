# Commands

How to run each Idiom command, its flags and what it prints. What to write in `.idiom/project.json`, flow files and CI configuration is in [configuration.md](configuration.md). When a newer Idiom is released, a few commands say so once a day; see [Update notices](#update-notices).

## Command index

`idiom --help` opens with a four-line **Start here** workflow (`idiom init`, `idiom init --validate`, `idiom check <flow>`, then `idiom fix` or `idiom decide`) and lists every command once under a group: Setup, Daily loop, Judgment and decisions, Briefs, Explore and inspect, Agents and integration, and Maintenance. `idiom <command> --help` shows the command's flags; `init`, `check`, `review`, `fix`, `decide` and `brief` also end with an **Examples** block.

```
idiom mcp                    # stdio MCP tools for coding agents
idiom quick <url...>         # public-page review with no setup
idiom init                   # safe project scaffold, then hand setup to your coding agent
idiom init --wire            # wire agent files, CI, hooks and Autobuild in one confirmed plan
idiom init --validate        # setup is done? ready, or not ready + Fix
idiom upgrade                # update the CLI, then vendored skills, preserving customization
idiom validate [flow]        # project + manifest validation
idiom doctor [flow]          # boot the server once and diagnose setup
idiom reference add|list|remove  # manage visual references and anti-references
idiom capture <flow>         # deterministic browser capture
idiom check <flow>           # every deterministic finding, in fix order
idiom check --gate           # build gate: only what the change affects, within a budget
idiom digest [flow]          # short summary of the latest run against the previous one
idiom nightly [flow...]      # scheduled full check that files new findings as triage tickets
idiom watch                  # run the gate on every merge to the base branch; file regressions into triage
idiom bisect <finding>       # find the commit that introduced a finding
idiom baseline record|accept [flow]  # record or accept the regression baseline
idiom baseline advance [flow]        # advance the gate's base to the target tip, every flow that needs it
idiom fix <flow>             # bounded local agent repairs with calibrated proof
idiom sweep [flow] --all     # whole-product polish (choose a flow or --all)
idiom learn <observation>    # turn a human-found miss into a check or ruling
idiom learn --harvest        # collect UI corrections from build answers and PR reviews
idiom learn --import <file.md>  # import a Markdown table of misses; --replay counts what checks catch
idiom escalations [--answer]  # answer Autobuild design escalations that precedent already settles
idiom compare <flow>         # before/after composites between two stored captures
idiom coverage               # routes no flow captures
idiom review <flow>          # bounded deterministic + model critique
idiom report [runId]         # open the newest or named HTML report
idiom system [--learn]       # render or learn the project design system
idiom decide [--list]        # persist decisions or list lifecycle
idiom brief triage|plan|research|gate|lint|record|decide|list|show  # before a UI ticket: triage, research, measure comparables, ask, decide, gate and lint
idiom explore [flow]         # render three candidate directions for one state
idiom explore resolve <run-id>  # record the judgment on an exploration
idiom ruling --decision <id> # resolve a reviewed design-law question
idiom instruction            # render one accepted finding for pasting
idiom tickets                # turn accepted findings into triage tickets
idiom verify <flow>          # offline recapture and proof of resolution
idiom context [flow]         # bounded write-time design brief on stdout
```

## mcp

Run `idiom mcp [--project <dir>]` to expose eight local tools over stdio. The root is the launch directory or the resolved `--project` argument. Startup needs no initialized project; configured tools validate when called. Stdout contains only protocol messages. See [mcp.md](mcp.md) for client setup, schemas, progress/cancellation and the repair handoff.

## quick

Start the application yourself, then point Idiom at one or more public pages from the same origin:

```sh
cd /path/to/any/uninitialized-directory
idiom quick http://127.0.0.1:3000/
```

Add explicit pages to the same command when you already know the routes; Idiom preserves their order, does not crawl links, and blocks form submission while it probes:

```sh
idiom quick \
  http://127.0.0.1:3000/ \
  http://127.0.0.1:3000/pricing \
  http://127.0.0.1:3000/contact
```

The command captures every supplied page at desktop (1440×900) and mobile (390×844) sizes in both light and dark color schemes. It runs the deterministic checks and prints the exact `report.md` and `report.html` paths. By default, the timestamped result is written beneath `idiom-quick-reports/`; use `--out <dir>` for an exact new directory.

When some captures fail, for example a screenshot that ran out of time on a slow page, the findings from the captures that succeeded are still reported, and the final line names the failed captures and what to do (`1 of 4 captures failed — page-1/mobile/dark: screenshot out of time: …`). The command exits 0. Only when no capture succeeded does it fail (exit 1) with the same list and advice. MCP `idiom_quick` follows the same rule.

### The interaction probe

Quick review also interacts with each page once, at the first selected viewport in light (the same rule configured flows use). It hovers, focuses and clicks the page's controls so the probe-based rules (dead control, duplicate entry, motion and the other temporal rules) have evidence on a page you have never configured.

- **Budget.** Each page gets 45 000 ms for the keyboard focus sweep and the click probe together, and at most 40 controls. The focus sweep may use at most a third of it. The page's own controls go before shared navigation. Change the time with `--probe-budget <ms>` (a positive integer up to 600000). Controls the budget or the cap never reached are counted in the report.
- **Static review.** `--no-probe` skips the probe entirely and gives a static review. `--probe-budget` cannot be combined with it.

Quick review targets pages you may not own, so the probe is strict:

- Only `GET`, `HEAD` and `OPTIONS` requests leave the browser. Every other method is blocked, including requests to paths that look like a development server.
- Top-level navigation to another origin is blocked. A redirect the page took on load (for example to `www.`) counts as the page's own origin.
- Form submission is vetoed, whether by a submit button, Enter, `requestSubmit()` or `form.submit()`. The page's own handlers still run, and anything they send is held to the request rule above.
- Downloads are canceled, new windows are closed, and `window.open` and `print` do nothing.
- Notification, geolocation, camera, microphone and screen-share prompts are denied.
- A page's "leave this page?" prompt is answered so the page can be reloaded between controls.
- Service workers are blocked on the probed capture, so no request bypasses these rules.
- Controls whose names look destructive (delete, remove, sign out, unsubscribe, purchase, pay and similar) are never clicked; they are counted as skipped.

The report's **Coverage and limits** section has an **Interaction** paragraph per page. It says how many controls were clicked, what was skipped and why, how many were not reached, and how many navigations, submissions, downloads, new windows, permission prompts and non-GET requests were blocked. The probe artifact in each probed tuple's `observations.json` carries the same counts as `probe.safety` ([schemas](schemas.md)). The CLI's final line ends with `probed N controls, skipped M, not probed K`, or `probe off`.

Compare one page against an intended design with `--design`, without a project:

```sh
idiom quick http://127.0.0.1:3000/pricing --design ./exports/pricing.png
idiom quick http://127.0.0.1:3000/pricing --design https://example.com/pricing
```

The value can be a local PNG, JPEG or WebP image, a local HTML file or directory, a live site URL, or a Figma frame URL. A Claude share URL counts as an HTML design. Any other HTTP(S) URL is captured as a live reference site. A Figma frame URL is fetched with `FIGMA_TOKEN` and pinned under `.idiom/designs/` beside the working directory, as in a project ([Figma frames](configuration.md#figma-frames)). `--design` compares one page, so pass a single URL. See [design comparison](configuration.md#design-comparison).

Read the final **Quick-review limits** section as part of the result. It names the fixture-dependent error and empty states, authenticated surfaces, destinations behind forms or other interactions, and product/design judgments that a public-page pass cannot cover. To cover those, run `idiom init`, declare a flow, and use `idiom review <flow>`.

Quick review requires no Idiom files, product or design documents, flow manifest, interview, Git repository, or model credentials. It deliberately refuses to run in or below a directory that already contains `.idiom/project.json`; use that project's configured flow so quick review cannot bypass its states or guidance.

## init

### Hand setup to your coding agent (recommended)

```sh
idiom init                          # scaffold, then offer to launch Claude Code or Codex
idiom init --agent claude-code      # launch that agent without asking
idiom init --print-setup-prompt     # print only the prompt, for any other agent
```

Scaffolding is the easy part; the work is writing the server command, seed steps and a first flow. After scaffolding, an interactive `idiom init` hands that work to the coding agent you already use. It checks whether `claude` (Claude Code) or `codex` (Codex) runs here by calling `<cli> --version` through the same process transport critique uses. The project's configured critique provider (`model.provider`, then `model.fallback.provider`) is tried first; otherwise Claude Code is. If one is usable, init asks `Hand the rest of setup to <agent> now? [y/N]` and, on yes, starts that agent's interactive session in the project with the setup prompt as its first message. When it exits, confirm with `idiom init --validate`; the agent's exit code is reported but never fails init.

If no agent is usable, or you decline, init prints the same prompt between `----- BEGIN IDIOM SETUP PROMPT -----` and `----- END IDIOM SETUP PROMPT -----`, ready to paste into any coding agent.

- `--agent claude-code|codex` launches that agent without asking (the flag is the consent). If it is not usable, init prints why and the prompt, then exits 1; the scaffold is still written.
- `--no-agent` leaves out the agent step entirely and prints a one-line hint.
- `--yes` never launches an agent unless `--agent` is also given; without it, init prints the prompt instead. A non-interactive run (no TTY) behaves the same way.
- `--print-setup-prompt` prints only the prompt and exits, without scaffolding; it works in an uninitialized directory and cannot be combined with other init options.
- A launched agent runs with `IDIOM_SETUP_AGENT=1`, so an `idiom init` it runs never offers again.

The prompt is versioned with the CLI (its title names the Idiom version) and repository-aware: it lists what Idiom found — package manager, relevant `package.json` scripts (credentials redacted), frameworks, the current `server` config and whether it is still the scaffold default, existing flows and routes found by `--flows`, seed scripts and fixtures, an example env file by name only, and whether `PRODUCT.md` and `DESIGN.md` are untouched or human-edited. It never includes env file contents or `server.env` values. Its steps are: start the app (server command, port, `readyUrl`); seed data and test accounts from the repository's own scripts and fixtures, never real credentials; find routes with `idiom init --flows`; write a first flow of 3–8 states with stable selectors; and fill `PRODUCT.md` and `DESIGN.md` from the repository. It ends at `idiom init --validate`: the agent must keep going until that prints `ready`, and otherwise report the exact `not ready` and `Fix` lines as the remaining problem rather than claim success. The agent is told never to disable or weaken checks, edit rules or decisions to silence findings, commit, push or open pull requests.

Agents that use Idiom through MCP get the same prompt from `idiom_setup_prompt` and the same verdict as `init --validate` from `idiom_ready` (see [mcp.md](mcp.md)).

## Initialize a project

From the unrelated application you want to inspect:

```sh
cd /path/to/app
git rev-parse --verify HEAD
idiom init --yes
```

The Git check must print a commit. A plain directory, an uninitialized repository, or a repository with no commits can be initialized and validated, but cannot be captured; make its first application commit before continuing. Later uncommitted application or Idiom configuration changes are allowed and are recorded as a dirty source state.

To set up by hand instead of with an agent (add `--no-agent` to leave out the printed prompt), edit `.idiom/project.json` and define a flow; both files are described in [configuration.md](configuration.md#project-file). Validate and capture the first flow end to end:

```sh
idiom validate home
idiom capture home
```

A successful web or Electron capture writes the same `baseline.md`, screenshots, DOM, accessibility results, observations, console output, and metadata beneath a new `.idiom/reports/<run>/` directory. Review, decisions, tickets, and verify consume both target kinds unchanged.

Initialization creates `PRODUCT.md`, `DESIGN.md`, and `.idiom/` with project configuration, flow/reference directories, rules, an empty decision log, empty `finding-names.json` and `ruling-names.json` registries, and a gitignored reports directory. The registries and decision log are shared project memory and should be committed; only `reports/` is ignored. It also installs the conversational skill directory at `.agents/skills/idiom/` — `SKILL.md` plus the `init.md` guided-initialization procedure it loads on demand — and links `.claude/skills/idiom` to that canonical copy. It compares every existing scaffold file before writing:

- Identical files are left alone.
- `--yes` accepts template defaults but never overwrites a differing file.
- Without `--yes`, each differing file requires an explicit affirmative confirmation before replacement.

That makes `idiom init --yes` safe and idempotent in scripts and CI.

When `.idiom/project.json`'s viewports jump from a phone straight to a desktop, init's summary ends (before `Next: idiom init --validate`) with one suggestion to add a tablet viewport, for example `Suggestion: viewports skip from phone (mobile 390px) to desktop (desktop 1440px); add a tablet viewport such as { "name": "tablet", "width": 768, "height": 1024 } (or 1024 wide) to viewports in .idiom/project.json.` The default viewports (desktop 1440 and mobile 390) are unchanged, so a fresh project gets the suggestion; [`init --validate`](#check-that-setup-is-done) repeats it until a viewport between 640 and 1199px wide is configured.

To start a flow from your routes, configure `.idiom/project.json` and run the app
at `server.readyUrl`, then run:

```sh
idiom init --flows --yes
idiom validate site
idiom capture site
```

Interactive `idiom init` also offers route generation; plain init with
non-interactive stdin skips the offer. Accepting it discovers Next.js App/Pages routes, Astro pages (`.astro`, `.md`,
`.mdx`, `.html`), `/sitemap.xml` (including sitemap indexes), and rendered
same-origin links, with at most 30 page paths admitted by the link crawl. Sitemap
and filesystem routes are independent of that cap. Filesystem discovery skips
underscore-prefixed files and directories, declarations and non-page modules
such as Astro endpoints. It writes
`.idiom/flows/site.json`, using the project's viewport names and color schemes.
`--flows --yes` preserves a differing existing site flow; rerun interactively to
approve replacing that file. Other authored flows are preserved. For projects
with multiple surfaces, pass `--surface <declared-id>`; a sole surface is selected
automatically.

Generation visits the configured running local app; it does not build or start
it, execute setup, or call a model. Offline discovery still produces filesystem
states and explicit unverified notes. Confirmed live failures, including HTTP
404 and non-HTML responses, are omitted from states and retained as diagnostic
TODOs with their sources and reasons. Dynamic templates need an observed,
verified example URL; unresolved templates are TODOs in `intent` and init output,
never literal bracket URLs. Redirects to successful HTML login destinations
produce states at their original
URLs, with `TODO: requires setup` descriptions and instructions in `intent`.
Add your real authentication or fixture command to the flow's `setup` array,
then validate and capture again. Generated `expect.path` guards fail capture if
a protected route still lands on login. The guard tolerates canonical trailing
slashes while requiring the same route and capture origin. Generation does not
infer credentials, menus, dialogs, or other interaction states; add those manually or with `learn`.
Partial discovery and its limits are printed and retained in the flow.

The two named skill entries are collision-safe: an existing file, directory,
custom skill, or differently targeted symlink is preserved without a prompt,
even with `--yes`. Unrelated sibling skills are never changed.

### Wire agents, CI, hooks and Autobuild

```sh
idiom init --wire                      # wiring only, on an initialized project
idiom init --dry-run                   # print the plan; change nothing
idiom init --wire --yes                # apply the default plan without a prompt
idiom init --wire --git-hook --nightly --design-review
idiom init --wire --advance-baseline   # GitHub job: advance the baseline on every merge
idiom init --wire --skip-wiring github --skip-wiring claude
```

After scaffolding (and after any flow generation, so the plan sees new flows),
`idiom init` detects where the project builds UI and prints one plan. It looks
for `autobuild.toml`, `.github/workflows/`, `.husky/`, `lefthook.yml`,
`AGENTS.md`, `CLAUDE.md` and `.cursor/`, and notes whether `claude` and `codex`
are on `PATH` (found on `PATH` only; neither is run). The plan lists every
surface it will wire with the exact diff, and every surface it found but will
leave, with the reason. In a terminal you can change the selection first; then
one question, `Apply all selected wiring shown above? [y/N]`, applies all of it
or none of it. `--yes` applies the displayed default plan without asking; with
`--wire` (or `--dry-run`) that plan includes the Autobuild rows a prompt would
offer, so `idiom init --wire --yes` wires Autobuild with no terminal. A plain
scaffold `idiom init --yes` leaves the Autobuild rows unselected. A
noninteractive `--wire` run without `--yes` prints the plan, changes nothing and
ends with `Apply the offered wiring without a prompt: idiom init --wire --yes`.
`--dry-run` prints the same plan and creates nothing at all, not even the
scaffold; it wins over `--yes`.

`--wire` runs only this step on a project that already has
`.idiom/project.json`: no scaffold, skill, flow, learning or agent setup. On an
uninitialized directory it stops and tells you to run `idiom init` first. It
cannot be combined with `--flows`, `--surface`, `--agent` or `--no-agent`, and
none of the wiring flags combine with `--validate` or `--print-setup-prompt`.

| Surface (`--skip-wiring` id) | Default | What it writes |
| --- | --- | --- |
| `agents` | on | A marked **Design QA (Idiom)** section in `AGENTS.md`, created when absent |
| `claude` | on when `CLAUDE.md` exists | The same section in `CLAUDE.md`; a `CLAUDE.md` link to `AGENTS.md` is covered by `AGENTS.md` |
| `cursor` | on when `.cursor/` exists | `.cursor/rules/idiom.mdc` with `alwaysApply: true` and the same section |
| `github` | on when `.github/workflows/` exists | `.github/workflows/idiom.yml` (below) |
| `husky` | off; `--git-hook` | A marked `idiom check --gate --fail-on blocker` step at the top of `.husky/pre-push` |
| `lefthook` | off; `--git-hook` | A marked `pre-push` command (or job) running the same check in `lefthook.yml` |
| `autobuild-gate` | offered at a prompt; applied by `--wire --yes` | The UI gate described below |
| `autobuild-baseline` | offered at a prompt; applied by `--wire --yes`; an existing step stays selected | A finalize check step running `idiom baseline advance --fetch`, so the gate's baseline advances as builds land ([configuration](configuration.md#autobuild)) |
| `autobuild-verifier` | off; choose it at the prompt | The optional finding verifier described below |
| `autobuild-plan` | offered at a prompt when installed; applied by `--wire --yes`; managed sections refresh | UI context, Idiom design exports and expected checks in `ab-plan` |
| `autobuild-implement` | offered at a prompt when installed; applied by `--wire --yes`; managed sections refresh | UI checks and authorized repairs before finishing `ab-implement` |
| `autobuild-code-review` | offered at a prompt when installed; applied by `--wire --yes`; managed sections refresh | Compare changes against Idiom design asset criteria in `ab-code-review` |
| `autobuild-landing` | off; `--design-review` | A `[[landing]]` rule `label = "design-review"`, `mode = "consent"` before your other landing rules: tickets labeled design-review wait for a person before merging |

The Design QA section tells every agent to run `idiom brief triage
"<request>"` before speccing UI, read `idiom context` before building a new
screen, run `idiom check --changed` after changing UI, and not call a UI task
done while blocking findings remain. It replaces the older two-line brief
instruction offer. An earlier unmarked brief line is left exactly as it is;
remove it by hand if the section makes it redundant.

The workflow has two jobs. On `pull_request` it checks out the PR head and
runs the published Action (`mattskilly/idiom@main`; pin a commit SHA if you
prefer) on the **first** flow in `.idiom/flows` by filename. On `push` to the
default branch it installs the published CLI and runs
`idiom check <flow> --all --fail-on major` for **every** flow, failing if any
fails and uploading reports. With the optional nightly schedule (`--nightly`,
03:17 UTC) a third job runs [`idiom nightly`](#nightly) with
`--tracker directory --out .idiom/reports/nightly`: new findings since each
baseline become ticket proposals in the uploaded reports, and
`.idiom/filed-tickets.json` is restored and saved with `actions/cache` so each
night proposes only what is new. A runner has no tracker CLI or credentials;
to file into a tracker from CI, install `ab`, give the job its token, and drop
`--tracker directory`. With `--advance-baseline` (or `advance` at the prompt) a
`baseline` job runs on each default-branch push: `idiom baseline advance
--target <pushed sha> --commit-file`, then it commits `.idiom/baselines/` and
pushes. It needs `contents: write` and a branch that lets
`github-actions[bot]` push ([configuration](configuration.md#github-action)). The default
branch comes from the local `refs/remotes/*/HEAD`; when none exists, pushes to
any branch start a run that skips unless it is the repository's default branch.
The dependency install command follows your lockfile and `packageManager`
(bun, pnpm, yarn or npm) and is shown in the plan; when it cannot be
determined, the workflow is not offered and the plan says what is missing. A
repository with no flow fails the workflow with a setup instruction rather than
passing empty.

Hooks are never installed without `--git-hook` or a selection at the prompt;
init does not install husky or lefthook, run `lefthook install`, or touch
`core.hooksPath`. With both managers present, `--git-hook` needs a choice: pick
one at the prompt, or exclude the other (`--git-hook --skip-wiring lefthook`).
The nightly schedule, the baseline job, the landing rule and hooks stay off under bare `--yes`.
Every plan also ends with a crontab line and the `idiom nightly --print-schedule
launchd` command, for running the nightly check on a machine instead of in CI;
nothing is written for them (see [nightly](#nightly)).

Every write is a marked section: `<!-- idiom:wiring:<name>:begin -->` /
`<!-- idiom:wiring:<name>:end -->` in Markdown, `# idiom:wiring:<name>:begin` /
`# idiom:wiring:<name>:end` in YAML, TOML and shell. Reruns replace only the
marked section and leave every other byte alone; a second run with no changes
writes nothing. An existing unmarked `idiom.yml` or `idiom.mdc`, a foreign
`idiom` lefthook command, malformed markers, a symlinked destination, or a shape
init cannot patch narrowly is reported as protected and left untouched, without
blocking the other surfaces. Skipping a surface leaves it byte-identical; it
does not remove earlier wiring. Surfaces Idiom already manages (a marked hook,
landing rule or nightly schedule) stay selected on reruns; deselect them at the
prompt to stop updating them. If a file changes between the preview and the
confirmation, nothing is written; rerun `idiom init --wire`.

To remove wiring by hand, delete each marker pair and the lines between them.
Delete `.github/workflows/idiom.yml`, `.cursor/rules/idiom.mdc` or a created
`.husky/pre-push` only when nothing of yours remains in it. A lefthook
`pre-push:` or `commands:` line that init added sits inside the markers and goes
with them. Removing wiring never touches the scaffold, skills or the Autobuild
gate below.

The agent setup prompt lists the detected surfaces and which were wired or
left, and tells the agent to keep left surfaces off (`--skip-wiring`) when it
reruns init. MCP `idiom_init` never applies wiring: it returns the detected
plan under `wiring` and points the human to `idiom init --wire`.

If the repository root contains `autobuild.toml`, an interactive run offers the
UI gate as the `autobuild-gate` row of the same plan. It adds
`[commands].idiom-check = "idiom check --gate --fail-on major --deferred warn"`,
selects `idiom-check` once in `[verify].steps`, and adds a `kind = "check"`
step referencing that command, without a `paths` filter. Gate-only setup
installs no verifier skill and requires no detected flow. Invalid or ambiguous
TOML and foreign command/step ownership produce a complete manual addition;
ordinary scaffolding still completes. Current reruns report it as unchanged.
`idiom init --yes` reports gate availability without applying it.

The optional finding verifier (`autobuild-verifier`) is for projects that use
Idiom-originated tickets. When you select it, init offers each detected flow by
name in deterministic order, then the plan previews its command,
project-derived paths, `.agents/skills/idiom-verify/SKILL.md` and relative
`.claude/skills/idiom-verify` link. No flows or invalid manifests leave the gate
available and explain how to retry. Unknown applicability uses `paths = ["**"]`.
The verifier's configured command names the selected flow; the generic skill
reads and validates it from the actual TOML and runs it once.

An existing `idiom` skill, or a wired `idiom-verify` skill, whose bytes
differ from the installed templates is never replaced and never prompts.
Init hands it to the same decision as [`idiom upgrade`](#upgrade), with model
resolution off: an untouched older copy is `adopted`, independent local edits
are `merged`, and overlapping edits are left untouched and reported
`conflicted`, with the conflict preview and a pointer to `idiom upgrade`.
Init prints those results under `Existing skills upgraded in place` using the
same per-skill summary and outcome words, and its exit status is unchanged.

### Check that setup is done

```sh
idiom init --validate
idiom init --validate --flow site --json
```

`idiom init` ends with `Next: idiom init --validate`. `--validate` is the noninteractive readiness check: it creates and changes nothing. It runs `idiom validate` across every flow in `.idiom/flows`, then one `idiom doctor` boot of the first flow (in filename order) or the flow named by `--flow <id>`, and prints both results. When every step passes, the last line is `ready` and the exit code is 0. Otherwise stderr holds two lines, `not ready: <first problem>` and `Fix: <what to do>`, and the exit code is 2 (see [Exit codes and setup failures](#exit-codes-and-setup-failures)). Doctor warnings such as a dirty tree do not block readiness. Before the verdict it prints the [Where Idiom runs](#where-idiom-runs) section, even when validation failed, and that section never affects readiness. When the configured viewports jump from a phone (narrower than 640px) to a desktop (1200px or wider) with nothing in between, it then prints a suggestion to add a tablet viewport, 768 or 1024 wide, before `ready`; a suggestion never affects readiness, and the default viewports are unchanged.

- In a directory with no `.idiom/project.json` here or above, it prints `not ready: Idiom is not initialized here (…)` and `Fix: run idiom init`.
- A project with no flow manifest yet (plain `idiom init --yes` authors none) prints `not ready: .idiom/flows: no flow manifests found` with the fix to generate one with `idiom init --flows --yes` or author `.idiom/flows/<id>.json`.
- A manifest or project error names the file and field, as `idiom validate` does, and no server is started.

`--json` prints `{ ready, validate, doctor, surfaces, suggestions }`: `suggestions` is a list of advice lines such as the tablet viewport suggestion (empty when validation failed), `surfaces` is the [Where Idiom runs](#where-idiom-runs) report, `validate` is `{ ok: true, projectDirectory, flows: [{ id, file }] }` or `{ ok: false, failure }`, and `doctor` is the [`idiom doctor --json`](#doctor) report, or `null` when validation failed. `--validate` cannot be combined with `--yes`, `--flows`, `--surface`, `--agent`, `--no-agent` or `--print-setup-prompt`; `--flow` and `--json` apply only with `--validate`. Note that `--flow <id>` (one flow to boot) is distinct from `--flows` (generate a site flow). The MCP `idiom_init` tool ends with `Next: idiom_ready` instead; `idiom_ready` returns the same report and verdict as a tool.

### Use the conversational skill

Start Claude Code in the initialized repository and invoke:

```text
/idiom init
/idiom [flow]
/idiom verify <flow> <ticket-or-spec>
```

The normal form validates and captures each selected flow, reviews the immutable
capture, shows each finding with its available screenshot evidence, asks for
accept/reject judgment and reasons, records decisions, and emits newly accepted
findings as triage tickets. It also presents a paste-ready instruction for each
accepted finding as an optional handoff to another coding tool. It does not edit
product code, apply or send an instruction, promote tickets, or start a build
dispatcher. The `verify` form is the later, post-implementation continuation and
delegates to `idiom verify <flow> --spec <ticket-or-spec>`.

### Guided initialization

`/idiom init` is the collaborative interview that turns the scaffold into real
product truth in under fifteen minutes. It scaffolds with `idiom init --yes`,
then mines the repository first — design tokens and theme stylesheets, global
and component CSS, the component directory, existing design documentation, the
UI framework and its user-facing surfaces, and the product's own copy — so it
asks only the questions the code cannot answer: who the surface is for, what
must be obvious in seconds, what observable outcome means it is working, and one
to three links or screenshots of design you are after plus one to three you
dislike. Offered links and images become managed references and anti-references
through `idiom reference add`, so the answers end up as enforceable imagery
rather than adjectives. Every claim written into `PRODUCT.md` and `DESIGN.md`
carries its source — a repository path, a managed reference name, or the
interview itself — and anything without one is written as an explicit unknown.

Both files come back for your correction before they are treated as
authoritative, and a file that already differs from the template is never
overwritten without your explicit approval. The procedure ships as `init.md`
beside the skill; `idiom init --yes` remains the unchanged non-interactive path
for scripts and CI.

`.agents/skills` is the shared canonical location for compatible agent
harnesses; `.claude/skills` is Claude Code's project discovery path. If Claude
Code was already running when the top-level skills directory was first created,
restart the session so `/idiom` is discovered.

## upgrade

```sh
idiom upgrade [--project <dir>] [--no-agent] [--no-self-update] [--dry-run] [--json] [--yes] [--skip-wiring <surface>]
```

Update the Idiom CLI, then merge its skill templates into a project (the skill
merge since 0.16.0). Without `--project`, an initialized ancestor is selected, with
the current directory as fallback. Only already-installed or pristine-tracked
`idiom-verify` skills participate; Autobuild detection alone grants no install.

After any CLI self-update handoff, upgrade offers the same gate diff and legacy
verifier migration as init. The old `ab-verify-idiom` directory, owned discovery
link, pristine directory and manifest keys move to `idiom-verify`. Only the live
frontmatter identity changes during the move; local body edits/support files
and historical baseline bytes, versions and digests survive. Every live legacy
`[verify.<name>].skill` reference changes in the preview, retaining its logical
step name, flow and paths. A recognized released untracked copy recovers its
real historical base; unknown customized content moves without invented
provenance and remains reported for manual resolution. Normal three-way skill
upgrades follow the move. Collisions/protected entries require manual recovery.
Declining migration leaves the legacy copy outside automatic skill upgrades.

`--dry-run` reports proposed wiring/moves with no writes, link changes or model
calls. `--yes` applies every offered change without prompting (the gate and its
skill, the baseline finalize step and the brief instruction), printing the same
exact diffs a prompt would show; `--dry-run` wins over `--yes`. `--skip-wiring
<surface>` takes init's surface ids and leaves `autobuild-gate`,
`autobuild-baseline`, `agents` or `claude` alone; the other ids are accepted
and change nothing here. Without `--yes`, `--json` and noninteractive runs never
prompt or apply config/migration changes, and a human-readable run that left
wiring unapplied ends with `Apply the offered wiring without a prompt: idiom upgrade --yes`.
The report adds optional `autobuild` and `baselineAdvance` with `kind` (a
skipped surface reads `skipped`) and the `diff` and `migration` previews when
available; manual outcomes name the reason and complete addition. Existing skill
reports and conflict exits still apply.

**First, the CLI.** For a global `npm install -g` or `bun add -g` install,
`idiom upgrade` reads the registry's `latest` (a fresh read, up to 10 seconds,
never the notice's cache). When a newer stable release exists it runs
`npm install -g @mattskilly/idiom@<latest>` or `bun add -g @mattskilly/idiom@<latest>`,
checks that the replaced package reports `<latest>` from `--version`, prints
`Updated the Idiom CLI <old> → <new> (ran: <command>).` and re-runs the new
package's `idiom upgrade` with the same arguments and `IDIOM_SELF_UPDATE_HANDOFF=1`.
That fresh process merges skills with the new templates and never self-updates
again; its exit code is `idiom upgrade`'s exit code.

Every other install leaves the CLI alone and still merges skills. A plugin,
`npx` or `bunx` install prints one line with its [update command](#update-notices)
when a newer release exists. A source checkout prints
`git pull && bun install --frozen-lockfile && bun run build`, and an install
Idiom cannot identify (usually a project dependency) prints
`npm install --save-dev --save-exact @mattskilly/idiom@latest`; neither makes a
network request. The [update-notice off switches](#update-notices) also turn
the registry read off, with one line saying so. Offline, a timeout or a registry
failure prints one line saying the CLI version could not be checked, and the
skills merge anyway.

If the package manager fails, or the replaced package reports a different
version, `idiom upgrade` exits 1 before touching any skill, naming the command
(and, after a version mismatch, the command that reinstalls your previous
version). A failed install leaves the existing CLI in place.

**Project files.** Before the skill merge, upgrade brings each versioned
`.idiom/` file (`project.json`, `rules.json`, baselines, briefs and the rest
[listed in stability](stability.md#format-versions-and-upgrade)) to the format
the installed release writes. A current file is only read. An older one is
migrated after its original is copied to `.idiom/backups/upgrade-<stamp>/`.
Logs are never rewritten. The text report adds a `Project files: …` line with
counts, then one line per file that is not current (`migrated`, `kept`,
`refused`, `skipped` or `failed`); `--dry-run` prints `would migrate` and
writes nothing. A file on a newer format than Idiom understands is left
untouched and upgrade exits 1 (telling you to update Idiom), as does a
migration that fails; the skill merge still runs and both are reported. No
migrations are currently needed.

`--no-self-update` skips this step: skills only, with the installed templates.
`--dry-run` names the install it would run and reports the skill merge against
the installed templates, changing nothing. `--json` adds
`"cli": { "from", "to", "command", "outcome" }`, where `outcome` is `updated`
(reported by the handed-off process), `would-update`, `current`, `manual`,
`skipped`, `disabled`, `unchecked` or `failed`. A failure prints
`{ "interfaceVersion", "cli": { …, "outcome": "failed", "error" } }` and no
skill report.

Init seeds upstream bytes under `.agents/skills/.idiom-pristine/<skill>/<file>`
and per-file version/digest records in its `manifest.json`. Upgrade compares
those bytes with local and incoming, advances successful baselines to **incoming**,
and preserves conflicted files and their records. Exact historical templates
are recognized offline; unknown customized legacy bytes require a manual merge.

The text report lists previous/installed versions (including unknown, candidate
or mixed provenance), then each skill: one summary line such as
`idiom: merged (2 files)` or `idiom-verify: current`, then that skill's
files, indented, each with `current`, `adopted`, `merged`, `resolved`,
`conflicted`, `installed`, `removed` or `kept`. The skill's outcome is the
highest of its files' in the order conflicted > merged > resolved > adopted >
installed > removed > kept > current, and the count is how many files carry it.
`installed` means a first install; a file that is new in this release, or a
missing tracked file that is restored, is `adopted`.

Conflicts include pristine and installed incoming paths. An overlapping edit
also prints the three-way merge with its sides marked (`<<<<<<< local <path>`,
`||||||| base <pristine version>`, `=======`, `>>>>>>> incoming <version>`),
labeled as not written to disk; the live file is unchanged. The preview stops
at 80 lines and names the three paths to compare for the rest. Foreign
discovery entries are reported separately and preserved exactly. Successful
neighbors still advance. Any content conflict or discovery collision returns
exit 1 **after** the report; success returns 0. `--json` prints the same
structured report as a single JSON document on stdout, including a `skills`
array (each skill's `name`, `outcome` and `files`) and, for an overlap, the
file's full untruncated `conflictText`. It also includes `projectFiles`:
`backupDirectory` (or `null`) and `files`, each with `path`, `format`, `kind`,
`outcome`, `version`, `currentVersion` and, as they apply, `from`, `to`,
`backupPath` and `reason`.

`--no-agent` never loads or invokes a resolver. `--dry-run` writes nothing and
never calls a model; overlaps report `conflicted` with `needsResolution: true`.
Git on PATH is needed only for divergent three-way text merges. Overlaps normally
use review's configured `model.provider` and `model.model`: subscription Claude
Code by default, or explicit Anthropic with `ANTHROPIC_API_KEY`. Tool-free,
bounded proposals replace conflict hunks only, and must retain clean regions,
upstream-only changes and frontmatter identity without new markers. Provider
failure or validation rejection leaves that file and baseline untouched.

Commit skill files, pristine state and owned `.claude/skills` discovery links
together. Downgrading to an earlier upgrade-capable CLI uses these same rules.
For manual conflicts and older binaries without this command, follow
[Update and roll back](https://idiom.build/docs/update-and-roll-back).

## validate

```sh
idiom validate --project /path/to/app
idiom validate booking --project /path/to/app
```

Validation starts in the `--project` directory, or in the current directory when `--project` is omitted. A relative `--project` resolves against the current directory. From that start it walks upward to the nearest `.idiom/project.json`, so `--project /path/to/app/apps/web` validates the project rooted at `/path/to/app` when that is the closest ancestor with a manifest. If no ancestor has one, validation exits `1` with `no .idiom/project.json found from <dir> or any parent directory`. With no flow argument it validates every `.json` file in `.idiom/flows/` in filename order. It validates the project first, then schema and cross-record constraints such as flow viewport names.

Success exits `0` and names the validated flows. Missing files, malformed JSON, and schema errors exit `1`; diagnostics include both the source file and exact field path, such as `states[3].urlFrom.pattern`.

To validate the committed real-world example:

```sh
idiom validate booking --project examples/booking
```

`validate` and init with no accepted flow-generation offer are fully local: they make no model, network, or external API calls. Explicit `init --flows` or an accepted interactive offer visits the configured local app for route discovery. Validation treats setup command strings as data and never executes them.

## doctor

```sh
idiom doctor            # the project's server, no flow setup
idiom doctor booking    # also runs the flow's setup steps
idiom doctor booking --port 4100 --json
```

`idiom doctor` boots the application server once, exactly as a capture would, and reports why a run could not start. It runs these steps in order, each with its timing:

| Step | What it does |
| --- | --- |
| `node` | checks that Node is 22.12 or newer; a failure skips every other step |
| `config` | validates `.idiom/project.json` and the flow manifests; a failure skips every other step |
| `registry` | resolves finding names from `.idiom/finding-names.json` (and the primary checkout's); divergence from the primary passes, and the next run warns |
| `tree` | a warning, not a failure, when the tree is dirty or not a Git worktree, because a baseline cannot be recorded then |
| `port` | binds the port the same way capture does (`--port`, `IDIOM_PORT`, `server.fixedPort`, or a free one) and fails when a pinned port already answers |
| `setup` | runs the named flow's setup steps in a temporary data directory |
| `build` | runs `server.build` with `server.env` and `PORT` |
| `start` | runs `server.start` and waits for `server.readyUrl` within `server.startupTimeoutMs` |
| `ready` | loads `server.readyUrl` once more and expects `200` |
| `shutdown` | stops the server and checks that the port is released |

Electron flows launch the app directly, so every server step is skipped for them. The first line is `idiom doctor <flow>: ok` or `idiom doctor <flow>: <failure>`; each failing or warning step adds a `fix:` line. The fixes cover the known causes: a start command that pins its port without `server.fixedPort`, a missing environment variable (add it to `server.env`), a port already in use, and a readiness URL that never returns `200`. `--json` prints `{ flow, ok, steps: [{ id, status, ms, detail, hint }], failure, surfaces }` (see [Where Idiom runs](#where-idiom-runs)).

After the steps, doctor lists every open [unattended condition](#unattended-runs-never-fail-quietly) that nightly, the gate or the verify step recorded: `Open conditions (N):`, each with its one line, its ticket, and `seen <runs>× since <first>, last <last> by <mode>`, or `No open conditions from unattended runs.` The headline then reads `ok; N open condition(s)`. Conditions are informational here: they never change `ok` or doctor's exit code, and `--json` adds them as `conditions: [{ key, cause, line, mode, firstSeen, lastSeen, runs, ticket? }]` only when any are open.

Doctor exits `0` when every step passes or warns, and `2` with the failing step's one-line cause when one fails. It captures nothing and writes nothing to the project. The MCP tool is `idiom_doctor`. [Troubleshooting](troubleshooting.md) covers each failure with its cause and fix.

### Where Idiom runs

After the steps, doctor prints a **Where Idiom runs** section: one line per place Idiom can fire when UI changes, so a setup that silently never runs is visible next to one that works. Each line is `wired`, `missing`, `stale` (present but out of date or unable to fire) or `not applicable` (the tool or file is not used here), and every `missing` or `stale` line carries a `fix:` with the exact command or edit.

```text
Where Idiom runs:
  ✓ wired           Autobuild gate step              [verify.idiom-check] runs idiom-verify on `idiom check --gate --fail-on major --deferred warn`
  ! stale           Autobuild verifier step          paths never match: apps/web/**
                    fix: edit [verify.idiom].paths in autobuild.toml
  ✗ missing         GitHub workflow                  no workflow runs Idiom
                    fix: idiom init --wire
  – not applicable  Codex MCP                        Codex not found
```

| Surface | Wired when | Stale when | Fix |
| --- | --- | --- | --- |
| Autobuild gate step | `autobuild.toml` already has the gate `idiom init --wire` would write; the detail names the wired skill (`idiom-verify` or `idiom-fix`) and any `paths` filter | the step is not in `[verify].steps`, uses the old `--fail-on major` command without `--deferred warn`, is the old `kind = "check"` step with `paths`, is owned by another command, or runs a skill (`idiom-verify` or `idiom-fix`) whose `.agents/skills/<skill>/SKILL.md` is not installed | `idiom init --wire`, `idiom upgrade` for a missing gate skill, or a hand edit when init cannot change it safely |
| Autobuild verifier step | an `idiom-verify` agent step is listed in `[verify].steps`, its command names an existing flow, and its `paths` can match | the legacy `ab-verify-idiom` verifier (`idiom upgrade`), a missing flow, a `paths` glob whose fixed prefix does not exist, or a step that never runs | the named `autobuild.toml` edit |
| GitHub workflow | a workflow in `.github/workflows` uses the Idiom Action or runs `idiom check` | it pins an Idiom version older than this one | `idiom init --wire` for the managed `idiom.yml` section, otherwise the version to change |
| Agent instruction (AGENTS.md, CLAUDE.md, Cursor rule) | the marked Design QA section matches what init writes | an older section, or unmarked Idiom text | `idiom init --wire` |
| Claude Code plugin hooks | the `idiom` plugin is installed for the user or this project, enabled, `agent.hooks` is not `false`, and the project is initialized | the installed plugin is older | the `claude plugin` install, enable or update command |
| Codex MCP | `mcp_servers.idiom` is in `.codex/config.toml` or `~/.codex/config.toml` (`CODEX_HOME`) | it runs an older release tarball or package | `codex mcp add idiom -- …` for this release |
| Git hook | a husky `pre-push` or lefthook pre-push command runs `idiom check` | the managed block runs an older command | `idiom init --wire --git-hook` |

The Claude Code plugin is read from `~/.claude` (or `CLAUDE_CONFIG_DIR`): `plugins/installed_plugins.json`, then `enabledPlugins` in the user, project and local `settings.json`. Without `.idiom/project.json`, the section opens with `No .idiom/project.json: Claude Code hooks and the Autobuild gate are inactive until you run idiom init.`

The section is read-only and fast: it reads a bounded set of files, starts no process (not even Git), uses no network and takes well under a second. It is informational and never changes doctor's exit code. `--json` adds `surfaces: { root, initialized, notice?, ms, entries: [{ id, label, status, path?, detail, fix? }] }`, where `id` is one of `autobuild-gate`, `autobuild-verifier`, `autobuild-plan`, `autobuild-implement`, `autobuild-code-review`, `github`, `agents`, `claude`, `cursor`, `claude-plugin`, `codex-mcp`, `git-hook` and `status` one of `wired`, `missing`, `stale`, `not-applicable`.

## Unattended runs never fail quietly

`idiom nightly`, `idiom check --gate` and `idiom verify` run where nobody watches: on a schedule, in CI, in a pre-push hook and as Autobuild verify steps. Three setup breaks used to make them exit quietly or pass, and now always exit `2` with one line on stderr per cause:

```
idiom <mode>: <cause>: <subject>: <what happened> — fix: <how>
```

| Cause | When | Key | Fix the line names |
| --- | --- | --- | --- |
| `app-start` | the server exited, timed out, could not spawn, pinned its port, or found the port in use | `app-start` (one for the project; the ticket lists the flows) | the server failure's own fix, then `idiom doctor <flow>` |
| `baseline` | no recorded baseline is reachable (`baseline-missing`); the checks configuration changed since it was recorded (`baseline-stale`); nightly's baseline covers none of the checked states (`baseline-uncovered`); the gate has neither a baseline nor a base capture (comparison mode `none`); `idiom verify` cannot resolve the capture it verifies against | `baseline:<flow>` | `idiom baseline record <flow>` or `idiom baseline advance <flow>` on main, committed; for verify, `--against <run directory>` |
| `expectation` | a captured state's `expect` no longer matches (text, selector or status), even when the baseline already held the mismatch | `expectation:<flow>/<state>` | fix the app, or the state's `steps`/`expect` in its flow file; confirm with `idiom capture <flow> --states <state>` |

A state whose expectation stopped matching is **broken coverage**: `check` prints `broken coverage: <state> (<coordinates>) — expect no longer matches; not counted as reviewed`, `--json` adds `brokenCoverage: [{ state, viewport, colorScheme, mismatches }]`, and neither `--changed`/`--gate` nor the digest count the state as reviewed. The `missing-state` finding is unchanged, so an interactive `check` behaves as before.

Conditions outrank findings: a gate with a broken state and new findings prints its normal report, then the condition lines, and exits `2`, not `1`. The lines replace the usual `Fix:` line. `--json` output is unchanged except for an additive `conditions: [{ key, cause, line }]` (gate and nightly), and nightly's `conditionOutcomes`.

**One ticket per cause.** With a tracker (below), each distinct key files one triage ticket, titled `Idiom cannot <run|compare|review> <subject>: …`, and later runs update that same ticket's body (last seen, run count) instead of filing again. The body ends with `<!-- idiom-condition: <key> -->`, so the ticket is found again from `ab ticket list --labels <first label>` even when the local record is gone, as in a fresh build worktree. When a run that covers the cause passes (the app started; the flow compared against a usable baseline; the state captured cleanly at every coordinate that broke), the ticket gets one `Cleared: <date> by <mode>` line and stays where it is: Idiom never moves a ticket. A run that skipped the state clears nothing. Filing problems are one extra stderr line each and never change the exit.

**Where they go.** Nightly files through its own sink (autobuild triage; a directory sink records only). The gate and verify step file when `unattended.tracker` resolves to autobuild: `auto` (the default) means `autobuild.toml` above the project and `ab` on `PATH`; `off` never files; `IDIOM_UNATTENDED_TRACKER=off|autobuild|auto` overrides the config, for CI and tests. `ab` runs without the build session's `AB_BUILD`, `AB_PHASE` and `AB_SESSION`, and files into the first state whose roles include `triage`; labels are `unattended.labels` (default `idiom`, `idiom-condition`).

**Where they are remembered.** Every condition is recorded in the gitignored `.idiom/reports/conditions.json` of the **primary checkout** (from a linked worktree, the main one), under a lock, so `idiom doctor` in the main checkout lists what gate and verify runs raised inside build worktrees. The exit and the line never depend on that record.

**Watch.** A future watch mode must report each run through the same entry point (`reportConditions({ mode: "watch", … })` in `src/unattended/file.ts`).

## Exit codes and setup failures

Every command that captures uses the same exit codes:

| Code | Meaning |
| --- | --- |
| `0` | the run completed and the gate passed |
| `1` | the findings gate failed (`--fail-on`), or another error occurred (usage, I/O) |
| `2` | the run could not happen: a refused precondition, a server that did not start, or a capture that could not start |
| `3` | `check` deferred review: the host was busy and selected tuples still timed out after retry (additive at interface version 1) |
| `4` | `check --gate` has unresolved explicit decision questions and no ordinary eligible failure (additive at interface version 1) |

For an executed `check --gate --json`, `decisionNeeded` lists explicit reference
conflicts and stored ruling questions; `decisionQuestion` is the complete numbered,
ready-to-answer text with evidence paths, citations and quoted `idiom decide`
examples. Each checked flow retains the same fields. Ordinary defects still fail.
Run failures take precedence (2), then default host deferral (3), then ordinary
eligible findings (1), then unanswered questions (4), then success (0).
`--deferred warn` continues that evaluation. `--fail-on never` disables severity
and decision gates while retaining truthful question JSON; default deferral still
returns 3. Plain checks expose questions but keep their existing severity status.
Non-UI skips and `--plan-only` do not scan old reports for questions.

A navigation or readiness timeout gets one retry after the other tuples finish, in a fresh browser context with twice its navigation/readiness deadlines. Action, screenshot and probe budgets keep their original deadlines. Recovered captures pass normally and reports name the retry.

With the default `--deferred fail`, when retries still time out and recorded host pressure explains them, `check` returns `3` even with `--fail-on never` or genuine findings elsewhere. JSON adds `verdict: "deferred"` and `timedOutTuples: [{ state, viewport, colorScheme }]` to the normal result, without a second error object. Those coordinates remain failed coverage but add no timeout `missing-state` findings. Default baseline initialization is skipped. Idle-host timeouts remain blockers. `check --from` uses recorded pressure; editing config or running later on an idle machine does not reclassify it. Changed/gate checks return `3` if any checked flow defers; their aggregate JSON adds the same fields with `flow` on each coordinate. These additions retain interface version 1.

A run that could not happen prints its cause as the **first line** on stderr, with no `Error:` prefix, followed by any existing detail and a `Fix:` line:

```
server failed to start: exit 1 — Error: DATABASE_URL is not set
application server exited before readiness (exit 1): …
Fix: add DATABASE_URL to server.env in .idiom/project.json
```

The first line is one of:

- `config invalid: …` (cause `invalid-config`, or `no-project` when no `.idiom/project.json` is found)
- `finding-name registry refused: …` (`finding-name-registry`)
- `baseline refused: tree dirty: <up to 5 paths>[ (+N more)] (commit or stash, or pass --all)` (`tree-dirty`)
- `baseline refused: …` for a project outside a Git worktree (`not-a-git-worktree`)
- `no recorded baseline for "<flow>" reachable from HEAD in <path>` (`baseline-missing`)
- `server failed to start: exit <code>|signal <name> — <last stderr lines, redacted>` (`server-exited`)
- `server failed to start: timeout after <ms>ms waiting for <readyUrl> — <last stderr lines>` (`server-timeout`)
- `server failed to start: could not spawn — …` (`server-spawn`)
- `server failed to start: port pinned — started on <configured>, not reserved <port>` (`port-pinned`)
- `server failed to start: port <n> in use — <readyUrl> already answers` (`port-in-use`)
- `capture failed to start: browser launch — …` (`browser-launch`)
- `capture failed: <n> tuple(s): …` (`capture-failed`, MCP `idiom_check` only)
- `baseline refused: the captured tree was dirty` (`tree-dirty-after-capture`)

With `--json`, `check` and `baseline record|accept` also print `{ "flow": …, "failure": { "stage": "preflight"|"server"|"capture", "cause": …, "hint": …, "message": … } }` on stdout; `tree-dirty` adds `paths`. MCP tools return the same object as `structuredContent.failure`.

Every `--json` payload is an object whose first key is `interfaceVersion`. Which payloads and fields are stable is in [stability](stability.md#json-output).

Server failures exit `2` from any command that starts the server (`capture`, `check`, `review`, `sweep`, `verify`, `baseline record`). Preflight runs only for `check` and `baseline record|accept`; `review` also checks the finding-name registry before a fresh capture.

## Update notices

When a newer Idiom release exists, `idiom init`, `check`, `review`, `doctor` and `idiom --version` print one line on stderr after all their other output, including a failure's `Fix:` line. The exit code is unchanged:

```
Idiom 0.19.0 is available (you have 0.18.0). Update: idiom upgrade
```

With `--json` the line is not printed. Instead the JSON object gains `"update": { "current", "latest", "command" }`, and only when a newer release exists. `idiom mcp` delivers the same notice to agents; see [mcp.md](mcp.md#update-notices).

The update command depends on how Idiom was installed:

| Install | Update command |
| --- | --- |
| `npm install -g` | `idiom upgrade` |
| `bun add -g` | `idiom upgrade` |
| `npx` (including a hand-run `npx --package=<tarball>`) | `npx -y @mattskilly/idiom@latest upgrade` |
| `bunx` | `bunx @mattskilly/idiom@latest upgrade` |
| Claude Code plugin | `claude plugin marketplace update idiom && claude plugin update idiom@idiom` |
| Codex plugin | `codex plugin marketplace upgrade idiom && codex plugin add idiom@idiom && codex mcp add idiom -- npx -y --package=<new release tarball> idiom mcp` |

For the two global installs, [`idiom upgrade`](#upgrade) runs the package manager itself and then updates the project's skills. The Codex row applies when Codex starts the MCP server (the `codex mcp add` line), which Idiom recognizes by the MCP client name. The CLI never reports the Codex command.

A source checkout, or an install whose kind Idiom cannot identify (for example a project-local dev dependency), never checks.

**What is requested.** One `GET <registry>/@mattskilly%2fidiom/latest`, where `<registry>` is `NPM_CONFIG_REGISTRY` (or npm's `npm_config_registry`) and otherwise `https://registry.npmjs.org`. The request sends only `accept: application/json` and `user-agent: idiom/<version> (node <version>; <platform>)`. It carries no project, path or user data, and nothing else is ever reported. The check gives up after 3 seconds and runs alongside the command, so it never delays a command by more than that plus one small local cache write. Any failure, timeout, malformed answer or prerelease is silent.

**Cache.** The answer is cached per user for 24 hours in `update-check.json` under `$XDG_CACHE_HOME/idiom/`, else `%LOCALAPPDATA%\idiom\` on Windows, else `~/.cache/idiom/`. A failed check is retried after an hour. A cache hit makes no network request, and the cached version is compared with the version now running, so the notice disappears as soon as you update.

**Turn it off.** Any of these disables the check, and no network request is made:

- `IDIOM_NO_UPDATE_CHECK=1`
- `NO_UPDATE_NOTIFIER` set to any value
- `CI` set (other than `false` or `0`)
- `"updateCheck": false` in `.idiom/project.json` ([configuration.md](configuration.md#update-check))

## reference

Add a URL at an exact configured viewport, or copy a local image, with a required note that says what the review should follow or avoid:

```sh
idiom reference add editorial-density --url https://example.com/design --viewport desktop --note "Use the compact type scale and information density."
idiom reference add gmail-register --file ./research/gmail-paste.png --note "Match the plain, utilitarian register."
idiom reference add booking-widget --file ./research/widget.png --note "Avoid glossy SaaS booking chrome." --anti
```

List both catalogs or remove one exact managed entry:

```sh
idiom reference list
idiom reference remove editorial-density
idiom reference remove booking-widget --anti
```

Managed entries live in name-addressed directories beneath `.idiom/references/` or `.idiom/anti-references/`, with the image and a versioned `reference.json` note/provenance record. URL entries record the exact requested source, capture date, viewport name, and dimensions. URL capture uses the same pinned Chromium context as flow capture but stores exactly the named viewport rather than an unbounded full page; it rejects non-2xx responses and images outside the model transport's dimension or encoded-size budget before publication. It makes no model call and publishes nothing if navigation, validation, or screenshot capture fails. Local `--file` adds accept PNG, JPEG, WebP, or GIF, preserve the source bytes, enforce the same dimension and encoded-size budget for every accepted format, and launch no browser, network request, or model, so they work offline. Existing loose image and text references remain review context but are intentionally not mutated by `reference remove`. A malformed managed record is skipped by listing and full review but remains removable by its name, so one damaged entry cannot disable the catalog.

## capture

From a configured checkout of the booking app, the complete booking baseline is one command:

```sh
idiom capture booking
```

The equivalent explicit forms are:

```sh
idiom capture booking --project /path/to/booking-app
idiom capture booking --project /path/to/booking-app --out /path/to/baseline
idiom capture booking --project /path/to/booking-app --out ./baseline
```

Relative `--out` paths resolve from the directory where the command is invoked, even when `--project` selects another directory. In the last example, `./baseline` is beneath the invoking directory. An absolute `--out` path identifies that exact directory.

Without `--out`, each run gets a new timestamped directory under the selected project's `.idiom/reports/`. An explicit output path must not already exist and is never overwritten. A custom path inside the target repository must either be under `.idiom/reports/` or covered by the repository's ignore rules; otherwise capture fails before setup so its own output cannot change the next run's source dirty flag. The run-level `baseline.md` links each capture tuple and its six artifacts. Existing singleton projects retain `state/viewport`; projects declaring multiple top-level `colorSchemes` use `state/viewport/colorScheme`:

- `screenshot.png` — full-page, animation-disabled rendered output
- `dom.html` — rendered DOM after the configured settle period
- `console.jsonl` — console messages and uncaught page errors
- `axe.json` — raw accessibility scan data
- `observations.json` — browser-time geometry, heading, computed-style, hit-test, and configured-token facts without review verdicts
- `metadata.json` — commit/dirty identity, flow, state, viewport, selected color scheme and axis status, target provenance, timestamps, platform, browser/runtime, and Idiom versions

For a faster iteration, scope a fresh `capture` or `check` with comma-separated lists:

```sh
idiom check studio-lab --states editor,settings --viewports desktop --schemes light
idiom capture studio-lab --states editor --viewports mobile,desktop
```

Omitted flags retain the flow's full effective matrix. Lists trim whitespace and reject empty, duplicate, unknown or flow-excluded values. Selection preserves manifest order, intersects each state's viewport restrictions, and supports published-flow widths. State IDs match exactly, including generated route and toggle IDs: selecting a base state does not select its generated combinations. A scope with no effective tuples fails before setup, builds, server launch or output creation. Internal finding verification continues selecting exact coordinates.

Every new capture writes a versioned `run.json` alongside the tuple artifacts, recording its source, declared and selected matrices, probe placement and capture timings. `baseline.md`, `report.md` and `report.html` disclose selected versus successful tuples, intentionally skipped tuples, omitted states/viewports/schemes, and unsuccessful selected tuples. `check --json` includes structured `scope`, `coverage` and `timings`, even for clean checks. Scope flags require a fresh capture and cannot accompany `check --from` or `--latest`; replay uses the stored scope. Unscoped `--latest` skips recorded partial runs. Older runs without a record retain legacy full-matrix behavior. Uncaptured baseline coordinates remain uncovered when comparing findings.

Live probe progress goes to stderr before initialization and as each attempt starts/finishes, including state, completed count, selector and phase. Library callers can supply `onProbeProgress`; otherwise they remain silent. Timings also retain the five slowest attempted controls across the run, including selector, elapsed milliseconds and timeout outcome. JSON stdout remains a single result; stored-run replay preserves these historical control timings.

Completed `capture` and `check` commands print phase timings to stderr in milliseconds: build, server readiness, each tuple capture, probe, and deterministic checks. Tuple totals include probe time, which is displayed as an included submeasurement. Statuses distinguish measured, reused, skipped, unsupported and unavailable work. Capture-only runs skip checks. Rechecking a stored run preserves `run.json` and labels its capture phases as historical evidence; current checks are timed separately in versioned `checks-timings.json`, which also lists each tuple's check time (`tuples`). Legacy historical timings are unavailable. Timing values are excluded from deterministic findings.

Capture runs setup steps sequentially to full process exit. Web targets perform the configured server build, own the application server through readiness and teardown, and use a fresh browser context for every tuple. Electron targets skip the server and launch a fresh application for every tuple. An expectation or tuple-capture failure is recorded in metadata and the completed report; remaining tuples still run, artifacts are published, and the command then exits `1`. Setup and fatal publication failures stop immediately with an actionable error. Owned servers and Electron applications are closed on success, failure, and interruption.

Electron evidence has two disclosed provider boundaries. Diagnostics are one final snapshot of the selected renderer's last 200 Playwright-retained console messages followed by its last 200 page errors; auxiliary windows are excluded. Accessibility uses axe legacy mode because an Electron persistent context cannot open axe's normal aggregation page. Cross-origin frames are therefore not analyzed, and axe's `frame-tested` rule identifies untested frames. All six artifact names and downstream behavior remain the same as web capture.

Before publication, Idiom scans every staged artifact for non-empty inherited or configured environment values named `*_TOKEN`, `*_SECRET`, or `*_KEY`. A match identifies only the variable and artifact, removes the private staging/data directories, and publishes nothing. Capture makes no model or external API calls; after dependencies and Chromium are installed, its only HTTP traffic is to the configured loopback application.

Reproducibility is a same-machine contract because the booking app deliberately uses system fonts. Context settings, device scale, iteration order, and artifact paths are pinned. The app also intentionally mints new private booking slugs on every fresh seed: Idiom uses the raw setup-derived URL for browser navigation and persists the stable setup-output declaration plus a state-keyed URL template. Therefore unchanged consecutive runs have equivalent screenshots and metadata after removing only the named timestamp fields.

For setup-stdout-derived navigation values, saved DOM, console and accessibility text replace the complete URL, non-root pathname and every nonempty route segment, including encoded/once-decoded segments and their ordinary JSON-string and HTML-entity forms. The same sanitizer covers captured observation/timeline strings and tuple failure messages. With no route schema to identify private parameters, every segment is a candidate, including short ones. Bare segments match complete tokens rather than substrings inside larger words, CSS identifiers or percent escapes. In saved DOM and accessibility HTML snippets they are replaced in text and attribute values, never in tag or attribute names, and in selectors never in tag-name position (so a route segment such as `b` or `button` leaves the markup and path-style selectors intact). Captured observation/timeline text and selector identities are redacted while structural fields (such as statuses, tag/role names and measured CSS) remain intact; selector-keyed screenshot geometry follows the redacted selectors. Probe rounds and replay merges use raw in-memory identities, with redaction applied to their completed evidence before checks and saving. Literal state URLs are recorded exactly. Screenshot pixels and the rendered browser state are unchanged. This bounded replacement does not discover arbitrary secrets or all possible encodings; the separate environment-value publication scan still checks configured secret values before publication.

Probe, time-budget and color-scheme settings are in [configuration.md](configuration.md#capture-settings); production builds are in [configuration.md](configuration.md#production-builds).

**Development-server warning.** A development server behaves differently from production (error overlays, unminified timing, dev-only console warnings), and findings it causes are not real. While capturing each HTML page, Idiom looks for signs of one: a Vite client script (`/@vite/client`), a webpack dev-server or hot-middleware client script, a framework error overlay element (`<vite-error-overlay>`, `<nextjs-portal>`, the webpack dev-server or React refresh overlay), a Next.js development build (`__NEXT_DATA__` `buildId: "development"` or `/_next/static/development/` scripts), or a React development build (a `react-dom.development.js` script, or development-only debug fields on React's rendered elements). `capture` and `check` then print one warning naming the first sign and where it was seen, for example `Warning: booking looks like it was captured from a development server (script /@vite/client on home/desktop). …`, suggesting `server.build` with a production start command. The sign is recorded in `run.json` as `devServer: { kind, evidence, state, viewport, colorScheme }` (`kind` is `vite-client`, `webpack-dev-server`, `error-overlay`, `next-development` or `react-development`) and `check --json` carries it as `devServer`. Detection never fails a capture and changes no finding. Set `checks.devServer` to `"allow"` to skip it; see [configuration.md](configuration.md#checks).

### Capture a fixed commit

```sh
idiom capture booking --ref HEAD~1
idiom check booking --ref HEAD~1
```

`--ref <commit-ish>` resolves a local commit once, creates an owned detached worktree under the invoking project's `.idiom/cache/worktrees/`, then builds and captures that revision. It uses the revision's committed project configuration, named flow, setup commands, design inputs and application sources, preserving nested project locations. The invoking checkout can advance or remain dirty while the capture stays pinned. Missing history is not fetched automatically.

| Command | Option | Meaning |
| --- | --- | --- |
| `capture` | `--ref <commit-ish>` | Fresh capture of a fixed commit; supports scope, `--prod`, `--port` and `--out`. |
| `check` | `--ref <commit-ish>` | Fresh capture and review, with baseline ancestry and initialization pinned to that commit. |

For Node applications with dependencies, Idiom installs into the detached tree from its own metadata: Bun/pnpm use `install --frozen-lockfile`, npm uses `ci`, Yarn 1 uses `install --frozen-lockfile` and modern Yarn uses `install --immutable`. The matching executable must be installed and dependency downloads may require network access. A package without a lockfile uses `npm install --package-lock=false`, which has weaker dependency reproducibility. Dependency-free projects need no implicit install. Configured flow setup runs afterwards. Non-Node projects use their configured setup/build. The total `capture.maxMinutes` budget includes preparation and dependency installation.

The environment is inherited, but untracked `.env` files and caller `node_modules` are absent. Supply needed environment variables before invoking Idiom or use committed setup configuration. Ref captures always start an owned server, including when the revision config enables `server.reuse`; production build reuse is disabled. `check --ref` cannot accompany `--from`, `--latest`, `--changed`, `--gate` or explicit `--reuse-server`. Scope, `--all`, `--since-baseline` and `--baseline-file` retain their existing restrictions.

Reports, finding/ruling names, decisions, agent records and baseline JSON/pixels belong to the **invoking checkout's project**, including when it is a linked worktree. Relative `capture --out` still resolves from the original invocation directory and follows the same destination-safety rules. A default `check --ref HEAD~1` can initialize a baseline for that historical commit without `--all`. `--ref` alone adds no decision-log entry, and stored reports remain usable by `idiom decide` after cleanup. Temporary worktrees are removed on success, failure, SIGINT and SIGTERM after owned processes stop; SIGKILL cannot guarantee cleanup. Cleanup failures are reported.

## check

Temporal findings include an optional `filmstrip` path in `--json`, including baseline comparisons and grouped representatives. `screenshot` still names static evidence. Markdown reports link the contact sheet, and HTML reports show it inline with horizontal scrolling, including deferred findings. Stored reports embed the PNG and need no browser session to regenerate. See [filmstrip configuration](configuration.md#capture-settings) for explicit action requests and offsets.

`idiom check` protects the flow against regressions by default. On the first check without a reachable baseline it records the already captured clean HEAD, announces the acceptance, and passes: existing defects become pre-existing. Commit the generated `.idiom/baselines/<flow>.json` (and the pixel directory for a published flow). Later checks report **New**, **Fixed**, and **Pre-existing** findings with the baseline SHA, and gate only new live deterministic occurrences. The capture runs once; repeated checks never advance the baseline automatically. If some tuples failed, the first check records no baseline: it reports the findings for the successful tuples, lists the failed ones as coverage gaps (`captureFailures` and `baselineNotRecorded` in `--json`), prints `Baseline not recorded: 3 of 120 tuples failed (<list>). Findings for the other 117 are above.` on stderr and exits 1, even with `--fail-on never`. A capture interrupted by `Ctrl-C`, `SIGTERM` or a hard kill keeps the tuples it finished in a visible, unverified run; see [troubleshooting](troubleshooting.md#a-run-was-interrupted).

Initialize on the branch state you want to preserve. A dirty or historical capture cannot initialize a HEAD baseline: commit or stash, capture clean HEAD and retry, or use `--all` to inspect every open finding.

Before it starts the server or captures anything, `check` runs a preflight: it validates the project and flow, reads the finding-name registry and, when this run would record the first baseline from a fresh capture, checks that the tree is clean. A refused preflight exits `2` in seconds with one line, for example `baseline refused: tree dirty: src/app/page.tsx, styles.css (commit or stash, or pass --all)`. Files Idiom writes itself and Git-ignored paths never count as dirty; [configuration.md](configuration.md#baselines) lists them. See [Exit codes and setup failures](#exit-codes-and-setup-failures). Once a baseline exists, checks can compare dirty working changes normally. After intentional changes, run `idiom baseline accept <flow>` and commit the updated record. This is model-free and repeatable:

```sh
idiom check studio-lab                 # initialize once; then gate new findings
idiom check studio-lab --latest        # reuse the newest passing capture at HEAD
idiom check studio-lab --from <runId>  # or a specific stored run
idiom check studio-lab --baseline <runId>  # only findings that run did not have
idiom baseline accept studio-lab       # explicitly accept intentional changes
idiom check studio-lab --since-baseline # strict: require an existing reachable record
idiom check studio-lab --emit-tickets .autobuild/tickets # propose clustered repairs in triage
idiom check studio-lab --all --top 10  # show ten top issues first in the full view
idiom check studio-lab --all           # report AND gate every open finding; expand siblings
idiom check studio-lab --json          # new findings, fixed and preExistingFindings
idiom check studio-lab --fail-on minor # exit non-zero at this severity (default major; or never)
idiom check studio-lab --all --ungrouped # full view, one entry per finding
idiom check studio-lab --probe-budget 0 # no probe run target for this capture
```

`check --json` includes optional `humanFound` counts and open entries when human-found misses have been logged; see [learn](#misses-idiom-has-not-caught-yet). The same metric appears once in text summaries.

**Trend across runs.** Every check summary ends (before `Full report:`) with the flow's trend over its last five checked runs, oldest first, so a team can see whether the flow is getting better or worse:

```text
Trend for booking (last 5 runs, oldest first; open blocker/major/minor, acknowledged and rejected excluded):
  2026-11-01 abc1234  0/3/5
  2026-11-03 def5678 (dirty)  0/2/5
  2026-11-05 0a1b2c3  0/1/4  coverage gap: 2 of 12 tuples missing — not comparable
  2026-11-06 9f8e7d6  0/1/4
  2026-11-08 1234abc  0/1/3
```

Each line is a run's completion date, commit (with `(dirty)` for an uncommitted tree) and its open blocker, major and minor counts. The trend reads the digest record each check stores in its run (the same one [digest](#digest) reads), so it starts with the second check of a flow and needs nothing re-run. Only full-scope runs count: runs scoped with `--states`, `--viewports` or `--schemes`, and `--changed` and `--gate` runs of part of a flow, are left out. Counted findings are open deterministic occurrences at blocker, major or minor; info, tuple failures, acknowledged findings and rejected findings are not counted. The current decision log applies to older runs too: a finding rejected today (by rule, or by its finding id) no longer counts in the runs before the decision, so older counts can drop after a decision. A run with failed, interrupted or busy-host tuples is marked `coverage gap: N of M tuples missing — not comparable` (or `deferred (busy host)`), so a drop caused by missing tuples is not read as improvement. One run prints no trend. `--json` carries the series as `trend: { flow, runs: [{ runId, completedAt, commit, dirty, blocker, major, minor, coverageGap? }] }`, where `coverageGap` is `{ missing, selected, kinds }`; it includes a single run. `--gate` and `--changed` print and carry one trend per flow summary. [`idiom report`](#report) prints the trend for every flow.

Every check ends its stderr with one **Timing** line naming where the run's time went and the slowest phase, for example `Timing: 2m41s — build reused, server start 12s, capture 1m50s (probe 1m02s), checks 9.0s; slowest: probe`. Capture is wall clock from browser launch to the last tuple; the probe is summed lane time and is included in capture. `--json` carries the same breakdown as `timing` (`totalMs`, `phases.{build,serverStart,capture,probe,checks}`, `slowest`). Multi-flow `--changed` and `--gate` runs print one line per flow and a combined line last. The multi-line `Timings:` block above it is unchanged. When a check is slow, read this line before reaching for anything else.

Every check that probed prints **Probe coverage**: per state, how many controls the interaction probe completed, timed out on or never reached, and the most common not-reached reason. A warning follows when more than 10% were not reached. `--probe-budget <ms>` sets the probe's run target for one fresh capture (default `checks.probe.flowBudgetMs`, 400000); `0` means no target. It cannot be combined with `--from` or `--latest`. See [configuration.md](configuration.md#capture-settings).

The full `--all` view starts with **Top issues** (five by default, adjustable with `--top <n>`), ranked by salience × prominence, then worst severity and first-seen order. Salience is a fixed rule/category policy. Prominence uses viewport-clipped area, visibility, primary region/action and bounded logarithmic state/place breadth. Known deterministic rules aggregate across selectors, with explicit adjacent-gap and clipping repair families. Compact output shows one prominent example and the family occurrence count; `--all` exposes every original group's evidence, rule and decision command. See [the ranking model](ranking.md) for the normative salience table, exact formula, fallback grouping, tie rules and worked example.

Findings from different rules that share one source — the same design token or custom property, component, authored style rule or failing region — appear as one **root cause** entry (for example ``N. [minor] root cause — `--r-md` is not applied: 9 controls render 4px against 8px``), followed by its confidence, grouping evidence, a suggested fix where there is one, and every symptom (rule, element, measurement, group id). It ranks by its best symptom plus a bounded breadth factor. `--all` lists each symptom group with its own decision command; JSON adds `rootCause` to the issue, with every symptom's finding ids, fingerprints and status. Findings, groups, decisions and `--fail-on` are unchanged.

The same element failing the same rule in several states, viewports or color schemes remains one group: `Seen: seen in 2 states; viewports: mobile, mobile-short; schemes: light, dark (8 coordinates)`, member finding IDs, one representative crop, and `idiom decide --group <id>`. A collapsed issue's decision command applies only to its example group; use `--all` to decide other elements individually. Finding IDs, fingerprints and decisions stay per member, so `--fail-on` and the blocking count are unchanged, and a decision on one member still suppresses only that member. `--all --json` keeps every open finding in the flat `findings` array and the existing `groups`, each with every member and its coordinates (`state/viewport[/scheme][#combination]`). It adds the complete ranked `issues` array with group IDs, element/places/finding counts, constituent rules, salience, prominence, score, the primary-action signal and the winning score inputs. Every group appears in exactly one issue. Default JSON uses `findings` for new occurrences and `preExistingFindings` for existing occurrences, with `fixed` and `baseline` provenance. Full mode JSON also includes `groups` and `issues`. Reports, `groups.json` and legacy `--baseline` retain their existing forms.

`--emit-tickets <dir>` writes spec-standard proposals for this check's persisted, actionable findings, grouped by observed component and category within the flow; the symptoms of one root cause form one ticket across categories, with an "all symptoms clear" criterion. It requires no acceptance decision and creates none. Deferred-only and occurrence-only rows are excluded; in default and recorded-baseline modes, only reported new material findings qualify. The directory is a **file tracker root**: `.autobuild/tickets` writes beneath `.autobuild/tickets/triage/`; passing the `triage/` directory itself works too. Existing member identities suppress retries, including after a ticket is renamed or promoted. Crop links point to the retained report, with full screenshots as fallback and missing crops marked unavailable. Ticket counts, covered IDs and paths appear in text and the optional JSON `tickets` result. Emission runs before `--fail-on` is applied, so a failing check still deposits its requested proposals. Without the flag, check output and behavior stay unchanged.

A recorded baseline is a small committable file at `.idiom/baselines/<flow>.json`: deterministic finding fingerprints and aliases per state, viewport, color scheme and combination, plus the captured commit, version and checks configuration hash. It contains no screenshots. `baseline record <flow>` and `baseline accept [flow]` require a clean captured tree and accept `--from <runId>`, `--latest`, `--prod`, `--port`, `--json`, `--isolated-registry` and `--out <directory>` (overrides both JSON and pixel destinations). Accept infers the flow only when exactly one is configured; otherwise it lists the choices. It stores the capture's commit, even when replayed later, and replaces an existing record for that commit. Each file retains up to twenty records.

`baseline record <flow> --resume` continues the newest capture of the flow when it was interrupted: by `capture.maxMinutes`, a crash or a signal. It keeps every tuple whose evidence was final (after its probe and design reference), captures only the rest, and records one baseline over all of them, the same one an uninterrupted capture records when the probe is not time-bound (finished states keep their evidence; remaining states are probed within the run's budget). It needs the same commit and a clean tree, the same capture configuration, selected tuples, toggle declarations, Idiom version and production mode as the interrupted run, and refuses otherwise with the reason, for example `cannot resume run <id>: it captured <commit> but HEAD is <commit>`. It cannot be combined with `--from` or `--latest`. With toggles, a base state's combinations at one viewport and scheme are kept or recaptured together; a state that ran out of `capture.stateMaxMinutes` is always recaptured. The kept and new tuples become one ordinary complete run under `.idiom/reports`, which `--from` and later gates read like any other; the interrupted run is left as it was. A fresh baseline capture that stops says how many tuples it kept and prints the `--resume` command.

In text mode, `baseline record` prints the slowest tuples on stderr with their capture, probe, artifact, secret-scan and check times (`timing.slowTuples` in `--json`). Tuples of a state over `capture.stateMaxMinutes` are left out of the baseline, and a line names the state, the limit and the step; `--json` lists them in `stateBudgetFailures`.

`baseline advance [flow]` records the target branch's tip for the build gate instead; see [Gate a build](#gate-a-build).

Default checks and `--since-baseline` select the recorded ancestor nearest HEAD by Git commit distance, with recording time breaking ties. Demonstrably unrelated branch records are skipped and retained. Missing Git objects or shallow-history uncertainty require fetching more history; they never authorize replacement. `--since-baseline` requires an existing reachable record. `--baseline-file <path>` selects only that compact file (relative to the invocation directory), also strictly: missing, malformed, wrong-flow or unreachable files fail without initialization. `--all` cannot accompany any baseline selector, and the three explicit selectors cannot be combined. Text and JSON separate **new**, **fixed** and **pre-existing** findings. The exit status and `--fail-on` apply only to new live deterministic occurrences, with rules, severity overrides and review lifecycle status applied. Each viewport participates independently, including findings beyond the report's attention cap. Fixed rows use the baseline's stored severity; a missing or failed tuple is listed as uncovered and cannot establish a fix. Suppressed findings still count as present evidence when deciding whether a defect was fixed.

A finding acknowledged with `idiom decide <finding> --ack <reference>` is listed under `Acknowledged (not counted): N`, one `- finding-12 [major] … — acknowledged (ABC-123)` line each, and is left out of the new and pre-existing counts, `blocking` and `--fail-on`, in every mode (default, `--since-baseline`, `--all`, `--changed`, `--gate`, `sweep`). It is never reported as fixed while it is still observed. An acknowledgement that lapsed prints one line saying why, for example `finding-12 was acknowledged for file-1592, which is now done; it counts again.` JSON adds `acknowledgedFindings` (each with `acknowledged: { reference, until? }`) and `acknowledgementLapses`. See [decide](#reject-accept-or-acknowledge).

A changed normalized `checks` configuration or installed check set warns that the baseline is **possibly stale**; comparison continues. Use `baseline accept` after intentional configuration changes. `idiom review studio-lab --since-baseline` supports the same gate, `--json` and `--fail-on` (the latter only gates review with this flag); model findings are counted separately as unclassified. Review also writes `baseline-comparison.json` beside its ordinary report.

Unlike `review`, `check` lists every open finding, including those past the review's `model.maxFindings` attention cap. `--baseline` makes it a regression gate: findings already present in the baseline run are counted but not reported. `idiom context` carries a **Craft checks** section that tells a builder, before they write anything, what `check` will reject, using the project's own values.

Every check and its settings are listed in [configuration.md](configuration.md#checks). The baseline directory setting is in [configuration.md](configuration.md#baselines).

### Where a new finding came from

When a check finds something that was not there in the previous complete check of the same flow (the run `digest` compares with), it records the commits the finding appeared between: the previous run's commit, where the finding was last absent, and this run's. The report shows it under the finding, and `digest` and `decide --list` show the same:

```
Appeared: appeared between abc1234 and def5678 (4 commits); likely introduced by def5678 "Add promo banner" (file-263).
```

Commits are counted on the first-parent line (`git rev-list --first-parent`), so a merged pull request counts once and its merge commit stands for it; in a squash-merge repository that is every commit. Within the range, Idiom lists the commits whose changed files map to the finding's state, using the same mapping as [`check --changed`](#check-only-changed-states). A shared file (a layout, global CSS, tokens, `.idiom/`) or a file with no known route maps to every state. When exactly one commit qualifies, it is the likely cause; with several, the line lists up to five (`commits touching this state: a1b2c3d, e4f5a6b`); with none, it says `no commit in range touched this state's files`.

For a merge whose subject starts `Merge pull request` or `Merge branch`, the subject shown is the first line of its body (the pull request title). A ticket id in the subject or body is shown in parentheses. Ids are matched with `attribution.ticketPattern` in `.idiom/project.json`, default `[A-Z]+-\d+|file-\d+` ([configuration.md](configuration.md#attribution)). The default also matches strings like `UTF-8`; set your own pattern if that is a problem.

The line also says when the range cannot be tied to commits: `(not a linear range)` when the earlier run's commit is not an ancestor of this one (a rebase or another branch), `(no commits between runs)` when both runs were at the same commit, `; plus uncommitted changes` when this run's tree was dirty, and `; checks configuration changed between runs` when the finding may come from configuration rather than code. Ranges longer than 200 commits record the range only. Nothing is queried beyond the local repository.

Attribution is stored in `<run directory>/attribution.json` when the check runs. A check never fails because of it; if it cannot be written, the check prints one `Warning: attribution not recorded: …` line. To find the exact commit, run [`idiom bisect <finding>`](#bisect).

### Check only changed states

```sh
idiom check checkout --changed              # one validated flow
idiom check --changed                       # every validated flow, affected states only
idiom check checkout --changed main         # explicit base commit/ref
idiom check --changed=main --json --fail-on never
idiom check checkout --changed --states cart,receipt --viewports mobile
```

Put the flow **before** `--changed`: a word immediately after bare `--changed` is its optional base. Ordinary `check` still requires a flow. Without a base, Idiom uses the merge base of HEAD and the locally available remote default branch (preferring origin), then local main/master when remote metadata is absent. If neither a default branch nor a merge base is available, it uses HEAD and explains the fallback. No fetch occurs. A missing repository, unborn HEAD or invalid explicit base is an error.

The diff includes committed changes from base to HEAD, staged changes, unstaged changes and nonignored untracked files, including deletions and both sides of renames. Next app/pages, SvelteKit, Astro and Remix route files and unambiguous colocated files select states at that route. Other sources follow transitive static imports, re-exports, relative paths and tsconfig aliases. A route-local component imported elsewhere selects those routes too. Dynamic URL paths, pathless groups and expanded/chained states use their validated URLs. Runtime rendering and monorepo package graphs beyond tsconfig resolution are not inferred.

Layouts and their dependencies, global CSS entry points, Tailwind/theme config, the project's design and product files (`design.designFile` and `design.productFile`, default `DESIGN.md` and `PRODUCT.md` in the project directory), design tokens and `.idiom/` configuration select every candidate state. A `DESIGN.md` anywhere else (fixtures, templates, another package) is documentation (`kind: "documentation"`) and selects no states, as in the gate. Paths the gate calls non-UI by path select no states either and are reported as `kind: "non-ui"` with the gate's reason: other documentation (`*.md`, `docs/**`), tests, `.github/**`, lockfiles, build scratch, Idiom's own reports and cache, and `checks.gate.nonUi` globs (see [Gate a build](#gate-a-build)). A diff of only such paths selects nothing and launches nothing. A changed file with no route owner or known importer (including deleted shared sources), an uncertain edge inside a global module, a malformed tsconfig and unsupported route conventions also fall back to every state, with the triggering file and reason shown. Narrower uncertainty stays narrow: states whose URL is runtime-derived (`urlFrom`) or whose target is not web join every source edit's selection, and so do the routes whose import walk reached an unresolved, nonliteral or malformed import. That file's `uncertainties` lists why they were added. Runtime builtins such as `node:fs` are external, not unresolved. A known route with no configured states, no changes or an empty explicit-state intersection selects nothing: no server, browser, review, baseline write or successful-check acknowledgment is produced.

Text says `checked N of M states`, explains every file mapping and all-state fallback, and lists skipped `flow/state` identities as `not checked`. N counts successfully checked states; selected counts are separate. Changed JSON is a `{ selection, checkedStates, checks }` envelope. `selection.git` contains requested/resolved base and fallback explanation; `selection.files` contains every changed path, mapping kind/reason, routes, import chains where available and affected states. `selected`, `skipped`, `candidates` and `fallbackFiles` disclose the final scope. Each `checks` entry has its flow and `checked` or `not-checked` status; only checked entries have a normal `summary` and run/report fields within it. Skipped states never count as passing.

Changed mode judges findings against the change's **base** (the merge base with the target branch, or the explicit `--changed <base>`) by default: a finding already present at the base is pre-existing, whatever the committed baseline says. It reads the comparison exactly as the gate does (see [Gate a build](#gate-a-build): a stored record that is current at the base, a cached base capture, or a fresh capture of the base), but has no budget, so it captures the base whenever nothing stored covers it. If the base cannot be captured (it has no committed Idiom configuration, its install or server fails) it warns and compares with the nearest recorded baseline behind the base, else reports live findings with a `baseline not applied` explanation. It **never initializes or advances a committed baseline**. Explicit `--since-baseline` and `--baseline-file` keep their HEAD-relative selection and still require a usable record. `--baseline <runId>` suppresses findings already known in that stored run. Only a successfully recaptured tuple can establish a fix; omitted states remain uncovered. `--all` bypasses baseline comparison, and `--fail-on` gates new/open findings across checked flows with its usual severity policy (`never` disables the findings gate).

`--changed` requires fresh capture and rejects `--from` and `--latest`. Named-flow `--states` intersects inferred states after validating the IDs; viewport/scheme scopes work normally. With no flow, `--states`, `--baseline <runId>` and `--baseline-file` require a flow name. All selected flow options are checked before the first capture. `--prod`, `--advisory` and `--emit-tickets` work per selected flow with that run's provenance. A batch publishes one hook acknowledgment only when all selected captures succeed; failure, cancellation and edits during checking prevent acknowledgment.

### Gate a build

```sh
idiom check --gate                      # every flow, affected states only, 3m budget
idiom check checkout --gate             # one flow
idiom check --gate --budget 90s         # budget: 90s, 3m, 2m30s or milliseconds
idiom check --gate --reuse-server       # capture the dev server already at readyUrl
idiom check --gate --changed main       # explicit base (default: the merge base)
idiom check --gate --json --fail-on major
idiom check --gate --plan-only --json   # the plan or skip only: no server, browser or capture
```

`--gate` is the check to run inside a build loop. It starts from the same changed-file mapping as `--changed` and makes it cheaper, says what it costs before it starts, and fits a time budget (`--budget`, else `checks.gate.budgetMs`, default 3 minutes).

- **Non-UI changes skip.** Documentation (`*.md` except the checked project's own design context, `docs/**`), tests (`test/**`, `tests/**`, `__tests__/**`, `*.test.*`, `*.spec.*`), `.github/**`, lockfiles, build scratch and Idiom's own reports are non-UI by path, as are `checks.gate.nonUi` globs. When every changed file is non-UI the gate prints `no UI changes since <base>; skipped` and exits 0 in well under a second: no import graph, server or browser. When the import graph is **complete** (route entries found, no unresolved, nonliteral or malformed import anywhere, no unmappable states), a script module that no route reaches and that is not a style, markup, asset or static-directory file (`public/`, `static/`, `assets/`, or beside an `.html` file) is non-UI too, so a server-only edit no longer drags in every state. Build and runtime configuration never counts as non-UI this way: `package.json`, `*.config.*` scripts, `middleware.*`/`proxy.*`, `.env*` and `tsconfig`/`jsconfig` change what every page renders, so they gate every state. On an incomplete graph that pass is off and the plan line says `non-UI detection off: <reason>`; declare server-only directories in `checks.gate.nonUi` instead. The design context is `design.designFile` and `design.productFile` (default `DESIGN.md` and `PRODUCT.md` in the project directory); a `DESIGN.md` or `PRODUCT.md` anywhere else (fixtures, templates, another package) is ordinary documentation. A change to the project's design file widens to every color scheme.
- **One viewport and scheme.** Each affected state runs at the first declared viewport and `capture.colorScheme`, unless the change touches responsive styles (`@media` on width/height/orientation, `@container`, Tailwind breakpoint prefixes, `useMediaQuery`, `matchMedia` with a width) or theme styles (`prefers-color-scheme`, `dark:`, `[data-theme`, `.dark`, `color-scheme`, the `colorSchemeAttribute`, global theme files), in added or removed lines or untracked files. Then it widens that axis and says which file did it. Explicit `--viewports` / `--schemes` win.
- **Probe the changed region.** Every probed run records a fingerprint per control (identity, rounded box, a fixed set of computed styles and text) in `observations.json`. The gate compares against the newest stored run with fingerprints that was captured from a clean tree at the base or an earlier commit. A dirty run, or one at a later commit, is never the reference: it may already contain the change (an earlier gate round in the same build, say), and a control the change broke would match it and go unclicked. the probe's own check candidates (duplicate names, glyph and unexplained controls, popups, text buttons) always run; another control is clicked only when it is new or renders differently. The rest are reported as `not reached: gate: unchanged since <runId>`, so probe coverage shows them. With no reference the probe runs unscoped and the plan says so.
- **Judged against the base.** A finding fails the gate only if it is absent at the build's base. Per flow the gate picks the cheapest record that speaks for the base, and prints which as `<flow>: judged against base <sha> (…)`:
  1. a recorded baseline or cached base capture made **at the base**, or at an earlier commit when every file changed between it and the base is non-UI by the path pass above (Idiom's own `.idiom/baselines/`, `decisions.jsonl` and name registries count as non-UI here). This needs no capture and is the common case when the baseline is kept fresh;
  2. otherwise a **cached capture of the base** in the shared base cache (below), reused across builds and worktrees, capturing only the tuples it lacks;
  3. otherwise a **capture of the base**: the same states, viewports, schemes and probe settings as the head, in a detached worktree of the base with its committed configuration and an owned server (as [`--ref`](#capture-a-fixed-commit) does), deterministic checks only, written to the cache. It writes no committed baseline, decision, digest or attribution.

  Base capture is priced like the head (same history, plus 30s for the worktree and dependency install, a default) and runs only when head and base together fit the budget; head coverage is trimmed first and never for the base. When it does not fit, or the capture fails, the gate does not hide it: `warning: base capture skipped (~40s over the 3m budget); comparing with baseline <sha>, N commit(s) behind base <sha> — findings already at the base may be counted as new; run idiom baseline advance <flow>` and it compares with the nearest recorded baseline behind the base. With no baseline reachable either (`no baseline reachable from base <sha>; gating open findings`), the gate has nothing to judge against: it prints its report, then exits `2` with one `baseline` condition line for the flow (see [Unattended runs never fail quietly](#unattended-runs-never-fail-quietly)). A recorded baseline whose checks configuration has changed since is the same `baseline` condition. Records are considered only when they are ancestors of the base: a baseline recorded on a branch that was **squash-merged** is not reachable from the target branch and is ignored, so record on the target branch or use `baseline advance`.
- **Keep the base fresh cheaply.** `idiom baseline advance [flow]` captures the target branch's tip (the remote HEAD, else `main` or `master`; `--target <ref>` overrides) in its own worktree, from any checkout, and writes it to the shared base cache, so the next gates are case 1 with no capture. With no flow it advances every flow that needs it: a flow a stored record already covers by the rule above is `current` and captures nothing, a flow whose stored record is newer than the target is `superseded`, and a flow not on the target yet is `absent`. Only tuples the target commit declares are captured. If any capture fails, that flow writes nothing, the previous baseline stays, and the command prints `idiom: baseline advance failed for <flow> at <sha>: <reason>; the previous baseline is unchanged` on stderr and exits 2. Advances are serialised per project; `--wait <duration>` bounds the wait for another one (default `30m`). `--fetch` fetches the target's remote-tracking branch first, for a post-merge or finalize step. Run it after merges: init and upgrade wire it as an Autobuild finalize step, or as a GitHub job with `--advance-baseline` ([wiring](#wire-agents-ci-hooks-and-autobuild)). `--commit-file` also writes the committed `.idiom/baselines/<flow>.json` for a job that commits it on the target branch; `--prod` and `--json` work as for `record`. The cache lives in the Git common directory (`<git-common-dir>/idiom/base-cache/`), is untracked, shared by every worktree of the checkout, keyed by commit, checks configuration and Idiom build, and safe to delete. See [Advancing on every merge](configuration.md#baselines).

Before any server starts, the gate prints its plan and estimate to stderr:

```
idiom check --gate: 1 state × 1 viewport, probe on ≤23 controls (changed region), server reused (verified), est. 2m10s of 3m budget
```

The estimate uses the medians of up to five stored runs of the flow (capture per tuple, probe per control, server build and start, checks), split over capture lanes; with no history it uses defaults (20s per tuple, 1.5s per control, 30s server start, 5s checks) and says `(no history)`. When it exceeds the budget the gate trims, lowest priority first: ordinary probe controls (a smaller probe allotment; check candidates run first), viewports then schemes that styles widened, the probe itself, then whole states, lowest rank first (route-owned before import-reached before fallback; later flow states first). It never drops below one tuple of the best-ranked state; if that still exceeds the budget it runs anyway and says `estimate exceeds budget at minimum coverage`. Each cut prints `skipped: <kind> <what> — <reason> (~est)`, appears under **Build gate** in the report, and is in `--json` as `gate.skippedWork`.

**Server reuse.** With `--reuse-server` or `server.reuse: true`, a server already answering `server.readyUrl` is captured instead of built and started (`build reused, server start reused` in the timing line). When `server.production.distDir/BUILD_ID` exists, the gate compares it with the build id the ready page serves (Next.js `buildId`) and refuses reuse on a mismatch or when a changed UI file is newer than the build: it then starts a server as usual. Without a build id to compare, reuse is `unverified` and the plan line says so: make sure the server at `readyUrl` is this checkout. Production flows (`--prod`, `"server": "production"`) instead reuse the production build cache keyed on working-tree content (HEAD's tree, the diff and untracked files), so an unchanged dirty tree in a build round does not rebuild.

`--json` adds a top-level `gate` object (`plan`, `skippedWork`, `estimateMs`, `budgetMs`, `server`, `comparisons`, `timing`) to the `--changed` envelope; `gate.comparisons.<flow>` is `{ mode: "baseline"|"base-cache"|"base-capture"|"fallback"|"none", base, baselineCommit?, behindBase?, missingTuples, estimateMs?, baseCaptureMs? }`, and each checked summary's `baseline` adds `source`, `base` and, when a stored baseline was used, `baselineCommit`/`behindBase`; the skip path prints `{"gate":{"skipped":true,"reason":…,"base":…,"line":…,"files":…,"allFlows":[…]}}`. `gate.plan` lists `flows` (every flow with an affected state, before budget trimming) and `allFlows` (every validated flow). `--gate` rejects `--from`, `--latest`, `--all`, `--baseline`, `--since-baseline` and `--baseline-file`; `--states`, `--viewports`, `--schemes`, `--prod`, `--port`, `--probe-budget` (caps the probe allotment) and `--fail-on` work as usual. `--budget` requires `--gate`.

`--plan-only` (with `--gate`) stops after planning. It prints the skip line, or the plan to stdout, and exits 0 without starting a server, a browser or a capture. With `--json` it prints `{"gate":{"planOnly":true,"line":…,"plan":…}}`, or the skip object above. The [GitHub Action](configuration.md#github-action) runs it first so a change with no UI costs no browser install or app setup. `--plan-only` requires `--gate`.

`--handoff <dir>` (with `--gate`) also writes the [fix step's](#fix-findings-inside-the-build) handoff under `<dir>`: `round-N/handoff.json` and `handoff.md` with the top three blocking new findings in rank order (each with selector, state, viewport, measured value, the rule in the director's words with its labelled source, a suggested fix, done-when criteria and copied crops), `progress` against the last kept round (`fixed`, `persisting`, `introduced`, compared by coordinate and fingerprint), `outcome` on re-verify rounds (`commit` when the edits fixed a target and introduced nothing, else `revert`; a reverted round never becomes the baseline), `repairFrom` (the round the next repair works from: this one, or the last kept round after a revert), and `next` (`pass`, `repair`, `stop` after three repair rounds, or `skip`); plus `summary.md` (at most 15 lines) and `transcript.md` rewritten from every round. Exit codes and output are unchanged; `--json` adds `handoff: { dir, round, next, targets, outcome?, repairFrom?, summaryPath }`. It is rejected with `--plan-only` and `--fail-on never`.

`check --deferred fail|warn` controls only busy-host process status, for named,
changed and gate checks. The default `fail` retains exit 3, even with
`--fail-on never`. `warn` prints an explicit incomplete-review warning on stderr
and permits exit 0 only if completed findings pass the severity gate. It never
hides run failure (exit 2), changes capture evidence, or initializes a baseline
from incomplete coverage. JSON remains a single normal result object with
`verdict: "deferred"` and `timedOutTuples` intact. This policy is CLI-only;
MCP deferral semantics are unchanged.

### Run in Autobuild

For the implementing caller after a failed check: Fix the top three findings in rank order (function before appearance), re-run, and stop after three rounds, reporting what remains. One round is one repair batch followed by one check; the initial check is not a repair round. Stop earlier when nothing remains. Repair only within the caller's authorization; remaining blocking findings still withhold completion and do not permit suppressions. The verify agent runs once and deposits its verdict; this does not change the pipeline retry policy.

Interactive init/upgrade offer the pathless `idiom-check` agent gate by default, installing the shared `idiom-verify` skill and discovery link. Gate builds with `--gate --deferred warn`, and move full coverage to a scheduled run. The full run also refreshes the timing history and probe fingerprints the gate plans from:

#### Fix findings inside the build

The **fix step** makes the gate act like the director at verify time: instead of only reporting, the `idiom-check` agent step fixes what it finds before the pull request exists, and returns only what it could not fix. Interactive `idiom init --wire` and `idiom upgrade` offer it (the `autobuild-fix` row) once the gate is wired; it is the one-line swap

```toml
[verify.idiom-check]
kind = "agent"
skill = "idiom-fix"  # fixes up to 3 new major findings per round, 3 rounds
```

with the same command, step name and order, plus the `idiom-fix` skill and its discovery link. A custom `idiom-check` (a check step or another skill) is never rewritten. The skill runs `idiom check --gate --fail-on major --deferred warn --json --handoff .ab/idiom-fix`:

- **No UI change:** `ab verdict skip` with the gate's skip line, in under a second of Idiom time (agent start-up is Autobuild's).
- **Clean:** `ab verdict pass`.
- **New major findings:** the agent edits the application source for the handoff's top three, re-runs the gate, and commits a round the CLI judged `commit` (it fixed a target and introduced nothing); otherwise it reverts its own edits (never stash, reset or clean) and the next attempt works from the last kept round. At most three repair rounds.
- **All fixed:** Autobuild certifies the head it verified, so the step fails with a "fixed in-build" report naming the commits (with a patch fallback). The build returns to implement, which keeps the commits (the managed `ab-implement` section says so) and publishes them; the next verify cycle's gate is clean and passes. The round uses one verify attempt (`[policy].maxVerifyAttempts`); if none are left, the build escalates with `fixed.md`, whose first line is `Idiom fixed every finding in this build; nothing needs a human decision.`
- **Still blocked after three rounds:** the step fails with the CLI's short summary, which becomes the escalation text when verify attempts run out: one line per finding with selector, state, viewport, measured value, the rule in the director's words and the suggested fix. The full transcript and crops attach to the PR as `idiom-fix-report` and `idiom-fix-crop-NNN`.

Decisions (gate exit 4) and guidance rounds behave exactly as in the `idiom-verify` gate. Four gate runs fit the default one-hour session; raise `[roles.idiom-check] sessionBudgetSeconds` for slow gates. Evidence from a fixture build: [docs/field-test/idiom-fix-step.md](field-test/idiom-fix-step.md). To skip agent start-up on changes that cannot affect the UI, add an optional `[verify.idiom-check].paths` list ([configuration.md](configuration.md#autobuild) has an example and the caveat).

```sh
idiom check studio-lab
git add .idiom/baselines
git commit -m "Record studio baseline"
# In each build:
idiom check --gate --fail-on major --deferred warn
# Nightly (CI schedule or cron), complete coverage, new findings filed into triage:
idiom nightly
```

If the gate is slow, read its `Timing:` line or lower `--budget`; don't remove the step.

On the schedule, [`idiom nightly`](#nightly) checks every flow against its baseline, files each new finding cluster into the tracker's triage and ends with the [`idiom digest`](#digest), so whoever triages reads tickets and a short summary instead of the whole report. To gate on the scheduled run instead of filing, keep the check's exit status:

```sh
idiom check studio-lab --since-baseline --fail-on major; status=$?; idiom digest studio-lab; exit $status
```

For a custom deterministic pipeline that handles decision exit 4 separately, a digest wrapper may be useful (this is not the managed agent recipe):

```toml
[commands]
idiom-check = "idiom check --gate --fail-on major --deferred warn || { idiom digest; exit 1; }"
```

A gate run checks only part of the flow, so it never becomes the digest's latest run: the digest it prints describes the latest full run, which the scheduled check keeps current.

The `autobuild.toml` wiring is in [configuration.md](configuration.md#autobuild), and the pull-request workflow in [configuration.md](configuration.md#github-action).

## digest

A short summary of the latest check of a flow, compared with the previous complete check of the same flow rather than only the baseline. It is meant for a daily triage that takes five minutes, and for a clear "nothing new" on quiet days:

```sh
idiom digest studio-lab
idiom digest                         # every flow that has been checked
idiom digest studio-lab --since 2026-11-01
idiom digest studio-lab --since 2026-11-03T08-00-00-000Z --json
```

```
2 new, 1 fixed since 2026-11-05T06-00-00-000Z.
! failed checkout/mobile/light — The declared state did not render during navigation: timeout
+ IDM-0142 [major] idiom:element-content-clipped — cart, checkout — The Pay button label is clipped
- IDM-0098 [minor] idiom:off-scale-spacing — cart — fixed
Also: 1 new minor, 14 open unchanged, 2 not compared, 3 acknowledged.
Report: .idiom/reports/2026-11-06T06-00-00-000Z/report.md
```

`digest` only reads files. It never captures, runs a check or starts a server, so it is instant after any scheduled check. Every `idiom check` writes a small record of what it concluded to `<run directory>/digest.json`: every open, acknowledged and rejected deterministic finding at each coordinate, the run's coverage problems, whether it checked the whole flow, and a hash of `checks` configuration. A check still passes if the record cannot be written; it prints one warning line instead.

**Which runs.** The latest run is the newest check that covered every declared state, viewport and color scheme, complete or not, so a failed or interrupted daily run is what shows up. A partial run (`--gate`, `--changed`, `--states`, `--viewports`, `--schemes`) is never the latest and never compared against. By default the comparison is the newest *complete* full run before it: one with no failed, interrupted or busy-host tuples. `--since <run>` compares with that run id instead (it must have checked the whole flow). `--since <YYYY-MM-DD>` picks the newest complete run finished before midnight UTC that day; `--since <ISO datetime>` the newest finished at or before that instant. Runs checked before this version have no record, so the first digest after upgrading says there is no earlier complete run until two checks have run.

**What it prints**, in this order, in at most 25 lines:

1. The verdict: `Nothing new since <run>, <time>.`, `<n> new, <m> fixed since <run>.`, or `No earlier complete run of <flow> to compare with`. When the `checks` configuration changed between the two runs it adds `Checks configuration changed since then.`: new findings may come from configuration rather than code.
2. Coverage problems (`!`): failed tuples with the first line of the failure, tuples that were selected but never captured, and a busy host. These are not counted as findings.
3. Each new finding at major or above (`+`), one line: id, severity, rule, the states it appears in, and the first clause of the problem. Occurrences of the same element and rule across states and schemes are one finding.
4. Each fixed finding (`-`), at any severity.
5. Counts for the rest: new minor findings, findings open in both runs, findings not compared, acknowledged and rejected findings.
6. The path of the latest run's report.

New and fixed are decided by finding identity (coordinate and fingerprint) at coordinates both runs captured successfully. A finding at a coordinate that failed or was not captured in either run is counted as *not compared*, never as new or fixed. Acknowledged and rejected findings never appear as new or fixed, only in the counts: a finding that went from open to acknowledged has not been fixed. A finding withheld by a rule-scope rejection (`idiom decide --reject --scope rule`) or a `suppress` override in `rules.json` is recorded as rejected. Lists are ranked like `check` (severity, then [impact](rules.md#ranking), then score).

When a section is longer than its share of the budget, its last line says how many more there are: coverage problems take up to 5 lines, fixed findings keep at least 3, and new findings take the rest. With several flows the sections are shared and ids are prefixed with the flow; only more than 8 flows can exceed 25 lines, through one verdict and one report line per flow. `--json` also includes `humanFound` when misses have been logged (see [learn](#misses-idiom-has-not-caught-yet)). It returns the same structure (`flows[]`: `flow`, `run`, `since`, `verdict`, `text`, `configChanged`, `coverage`, `newFindings`, `fixed`, `counts`, `attribution`) with complete lists; only the text is truncated.

When the latest run recorded [where its new findings came from](#where-a-new-finding-came-from), each `+` line ends with the range and the likely commit, without its subject: `… — The Pay button label is clipped · appeared between abc1234 and def5678 (4 commits), likely def5678 (file-263)`. In `--json`, such items carry `introduced` (with `range.from` and `range.to`), and the flow's `attribution` gives the two commits compared (`previousCommit`, `commit`), or `null` when the run has no attribution. The range is always relative to the run's own previous complete run, so with `--since` only findings that were also new then show one. The exit code is 0 whenever a digest is printed, whatever it says; gate on `check`.

Each digest also reports applied human and agent judgments side by side (accept/reject and separate acknowledgement counts). Counts deduplicate exact decision sources across coordinates; occurrence/disposition totals keep their existing meaning. Historical snapshots without sources say attribution unavailable, and unknown legacy actors have an unattributed bucket. Later corrections update the actor partition of an existing snapshot without recapturing or changing its dispositions.

## scorecard

A weekly reading of two numbers: who found each UI problem first, Idiom or the director, and how many of the findings the director decided were accepted. Experimental. It reads only what Idiom already wrote and needs no network, browser or server:

```sh
idiom scorecard                      # the last four ISO weeks, ending this week
idiom scorecard --weeks 8
idiom scorecard --since 2026-10-01   # from that day's week through this week
idiom scorecard --since 2026-10-01 --weeks 2 --json
idiom scorecard --verbose            # every learned record matched to a finding, and why
```

```
Scorecard 2026-W43 to 2026-W46 (ISO weeks, UTC)
Found first (UI problems first found by Idiom vs by the director)
  2026-W43  Idiom 2  director 1  director share 33% (n=3)
  2026-W44  Idiom 1  director 1  director share 50% (n=2)
  2026-W45  no UI problems recorded
  2026-W46  Idiom 1  director 2  director share 67% (n=3)
  Window    Idiom 4  director 4  director share 50% (n=8)
  By category: contrast 1/0, control-gap 1/0, copy 0/1, target-size 1/0, visual 0/1, unrecorded 1/2 (Idiom/director)
  By surface:  store 4/3, cart drawer 0/1 (Idiom/director)
Acceptance (director decisions on findings)
  2026-W43  1 accepted, 1 rejected, 0 acknowledged — 50% accepted (n=2); 1 agent decision excluded
  2026-W44  2 accepted, 1 rejected, 1 acknowledged — 67% accepted (n=3)
  2026-W45  no director accept/reject decisions
  2026-W46  no director accept/reject decisions (1 acknowledged)
  Window    3 accepted, 2 rejected, 2 acknowledged — 60% accepted (n=5); 1 agent decision excluded
Sources: 3 runs (oldest 2026-10-20; 1 watch root), 2 filed tickets, 7 learned (1 undated, not placed), 10 decisions
note: Idiom runs before 2026-10-20 are not stored; Idiom-first may be undercounted
```

**Weeks.** ISO 8601 weeks in UTC, Monday 00:00 to the next Monday, labelled `2026-W46`. By default the last four, ending with the current week. `--weeks <n>` (1 to 52) sets how many. `--since <YYYY-MM-DD>` starts at the week containing that day: alone it runs through the current week, with `--weeks` it is that many weeks. A `--since` after today is an error.

**What it reads.**

- Idiom's side: the `digest.json` record every `check`, `check --gate`, `nightly` and `watch` run writes in its run directory under `.idiom/reports/`, and, when `idiom watch` has run, the same records in the watch tree (`<git common dir>/idiom/watch/<project>/tree/<project path>/.idiom/reports`). A run found in both is counted once. The filing ledger `.idiom/filed-tickets.json` adds the day each finding was filed.
- The director's side: every record in `.idiom/learned.jsonl`, whether from `idiom learn`, the MCP tool `idiom_learn`, `learn --harvest` or `learn --import`.
- Acceptance: `.idiom/decisions.jsonl`, with `reattribute` corrections applied.

**An Idiom problem** is one digest occurrence group in a flow: occurrences sharing a group key, else a fingerprint, so one element failing at three viewports is one problem. Coverage problems (failed or interrupted captures, unmet declared expectations) are not UI problems and are skipped. Open, acknowledged and rejected findings all count: a rejected finding was still found. It was **first seen** at the earliest stored run containing it, or the earliest ticket filed for it, whichever is earlier. A filed ticket whose findings appear in no stored run (its runs were pruned, or ran in a build worktree that was discarded) is its own Idiom problem, first seen when it was filed, with an unrecorded category; it matches no learned record.

**A director catch** is one learned record, dated by the date its imported row gives (`YYYY-MM-DD` is the whole UTC day), else when its harvested comment was written, else when it was recorded. An imported record whose row gives no readable date is *undated*: it is counted in the sources line and never placed in a week, since the day it was imported is not the day it was found. Its category is the imported row's, else the harvested correction's first; its surface is the imported row's, else its flow's.

**Matching.** A learned record and an Idiom problem are the same UI problem when they are in the same flow and the first of these holds (`--verbose` shows which, as `via`):

1. `rule`: the same state, and the record's learned rule, an imported row's check ids or its `target.check` names the finding's rule or category.
2. `selector`: the record's selector or law scope appears verbatim in the finding's group key or problem text.
3. `words`: the same state, and the record's words and the finding's problem text share at least two content words (lowercase, singular, three letters or more, common words dropped), covering at least 60% of the record's.

**Found first.** Matches join records and problems into groups; each group is one UI problem. It was found by **Idiom** when Idiom first saw it strictly before every dated director catch in the group, and otherwise by the **director**. A director date given as a day beats any Idiom finding on that same UTC day. The problem is counted in the week of whoever found it first, under that finder's category and surface; a group of only undated records is not counted. **Director share** = director / (Idiom + director). Category names are shown as each side records them (finding categories are check names; harvested and imported categories are the director's) and are not merged.

**Acceptance.** Of the `accept`, `reject` and `acknowledge` decisions the director (actor `human`, after corrections) recorded in a week, each finding counts once, by its last such decision that week. Rate = accepted / (accepted + rejected), and **n = accepted + rejected**; acknowledged findings are shown beside it, outside the rate. Agent decisions are left out and counted as excluded. The window total sums the weeks.

**Empty weeks.** A week with no UI problems says `no UI problems recorded`, and a week with no director accept or reject says `no director accept/reject decisions`, never 0%. In `--json` their rates are `null`.

**Limits.** The scorecard knows only what was stored. Gate runs inside build worktrees that were thrown away are seen only through the tickets they filed, and runs older than the oldest stored one are gone; the `note:` line says when the window starts before the oldest stored run, so Idiom-first may be undercounted.

`--json` (experimental) prints `{ interfaceVersion, window: { from, to, start, end, weeks }, weeks: [{ week, start, end, idiom, director, total, directorShare, byCategory, bySurface }], overall, acceptance: { weeks: [{ week, start, end, accepted, rejected, acknowledged, n, rate, agentExcluded }], overall }, pairs?, sources, notes }`; `pairs` is present with `--verbose`. A malformed filing ledger prints a warning on stderr and the scorecard runs without it. The exit code is 0 whenever a scorecard is printed.

## escalations

Autobuild builds stop and ask when an agent cannot decide something. Many of those questions are about the UI (which control, what spacing, what wording) and are already settled: a recorded ruling in `DESIGN.md`, a finding the director accepted or rejected with a reason, or a learned law. `idiom escalations` finds those and answers them with the precedent, so only new questions reach a person. Experimental. It reads the local Autobuild store through `ab` and needs no network:

```sh
idiom escalations                # list open escalations, classified, with matching precedent
idiom escalations --answer       # answer the ones precedent settles through ab answer
idiom escalations --history      # every answer Idiom gave, newest first
idiom escalations --json
```

**What it reads.** `ab builds --json`, then `ab build status <slug> --json` for each `blocked` or `paused` build. Every `ab` call drops the ambient build identity (`AB_BUILD`, `AB_PHASE`, `AB_SESSION`, …), as [`learn --harvest`](#harvest-corrections-you-already-wrote) does, so it works inside a build step too. Without `ab` on `PATH` it exits 1 with `idiom escalations needs the autobuild CLI (ab) on PATH`.

**Which escalations are design questions.** Only agent escalations; stall and policy escalations are process by definition and are never touched. The question text is classified with the same deterministic vocabulary harvest uses: UI category words (layout, spacing, copy, interaction, visual), UI nouns (button, footer, dropdown, …), pixel sizes, and the question nouns `control`, `spacing`, `wording`, `copy`, `empty state` and `component`, against build-process words (verify, lockfile paths, spec, scope, test, …). Code spans, fenced code and file paths are masked first. A question is a design question when it has at least two UI hits and more UI hits than process hits. No model is involved.

**Precedent.** Three sources, read-only:

- **Rulings**: recorded rulings with a rule outcome, from `DESIGN.md` and the decision log (one effective law, as `idiom ruling` sees it). Located as `DESIGN.md (recorded ruling ruling-1)`, or `.idiom/decisions.jsonl (ruling ruling-1)` when the ruling is only in the log.
- **Decisions**: the latest accept or reject of each finding in `.idiom/decisions.jsonl`, when its reason is itself about the design (a reason such as "false positive, Idiom bug" is left out). A later decision on the same finding supersedes an earlier one. Located as `.idiom/decisions.jsonl line N`.
- **Learned laws**: `.idiom/learned.jsonl` records that became more than an observation; their rule candidate is the text. Located as `.idiom/learned.jsonl (learned-N)`.

**Matching.** Deterministic term overlap: words are lowercased, stop words and question scaffolding ("should", "which", "spec", …) are dropped and plurals folded; each term is weighted by how rare it is across the precedent (`ln(1 + N/df)`), and a precedent is scored by the cosine of the weighted term sets. Precedents with identical text (a batch of rejections sharing one reason) count once. Each match lists the terms it shares with the question as the reason it matched.

| Threshold | Value | Meaning |
| --- | --- | --- |
| Match floor | 0.15 | A precedent below this score is not listed |
| Minimum shared terms | 2 | A precedent sharing fewer terms is not a match, however rare the term |
| Decisive | 0.35 | The top match must reach this to settle the question |
| Conflict | 0.25 | Any other match at or above this is conflicting precedent; the question is left open |

**Verdicts.** Each escalation is `decisive` (one clear match settles it), `open` (no precedent, below threshold, conflicting precedent, or a guard below), `not-design`, or `answered-before`. Even when precedent settles the question, Idiom answers only when it is safe:

- **Blocked builds only.** A `paused` build is never answered, because `ab answer` on a paused build asks it to resume once its blockers clear; the escalation is left open with `build is paused`.
- **One open escalation.** `ab answer` answers every open escalation on a build at once, so a build with more than one is left open (`build has 2 open escalations`).
- **No answer loop.** A new escalation on a build Idiom already answered usually means the agent pushed back on the precedent; it is left for a person.

Each open design escalation gets one paragraph for the human: the question, the closest precedent with its score and shared terms, and why it was left open.

**Answers.** With `--answer`, each decisive escalation is answered with `ab answer <build> <guidance>`, always with guidance text. Idiom never sends a bare retry, `--dismiss`, `--revise-spec` or `ab abort`, and never answers the same escalation twice. The guidance quotes the precedent verbatim (cut to 600 characters only when longer) and names where it lives:

```text
Idiom precedent answer: this design question is already settled.
Recorded ruling ruling-1 in DESIGN.md says: "Filters with five or fewer options use a segmented control, never a dropdown."
Follow it. If it does not apply to this case, escalate again and say why; a person will answer.
```

A failed `ab answer` leaves the escalation open with a warning on stderr and is not retried. An answering pass holds `.idiom/escalations.lock`, so a manual run and `idiom watch` never answer at the same time; the second fails fast.

**History.** Every answer is appended to `.idiom/escalation-answers.jsonl` (commit it like `decisions.jsonl`) with the build, escalation, phase, question, guidance, precedent (kind, id, location, text, stance, score, shared terms) and time. `--history` lists them newest first with the hint to overrule: answer the build again, or revise the precedent. [`learn --harvest`](#harvest-corrections-you-already-wrote) never records these answers as director corrections. Limit: a record is written only after `ab answer` succeeds, so if Idiom is killed between the two the escalation is answered (and closed) but the history line is missing; it is never answered twice.

**In watch.** Set `"escalations": { "watch": true }` in the project file ([configuration](configuration.md#escalations)) and [`idiom watch`](#watch) runs one answering pass each time it has processed what is pending, logging a line only when it answered something or the pass failed.

`--json` (experimental) prints `{ interfaceVersion, escalations: [{ build, buildStatus, id, phase, source, question, classification, matches, verdict, reason?, summary?, guidance?, answered? }], answered, warnings }`, or `{ interfaceVersion, history }` with `--history`. The exit code is 0 whenever the list prints.

## nightly

The scheduled full check. Builds check only what they change; `idiom nightly` checks every flow against its recorded baseline and files each new problem where the team triages work. To react to each merge as it lands instead of once a night, see [`idiom watch`](#watch).

```sh
idiom nightly                          # every flow; file into autobuild triage or a directory
idiom nightly studio-lab checkout      # only these flows
idiom nightly --severity minor --label design-qa --label ux
idiom nightly --tracker directory --out .idiom/reports/nightly
idiom nightly --dry-run                # print what would be filed or updated
idiom nightly --print-schedule cron    # a crontab line; or launchd
```

For each flow it runs `idiom check <flow> --since-baseline`. Only findings that check reports as **new** are eligible: pre-existing, fixed, deferred, acknowledged and rejected findings are never filed. Findings at or above the severity (`--severity`, then `nightly.severity` in `.idiom/project.json`, then `major`) are clustered like [`idiom tickets --cluster`](#tickets), one ticket per component or shared root cause. Judged findings never qualify.

**Where tickets go.** With `autobuild.toml` above the project and `ab` on `PATH` (`--tracker auto`, the default), each cluster is created with `ab ticket create <title> --body <file> --state <triage> --labels <labels>` in the state whose roles include `triage` (from `ab ticket states --json`), so it works with any configured ticket source. If no state has the triage role, nightly refuses before checking anything. It runs only `ab ticket states`, `list`, `show`, `create` and `update`; it never moves a ticket. Tools propose and humans promote. Without autobuild, or with `--tracker directory`, each cluster is written as `<out>/<cluster id>.md` (default `nightly.out`, then `.idiom/reports/nightly`) with the same front matter as `--emit-tickets`, and the summary is printed. `--tracker autobuild` without `autobuild.toml` or `ab` refuses and names the directory fallback.

**The ticket.** Labels are `--label` (repeatable), then `nightly.labels`, then `idiom`, plus each finding's category. The body says what and why, then every finding id with its coordinate, selector and evidence paths (relative to the project in a tracker ticket), and where it came from: `Introduced: appeared between abc1234 and def5678 (3 commits); likely introduced by def5678 "…" (file-12).`, from the run's [attribution](#where-a-new-finding-came-from), or `commit range unavailable: no earlier complete run`. Acceptance criteria end with `Done when idiom check <flow> --since-baseline no longer reports <ids>, and idiom verify <flow> --spec <this ticket> passes for every embedded finding.` Each finding is embedded as an `idiom:finding` block, so [`idiom verify`](#verify) can prove the fix.

**Never twice.** Each filing is recorded in `.idiom/filed-tickets.json`: the ticket id (or proposal path) and every finding id and fingerprint it covers. Commit it after a run, as you do `.idiom/decisions.jsonl`. A cluster that shares any identity with a recorded ticket is not filed again, even when it gains or loses members:

| The recorded ticket | What nightly does | Outcome |
| --- | --- | --- |
| In triage, open | Updates its body and adds missing labels, only when the findings changed (your labels are kept) | `updated` or `unchanged` |
| In any other open state | Leaves it alone: someone is working on it | `in-progress` |
| Resolved | Files a new triage ticket that says it reappeared after the old one, since a recurrence is a regression | `reopened-as-new` |
| Gone from the tracker | Files it again | `refiled-missing` |

In directory mode, a missing proposal is restored at its recorded path from the current findings. The outcome stays `unchanged` or `updated` according to whether the findings changed, so restoring only the ledger on a fresh CI runner does not count earlier proposals as new filings.

A cluster matching two recorded tickets is reported as a `conflict` and filed nowhere. Without the ledger, as on a fresh CI checkout, identities are recovered from the `idiom:finding` blocks of tickets carrying the first label (`ab ticket list --labels <label>`), or of the proposals already in the directory. The ledger is written after every successful filing, so a failure partway through never refiles what already succeeded. A ticket source that refuses unknown labels reports `ab`'s message as an `error`; create the labels once.

**Exit codes.** `0` when every flow was checked and every filing succeeded (new findings are the output, not a failure); `2` when a flow could not be checked, or on any [unattended condition](#unattended-runs-never-fail-quietly): the app could not start, a baseline is missing, stale or covers nothing checked, or a state's expectation no longer matches. Each condition prints one `idiom nightly: …` line and files or updates one triage ticket (the other flows still run and file); `3` when the host was too busy to finish a flow, unless `--deferred warn` (the completed findings still file); `1` when a filing failed. `--json` prints `flows`, `sink`, `triageState` or `outDirectory`, `outcomes`, the `digest`, `conditions` and `conditionOutcomes`.

**Schedule it.** `idiom init --wire --nightly` adds a nightly job to the GitHub workflow (see [Wire agents, CI, hooks and Autobuild](#wire-agents-ci-hooks-and-autobuild)). On a machine, `--print-schedule cron` prints a crontab line for 03:17 that runs in the project root with your current `PATH`, appending to `.idiom/reports/nightly.log`; `--print-schedule launchd` prints a macOS launch agent and the `launchctl bootstrap` command that loads it. Neither installs anything:

```sh
idiom nightly --print-schedule cron
# 17 3 * * * cd '/work/shop' && PATH='/usr/local/bin:/usr/bin:/bin' '/usr/local/bin/idiom' nightly >> .idiom/reports/nightly.log 2>&1
idiom nightly --print-schedule launchd > ~/Library/LaunchAgents/build.idiom.nightly.shop.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/build.idiom.nightly.shop.plist
```

## watch

The merge watcher. A nightly run finds an afternoon regression the next morning; `idiom watch` is a long-running process that notices each new commit on the base branch and checks it within minutes:

```sh
idiom watch                            # watch the base branch from its current tip
idiom watch --target origin/main       # a remote-tracking branch: fetched before every look
idiom watch --since main~5             # first start only: also process the last five merges
idiom watch --once                     # process what is pending, then exit
idiom watch --poll 30s --tracker autobuild --severity major --label design-qa
idiom watch --install-service          # run it as a login service (launchd or systemd)
idiom watch --uninstall-service        # stop it cleanly and remove it
```

**What each merge gets.** Every first-parent commit after the last one processed counts as one merge, so a squash merge and a `--no-ff` merge each appear once and a merged branch's own commits are never visited. For each, oldest first:

1. **Gate.** The merge is checked out in a watch-owned worktree and gated against its first parent, as [`idiom check --gate`](#gate-a-build) would on the branch before it landed. Base records come from the shared base cache, so after a clean merge the next gate usually captures no base. Watch never reuses a running dev server: one on the configured port serves other code.
2. **File.** New findings at or above the severity are clustered and filed exactly as [`idiom nightly`](#nightly) files them: the same `--tracker`, `--severity`, `--label` and `--out` resolution, the same `nightly` config block, and the same `.idiom/filed-tickets.json` ledger. A finding nightly already filed is updated, not filed again, and the reverse.
3. **Advance.** Only when the gate is clean (no finding at or above the severity, nothing deferred or failed) is the baseline advanced to the merge, as [`idiom baseline advance`](#gate-a-build) does on every clean merge. A merge with findings is not advanced: the next merge's gate captures it as its base, so the regression it carried is not filed a second time as new.
4. **Harvest.** [`idiom learn --harvest`](#harvest-corrections-you-already-wrote) reads new escalation answers and pull request comments when `ab` or `gh` is available. Harvest never fails a merge.

When `escalations.watch` is on, each look that finds nothing more pending also runs one [`idiom escalations --answer`](#escalations) pass. It logs `escalations: answered 2 (booking-filter esc_1, …); 1 left open` only when it answered something, and a failing pass is logged once until it recovers; it never stops the watch.

**One line per merge.** Each finished merge logs one line; `--json` logs every event (`start`, `resume`, `merge`, `retry`, `rewritten`, `fetch-failed`, `escalations`, `stop`) as a JSON line:

```text
2026-11-15T14:02:11.000Z a1b2c3d4e5f6 "Merge feature-2" gate: 1 new (1 at threshold); tickets: file-7 created; baseline: not advanced (findings); harvest: unavailable (ab is not installed); 41.2s
```

**Order, restarts and failures.** One watcher runs per project (a second fails fast naming the holder), and merges are processed one at a time. The position is recorded only after a merge's steps finish, so a stop or crash redoes at most the merge that was in flight, and that redo files nothing twice. A merge whose steps fail (a gate that cannot start, a filing error) is retried once on the next look, then logged with its error and passed. If the branch is rewritten so the last processed commit is no longer on it, watch logs it and continues from the new tip without replaying.

**State.** Watch keeps its position, lock and worktree in the Git common directory (`.git/idiom/watch/<key>/`), shared by every worktree and never tracked. Delete `state.json` there to start again from the tip. `--since` applies only when there is no state yet. Like every capture, the gate and the advance use the configured server port: stop a dev server holding it, or the merge's gate fails and is retried.

**Run it as a login service.** `--install-service` writes and starts a service that runs `idiom watch` in the project root with your current `PATH`, logging to `.idiom/reports/watch.log`. It passes on the `--target`, `--tracker`, `--severity`, `--label` and `--poll` you give it. A crash restarts after a minute; a stop does not. `--uninstall-service` stops it with SIGTERM, which ends the watcher cleanly between steps (an interrupted merge is redone on the next start), and removes it. `--print-service` prints the definition and the manual load command without installing anything:

```sh
idiom watch --install-service
# macOS: ~/Library/LaunchAgents/build.idiom.watch.<project>.plist, loaded with launchctl bootstrap gui/$(id -u)
# Linux: ~/.config/systemd/user/idiom-watch-<project>.service, started with systemctl --user enable --now
idiom watch --uninstall-service        # launchctl bootout, or systemctl --user disable --now
```

Other platforms: run `idiom watch` under your own supervisor and send SIGTERM to stop it.

## bisect

```sh
idiom bisect finding-12
idiom bisect finding-12 --json
```

Finds the first commit at which a finding appears, within the range `check` recorded for it ([Where a new finding came from](#where-a-new-finding-came-from)). It runs a binary search over the range's first-parent commits. Each probe captures only that finding's state, viewport and color scheme at one commit, in a detached worktree as [`--ref`](#capture-a-fixed-commit) does. It then runs the current checkout's deterministic checks on it, so a rule change inside the range cannot skew the result. The finding is present at a probe when the same fingerprint (or any earlier fingerprint of the finding) appears at that coordinate.

```
bisect finding-12: probing 9f3c2ab (1 of ~2)
  present
bisect finding-12: probing 41d07ce (2 of ~2)
  absent
first appears at 9f3c2ab "Add promo banner" (file-263)
range abc1234..def5678, 3 commits, 2 probes
```

Bisect never changes your checkout, branch or working tree. Probe captures go to `.idiom/cache/bisect/` and are deleted after each probe, and no run is added to `.idiom/reports`, so probes never show up in `digest`, `decide` or finding names. When the recorded run had uncommitted changes, bisect probes its commit first; if the finding is absent there, it reports that the finding came from uncommitted changes.

It refuses, with exit code 2 and a `Fix:` line, when no range is recorded for the finding (it was never new against a previous complete check), when the range's commits are not in the local repository, when the range is not linear, when there are no commits in it, or when the commit at the end of the range has no committed `.idiom/project.json` (needed for `--ref` capture). A probe that cannot capture stops the search and names the commit and the bounds reached so far.

A finding whose selector changes inside the range gets a different fingerprint and reads as absent at those commits, which moves the answer later. `--json` prints `finding`, `flow`, `coordinate`, `range` (`from`, `to`, `commits`), `probes[]` (`commit`, `present`), `firstBad` (`commit`, `subject`, `tickets`, or `null`) and `verdict` (`found` or `not-in-range`).

## fix

Run the check → repair → verify loop against a configured flow:

```sh
idiom fix studio-lab                          # Claude Code, 3 rounds, 5 findings per round
idiom fix studio-lab --agent codex --top 10 --max-rounds 4
idiom fix studio-lab --dry-run                 # fresh capture, prompt only on stdout
idiom --project /path/to/app fix studio-lab
```

Install and authenticate the chosen CLI first (`claude auth login` or `codex login`).
Idiom invokes it non-interactively in the project repository, with the ordinary
repair instruction plus selectors, measurements, design rules, acceptance criteria,
and absolute crop paths. It uses your CLI's existing authentication and starts an
independent attempt each round. Claude receives explicit read/edit/search tools;
Codex runs in its workspace-write sandbox. Each attempt has a 15-minute timeout
and bounded output. A missing CLI, login failure, or unsupported CLI version fails
with its diagnostic; there is no automatic provider fallback.

`--top` bounds the findings assigned to each attempt, following check's issue
order, including findings beyond the review attention cap. A root cause is
attempted whole, even past `--top`, and never split: the prompt leads with the
shared cause, and the round is verified for that cause only when every symptom
is proven fixed (`Root cause <id>: verified (k/n symptoms cleared)` or
`partial (k/n)`). Applicable rejected
findings are excluded before selection and from sibling instructions. Open and
accepted findings may be attempted; fix records no human acceptances and creates
no tickets. Ordinary `idiom instruction` still requires an explicit acceptance.

Every attempt gets a fresh full-flow recheck, including unselected states,
viewports, schemes, combinations, and minor findings. A newly introduced raw
deterministic occurrence at **any severity** fails the round and stops immediately,
even if more old findings disappeared or the new occurrence is suppressed in the
normal presentation. Missing capture coverage and changed flow/check/design
configuration also fail. Fixes count as progress only when the existing verify
path proves the selected source finding fixed using two fresh calibration captures.
A batch with both fixed and reproduced targets may continue.

The command exits 0 when no eligible work remains; it exits nonzero on regression,
no verified progress, remaining work at the round bound, agent failure, or capture
or verification failure. It leaves application edits for inspection, preserves
unrelated user edits, and never stages or commits. An agent that changes HEAD fails
the session without an automatic undo. Summaries distinguish observed disappearance,
proven target fixes, untouched work, and new occurrences; failed agent attempts
are rechecked too, since they may have left partial edits.

Session prompts, original verification specs, `summary.json`, and `summary.md` live
under `.idiom/reports/fix-<timestamp>-<unique>/`. Each round links an ordinary
verification report, HTML viewer, and before/after attachments. Dry-run needs no
agent installed: it makes the initial check's normal capture/report/name artifacts,
prints only the exact first repair prompt (empty when no assignments exist), and
creates no fix session, verification report, or decision. Progress and diagnostics
use stderr.

## sweep

After an autonomous build, once a batch of builds lands, run a whole-product polish sweep:

```sh
idiom sweep --all --emit-tickets .autobuild/tickets/triage
idiom sweep --all --deterministic-only --max-tickets 5
```

All-mode validates every manifest first, then makes fresh captures in filename order.
It runs the complete deterministic and temporal check registry, the budgeted interaction
probe, and a per-surface model sweep. `--deterministic-only` skips providers and
model-only spec reads and needs no model credentials; capture and probing still run.
The existing project `model` configuration remains required.

Findings across flows sharing proven token, component or authored-style evidence
become one cause proposal. Proposals use the existing salience × prominence ranking.
`--max-tickets <n>` is a positive safe integer, default **10**. It caps new tickets
after grouping, eligibility and open-ticket finding-id deduplication; existing owners
remain linked and human edits stay intact. All findings remain in their source runs,
and `--fail-on` evaluates even findings outside the ticket budget.

Inspect `.idiom/reports/polish-*/polish.md`, `polish.html` and `polish.json` for the
ranked list, omission count, all severity/rule totals, original per-flow reports,
states, viewport sizes, tuple outcomes, model status and probe/check coverage.
Probe budgets, reused controls, unsupported Electron probing and missing temporal
prerequisites remain visible limitations. Failed captures keep successful evidence;
a failed flow does not prevent later flows from running. Partial work is marked
incomplete/degraded and must never be read as a clean product.

Emitted tickets have bounded member acceptance, selectors and measured values,
real screenshot/crop links and a paste-ready repair instruction. Original source
occurrences live in hidden immutable verification sidecars, partitioned by flow and
tuple. After repairs, run **every printed `idiom verify <flow> --spec <sidecar>`
command**, including its project argument; a shared ticket's main body spans flows
and is not itself a single-flow verification spec. Missing filmstrips and manual
model verification are disclosed. Review and groom proposals manually; emission
never promotes tickets or dispatches cleanup work.

Choose exactly one of a named flow or `--all`. All-mode rejects `--from` and
`--latest`; named-flow sweep retains both replay modes (mutually exclusive),
`--prod`, `--port`, JSON and advisory exits.

`idiom sweep` is the deeper pass to run when the deterministic checks are clean but the build still needs a designer's eye. It captures the flow, runs every deterministic check, then asks the configured model to critique each surface (flow state) on its own, with zoomed crops of the small details and the measured geometry (heights, widths, radii, gaps to the nearest control, contrast and declared component sizes) in the prompt, so it compares numbers instead of estimating pixels:

```sh
idiom sweep studio-lab                          # capture + checks + per-surface model sweep
idiom sweep studio-lab --from <runId>           # sweep a stored capture
idiom sweep studio-lab --emit-tickets .tickets/triage
idiom sweep studio-lab --json --fail-on major   # advisory unless asked to gate
```

Point `design.specFile` at a written spec to have each surface compared against it; mismatches are reported as `spec-mismatch` findings that quote the requirement and state the measured value:

```json
{
  "design": {
    "productFile": "PRODUCT.md",
    "designFile": "DESIGN.md",
    "specFile": "SPECS.md"
  }
}
```

Unlike `review`, a sweep reports every finding, ranked by severity with measured findings ahead of model findings at the same severity, and writes `sweep.json` (per-surface status, crops and counts) beside the usual reports. A surface whose critique fails is listed as failed while the other surfaces keep their findings. Sweep findings live in the run's `findings.json`, so `idiom decide`, `idiom tickets --cluster` and the HTML report work on them unchanged. `review` is unchanged; sweep needs the same `model` configuration. Named-flow finding display retains its severity/layer ordering; ticket proposals use salience × prominence and the shared ticket budget.

## learn

When a person spots something every check missed, `idiom learn` turns the observation into configuration the next check measures, or a ruling the next review enforces:

```sh
idiom learn --state editor "the override dots should be 8px"
idiom learn --state editor "the toolbar should be 48px tall"
idiom learn --state editor 'say "Sign in" not "Log in"'
idiom learn --state editor "the left rail and the right rail should mirror horizontally"
idiom learn --state editor "section headers never use all caps"     # becomes a ruling
idiom learn --state editor --screenshot annotated.png "the override dots should be 8px"
idiom learn --from-brief pinned-group "every tile got taller once pins were added"
idiom learn --yes --screenshot annotated.png "the override dots should be 8px"   # no --state
idiom learn --yes "the settings toggle labels feel cramped"                       # no --state
```

Agents record a catch the moment a person says it with the MCP tool [`idiom_learn`](mcp.md#tools-and-inputs), which records exactly as `idiom learn --yes` does and returns the record, its matched or proposed state and its rule candidate.

Sizes become `checks.components` entries (or, with "tall"/"wide", a state invariant in the flow manifest), quoted wording becomes a `checks.copy.glossary` term, "A and B should mirror" becomes a `checks.mirrored` pair, a measurable law ("nothing in a toolbar sits closer than 4px") configures the deterministic check that measures it (see [Laws learn compiles](configuration.md#laws-learn-compiles)), and anything else becomes a design-law ruling in `DESIGN.md` (force that with `--ruling`, and set its text with `--wording`). The subject ("override dots") is resolved to a selector from the state's newest stored capture; pass `--selector <css>` when it is ambiguous or nothing was captured. Learn prints the exact diff and writes nothing until you confirm it:

```diff
--- a/.idiom/project.json
+++ b/.idiom/project.json
@@ -34,5 +34,15 @@
     "provider": "claude-code",
     "model": "claude-sonnet-5-5",
     "maxFindings": 5
+  },
+  "checks": {
+    "components": [
+      {
+        "name": "override dot",
+        "selector": ".bp-override-dot",
+        "width": 8,
+        "height": 8
+      }
+    ]
   }
 }
```

Only the learned entry is added; the rest of the file keeps its formatting.

`--from-brief <slug>` names the decided brief a post-build rejection is about ([brief.md](brief.md#checking-the-build)). `--state` is then optional when the brief's assertions name exactly one flow state. When the words are not measurable themselves, the brief's size assertions for that state become state invariants; when there are none left to add, the rejection becomes a ruling that names the brief. A brief that is not decided is refused.

Every learning also appends a line to `.idiom/learned.jsonl` naming the observation, what it became and the capture it was seen on (plus a copy of `--screenshot` under `.idiom/learned/`); commit both. Component sizes, invariants and mirrored pairs are measured at capture time, so run `idiom check <flow>` (a fresh capture) to see them report.

`--yes` records without the prompt, so an agent can call learn in the middle of a conversation. Without it, learn shows the diff and asks first.

### Learning without a state

`--state` is optional. A person describes a miss in words and screenshots, not state ids, so learn works out where the observation applies, in this order:

1. **The screenshot.** With `--screenshot` and no `--state`, learn compares it with the newest complete capture of every declared flow state, viewport and colour scheme under `.idiom/reports/` (`--flow` narrows the candidates, `--from <runId>` limits them to one run). The comparison follows layout: both images are shrunk to a small greyscale thumbnail and correlated, a viewport screenshot can be found inside a full-page capture and the other way round, and coloured annotation strokes on the human's screenshot are left out. Learn says which capture matched and how sure it is:

   ```text
   Matched screenshot to studio-lab/editor @ desktop (run 2026-11-14T10-02-11-000Z), 97% similar, high confidence; next closest studio-lab/menu-open @ desktop, 71%.
   ```

   A match needs at least 60% similarity. Confidence is **high** at 90% or more and at least 5 points clear of the closest other state, **medium** when it is clear but below 90%, and **low** when another state is within 5 points. The matched capture is the one learn resolves the subject's selector in and records as provenance. When the match is low confidence because a state of a different flow is within 5 points, the words decide between them: if they name exactly one of those states, learn uses it; otherwise it names the candidates and asks for `--flow` instead of guessing:

   ```text
   The screenshot matches states in several flows: studio-lab/settings (88%), tablet-guide/options (87%); pass --flow <id> to choose.
   ```

   Learn reads only complete runs under `.idiom/reports/`. Other folders there (a hidden folder, a hand-made folder, a run that never finished) are skipped when it searches; only a run named with `--from` is checked, and refused if it is not a complete run.
2. **The words.** With no screenshot, a state whose whole id appears in the observation ("the **settings** toggle labels…") is used, the most specific id winning. Otherwise a state is used if it is the only one sharing two or more words with its description. A tie inside one flow matches nothing; a tie between states of different flows (two flows that both declare `editor`) is reported with the candidates, and nothing is recorded until `--flow` or `--state` settles it.
3. **The only state.** A project that declares exactly one state uses it.
4. **A draft state.** When nothing matches well enough, learn never fails for want of a state. It records the miss as **open** against a draft flow state and writes the draft to `.idiom/proposals/states/<learned-id>.json`. The draft goes on the flow `--flow` names, the only flow, or the flow the screenshot pointed to (its closest capture at least 5 points ahead of any other flow's). With several flows and nothing that says which, learn names the candidate flows and asks for `--flow`; it never puts the draft on the first declared flow by default:

   ```json
   {
     "version": 1,
     "learned": "learned-7",
     "flow": "studio-lab",
     "file": ".idiom/flows/studio-lab.json",
     "observation": "the export menu items should be 32px tall",
     "nearest": { "flow": "studio-lab", "state": "editor", "viewport": "desktop", "runId": "…", "similarity": 0.41 },
     "state": { "id": "export-menu-item-32px", "description": "The export menu items should be 32px tall.", "from": "editor", "steps": [], "expect": {} },
     "next": "Add `state` to the states in .idiom/flows/studio-lab.json, keep its id, fill in the steps that reach it, then idiom capture studio-lab."
   }
   ```

   The draft is reached `from` the nearest captured state with the steps left for you to fill in (or from the flow's first URL when nothing was close). It already validates against the flow's state schema. Paste `state` into the flow's `states`, keep its id, add the steps, and run `idiom capture <flow>`. The learned record names that id, so run evidence covers it once the state is captured and checked. The proposal is part of the diff and is written only on confirm or `--yes`.

What still applies while the state is only proposed: glossary terms and rulings, and component sizes or mirrored pairs given with `--selector`, since they are project-wide. What needs the state's DOM (a size or mirrored pair without `--selector`, a state invariant) is recorded as an **observation**: it changes no configuration, points at the proposal file, and keeps the interpreted entry so it can be applied once the state exists.

Every record also carries:

- `candidate`: the generalised rule (`Every override dot is 8×8px.`, `Say "Sign in", not "Log in".`, or the ruling's wording), its `kind`, and how it could be checked: `deterministic` for sizes, invariants, glossary terms, mirrored pairs and laws, `reference` for a ruling that compares against a design (Figma, a mock, the spec), and `judged` for any other ruling.
- `placement`: how the state was found. `via` is `state`, `brief`, `screenshot` (with `similarity`, `confidence`, `viewport`, `colorScheme` and `runId`), `words` (with the shared `tokens`), `only-state`, or `proposed` (with the `proposal` path).

### Misses Idiom has not caught yet

When `.idiom/learned.jsonl` has entries, check summaries, review reports,
`idiom report`, and `idiom digest` include a project-wide line:

```text
Human-found misses: 9 logged, 4 now covered by a rule, 5 open (latest: 2 days ago).
```

“Latest” means the newest logged observation, including covered entries. Ages use
whole elapsed days (`today`, `1 day ago`, `2 days ago`). A missing or empty log
adds no line. `check --json` and `digest --json` include `humanFound` with `logged`,
`covered`, `coveredByRun`, `coveredByMark`, `open`, `latest` (ISO timestamp), and
`openEntries` (id, flow, state, kind, observation, recordedAt and optional selector).
Unreadable old run evidence and malformed log lines are skipped in these summaries;
List, mark and fixture modes report malformed log lines so they can be repaired before editing.

```sh
idiom learn --list
idiom learn --list --json
idiom learn --covered learned-3 --by component-size
idiom learn --covered learned-4 --by test/fixtures/menu-dismissal
idiom learn --fixture learned-5 --out ./test/fixtures/human-misses
```

A miss becomes covered automatically when a run produces a finding of its rule on
that same **flow and state**, strictly after the observation was logged. A deferred,
acknowledged or rejected occurrence in a stored check digest also counts. Coverage
records detection of the miss, rather than proving the application defect is fixed.

| Learned kind | Check | Finding rule |
| --- | --- | --- |
| component | `component-size` | `idiom:component-size-mismatch` |
| invariant | `layout-invariants` | `idiom:layout-invariants:*` |
| glossary | `copy-lint` | `idiom:glossary-term` |
| mirrored | `mirrored-control` | `idiom:mirrored-asymmetry` |
| law | its `target.check`: `control-gap`, `negative-spacing`, `text-centering` or `layout-invariants` | that check's rule (`idiom:label-off-centre` for text-centering) |
| ruling | explicit mark required | Model findings do not name ruling ids |
| observation | its `candidate.kind`'s check | as that kind (a ruling candidate needs a mark) |
| imported (`learn --import`) | any check its row names (`import.checks`) | a finding whose **category** is one of those checks |

`--list` shows each entry's coverage and its state:

```text
learned-7  open  studio-lab/export-menu-item-32px (state proposed: .idiom/proposals/states/learned-7.json)  observation  "the export menu items should be 32px tall"
learned-3  covered by fixture test/fixtures/menu-dismissal (marked 2026-11-12T09:30:00.000Z)  studio-lab/editor (state matched, screenshot 97%)  component  "the override dots should be 8px"
learned-2  covered by rule component-size (run 2026-11-10T08-00-00-000Z, 2026-11-10T08:00:04.000Z)  studio-lab/editor (state matched)  component  "the dots should be 8px"
```

Coverage is `open`, covered by a **rule** (run evidence, or a mark naming a rule), or covered by a **fixture** (a mark whose `--by` is a path: it contains `/` or `\`, or ends in a file extension). The state is **proposed** while its draft state is not declared yet and **matched** once it is (records from before placement count as matched). `--list --json` carries the same as `coverage` (`open`, `rule`, `fixture`) and `state` (`matched`, `proposed`) on each status. Use
`--covered <id> --by <rule|fixture>` to record coverage yourself, including a ruling
or a regression test maintained in your repository. The mark is written into that
entry in `.idiom/learned.jsonl`; **commit this file**. A mark takes precedence over
run evidence. It cannot be marked twice, and the log's entry count does not change.
The metric's covered total includes both runs and explicit marks, including fixtures.

`--fixture <id> --out <dir>` exports an **open** entry that names an element. It writes
only `<dir>/<id>/snippet.html` (up to ten matching elements' captured outer HTML)
and `<dir>/<id>/expectation.json` (the original observation, expected configuration,
selector, check id when applicable, and capture provenance). Relative destinations
resolve from the current directory. These are skeletons for your own tests or to
send upstream yourself. The command uses the entry's capture, falling back to the
newest capture of its flow and state if that run has been pruned. The expectation
records the capture actually used. It refuses covered entries, unknown ids, entries
without an element selector, missing captures, selectors with no matches, and existing
target files. It leaves the learning log unchanged and sends nothing upstream.

### Harvest corrections you already wrote

A director already corrects their agents all day: answers to autobuild escalations, and review comments on pull requests. `idiom learn --harvest` collects the UI and UX corrections in them, so nothing has to be said twice:

```sh
idiom learn --harvest
idiom learn --harvest --dry-run              # show what it would record; write nothing
idiom learn --harvest --since 2026-11-01     # look further back than the last harvest
idiom learn --harvest --json
idiom learn --confirm learned-12 learned-13  # turn candidates into rules, one diff each
```

It reads two sources:

- **Autobuild escalation answers**, through the repository's `ab` CLI (`ab builds --all --json` and `ab build status <build> --events … --json`). Only answers a human wrote count; kernel events and blank retry answers are skipped. This reads the local store, so it works with no network on the machine that holds `.autobuild/`. Inside an autobuild step, harvest drops the build's ambient `AB_*` identity before calling `ab`, so repository-wide reads are allowed; `AB_STORE` is kept.
- **Pull request comments**, through the `gh` CLI: inline review comments, review bodies and conversation comments on the repository's pull requests (the 20 most recently updated on the first run, then those updated since the last harvest). Comments from bots, pending reviews, and machine-written comments (anything containing `<!--`, or a "Generated with" agent footer) are skipped.

Each answer or comment is classified sentence by sentence, without a model, so the same words always classify the same way and nothing leaves the machine. A sentence is a UI correction when it asks for a change (*should*, *needs*, *too*, *instead*, *make*, *move*, *feels*, *missing*…), names a kind of UI problem (layout, spacing, copy, interaction or visual quality), and has more UI words (*button*, *modal*, *header*, *padding*, *contrast*, *label*…) than build-process words (*test*, *commit*, *merge*, *spec*, *ticket*, *check*, file paths, commit hashes…). Code blocks, inline code and quoted lines are left out. An answer that is all build process (commits, test runs, scope) is ignored.

Every correction becomes one **open** `observation` record in `.idiom/learned.jsonl`:

- **The director's words, verbatim**: the qualifying sentences exactly as written, without the process chatter that often shares an answer. The source link keeps the rest reachable.
- **Attribution** under `harvest`: the source (`escalation`, `pr-review-comment`, `pr-review` or `pr-comment`), the build and escalation id or the pull request number, link and file, the author, the date, and the UI categories.
- **A rule candidate**, read from the words as `learn` reads an observation: a size becomes a component or invariant candidate, `say "X", not "Y"` a glossary candidate, anything else a ruling candidate.
- **A flow state**, found as [learning without a state](#learning-without-a-state) finds one from words alone: a state the words name, else the only declared state, else a draft state written to `.idiom/proposals/states/`.

Harvest records misses only. It never writes `DESIGN.md`, `.idiom/project.json` or the ruling-name registry, so nothing becomes law without you. It ends by listing every new rule candidate together, with one command that walks them:

```text
Harvested 2 UI corrections (1 escalation answer, 1 PR comment); ignored 3 non-UI, 0 already harvested.
learned-12  open  booking/pick-time (state matched, words)  from booking-times esc_a1 (2026-11-09, director)
  "The time picker chips feel cramped; add more space between them."
learned-13  open  booking/toast-overlap-header (state proposed: .idiom/proposals/states/learned-13.json)  from PR #41 review comment on src/Toast.tsx (2026-11-10, director)
  "The confirmation toast overlaps the header; move it below."

Rule candidates (2):
  learned-12  ruling (judged)  The time picker chips feel cramped; add more space between them.
  learned-13  ruling (judged)  The confirmation toast overlaps the header; move it below.

Confirm them in one pass: idiom learn --confirm learned-12 learned-13
Commit .idiom/learned.jsonl, .idiom/harvest.json and .idiom/proposals/states/.
```

`idiom learn --confirm [ids...]` applies the candidates (every open harvested one when no ids are given) one at a time, each with its diff and a `y/N` prompt (`--yes` skips the prompts). A confirmed candidate is recorded the way `idiom learn` records it, and the harvested record is marked covered by the new learned id. A ruling or glossary candidate applies even while its state is only proposed; a size or mirrored candidate needs its state declared and captured first, so confirm says `add the draft state in <proposal> first` and moves on. One candidate that cannot apply never stops the pass.

Running harvest again adds nothing it already recorded: each record carries a key (`autobuild:<build>:<escalation>` or `github:<owner/repo>#<n>:<kind>:<id>`), and `.idiom/harvest.json` remembers the newest item read from each source so the next run only reads newer ones. `--since <date>` starts from an earlier date instead; keys still stop duplicates. `--flow <id>` places corrections in one flow. Run one harvest at a time.

When pull request comments cannot be read (`gh` not installed, not logged in, no GitHub remote, no network), harvest still records the autobuild answers and says why:

```text
PR review comments: not read — gh is not installed.
```

The pull request cursor stays where it was, so the next run that can read them catches up. Harvest fails only when neither source can be read. `--json` prints the structured result: `recorded`, `ignored`, `duplicates`, per-source `sources.autobuild` and `sources.pullRequests` (`status` `read` with counts and `through`, or `unavailable` with `reason`), and the `cursor`.

#### Run it on a schedule or as an autobuild step

Harvest needs no daemon. Run it on a schedule on the machine that holds `.autobuild/`, for example hourly from cron (a launchd agent or systemd timer works the same way):

```sh
17 * * * * cd /path/to/repo && idiom learn --harvest >> .idiom/reports/harvest.log 2>&1
```

A CI runner has no local autobuild store, so there it reads pull request comments only.

Or run it at the end of every build as an autobuild finalize step, in `autobuild.toml`:

```toml
[commands]
idiom-harvest = "idiom learn --harvest --project /path/to/main/checkout"

[finalize]
steps = ["idiom-harvest"]

[finalize.idiom-harvest]
kind = "check"
command = "idiom-harvest"
```

A finalize step runs inside the build's worktree, so point `--project` at the main checkout, where the records are committed. A source that cannot be read never fails the step; only both sources unreadable exits non-zero.

### Importing a table of misses

A catalog of misses caught by eye is usually a Markdown table: what was seen, the general rule it suggests, and sometimes a category, how it could be checked and the state that would show it. `idiom learn --import` reads the whole table in one pass:

```sh
idiom learn --import misses.md
idiom learn --import misses.md --flow editor-flow   # place rows on one flow
idiom learn --list --import misses
idiom learn --replay misses
```

**Columns.** Headers are matched by role, ignoring case, punctuation, `**`/`__`/backtick emphasis and any parenthetical or bracketed note (`General rule (checkable law)` reads as `general rule`); an exact alias wins, then a header that starts with one (`Observation, what we saw`). Other columns are listed as ignored.

| Role | Required | Accepted headers |
| --- | --- | --- |
| id | yes | `id`, `#`, `no`, `number`, `ref`, `key` |
| observation | yes | `observation`, `miss`, `what was seen`, `issue`, `problem`, `finding`, `what was wrong`, `what went wrong`, `catch`, `description` |
| rule | yes | `rule`, `general rule`, `generalised rule`, `generalized rule`, `principle` |
| category | | `category`, `type`, `area` |
| how | | `how`, `how to check`, `how it could be checked`, `detection`, `checkable`, `check` |
| check | | `idiom check`, `check id`, `check ids` |
| state | | `state`, `state that would show it`, `where`, `shows in`, `Idiom state`, `capture state` |
| surface | | `surface`, `screen`, `page`, `view` |
| date | | `date`, `when` |
| source | | `source`, `sources`, `found by`, `reporter` |

Every table with id, observation and rule columns is imported, in file order; other tables are reported and skipped, and tables inside fenced code blocks are never read. Escape a pipe inside a cell as `\|`; `<br>` reads as a space. Two columns claiming one role is an error, with one exception: a bare `Check` column beside another how column (`How | Check`) is the check-id column; alone, it is the how column and its cells are also read as check ids.

**One record per row.** Each row becomes an `observation` record in `.idiom/learned.jsonl` carrying the row's rule as its `candidate`, its `placement`, and an `import` block (`name`, `source`, `row`, `line`, `category`, `how`, `state`, `surface`, `date`, `rowSource` (the row's own source column; `source` is the file), `rule`, `checks`, and `updatedAt` once a re-import changed it). The import's name is the file's base name (`misses.md` → `misses`). An import never edits `.idiom/project.json`, flows or `DESIGN.md`, records no rulings, and never prompts (`--yes` is accepted and ignored). Rule candidates stay candidates.

**Placement.** A state cell that is `flow/state`, or a state id one flow declares, places the row there. Otherwise the row is placed the way an observation without `--state` is: by the state its words (plus the state cell's words) name, else the only declared state, else a draft state written to `.idiom/proposals/states/<id>.json`. A state cell `NEW: <description>` always becomes a draft state with that description, never a match. Draft state ids are unique within one import.

**Checks.** `import.checks` lists the shipped check ids the row names: any id in the `check` column (`contrast, target-size`, with or without `idiom:`); in the `how` column, hyphenated ids such as `target-size` as whole words, and single-word ids such as `contrast` or `motion` only when backticked or written `idiom:contrast` (plain English would over-match). A size, wording or mirrored rule also adds the check its kind maps to (`component-size`, `copy-lint`, `layout-invariants`, `mirrored-control`). A row with checks is **covered by an existing rule**.

**Nothing is dropped silently.** A body row that is not imported is reported with its line, id and reason: `empty row`, too many cells (`8 cells, header has 6; escape | in a cell as \|`; fewer cells count as blank), `blank id`, `blank observation`, `blank rule`, `duplicate id M-03 (first on line 22)` (the first wins), an ambiguous state (`state editor is declared by a, b; pass --flow or write flow/state`), an unknown flow in `flow/state`, or a row with no state whose flow cannot be told on a project with several flows (`ambiguous-flow`, with the candidate flows; pass `--flow`). Skipped rows do not fail the command.

**Re-importing** the same file updates records by row id instead of duplicating them: ids, `recordedAt` and any `--covered` mark are kept, an edited row is rewritten in place with `import.updatedAt`, an unchanged row is left byte-for-byte, a new row gets the next id, and a record whose row is gone is kept and listed. A row is re-placed only when its observation, state cell or `--flow` changed.

```text
Imported misses.md as "misses": 25 rows — 20 created, 0 updated (0 changed), 5 skipped.
Covered by an existing rule: 16 of 20. Need a new state: 6 (drafts in .idiom/proposals/states/).
Skipped:
  line 38   —     blank id
  line 39   M-19  blank rule
  line 40   M-03  duplicate id M-03 (first on line 22)
  line 41   M-20  8 cells, header has 6; escape | in a cell as \|
  line 42   —     empty row
Ignored the table on line 7 (Week | Misses): missing id, observation, rule.
Next: idiom learn --list --import misses; idiom learn --replay misses
Commit .idiom/learned.jsonl and .idiom/proposals/.
```

**`--list --import <name|file>`** lists only that import's records, with `import <name>#<row>`, `surface <surface>` when the row has one, and `checks <ids>` on each line, and ends with `Import misses: 20 records, 3 covered, 17 open, 6 need a new state.` An imported record is covered, as in the table above, by a finding whose category is one of its checks on the same flow and state **after the record was logged**.

**`--replay <name|file>`** answers a different question: how many of the import's misses do the latest checks catch, whenever they were logged? For each record it reads the newest **reviewable** stored run that captured its flow state: a complete run with `findings.json` or a digest record. Capture-only runs and run directories that no longer exist are skipped, so the search moves on to an older reviewed run. A record is **caught** when that run has a finding on that state from one of its checks, **missed** when it has none, and **unmeasured** when it cannot be measured at all. It writes nothing and captures nothing:

```text
Replay "misses": caught 2, missed 7, unmeasured 11 of 20. Catch rate 22% of 9 measured.
Unmeasured, by reason:
  no reviewed run captured the state               2  capture the flow: idiom check studio-lab
  state proposed but not added                     4  add the proposed state (drafts in .idiom/proposals/states/)
  state not declared in any flow                   1  declare it in a flow, or re-import with --flow or flow/state
  no check named and no matching finding category  4  record a ruling: idiom learn "<rule>" --ruling
  caught      learned-4   M-04  studio-lab/settings                  target-size (run 2026-11-14T12-00-00-000Z)
  missed      learned-1   M-01  studio-lab/editor                    no contrast finding in run 2026-11-15T12-00-00-000Z
  unmeasured  learned-5   M-05  studio-lab/layer-list-row-jump       no check named
  unmeasured  learned-8   M-08  studio-lab/template-card-uneven-gap  state proposed but not added (.idiom/proposals/states/learned-8.json)
  unmeasured  learned-3   M-03  studio-lab/publish-dialog            no reviewed run captured this state
Read runs: studio-lab 2026-11-15T12-00-00-000Z, 2026-11-14T12-00-00-000Z
Newest reviewed run: studio-lab 2026-11-15T12-00-00-000Z
To replay against the current checks, run idiom check <flow> (or idiom review <flow> --from <run> --deterministic-only) first.
```

Each unmeasured record has exactly one reason, taken in this order: no check named (the row names no check and no finding category can match it; record a ruling), then a state that is not declared (proposed by the import but not added yet, or not declared in any flow), then no reviewed run of the state (capture the flow). The breakdown comes first, listing only reasons with a count. The catch rate is over measured rows (caught plus missed) only, with n. When every record is unmeasured, the headline says `nothing measured`, and replay exits 1 with the counts by reason on stderr.

Replay reports stored evidence, so it is only as current as the runs it names: run `idiom check <flow>` (or re-review a stored capture with `idiom review <flow> --from <run> --deterministic-only`) after upgrading Idiom before quoting the catch rate. `--json` prints the import result or the replay (`name`, `total`, `caught`, `missed`, `unmeasured`, `measured`, `catchRate` (null when nothing is measured), `unmeasuredBy` with `no-run`, `proposed`, `undeclared` and `no-check`, `runs` (flow → the runs read), `newestRuns` (flow → its newest reviewed run, or null), and `records[]` with `status` (`caught`, `missed` or `unmeasured`), `reason` (unmeasured only), `detail`, `runId` and `check`). With `--json`, the payload is printed before the exit 1.

Choose exactly one learn mode: an observation, `--list`, `--covered`, `--fixture`, `--harvest`, `--confirm`, `--import <file.md>` or `--replay <import>`.
`--by` requires `--covered`, `--out` requires `--fixture`, `--since` and `--dry-run` require `--harvest`, and `--json` requires `--list`, `--harvest`, `--import` or `--replay`.
`--state`, `--screenshot`, `--selector`, `--ruling`, `--wording` and `--from-brief` apply only to an observation, not with `--list`, `--import` or `--replay`.

## compare

`idiom compare` pairs two stored captures of a flow by state, viewport, scheme and combination, and writes a labeled before | after composite for every tuple whose pixels changed. Unchanged tuples are listed, not rendered:

```sh
idiom compare studio-lab --from <after-run> --against <before-run> --out .ab/idiom-compare
```

`before-after.md` lists changed, unchanged and not-comparable tuples, then the deterministic findings that are new in `--from` and fixed since `--against`. Its `attachments.json` uses the same contract as `idiom verify` output (`idiom-before-after-NNN` composites, the `idiom-verify-report` report), so the `idiom-verify` delivery steps attach it to an Autobuild PR unchanged; see `templates/autobuild.idiom.toml`. Compare is evidence, not a gate: it exits 0. Without `--out` it writes `.idiom/reports/compare-<timestamp>`; an existing `--out` is replaced only if compare owns it.

## review

Capture and fully review a flow in one command, replay an immutable stored run, or keep the review completely offline:

```sh
claude auth login
claude auth status
idiom review booking
idiom review booking --from <runId>
idiom review booking --deterministic-only
idiom review booking --deterministic-only --from <runId>
idiom review booking --deterministic-only --latest
```

New projects default to the subscription-backed `claude-code` provider, so full review needs an installed and authenticated Claude Code CLI but no API key. Idiom launches an isolated non-interactive session with only the `Read` tool, passes screenshots and image references as absolute readable paths, and sends all other critique context over stdin. The configured model identifier is passed to Claude Code. Idiom removes every `ANTHROPIC_*` variable, the third-party provider-selection flags (`CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX`, `CLAUDE_CODE_USE_FOUNDRY`, `CLAUDE_CODE_USE_MANTLE`, `CLAUDE_CODE_USE_ANTHROPIC_AWS`), `CLAUDE_CODE_SKIP_*_AUTH` and `AWS_BEARER_TOKEN_BEDROCK` from this child, so an inherited key, token, base URL, header or provider switch cannot move critique off subscription authentication. Everything else passes through unchanged, including `PATH`, keychain access, `CLAUDE_CODE_OAUTH_TOKEN` and proxy settings. Your Claude Code settings files are not changed, so an `env` block or `apiKeyHelper` there still applies. The `anthropic` provider still reads `ANTHROPIC_API_KEY`. Each session sees at most 20 images, 20 MB of image files and 60,000 characters of DOM excerpts; a larger capture is split by state across several sessions, and anything that cannot fit any session is left out rather than silently dropped by the model's context.

The direct Messages API remains an explicit fallback for existing projects and machines that cannot authenticate Claude Code. Select it in `.idiom/project.json` and provide the key in the process environment:

```json
{
  "model": {
    "provider": "anthropic",
    "model": "claude-sonnet-5-5",
    "maxFindings": 5
  }
}
```

```sh
ANTHROPIC_API_KEY=<credential> idiom review booking
```

To review with Codex instead, install and authenticate the Codex CLI (`codex login`) and select `codex`. Idiom runs `codex exec` read-only and ephemeral in the project directory, attaches every screenshot and image reference to the request, and reads the structured result from a temporary file. It needs no Anthropic credential and removes `ANTHROPIC_API_KEY` from the child. The critique context, allowances, validation and one repair round are the same as Claude Code's.

Any provider can name a fallback, with its own model id, used only when the primary fails:

```json
{
  "model": {
    "provider": "codex",
    "model": "<codex model id>",
    "maxFindings": 5,
    "fallback": { "provider": "claude-code", "model": "claude-sonnet-5-5" }
  }
}
```

The fallback must be a different provider. After the first primary failure the rest of that run uses the fallback. The report stays full but says which provider completed it and why the primary failed, and the CLI prints a `Warning:` line. If both fail, the review degrades as usual and the reason names both.

Review writes `findings.json`, `unruled-decisions.json`, `report.md`, and `report.html` beside the capture. Both report formats begin with the declared flow coverage: selected states, viewport dimensions, color schemes, successfully captured tuples, commit identity, project axes narrowed out by the flow, and any failed or unavailable tuple. When surfaces are declared, the same block always names judged, governed-but-not-judged, and ungoverned groups, including an explicit `none`. The self-contained HTML groups findings by state and embeds every displayed screenshot; it makes no network requests and supports light and dark system themes. It always runs ten local checks for overflow/clipping, narrow-viewport breakage, contrast, accessible labels, target size, headings, design-token drift, console errors, missing states, and spacing-rhythm outliers, plus the thirty-two craft checks described under [Checks](configuration.md#checks). Spacing rhythm is inferred only from a strong prevailing clearance among comparable interactive placements in the current run, so uniformly tight products are not judged against a built-in spacing scale. Captures with legacy observations show that check as `not evaluated` instead of guessing. Both providers receive the same product/design context, prior decisions, rules and rulings, every eligible deterministic finding, managed reference and anti-reference images with their notes/provenance, legacy loose references, captured screenshots, and bounded allowances. Both polarities are equally binding. Both providers return strict findings plus best-effort decision observations. Findings retain their existing local screenshot/state/viewport, exact known-reference-label, and no-rating validation. A `reference-mismatch` finding must cite at least one specific reference or anti-reference label; that citation is persisted and printed in the report. The direct provider retains its base64 Messages transport and requires an image-capable Messages model.

Unruled decisions are a separate review product, never findings. Idiom groups
observations by normalized choice, requires recurrence across at least two
distinct states, lists every recurring state/viewport/scheme coordinate,
suppresses choices already resolved in `DESIGN.md`, and publishes at most three
`ruling-N` records per run. This fixed cap never consumes `model.maxFindings`.
Each candidate must carry an exact design-law excerpt or a cited screenshot of
the same choice on the current governed flow; unsupported observations are
dropped and disclosed without degrading valid findings. When no precedent
exists, the question is published with no candidate rather than invented
guidance. Deterministic-only and degraded reports say the analysis was
unavailable instead of implying that the law is complete.

At most five material findings are published across both layers. After both layers complete, eligible findings are deduplicated and ranked by severity, confidence descending, then canonical fingerprint; deterministic confidence is `1.0`, so deterministic findings naturally win equal-severity confidence comparisons. Reports visibly label each material finding's layer and list every eligible finding below the cap cutoff in a separate evaluated-but-not-selected section. Model findings have per-finding confidence below `1.0` and cite real captured screenshots plus the guidance they violate. Standing rule-scope rejections from `.idiom/decisions.jsonl` and suppressions from `.idiom/rules.json` filter matching deterministic and model findings before selection and remain visible, with their provenance and reason, in every report's suppressed-findings appendix. Rules-file severity overrides apply before ranking and are annotated as `original -> effective` in the report.

A report is labeled full only when the selected model provider completes successfully. `--deterministic-only` is labeled as an intentional model skip. A full review invokes the provider even when deterministic candidates already meet or exceed the material cap; cap saturation is never itself a degradation. A missing or unauthenticated `claude`, a Claude Code session that does not finish within its 10-minute bound, an unsupported model or CLI version, malformed output, a token-limit truncated response, provider/network failure, or missing API key on the explicit `anthropic` path produces a visible degradation warning and a non-full report. When Claude Code cannot run and no API key is available, the warning names both prerequisites and still exits 0 with ranked deterministic findings. When Claude Code runs and is signed in but the session itself fails (for example it hits its turn limit or gets an API error), the warning says "Claude Code ran but the critique session failed" with the CLI's own diagnostic, not a sign-in hint. A present key is never used as an automatic fallback; the warning explains how to select `model.provider: "anthropic"` explicitly or configure `model.fallback`. A configured `model.fallback` is used visibly, never silently. A missing or unauthenticated `codex` degrades the same way, with a `codex login` hint. Partial model batches are never published. When the Claude Code critique was split across sessions or left evidence out, the report stays full and says so in one line under the model layer, naming each omitted screenshot, crop, design image, reference or DOM excerpt and why; if every screenshot would be left out, the provider fails and the review degrades with the limit named. The model is shown at most 50 deterministic findings (or 20,000 characters of them) per prompt, the rest summarized by category and severity; when that bound applies, the report says so in one line under the model layer. `--deterministic-only` does not construct a provider or read provider-only screenshot/context inputs and makes zero external calls. A corrupt decision log remains an actionable project-data error because silently forgetting human policy would be unsafe.

`--from` validates the stored flow and commit coherence and does not compare with current `HEAD`, launch a browser, start a server, or run Git. In full mode it may call the configured model; combine it with `--deterministic-only` for an offline replay. When `design.tokensFile` is absent, token drift is reported as skipped; when declared, the project-relative stylesheet is parsed and its custom-property values are normalized in Chromium. Review never produces an aggregate design rating.

Findings use short names such as `finding-12`. `.idiom/finding-names.json` owns the monotonically increasing allocation plus every historical fingerprint and legacy `IDM-...` alias for each lineage. Review reserves names for material, deferred, and suppressed findings before publishing its artifacts, so a hidden or deferred name is never recycled. Linked worktrees union the local and primary registries, and the current checkout's names win. Compatible primary entries merge. A primary entry that gives one of this checkout's names to a different finding, or names one of its findings differently, is skipped for the run, along with any primary decision, report or ticket record that relies on it. The run completes and prints one line on stderr (and `findingNameWarning` in `--json`):

```
Warning: finding-name registry diverges from the primary checkout: skipped 3 conflicting entries from <primary>/.idiom/finding-names.json; this checkout's names win (pass --isolated-registry to ignore the primary's names)
```

Skipped entries are never written to this checkout's registry, so repeated runs keep the same names and print the same line. New names continue after the highest number either registry has spent. For a throwaway worktree, `check`, `review` and `baseline record|accept` accept `--isolated-registry`, and the project key [`findingNames.isolatedRegistry`](configuration.md#finding-names) does the same for every command: the primary's registry, decisions, reports and tickets are not consulted for names. A registry that cannot be read or parsed (in either checkout), or a conflict within this checkout's own evidence, still refuses the run in preflight with `finding-name registry refused: …`. Existing projects need no rewrite: when the registry is missing, Idiom deterministically reconstructs it from decisions first, then retained reports and embedded ticket findings, and the next mutating `review`, `decide`, or `tickets` command persists it. `idiom context` performs the same projection read-only.

Fingerprint inputs are canonicalized deterministically: Unicode and whitespace are normalized, CSS combinator spacing is standardized, stable classes in each compound selector are sorted, and generated/hashed classes are discarded when a tag, ID, attribute, or stable class still anchors the compound. A generated-only compound retains its original token rather than collapsing unrelated elements to one empty identity. Legacy hashes and IDs remain lookup aliases, so existing decisions, reports, and tickets stay readable and effective. Re-observing the same problem reuses its registry name and adds an occurrence to that lineage rather than creating a new identity. Ticket IDs, run IDs, capture directory names, fingerprints, ranking, and finding caps are unchanged.

### Review a generated page

`idiom review --page <url>` reviews one rendered page, such as an AI-generated landing page, without a flow. It captures the page at desktop and mobile in light mode and runs every deterministic check: one H1 and heading order (`heading-structure`), contrast, and the craft checks above, plus `page-content`, which looks for placeholder or lorem ipsum copy, a hero or final section with no call to action styled as a button, and images with no alt text.

```sh
idiom review --page https://localhost:3000/ --brief brief.md --direction direction.md \
  --focus hierarchy primary-action --frame refs/editorial.png "Calm, editorial, one accent colour"
```

With `--brief`, every statistic on the page (percentages, multipliers, prices, `12,000+ teams`, `4.9/5`) has to appear in the brief, or `page-content` reports it as `idiom:unsupported-claim`. Footers and years are ignored. The model critique (`--model`, `--provider` (`claude-code`, `anthropic` or `codex`), or the project's `model` inside an Idiom project, including its `fallback`; an explicit `--provider` or `--model` skips the fallback) reads the brief and direction as numbered lines. It reports sections that drift from the direction (`direction-drift`), offer changes (`offer-change`) and claims the brief does not contain (`unsupported-claim`). Each finding names the page section (`s1`, `s2`, …), cites the brief or direction line it relies on, and gives a concrete fix. Citations are checked against the file: a line that does not exist, or an excerpt that is not on it, is rejected. Only the brief is the source of truth; claims are never fact-checked against the web.

`--focus` takes `hierarchy`, `primary-action` (one primary action per view), `naming`, `radii-heights` and `jargon`; findings in a requested area rank first within their severity. `--frame` adds reference frames as image files, text files or literal text. `--max-findings` (default 10) caps the material findings, `--out` sets the output directory (default `idiom-page-reviews/<timestamp>`), and `--deterministic-only` skips the model. Without a model, the report says the critique degraded and keeps the deterministic findings.

Inside an Idiom project, page review uses the project's checks, model and references. To tune `page-content`, or to turn it on for flow captures too, add `checks.page`:

```json
{"checks":{"page":{"ctaSelectors":[".cta"],"placeholderPatterns":["Acme Placeholder"],"claimsAllow":["24/7"]}}}
```

`ctaSelectors` replace the button-style heuristic, and are resolved at capture like the other selector checks, so recapture after changing them. `placeholderPatterns` are extra regular expressions, and `claimsAllow` lists figures that need no brief. Without `checks.page`, flows report `page-content` as skipped.

### Review patterns against their intent

Rules can pass on a pattern that still looks wrong: a section heading touching the cards it introduces, or placeholder logos that read as broken thumbnails. Declare a web flow's patterns or templates under `content`, each with the intent it should meet, and the model reviews each one on its own for spacing, hierarchy and coherence problems:

```json
{
  "content": {
    "patterns": [
      {
        "id": "carousel-cards",
        "path": "/patterns/carousel-cards",
        "intent": "A section heading introduces a row of equal cards; the heading sits clearly apart from the cards.",
        "reference": "carousel-cards"
      },
      { "id": "logo-bar", "state": "logo-bar", "intent": "A marquee of customer logos that reads as social proof." }
    ]
  }
}
```

- `id` is a lowercase slug, unique in the flow.
- Give exactly one of `path` or `state`. A `path` pattern is captured as a generated state named `pattern-<id>` with the flow's viewports and color schemes. A `state` pattern reuses a state the flow declares.
- `intent` says what the pattern is meant to look like and do.
- `reference` (optional) names a managed reference (`idiom reference add`) or a project file: an image, or a text file used as written guidance. Without it, a managed reference named exactly like the pattern id is paired automatically. A named reference that cannot be found fails that pattern only.

Each request carries that pattern's screenshots, DOM, measured geometry, the sections detected on the page (as in page review) and its reference. Each finding names a section, an `aspect` (`spacing`, `hierarchy` or `coherence`) and a concrete fix, and gets a crop of the cited section.

The results are advisory. They are written to `advisory.json` in the run directory and shown in a separate "Advisory design review (does not gate)" section of `report.md` and the HTML report. They never appear in `findings.json`, groups, tickets or `--fail-on`, and they cannot be decided with `idiom decide`. A pattern whose request fails is marked failed and the others are kept; a pattern whose state was not captured in the run is marked skipped.

`idiom review <flow>` runs the advisory pass whenever the flow declares `content` and the model layer runs, so `--deterministic-only` skips it. `idiom check <flow> --advisory` runs it beside the deterministic checks and prints the advisory entries before the `Full report:` line; check's exit code and `blocking` count ignore them. Without `--advisory`, check makes no model calls. Each pattern costs one model request per run; `--states` narrows a fresh capture to the patterns you are working on.

## report

Temporal finding cards display their contact sheets before static evidence. The sheet labels requested offsets and original sampled times, marks unavailable/unsettled cells, and uses red outlines at the subject's recorded position. Missing legacy filmstrip evidence has no synthetic replacement.

Open a report in the default browser by run ID, or omit the ID to select the newest `report.html` by modification time (with a stable run-name tie-break):

```sh
idiom report
idiom report <runId>
idiom report --json
```

After the `Opened report` line, `report` prints the [trend across runs](#check) of every flow with at least two checked runs, sorted by flow id. `--json` prints `{ runId, reportPath, trend, humanFound? }` instead, where `trend` lists every flow with at least one checked run in the same form as `check --json` (experimental). The report still opens.

Discovery and named lookup are limited to direct children of `.idiom/reports/`. HTML reports are offline and read-only: screenshots are data-embedded, evidence links stay local, and there are no finding or ruling controls. Choose **Print or save as PDF** to open the browser's native print dialog. The printed form hides controls but keeps findings, unruled questions, unclipped text evidence, and labeled static before/after pairs; tall full-page images are scaled to the paper box instead of clipped. Continue to record finding decisions through `idiom decide` and design rulings through `idiom ruling`.

## coverage

```sh
idiom coverage                       # routes from Next.js app/ and pages/ directories
idiom coverage --crawl http://localhost:3000/   # or same-origin links on a running page
idiom coverage --states              # which states each flow's latest capture observed, and the surfaces none opens
```

Coverage lists every route against the flows that capture it, so an uncaptured dashboard is a visible gap rather than silent approval, and prints the `routes` line that would capture the plain ones. Dynamic routes show the concrete paths flows used, e.g. `/p/[id] (e.g. /p/abc123)`.

Exclusions are configured with [`coverage.exclude`](configuration.md#coverage).

Both modes also list, per flow, the disclosures (`<details>`, `aria-haspopup` and `aria-expanded` controls) on the newest capture's surfaces that no state showed open and the probe never opened, with the reason: not reached, skipped, timed out, or no probe at that state. Up to ten are named, then a count; `--json` carries all of them as `disclosures`. A capture from before the disclosure inventory reports it unavailable. The same list appears in each flow review report's coverage section. See [the probe](configuration.md#probe).

Both modes also list, per flow, the lists, tables, grids, feeds, configured regions and editors (a group whose only content is an Add, New or Create control) that held no items in any captured state of the newest capture, so you know which to seed with data before the checks can judge them filled. Up to ten are named with the states they were empty in, then a count; `--json` carries all of them as `emptyContainers`. A capture from before the container inventory reports it unavailable. The report's coverage section shows the same list under Empty containers.

`--states` reports state coverage instead of routes. For each flow it reads the newest stored capture under `.idiom/reports` (passing or not, from any commit) and, for every state, marks each dimension observed, missing or not applicable:

- **viewports**: every project viewport and every viewport the flow names;
- **color schemes**: light and dark;
- **reduced motion**: on and off (one capture records one mode, so one is always missing until you capture the other);
- **network**: fast (the ordinary capture), the slow-network held replay and the failure replay;
- **interaction**: the probe reached the state's controls, and the focus sweep (which runs inside the probe pass) ran;
- **data** (per flow): `empty`, `one`, `many` and `error`, when any state declares [`data`](configuration.md#declare-data-states).

A dimension is observed only by a successful tuple (no capture failure, no expectation mismatch). Each missing dimension names the exact change that covers it, for example `add "mobile" to "viewports" in flow checkout`, `capture once with "capture": { "reducedMotion": false } in project.json` or `add a state with "data": "empty" to flow checkout, seeded by a "setup" command`. A dimension that cannot apply is **not applicable** and never enters the percentage: replays when no probed action sent requests, the probe and its focus sweep on Electron, the probe on a state with no controls, and data states when the flow declares none. The output is a per-flow table of observed versus applicable dimensions with the missing ones, then a `To cover:` list. `--json` returns the same data. `--states` skips route discovery, so it works without `app/` or `pages/`, and cannot be combined with `--crawl`.

`--states` also lists, per flow, the interactive surfaces on the newest capture that no captured state shows open, expanded, selected or focused: **menus** (`aria-haspopup` triggers), **popovers** (`popovertarget` buttons and `aria-haspopup` listbox, dialog, grid or tree triggers), **disclosures** (`<details>` and `aria-expanded` controls), **toolbars** (`role="toolbar"`, covered once any state shows one), **editable text** (`contenteditable` and `role="textbox"`, covered once focused), **selectable** elements (anything with `aria-selected`: tabs, options, rows, cells) and **multi-select** containers (`aria-multiselectable`, covered once two members are selected). Unlike the disclosures list, a control the probe opened still counts as never shown, because no state keeps it open for every check and baseline. Each comes with a draft flow state to paste into the flow's `states`: `from` the first declared state that showed it (or `url` for a `routes`, published `pages` or content-pattern state), then the steps that reach it: `click` and a `waitFor` on what it opens, `click` and `waitFor` the selected element, two clicks with `"modifiers": ["ControlOrMeta"]` for a multi-selection, `dblclick` and `focus` for inline editing, and for a toolbar the selection that shows it before a `waitFor` (with a note when there is nothing to select first). Drafts have an empty `expect`; check the selectors and add expectations before relying on them. They are ranked by how much UI each would reveal (the interactive and text elements in what it opens, plus a weight for its kind) and the top ten are named, then a count; the order is the same on every run over the same capture. `--json` carries the same list as `surfaces` with each `suggestion`. A capture from before the surface inventory, or an Electron flow, reports it unavailable; recapture to pick it up.

This is coverage of what was reviewed, not a measure of quality. Flow review reports and `idiom check` print the same summary as one `State coverage:` line.

## system

Render the project-wide design system and open it in the default browser:

```sh
idiom system
```

The command prints the exact absolute path to `.idiom/reports/system.html`.
That stable file is directly beneath the already ignored reports root, rather
than inside a run directory, so report discovery ignores it and later captures
continue to see a clean source tree. It is atomically replaced on each run and
is suitable for sending, printing, or saving as PDF.

The page separates authored design tokens, observed palette and typography,
the human-authored portion of `DESIGN.md`, recorded rule and no-rule rulings,
standing rule-scope prohibitions, and review coverage. Observed styles come
from the newest complete stored capture; coverage comes independently from the
newest completed review, including a review with zero findings. Both searches
read the current reports root and a reachable primary worktree's root, with
current-checkout precedence for duplicate run IDs. Missing tokens, captures,
reviews, decisions, and rulings remain explicit on the page rather than being
treated as evidence of completeness.

Custom properties authored in the configured `design.tokensFile` and confirmed
inline `design.tokens` become token rows. Color aliases may be resolved from project-contained relative CSS
imports and regular `.css` siblings of that file, but those supporting
properties never become displayed tokens. Missing, cyclic, or conflicting
support is reported on the affected token instead of guessing application
cascade order. The browser resolves color syntax—including fallbacks and
light/dark values—inside isolated local probes.

`idiom system` is offline and model-free. It reads stored artifacts and local
project files without constructing a provider, reading credentials, starting
the application, launching a capture browser, or making an external request.
Its only writes are the temporary atomic sibling and final `system.html`; its
only process launch is the same platform browser opener used by `idiom report`.
All screenshot sources are embedded data, and the closed content-security
policy, system light/dark theme, print control, and print CSS follow the shared
HTML report contract. The page presents evidence and disclosed gaps without an
aggregate rating.

Learn the declared system from source code with a confirmed configuration diff:

```sh
idiom system --learn        # preview, then “Apply this learning? [y/N]”
idiom system --learn --yes  # print the same diff and explicitly apply it
```

Learning recursively discovers Tailwind v3 `tailwind.config.{js,cjs,mjs,ts,cts,mts}`,
v4 `@theme` (including `inline` and `static`), CSS custom properties in `:root`
and literal `[data-theme="…"]` rules, and DTCG design-token JSON. It skips
`node_modules`, `.git`, `dist`, `build`, `.next`, `.output`, `coverage`, `.idiom`,
`.ab`, and `.autobuild`, and never follows directory symlinks. Local stylesheet
imports must remain inside the project. Tailwind v3 configuration is executable
repository code: only explicit learning evaluates it, through a pinned v3
loader/resolver that also works in applications using v4. Detection during
`init` only reads filenames/content signatures.

The proposal retains names, source paths/keys, aliases and themes in
`design.tokens`, and adds supported values to `checks.scales` without replacing
existing human values or role selectors. CSS namespace/name mappings and DTCG
dimension purposes are labeled as inferred: spacing/space/gap/padding/margin,
radius/radii, and explicitly named control/button/input heights. Ambiguous
layout dimensions and unsupported composites remain display-only. Tailwind
resolver defaults are counted separately and excluded from proposed tokens and
scales; only project-declared entries (including resolved references) are learned.
Missing/cyclic aliases, conditional declarations
and conflicting independent sources are disclosed instead of becoming rules.
A recognized source that cannot be read or parsed aborts the proposal.

Learn tokens from a Figma file's local variables instead of code:

```sh
idiom system --learn "https://www.figma.com/design/<file>/<name>"
idiom system --learn "https://www.figma.com/design/<file>/<name>" --yes --refresh-design
```

The URL needs no `node-id`. Color variables become `color` tokens (`#rrggbb`, or
`#rrggbbaa` below full opacity); numbers scoped to corner radius become `radius`,
numbers scoped to gap become `spacing`, and other numbers `other`, all in `px`.
Aliases are resolved (with a cycle guard), remote and boolean/string variables are
skipped, and a collection's non-default modes become themes (for example `dark`).
The response is cached at `.idiom/designs/figma/<file>/variables/<version>.json`
and reused until `--refresh-design`. The proposal goes through the same confirmed
diff as code learning. Figma's variables REST endpoint is available only on
Enterprise plans with a token carrying `file_variables:read`; otherwise learning
fails with that explanation.

`checks.scales.spacing` accepts CSS-pixel numbers and base-step entries such as
`[8, 12, { "multipleOf": 4 }]`. The latter represents v4's unbounded `--spacing`
family. It checks authored padding, margin magnitudes and row/column gaps on
visible elements, with a 0.5px rounding tolerance. Empty leaves existing
spacing-rhythm inference unchanged. Only declared control heights become height
rules. Generic radii apply to every radius role; named roles apply to that role.
Colors remain typed so spacing values cannot authorize a radius or a color.
Existing `tokensFile`-only configurations keep their historical token coverage
until inline `design.tokens` entries are configured.

The report's **Token drift** section compares current declarations with the
same newest complete stored capture used for the observed system. It lists
uncovered values and tokens **not observed in this capture**, qualified by run,
date, flow/state/viewport/scheme, counts and example selectors. This is value
coverage: equal-valued aliases share coverage; it does not prove literal CSS
variable use or repository-wide dead code. Comparisons use matching theme
identity; arbitrary named themes need explicit capture evidence. Global numeric
scales union supported theme variants. Rem comparisons use each capture's
recorded root font size; legacy captures disclose missing rem coverage. Without
capture evidence, proposed rem conversions explicitly assume 16px. Incompatible
conversions across captured root sizes stay out of numeric scales.

Learning needs no flow, capture, running server or model provider. It uses a
disposable local Chromium document for CSS normalization without loading the
application or external resources. Declining preserves configuration/source
bytes; a non-TTY run without `--yes` prints a preview and exits without waiting
on stdin. No sources or no changes is a successful no-op. Configuration changes
during confirmation require a fresh proposal. **Recapture after applying**:
old captures retain historical token normalization and cannot enforce new token
rules. The report labels an unapplied proposal as transient.

Interactive `idiom init` offers learning after scaffolding when it finds sources.
Accepting the offer prepares the diff; applying it requires a separate second
confirmation. `idiom init --yes` preserves noninteractive scaffold behavior and
prints the available `idiom system --learn` command without importing tokens or
opening the system report. Plain `idiom system` keeps the report-only write
behavior described above; confirmed `--learn` also atomically updates
`.idiom/project.json`.

## decide

### Execution actor and history corrections

`--actor <human|agent>` controls who executed a decision. MCP always records `agent` with label `mcp`, even for relayed human instructions; it exposes no public actor override. CLI detects Autobuild before Claude Code before Codex. Build environment/context gives `autobuild:<slug>` (or `autobuild` when the slug is unavailable); Claude markers give `claude-code`; Codex session/thread markers or `CODEX_CI=1` give `codex`. See [the detection contract](stability.md#decision-actor-attribution).

An ordinary TTY prompt without agent hints records human. A prompt inside an agent environment records agent. A person typing in that environment can pass `--actor human`, which overrides all CLI detection and removes the agent label. `--actor agent` forces agent even with no hints; the flag alone still allows interactive prompting. `--build` supplies answer provenance and does not establish execution identity.

```sh
idiom decide finding-3 --accept --actor human --reason "I checked the screenshot"
idiom decide --actor agent
idiom decide --reattribute base..build-tip --actor agent --note "Build agent judgments; PR #299."
```

`--reattribute <from-commit>..<to-commit>` is a standalone append-only correction mode. Both endpoints, an explicit `--actor`, and nonblank `--note` are required. It cannot be combined with a finding, group, accept/reject/choose, scope, listing/pending mode, ruling answer/provenance flags, reason, acknowledgement/unacknowledgement or until. It needs the project/log and Git; no report directories, app or prompts. Invalid or triple-dot ranges fail before writing. Valid ranges with no matching originals report `0 corrected`.

The range uses Git's exclusive-from/inclusive-to set of **observed commits on original decisions**, resolving abbreviated hashes when possible. It does not mean the commits that added the log lines; `unknown` cannot match. Every original byte stays intact. Corrections target exact physical lines/hashes and only change actor metadata, preserving original judgment order, acknowledgement expiry, intended choices and ruling answers. Retrying skips records already attributed to the requested actor. A historical agent label is not guessed from today's process; put known build provenance in the note. Reversing the actor later appends another correction. Commit the log immediately after recording.

Run `decide` without flags to walk the newest review's findings interactively:

```sh
idiom decide --project /path/to/app
```

For scripts, select one finding and exactly one decision:

```sh
idiom decide --finding finding-1 --accept --reason "The repair is worth doing"
idiom decide --finding finding-2 --reject
idiom decide --finding finding-3 --reject --scope rule --reason "This treatment is intentional"
idiom decide --group group-1a2b3c4d5e6f --reject --scope rule --reason "Decorative; the hit area is the row"
```

`--group <id>` (from `idiom check` output or `groups.json`) appends one decision per member of the group in the newest run that recorded it, including members past the review's attention cap. It applies to the run's whole group, which can hold members `check` did not show because a baseline or status filtered them. `--finding` and `--group` cannot be combined.

`--finding` accepts the actionable findings a review records in `findings.json`. A report's **Evaluated but not selected** section marks each finding past the cap: `decision target` when its id already has a catalog lineage from an earlier run, so `--finding` accepts it, or `report-only` when the id names it in that report only and `--finding` would fail with `unknown finding id`. Quick and page reviews mark every deferred finding report-only.

Rejections default to `--scope instance`. Rule scope is defined only for rejection: `--accept --scope rule` (and `--accept --scope instance`) fails with `--scope applies only to --reject` and appends nothing. Reasons are optional for either decision but cannot be blank.

Every actual accept or reject appends one schema-valid record with the canonical name to `.idiom/decisions.jsonl`; skip and quit append nothing. The log is never rewritten. Historical commands may still supply an `IDM-...` alias and resolve the same lineage. An instance decision applies to that lineage occurrence at the recorded commit, so a re-observation on a later commit is presented and requires its own decision even though its stable name is unchanged. Separately, the latest rule-scope record for a fingerprint controls standing suppression across the lineage: a rule rejection suppresses future matches, while a later rule acceptance removes that suppression.

Use `idiom decide --list` for a read-only lifecycle view. It renders one entry per stable lineage with the canonical ID/fingerprint, aliases, surface, first/latest observation and occurrence count, latest decision, ticket/tracker state, verification result, and the ordered path from `open` onward. A ticket is found by its generated filename first, then by the `idiom:finding` record embedded in a consolidated ticket (the same resolution `idiom tickets` uses), and listed with its tracker state and a `Ticket path:` line; a consolidated ticket is marked `— consolidated`. A catalog checkpoint with no tracker ticket behind it reads `checkpointed — no tracker ticket found`. `--list` cannot be combined with decision flags and never appends to the log. A lineage with an acknowledgement adds an `Acknowledgement:` line after its decision: `ABC-123 (active)`, `ABC-123 (active until 2026-12-01)`, or `ABC-123 (lapsed — <why>)`. Lineages without one print no such line. A lineage that `check` found new adds `Appeared:` and `Likely cause:` lines after `Observed:` ([Where a new finding came from](#where-a-new-finding-came-from)); a finding that went away and came back shows when it came back. `--list --json` prints `{ lifecycles }`, each with `introduced` when there is one; `--json` without `--list` is an error.

### Pending decisions and remembered answers

```sh
idiom decide --pending
idiom decide --pending --json
idiom decide --finding finding-12 --choose prototype --reason "Use the approved prototype"
idiom decide --decision ruling-3 --candidate 1 --reason "Use the existing selection treatment"
idiom decide --decision ruling-3 --wording "Selected chips use a filled treatment." --reason "Visible at a glance"
idiom decide --decision ruling-3 --no-rule --reason "Leave this to each surface"
idiom decide --decision ruling-4 --add-step --token space-control --reason "Intentional control padding"
idiom decide --decision ruling-4 --drift --reason "Align with the authored scale"
```

`--pending` is read-only and mutually exclusive with `--list` and answer flags.
Its interface-version-1 JSON object contains `decisionNeeded` and
`decisionQuestion`. It reads current and reachable primary-checkout reports,
using the newest observation per stable identity and preferring this checkout
on a run collision. Missing legacy question artifacts are allowed; malformed
present artifacts fail. Partial captures cannot resolve uncovered questions.

Reference choices require the recorded reference name. Ruling answers require
exactly one applicable mode and a nonblank human `--reason`: generic questions
use `--candidate`, `--wording`, or `--no-rule`; scale questions use `--add-step`
(with optional `--token`) or `--drift`. Candidate bounds and token syntax match
`idiom ruling`. The new `decide --decision` writes only `.idiom/decisions.jsonl`;
`idiom ruling` still records in DESIGN.md. Both sources form effective law:
equivalent resolutions deduplicate and conflicting resolutions fail clearly.
Recorded rulings never become finding acceptance or acknowledgement.

External pipelines can route exit 4 to a person, present `decisionQuestion`, apply
an explicit answer with `idiom decide`, and re-check. Add `--build <slug>` and
optionally `--escalation <id>` for provenance; metadata never implies an answer.
An identical replay for that build/escalation/identity is a no-op, while changed
answer content fails. Commit decision memory immediately so later builds retain it.

Deterministic checks create only their existing scale questions; they do not run
model critique or detect new unruled patterns. Stored model-review ruling questions
are also available through `--pending`. Brief mismatches retain their existing
coverage and failure rules: the current contract has no ambiguity decision marker.
A future brief-ambiguity route needs an explicit marker, stable identity and options.

### Reject, accept or acknowledge

- **Reject**: not a problem. An instance rejection answers this occurrence; `--scope rule` is a standing suppression that hides future matches.
- **Accept**: a problem worth fixing here. It becomes repair instructions and tickets.
- **Acknowledge**: a real problem already tracked somewhere else. The finding stays in every report, but it stops counting toward `--fail-on` and is never reported as new, until the acknowledgement lapses.

```sh
idiom decide finding-12 --ack ABC-123 --note "Tracked in Jira"
idiom decide finding-12 --ack https://tracker.example/browse/ABC-123 --until 2026-12-01
idiom decide finding-12 --ack file-1592
idiom decide finding-12 --unack
```

`decide <finding>` is the same as `--finding <finding>`; giving both with different ids is an error. `--ack <reference>` takes free text, a ticket id or URL, on one line. `--note <text>` and `--until <YYYY-MM-DD>` apply only to `--ack`; `--until` must be today or later. An acknowledgement applies to one finding: it cannot be combined with `--accept`, `--reject`, `--choose`, `--scope`, `--reason` (use `--note`) or `--group`. It prints `Acknowledged finding-12 for ABC-123. It stays in reports and no longer counts toward --fail-on or as new — <log path>`. `--unack` removes the finding's acknowledgement and fails with `finding-12 has no acknowledgement to remove` when it has none. Both append one line to `.idiom/decisions.jsonl` and never rewrite it; an acknowledgement is not a judgment, so it does not change the finding's decision or ticket eligibility.

An acknowledgement lapses, and the finding counts again, on the first of these that applies. `check` and the report say which:

1. You ran `--unack`: `finding-12 was acknowledged for ABC-123 and unacknowledged on 2026-11-06; it counts again.`
2. The reference is a ticket id in the project's local ticket tracker (`.autobuild/tickets/<state>/<id>.md`, the tracker lifecycle reads, earliest state wins) and that ticket is done: `finding-12 was acknowledged for file-1592, which is now done; it counts again.` Remote trackers are not queried, so a URL or an external id lapses only by the other three rules.
3. The `--until` day has passed (it holds through that whole day, UTC): `finding-12 was acknowledged for ABC-123 until 2026-12-01, which has passed; it counts again.`
4. Its evidence changed materially: the finding is now more severe, or reported under a different rule, than when it was acknowledged: `finding-12 was acknowledged for ABC-123, but its evidence changed (severity minor → major); it counts again.` Measured values that move between runs do not lapse it, and unlike an instance decision it is not bound to the commit, so it survives new commits for as long as the problem is the same one.

## brief

The design decision gate that runs before a ticket is written. The flow, the rubric, the research plan, the brief input and its validation, and the question to ask are in the [design decision briefs guide](brief.md).

```sh
idiom brief triage "Add a pin button to every tile"   # or a path to a draft ticket
idiom brief triage drafts/pinned-group.md --json
idiom brief triage "Fix the typo in the Publish dialog" --no-model
idiom brief plan triage-3f9c0a1b2d                     # research instructions for the agent
idiom brief plan "Add a pin button to every tile" --question "How large is the pin?" --minutes 5
idiom brief "Add a pin button to every tile" --research
idiom brief research "selection toolbar offset chip"   # capture and measure comparables, propose criteria
idiom brief record brief.json        # or: idiom brief record - < brief.json
idiom brief record brief.json --json
idiom brief decide pinned-group-in-the-add-drawer --option corner-pin
idiom brief list
idiom brief list --json
idiom brief show pinned-group-in-the-add-drawer
idiom brief export pinned-group-in-the-add-drawer --out design/pinned-group
idiom brief attach pinned-group-in-the-add-drawer --ticket file-281   # in an autobuild project
idiom brief gate tickets/pin.md                        # warn when a ticket lacks a decided brief
idiom brief gate .autobuild/tickets/ready/file-12.md --strict --json
idiom brief lint tickets/pin.md                        # warn when a criterion caps with no floor or outcome
idiom brief lint .ab/spec.md --strict --json
```

`triage <request>` takes the request text, or a path to an existing draft ticket file (up to 64 KB). It applies the shipped rubric with one bounded call to the configured review provider (`model.provider`, then `model.fallback` once if that fails, with a warning on stderr): no tools, no capture, a 90-second limit. It prints `no design decision: <reason>`, or `design decision: <reason>` followed by one `- <question>` line per open question, then `Triage id: <id>` (and `Next: idiom brief plan <id>` for a design decision), and exits 0 either way. It stores the result as `.idiom/briefs/triage/<id>.json`. `--json` prints exactly `{ id, verdict, reason, questions }`. `--no-model` makes no call and works outside a project: it prints the rubric, the request, any project context and the JSON answer shape for the calling agent to apply itself (`--json` returns the same as one object). Without `--no-model`, triage needs an initialized project for its provider.

`research <request>` (experimental) names two or three comparable products from `brief.references` (or PRODUCT.md's `## Comparable products` section) and says why each was chosen, captures each one's equivalent public page as a managed reference at `--viewport` (default: the first project viewport), measures the elements the request names, and prints proposed acceptance criteria with a floor and a cap, each citing the reference it came from. Pages behind a sign-in are reported as not reachable and never logged into. `--json` prints the comparables, measurements and criteria. It needs an initialized project and no model; see [comparable research](brief.md#comparable-research).

`plan <target>` prints research instructions for the calling agent: the open questions with what to check (hover, touch, keyboard, small screen, empty and error states), the reference products by tier, standards to look for, a time budget, the research rules and the exact JSON shape `record` accepts. The target is a triage id (no model call), or the request text or a draft-ticket path. With `--question <text>` (repeatable, up to 8) it plans those questions with no model call, also outside a project; without, it runs and stores a model triage first. `--minutes <n>` sets the budget (1–60, default 10). `--json` prints the plan object.

Before options, `plan` asks for the screen's one question in one line and an inventory of real objects and magnitudes; gather facts rather than invent counts. Optional `screenQuestion` (nonblank, single line) and `inventory` (nonempty list of nonblank strings) are accepted by `record`, retained through `decide`, and rendered before alternatives in the decision section. Old briefs render as before. JSON/MCP plans add `inventoryInstructions` and `stateChecklist` arrays.

The state checklist covers every block's empty, zero, loading and error states, and every row/item's hover, selected, focus and disabled states. Declare important cases as named flow states, including opened drawers, dialogs and menus, so Idiom captures them. For example, with `editor` declared as a base state:

```json
{"id":"editor+menu","description":"Page menu open","from":"editor","steps":[{"action":"click","selector":"[data-testid=open-menu]"}],"expect":{"selectorPresent":["[data-testid=page-menu]"]}}
```

See [opened-state configuration](configuration.md#capture-opened-drawers-dialogs-and-menus). A no-design-decision plan still prints its existing short-circuit message.

`record [file]` validates the calling agent's research and options and stores `.idiom/briefs/<slug>.json` plus the rendered `<slug>.md`. Omit the file or pass `-` to read stdin (up to 1 MB). It prints `Recorded brief <slug> (created|updated, <status>) — .idiom/briefs/<slug>.md`, then, for a proposed brief, the question to ask the requester: numbered options with the recommendation first, any sketches, and whether the agent may proceed without asking. `--json` prints `{ slug, outcome, status, markdownPath, ask }`, where `ask.askUserQuestion` is ready for Claude Code's AskUserQuestion. Invalid input exits 1 with `brief rejected:` and one `path: message` line per issue on stderr. Recording an existing slug updates it.

`decide <slug> --option <id> [--by <name>]` records the requester's choice (`decidedBy` defaults to `requester`) and regenerates the Markdown. It prints `Decided brief <slug>: <chosen title> (by <who>) — .idiom/briefs/<slug>.md`, plus a warning when the choice is not the recommendation, since the acceptance criteria were written for the recommendation. `--json` prints `{ slug, outcome, chosen, recommended, decidedBy, markdownPath, warning? }`.

`"<request>" --research` runs the whole brief without an agent: triage, one web research call per open question and one options call through the configured review provider (`claude-code` or `codex`), then the same validation and storage as `record`. It takes the request text or a draft-ticket path, like `triage`, and writes progress lines and fallback warnings to stderr. It prints `Recorded brief <slug> (created|updated, proposed[, research incomplete]) — .idiom/briefs/<slug>.md` and a `Cost:` line (time, calls, and turns, searches and tokens when the provider reports them, against the budget); a run that stopped early adds its note. With no design decision it prints the triage line and `No design decision; no research run.` `--json` prints `{ outcome, triage, slug, markdown, status, researchRun }` (`outcome` is `stored` or `no-decision`). It exits 0 for a stored brief, complete or not, and for no design decision; an answer invalid twice, a provider failure with no fallback, an `anthropic`-only configuration or a triage that outlasts the budget exits 1 and stores nothing. Without `--research`, `idiom brief "<request>"` is an error. Details are in [brief.md](brief.md#two-ways-to-research).

`gate <tickets...>` checks ticket files (up to 64 KB each) for a decided brief. A ticket that links one (`brief: <slug>`, or `brief = "<slug>"` in leading TOML front matter) or embeds a rendered brief is judged by that brief with no model call: `decided` passes, while `proposed`, `superseded` and a slug with no stored brief warn. A ticket with no brief is triaged once, as `triage` does, and warns with its open questions, `idiom brief plan <id>` and `idiom brief "<ticket>" --research` when it holds a design decision. It prints nothing when every ticket passes, otherwise one warning per ticket and `N of M ticket(s) need a decided brief.`, and exits 0. `--strict` exits 1 when any ticket warns; a failed triage counts as a warning. `--json` prints `{ strict, warnings, tickets }`. A missing or empty ticket, or a missing project when one is needed, exits 1 before any model call. Details and hook recipes are in [brief.md](brief.md#gate-tickets).

`lint <files...>` reads each ticket or spec's acceptance criteria section (up to 64 KB per file) and warns on every criterion that caps a size, time, count or length with no floor or observable outcome, such as "the chip adds at most 64px to the toolbar" with no minimum gap, no overlap condition and no "stays on one row". Each warning quotes the criterion and suggests paired criteria, using the project's `checks.controlGap.min`, `checks.targetSize`, viewports and rulings when there is a project and Idiom's defaults when there is not. It makes no model call. It prints nothing when every file has a criteria section and every cap is paired, and exits 0; `--strict` exits 1 when any criterion warns. `--json` prints `{ strict, warnings, files }`. `record` and `--research` run the same lint over the brief's criteria. The rule, where the false-positive line sits, and the autobuild recipes are in [brief.md](brief.md#lint-acceptance-criteria).

`export <slug> --out <dir> [--capture]` writes a decided brief as a self-contained design asset: `README.md` (the decision, rejected options, acceptance criteria and the Idiom rule that verifies each), `criteria.json` (the machine-readable assertions) and `screenshots/`, one per asserted state at each configured viewport and scheme. Screenshots come from the latest capture of each flow; `--capture` takes a fresh capture of just those states. It prints `Exported brief <slug> to <dir>: N screenshot(s) of M state(s)`; `--json` prints `{ slug, out, files, screenshots, states }`. It refuses a brief that is not decided, a "don't build" decision, a choice other than the recommendation, a missing screenshot (naming it and suggesting `--capture`) and a `--out` that is not empty. Nothing written holds an absolute path.

`attach <slug> --ticket <id> [--capture]` exports the brief to a temporary directory and runs `ab ticket attach <id> design <dir> --name <slug> --json` from the directory holding `autobuild.toml`, then records the ticket on the brief. It runs no other `ab` command, so the ticket's state never moves. It prints `Attached brief <slug> to ticket <id> as design asset <slug> (N screenshot(s)). The ticket's state is unchanged.`; `--json` prints `{ slug, ticket, asset, screenshots, states, ab }`. Without `autobuild.toml` or the `ab` CLI on PATH it exits 1 before exporting or capturing; a failing `ab` exits 1 with its stderr and leaves the brief unchanged. Details are in [brief.md](brief.md#attach-to-an-autobuild-ticket).

`list` prints one line per brief, newest first: `<slug>  <status>[ by <decidedBy>]  <title>[ (research incomplete)]`, or `No briefs.`; a stored file that no longer parses is listed as `invalid` with the reason. `list --json` prints `{ interfaceVersion, briefs }`, where `briefs[]` holds the stored records, newest first, and `{ slug, error }` for one that no longer parses. `show <slug>` prints the rendered Markdown, and `show --json` the stored record.

## explore

Explore exactly one declared state with either a new question or a reviewed
unruled decision:

```sh
idiom explore booking --state choose-slot --question "This screen is busy and the hierarchy is weak"
idiom explore booking --state choose-slot --decision ruling-2
```

Generation and judgment may be separated. When stdin/stdout are not attached to
a TTY, generation still publishes all three candidates, `exploration.md`, and
the HTML comparison, then exits successfully with the run ID. Record the later
human judgment without regenerating:

```sh
idiom explore resolve <run-id> --candidate A --reason "Why A should govern" --yes
idiom explore resolve <run-id> --candidate A --reason "Why A should govern" --repairs --yes
idiom explore resolve <run-id> --none --reason "Why no direction should govern" --yes
```

Resolution prints the exact `DESIGN.md` diff before `--yes` permits the atomic
write. A run resolves at most once. Explicit `--none` changes only the run's
lifecycle manifest. Current version-1 question-driven run artifacts can be
resolved after the fact; an older decision-driven run that does not store its
reviewed-decision identity is rejected as ambiguous. Deferred resolution does
not offer refinement—rerun exploration in a live terminal for that.

The configured model provider must be available before Idiom creates a capture
or temporary workspace. Idiom renders three structurally or stylistically
distinct edits to the real application across every declared viewport and
color scheme, using the same capture pipeline as review. It never generates a
standalone mockup or invents product copy, controls, data, or features. Existing
references and anti-references inform the candidates and are named in the
self-contained comparison report.

Candidate source lives only in disposable runtime clones; the user's checkout
is never stashed or edited. Choose none to remove the exploration without
recording anything. After choosing, one plain-language refinement may be
recaptured; a second is refused. Confirmation appends a reasoned rule through
the same `DESIGN.md` ruling machinery as `idiom ruling`. The temporary candidate
code is never applied. Bounded ordinary repair tickets are offered afterwards;
declining them leaves the rule in force. Exploration is opt-in and is never
triggered by `review` or `verify`. Web states are supported; Electron/desktop
capture remains deferred.

## ruling

Resolve a reviewed `ruling-N` with exactly one explicit human choice:

```sh
idiom ruling --decision ruling-1 --candidate 1
idiom ruling --decision ruling-2 --wording "Selected chips use a filled treatment."
idiom ruling --decision ruling-3 --no-rule
```

The command finds the reviewed record, prints the exact unified diff, and asks
for confirmation before writing. On confirmation it atomically appends one
delimited, machine-readable block to `DESIGN.md`; every prior byte remains an
exact prefix. Candidate numbers are one-based and only select wording already
shown with its precedent. `--wording` records the human's own rule, while
`--no-rule` records that the decision deliberately needs no rule. Cancellation
writes nothing, conflicting modes fail, malformed markers fail closed, and an
already resolved fingerprint cannot be recorded twice. Both outcomes suppress
the question in later reviews and appear in the priority `Recorded rulings`
section of `idiom context` before lower-priority prose.

## instruction

Render one accepted finding as plain text for a human to inspect and paste into a coding agent or chat tool:

```sh
idiom instruction --finding finding-1
idiom instruction --project /path/to/app --finding IDM-run-0001
```

`--finding` is required and singular. Canonical names and historical aliases resolve to the same latest lineage occurrence, which must have a current acceptance; rejected, undecided, and stale instance-accepted occurrences fail without writing an instruction. The output contains only `Change`, `Surface`, `Why`, `Done when`, and `Out of scope` sections. It carries the finding's observable criteria and the same sibling and surface boundaries used by ticket emission, but omits run IDs, commits, fingerprints, lifecycle state, raw finding JSON, and evidence paths.

The command is read-only. It neither sends nor applies the instruction, changes the finding, scans or writes ticket files, nor consumes ticket eligibility. An accepted finding remains renderable when its ticket is `ticketed`, `verify-failed`, or `verified-fixed`, and running `idiom instruction` before or after `idiom tickets` leaves both outputs independently available.

## tickets

Emit every currently accepted finding, or select accepted findings explicitly:

```sh
idiom tickets --project /path/to/app
idiom tickets --finding finding-1 --finding finding-4
idiom tickets --out /path/to/drafts
```

By default, new tickets are created only in the target repository's `.autobuild/tickets/triage/` intake. They are never promoted, made dispatchable, or submitted for implementation automatically. Each ticket has strict TOML front matter, the four spec-standard sections, behavior-only acceptance criteria copied verbatim from the finding, links to screenshot evidence, and the complete Finding JSON in a machine-readable `idiom:finding` block.

Retries inspect ticket IDs derived from every historical fingerprint/ID pair across `triage`, `ready`, `doing`, and `done`. This preserves a pre-canonicalization ticket filename and prevents duplicate emission after identity migration. A promoted or human-edited ticket is reported as already emitted and is never recreated or overwritten. Pre-existing duplicate ids are reported as a per-finding conflict without preventing unrelated accepted findings from being emitted.

Every invocation also reads the canonical tracker's Markdown tickets once and strictly indexes their complete `idiom:finding` blocks by exact historical finding-ID/fingerprint pair. If no generated filename is authoritative, any `ticketed` or `verified-fixed` occurrence in the lineage, or any exact embedded record in an existing or completed ticket, suppresses emission and is reported as already resolved. This keeps a human-consolidated ticket authoritative after its redundant standalone files are removed; embedded discovery checkpoints `ticketed` without downgrading `verified-fixed`. Successful canonical tracker emission uses the same atomic checkpoint. A custom `--out` draft consults canonical tracker and persisted lifecycle state and retains no-overwrite behavior within its own directory, but does not checkpoint `ticketed`, so drafting cannot suppress a later canonical emission. A ticket whose `idiom:finding` blocks are malformed, schema-invalid or repeat an embedded identity is reported with its path and reason (`malformed tracker ticket: …`) and is never repaired automatically. Only lineages whose IDs, fingerprints or generated filename appear in that ticket are reported as blocked instead of emitted; unrelated lineages still emit and reconcile. A corrupt ticket that no longer names its lineage at all cannot be recognized, so review every reported malformed ticket.

To combine accepted findings into fewer tickets, opt into clustering:

```sh
idiom tickets --cluster
idiom tickets --cluster --finding finding-1 --finding finding-4
idiom tickets --cluster --out /path/to/target/tasks
idiom tickets --cluster --out /path/to/target/tasks/triage
```

Clustered mode selects currently accepted finding lineages. Findings share a ticket only when their flow, category and observed component match: a common `data-node-id` takes precedence, followed by captured selector ancestry. Missing or ambiguous component evidence keeps findings separate. Each spec merges identical acceptance criteria and retains each member's selectors, source run/commit, coordinates, original verification payload and complete `idiom:finding` block. Available crops and full screenshots are linked relative to the spec; retain the source reports for those links and verification.

For **clustered mode**, `--out` is a file tracker root, with proposals always written into `triage/`; a path already ending in `triage` is used directly. With no `--out`, the source repository's `autobuild.toml` `[tickets].dir` is resolved relative to that repository, defaulting to `.autobuild/tickets`. For example:

```toml
[tickets]
source = "file"
dir = "tasks"
readyState = "ready"
```

Proposals land in `tasks/triage/`. Ready/doing/done destinations, configured ready-state descendants and directory aliases into those states are rejected. A configuration making triage dispatchable is rejected, and a non-file default tracker requires an explicit file directory. Proposal/create-state configuration cannot bypass human triage. Ordinary `tickets --out` keeps its direct draft-directory semantics.

Deduplication checks individual members before grouping, across arbitrary Markdown filenames at the requested tracker root and its state directories, plus the source tracker. Canonical names, historical aliases/fingerprints and legacy standalone filenames remain authoritative after renaming, promotion or consolidation. Existing tickets are never overwritten or extended. If a component gains new findings, only uncovered members receive a new proposal; multiple owner files produce a per-member conflict while unrelated work proceeds. A malformed tracker ticket is reported with its path and blocks only the members it names; the rest still publish. Canonical publication checkpoints accepted members as ticketed without replacing verification status. Custom drafts and unaccepted check proposals do not checkpoint lifecycle status.

## verify

Temporal findings add optional before/after contact sheets to `before-after.md`, HTML and `attachments.json`. Before uses the original stored pixels; both ordinary recaptures explicitly request the same semantic action so a passing fix still has an after sheet. Probe ordinals alone never establish a match. Missing or ambiguous actions are reported unavailable and do not change calibrated verification verdicts. Paired sheets share a region and scale; uncaptured portions of a wider common region appear gray and partial, and the original sheet is retained. All attachments remain under the verification output after temporary captures are removed.

Verify one or more machine-readable findings embedded in a ticket spec:

```sh
idiom verify booking --spec .ab/spec.md
idiom verify booking --spec .ab/spec.md --against <runId>
idiom verify booking --spec .ab/spec.md --against /path/to/copied/capture
idiom verify booking --spec .ab/spec.md --out .ab/idiom
```

Verification is fully local and never constructs the critique adapter, reads a model credential, calls `fetch`, or contacts an external API. It resolves the immutable source capture by matching the exact historical fingerprint and an intersection of the ticket finding's canonical/legacy ID set with the retained finding's ID set, while still requiring the same flow, state, viewport, color scheme, and commit. A safe run id is searched beneath the current checkout's `.idiom/reports/` and, from a linked worktree, the primary checkout discovered through Git's common-worktree topology. An explicit absolute or project-relative capture directory supports retained evidence copied elsewhere. Keep the original ignored capture: a missing baseline is never replaced by recapturing the already-fixed tree.

Only the exact referenced state/viewport/color-scheme triples are captured—never their independent Cartesian cross-product. Historical findings without a scheme resolve to `capture.colorScheme`. Verification of an inert-scheme finding deliberately selects the flow's full declared grid. Idiom performs two independent setup/data/build/server/browser lifecycles for those tuples. Current A/B evidence must agree under the full version-2 structured rendered profile at every selected triple and under the exact historical comparison profile before any finding can be marked fixed. Version-1 captures remain supported without recapture through a rendered-only projection of their shared subtree text, computed styles, and ancestor-relative geometry. Non-rendered script/flight records are removed first; 500-character-boundary, temporal, and masked-ancestor text is suppressed and reported. Browser-evaluated version-2 mask membership is transferred structurally to version 1, widened when possible, or uses a reported temporal-mask fallback. Malformed masks, A/B mask drift, corrupt ancestry, platform mismatch, and nondeterminism fail closed.

The verdict uses structured DOM text, allow-listed semantic/presentation attributes, computed style, deterministic checks, and stable-island-relative geometry. Dates and times plus their layout reflow are normalized away. PNG differences and raw dimensions are inspectable evidence only, and unequal image sizes are padded safely for the paired composite. A declared target may disappear consistently when its stable region remains coherent; unrelated changes outside a bounded locus cannot prove a finding fixed.

Output defaults to a fresh `.idiom/reports/verify-<timestamp>/`. An explicit `--out` is the exact verify-owned directory and is atomically replaced on retry. It contains `before-after.md`, `report.html`, `attachments.json`, one `before-after-<state>-<viewport>.png` per referenced tuple (a state or viewport name with characters outside letters, digits, `.`, `_` and `-` is written as a sanitized stem plus a short hash, so each composite stays a single file in the output directory), and `current-a/` plus `current-b/` recapture artifacts. Both reports identify finding-selected scope—or the full declared grid required by a full-flow finding—and the historical baseline and current recapture commits; neither scope is presented as a fresh whole-flow review. The self-contained HTML embeds labeled before/after images and provides a presentation-only comparison slider plus the browser-native print/save action. Its content-security policy forbids external requests. The slider disappears in print while the static pair remains. Attachment kinds are stable and distinct: `idiom-before-after-001`, `idiom-before-after-002`, and so on in manifest order, plus `idiom-verify-report`.

Default verify outputs can be opened with `idiom report`. Custom outputs outside `.idiom/reports/` are intentionally not discovered; for the example above, open `.ab/idiom/report.html` directly in a browser.

Exit `0` means every finding is fixed or the spec contains no findings. The no-findings outcome reports zero exercised states and tuples and no captured commit identity; it performs no Git source inspection, setup, build, server, browser, provider, or external API work. Exit `1` names every reproduced finding, new deterministic blocker, or calibration/projection failure and points to the published report. Review and verification reports describe evidence and limits; they never calculate a score or grade.

For authorized repairs by the implementing caller: Fix the top three findings in rank order (function before appearance), re-run, and stop after three rounds, reporting what remains. One round is one repair batch followed by one check; the initial check is not a repair round. Stop earlier when nothing remains. Repair only within the caller's authorization; remaining blocking findings still withhold completion and do not permit suppressions. The verifier runs once and deposits a verdict.

The default gate fragment is `templates/autobuild.idiom.toml`. The optional finding-verifier recipe is `templates/idiom-verify/SKILL.md`; init offers it separately for projects using Idiom-originated tickets, with a detected flow and project paths, after exact-diff confirmation. Unsafe edits fall back to printing this full manual payload. Non-interactive `idiom init --yes` never modifies or installs Autobuild wiring.

## context

Everything above improves UI after it renders. `idiom context` is the other half of the loop: it emits the accumulated judgment as plain Markdown on stdout, sized to paste into any agent's context *before* it writes UI, so the same mistake stops being generated at all.

```sh
idiom context
idiom context booking
idiom context booking --project /path/to/app
```

It is offline, model-free, and read-only: no provider is constructed, no credential is read, `fetch` is never called, no browser or server is started, and neither checkout is written to. The only child process is the same local Git topology query verify uses, and its failure degrades rather than fails.

**Scope.** With no argument the brief is the complete project-wide view and reads no flow manifest at all, so it succeeds in a repository that has none yet. With a flow argument it validates exactly `.idiom/flows/<flow>.json` and requires the manifest's `id` to equal the argument; a missing, malformed, or mismatched named manifest fails with the usual project-relative diagnostic, and unrelated manifests are never read. An unknown flow is an error, never an empty under-scoped brief.

**Sections, in this fixed order.** `Recorded rulings`, `Design law`, `Standing prohibitions`, the conditional `Decided design briefs`, `Craft checks`, `Design tokens`, `Project rules`, `Accepted work not yet built`, and `Product intent`. The design-law section carries the human-authored portion of `DESIGN.md`; appended ruling blocks are parsed into atomic rule/no-rule entries in the first section. Product intent carries `PRODUCT.md` unchanged. Parse section boundaries by scanning for these titles in order. Output carries no invocation-specific data, so two runs over unchanged data are byte-identical.

**Craft checks.** Common checks retain configured sizes, spacing, frame, mirrored pairs and copy rules. Product flows (including omitted kind) get app guidance: color on data/status, prominent numbers as type, sparse status marks and badges, numerical alignment, stable chips, actionable queue counts, framed empty sections, token-styled browser surfaces, expanded-state disclosure indicators and consistent icon meanings. Published flows (`kind: "published"`) or projects with `checks.page` get page guidance: clear section headings, shared gutters and no blank bands. Without a flow, only the project page profile selects page guidance; the default is app guidance. `review --page` is transient and does not change later context output; `context` has no `--page` option. These are preventive instructions, not a claim that checks cover every convention. Rule labels identify actual checks and describe partial coverage.

**Standing prohibitions are project-wide.** A rule-scope rejection suppresses its fingerprint everywhere, exactly as review already treats it, so every active one appears in every brief regardless of the flow argument. Aliases are resolved across a lineage, and the latest rule-scope record for that lineage decides: a later rule acceptance removes the prohibition. The prohibited behavior is sourced from the lineage's *latest* finding — `Do not repeat this rejected pattern: <explanation>`, plus its `rule` (or `category`), the recorded reason or `No reason recorded`, the rejection count, project-wide applicability, and the *first* observed surface as provenance. A fingerprint is traceability metadata, never a behavior description: when a rejection has no finding artifacts anywhere, the entry degrades explicitly to `Do not reintroduce the standing rejected pattern identified by fingerprint <fingerprint>; descriptive finding evidence is unavailable.`

**Rules and accepted work.** With no flow, every rules-file override is included in file order with its complete match annotated, so a `flow` constraint stays visible. With a flow, global overrides plus overrides whose `match.flow` equals that flow are included. Accepted findings follow the same split. Accepted work uses ticket-emission eligibility: a lineage accepted at its latest occurrence, minus anything `verified-fixed` or resolved to a `done` tracker ticket. `triage`, `ready`, `doing`, `verify-failed`, and unresolved checkpoints stay visible.

**Design tokens** lists each configured custom property as `--name: authored value`, sorted by name, parsed by the same loader the token-drift check uses. When `design.tokensFile` is not configured the section says so explicitly, so an agent knows token coverage is unavailable rather than assuming there are no tokens. A configured path that is absolute, escapes the project, cannot be read, cannot be parsed, or declares no custom property fails with the existing diagnostic; so does a malformed `project.json`, `rules.json`, `decisions.jsonl`, or reviewed `findings.json`, and a missing configured `DESIGN.md`/`PRODUCT.md`.

**Size ceiling.** A brief never exceeds **12,000 UTF-8 bytes**. Headers, every unavailable-evidence marker, and every section heading are reserved first; content is then allocated as recorded rulings and standing prohibitions, design law and craft checks, design tokens and project rules, accepted work, and finally product intent. Rulings are atomic and outrank replaceable prose, so a long law cannot hide its recorded resolutions. Truncation happens only at complete-entry and line boundaries: a ruling or prohibition is never split and neither is a multi-byte character. Whatever did not fit is reported in place, for example `(37 further lines omitted to stay within the 12000-byte ceiling)`.

**Evidence resolution across checkouts.** The brief resolves the tracked `.idiom/finding-names.json` registry alongside two gitignored stores, all through the same Git-topology boundary: the current checkout plus, from a linked worktree, the primary checkout. `.idiom/reports/` supplies the finding evidence that makes a prohibition behavioral; `.autobuild/tickets/` supplies the tracker state that tells built work from open work. Registry entries are unioned with the current checkout's names winning, so every rendered reference uses the same canonical name. The project's own report root wins on a run collision, and `context` writes to neither checkout. When a store is unreachable the brief still emits, marked:

- `Review evidence: unavailable in this checkout` — prohibitions fall back to the degraded fingerprint form and no accepted work can be listed.
- `Tracker state: unavailable in this checkout` — listed entries may already have been built.

The markers are independent; either can appear alone. Both mean the same thing — the store is absent from every checkout searched — and both are derived the same way, by probing for the root rather than counting what it holds. A store that exists but holds no run, and a tracker root that exists but holds no matching ticket, are genuine answers and are never marked.

**In a plain interactive session**, run the command and use its output directly:

```sh
idiom context booking
```

**In an Autobuild implement flow**, hydrate the phase first, then capture the brief as implementation context. Redirection is owned by the caller — the command only writes to stdout:

```sh
ab context
idiom context booking > .ab/design-brief.md
```

That worktree is exactly the case both primary-checkout roots exist for. A linked worktree materializes tracked files only, so it has neither `.idiom/reports/` nor `.autobuild/tickets/`: without the report root every prohibition would collapse to an opaque fingerprint, and without the tracker root every already-built ticketed finding would be handed to the implementer as outstanding work.


<a id="intended-designs-html-and-figma"></a>

## Intended designs

```sh
idiom design add <state> <source> [--flow <id>] [--name <name>] [--viewport <name>]
idiom review --page <url> --design <source> --deterministic-only
idiom decide --finding <id> --choose <reference>
```

For a worked example, matching, tolerances and auth, see the [design comparison guide](design-compare.md).

`<source>` accepts local HTML files/directories, public HTML prototype URLs and
local PNG/JPEG/WebP images (download remote images first). Live sites use a flow
state's `"design": { "site": "https://example.com/checkout" }`; this object is not
a `design add` argument. `<source>` may also be a Figma frame URL (`https://www.figma.com/design/<file>/…?node-id=…`,
from right-click → Copy link to selection). Without `--name`, `design add` replaces
the state's design with that one source; with `--name`, it adds or replaces that
named reference and keeps the others, so a state can carry, for example, a Figma
frame and an HTML prototype. `--viewport` limits a reference to one project
viewport. See [configuration](configuration.md#figma-frames) for the token, the
pinned cache and viewport selection.

`capture`, `review`, `check` and `verify` accept `--refresh-design`, which
refetches pinned Figma frames instead of reusing
`.idiom/designs/`. Verify refreshes only before its first recapture, so both
recaptures compare against the same frame. Outside a configured project,
`idiom quick <url> --design <source>` compares exactly one page against an image,
HTML, Figma or live-site source; quick has no refresh flag. `fix` always uses
the pinned cache so a repair loop's reference cannot move under it.

When a state's references disagree with each other about a matched element, the
finding is an `idiom:design-decision`: it shows each reference's value beside the
build and says which one the build matches. It is never a defect against either
reference. `idiom decide --finding <id> --choose <name>` records the intended
reference (the interactive prompt offers the names too). From then on the
`design-drift` check reports that element and property only against the chosen
reference, in every review, check and verify run. `--choose` is valid only for
design decisions and cannot be combined with `--accept`, `--reject` or `--group`.

`design add` updates only an authored state's `design` field in its original JSON
manifest. Use `--flow` for repeated state IDs. A generated route/page/combination
needs an explicit authored state to attach its own design. Repeating an assignment
is a no-op. Local paths are relative to the command's working directory and stored
relative to the project root when possible. Flow declarations resolve from the
project root. `review --page --design` resolves from the invocation directory;
`--design` without `--page` is rejected with configuration guidance.

Sources are a standalone `.html`/`.htm` file, a directory of exported HTML and
assets, or an absolute HTTP(S) HTML prototype URL without credentials. A directory
uses `index.html`, otherwise its sole top-level HTML file; ambiguous entry points
fail with a candidate list. Local assets are served from the file's containing
folder, or the selected directory. No build or dependency install runs for exports.

Accessible Claude Design/artifact shares use rendered preview discovery: a single
visible iframe (including `srcdoc`) or explicit `rel="preview"` link is opened as
the design page. The editor/share shell is never the comparison target. Restricted,
expired, login-only, missing or ambiguous previews fail with an export-HTML remedy.
No private API, account integration or share-ID-to-URL conversion is used. The generic
resolver is deliberately conservative; it does not promise that every provider
wrapper exposes a usable preview. Claude documents [exports](https://support.claude.com/en/articles/14604416-get-started-with-claude-design)
and [sharing/access](https://support.claude.com/en/articles/9547008-share-artifacts).

Capture first, then `idiom review <flow> --from <run-id> --deterministic-only` to
compare saved evidence without reopening the source. The report shows labeled
Design / App capture full views even when no drift is found. Findings carry both
property values, a match method and a proposed fix with paired crops; Markdown and
JSON retain this evidence too. To accept an intentional departure, use the normal
`idiom decide` rejection/suppression decision for the finding. Comparison never
edits application code or the reference.


## Finding basis, severity gates and acceptance verification

`check`, flow `review --since-baseline`, and single-flow/whole-product `sweep` severity gates count measured and observed findings by default. Add `--fail-on-judged` to include judged suggestions, including deferred current suggestions; `--fail-on never` disables severity gating. Flow baseline storage continues to classify deterministic occurrences only: opted-in judged suggestions are current critique, not baseline regressions. Page review retains its existing severity-option restriction. Advisory design review remains non-gating. Configured published-budget failures remain an independent review gate even with `--fail-on never`.

Every verify finding includes `acceptance: { contract, status, reason }`. For new executable rule contracts, **passed** maps to fixed, **failed** to reproduced, and **not-recheckable** to unverifiable. Missing/ambiguous targets, incompatible settings, disabled checks and incomplete evidence cannot prove a pass. The existing rules evaluate both captures; A/B disagreement prevents proof. Cross-tuple contracts select their recorded sibling coordinates.

Manual judged or historical model acceptance reports not-recheckable because human prose was not machine-proven, while existing calibrated visual-locus comparison still determines fixed/reproduced. Historical deterministic acceptance similarly reports not-recheckable while preserving coordinate-scoped legacy fingerprint verification. A changed visual locus or disappearing legacy fingerprint can therefore still produce a passing verification. `verification.kind: manual` remains unverifiable. Overall success still requires every finding verdict to be fixed and no new blockers; informational acceptance status adds no separate universal gate. Calibration, platform, design-reference, source-pinning and full-flow regression guards continue to apply. Reports and CLI show each acceptance reason, including when a global diagnostic prevents safe evaluation.

Informational findings (`info`) remain visible in check, review, sweep, JSON and
hosted reports, including baseline comparisons. They contribute zero blocking
findings and never fail severity gates, including `--fail-on-judged`. The
`--fail-on` choices remain `blocker`, `major`, `minor`, and `never`; there is no
info threshold. Digest alerts and counts omit effective info findings.

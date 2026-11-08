# Troubleshooting

Start with [`idiom doctor`](commands.md#doctor), which boots the server once the way a capture does and names the step that fails. Then read the first line on stderr and the exit code: a run that could not happen exits `2` and prints its cause first ([exit codes and setup failures](commands.md#exit-codes-and-setup-failures)).

```sh
idiom doctor            # the project's server
idiom doctor checkout   # also runs the flow's setup steps
```

## The server won't start or readyUrl is wrong

**Symptom.** A capture, `idiom check` or `idiom review` exits `2` with a first line such as `server failed to start: exit 1 — …`, `server failed to start: timeout after <ms>ms waiting for <readyUrl> — …`, `server failed to start: port <n> in use — <readyUrl> already answers` or `server failed to start: port pinned — started on <configured>, not reserved <port>`.

**Cause.** The `server` block in `.idiom/project.json` does not start this application: the start command crashes (often a missing environment variable), it ignores the `PORT` Idiom passes, it takes longer than `server.startupTimeoutMs`, something else already answers at `readyUrl`, or `readyUrl` never returns `200`.

**Fix**, in order:

1. Run [`idiom doctor`](commands.md#doctor). Each failing step prints a `fix:` line.
2. Run `idiom doctor <flow>` when the flow has setup steps, since they run before the server starts.
3. Act on the step that failed:
   - `start` exits: add the missing variable to `server.env`.
   - `port pinned`: read `PORT` in the start command, or set `"fixedPort": true` in `server` for an app that cannot take a port.
   - `port in use`: stop the other process, or choose a port with `--port <n>` or `IDIOM_PORT`. If it is a server an earlier Idiom run started, see [a server from an earlier run](#port-already-in-use-or-a-server-from-an-earlier-run-is-still-running).
   - `timeout`: raise `server.startupTimeoutMs`, and point `readyUrl` at a page that returns `200` once the app is ready.

```sh
idiom doctor checkout --port 4100
```

See the [project file](configuration.md#project-file).

## Port already in use, or a server from an earlier run is still running

**Symptom.** A run exits `2` with `server failed to start: port <n> in use — <readyUrl> already answers`, or prints `Stopped a leftover application server (pid <pid>, port <n>) from an earlier run.` on stderr before it starts.

**Cause.** An earlier Idiom run was killed before it could stop the application server it started: a `SIGKILL`, a closed terminal, or a CI or agent timeout. The server kept running and kept its port.

**Fix.** Usually nothing. Idiom records each server it starts in `.idiom/cache/servers/` and removes the record when the server stops. The next `idiom capture`, `check`, `check --gate`, `review`, `verify`, `sweep` or `doctor` in that project stops each recorded server whose run is gone, and prints one line per server. It stops only processes it started, and only while the pid still runs the recorded command, so a pid reused by another program is never touched. `idiom doctor` lists what it found under `leftovers` in its `--json` report.

If a run prints `Could not stop a leftover application server …`, or the port belongs to something Idiom did not start, stop it yourself, or choose another port:

```sh
lsof -i :<port>          # find the process holding the port
idiom doctor --port 4100 # or IDIOM_PORT=4100
```

## Playwright Chromium is missing or the wrong version

**Symptom.** A capture exits `2` with `capture failed to start: browser launch — …`, usually naming a missing executable.

**Cause.** Capture uses the Playwright-managed Chromium build that matches the exact `playwright` version Idiom pins. It is installed once per machine, separately from Idiom, and a different Playwright version installs a different build. `idiom doctor` does not launch a browser, so this shows up only when a capture starts.

**Fix**, in order:

1. Find the pinned version: it is in the README's [Browser setup](../README.md#browser-setup) for your release, and in the `playwright` entry of Idiom's `package.json`.
2. Install that build:

```sh
npx playwright@<version> install chromium
# Linux CI images also need the system libraries:
npx playwright@<version> install --with-deps chromium
```

3. Rerun the capture. After you update Idiom, repeat this if the release moved to a new Playwright version.

## Baseline refused on a dirty tree

**Symptom.** `idiom check` or `idiom baseline record` exits `2` with `baseline refused: tree dirty: <paths> (commit or stash, or pass --all)`, or with `baseline refused: the captured tree was dirty` after a capture.

**Cause.** A baseline is recorded only from a clean Git tree, so its findings belong to one commit. Untracked files that are not ignored count, and so does an uncommitted baseline directory. Files Idiom writes during a run (`.idiom/finding-names.json`, `.idiom/reports/` and the others listed under [Baselines](configuration.md#baselines)) never count. The doctor `tree` step warns about this in advance.

**Fix**, in order:

1. Commit the listed paths, or stash them under a name you can find again.
2. Commit a baseline you recorded earlier before recording another.
3. If only tracker/scratch paths change, configure [`baselines.ignoreDirty`](configuration.md#baselines) with narrow repository-root globs. Validation refuses discoverable application inputs.
4. For a busy checkout or merges landing during capture, run `idiom check checkout --ref HEAD` (or `--ref HEAD~1`) to capture a fixed committed revision. See [fixed-commit capture](commands.md#capture-a-fixed-commit). Commit the project configuration and flow at that revision; fetch missing history if the ref cannot resolve. Install the package manager selected by the revision's lockfile, and supply required environment variables (untracked `.env` files are absent).
5. Rerun the command:

```sh
git stash push -u -m "before idiom baseline"
idiom baseline record checkout
```

To look at findings without recording a baseline, pass `--all` to `idiom check`.

## Finding-name registry conflict in a worktree

**Symptom.** A run refuses with `finding-name registry refused: …`, or a run completes and prints `Warning: finding-name registry diverges from the primary checkout: skipped <n> conflicting entries …`.

**Cause.** In a linked Git worktree, finding names union `.idiom/finding-names.json` with the primary checkout's, so a branch keeps the names `main` gave its findings. When the two disagree, this checkout's names win and the conflicting primary entries are skipped, which is the warning. A registry that cannot be read or parsed, in either checkout, or a conflict inside this checkout's own evidence refuses the run. The doctor `registry` step checks this.

**Fix**, in order:

1. If you only see the warning, nothing is broken: the run finished with this checkout's names.
2. For a throwaway worktree (a benchmark or an experiment) that should not consult the primary at all, pass `--isolated-registry` for one run, or set `findingNames.isolatedRegistry: true`.
3. For an unreadable or invalid registry, restore the file from Git:

```sh
git checkout -- .idiom/finding-names.json
idiom check checkout --isolated-registry
```

See [Finding names](configuration.md#finding-names).

## MCP server not found or bound to the wrong project

**Symptom.** Your agent has no Idiom tools, or they fail with `no .idiom/project.json found …`, an error saying the server will not use its own plugin directory as the project, or results from another project.

**Cause.** The MCP server binds one project root when it starts: `--project` if given, otherwise its launch directory, and then searches upward for `.idiom/project.json`. A client that starts the server in the wrong directory, or Codex starting a plugin's server in the plugin directory, binds the wrong root. Tool arguments cannot switch projects.

**Fix**, in order:

1. In Codex, register the server with `codex mcp add`, which Codex starts in each thread's project directory. Copy the line for your release from [Standalone MCP setup](mcp.md#standalone-mcp-setup):

```sh
codex mcp add idiom -- npx -y --package=https://github.com/mattskilly/idiom/releases/download/v<version>/mattskilly-idiom-<version>.tgz idiom mcp
```

2. To bind a fixed root in any client, pass `--project`, for example `claude mcp add idiom -- idiom mcp --project /path/to/project`.
3. Restart the client or server after changing its registration or its environment (such as `FIGMA_TOKEN`).
4. Run `idiom doctor` (or the `idiom_doctor` tool) from the intended root to confirm it is the project you expect.

See [Project roots and evidence](mcp.md#project-roots-and-evidence).

## Model critique degraded or timed out

**Symptom.** `idiom review`, `idiom sweep` or a page review prints a degradation `Warning:` and the report is not labelled full. The run still exits `0` with the ranked deterministic findings.

**Cause.** The configured model provider could not complete: `claude` is missing or not signed in, a Claude Code session did not finish within its 10-minute bound, the model or CLI version is unsupported, `ANTHROPIC_API_KEY` is missing for the explicit `anthropic` provider, or `codex` is missing or not signed in.

**Fix**, in order:

1. Sign in to the provider you configured:

```sh
claude auth login     # model.provider "claude-code"
codex login           # model.provider "codex"
```

2. For the `anthropic` provider, set `ANTHROPIC_API_KEY` in the environment that runs Idiom.
3. Set `model.fallback` to a different provider, so a failing primary hands over visibly instead of degrading.
4. To review without a model at all, pass `--deterministic-only`.

See [review](commands.md#review).

## Low probe coverage

**Symptom.** `idiom check` prints probe coverage lines with many controls not reached, warns that more than 10% of the run's candidates were not reached, or `idiom coverage` lists disclosures the probe never opened.

**Cause.** The interaction probe works within time budgets (400 seconds per flow by default) and per-control limits. On a large app, controls past the budget, controls hidden behind a modal and repeated rows beyond the sample are not clicked. Each not-reached control carries its reason.

**Fix**, in order:

1. See what was reached per state, and which disclosures were never opened:

```sh
idiom coverage --states
idiom coverage
```

2. Give the probe more time for one run with `--probe-budget <ms>` (`0` sets no flow target), or raise `checks.probe.flowBudgetMs`. Raise `capture.maxMinutes` with it on very large apps.
3. Declare a state that opens the area the probe cannot reach, so its controls are probed from there.
4. Adjust `checks.probe` settings such as `maxControls`, `controlTimeoutMs` and `maxRevealed`.

See [Probe](configuration.md#probe) and [coverage](commands.md#coverage).

## Findings need a recapture after an upgrade

**Symptom.** After updating Idiom, a check shows as unavailable or not evaluated, or the report or `idiom coverage` says the evidence is missing until recaptured, when you replay an older run with `--from <runId>` or `--latest`.

**Cause.** A new or improved check needs evidence that older captures do not have. Stored runs stay readable and say what they lack instead of passing. Examples:

- action timelines and filmstrips (0.12.0), used by the motion, loading-state and layout-stability checks;
- failure replays for `error-state-missing` and `retry-blocked` (0.13.0);
- the recorded reduced-motion mode for state coverage (0.14.0);
- the disclosure and empty-container inventories, and the probe fingerprints `idiom check --gate` compares against;
- settings resolved at capture, such as layout invariants, `checks.page.ctaSelectors` or `checks.probe.respectControlIntent`.

**Fix**, in order:

1. Run a fresh check instead of replaying a stored run:

```sh
idiom check checkout
```

2. When the tree is clean, record a new baseline so later checks compare against the new evidence:

```sh
idiom baseline record checkout
```

The release-by-release list is in [Upgrading](upgrading.md#action-required-by-release).

## idiom check --gate is slower than its budget

**Symptom.** The gate's plan line estimates more than its budget, ends with `(no history)` or `estimate exceeds budget at minimum coverage`, or it prints several `skipped: …` lines and takes longer than you want.

**Cause.** The gate estimates from up to five stored runs of the flow, using defaults when there are none, and trims work to fit `--budget` (default three minutes). Building and starting a server, probing many changed controls and widening to more viewports or schemes all add time. Without a clean reference run, the probe runs unscoped.

**Fix**, in order:

1. Reuse the dev server that is already running, with `--reuse-server` or `server.reuse: true`:

```sh
idiom check --gate --reuse-server
```

2. Record a clean run so the gate has history and a probe reference: `idiom baseline record <flow>` from a clean tree.
3. Declare server-only directories in `checks.gate.nonUi` so their changes skip the gate.
4. Set the budget you can afford with `--budget` or `checks.gate.budgetMs`, and cap the probe with `--probe-budget`.

See [Gate a build](commands.md#gate-a-build) and [Build gate](configuration.md#build-gate).

## Node is too old

**Symptom.** Any `idiom` command or the MCP server exits `2` with `Idiom needs Node 22.12 or newer; this is Node <version>. Install Node 22.12+ (https://nodejs.org) and run again.` An MCP client shows the server failing to start, with that line in its server log.

**Cause.** Idiom requires Node 22.12 because its CLI library (commander) requires it, and 22 is the oldest Node line still maintained; older lines no longer get security fixes. The check runs before anything else loads, so an older Node gets this line instead of a module or syntax error.

**Fix**, in order:

1. Install Node 22.12 or newer from [nodejs.org](https://nodejs.org) or your version manager, and check the version:

```sh
node --version
```

2. For the plugin and `npx`, the `node` that matters is the one on the PATH the host launches with. With nvm or volta, set a default of 22.12 or newer, then restart the host.
3. Run [`idiom doctor`](commands.md#doctor): its first line reports the Node version.

## Most tuples timed out on a busy machine

**Symptom:** A check says `Host busy: 12 of 20 tuples timed out (load 64 on 11 cores). No review for: …`. JSON says `verdict: "deferred"`; the exit code is 3.

**Cause:** Navigation/readiness timed out again after one retry, made after the other tuples with double deadlines. The recorded 1-minute load/core ratio exceeded `capture.hostPressureThreshold` (default 1.5), or the ready URL became more than 10 times slower than its successful measurement at start. Missing measurements are unavailable; a busy start does not pretend to be an idle latency baseline. The report preserves genuine findings and lists the states that received no review.

**Fix:** Re-run on an idle host after other builds finish. Increasing the probe budget cannot make an unreachable state produce evidence: `Probe produced no evidence for <state>: the state timed out` recommends an idle-host re-run. On an idle host, persistent timeouts remain ordinary `missing-state` blockers to investigate. Very tall screenshots are capped at 16000 CSS px by default; adjust `capture.maxFullPageHeight` or a state's `screenshotTimeoutMs` if the report says a needed region was cropped.

## A run was interrupted

**Symptom:** A capture or check stopped early. On `Ctrl-C` or `SIGTERM` Idiom prints `Interrupted: run <id> kept 7 of 20 tuples (unverified).` on stderr and exits non-zero. After a hard kill (`SIGKILL`, a restart, a closed terminal), the next Idiom command in the project prints `Run <id> was interrupted (process gone) after 7 of 20 tuples.` once.

**Cause:** Each run's report directory, `.idiom/reports/<runId>/`, exists from the run's first second. Its `run.json` says `status: "running"` and lists the planned tuples, and Idiom adds each tuple to `completedTuples` once that tuple's evidence is saved. A clean finish sets `status: "complete"`. A run stopped before that is `interrupted`; when no process remains to say so, the next command that lists runs finds the `running` record whose process is gone and marks it.

**Fix:** Open `.idiom/reports/<runId>/run.json` to see how far the run got. `completedTuples` names the tuples whose screenshot, DOM and metadata are kept in their state/viewport directories, and `interruption` says why it stopped. That evidence is **unverified**: the run never reached its final source check, report or secret scan of the whole run. `check`, `review`, `decide`, `report`, baselines and MCP ignore interrupted runs, and passing one with `--from` explains that it is interrupted. Idiom cannot resume a run; capture again for a complete one. Delete interrupted run directories you no longer need.

Separately, when the first `check` would record the baseline and some tuples failed, it still reports the findings for the tuples that succeeded, lists the failed ones under `Coverage gaps`, and ends with `Baseline not recorded: 3 of 120 tuples failed (<list>). Findings for the other 117 are above.` It exits 1, even with `--fail-on never`. Fix or remove the failing states and check again to record the baseline.

## Still stuck

Run `idiom doctor --json` and `idiom --version`, then [open an issue](https://github.com/mattskilly/idiom/issues) with both outputs and the first lines of the failing command's stderr.

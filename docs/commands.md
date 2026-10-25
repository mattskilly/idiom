# Commands

How to run each Idiom command, its flags and what it prints. What to write in `.idiom/project.json`, flow files and CI configuration is in [configuration.md](configuration.md).

## Command index

```
idiom quick <url...>         # public-page review with no setup
idiom init                   # safe project scaffold
idiom validate [flow]        # project + manifest validation
idiom reference add|list|remove  # manage visual references and anti-references
idiom capture <flow>         # deterministic browser capture
idiom check <flow>           # every deterministic finding, in fix order
idiom baseline record|accept [flow]  # record or accept the regression baseline
idiom fix <flow>             # bounded local agent repairs with calibrated proof
idiom sweep <flow>           # checks + per-surface model sweep, uncapped
idiom learn <observation>    # turn a human-found miss into a check or ruling
idiom compare <flow>         # before/after composites between two stored captures
idiom coverage               # routes no flow captures
idiom review <flow>          # bounded deterministic + model critique
idiom report [runId]         # open the newest or named HTML report
idiom system [--learn]       # render or learn the project design system
idiom decide [--list]        # persist decisions or list lifecycle
idiom explore [flow]         # render three candidate directions for one state
idiom explore resolve <run-id>  # record the judgment on an exploration
idiom ruling --decision <id> # resolve a reviewed design-law question
idiom instruction            # render one accepted finding for pasting
idiom tickets                # turn accepted findings into triage tickets
idiom verify <flow>          # offline recapture and proof of resolution
idiom context [flow]         # bounded write-time design brief on stdout
```

## quick

Start the application yourself, then point Idiom at one or more public pages from the same origin:

```sh
cd /path/to/any/uninitialized-directory
idiom quick http://127.0.0.1:3000/
```

Add explicit pages to the same command when you already know the routes; Idiom preserves their order and does not crawl links or submit forms:

```sh
idiom quick \
  http://127.0.0.1:3000/ \
  http://127.0.0.1:3000/pricing \
  http://127.0.0.1:3000/contact
```

The command captures every supplied page at desktop (1440×900) and mobile (390×844) sizes in both light and dark colour schemes. It runs the deterministic checks and prints the exact `report.md` and `report.html` paths. By default, the timestamped result is written beneath `idiom-quick-reports/`; use `--out <dir>` for an exact new directory.

Read the final **Quick-review limits** section as part of the result. It names the fixture-dependent error and empty states, authenticated surfaces, form/interaction destinations, and product/design judgments that a public-page pass cannot cover. To cover those, run `idiom init`, declare a flow, and use `idiom review <flow>`.

Quick review requires no Idiom files, product or design documents, flow manifest, interview, Git repository, or model credentials. It deliberately refuses to run in or below a directory that already contains `.idiom/project.json`; use that project's configured flow so quick review cannot bypass its states or guidance.

## init

## Initialize a project

From the unrelated application you want to inspect:

```sh
cd /path/to/app
git rev-parse --verify HEAD
idiom init --yes
```

The Git check must print a commit. A plain directory, an uninitialized repository, or a repository with no commits can be initialized and validated, but cannot be captured; make its first application commit before continuing. Later uncommitted application or Idiom configuration changes are allowed and are recorded as a dirty source state.

Then edit `.idiom/project.json` and define a flow; both files are described in [configuration.md](configuration.md#project-file). Validate and capture the first flow end to end:

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

To start a flow from your routes, configure `.idiom/project.json` and run the app
at `server.readyUrl`, then run:

```sh
idiom init --flows --yes
idiom validate site
idiom capture site
```

Interactive `idiom init` also offers route generation; plain init with
non-interactive stdin skips the offer. Accepting it discovers Next.js App/Pages routes, `/sitemap.xml` (including sitemap indexes), and rendered
same-origin links, with at most 30 page paths admitted by the link crawl. Sitemap
and filesystem routes are independent of that cap. It writes
`.idiom/flows/site.json`, using the project's viewport names and colour schemes.
`--flows --yes` preserves a differing existing site flow; rerun interactively to
approve replacing that file. Other authored flows are preserved. For projects
with multiple surfaces, pass `--surface <declared-id>`; a sole surface is selected
automatically.

Generation visits the configured running local app; it does not build or start
it, execute setup, or call a model. Offline discovery still produces filesystem
states and explicit unverified notes. Dynamic templates need an observed,
verified example URL; unresolved templates are TODOs in `intent` and init output,
never literal bracket URLs. Redirects to login produce states at their original
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

If the repository root contains `autobuild.toml`, an interactive run also
offers to wire Idiom into Autobuild verification. Accepting the offer is only
discovery consent: Idiom then prints the exact configuration diff and asks
again before editing `autobuild.toml`; a differing regular verifier skill needs
its own replacement confirmation. The installed verifier lives at
`.agents/skills/ab-verify-idiom/SKILL.md`, with
`.claude/skills/ab-verify-idiom` linked to that canonical directory. Existing
compatible commands may use the repository's own safe flow name and compatible
steps may keep custom paths. Invalid or ambiguous TOML and foreign skill
occupants change no wiring files and produce the complete manual addition
instead, while the ordinary scaffold still completes successfully. A fully
wired rerun does not prompt or duplicate entries. `idiom init --yes` never
changes Autobuild configuration or installs the verifier; it only reports that
interactive wiring is available.

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

## validate

```sh
idiom validate --project /path/to/app
idiom validate booking --project /path/to/app
```

Without `--project`, validation starts in the current directory and walks upward to the nearest `.idiom/project.json`. With no flow argument it validates every `.json` file in `.idiom/flows/` in filename order. It validates the project first, then schema and cross-record constraints such as flow viewport names.

Success exits `0` and names the validated flows. Missing files, malformed JSON, and schema errors exit `1`; diagnostics include both the source file and exact field path, such as `states[3].urlFrom.pattern`.

To validate the committed real-world example:

```sh
idiom validate booking --project examples/booking
```

`validate` and init with no accepted flow-generation offer are fully local: they make no model, network, or external API calls. Explicit `init --flows` or an accepted interactive offer visits the configured local app for route discovery. Validation treats setup command strings as data and never executes them.

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
```

Without `--out`, each run gets a new timestamped directory under `.idiom/reports/`. An explicit output path must not already exist and is never overwritten. A custom path inside the target repository must either be under `.idiom/reports/` or covered by the repository's ignore rules; otherwise capture fails before setup so its own output cannot change the next run's source dirty flag. The run-level `baseline.md` links each capture tuple and its six artifacts. Existing singleton projects retain `state/viewport`; projects declaring multiple top-level `colorSchemes` use `state/viewport/colorScheme`:

- `screenshot.png` — full-page, animation-disabled rendered output
- `dom.html` — rendered DOM after the configured settle period
- `console.jsonl` — console messages and uncaught page errors
- `axe.json` — raw accessibility scan data
- `observations.json` — browser-time geometry, heading, computed-style, hit-test, and configured-token facts without review verdicts
- `metadata.json` — commit/dirty identity, flow, state, viewport, selected colour scheme and axis status, target provenance, timestamps, platform, browser/runtime, and Idiom versions

For a faster iteration, scope a fresh `capture` or `check` with comma-separated lists:

```sh
idiom check studio-lab --states editor,settings --viewports desktop --schemes light
idiom capture studio-lab --states editor --viewports mobile,desktop
```

Omitted flags retain the flow's full effective matrix. Lists trim whitespace and reject empty, duplicate, unknown or flow-excluded values. Selection preserves manifest order, intersects each state's viewport restrictions, and supports published-flow widths. State IDs match exactly, including generated route and toggle IDs: selecting a base state does not select its generated combinations. A scope with no effective tuples fails before setup, builds, server launch or output creation. Internal finding verification continues selecting exact coordinates.

Every new capture writes a versioned `run.json` alongside the tuple artifacts, recording its source, declared and selected matrices, probe placement and capture timings. `baseline.md`, `report.md` and `report.html` disclose selected versus successful tuples, intentionally skipped tuples, omitted states/viewports/schemes, and unsuccessful selected tuples. `check --json` includes structured `scope`, `coverage` and `timings`, even for clean checks. Scope flags require a fresh capture and cannot accompany `check --from` or `--latest`; replay uses the stored scope. Unscoped `--latest` skips recorded partial runs. Older runs without a record retain legacy full-matrix behavior. Uncaptured baseline coordinates remain uncovered when comparing findings.

Live probe progress goes to stderr before initialization and as each attempt starts/finishes, including state, completed count, selector and phase. Library callers can supply `onProbeProgress`; otherwise they remain silent. Timings also retain the five slowest attempted controls across the run, including selector, elapsed milliseconds and timeout outcome. JSON stdout remains a single result; stored-run replay preserves these historical control timings.

Completed `capture` and `check` commands print phase timings to stderr in milliseconds: build, server readiness, each tuple capture, probe, and deterministic checks. Tuple totals include probe time, which is displayed as an included submeasurement. Statuses distinguish measured, reused, skipped, unsupported and unavailable work. Capture-only runs skip checks. Rechecking a stored run preserves `run.json` and labels its capture phases as historical evidence; current checks are timed separately in versioned `checks-timings.json`. Legacy historical timings are unavailable. Timing values are excluded from deterministic findings.

Capture runs setup steps sequentially to full process exit. Web targets perform the configured server build, own the application server through readiness and teardown, and use a fresh browser context for every tuple. Electron targets skip the server and launch a fresh application for every tuple. An expectation or tuple-capture failure is recorded in metadata and the completed report; remaining tuples still run, artifacts are published, and the command then exits `1`. Setup and fatal publication failures stop immediately with an actionable error. Owned servers and Electron applications are closed on success, failure, and interruption.

Electron evidence has two disclosed provider boundaries. Diagnostics are one final snapshot of the selected renderer's last 200 Playwright-retained console messages followed by its last 200 page errors; auxiliary windows are excluded. Accessibility uses axe legacy mode because an Electron persistent context cannot open axe's normal aggregation page. Cross-origin frames are therefore not analyzed, and axe's `frame-tested` rule identifies untested frames. All six artifact names and downstream behavior remain the same as web capture.

Before publication, Idiom scans every staged artifact for non-empty inherited or configured environment values named `*_TOKEN`, `*_SECRET`, or `*_KEY`. A match identifies only the variable and artifact, removes the private staging/data directories, and publishes nothing. Capture makes no model or external API calls; after dependencies and Chromium are installed, its only HTTP traffic is to the configured loopback application.

Reproducibility is a same-machine contract because the booking app deliberately uses system fonts. Context settings, device scale, iteration order, and artifact paths are pinned. The app also intentionally mints new private booking slugs on every fresh seed: Idiom uses each raw value only for in-memory navigation, redacts it from textual artifacts, and persists the stable setup-output declaration plus a state-keyed URL template. Literal state URLs are recorded exactly. Therefore unchanged consecutive runs have equivalent screenshots and metadata after removing only the named timestamp fields.

Probe, time-budget and colour-scheme settings are in [configuration.md](configuration.md#capture-settings); production builds are in [configuration.md](configuration.md#production-builds).

## check

`idiom check` protects the flow against regressions by default. On the first check without a reachable baseline it records the already captured clean HEAD, announces the acceptance, and passes: existing defects become pre-existing. Commit the generated `.idiom/baselines/<flow>.json` (and the pixel directory for a published flow). Later checks report **New**, **Fixed**, and **Pre-existing** findings with the baseline SHA, and gate only new live deterministic occurrences. The capture runs once; repeated checks never advance the baseline automatically.

Initialize on the branch state you want to preserve. A dirty or historical capture cannot initialize a HEAD baseline: commit or stash, capture clean HEAD and retry, or use `--all` to inspect every open finding. Once a baseline exists, checks can compare dirty working changes normally. After intentional changes, run `idiom baseline accept <flow>` and commit the updated record. This is model-free and repeatable:

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
```

The full `--all` view starts with **Top issues** (five by default, adjustable with `--top <n>`), ranked by severity, then the number of distinct places (state/viewport/colour scheme/combination coordinates), then whether the issue affects a primary action. Similar sibling elements failing the same rule collapse into one issue with the element count and one example. This is a selector heuristic: positional indices and digit runs in IDs and quoted attribute values are ignored after selector normalisation; tag names and stable classes stay distinct. It can combine structurally similar controls that are not DOM siblings. Complete ties preserve first-seen order. Places are a union across the sibling groups, so forty rows on four screens count as four places. The remaining issues are counted per category. `--all` lists them in ranked order and exposes every sibling group's evidence and decision command.

The same element failing the same rule in several states, viewports or colour schemes remains one group: `Seen: seen in 2 states; viewports: mobile, mobile-short; schemes: light, dark (8 coordinates)`, member finding IDs, one representative crop, and `idiom decide --group <id>`. A collapsed issue's decision command applies only to its example group; use `--all` to decide other elements individually. Finding IDs, fingerprints and decisions stay per member, so `--fail-on` and the blocking count are unchanged, and a decision on one member still suppresses only that member. `--all --json` keeps every open finding in the flat `findings` array and the existing `groups`, each with every member and its coordinates (`state/viewport[/scheme][#combination]`). It adds the complete ranked `issues` array with group IDs, element/places/finding counts and the primary-action signal. Every group appears in exactly one issue. Default JSON uses `findings` for new occurrences and `preExistingFindings` for existing occurrences, with `fixed` and `baseline` provenance. Full mode JSON also includes `groups` and `issues`. Reports, `groups.json` and legacy `--baseline` retain their existing forms.

`--emit-tickets <dir>` writes spec-standard proposals for this check's persisted, actionable findings, grouped by observed component and category within the flow. It requires no acceptance decision and creates none. Deferred-only and occurrence-only rows are excluded; in default and recorded-baseline modes, only reported new material findings qualify. The directory is a **file tracker root**: `.autobuild/tickets` writes beneath `.autobuild/tickets/triage/`; passing the `triage/` directory itself works too. Existing member identities suppress retries, including after a ticket is renamed or promoted. Crop links point to the retained report, with full screenshots as fallback and missing crops marked unavailable. Ticket counts, covered IDs and paths appear in text and the optional JSON `tickets` result. Emission runs before `--fail-on` is applied, so a failing check still deposits its requested proposals. Without the flag, check output and behavior stay unchanged.

A recorded baseline is a small committable file at `.idiom/baselines/<flow>.json`: deterministic finding fingerprints and aliases per state, viewport, colour scheme and combination, plus the captured commit, version and checks configuration hash. It contains no screenshots. `baseline record <flow>` and `baseline accept [flow]` require a clean captured tree and accept `--from <runId>`, `--latest`, `--prod`, `--port`, `--json` and `--out <directory>` (overrides both JSON and pixel destinations). Accept infers the flow only when exactly one is configured; otherwise it lists the choices. It stores the capture's commit, even when replayed later, and replaces an existing record for that commit. Each file retains up to twenty records.

Default checks and `--since-baseline` select the recorded ancestor nearest HEAD by Git commit distance, with recording time breaking ties. Demonstrably unrelated branch records are skipped and retained. Missing Git objects or shallow-history uncertainty require fetching more history; they never authorize replacement. `--since-baseline` requires an existing reachable record. `--baseline-file <path>` selects only that compact file (relative to the invocation directory), also strictly: missing, malformed, wrong-flow or unreachable files fail without initialization. `--all` cannot accompany any baseline selector, and the three explicit selectors cannot be combined. Text and JSON separate **new**, **fixed** and **pre-existing** findings. The exit status and `--fail-on` apply only to new live deterministic occurrences, with rules, severity overrides and review lifecycle status applied. Each viewport participates independently, including findings beyond the report's attention cap. Fixed rows use the baseline's stored severity; a missing or failed tuple is listed as uncovered and cannot establish a fix. Suppressed findings still count as present evidence when deciding whether a defect was fixed.

A changed normalized `checks` configuration or installed check set warns that the baseline is **possibly stale**; comparison continues. Use `baseline accept` after intentional configuration changes. `idiom review studio-lab --since-baseline` supports the same gate, `--json` and `--fail-on` (the latter only gates review with this flag); model findings are counted separately as unclassified. Review also writes `baseline-comparison.json` beside its ordinary report.

Unlike `review`, `check` lists every open finding, including those past the review's `model.maxFindings` attention cap. `--baseline` makes it a regression gate: findings already present in the baseline run are counted but not reported. `idiom context` carries a **Craft checks** section that tells a builder, before they write anything, what `check` will reject, using the project's own values.

Every check and its settings are listed in [configuration.md](configuration.md#checks). The baseline directory setting is in [configuration.md](configuration.md#baselines).

### Run in Autobuild

For an Autobuild gate, initialize and commit the baseline so build worktrees inherit it; accept it again after intentional changes:

```sh
idiom check studio-lab
git add .idiom/baselines
git commit -m "Record studio baseline"
# In each build:
idiom check studio-lab --since-baseline --fail-on major
```

The `autobuild.toml` wiring is in [configuration.md](configuration.md#autobuild), and the pull-request workflow in [configuration.md](configuration.md#github-action).

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
order, including findings beyond the review attention cap. Applicable rejected
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

Unlike `review`, a sweep reports every finding, ranked by severity with measured findings ahead of model findings at the same severity, and writes `sweep.json` (per-surface status, crops and counts) beside the usual reports. A surface whose critique fails is listed as failed while the other surfaces keep their findings. Sweep findings live in the run's `findings.json`, so `idiom decide`, `idiom tickets --cluster` and the HTML report work on them unchanged. `review` is unchanged; sweep is an additional, model-assisted mode and needs the same `model` configuration.

## learn

When a person spots something every check missed, `idiom learn` turns the observation into configuration the next check measures, or a ruling the next review enforces:

```sh
idiom learn --state editor "the override dots should be 8px"
idiom learn --state editor "the toolbar should be 48px tall"
idiom learn --state editor 'say "Sign in" not "Log in"'
idiom learn --state editor "the left rail and the right rail should mirror horizontally"
idiom learn --state editor "section headers never use all caps"     # becomes a ruling
idiom learn --state editor --screenshot annotated.png "the override dots should be 8px"
```

Sizes become `checks.components` entries (or, with "tall"/"wide", a state invariant in the flow manifest), quoted wording becomes a `checks.copy.glossary` term, "A and B should mirror" becomes a `checks.mirrored` pair, and anything else becomes a design-law ruling in `DESIGN.md` (force that with `--ruling`, and set its text with `--wording`). The subject ("override dots") is resolved to a selector from the state's newest stored capture; pass `--selector <css>` when it is ambiguous or nothing was captured. Learn prints the exact diff and writes nothing until you confirm it:

```diff
--- a/.idiom/project.json
+++ b/.idiom/project.json
@@ -34,5 +34,15 @@
     "provider": "claude-code",
     "model": "claude-sonnet-4-5",
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

Every learning also appends a line to `.idiom/learned.jsonl` naming the observation, what it became and the capture it was seen on (plus a copy of `--screenshot` under `.idiom/learned/`); commit both. Component sizes, invariants and mirrored pairs are measured at capture time, so run `idiom check <flow>` (a fresh capture) to see them report.

## compare

`idiom compare` pairs two stored captures of a flow by state, viewport, scheme and combination, and writes a labelled before | after composite for every tuple whose pixels changed. Unchanged tuples are listed, not rendered:

```sh
idiom compare studio-lab --from <after-run> --against <before-run> --out .ab/idiom-compare
```

`before-after.md` lists changed, unchanged and not-comparable tuples, then the deterministic findings that are new in `--from` and fixed since `--against`. Its `attachments.json` uses the same contract as `idiom verify` output (`idiom-before-after-NNN` composites, the `idiom-verify-report` report), so the `ab-verify-idiom` delivery steps attach it to an Autobuild PR unchanged; see `templates/autobuild.idiom.toml`. Compare is evidence, not a gate: it exits 0. Without `--out` it writes `.idiom/reports/compare-<timestamp>`; an existing `--out` is replaced only if compare owns it.

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

New projects default to the subscription-backed `claude-code` provider, so full review needs an installed and authenticated Claude Code CLI but no API key. Idiom launches an isolated non-interactive session with only the `Read` tool, passes screenshots and image references as absolute readable paths, and sends all other critique context over stdin. The configured model identifier is passed to Claude Code. Idiom removes `ANTHROPIC_API_KEY` from this child only so an inherited key cannot override subscription authentication.

The direct Messages API remains an explicit fallback for existing projects and machines that cannot authenticate Claude Code. Select it in `.idiom/project.json` and provide the key in the process environment:

```json
{
  "model": {
    "provider": "anthropic",
    "model": "claude-sonnet-4-5",
    "maxFindings": 5
  }
}
```

```sh
ANTHROPIC_API_KEY=<credential> idiom review booking
```

Review writes `findings.json`, `unruled-decisions.json`, `report.md`, and `report.html` beside the capture. Both report formats begin with the declared flow coverage: selected states, viewport dimensions, colour schemes, successfully captured tuples, commit identity, project axes narrowed out by the flow, and any failed or unavailable tuple. When surfaces are declared, the same block always names judged, governed-but-not-judged, and ungoverned groups, including an explicit `none`. The self-contained HTML groups findings by state and embeds every displayed screenshot; it makes no network requests and supports light and dark system themes. It always runs ten local checks for overflow/clipping, narrow-viewport breakage, contrast, accessible labels, target size, headings, design-token drift, console errors, missing states, and spacing-rhythm outliers, plus the thirty-two craft checks described under [Checks](configuration.md#checks). Spacing rhythm is inferred only from a strong prevailing clearance among comparable interactive placements in the current run, so uniformly tight products are not judged against a built-in spacing scale. Captures with legacy observations show that check as `not evaluated` instead of guessing. Both providers receive the same product/design context, prior decisions, rules and rulings, every eligible deterministic finding, managed reference and anti-reference images with their notes/provenance, legacy loose references, captured screenshots, and bounded allowances. Both polarities are equally binding. Both providers return strict findings plus best-effort decision observations. Findings retain their existing local screenshot/state/viewport, exact known-reference-label, and no-rating validation. A `reference-mismatch` finding must cite at least one specific reference or anti-reference label; that citation is persisted and printed in the report. The direct provider retains its base64 Messages transport and requires an image-capable Messages model.

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

A report is labeled full only when the selected model provider completes successfully. `--deterministic-only` is labeled as an intentional model skip. A full review invokes the provider even when deterministic candidates already meet or exceed the material cap; cap saturation is never itself a degradation. A missing or unauthenticated `claude`, an unsupported model or CLI version, malformed output, provider/network failure, or missing API key on the explicit `anthropic` path produces a visible degradation warning and a non-full report. When Claude Code cannot run and no API key is available, the warning names both prerequisites and still exits 0 with ranked deterministic findings. A present key is never used as an automatic fallback; the warning explains how to select `model.provider: "anthropic"` explicitly. Partial model batches are never published. `--deterministic-only` does not construct a provider or read provider-only screenshot/context inputs and makes zero external calls. A corrupt decision log remains an actionable project-data error because silently forgetting human policy would be unsafe.

`--from` validates the stored flow and commit coherence and does not compare with current `HEAD`, launch a browser, start a server, or run Git. In full mode it may call the configured model; combine it with `--deterministic-only` for an offline replay. When `design.tokensFile` is absent, token drift is reported as skipped; when declared, the project-relative stylesheet is parsed and its custom-property values are normalized in Chromium. Review never produces an aggregate design rating.

Findings use short names such as `finding-12`. `.idiom/finding-names.json` owns the monotonically increasing allocation plus every historical fingerprint and legacy `IDM-...` alias for each lineage. Review reserves names for material, deferred, and suppressed findings before publishing its artifacts, so a hidden or deferred name is never recycled. Linked worktrees union the local and primary registries; compatible entries merge, while divergent allocation of one name or identity fails closed instead of guessing. Existing projects need no rewrite: when the registry is missing, Idiom deterministically reconstructs it from decisions first, then retained reports and embedded ticket findings, and the next mutating `review`, `decide`, or `tickets` command persists it. `idiom context` performs the same projection read-only.

Fingerprint inputs are canonicalized deterministically: Unicode and whitespace are normalized, CSS combinator spacing is standardized, stable classes in each compound selector are sorted, and generated/hashed classes are discarded when a tag, ID, attribute, or stable class still anchors the compound. A generated-only compound retains its original token rather than collapsing unrelated elements to one empty identity. Legacy hashes and IDs remain lookup aliases, so existing decisions, reports, and tickets stay readable and effective. Re-observing the same problem reuses its registry name and adds an occurrence to that lineage rather than creating a new identity. Ticket IDs, run IDs, capture directory names, fingerprints, ranking, and finding caps are unchanged.

### Review a generated page

`idiom review --page <url>` reviews one rendered page, such as an AI-generated landing page, without a flow. It captures the page at desktop and mobile in light mode and runs every deterministic check: one H1 and heading order (`heading-structure`), contrast, and the craft checks above, plus `page-content`, which looks for placeholder or lorem ipsum copy, a hero or final section with no call to action styled as a button, and images with no alt text.

```sh
idiom review --page https://localhost:3000/ --brief brief.md --direction direction.md \
  --focus hierarchy primary-action --frame refs/editorial.png "Calm, editorial, one accent colour"
```

With `--brief`, every statistic on the page (percentages, multipliers, prices, `12,000+ teams`, `4.9/5`) has to appear in the brief, or `page-content` reports it as `idiom:unsupported-claim`. Footers and years are ignored. The model critique (`--model`, `--provider`, or the project's `model` inside an Idiom project) reads the brief and direction as numbered lines. It reports sections that drift from the direction (`direction-drift`), offer changes (`offer-change`) and claims the brief does not contain (`unsupported-claim`). Each finding names the page section (`s1`, `s2`, …), cites the brief or direction line it relies on, and gives a concrete fix. Citations are checked against the file: a line that does not exist, or an excerpt that is not on it, is rejected. Only the brief is the source of truth; claims are never fact-checked against the web.

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
- Give exactly one of `path` or `state`. A `path` pattern is captured as a generated state named `pattern-<id>` with the flow's viewports and colour schemes. A `state` pattern reuses a state the flow declares.
- `intent` says what the pattern is meant to look like and do.
- `reference` (optional) names a managed reference (`idiom reference add`) or a project file: an image, or a text file used as written guidance. Without it, a managed reference named exactly like the pattern id is paired automatically. A named reference that cannot be found fails that pattern only.

Each request carries that pattern's screenshots, DOM, measured geometry, the sections detected on the page (as in page review) and its reference. Each finding names a section, an `aspect` (`spacing`, `hierarchy` or `coherence`) and a concrete fix, and gets a crop of the cited section.

The results are advisory. They are written to `advisory.json` in the run directory and shown in a separate "Advisory design review (does not gate)" section of `report.md` and the HTML report. They never appear in `findings.json`, groups, tickets or `--fail-on`, and they cannot be decided with `idiom decide`. A pattern whose request fails is marked failed and the others are kept; a pattern whose state was not captured in the run is marked skipped.

`idiom review <flow>` runs the advisory pass whenever the flow declares `content` and the model layer runs, so `--deterministic-only` skips it. `idiom check <flow> --advisory` runs it beside the deterministic checks and prints the advisory entries before the `Full report:` line; check's exit code and `blocking` count ignore them. Without `--advisory`, check makes no model calls. Each pattern costs one model request per run; `--states` narrows a fresh capture to the patterns you are working on.

## report

Open a report in the default browser by run ID, or omit the ID to select the newest `report.html` by modification time (with a stable run-name tie-break):

```sh
idiom report
idiom report <runId>
```

Discovery and named lookup are limited to direct children of `.idiom/reports/`. HTML reports are offline and read-only: screenshots are data-embedded, evidence links stay local, and there are no finding or ruling controls. Choose **Print or save as PDF** to open the browser's native print dialog. The printed form hides controls but keeps findings, unruled questions, unclipped text evidence, and labeled static before/after pairs; tall full-page images are scaled to the paper box instead of clipped. Continue to record finding decisions through `idiom decide` and design rulings through `idiom ruling`.

## coverage

```sh
idiom coverage                       # routes from Next.js app/ and pages/ directories
idiom coverage --crawl http://localhost:3000/   # or same-origin links on a running page
```

Coverage lists every route against the flows that capture it, so an uncaptured dashboard is a visible gap rather than silent approval, and prints the `routes` line that would capture the plain ones. Dynamic routes show the concrete paths flows used, e.g. `/p/[id] (e.g. /p/abc123)`.

Exclusions are configured with [`coverage.exclude`](configuration.md#coverage).

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
inline `design.tokens` become token rows. Colour aliases may be resolved from project-contained relative CSS
imports and regular `.css` siblings of that file, but those supporting
properties never become displayed tokens. Missing, cyclic, or conflicting
support is reported on the affected token instead of guessing application
cascade order. The browser resolves colour syntax—including fallbacks and
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
dimension purposes are labelled as inferred: spacing/space/gap/padding/margin,
radius/radii, and explicitly named control/button/input heights. Ambiguous
layout dimensions and unsupported composites remain display-only. Tailwind
resolver defaults are counted separately and excluded from proposed tokens and
scales; only project-declared entries (including resolved references) are learned.
Missing/cyclic aliases, conditional declarations
and conflicting independent sources are disclosed instead of becoming rules.
A recognized source that cannot be read or parsed aborts the proposal.

`checks.scales.spacing` accepts CSS-pixel numbers and base-step entries such as
`[8, 12, { "multipleOf": 4 }]`. The latter represents v4's unbounded `--spacing`
family. It checks authored padding, margin magnitudes and row/column gaps on
visible elements, with a 0.5px rounding tolerance. Empty leaves existing
spacing-rhythm inference unchanged. Only declared control heights become height
rules. Generic radii apply to every radius role; named roles apply to that role.
Colours remain typed so spacing values cannot authorize a radius or a colour.
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

Rejections default to `--scope instance`. Rule scope is defined only for rejection: `--accept --scope rule` (and `--accept --scope instance`) fails with `--scope applies only to --reject` and appends nothing. Reasons are optional for either decision but cannot be blank.

Every actual accept or reject appends one schema-valid record with the canonical name to `.idiom/decisions.jsonl`; skip and quit append nothing. The log is never rewritten. Historical commands may still supply an `IDM-...` alias and resolve the same lineage. An instance decision applies to that lineage occurrence at the recorded commit, so a re-observation on a later commit is presented and requires its own decision even though its stable name is unchanged. Separately, the latest rule-scope record for a fingerprint controls standing suppression across the lineage: a rule rejection suppresses future matches, while a later rule acceptance removes that suppression.

Use `idiom decide --list` for a read-only lifecycle view. It renders one entry per stable lineage with the canonical ID/fingerprint, aliases, surface, first/latest observation and occurrence count, latest decision, ticket/tracker state, verification result, and the ordered path from `open` onward. `--list` cannot be combined with decision flags and never appends to the log.

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
colour scheme, using the same capture pipeline as review. It never generates a
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

Every invocation also reads the canonical tracker's Markdown tickets once and strictly indexes their complete `idiom:finding` blocks by exact historical finding-ID/fingerprint pair. If no generated filename is authoritative, any `ticketed` or `verified-fixed` occurrence in the lineage, or any exact embedded record in an existing or completed ticket, suppresses emission and is reported as already resolved. This keeps a human-consolidated ticket authoritative after its redundant standalone files are removed; embedded discovery checkpoints `ticketed` without downgrading `verified-fixed`. Successful canonical tracker emission uses the same atomic checkpoint. A custom `--out` draft consults canonical tracker and persisted lifecycle state and retains no-overwrite behavior within its own directory, but does not checkpoint `ticketed`, so drafting cannot suppress a later canonical emission.

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

Deduplication checks individual members before grouping, across arbitrary Markdown filenames at the requested tracker root and its state directories, plus the source tracker. Canonical names, historical aliases/fingerprints and legacy standalone filenames remain authoritative after renaming, promotion or consolidation. Existing tickets are never overwritten or extended. If a component gains new findings, only uncovered members receive a new proposal; multiple owner files produce a per-member conflict while unrelated work proceeds. Canonical publication checkpoints accepted members as ticketed without replacing verification status. Custom drafts and unaccepted check proposals do not checkpoint lifecycle status.

## verify

Verify one or more machine-readable findings embedded in a ticket spec:

```sh
idiom verify booking --spec .ab/spec.md
idiom verify booking --spec .ab/spec.md --against <runId>
idiom verify booking --spec .ab/spec.md --against /path/to/copied/capture
idiom verify booking --spec .ab/spec.md --out .ab/idiom
```

Verification is fully local and never constructs the critique adapter, reads a model credential, calls `fetch`, or contacts an external API. It resolves the immutable source capture by matching the exact historical fingerprint and an intersection of the ticket finding's canonical/legacy ID set with the retained finding's ID set, while still requiring the same flow, state, viewport, colour scheme, and commit. A safe run id is searched beneath the current checkout's `.idiom/reports/` and, from a linked worktree, the primary checkout discovered through Git's common-worktree topology. An explicit absolute or project-relative capture directory supports retained evidence copied elsewhere. Keep the original ignored capture: a missing baseline is never replaced by recapturing the already-fixed tree.

Only the exact referenced state/viewport/colour-scheme triples are captured—never their independent Cartesian cross-product. Historical findings without a scheme resolve to `capture.colorScheme`. Verification of an inert-scheme finding deliberately selects the flow's full declared grid. Idiom performs two independent setup/data/build/server/browser lifecycles for those tuples. Current A/B evidence must agree under the full version-2 structured rendered profile at every selected triple and under the exact historical comparison profile before any finding can be marked fixed. Version-1 captures remain supported without recapture through a rendered-only projection of their shared subtree text, computed styles, and ancestor-relative geometry. Non-rendered script/flight records are removed first; 500-character-boundary, temporal, and masked-ancestor text is suppressed and reported. Browser-evaluated version-2 mask membership is transferred structurally to version 1, widened when possible, or uses a reported temporal-mask fallback. Malformed masks, A/B mask drift, corrupt ancestry, platform mismatch, and nondeterminism fail closed.

The verdict uses structured DOM text, allow-listed semantic/presentation attributes, computed style, deterministic checks, and stable-island-relative geometry. Dates and times plus their layout reflow are normalized away. PNG differences and raw dimensions are inspectable evidence only, and unequal image sizes are padded safely for the paired composite. A declared target may disappear consistently when its stable region remains coherent; unrelated changes outside a bounded locus cannot prove a finding fixed.

Output defaults to a fresh `.idiom/reports/verify-<timestamp>/`. An explicit `--out` is the exact verify-owned directory and is atomically replaced on retry. It contains `before-after.md`, `report.html`, `attachments.json`, one `before-after-<state>-<viewport>.png` per referenced tuple, and `current-a/` plus `current-b/` recapture artifacts. Both reports identify finding-selected scope—or the full declared grid required by a full-flow finding—and the historical baseline and current recapture commits; neither scope is presented as a fresh whole-flow review. The self-contained HTML embeds labeled before/after images and provides a presentation-only comparison slider plus the browser-native print/save action. Its content-security policy forbids external requests. The slider disappears in print while the static pair remains. Attachment kinds are stable and distinct: `idiom-before-after-001`, `idiom-before-after-002`, and so on in manifest order, plus `idiom-verify-report`.

Default verify outputs can be opened with `idiom report`. Custom outputs outside `.idiom/reports/` are intentionally not discovered; for the example above, open `.ab/idiom/report.html` directly in a browser.

Exit `0` means every finding is fixed or the spec contains no findings. The no-findings outcome reports zero exercised states and tuples and no captured commit identity; it performs no Git source inspection, setup, build, server, browser, provider, or external API work. Exit `1` names every reproduced finding, new deterministic blocker, or calibration/projection failure and points to the published report. Review and verification reports describe evidence and limits; they never calculate a score or grade.

Copy-ready Autobuild assets live at `templates/ab-verify-idiom/SKILL.md` and `templates/autobuild.idiom.toml`. Interactive `idiom init` can vendor the skill and add the agent step to a target repository's ordered `[verify].steps` array after the separate offer and exact-diff configuration confirmation described above. Unsafe edits fall back to printing this full manual payload. Non-interactive `idiom init --yes` never modifies or installs Autobuild wiring.

## context

Everything above improves UI after it renders. `idiom context` is the other half of the loop: it emits the accumulated judgment as plain Markdown on stdout, sized to paste into any agent's context *before* it writes UI, so the same mistake stops being generated at all.

```sh
idiom context
idiom context booking
idiom context booking --project /path/to/app
```

It is offline, model-free, and read-only: no provider is constructed, no credential is read, `fetch` is never called, no browser or server is started, and neither checkout is written to. The only child process is the same local Git topology query verify uses, and its failure degrades rather than fails.

**Scope.** With no argument the brief is the complete project-wide view and reads no flow manifest at all, so it succeeds in a repository that has none yet. With a flow argument it validates exactly `.idiom/flows/<flow>.json` and requires the manifest's `id` to equal the argument; a missing, malformed, or mismatched named manifest fails with the usual project-relative diagnostic, and unrelated manifests are never read. An unknown flow is an error, never an empty under-scoped brief.

**Sections, in this fixed order.** `Recorded rulings`, `Design law`, `Standing prohibitions`, `Design tokens`, `Project rules`, `Accepted work not yet built`, and `Product intent`. The design-law section carries the human-authored portion of `DESIGN.md`; appended ruling blocks are parsed into atomic rule/no-rule entries in the first section. Product intent carries `PRODUCT.md` unchanged. Parse section boundaries by scanning for these seven titles in order. Output carries no invocation-specific data, so two runs over unchanged data are byte-identical.

**Standing prohibitions are project-wide.** A rule-scope rejection suppresses its fingerprint everywhere, exactly as review already treats it, so every active one appears in every brief regardless of the flow argument. Aliases are resolved across a lineage, and the latest rule-scope record for that lineage decides: a later rule acceptance removes the prohibition. The prohibited behavior is sourced from the lineage's *latest* finding — `Do not repeat this rejected pattern: <explanation>`, plus its `rule` (or `category`), the recorded reason or `No reason recorded`, the rejection count, project-wide applicability, and the *first* observed surface as provenance. A fingerprint is traceability metadata, never a behavior description: when a rejection has no finding artifacts anywhere, the entry degrades explicitly to `Do not reintroduce the standing rejected pattern identified by fingerprint <fingerprint>; descriptive finding evidence is unavailable.`

**Rules and accepted work are the only flow-scoped content.** With no flow, every rules-file override is included in file order with its complete match annotated, so a `flow` constraint stays visible. With a flow, global overrides plus overrides whose `match.flow` equals that flow are included. Accepted findings follow the same split. Accepted work uses ticket-emission eligibility: a lineage accepted at its latest occurrence, minus anything `verified-fixed` or resolved to a `done` tracker ticket. `triage`, `ready`, `doing`, `verify-failed`, and unresolved checkpoints stay visible.

**Design tokens** lists each configured custom property as `--name: authored value`, sorted by name, parsed by the same loader the token-drift check uses. When `design.tokensFile` is not configured the section says so explicitly, so an agent knows token coverage is unavailable rather than assuming there are no tokens. A configured path that is absolute, escapes the project, cannot be read, cannot be parsed, or declares no custom property fails with the existing diagnostic; so does a malformed `project.json`, `rules.json`, `decisions.jsonl`, or reviewed `findings.json`, and a missing configured `DESIGN.md`/`PRODUCT.md`.

**Size ceiling.** A brief never exceeds **12,000 UTF-8 bytes**. Headers, every unavailable-evidence marker, and every section heading are reserved first; content is then allocated as recorded rulings and standing prohibitions, design law, design tokens and project rules, accepted work, and finally product intent. Rulings are atomic and outrank replaceable prose, so a long law cannot hide its recorded resolutions. Truncation happens only at complete-entry and line boundaries: a ruling or prohibition is never split and neither is a multi-byte character. Whatever did not fit is reported in place, for example `(37 further lines omitted to stay within the 12000-byte ceiling)`.

**Evidence resolution across checkouts.** The brief resolves the tracked `.idiom/finding-names.json` registry alongside two gitignored stores, all through the same Git-topology boundary: the current checkout plus, from a linked worktree, the primary checkout. `.idiom/reports/` supplies the finding evidence that makes a prohibition behavioral; `.autobuild/tickets/` supplies the tracker state that tells built work from open work. Registry entries are unioned strictly so every rendered reference uses the same canonical name. The project's own report root wins on a run collision, and `context` writes to neither checkout. When a store is unreachable the brief still emits, marked:

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

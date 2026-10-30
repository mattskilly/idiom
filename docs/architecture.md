# Architecture

Presentation lists rank by severity first (BLOCKER, MAJOR, MINOR), then prominence as measured by the existing salience × prominence score within each tier. Scoring, rule severities and finding identity are unchanged; see [ranking](ranking.md).

Idiom is a repo-native design acceptance loop for existing applications: it learns a product's intended design, renders real flows in a browser, critiques them against product and design context, drives bounded repairs through tickets, verifies the result, and remembers what the human accepts. This document is the technical contract for the MVP. Record schemas live in [schemas.md](schemas.md); scope and sequencing live in [mvp-spec.md](mvp-spec.md) and [mvp-backlog.md](mvp-backlog.md).

## The loop mapped to commands

| Loop stage | Command | What it does |
|---|---|---|
| First result | `idiom quick <url...>` | Captures explicit public pages and emits deterministic findings without project configuration |
| Learn | `idiom init` | Scaffolds `PRODUCT.md`, `DESIGN.md`, and `.idiom/` in the target repo |
| Render | `idiom capture <flow>` | Seeds fixtures, boots the app, screenshots every declared state × viewport × colour-scheme tuple with metadata |
| Critique | `idiom review <flow>` | Deterministic checks plus bounded model critique emit findings, unruled decisions, and self-contained reports |
| Explore | `idiom explore <flow> --state <state> ...`; `idiom explore resolve <run-id> ...` | Renders three isolated real-product directions, then records a live or deferred reasoned choice |
| Rule | `idiom ruling --decision <id> ...` | Human records a cited/custom ruling or an explicit no-rule outcome after reviewing an append-only diff |
| Repair | `idiom decide`, `idiom tickets` | Human accepts or rejects findings; approved findings become bounded Autobuild-ready tickets |
| Repair loop | `idiom fix <flow>` | Drives a local Claude Code or Codex CLI, rechecks the whole flow, and records calibrated verification |
| Verify | `idiom verify <flow>` | Recaptures the same states, re-runs checks, proves the finding resolved, detects regressions |
| Remember | `.idiom/decisions.jsonl`, `DESIGN.md` ruling blocks | Finding decisions and design rulings persist and shape future reviews |
| Reuse | `idiom context [flow]` | Projects law, prohibitions, tokens, rules, and open accepted work into one bounded brief an agent reads *before* writing UI |

## Runtime and packaging

Idiom is a **single private package** named `idiom` in this repository — no workspace until a genuine reuse story (for example a standalone `@idiom/checks`) materializes. TypeScript throughout, built to a single tracked `dist/cli.js` with tsup, `bin: { "idiom": "./dist/cli.js" }`, ESM. Release tags carry that prebuilt Node entrypoint because Bun does not run lifecycle build scripts for an untrusted Git dependency. The bundle reads its version from the colocated `package.json`, and resolves managed assets from the colocated `templates/` directory.

Bun's Git installer copies the repository checkout even though `package.json.files` describes a smaller package payload. Runtime does not depend on `src/`, tests, docs, examples, TypeScript/build configuration, or Autobuild files: package metadata, declared runtime dependencies, `templates/`, and `dist/cli.js` are sufficient. The hermetic distribution test proves that minimal boundary with `bun pm pack`; it does not claim that a Git-installed checkout is pruned.

**Node ≥ 20 is the canonical runtime.** Playwright's library API is fully supported on Node, while Bun has recurring edge cases (especially around `@playwright/test`). Idiom uses the **Playwright library API directly, not `@playwright/test`**: Idiom is an orchestrator with its own metadata and artifact lifecycle, not a test suite. Bun installs and links the package but the generated bin entry's shebang launches Node. Bun may also appear inside shelled target-repo commands declared in the flow manifest (`bun run seed:booking`, `bun run --cwd apps/web start`), so the two runtimes never mix in one process.

## Repository layout

```
idiom/
├── package.json            # name "idiom", bin → dist/cli.js, type: module
├── tsconfig.json
├── src/
│   ├── cli.ts              # commander program, command registration
│   ├── commands/           # one file per CLI command (including quick, review, explore, decide, ruling, verify, context)
│   ├── explore/            # isolated source/runtime workspaces, providers, validation, reports, and interaction state
│   ├── fix/                # fresh snapshots, occurrence comparison, local editing agents, bounded loop and reports
│   ├── quick/              # zero-configuration URL validation, capture, checks, and reporting
│   ├── context/            # design-brief collection, policy reduction, and the bounded deterministic renderer
│   ├── schemas/            # zod schemas: project, flow, finding, decision, ruling
│   ├── capture/            # setup-step runner, server lifecycle, browser session, artifact writer
│   ├── checks/             # deterministic check registry + one file per check
│   ├── critique/           # CritiqueAdapter interface, Claude Code/Anthropic transports, shared prompt/schema
│   ├── report/             # shared coverage/HTML shell, report storage, semantic profiles, paired PNG evidence
│   ├── review/names.ts     # tracked finding-name registry, migration, allocation, numeric ordering
│   ├── rulings/            # observation aggregation, stable names, artifacts, and append-only law blocks
│   ├── tickets/            # spec-standard ticket emitter (TOML front matter)
│   └── decisions/          # decisions.jsonl append/read, fingerprint construction
├── templates/              # PRODUCT.md, DESIGN.md, name registries, conversational/verifier skills
└── docs/                   # this documentation
```

## Dependencies

| Package | Why |
|---|---|
| `commander` | Boring, stable CLI framework; nothing here needs more |
| `zod` | Schemas double as runtime validation and documentation; single source of truth for persisted record types |
| `playwright` (Chromium only) | Capture engine; library API gives full control over context options and artifact lifecycle |
| `@axe-core/playwright` | axe-core (MPL-2.0, fine as an unmodified dependency) injected into the already-open page for contrast, labels, and heading rules |
| `postcss` | Parses configured token stylesheets, including nested at-rules and comments, without a regex CSS parser |
| `pixelmatch` + `pngjs` | Padded paired-PNG evidence and inspectable pixel-difference counts (ISC/MIT); pixels do not decide verify |
| Claude Code CLI | Default external, subscription-authenticated model transport; invoked non-interactively and restricted to reading declared evidence |
| `@anthropic-ai/sdk` | Explicit direct-API fallback, isolated behind the same `CritiqueAdapter` interface |

## CLI surface

All commands accept `--project <dir>` (default: current directory). Configured commands resolve `.idiom/project.json` by walking upward; `quick` uses the directory only for its configuration guard and default output, while `init` uses it as the scaffold target.

**`idiom quick <url...> [--out <dir>]`** — the zero-configuration first-result path. It accepts one or more absolute credential-free HTTP(S) URLs from one origin, preserves their order as `page-1`, `page-2`, and so on, and captures exactly those URLs without crawling links, submitting forms, acquiring credentials, or starting the application. Every page is captured at fixed desktop (1440×900) and mobile (390×844) viewports in both light and dark schemes using the normal deterministic browser settings and artifact formats. The command directly reuses tuple selection, browser capture, atomic artifact publication, capture loading, all ten deterministic checks, finding finalization, the standard finding schema, and Markdown/HTML reporting. It never invokes setup steps, build/start ownership, Git source snapshotting, project/design documents, references, rules, decisions, finding-name memory, review catalogs, or a model provider.

Quick output defaults to a timestamped child of `<directory>/idiom-quick-reports/`, outside `.idiom/reports`; `--out` names an exact non-existing directory. Capture metadata records the source commit as unavailable rather than attributing a live URL to the selected directory. Before output creation or browser launch, the command walks upward from the global `--project` directory (or current directory) and refuses if it finds `.idiom/project.json`, including a partial or invalid one. The error directs the person to validate and review a named configured flow, preventing quick results from entering configured history or bypassing declared states and guidance.

Quick findings are ordinary schema-valid deterministic findings with standard fingerprints, evidence, severity, confidence, status, run-local `finding-N` names, and the same five-material-finding cap. Both report formats end with an explicit scope boundary: only supplied public URLs were visited; fixture-dependent error/empty states, authenticated surfaces, and form/interaction destinations were not judged; product intent, design law, references, and tokens were unavailable; `idiom init` plus a flow manifest and `idiom review <flow>` is the path to cover them. No score or aggregate rating is produced.

**`idiom init`** — scaffolds `PRODUCT.md`, `DESIGN.md`, the `.idiom/` tree (project.json, flows/, references/, anti-references/, rules.json, decisions.jsonl, finding-names.json, ruling-names.json, reports/), and the conversational agent skill in the target repo. Both registries and `decisions.jsonl` are committed project memory; `reports/` alone is ignored. Interactive prompts with `--yes` for scaffold defaults. It never overwrites an existing scaffold file without explicit confirmation; conversational-skill collisions remain preserved without prompting. When the target root contains `autobuild.toml`, an interactive run also offers the independent Autobuild verifier installation described below. A fully initialized but unwired repository can therefore receive the offer on a rerun; a fully wired rerun is a no-op. `--yes` never installs or edits Autobuild wiring.

**`idiom validate [flow]`** — zod-validates `project.json`, optional strict `.idiom/rules.json`, and all (or the named) flow manifests. With declared project surfaces, named validation also reads every flow association before work begins; with no surfaces it preserves named-flow isolation. Missing rules mean an empty version-1 ruleset; a present invalid file fails with pathed field errors. Cheap enough to run in CI.

**`idiom capture <flow> [--out <dir>]`** — runs setup, then branches at the flow's strict target seam. Web capture builds and owns the production server and one Chromium session; Electron capture skips all server operations and launches a clean target application for every state/viewport/scheme tuple. Web toggle combinations expand into ordinary states; a pre-capture layout measurement pass shares screenshots for equivalent combinations within each base state, viewport and scheme while retaining each combination’s deterministic evidence for offline review. Both paths produce PNG, DOM, console, axe, observations, and commit-keyed metadata in the same artifact grid. Output defaults to the selected project's `.idiom/reports/<timestamp>/`; relative `--out` paths resolve from the invoking directory even when `--project` selects another directory, and absolute paths identify the exact destination. An explicit output directory must not exist. Repo-internal custom paths must be under `.idiom/reports/` or gitignored so generated artifacts never change source identity. Makes **no model or external API calls** and never mutates the target app.

**`idiom reference add|list|remove`** — manages atomic, name-addressed visual context beneath `.idiom/references/` and `.idiom/anti-references/`. URL adds require a configured viewport and use the flow-capture browser's shared context pins and settle delay, reject non-2xx navigation, and capture the viewport rather than an unbounded full page; their strict metadata records the exact source URL, capture timestamp, and viewport identity/dimensions. URL and file images are rejected before publication when the dimensions read from their PNG, JPEG, WebP, or GIF header — or their encoded size — exceed the direct model transport budget. File adds otherwise preserve a supported image byte-for-byte without launching a browser or model. Publication is a temporary-sibling rename and duplicate names never overwrite. Listing and critique ignore hidden staging remnants and malformed managed entries so one damaged record cannot poison the catalog; a root slug directory with a regular `reference.json` ownership marker remains removable even when its record or image is damaged. Loose legacy reference directories without that marker remain readable but are never claimed or deleted by these commands.

**Recorded finding baselines** — `src/baseline/` stores compact per-flow fingerprint histories separately from ignored capture runs. `baseline record` records full deterministic candidates and the authoritative expected grid; `check` and `review --since-baseline` compare live occurrences finalized per tuple before global review deduplication and its attention cap. Git ancestry selects the nearest reachable recorded commit. Raw candidates and independently observed tuple coverage establish fixes, while the complete normalized checks hash discloses stale configuration. The existing run-ID `--baseline` and `idiom verify` capture-baseline resolver remain separate contracts.

**`idiom review <flow> [--deterministic-only] [--from <runId>]`** — runs a capture or reuses a simple run ID beneath `.idiom/reports`, executes ten pure evidence checks, then routes optional model critique through the configured `claude-code`, `anthropic` or `codex` provider and writes `findings.json`, `unruled-decisions.json`, `report.md`, and `report.html`. The run-level `spacing-rhythm` check derives a prevailing vertical interactive-to-boundary clearance from comparable version-2 observations in that run and reports only sharply divergent minority placements; missing or legacy tuple geometry is explicitly not evaluated without suppressing healthy sibling tuples. A stored replay validates internal flow/commit coherence without a Git query, navigation, browser launch, or server work. `--deterministic-only` also bypasses provider construction and all provider-only context/image reads, making replay fully offline. Full-mode provider, credential, response, and context failures degrade to deterministic-only output with a warning and exit 0; corrupt decision history remains a project-data error.

**`idiom system`** — builds a project-wide, read-only visual projection at the
stable `.idiom/reports/system.html`, prints that absolute path, and opens it
through the report launch boundary. The file is a direct child of `reports/`,
not a run directory: existing init ignore rules and capture source exclusions
therefore cover old and new projects without migration, while directory-only
run discovery cannot select it. Publication is an atomic replacement, and a
launch failure leaves the completed file available.

Collection separates authored and observed evidence. Authored rows are exactly
the custom properties in `design.tokensFile`; a bounded resolver may read that
file's project-contained relative CSS imports, regular `.css` siblings, and
their contained relative imports only to supply the dependency closure for
those rows. Supporting declarations never become tokens. Unique definitions
are passed to isolated light/dark browser probes in the generated page;
missing, conflicting, cyclic, package, URL, and out-of-project dependencies
produce a token-local unavailable state rather than guessed cascade behavior.
The configured file itself retains the existing strict parsing diagnostics.

Observed colour and type values come from the newest artifact-complete capture
whose successful observations exactly cover its currently declared flow grid.
Every value retains at least one flow/state/viewport/scheme coordinate. A newer
partial or failed run cannot replace complete evidence. Coverage is selected
independently from the newest `findings.json` completion artifact, including an
empty findings array, then rebuilt from that review's validated flow and stored
tuples. It always exposes judged, governed-but-not-judged, and ungoverned
surface groups plus states, viewport dimensions, colour schemes, and tuple
shortfalls. Run IDs merge current-root-first across the current and reachable
primary-worktree report stores; persisted timestamps or completion mtimes rank
the surviving candidates with a deterministic run-ID tie-break.

The remaining sections parse authored `DESIGN.md` prose away from delimited
rule/no-rule rulings and reuse the same alias-aware latest-rule-decision
reducer as `idiom context`. A standing prohibition embeds safe reachable
screenshot evidence as PNG data when present and names its absence otherwise.
Fresh projects and missing optional evidence render explicit unavailable or
`none` states. Malformed configured inputs and corrupt stored artifacts still
fail closed.

The renderer extends the shared HTML shell with additive trusted styles and a
page-local colour-probe initializer. All authored values enter escaped data
attributes and CSS properties are set through DOM APIs. Images are data URIs;
the CSP denies connections, frames, objects, media, external fonts, and every
default source. System light/dark themes and native print/PDF behavior reuse
the report conventions. Collection constructs no provider, reads no model
credential, starts no server or capture browser, and performs no external API
call. The page reports evidence and limits without an aggregate rating.

**`idiom decide [--list | --finding <id> --accept|--reject [--reason ..] [--scope instance|rule]]`** — records human judgment. Interactive by default (walks open findings), fully flag-driven for scripting. Appends one line per decision to `.idiom/decisions.jsonl`. `--scope rule` suppresses all future findings with the same fingerprint, not just this instance. `--list` is mutually exclusive with write flags and renders the catalog-reduced lifecycle without prompting or mutation.

**`idiom ruling --decision <id> (--candidate <n> | --wording <text> | --no-rule)`** — resolves one reviewed `ruling-N`, prints its exact append-only `DESIGN.md` diff, confirms, and atomically records a rule or deliberate no-rule outcome. It never calls `idiom decide`, emits a finding, or creates a ticket. Design-system questions (repeated declared-scale drift in one context, raised deterministically by `scale-conformance` on every non-quick review) take `--add-step [--token <name>]` or `--drift` instead. `projectChecksConfig` reads recorded `scale` answers back from the ruling blocks: an add-step extends the effective scale for that context in every project run, and a drift answer keeps the cluster as one grouped finding. `.idiom/project.json` is never written.

**`idiom explore <flow> --state <state> (--question <text> | --decision <ruling-N>)`** — the opt-in design-law elicitation surface. It preflights the configured provider before writing anything, captures one existing state across the flow's declared viewports and colour schemes, and renders exactly three distinct source-edit directions through the normal capture pipeline. Claude Code receives a canonical-path manifest inside a sanitized mirror with safe mode, `Read,Glob,Grep`, `dontAsk`, and no added directory; direct Anthropic reads only through bounded mirror-relative tools. Runtime clones retain ignored app inputs but are invisible to the provider. Exact existing-file replacements, captured copy, CSS generated content, state expectations, references, and pairwise pixels are validated locally. Candidate code is always removed.

The human may choose none, or choose one direction and request at most one recaptured plain-language refinement. A confirmed choice uses the same append-only ruling parser, diff, confirmation, atomic write, stable name, and downstream resolution type as `idiom ruling`, with an optional nonblank reason. The self-contained comparison remains under `.idiom/reports/<timestamp>-explore-<flow>-<state>/`; candidate captures sit one directory below `candidates/` and cannot be discovered as baseline tuples. Repair findings are offered only after the law is recorded and, when accepted, pass through ordinary decisions and tickets. `review` and `verify` never import or invoke exploration. Desktop/Electron capture is deferred.

**`idiom explore resolve <run-id> (--candidate <A|B|C> | --none) --reason <text> --yes [--repairs]`** — resolves one complete stored exploration without provider, capture, or readline work. The strict version-1 `exploration.json` manifest is the lifecycle authority: new decision-steered runs retain the reviewed ruling identity, refined runs expose one effective A/B/C set, and a final atomic resolution record prevents a second choice. Resolution validates the named run, report files, configured flow/state, baseline and candidate grids, containment, current law, and legacy identity boundary before mutation. Candidate choices share the live ruling/repair implementation and emit the exact law diff before the non-prompting confirmation; `--none` records only lifecycle state. No-TTY generation reaches this surface by returning a successful pending result after publication. Stored question-driven version-1 runs remain compatible; ambiguous legacy decision-driven runs fail closed. Refinement remains live-only.

**`idiom tickets [--finding <id>...] [--out <dir>]`** — converts approved findings into spec-standard ticket markdown files, defaulting into the target repo's `.autobuild/tickets/triage/`. Each ticket embeds its Finding JSON in a fenced block (see the verify seam below). Emission also consults persisted lifecycle status and exact embedded records across every tracker state, so consolidated or verified findings are reported as already resolved instead of recreated.

**`idiom context [flow]`** — the write-time projection, and the loop's main interoperability surface: one deterministic Markdown brief on stdout, consumed by pull over a documented format by any agent or pipeline. Inputs are the configured `DESIGN.md` (strictly separated into authored prose and recorded ruling blocks), `PRODUCT.md`, the optional `design.tokensFile` (read through the same `loadTokenDeclarations` the token-drift check uses), strict `.idiom/rules.json`, the append-only `.idiom/decisions.jsonl`, the tracked `.idiom/finding-names.json`, the reviewed-finding catalog, and the reduced finding lifecycle. Collection and rendering are separate: `src/context/brief.ts` produces structured entries and a pure renderer orders and bounds them at a hard **12,000 UTF-8 bytes**, truncating only at complete-entry and line boundaries with in-place omission counts. Recorded rulings and prohibitions allocate at priority zero before replaceable design/product prose. Canonical names sort numerically (`finding-2` before `finding-10`). No flow argument means no flow manifest is read at all; a flow argument validates exactly that manifest and enforces filename/manifest-id agreement. Rule-scope rejections and recorded rulings are project-wide; only rules-file overrides and accepted findings are flow-filtered. Accepted work reuses ticket eligibility, excluding `verified-fixed` and `done`. The registry and both gitignored stores — `.idiom/reports/` for finding evidence and `.autobuild/tickets/` for tracker state — are resolved through one Git common-worktree topology boundary, reading the current checkout plus the primary one. Registry ownership is unioned strictly; reports widen only for context, and no write ever crosses a checkout. Topology failure degrades to current-checkout roots. Unreachable stores are marked independently rather than silently reported as clean; both markers probe for the root itself, so a store that is present and empty reports a genuine answer rather than a degraded read. **No provider, credential, network, browser, server, or filesystem write, ever, in context.**

**`idiom compare <flow> --from <runId> --against <runId> [--out <dir>] [--json]`** — read-only evidence from two stored captures of one flow (`--against` is before, `--from` after). Tuples are paired by state, viewport, scheme and combination and pixel-diffed with the verify comparator; each changed pair gets a composite whose extra header band names the tuple and both commits, while unchanged, one-sided and failed tuples are only listed. The deterministic registry runs on both runs to report new and fixed findings by fingerprint and alias. The output reuses the verify attachment contract (`attachments.json`, `before-after.md` as `idiom-verify-report`, `idiom-before-after-NNN` composites) under its own `.idiom-compare-output` ownership marker, so the `ab-verify-idiom` delivery steps deposit it unchanged. It exits 0.

**Published flows** — `"kind": "published"` flows expand `pages` into states and accept widths as viewports. Capture records `<img>` observations and failed image requests for their tuples only, and `loadRunTuples` attaches the budget and the pixel ratio against `<flow>.pixels/` so the `published-budget` check stays a pure evaluator. Its findings are blockers; `idiom review` exits nonzero on any that remain open or approved.

**`idiom verify <flow> --spec <path> [--against <runId-or-directory>] [--out <dir>]`** — closes the loop. It parses strict `idiom:finding` blocks, recaptures only the exact referenced state/viewport/colour-scheme tuples through two independent production lifecycles, negotiates the retained observation version, re-runs each declared verification and the full deterministic registry on those tuples, and writes stable before/after evidence. It exits nonzero for a reproduced finding, a new deterministic blocker, or an unrepeatable/unsupported comparison. **No model calls, ever, in verify** — the gate is deterministic and offline-runnable.

## Report contract

Markdown and HTML reports receive the same presentation-neutral coverage value. It is rendered immediately below the report outcome and before states, findings, calibration, verdicts, or evidence. The block names the flow; selected versus declared states; viewport names and dimensions; colour schemes; successful versus selected tuple count; labeled commit identities; and explicit limitations. Review coverage starts from the declared flow grid and counts only loaded tuples without capture failures or expectation mismatches. It names project viewports or schemes excluded by the flow and reports every selected-tuple shortfall, so zero findings cannot be mistaken for broad coverage.

Flow reviews (and so `idiom check`) also attach `stateCoverage`, computed by the pure `computeFlowStateCoverage` in `src/coverage/states.ts` from the loaded run: `run.json` (declared, selected and probe-executed coordinates, the reduced-motion mode), each tuple's failure and mismatches, and the version-2 observation's probe replays, probe results and focus sweep. Markdown and HTML render it as one `State coverage:` line after the successful-tuple count; JSON carries the full value. Quick, page, system and verification coverage omit it, because they have no flow configuration to name remedies against. `idiom coverage --states` and MCP `idiom_coverage` run the same function over each flow's newest stored capture. Not-applicable dimensions are excluded from the denominator, and the wording is coverage of what was reviewed, never a quality measure.

When `project.surfaces` is nonempty, review resolves every validated flow mapping
and extends that same value with three ordered groups: surfaces judged by the
current flow, surfaces governed by another flow but not judged here, and
ungoverned surfaces with no flow. Every group renders even when empty. With no
declared surfaces the coverage value and rendered shape are unchanged.

Verification coverage starts from the exact finding-selected tuple triples. Sparse selection is labeled finding-scoped; a full-flow finding that selects the complete declared Cartesian grid is labeled as such, but still described as evidence for embedded findings rather than a fresh whole-flow review. The report carries the retained baseline commit and coherent current calibration commit. Successful, failed-but-published diagnostic, Markdown, and HTML paths share this block. The no-findings fast path reports zero exercised states and tuples plus unavailable commit identities while preserving its guarantee that no Git source inspection, setup, build, server, browser, provider, or external API work runs.

Every generated HTML report is a single offline-viewable file with embedded data images and no external assets. Its content-security policy keeps default, connection, font, media, frame, object, base, and form sources closed; inline script is enabled only for the report's comparison and print controls. A visible **Print or save as PDF** button invokes the browser's native print dialog. Print media hides that action and the presentation-only slider, retains the labeled source before/after pair, removes scroll and height clipping from tables and preformatted evidence, uses a light paper palette, and caps review and comparison images at eight physical inches with contained aspect ratio so tall full-page captures remain complete on Letter and A4 pages. Report findings and evidence are unchanged in substance, and neither screen nor print representation produces a score or grade.

## Capture pipeline

**Setup runner.** Manifest `setup` steps run strictly sequentially. Each step must exit 0 and its process must **fully terminate** before the next step (or the server) starts — this is a hard requirement because the booking example's PGlite database is single-holder: the seed process must release the data directory before `next start` opens it. Steps with `captureStdout: true` make their stdout available to `urlFrom` resolution.

**Server lifecycle.** Build (`server.build`) → start (`server.start` with `server.env` merged over the flow's env) → poll `server.readyUrl` until 200 or `startupTimeoutMs` → capture → SIGTERM and wait for exit on teardown. A pre-flight check detects a process already bound to `server.port` and fails with an actionable error rather than silently capturing a stale server.

Web captures share free-port allocation across development and production, pass the selected port as `PORT`, and refuse an occupied ready URL before spawn; `--port` / `IDIOM_PORT` pin a port and `server.fixedPort` preserves the configured server contract. Derived evidence uses the configured origin for stable identity while metadata retains the served origin and its optional `canonicalOrigin` mapping for offline review.

**Electron lifecycle.** The adapter expands `${dataDir}` in launch args, cwd,
and environment, rejects other placeholders and a conflicting scale-factor
switch, then calls Playwright `_electron.launch` with locale, timezone, colour
scheme, and an owned timeout. It selects exactly one loaded renderer by exact
title, sets native content size through `BrowserWindow`, synchronizes live
colour/reduced-motion state, executes declared locator actions, and closes the
application in the tuple `finally`. Launch, window, state, and evidence failures
are typed tuple failures, so later tuples continue. The target supplies its own
Electron executable; the fixture Electron dependency is development-only. One
fresh data directory belongs to the complete capture run and is shared across
its tuple processes; profile reset or per-tuple namespacing remains the target
application's responsibility when its state can affect evidence.

**Per state × viewport × colour-scheme artifacts.** Legacy/singleton runs remain under `.idiom/reports/<runId>/<state>/<viewport>/`; projects that activate the axis use `.idiom/reports/<runId>/<state>/<viewport>/<scheme>/`:

- `screenshot.png` — full-page, device scale factor 2. A full-page shot taller than Chromium's texture limit (16384 physical px) is taken as clip tiles of 8192 physical px and stitched (`src/capture/screenshot.ts`): a page with an isolated group spanning its height and a composited `mix-blend-mode` descendant renders as one surface capped at that limit, so a single shot is plain background below it. Shorter pages keep the single shot unchanged.
- `dom.html` — serialized DOM after settle
- `console.jsonl` — web listener records, or Electron's single final selected-page snapshot (console records followed by page errors, last 200 of each)
- `axe.json` — raw axe-core results
- `observations.json` — versioned geometry, selector hints, hit-test results, headings, computed styles, and normalized configured-token values captured from the settled live page; it contains facts, not verdicts. Authored properties and style sources come from stylesheet rules bucketed by a key from their rightmost compound selector (id, class or type, else a universal bucket), so each element is tested with `element.matches` only against its candidate rules rather than the whole stylesheet
- `timelines.json` — action timelines (below); absent in runs captured before them and for Electron
- `metadata.json` — target-repo commit and dirty flag, flow, state, viewport, selected scheme and axis status, sanitized URL or Electron window/launch provenance, timestamps, platform (`process.platform`, architecture, and OS release), browser/runtime version, Idiom version, expectations, and any explicit capture failure. Electron records axe legacy mode and never persists launch environment values. `screenshot` records how the image was taken: `strategy` (`viewport`, `full-page` or `tiled`), device `scale`, CSS `width`/`height`, `tiles`, and `drift` when the page size changed between the start of observing and the screenshot.

**Crop placement.** Crops cut an element out of `screenshot.png` at the scale recorded in `observations.screenshot`, not the image width divided by the viewport width, which is wrong whenever the document overflows the viewport horizontally. When the page size drifted between the start of `observePage` and the screenshot (late content during a multi-second observe, link checks), every observed selector is re-measured at screenshot time into `observations.screenshot.rects` and crops are cut there. Which elements are judged and cropped is unchanged; only where the cut lands. Observations without `screenshot` (older runs, design references) keep the width-derived scale and observed rects.

**URL resolution.** A state either declares a literal `url` or a `urlFrom` regex applied to captured setup stdout (one capture group), with an optional `append` suffix. Literal URLs are persisted exactly. Seeded URLs are taken from seed output verbatim for in-memory navigation rather than assuming a route shape, but the booking app mints a new private booking slug on every seed. Persisted metadata and reports therefore record the stable origin, `source`, regex `pattern`, `append`, and a state-keyed template such as `http://127.0.0.1:3107/{setup-stdout:valid-known}?tz=America/New_York`.

Saved DOM, console and accessibility text replace the setup-derived complete URLs (including original-origin aliases), non-root pathnames and every nonempty route segment with stable templates. Segments are matched in encoded and once-percent-decoded spellings, including ordinary JSON-string and HTML-entity forms; captured observation/timeline strings, copied replay evidence and tuple failure messages use the same transform. Without a route schema, every segment is a candidate, including short ones, but bare matches require token boundaries rather than replacing substrings inside larger words, CSS identifiers or percent escapes. Markup (dom.html, axe `html` snippets) is scanned so bare matches touch only text, raw-text element bodies and attribute values, never tag or attribute names; selectors skip bare matches in tag-name position (start of a compound, after a combinator or path slash). Structured observations/timelines redact captured text and selector identities while retaining status enums, tag/role names and measured CSS; dynamic selector keys in screenshot geometry are rewritten consistently. Probe planning, later rounds and replay ledgers retain raw in-memory identities until merging is complete, then the final evidence is redacted and origin-canonicalized before checks and saving. Replacement applies to captured strings after browser execution: raw URLs still drive navigation and expectations, and screenshot pixels and rendered browser state are unchanged. This is bounded replacement of known values, not arbitrary-secret discovery or coverage of every encoding. The separate environment-value publication scan remains in force.

**Publication and failures.** Every successful navigated tuple writes the six artifacts even when expectations fail. URL or browser failures always write metadata and preserve any earlier artifacts; later tuples continue while the server remains usable. Review treats metadata-explained absence as unavailable check coverage and emits `missing-state`, while a successful tuple missing any required artifact is stale and requires recapture. All output stays in a uniquely-created staging sibling until the server is stopped and staged bytes pass the `*_TOKEN` / `*_SECRET` / `*_KEY` environment-value scan; only then is the directory atomically published. If a hard-killed run leaves an explicit `--out`'s `.<out-basename>.staging-XXXXXX` sibling behind, the next capture's source dirty flag ignores it; nothing is deleted. A fresh data directory outside the target repository is always removed after teardown.

**Environment pinning.** For web, timezone is pinned in both the application URL and browser context; colour/reduced-motion and an optional root scheme attribute are present before application scripts. Electron launch receives locale, timezone, and a requested colour preference, but initial renderer windows are already loaded when launch resolves and Electron launch has no reduced-motion option. The adapter therefore re-applies colour/reduced-motion media and the optional attribute to the selected live page before actions or evidence. Electron adopters must react to those changes and cannot depend on boot-only sampling. A short `settleMs` wait follows navigation or state actions.

Electron axe runs `setLegacyMode(true)` because its persistent context cannot
create the blank aggregation page used by the normal partial-run path. That
keeps analysis on the renderer but excludes cross-origin frames; axe's
`frame-tested` rule reports the boundary. Web retains the normal axe factory.

**Capture lanes.** Web tuples run in lanes, one per viewport and colour scheme, up to `capture.concurrency` at once (`src/capture/lanes.ts`). A lane is sequential in flow order; every tuple keeps its own fresh context, so only scheduling changes. Results are stored by original position and published in sequential order; the first failure stops each lane before its next tuple and is rethrown once in-flight tuples settle, and a capture deadline names every coordinate in flight.

**Interaction probe.** `src/capture/probe.ts` clicks a state's controls on a disposable page. A flow-scoped ledger (`src/capture/probe-ledger.ts`, in memory, partitioned by viewport and scheme) keys finished results by control identity (role, name, region, selector signature), so shared chrome is probed once and reused (`reusedFrom`) at later states, and a state's own controls run first. Between attempts a restore ladder compares a DOM state fingerprint with the baseline, tries Escape and a revealed close control, and only then replays the state on its own budget. Nested menu items share a per-state budget; unattempted controls are `not-reached`. The mutation guard blocks non-GET requests from every probe click, ladder steps included; only declared state replays may mutate.

**Action timelines.** Capture records what the user experiences during each action, once, as shared evidence for temporal rules (`src/capture/timeline.ts`; schema `actionTimelineArtifactSchema` in `src/checks/artifact-schema.ts`). Four windows are recorded:

- *load* (`id: "load"`): from navigation of the state's document until the first web step starts, or, with no steps, until the settle wait and animation settle finish. It is installed as an init script before `goto` and disposed afterwards, so probe restore navigations are not recorded. Its geometry and DOM tracking begin on the first frame with a document body, including visible changes while the document is still parsing. After 30 seconds it disconnects its observers and retains a bounded snapshot, marked partial.
- *web step* (`id: "step-<n>"`): every declared step, assertions included, from just before the action until the step's existing drain and motion wait end.
- *slow replay* (`id: "slow-step-<n>"` or `"slow-probe-<k>"`): the probe's held replay of an action that sent requests; see *Held replay* below.
- *probe click* (`id: "probe-<n>"`, numbered by start time): from just before the click until the existing effect window ends (quiet, or `checks.probe.waitMs`). `settled` is false when the window ended at its bound. When the bound is reached while a request the click started is still in flight, the window keeps waiting for it and then 150ms of quiet, up to `LATE_CONTENT_WINDOW_MS` (2000ms) from the click (`src/capture/effect-window.ts`), so content that arrives after the 500ms late-shift boundary lands in the timeline. Ignored dev-server requests, navigations, streams (EventSource, WebSocket), beacons (`sendBeacon`), requests to well-known analytics endpoints (`analyticsRequest` in `src/capture/request-policy.ts`), and `keepalive` fetches whose result nothing awaits never extend it, a click that starts no request keeps its previous timing, and the added time counts in the probe's `effectWindowMs` and budget. Hover, nested-menu parent clicks, Escape and restores are not recorded, and ledger-reused results produce no timeline because nothing was clicked.

Each action records:

- every `layout-shift` entry, *including* those with `hadRecentInput` (Core Web Vitals drops these; the interaction-shift rule needs them), with sources resolved to observation selectors and their previous and current rects;
- geometry: `frames[0]` is the baseline rect of each painted element (the observation painted fact) within half a viewport beyond the viewport, in document order. When the acted control is outside that band, the band around the control comes first, because Playwright scrolls a control into view and clicks within one frame. Later frames are sampled on animation frames where something changed (DOM, attributes, a layout shift, a running new animation, a scroll). They hold only elements whose scroll-compensated position or size changed. An element that moved rigidly with its nearest tracked ancestor is represented by that ancestor;
- DOM insertions and removals, one record per subtree root, with its selector and rect;
- new animations and transitions from `document.getAnimations()`, with target, pseudo-element, properties, timing, start and end. `::view-transition*` animations and `pagereveal`/`pageswap` events with a view transition set `viewTransition`;
- requests started during the window (method, resource type, URL path without query, start, end, status, and outcome `ok`, `failed`, `blocked` by the probe policy, or `pending`). Times are on the capture process clock; in-page times are on the page clock. Both are relative to the action start and differ by about one evaluate round trip;
- the effect region: the acted control, its `aria-controls`/`aria-owns` targets, and the nearest common ancestor of the parents of every insertion and removal.

*Scroll compensation.* Each element sample carries `offset`, the cumulative scroll of its scroll chain (the window, unless the element is fixed, plus each scrolling ancestor). Change detection and `elementMovements` (`src/checks/timeline.ts`) compare `rect + offset`, so a scroll into view, an app scroll or a nested scroller moves nothing. Frames record the window `scroll` and any `scrollers` whose offset changed, and `scrollDuring` reports the window scroll so a rule can tell "the page scrolled" from "content moved". After the window scrolls by more than a quarter viewport, the band is re-derived and newly visible elements join, with a baseline entry in that frame. Known limitation: a `position: sticky` element that pins during a scroll reports movement equal to the pinned distance.

*Bounds.* Recording adds no waiting: browser evaluations to install, collect and clean up evidence, plus an in-page animation-frame loop that samples only changed frames. Per action, at most 60 frames (the last is reserved for the end state), 250 tracked elements, 80 changed elements per frame, 50 shifts, 60 mutations, 40 animations and 60 requests are kept; at most 120 actions per tuple. A cap that stops recording is listed in the action's `truncated` and makes it `partial` with reason `timeline truncated: <names>`; actions dropped by the tuple cap are counted in `truncated.actions`. Truncation is never silent.

*Passive only.* The recorder adds observers, passive listeners and a frame loop. It never clicks, replays, routes, or changes media emulation, and it only observes requests that the probe's `probeRequestAllowed` policy already allows or blocks. A recording failure becomes an `unavailable` action; it never fails the capture.

*Held replay* (`src/capture/loading.ts`). Local responses arrive instantly, so ordinary windows never see a pending state. After its clicks, the interaction probe replays each web step and each top-level probe click whose timeline sent fetch, XHR or document requests: web steps first, in step order, then probe clicks in enumeration order, at most six per state (`MAX_HELD_REPLAYS`). Each replay restores a fresh copy (steps `1..n-1` for a web step, the full restore for a probe click), installs an in-page *pending watcher*, samples 250ms of idle mutations to mark noisy subtrees (tickers, carousels), then repeats the action. A hold route registered on the page after the probe's guard runs first. It holds same-site fetch/XHR requests and a main-frame navigation for `checks.loading.delayMs`, chained requests included, with the whole window capped at three times that. It only ever calls `route.fallback()`, so every held request then meets the guard exactly as an ordinary probe click's would: safe methods are forwarded, the rest aborted and counted in the safety ledger. At `checks.progressWithinMs`, if a non-safe request is still held and the trigger is enabled, the replay clicks (or presses) the trigger once more; a same-method, same-path request that follows is recorded as a duplicate and handed to the guard, which aborts it. The replay is stored as an ordinary action (`source: "slow-replay"`, ids `slow-step-<n>` and `slow-probe-<k>`) with a `held` block: the held requests and their in-page release times, the first pending indicators (progressbar, busy, spinner, skeleton, status or progress text, trigger disabled/busy/pressed, each with whether it is inside the main region), the first visible change and the first change inside the main region, changes after a release, main-region emptiness, any same-document route change, the trigger's state at `progressWithinMs` and the second activation. In-page times are on the page clock; each release is posted into the page so release adjacency is judged on one clock. Once an action qualifies, the click loop stops starting top-level controls when less than min(30% of the state budget, two replays' worth) remains, reporting the rest `not reached: held replay reserve`; the held phase then runs before the explanation and collection passes. A replay never publishes a probe result, needs at least `3 × delayMs + controlTimeoutMs` of the state's remaining budget to start (otherwise coverage notes `not reached: probe budget`), and always forces a full restore afterwards. `loading-state-missing` and `double-submit` read only these actions; skeleton swaps that displace content stay with layout rules reading the same frames and shifts.

*Rules over timelines.* `interaction-shift` (`src/checks/interaction-shift.ts`) reads probe-click and web-step timelines; `layout-shift` reads the load timeline only to name the content behind the largest shift. Both are pure functions of the stored artifact, so replay needs no browser. Containment and causality are geometric, because timeline selectors are not hierarchical paths: an element is inside a region when its rect lies within the region's rect (±1px) at the start or the end, and a cause pushed an element when, in the baseline layout, it sat above it or to its left on the same row.

*Findings and old runs.* A finding candidate may name a timeline id; the finding then carries `evidence.timeline = { artifact, id }`, which `idiom check --json` lists and `idiom_issue` resolves to the recorded action. Runs without `timelines.json` load unchanged. `timelineEvidence` (`src/checks/shared.ts`) gives temporal rules the coverage reason `unavailable: recapture` for them.

**Masks are applied at diff time, not capture time.** Screenshots always record the truth; volatile regions (rendered dates and times) are excluded when comparing, so evidence stays honest while diffs stay stable.

## Changed-state checking

`changed/git.ts` collects read-only Git changes against an explicit commit or the default-branch merge base, unioned with index, working-tree and nonignored untracked paths. `coverage/routes.ts` exposes source-preserving topology for Next, SvelteKit, Astro and Remix alongside its existing deduplicated coverage API. `changed/imports.ts` lazily loads the runtime TypeScript compiler for cached syntax/module/config analysis, script extraction and transitive reverse route associations. No bundler or persistent cache participates.

`changed/select.ts` maps global files first, then direct/nearest route owners plus known import consumers. An unattributable file, or uncertainty in a global module or configuration, broadens to every candidate with a per-file explanation. Module-local uncertainty (an unresolved or nonliteral import) adds only the routes that reach that module; states without a static URL join every source edit. Validated flows stay intact; `commands/check-changed.ts` passes state scopes into the existing capture/review pipeline, sequentially and only for nonempty flows. CLI and MCP share the selection; MCP projects and registers each actual run separately. Explicit omissions have no fictitious run, evidence or passing status. Recorded baseline comparison retains successful tuple-key semantics, while changed mode disables only automatic bootstrap. One snapshot spans analysis and all captures; combined successful coverage publishes one agent-check acknowledgment, and empty/failed/aborted work publishes none.

## Deterministic check layer

Nine checks, each a `checkId` registered in `src/checks/`, run as pure evaluators over immutable capture evidence. Geometry and computed styles are observed in the original Playwright session so replay never needs a second render:

| Check | Mechanism |
|---|---|
| `overflow-clip` | Horizontal page scroll, elements exceeding the viewport, clipped text via `scrollWidth > clientWidth` probes evaluated in page context |
| `responsive-break` | Distinct, normal-flow interactive overlaps confirmed by capture-time hit testing at every viewport tied for minimum captured CSS width; `overflow-clip` owns document overflow |
| `contrast` | axe `color-contrast`, which measures rendered colors rather than declared ones |
| `a11y-label` | axe label/name rules: missing accessible names on interactive elements and form controls |
| `target-size` | Visible enabled interactive elements smaller than 24×24 CSS px on fine-pointer viewports or 44×44 below 768px / on touch, at every captured viewport; `checks.targetSize` overrides; excludes unpadded inline text anchors |
| `heading-structure` | axe heading rules plus a single-h1/ordering probe |
| `token-drift` | Computed color/radius values on captured elements that do not resolve to custom-property values defined in the project's `design.tokensFile` |
| `console-error` | Any `console.error` or uncaught page error recorded during capture, except the browser-generated document-load error when its non-200 status exactly matches both the manifest expectation and stored response; script errors and failed subresources remain findings |
| `missing-state` | A manifest state failed its `expect` block, or a complete multi-scheme grid proves a later declared scheme has the same stable rendered profile as the preceding scheme |

`token-drift` reads only a configured project-relative `design.tokensFile`. An absent declaration is explicit skipped coverage, not an empty allow-list. When the tokens file declares color tokens but none resolve in the captured page, capture fails with a color-token resolution diagnostic instead of producing an empty color allow-list, even if radii resolve. Each finding is independently schema-validated with `confidence: 1.0`, an artifact-backed evidence object, and a SHA-256 identity over `category | flow | state | [colour scheme] | rule | selectorHint`; the scheme component is omitted for legacy/singleton projects. On multi-scheme opt-in, the scheme equal to `capture.colorScheme` also carries both historical scheme-less fingerprint forms as aliases, preserving prior decisions and lineage without applying them to a newly reviewed scheme. Deterministic candidate construction uses captured tuple data and registry order; combined publication order uses severity, confidence, and canonical fingerprint. `createdAt` comes from capture metadata, making repeated review byte-identical. No numeric or aggregate design rating exists.

**Why in-process rather than wrapping impeccable.** Idiom's differentiators hinge on findings keyed to `(flow, state, viewport, colour scheme, commit)` from one capture session. `npx impeccable detect <url>` launches its own Puppeteer, has no notion of states, setup, fixtures, or schemes, and produces its own report shape — wrapping it as the core would mean a second browser, a second navigation (nondeterminism), and a lossy schema mapping. Several checks are also outside its territory entirely: `missing-state`, `console-error` from our session, project-specific `token-drift` (for example `packages/design/src/theme.css`), and re-render verification.

**The `--with-impeccable` adapter** keeps the door open: shell `npx impeccable detect <state-url>` per state (Apache-2.0, license-compatible), map P0 → blocker, P1 → major, P2–P3 → minor, tag rules as `impeccable:<rule-id>`, and dedupe against native findings by fingerprint. Whether the flag defaults on is decided empirically by backlog ticket T1.

## Model critique layer

```ts
interface CritiqueAdapter {
  critique(input: {
    screenshots: ScreenshotRef[]
    domExcerpts: string[]
    productMd: string
    designMd: string
    references: ReferenceRef[]
    priorDecisions: Decision[]
    deterministicFindings: Finding[]
    modelCandidateAllowance: number
    decisionObservationAllowance: number
    rulingResolutions: RulingResolution[]
  }): Promise<{
    findings: ModelFindingCandidate[]
    decisionObservations: DecisionObservation[]
    discardedDecisionObservations: number
  }>
}
```

`model.provider` routes exhaustively: newly scaffolded projects select `claude-code`; existing `anthropic` files keep the direct Messages API behavior unchanged; `codex` drives the locally authenticated Codex CLI. The configured model identifier is passed to the selected provider. Provider routing, the fallback wrapper and provider-specific failure wording live in `src/critique/provider.ts`; nothing else branches on provider.

A provider never switches on its own, because that could change billing. A fallback runs only when `model.fallback` names one: a different provider with its own model id. The first primary failure switches that adapter to the fallback for the rest of the run, so a capped primary costs one attempt, not one per surface. A switch is reported on the full outcome (`outcome.fallback: {from, to, reason}`), in both report headers, as a CLI `Warning:` line and in the MCP sweep text. When both fail, the degradation reason names both. An explicit `--provider` or `--model` on page review is honored literally, without the fallback.

The Claude Code implementation invokes `claude -p` with discrete arguments, `--output-format json`, the strict response shape as draft-07 `--json-schema`, `--safe-mode`, `--tools Read`, `--permission-mode dontAsk`, `--no-session-persistence`, and `--no-chrome`. The common prompt and an absolute label-to-path manifest travel on stdin; screenshots and image references are read from disk, while shell interpretation is never involved. The child inherits executable-discovery and normal OAuth/keychain environment but has `ANTHROPIC_API_KEY` removed so it cannot override subscription auth. Stdout/stderr are bounded and sanitized. Only a successful result envelope with `structured_output` is accepted.

The Codex implementation runs `codex exec --skip-git-repo-check --ephemeral --sandbox read-only --color never -C <project> --model <id> --output-schema <file> -o <file>`, then one `--image` per screenshot, image reference, crop and design image, in manifest order. There is no positional prompt; the common prompt and an attachment-numbered image manifest travel on stdin. Codex sends the output schema in OpenAI strict mode, so Idiom derives it from the same transport schema: every property is required (optional ones become a union with `null`), every object is closed, and `minLength`/`maxLength` are removed. Null keys are stripped from the final message before the same local validation and the same single repair round the Claude path uses. `ANTHROPIC_API_KEY` is removed from the child; Codex's own authentication decides. Stderr carries Codex progress, so its bound is 16 MiB and only a redacted tail reaches a diagnostic.

The direct Anthropic implementation reads `ANTHROPIC_API_KEY` only from the environment and isolates the SDK behind an injectable `CritiqueAdapter`/Messages-client seam. It uses the common baseline request fields `model`, bounded `max_tokens`, and `messages`; invalid, retired, and non-vision identifiers become sanitized provider failures.

The providers receive the identical `CritiqueInput`: product/design context, bounded DOM excerpts, managed reference and anti-reference images with exact labels, notes, and available provenance, legacy loose references, prior decisions, suppressions and ruling resolutions, every eligible deterministic finding, all captured screenshots, and independent finding/observation allowances. Both reference polarities carry equal judgment weight. The finding allowance equals the configured material cap. The observation allowance is fixed and does not consume it. For the direct provider, captured images use base64 blocks and are partitioned into bounded batches of at most 20; the prompt distinguishes visible batch images from the full-run coordinate universe. Finding citations remain batch-local; governed-surface precedents may cite another batch only when its coordinate belongs to the same current run. Claude Code sees the same labels through one readable path manifest; Codex receives the same images as attachments in manifest order. Nothing publishes until every batch's strict finding path succeeds.

The prompt requires JSON only, strict findings, and per-visible-state observations of potentially systemic choices. Finding validation is unchanged and owns the one-repair-then-degrade path. The transport JSON Schema makes the observation branch and its nested fields optional; local validation then accepts each observation independently only when its coordinate is exact, its nearest law passage is an exact excerpt, and every candidate cites an exact eligible law excerpt or a full-current-run screenshot coordinate. An invalid observation is dropped and counted while valid findings and sibling observations survive. A choice with no precedent retains an empty candidate list.

After all batches, local aggregation normalizes and hashes choice keys, requires
at least two distinct state ids, merges and deduplicates coordinates and
precedents, suppresses fingerprints already represented by rule or no-rule
blocks, orders by distinct-state recurrence then key, and writes at most three
stable `ruling-N` records to `unruled-decisions.json`. They are rendered as
questions with checkable citations in a section separate from findings. They
never enter `findings.json`, finding ranking, decisions, tickets, or verify.

Idiom owns persisted finding identity, timestamps, commits, paths, layer, status, fingerprints, and verification. A deterministic policy layer applies `.idiom/rules.json` and standing rule-scope decisions locally before selection, and supplies permanent suppressions as model prompt instructions. Severity overrides and suppression run before ranking. A full review always evaluates both layers, then deduplicates their combined eligible pool and orders it by severity, confidence descending, and canonical fingerprint. The configured 1–5 cap partitions that finalized order into material findings written to `findings.json` and report-only evaluated-but-not-selected findings; suppressed items remain in their separate report appendix. There is no overall design score anywhere in the system.

The version-1 `.idiom/finding-names.json` registry owns short `finding-N` names, a monotonic next sequence, every compatible fingerprint, and every legacy `IDM-...` ID. A missing file is an unmigrated version-0 state: all canonical claims in decisions, local/primary reports, and strict embedded ticket records are reserved before decision-first legacy allocation, so deleting and reconstructing a registry cannot swap owners or fill a claimed gap. Read-only consumers such as `instruction` and `context` retain the projection in memory; `review`, `decide`, and `tickets` atomically publish it before any dependent artifact. Local and primary registries union only compatible entries; the same name on unrelated identities or two names on one identity is a hard conflict.

`idiom ruling` is the only mutation boundary for an unruled decision. It resolves
the reviewed `ruling-N`, validates exactly one of candidate/custom/no-rule,
constructs the completed design source with the old bytes as an exact prefix,
prints a unified diff, and asks for confirmation before an atomic rename.
Canonical markers and strict metadata make `DESIGN.md` the single resolution
source; duplicate or malformed markers fail closed. `idiom context` separates
the pre-ruling prose from an atomic priority-zero `Recorded rulings` section so
rule and no-rule outcomes survive the 12,000-byte allocator ahead of replaceable
product prose.

The review catalog groups occurrences through that registry while retaining every exact historical fingerprint/ID pair for decision and ticket lookup. A shared repair-presentation seam resolves the canonical target, same-review sibling lineages, and the acceptance-expandable flow/state/viewport/colour-scheme boundary. Both ticket and instruction rendering consume that seam. Ticket discovery hashes every identity pair and scans every tracker state before emission; one generated-filename match is authoritative, multiple matches are a visible conflict, and no match ordinarily creates from the first-observed fingerprint plus canonical lineage name. New ticket presentation embeds the canonical target with legacy aliases. Existing ticket bytes are compared with both this canonical projection and complete pre-migration projections using raw target and sibling IDs; either exact match is `unchanged`, while any other edit is `human-modified`, and old tickets are never rewritten. In parallel, the command reads each Markdown ticket across `triage`, `ready`, `doing`, and `done` once, parses strict `idiom:finding` blocks, and indexes every primary/alias ID with its historical fingerprint. A persisted `ticketed` or `verified-fixed` occurrence, or an indexed identity in an arbitrarily named consolidated ticket, takes the no-generated-file path to an already-resolved result before decision eligibility or creation. Canonical emission and embedded discovery atomically checkpoint `ticketed`, while the shared writer preserves stronger verification state. Custom output uses the same canonical lifecycle/index check before creating a draft but does not write a lifecycle checkpoint, so a scratch draft cannot prevent later canonical emission. The catalog exports the same atomic boundary for `verified-fixed` and `verify-failed` writes; ticket emission itself does not execute verification.

`idiom instruction --finding <id>` is the independent human handoff. It resolves a canonical name or legacy alias to one lineage, selects the latest occurrence, and applies the same occurrence-aware acceptance reduction as ticket eligibility. It intentionally ignores ticket and verification checkpoints, performs no registry persistence or tracker scan, and returns one newline-terminated plain-text block on stdout. The block contains only `Change`, `Surface`, `Why`, `Done when`, and `Out of scope`; it includes the shared sibling/tuple boundary and optional suggested starting area, while excluding run IDs, commits, fingerprints, lifecycle metadata, evidence paths, raw JSON, and ticket syntax. Consequently instruction and ticket emission can run in either order without suppressing or consuming one another.

## Verify and the Autobuild seam

**Ticket embedding.** `idiom tickets` writes spec-standard markdown with TOML `+++` front matter. The Evidence section carries the machine seam — the full Finding JSON in a fenced block:

````markdown
+++
id = "idiom-<fingerprint8>"
title = "<behavioral title>"
labels = ["v1", "web", "design", "idiom"]
+++
## What and why        ← finding.explanation, behavior-only, no file paths
## Acceptance criteria ← finding.acceptance verbatim, plus:
- [ ] `idiom verify booking --spec .ab/spec.md` exits 0 for the finding below
## Out of scope        ← other findings from the run; any other flow/state
## Evidence            ← run id, commit, screenshot artifact names, and:
```idiom:finding
{ ...full Finding JSON... }
```
````

**Verification semantics.** `idiom verify booking --spec .ab/spec.md` resolves the immutable baseline by exact fingerprint, capture coordinates, colour scheme, commit, and an intersection of the embedded finding's `{id, idAliases}` with the retained record's identifier set. Thus a canonical ticket can resolve an untouched `IDM-...` baseline without weakening evidence matching. Overlapping compatible embedded blocks deduplicate; incompatible overlaps fail closed. A safe `--against` run id is searched beneath both the current worktree and the primary checkout derived from Git's absolute common-worktree topology; an absolute or project-relative capture directory supports intentionally relocated evidence. Zero or multiple matches fail with the searched roots. The original ignored capture must be retained or copied—verify never “repairs” a missing baseline by capturing the fixed branch.

The exact deduplicated `(state, viewport, colour scheme)` triples are ordered by the manifest and passed to capture as triples, not independent unions. Historical scheme-less findings resolve to `capture.colorScheme`; an inert-scheme finding selects the complete flow grid. Verify then runs two fresh setup/data/build/server/browser lifecycles over that same list. Their complete deterministic result sets and full version-2 semantic signatures must agree at every selected triple. The signature contains visible elements in document order, structural paths, normalized direct rendered text, allow-listed class/inline-style/role/title/alt/ARIA/boolean-state attributes, expanded computed presentation styles, and stable-island-relative geometry. It excludes serialized `dom.html`, comments, hidden and forbidden non-rendered elements, framework flight/build payloads, URL-bearing and `data-*` attributes, and raw document dimensions.

Historical comparison is explicit version negotiation. A version-2 baseline uses the full profile. A retained version-1 baseline is supported without recapture by projecting baseline and both current runs to visible non-`script`/`style`/`template`/`noscript` records, reconstructed class-independent tag/sibling paths, eligible capped subtree text, shared styles, and ancestor-relative rectangles. Version-1 text exactly 500 characters long, temporal text and its rendered ancestors, and masked text do not contribute; eligible descendants still do. Current browsers evaluate mask selectors and store ordered rendered structural paths. A/B membership must agree; paths transfer exactly, widen to a common ancestor, or activate a reported temporal-mask fallback when a valid selector cannot transfer. Malformed CSS, A/B membership drift, or corrupt rendered ancestry fails closed with a precise diagnostic.

After calibration, visual comparison is bounded to a persisted target/region locus when one could be resolved after the original fingerprint was calculated. The stable region must resolve coherently in baseline/A/B; a target may disappear in both current runs and become an explicit candidate change. Presence in only one run, ambiguous movement, or region loss is unverifiable. Older or semantic hints use a labeled legacy whole-tuple fallback. Changes outside a bounded locus cannot prove a finding fixed. Dates/times and their downstream reflow are excluded. Pixel and raw-size differences are always evidence only; differing PNG sizes are padded to a shared canvas for a truthful composite.

The default is a fresh `.idiom/reports/verify-<timestamp>/`; explicit `--out` is a verify-owned destination atomically replaced on retry. The stable singleton contract is unchanged: `before-after.md`, `attachments.json`, `before-after-<state>-<viewport>.png`, and `current-a/`/`current-b/` capture trees. Axis-aware composites append the scheme to avoid collisions. A spec with no embedded findings writes a distinct not-applicable report, runs no setup/build/server/browser, and exits zero.

**autobuild.toml addition** (mirrors the existing `[verify.e2e]` pattern; `kind = "agent"` because `ab artifact put --attach` is an agent verb):

```toml
[commands]
idiom-verify = "idiom verify booking --spec .ab/spec.md --out .ab/idiom"

[verify.idiom]
kind = "agent"
skill = "ab-verify-idiom"
paths = ["apps/web/**", ".idiom/**", "PRODUCT.md", "DESIGN.md", "packages/design/**"]
```

**Attachment and agent contract.** `attachments.json` is strict version 1: `{ report: { kind: "idiom-verify-report", path: "before-after.md" }, composites: [{ ordinal, kind, state, viewport, colorScheme?, path }] }`. Manifest-order ordinals are consecutive from one. Their unique canonical kinds use minimum three-digit padding: `idiom-before-after-001`, `idiom-before-after-002`, and so on; report and Markdown repeat the same mapping. Distinct kinds matter because a later `ab artifact put --attach` designation replaces only the same kind.

The copy-ready `templates/ab-verify-idiom/SKILL.md` runs `ab context`, then the literal `idiom verify booking --spec .ab/spec.md --out .ab/idiom` command exactly once. The byte-identical `[commands].idiom-verify` value lives in `templates/autobuild.idiom.toml` for operator reuse; `[commands]` is not assumed to appear in `.ab/context.json`. On a nonzero CLI exit it attaches nothing and returns `before-after.md` as the failed verification report. On zero it validates the complete manifest/report/file mapping, deposits every distinct composite kind and then `idiom-verify-report`, and passes only after every deposit succeeds. Mapping/deposit failure is separately reported as evidence-delivery infrastructure failure. The agent never interprets pixels or overrides the CLI exit status. A no-finding/no-manifest-change case is a justified verifier skip. Vendoring the skill and selecting `idiom` in the ordered `[verify].steps` list remain deliberate human actions: interactive `idiom init` discovers the integration and performs them only through the separate offer, exact-diff preview, and configuration confirmation.

## Installing into a target repo

No dependency is added to the target's `package.json`: a `file:` path is machine-specific and would break Autobuild's `--frozen-lockfile` setup gate. An authorized user installs a release tag globally over GitHub SSH:

```sh
bun add -g "git+ssh://git@github.com/mattskilly/idiom.git#vX.Y.Z"
```

Replace `X.Y.Z` with the release being installed. This private route requires GitHub access and working SSH authentication. Bun's generated global link targets the tracked `dist/cli.js`; no clone, local build, or wrapper is part of the install. Updating a pinned Git package uses a preflighted `bun remove -g idiom` followed by the same SSH add command with the new tag, with the old tag recorded for rollback. npm publication remains deliberately parked while the commercial posture is unresolved. Maintainer release and credentialed install/update smoke requirements live in [releases.md](releases.md).

The init-managed footprint in a target repository is:

- `PRODUCT.md`, `DESIGN.md` — committed
- `.idiom/` — `project.json`, `flows/`, `references/`, `anti-references/`, `rules.json`, `decisions.jsonl`, `finding-names.json`, and `ruling-names.json` committed; `reports/` gitignored
- `.agents/skills/idiom/` — the canonical cross-harness conversational skill: `SKILL.md`, plus `init.md`, the guided-initialization procedure `SKILL.md` loads on demand. Ownership is anchored on `SKILL.md`: a directory whose `SKILL.md` is ours byte-for-byte gains any missing managed file and keeps every modified one; a directory whose `SKILL.md` is somebody else's receives nothing and is reported as preserved by that one name.
- `.claude/skills/idiom` — the relative `../../.agents/skills/idiom` Claude Code discovery symlink
- With separately confirmed Autobuild wiring: `.agents/skills/ab-verify-idiom/SKILL.md`, the relative `.claude/skills/ab-verify-idiom` discovery symlink, and the Idiom command/agent step selected in the root `autobuild.toml`.

Existing named skill entries and all sibling skills are preserved. The separate `/idiom init` form is the guided-initialization mode over `idiom init --yes` plus `idiom reference add|list`: it mines the repository for design evidence, asks only what the code cannot answer, captures offered links as references and anti-references, and hands `PRODUCT.md` and `DESIGN.md` back for the human's correction; it authors no flow manifest and therefore sits before the review loop below. The skill drives `idiom validate` → `idiom capture` → `idiom review --from` → evidence-backed conversation → `idiom decide` → selected `idiom tickets`, then renders each accepted finding with `idiom instruction` as an optional external handoff. Ticket triage and checked plain text are handoff boundaries: neither installation nor either emission authorizes the skill to edit product code, apply or send instructions, promote work, or run Autobuild or another dispatcher. The separate `/idiom verify <flow> <ticket-or-spec>` form delegates post-implementation verification to the CLI.

Autobuild verification remains a deliberate operator integration. Interactive `idiom init` detects only a root `autobuild.toml`, offers the wiring, plans a byte-preserving edit, prints the exact unified diff, and asks for a second explicit confirmation before changing configuration. It accepts an existing compatible seven-token `idiom verify <safe-flow> --spec .ab/spec.md --out .ab/idiom` command and compatible custom Idiom paths without normalization. It installs the canonical verifier skill and Claude discovery link under the collision rules above; replacing a differing regular verifier file requires its own confirmation. Invalid or structurally ambiguous TOML, incompatible command/step ownership, and foreign skill occupants fail closed: no wiring destination changes, the full manual template is printed, ordinary initialization still completes, and the command succeeds. `--yes` has an absolute no-wiring rule and emits only an availability notice. Fully wired reruns neither duplicate entries nor prompt.

## Appendix: booking example flow facts

Verified ground truth (2026-08-14) that the first flow manifest and capture pipeline depend on:

- **Database env resolution** (`apps/web/lib/booking/database.ts`): `BOOKING_DATABASE_URL` (hosted Postgres) → `BOOKING_DATA_DIR` (file-backed PGlite) → in-memory empty PGlite. A reproducible environment is a fresh data dir plus explicit `BOOKING_DATABASE_URL=` (empty, to defeat inherited env). **PGlite is single-holder**: the seed process must fully exit before the server opens the same dir.
- **Deterministic fixtures already exist**: `scripts/seed-booking-demo.ts` (`bun run seed:booking`, requires `BOOKING_DATA_DIR`) seeds one offer per recipient-page state — scenario keys include `known`, `anonymous`, `conflicted`, `booked-confirmed`, `booked-taken`, `expired`, `withdrawn`, `plain`, `former-handle`, `wrong-handle`, `legacy`, `unknown`, `malformed` — and prints a labeled URL per scenario. Terminal states are produced by **pre-seeded offer events**; every state of interest is reachable by GET only, so one seeded data dir serves a whole capture session.
- **No loading state exists.** The booking page is a fully server-rendered `force-dynamic` route; there is no `loading.tsx` or `error.tsx` anywhere under `apps/web/app`. The real state set is `book | confirmed | taken | expired | withdrawn | not-found`.
- **Seeded URLs are mostly `/book/<handle>/<code>` vanity paths**, not `/b/...` (only the `legacy` scenario exercises `/b/`). Both routes render the identical surface. The flow is defined as the "recipient booking page" and state URLs are taken verbatim from seed stdout.
- **Timezone is request-resolved** (`?tz=` param → IP-timezone header → recipient zone). Every captured URL pins `?tz=America/New_York`, and the browser context pins `timezoneId` to match.
- **Seed dates are relative to run day** (`nextHostWeekday(Date.now())`), so rendered date text differs across days. Handled by manifest masks and diff-time text normalization, never by patching the app. (Fallback if needed: a small app ticket exposing the seed function's existing `now` option via env.)
- **The booking route loads no webfonts** (system stack only, by design). Screenshots render in the OS font, so pixel comparisons are **same-machine only**; platform is recorded in metadata and enforced at diff time.
- **Never capture dev mode.** Always `bun run --cwd apps/web build` then `start` on port 3107 with `BOOKING_DEMO_CALENDAR=1` and `BOOKING_ORIGIN=http://127.0.0.1:3107`, exactly as the existing `ab-verify-e2e` skill mandates for verdicts.
- **Error and edge states are URL-addressable**: form validation errors travel as `?error=<code>` (`name`, `email-empty`, `email-long`, `email-invalid`, `link`, `calendar`) and the race-lost state as `?taken=1` — no POST needed to capture them.
- **Design token ground truth** for the `token-drift` check: `packages/design/src/theme.css` (`--color-bg`, `--color-fg-muted`, `--color-accent`, `--color-rule`, `--color-danger`, and friends).

## Local repair controller

`commands/fix.ts` delegates to `fix/run.ts`. The internal `checkWithReview` seam
returns the existing check summary and its rich review result; ordinary check's
output and attention cap are unchanged. Fix alone materializes every deterministic
representative and obtains complete deterministic occurrences. `fix/check.ts`
loads the captured grid and raw candidates through the existing artifact loader
and evaluator identity seam. It rejects incomplete or failed coverage and compares
stable project/flow/rule/design configuration across attempts. Retained evidence
for collapsed combination screenshots remains independent check evidence.

`fix/compare.ts` matches fingerprints and aliases at exact tuple coordinates,
including scheme and combination. Eligible policy-filtered occurrences determine
remaining work; raw full-flow occurrences determine regressions at every severity.
`lineageDecision` filters instance, standing, canonical and legacy rejections before
the top limit, including prompt siblings. `fix/prompt.ts` reuses `renderInstruction`
and adds source measurements and resolved crop paths without changing the public
acceptance-gated, path-free instruction command.

`fix/agent.ts` spawns a PATH-resolved executable without a shell, streams a prompt
over closed stdin, bounds each output stream to 1 MiB, and terminates attempts
after 15 minutes. Claude requires a successful JSON result envelope as well as
exit zero. Codex requires exit zero. Neither provider's prose is verification.
Agent output failures preserve edits and trigger a diagnostic full recheck.

Each attempted batch embeds its unaltered current source findings in an ordinary
verification spec and calls `runVerify` against that exact before-run directory.
Verification retains two fresh captures, calibration, ordinary attachments and
report publication; its optional typed `verdicts` are available only after a
successful evaluation/publication boundary (empty for no findings, absent on
calibration/comparison failure). A reproduced member may coexist with proven
progress, whereas an unverifiable member fails closed. New raw findings are a
separate stricter terminal gate; verify's existing new-blocker policy is unchanged.

Unique ignored fix sessions persist every prompt, spec, verification link, round
result and cumulative initial-to-final summary. No decisions or ticket lifecycle
checkpoints are invented. The controller reads HEAD around each subprocess and
performs no Git mutation or rollback. Dry-run returns its initial real prompt
before creating session artifacts or requiring an agent.


## Intended design comparison

`src/design/source.ts` owns local export serving and browser preview discovery;
`capture.ts` renders a neutral reference with a fresh deterministic browser context.
Normal and literal-page capture attach references before runtime teardown, lazily
launching Chromium for Electron references. Locale, timezone, scheme, viewport,
scale factor, reduced motion and full-page settings match the app; opted-in captures
wait for fonts and requested images before measurements. App steps, seeds, focus,
probes and invariants are not replayed against the design. Owned source servers and
browser contexts close with capture cleanup and interrupts.

`match.ts` is pure: rendered content trees use stable node IDs, idiom names,
role/accessible-name, owned text, then compatible sibling position between anchors.
Stronger evidence is exhausted before positional matching. Duplicates require scoped
or unambiguous evidence; explicit identity conflicts cannot fall back positionally.
Extra wrappers remain visible in unmatched evidence. `measure.ts` compares matched
geometry/styles/copy, using matched-parent boxes rather than the stable-island
`relativeRect`. The registry appends `design-drift` after existing signal checks.

`artifacts.ts` persists and reloads reference evidence with the app tuple. Review is
fully offline: no current manifest declaration, source file or URL is consulted.
Reference failure is unavailable coverage and prevents an entirely passing baseline.
A live-site reference (`{ "site": url }`) takes the same element path. An image
reference has no DOM: `image-diff.ts` aligns it to the app screenshot and groups
perceptual cell differences into `regions.json`, which the loader recomputes, and
each region becomes a minor finding (with the design image sent to the critique).
Paired crops use separate selectors on each side; missing/extra elements show the
matched parent on the absent side. Reports embed stored PNGs under the existing CSP,
escape values and labels, and never embed live reference HTML or remote frames.
Existing decisions, finding caps, grouping and repair prompts apply normally.

`identity.ts` normalizes the intended observation independently of timestamps,
transient source URLs and probe data. Verification requires usable matching design
identity in baseline/current A/current B before a vanished fingerprint can mean
fixed. Changed, removed, failed or disabled reference comparison is unverifiable.

### Figma normaliser seam

A Figma frame never goes through a browser. `src/design/figma/` parses frame URLs
(`url.ts`), fetches the node tree, a 2× render and best-effort variables through
the REST API into a pinned, version-keyed cache (`client.ts`, `cache.ts`), and
`normalize.ts` turns the node tree into a synthesized V2 observation: a
transparent viewport-wide `html`, the frame as `body`, and one element per
visible layer with frame-relative bounds and CSS-shaped styles. Figma facts the
comparison needs ride on element attributes (`data-idiom-source="figma"`,
`data-figma-id`, `-name`, `-path`, `-link`, `-variables`, `-frame-width`), so
matching, measuring, saved matches, crops, verification and reports keep one
code path. `figma/capture.ts` composites the render onto a viewport-wide canvas
so crop rectangles in CSS pixels land as they do on the app screenshot.

The matcher reads those attributes generically and stays a pure function of the
two observations, so saved-match revalidation still holds. A Figma id is a
positive match key only: it pins an app element whose `data-node-id` is that
Figma id, and never conflicts with an app's own `data-node-id` vocabulary.
Layer names meet `data-idiom-name` and accessible names; kind and interactivity
checks relax for Figma layers, except that a layer named as a control needs an
interactive counterpart. With no Figma element on either side, every rule
reduces to the HTML behaviour.

### Several references and design decisions

`references.ts` resolves a state's declaration into named references and picks
each Figma frame's viewport. `measure.ts` exposes `measureComparisons`: every
compared property per pair, within tolerance or not, keyed by app element,
property and app neighbour. With several references, `decide.ts` reconciles them
per key: agreeing references yield the first one's drift (naming the others),
and disagreeing references yield one `idiom:design-decision` candidate instead
of drift against either. `checks/project-config.ts` loads recorded
`decide --choose` answers into `ChecksConfig.designChoices` for every validated
run path, so a choice is applied inside the check: the review baseline and both
verify recaptures emit the same candidates. A choice of the reference the build
matches emits nothing; a choice of another reference emits that reference's
ordinary drift candidate with its single-reference fingerprint, which reproduces
until the app matches. A review recorded before the choice shows its decision
finding as fixed once the choice exists, and the converted drift as new on the
next review; this is the existing semantics for any finding whose identity
changes.


## Finding contracts and verification

Finding loaders normalize legacy acceptance arrays once through `findingSchema`. Canonical finding producers attach explicit measured/observed/judged provenance and a versioned acceptance object. `src/findings/contract.ts` builds deterministic rule contracts from candidate evidence and the effective settings, including decision-derived settings; model producers publish manual contracts. Human text consumers use `acceptanceText`, while JSON, ticket blocks and evidence retain complete objects.

`src/verify/acceptance.ts` reruns the registry and matches public rule plus coordinate and original selector/document/action scope. It validates settings identity, required sibling tuples and target-specific evidence, including immutable capture predicate settings from `run.json` when recorded, original invariant/component declarations, and design-image regions, reusing existing loading/failure judges for replay coverage. Matching violations fail; disappearance only passes with complete usable evidence in both current captures. Timeline ordinals are not action identity. New contracts never fall back to fingerprint disappearance. Legacy deterministic and calibrated visual-locus verification remain separate compatibility paths; their machine acceptance can be not-recheckable while their finding verdict is fixed. Overall pass and repair causes remain based on finding verdicts and existing regression guards. Global evaluation diagnostics preserve per-finding not-recheckable acceptance outcomes.

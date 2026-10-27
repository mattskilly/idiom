# Configuration

What to write in `.idiom/project.json`, flow files, `.idiom/glossary.json`, `.idiom/baselines/`, `autobuild.toml` and the GitHub workflow. How to run each command is in [commands.md](commands.md).

## Project file

Edit the generated `.idiom/project.json` so its server contract starts this application. At minimum, customize these exact fields (and choose a free port):

```json
{
  "surfaces": [
    { "id": "home", "name": "Public home page" }
  ],
  "server": {
    "build": "npm run build",
    "start": "npm start",
    "readyUrl": "http://127.0.0.1:3000/",
    "port": 3000,
    "env": {},
    "startupTimeoutMs": 60000
  }
}
```

The configured `port` is a template, not a pin. Each capture serves the application on a free port of its own and passes it as `PORT`; the configured port is swapped, as a whole number, into `readyUrl`, `server.env` values, the `build`/`start` commands and every state URL, so two captures of the same project (two worktrees, or a capture beside a running benchmark) never collide. Read `PORT` in your start command (most dev servers already do). To choose the port yourself, pass `--port <n>` to `capture`, `check`, `sweep` or `baseline record`, or set `IDIOM_PORT` (the only way for `verify` and `explore`). An application that cannot take a port sets `"fixedPort": true` in `server` and is served on `port` exactly as configured; `--port` or `IDIOM_PORT` naming another port is then an error.

Before starting the application, Idiom checks the ready URL: if anything already answers there, the capture stops with `cannot start application server: <readyUrl> already answers — port <port> in use by another process` instead of capturing a server it did not start. Console, DOM and accessibility evidence is recorded against the configured origin, so finding identity, decisions and baselines do not change with the port; each tuple's metadata keeps the origin actually served and records the configured one as `canonicalOrigin`.

`surfaces` is an ordered project-wide inventory. Each flow in an opted-in
project names the surface it captures. Idiom can then distinguish the surface
judged by the current review, surfaces governed by other flows, and declared
surfaces no flow governs. Existing projects may leave `surfaces: []` (or omit
the defaulted field); their capture, review, verify, and report behavior stays
unchanged and flows need no `surface` field.

### Capture settings

Web capture records filmstrips by default. Configure them under `capture`:

```json
"filmstrips": {
  "enabled": true,
  "offsetsMs": [0, 50, 100, 200, 400, 800],
  "actions": ["#open-panel", "load"]
}
```

`actions` defaults to `[]`: retain pixels only for actions linked to temporal findings. A CSS selector explicitly retains every measured activation of that control, including hover and held replay; `load` requests the initial navigation. These requests use the existing guarded execution and budgets. `offsetsMs` must start at zero, strictly increase, contain 1–16 nonnegative integer milliseconds, and end at or before 5000ms. A separate settle frame is always included. Set `enabled: false` for diagnosis or paired cost measurements. Quick review uses the default configuration.

Zero is actual input dispatch, after actionability waits and scrolling; load uses the navigation time origin. Settle is the original rule observation boundary, with an explicit unsettled flag at a deadline. Selected actions stay visually observed through the last offset before another action or restore. This tail does not extend rule windows. Unchanged compositor frames may be reused with their original timestamps; unobserved slots, interrupted documents and known timing misses beyond 35ms are marked unavailable.

Frames use a fixed viewport-relative region containing the effect and moved elements, padded by 24 CSS pixels, with the viewport as fallback. Contact sheets keep every requested column, label sampling times and outline subjects at their measured positions. Each sheet is capped at 4096×1536 pixels and 4MiB encoded PNG; image cells scale uniformly. Transient compressed buffers are bounded to 16MiB per action and 64MiB per collector/capture lane. Decoding rejects images above 16 million pixels. Filmstrips are web-only; Electron and design-reference capture keep their existing behavior. Historical runs without filmstrips remain readable.


The interaction probe is on by default for web flows; `checks.probe.enabled: false` turns it off, and a state's `probe: false` turns it off for that state. It runs once per state at its first selected viewport, preferring that viewport's light coordinate regardless of scheme declaration order. If light is excluded, it uses the first selected scheme without capturing an extra page. Set `checks.probe.everywhere: true` to probe every enabled selected coordinate; this setting alone never enables probes or overrides a state's `probe: false`. Probe evidence belongs only to its executed coordinate. A failed designated capture leaves its probe unavailable; sibling tuples do not retry it. Electron interaction probing remains unavailable.

The probe has hard wall-clock budgets. `checks.probe.controlTimeoutMs` defaults to **5000ms** per attempted control, including explanation sampling, the click, its effect window and the cheap restore check. Full replay has its own restore deadline (the larger of the control budget and 15 seconds, bounded by the state's remaining flow share); its expiry is reported as `timed-out: restore` on the control that needed it. The effect window ends after about 150ms with no DOM, URL, focus or network activity, capped by `checks.probe.waitMs` (default 350ms). Tooltip explanation sampling retains its independent hover/focus windows.

`checks.probe.stateTimeoutMs` defaults to **60000ms**. Web capture sizes one aggregate flow allowance from the wall clock. The run aims to finish within 400 seconds, keeping 20 seconds for merging, artifacts and checks. Probing may use the time left before that target on every capture lane, measured when each probe round starts. A round gives each state at most this duration, and the first round always gets at least this duration per lane. Later rounds run while unfinished work and wall time remain. Each round divides its allowance in proportion to assigned control counts, with one unit for a state's enumeration bookkeeping when it has no assigned controls. No state's share runs past the target. A finished state returns unused time to unfinished states, extending running deadlines as well as queued shares. Ordinary nested menu, panel and tab items have an additional cap of a quarter of their state's current share; they still count toward the flow allowance. In a planned flow, nested check candidates (the ranks below) are bounded only by the state deadline. This cap prevents nested work from consuming the whole share. Discovery follows at most three reveal steps and 20 controls per revealed surface. Standalone library probes without a flow allocation retain a per-state deadline. Expired attempts retain their selector and partial effects with `status: "timed-out"`, `timeoutScope` and a `skipped` reason. Their incomplete evidence cannot establish dead controls or duplicate entries. A timed-out page is retired; later assigned controls replay on a replacement. Native dialogs, print, file choosers, downloads and popups are suppressed throughout probing, and the mutation guard covers both the page and its context, including a popup's first request. Only declared state replay may send mutating requests.

After the clicks, the probe runs a **held replay** of every probe click and web step whose action sent fetch, XHR or document requests (web steps first, at most six per state). Each replay restores a fresh copy, repeats the action and holds its same-site fetch/XHR requests (and a full-page navigation) for `checks.loading.delayMs` (default **1500ms**; it must exceed `checks.progressWithinMs`) to see what a user on a slow network sees. Held requests then go through the same mutation guard as any probe click, so the replay never sends a request the probe would not; for a pending non-safe request it activates the trigger once more and records any duplicate, which is aborted. Each replay costs about one restore plus `delayMs` and its settle, counted against the state's probe budget. Once an action qualifies, the clicks stop when less than the smaller of 30% of the state budget and two replays' worth remains; the controls left are reported `not reached: held replay reserve`. A replay that still does not fit is noted in coverage, never timed out. The replays feed `loading-state-missing` and `double-submit`.

Restoring between controls is cheap when it can be. The probe moves the pointer off the page and compares a state fingerprint (URL, scroll, revealed regions, element count, text, state attributes including `class` and `data-*`, form values, and which elements render; hover tooltips excluded) with the baseline. Equal means the next control runs without a reload. Otherwise it tries blur, Escape and a visible close control in a newly revealed region, and gives transient classes another moment to revert. It fully replays the state when the ladder cannot recover the baseline. Navigation, popups and retired pages always require replay. Escape and close clicks keep the mutation guard active.

All designated states are enumerated before probing begins. Within a viewport and colour scheme, controls are identified by role, accessible name, region and selector signature (an authored `id`, otherwise their own and their parent's tag and classes). Each unique control is assigned to exactly one state, preferring states without a blocking modal, then those with the least assigned work. States probe in parallel in fresh contexts at `capture.concurrency`; their results merge afterwards. Other states copy the completed result using their local selector and `reusedFrom: "<assigned state id>"`, which may name a later state. When an assigned state ends with a control unprobed, or with nested items cut off by the nested-menu budget, the control goes back to a flow queue. The next round hands it to another state that shows it. Each state is offered a control at most twice and never again after attempting it. Rounds continue while unfinished work and wall time remain. A control is reported unreached only when no state that shows it can still run it: `not completed in any state that shows it (tried …)`, `flow probe time exhausted` or `timed out at state …`. Per-state dead-control, duplicate-entry and unexplained-control checks still receive every control in their view.

The probe's own check candidates run first, ranked across the flow before any ordinary control. First come controls whose accessible name occurs on another surface (duplicate-entry candidates). Next are glyph and icon-only controls (unexplained-control candidates), together with controls that declare a popup (`aria-haspopup`), whose revealed items are reached only through them. Then text-labelled buttons and menu items without an href that are not form submits (dead-control candidates). Qualifying controls in repeated rows follow the singletons. Within a rank, a state's own controls precede shared ones. Newly revealed controls use the same priorities. Ordinary repeated rows, swatches and specimen groups get their first two controls sampled; the rest are `not-reached: repeated-row sample`. Sampling never removes a check candidate. Distinct navigation and menu actions are preserved, and separate named regions have separate sample groups. `checks.probe.maxControls` counts assigned attempts. Every unattempted candidate has `status: "not-reached"` and a `skipped: "not reached: <reason>"`, including flow budget share, nested-menu budget or limit, repeated-row sample, modal blockage, an incomplete assigned state or `checks.probe.maxControls`.

`capture.animationSettleMs` defaults to **1500** milliseconds and accepts finite nonnegative values; `0` disables the extra wait. After the state's existing `settleMs`, web and Electron capture wait for running or pending finite animations and transitions to finish naturally, including chained effects, under one deadline. Static pages incur no fixed delay. Paused and infinite effects do not block capture. Unsupported animation enumeration is a no-op. Effects still at opacity zero after the bound are observed as unpainted. Evidence screenshots allow unresolved animations rather than fast-forwarding them; animated tuples do not reuse an earlier screenshot.

`capture.concurrency` defaults to **4** (1–8). Evidence collection uses one lane per viewport and colour scheme, with states in flow order within each lane. The later probe pass uses independent state lanes at the same concurrency. Every capture and probe state gets a fresh context, navigation and settle. Results, timings and reports retain the original tuple order. `IDIOM_CAPTURE_CONCURRENCY` overrides the setting for one run, as a diagnostic (for example `1` for sequential execution).

`capture.maxMinutes` defaults to **30** (finite positive fractional minutes are allowed). This single budget covers the complete capture, including setup/build, readiness, launch, measurement, tuples, artifact publication and teardown, with or without probing and for web or Electron. Expiry fails with the state, viewport, scheme and step in progress (`pending` coordinates during setup). Resource cleanup has at most **5 seconds** of additional grace after the deadline. Zero never means unlimited.

Colour scheme is an opt-in capture axis. `colorSchemes` defaults to the existing `capture.colorScheme`, and a flow may narrow it with its own `colorSchemes` list. Each selected state is captured at every selected viewport and scheme. The scheme is applied through Playwright's `prefers-color-scheme` emulation; `capture.colorSchemeAttribute` can additionally name an HTML attribute such as `data-theme`, whose value is set before application scripts run. `idiom validate` prints the effective schemes for every flow. If a complete multi-scheme capture renders one declared scheme identically to the preceding declared scheme across the full stable semantic profile, review emits a `missing-state` blocker naming the inert scheme.

## Flows

Keep the rest of the generated object intact. Then define `.idiom/flows/home.json`:

```json
{
  "id": "home",
  "target": { "kind": "web" },
  "surface": "home",
  "title": "Home page",
  "intent": ["Explain the product's main action"],
  "setup": [],
  "states": [
    {
      "id": "default",
      "description": "The default home page",
      "url": "/",
      "expect": {
        "status": 200,
        "textPresent": [],
        "selectorPresent": ["main"],
        "selectorAbsent": []
      },
      "mask": []
    }
  ],
  "viewports": ["desktop"]
}
```

Flow states also accept `"viewports": [...]` (narrow the flow's viewports for one state, for a panel that is offscreen by design on mobile) and `"focus": "<selector>"` (capture the state with that element focused, to catch focus rings colliding with neighbours). A web flow can list `"routes": ["/", "/leads"]` to capture plain routes without hand-writing states.

### Electron flows

Flows may instead target an Electron application. The target repository supplies
the executable or Electron app entry; Idiom does not bundle Electron into its
runtime. A complete desktop flow looks like this:

```json
{
  "id": "desktop",
  "surface": "desktop",
  "title": "Desktop composer and settings",
  "intent": ["Creating availability and changing settings stay clear"],
  "setup": [
    {
      "run": "node scripts/create-capture-fixture.mjs",
      "env": { "FIXTURE_PATH": "${dataDir}/fixture.json" }
    }
  ],
  "target": {
    "kind": "electron",
    "launch": {
      "executablePath": "node_modules/electron/dist/electron",
      "args": ["apps/desktop/main.cjs", "--user-data-dir=${dataDir}/profile"],
      "cwd": ".",
      "env": { "FIXTURE_PATH": "${dataDir}/fixture.json" },
      "timeoutMs": 30000
    },
    "window": { "title": "Product capture", "timeoutMs": 10000 }
  },
  "states": [
    {
      "id": "settings",
      "description": "Settings window",
      "steps": [{ "action": "click", "selector": "#settings-tab" }],
      "expect": {
        "textPresent": ["Settings"],
        "selectorPresent": ["#account-form"],
        "selectorAbsent": []
      },
      "mask": []
    }
  ],
  "viewports": ["desktop"]
}
```

Electron state steps are the strict `click`, `fill`, and `press` locator
actions. Electron expectations deliberately reject HTTP `status`; porting a
web expectation fails validation instead of silently ignoring it. `${dataDir}`
is supported in launch args, cwd, and environment values, including
`--user-data-dir`. Every tuple receives a fresh application process. The data
directory is fresh per capture run and shared by its tuples, so an Electron
profile rooted directly beneath `${dataDir}` is also shared within that run.
Apps that require per-tuple profile isolation must clear or namespace their
own profile during launch. `executablePath` is target-owned and
project-relative or absolute; it does not accept placeholders. Project
`server` commands are ignored for an Electron flow.

The capture window must have one stable, unique exact title, remain open,
permit `BrowserWindow.setContentSize`, expose DOM-addressable controls, produce
stable results for the declared actions, respond to live colour-scheme and
reduced-motion changes, and shut down cleanly. The optional root scheme
attribute and reduced-motion emulation are synchronized after Idiom selects an
already-loaded initial renderer, so an app must not sample either only during
boot. The launch `colorScheme` is a requested context preference, not proof the
initial document observed it before boot.

### Steps

Web states can reach a screen through ordered `steps`, executed after the state URL loads and before normal settle, expectations, and evidence collection:

```json
{
  "id": "create-page",
  "title": "Create from a template",
  "intent": [],
  "setup": [],
  "health": {
    "allow": { "urls": ["/optional-preview$"], "console": ["Known preview warning"] },
    "serverLog": "logs/server.log"
  },
  "states": [{
    "id": "editor",
    "description": "New page editor",
    "url": "/pages/new",
    "steps": [
      { "action": "fill", "selector": "#title", "value": "Welcome" },
      { "action": "select", "selector": "#template", "label": "Landing page" },
      { "action": "click", "selector": "button[type=submit]" },
      { "action": "expectUrl", "path": "/editor" },
      { "action": "expectText", "text": "Page created" }
    ],
    "health": { "allow": { "urls": ["/editor-help$" ] } },
    "expect": { "textPresent": ["Page created"] }
  }]
}
```

The supported action shapes are:

| Action | Fields |
| --- | --- |
| `click` | `selector` |
| `fill` | `selector`, `value` (may be empty) |
| `press` | `selector`, `key` (for example `Enter` or `ControlOrMeta+k`) |
| `select` | `selector`, exactly one of `value` or `label` |
| `waitFor` | `selector`, optional `state`: `visible` (default) or `hidden` |
| `expectUrl` | exactly one of `path` or `pattern` |
| `expectText` | `text`: a literal substring of visible text; multiple matches are accepted |
| `expectVisible` | `selector`, optional `within`: requires a unique target intersecting the viewport and its clipping ancestors |
| `focus` | `selector`: moves keyboard focus to the element without clicking it |

`expectUrl.path` matches the exact pathname, beginning with `/` and containing no query or hash; it is not a glob. `pattern` is a JavaScript regular expression source matched against the full URL. Each action/assertion waits for up to 10 seconds. The existing `expect.status` still checks the initial navigation response.

Every step fails on a console error, uncaught page error, HTTP response with status ≥400, or a new matching server-log line. Flow and state `health.allow.urls` and `health.allow.console` arrays add together. Patterns are nonblank JavaScript regexp sources without slash delimiters; URL rules match the full response URL or the console record's own resource location, and console rules match diagnostic text (including page errors). Expected console records remain in `console.jsonl` with `healthAllowed: true`, so later stored deterministic reviews preserve the exemption.

`expectVisible` supports both step spellings:

```json
{ "expectVisible": { "selector": "#selected-footer", "within": ".canvas" } }
```

```json
{ "action": "expectVisible", "selector": "#selected-footer", "within": ".canvas" }
```

The assertion retries document navigation within its 10-second budget and waits for a unique, rendered target with a positive-area intersection with the viewport and every applicable clipping or scroll ancestor. Partial visibility passes. Optional `within` must uniquely match a containing element; its client box is an additional boundary. Missing or ambiguous targets/boundaries, CSS-hidden targets, and fully clipped boxes fail with `target not visible` and the limiting boundary or reason. Visibility is viewport-based even with full-page screenshots. The assertion never scrolls or focuses a target; use it after the app's own selection action to check that the selected content is in view.

`health.serverLog` is a flow-level, project-relative file path. Old bytes are ignored; newly appended content is monitored continuously, including across steps, truncation, and rotation. A log may first appear during the first step but must exist by that step's completion; missing or unreadable logs fail explicitly. Defaults match whole-word `ERROR`/`FATAL` and uncaught exception/error markers case insensitively. Set flow-level `health.serverErrorPatterns`, for example `["Failed to create page"]`, to replace those defaults with ordinary case-sensitive JavaScript regexp sources. Console allowances do not exempt server-log errors.

After each action, Idiom waits for its nonallowed requests to finish and for 250 ms of continuous quiet. Browser diagnostic activity, request starts/completions, and new log bytes reset that interval. The drain fails after 5 seconds with pending URLs or persistent activity; URL-allowed requests do not block it. Logs are polled at least every 50 ms during actions and drains. Requests keep their originating step identity; events without request ownership belong to the active step, and the final step remains monitored through settle and evidence collection. This bounded interval cannot predict arbitrary future timers: a timer that fires after quiet has completed may belong to the next active step.

Failures stop the sequence, name the one-based step index/action and diagnostic at stage `step`, and attach a best-effort failure screenshot through the usual baseline and review artifacts. Only the final reached state is captured. URL-only states and Electron's existing `click`/`fill`/`press` contract retain their behavior. With the optional interaction probe enabled, restoration navigates and replays the steps; use replayable actions because restoring can repeat application side effects.

### Chained states

Many screens are one interaction away from a state you already capture. A web state may declare `from` (another state's `id` in the same flow's `states`) instead of `url` or `urlFrom`; it loads that state, its URL and steps, then runs its own `steps`:

```json
"states": [
  { "id": "empty", "description": "Editor at rest", "url": "/editor", "expect": {} },
  {
    "id": "versions",
    "description": "Versions panel",
    "from": "empty",
    "steps": [
      { "action": "click", "selector": "[aria-label=History]" },
      { "action": "click", "selector": "text=Versions" },
      { "action": "focus", "selector": "#version-search" }
    ],
    "probe": true,
    "expect": { "textPresent": ["Name this version"] }
  }
]
```

Exactly one of `url`, `urlFrom` and `from` is required. Chains may be several hops long (`named` from `versions` from `empty`) and may be declared in any order; an unknown id or a cycle fails `idiom validate` at `states[i].from`. A chained state inherits the root's URL source, every ancestor's `steps` (root first) and their `health.allow` rules; it does not inherit `expect`, `mask`, `settleMs`, `viewports`, `focus`, `probe`, `fresh` or `invariants`, so each state is judged on its own declaration. Every tuple still starts from a fresh browser context, and the probe's restoration replays the whole chain. A failing step names the state that declared it and the chain, for example `Step 1 (click) of "empty" reaching versions from empty: …`; steps of states without `from` keep the plain `Step 1 (click): …` form. Report coverage and `idiom coverage` show chained states as `versions from empty`, and capture metadata records `state.from` (the ancestors, nearest first). Toggles and `toggleStates` accept chained states as bases.

States that should share persistent chrome, such as the panels behind each rail button, can declare siblings for `sibling-chrome`. `siblingGroup: "<name>"` groups states across the whole run, including other flows; `group: "<label>"` groups states within the same flow. A state declares one or the other, not both (`idiom validate` reports `states[i].group`); Electron states accept both fields too. Toggle combinations inherit their base's declaration, while a state reached with `from` keeps only its own. Declarations are recorded in capture metadata (`state.siblingGroup` / `state.group`), so recapture after adding them. Groups are never inferred.

### Force empty, error and loading states

Declare a state for each case your flow must handle. Add fixture data in a setup
script, or let your application read query flags that force an empty response,
an error, or a delayed response. For example, these entries belong in a web
flow's `states` array:

```json
[
  { "id": "empty", "description": "No leads or canvas blocks yet", "url": "/leads?fixture=empty", "expect": {} },
  { "id": "error", "description": "The leads request failed", "url": "/leads?fixture=error", "expect": { "textPresent": ["Could not load leads"] } },
  {
    "id": "loading", "description": "Generation is in progress",
    "url": "/leads?fixture=loading&delay=2000",
    "steps": [{ "action": "click", "selector": "#generate", "longRunning": true }],
    "expect": {}
  }
]
```

Your application implements these fixture flags; Idiom does not generate fixture
data. Delay the fixture response to expose loading UI and mark only genuinely
long actions `longRunning` (supported on web click, fill, press and select).
Capture installs the watcher before the action and measures progress from input
dispatch, excluding Playwright's waits for a control to become actionable. Changes
while waiting are baselined. Missing progress is reported even if the step settles
quickly. Each marked step waits for at least the configured progress window. New progressbars, `aria-busy`, infinite animations,
changed status/control text and added loading text count. Existing indicators
are baselined; a hidden running spinner counts when the action reveals it.
Unrelated changes in live status regions can still count as
progress, so use stable fixtures.

`empty-state` requires both explanatory text (including headings) and an enabled
button or link.
Auto-detection covers rendered lists, tables, grids and feeds, including nearby
messages and CTAs. Utility lists such as navigation and live regions, and lists
under 16px tall or 32px wide, are excluded. Declare genuine voids and canvases in
`checks.emptyState.regions`; `items` is required to distinguish actual content
from the empty-state message. Items using `display: contents` still count when
visible descendants or text render. Configured regions search inside the region itself.
Changes to region selectors or `emptyState.ignore` require a recapture. Progress
thresholds can rejudge stored timings; if the stored window is too short, coverage
asks for a recapture. Earlier captures show empty-state as unavailable and
progress-affordance as skipped until recaptured with marked steps.

### Capture panel combinations

Web flows can declare named `toggles` whose options are ordinary web steps:

```json
{
  "toggles": {
    "drawer": {
      "closed": [],
      "360": [{ "action": "click", "selector": "#drawer-360" }],
      "480": [{ "action": "click", "selector": "#drawer-480" }]
    },
    "inspector": {
      "closed": [],
      "open": [{ "action": "click", "selector": "#inspector-open" }]
    }
  },
  "combinations": "all",
  "toggleStates": ["editor"],
  "toggleRegions": [".drawer", ".inspector", ".ed-controls"],
  "invariants": [{ "name": "controls", "selector": ".ed-controls", "height": 64 }]
}
```

`combinations` defaults to `"all"`. To select combinations yourself, use a list such as `[{ "drawer": "480", "inspector": "open" }]`; omitted toggles use their first option. Unknown names/options and duplicate combinations are errors. Toggle and option names must start with a letter or number and contain only letters, numbers, underscores and dashes. `toggleStates` selects declared base states; omitting it expands every declared state, while `routes` remain plain captures. Base states are still captured.

Each generated state appends the chosen options' steps after its base steps, in toggle declaration order. Order dependent toggles accordingly. Generated ids such as `editor.drawer-480.inspector-open` work with `--tuples`, and findings also show `[drawer=480, inspector=open]`. Each combination receives the same invariants and deterministic checks. Combination states are not probed unless the base explicitly sets `"probe": true`.

Before full capture, Idiom measures each combination's layout at every selected viewport and colour scheme. Combinations of the same base state with identical rounded element rectangles share one layout screenshot per viewport/scheme. Every combination still collects its own expectations, DOM, console, axe and observations, so content or accessibility failures remain visible even when the rectangles match. `toggleRegions` should include the panels and the chrome they push; all effective invariant selectors are included automatically. Without either, deduplication is skipped and disclosed. A failed measurement falls back to normal capture. `combinations.json`, representative tuple metadata and `baseline.md` record equivalent combinations and collapse counts; offline review checks every combination’s retained evidence and reports the number of shared screenshots. Older captures that omitted collapsed evidence still load, with an explicit unavailable-coverage note; recapture them to check every combination. Finding verification retains separate screenshots for every requested coordinate so layouts that converge after a repair still have complete comparison attachments.

With `"all"`, at most three toggles are crossed by default; further toggles stay at their first option, with the cap recorded in the reports. Explicit lists are not capped. Keys follow JavaScript object order: integer option names such as `"360"` precede other names, so use a prefixed name such as `"width360"` when the first-option default must follow written order.

### Budget published pages

A flow with `"kind": "published"` captures rendered pages (generated sites, `/p/<id>` exports) and holds them to a hard budget. `pages` expands to `page-…` states the way `routes` does; `viewports` may name widths in pixels and defaults to 1280, 768 and 375 (heights 800, 1024 and 812). Project viewport names still work, and a project viewport wins over a same-named width.

```json
{
  "id": "published",
  "title": "Published pages",
  "intent": ["Published pages fit every viewport and load every image."],
  "setup": [],
  "kind": "published",
  "pages": ["/p/apex", "/p/harbor"],
  "viewports": [1280, 768, 375],
  "budget": { "maxDiffRatio": 0.01 }
}
```

`idiom review published --from <runId> --deterministic-only` (and `idiom check`, at its default `--fail-on major`) fails when any page:

- is wider than the viewport (`The page is 1352px wide at the 1280px viewport`);
- has a broken image: an `<img>` that finished with `naturalWidth` 0, or an image request that failed or answered 400 or above, named by URL;
- has a serious or critical axe violation (one finding per rule);
- differs from its recorded pixel baseline by more than `budget.maxDiffRatio` (a fraction of the padded screenshot area).

The first default `idiom check published`, `idiom baseline accept published` and `idiom baseline record published` also copy each tuple's screenshot to `.idiom/baselines/published.pixels/<state>--<viewport>[--<scheme>].png`, overwriting what is there and pruning images no tuple maps to. Commit that directory with the JSON; without it the pixel budget is not measured. Full-page screenshots are not small, so budget only the pages that need it. The overflow and axe parts overlap `overflow-clip` and `a11y-label` on purpose: the budget is the gate. A rejected decision still suppresses a budget finding. Only published flows record image evidence, so other flows' captures are unchanged; captures from before 0.5 report the image part as unavailable until recaptured.

Flows can also declare `content.patterns` for an advisory model pass; see [Review patterns against their intent](commands.md#review-patterns-against-their-intent).

## Production builds

To judge production output, add an optional `server.production` block in `.idiom/project.json`. For example, a Next.js project using port 3000 and the default `.next` output:

```json
{
  "server": {
    "build": "npm run build",
    "start": "npm run dev -- --port 3000",
    "readyUrl": "http://localhost:3000/",
    "port": 3000,
    "env": {},
    "production": {
      "build": "npm run build",
      "start": "npm run start -- --port 3000",
      "distDir": ".next",
      "env": {
        "PORT": "3000",
        "NEXT_PUBLIC_API_BASE": "http://localhost:3000",
        "DATA_DIR": "${dataDir}"
      }
    }
  }
}
```

```sh
idiom capture studio-lab --prod
idiom check studio-lab --prod --json
idiom review studio-lab --from <runId> --deterministic-only
```

A web flow can default to production with `"server": "production"`; fresh capture, check, and review operations then use that mode. `--prod` requires a fresh capture and cannot accompany `check --from` or `check --latest`. Projects without the production block keep their existing behavior; an explicit request without it shows the configuration to add.

Production capture uses the same free-port mechanism as every capture (see the server contract above): Idiom reserves a free port before building (or uses `--port`, `IDIOM_PORT` or `fixedPort`), replacing the configured port in build/start commands, `readyUrl`, and production environment values, and passing it as `PORT`. Build and start receive the same expanded environment, including build-time `NEXT_PUBLIC_*` values. `production.env` overlays the inherited environment; the legacy `server.env` applies to the legacy path. `${dataDir}` expands to a fresh temporary data directory. Relative state URLs work as usual; absolute literal and setup-derived URLs matching the configured local origin follow the selected production origin, preserving path, query, and fragment. Unrelated origins remain invalid.

`distDir` is a dedicated output directory inside the project, defaults to `.next`, and must match the build tool's output configuration. Idiom preserves any existing output, builds once per run by default, stops its processes, removes the new output, and restores the original directory on success, failure, or interruption. Baseline metadata and check/review reports name the production build: its `BUILD_ID` when present, otherwise a SHA-256 of the configured build command and source commit. Stored runs retain that identity when reviewed later; `--latest` on a production-default flow selects production captures.

To reuse production output across flows and scoped reruns, opt in with `server.production.reuseBuild: true`. The default is false. The local cache lives under `.idiom/cache/production/` and is ignored for source identity. Admission requires a clean source snapshot, the same commit, canonical project/output paths, build/start configuration and effective build environment, plus matching cached build identity. Input and environment values are hashed in metadata. Dirty sources build afresh; changed inputs, missing/corrupt output or IDs, and an unavailable saved port cause a rebuild. An application with a constant `BUILD_ID` cannot bypass these checks.

Reuse always runs setup, starts an owned server and captures the selected tuples again. For clean reusable builds, setup and build/start environments share a stable cache-owned `${dataDir}` pathname, emptied before each run and removed after shutdown. The saved production port is reserved before setup/build so embedded client origins remain valid. A busy saved port selects a new one and rebuilds. The development port is unchanged. Cached output is copied into the owned output directory; pre-existing application output is restored after shutdown on hits and misses. An exclusive output lock spans preparation through restoration and data cleanup; overlapping captures fail with a retry message. Failed or cancelled build/start attempts do not publish cache entries. With reuse disabled, the existing temporary-data and fresh-build path remains in use.

## Checks

Besides the original ten checks, `check` and `review` run additional checks built from real misses in an AI-built product:

| Check | Catches |
| --- | --- |
| `unexplained-control` | icon-only or single-glyph controls (`?`, `⋮`) with no tooltip or meaningful name; disabled ones with no reason |
| `dead-control` | enabled buttons that change nothing when clicked (needs the interaction probe, on by default) |
| `duplicate-entry` | two or more persistent controls that open the same panel or focus the same field (needs the probe, on by default; follows bounded nested menus and panels). Controls are identified by location (selector and nearest landmark or region), so same-name controls in different places are separate entry points; per-row actions in a repeated list are excluded; focus counts only when it is each control's sole effect |
| `dead-affordance` | "View terms", "Learn more" and similar link-like text that is not a link; `href="#"` placeholders at minor severity |
| `adjacent-gap` | neighbouring controls closer than `checks.minGap`, including a focused field's ring (with its `outline-offset`), and bordered shapes that close within the same parent group or row; findings name the shared parent |
| `text-centering` | single-line labels in chips, buttons and badges sitting off their box's vertical centre (painted text only; single glyphs such as + − × use their ink box) |
| `component-size` | named components rendering outside their declared size, or a size stated in DESIGN.md |
| `copy-lint` | camelCase or dotted token names in copy, stutter ("On primary on primary"), sibling labels cased two ways (except declared `copy.properNouns` and `data-idiom-name` items in a list or grid), mixed locale spelling (`en-GB`, `en-US`, `en-CA`, `en-AU`), glossary terms, opt-in retired terms and jargon |
| `glyph-icon` | Unicode glyphs (`▾ ◉ ▣ ×`) standing in for icons inside controls |
| `error-text` | engineering failures on screen: "Renderer failed", stack traces, `[object Object]`, raw JSON |
| `native-control` | browser-default selects or checkboxes beside the product's own styled versions |
| `layout-invariants` | declared dimensions, edge alignment, offsets, and missing protected structure (#29) |
| `group-invariants` | declared grouping: items in a list whose attribute or text doesn't match the list owner's (#41) |
| `selected-state` | radio groups, tab lists, listboxes, segmented controls and swatch grids with no option marked selected, several selected in a single-select group, or a selected option that looks the same as its siblings (#20) |
| `dialog-shell` | open dialogs with a missing or doubled heading, no visible close control, a primary action scrolled out of view without a sticky footer, or a title size the run's other dialogs do not use (#23) |
| `disguised-control` | buttons that read or look like a text field ("Describe a change", "Search…", field border and muted left-aligned text); readonly or disabled fields drawn as editable with no stated reason (#33) |
| `fresh-state` | on states declared `fresh`: enabled undo/redo and visible "unsaved changes" indicators (#33) |
| `motion` | chrome surfaces that snap, observed durations outside the configured scale or maximum, and motion running under reduced motion (#45; needs the probe or declared web steps) |
| `element-overlap` | intersecting controls or text in the same chrome layer, including partly visible elements; names both selectors and the overlap size (#4) |
| `clipped-text` | single-line or wrapped labels cut off without an ellipsis, including clipped menu requests (#4) |
| `field-group` | touching label/control/helper stacks and insufficient space between field groups (#25) |
| `mirrored-control` | declared mirrored pairs (`checks.mirrored`) that differ in size, element kind (icon vs text glyph), type, or distance from their panel's canvas-facing edge (#24) |
| `scale-conformance` | authored spacing, control heights, corner radii (controls, cards, panels, chips) and border colours (dividers, controls) off the declared `checks.scales`, one finding per off-scale value ("3 buttons at 50px; scale is 28/32/40"); without a declared scale, only sharp outliers from the run's prevailing value (#17) |
| `control-anatomy` | a select chevron or an icon-button/segmented-control icon more than 1px off its label's ink centre (or the box centre); sibling selects with different inner padding or chevron size (#26) |
| `luminance-parity` | in light/dark captures, a field, card or panel whose background stays light (or dark) while its painted container and most comparable neighbours flip; primary-action labels under 4.5:1 contrast in either scheme, at any text size (#9) |
| `frame` | the configured primary frame (`checks.frame.selector`) with no fill luminance step, visible border or shadow against its surround on any visible edge (#32) |
| `primary-region` | the declared primary region (`checks.primaryRegion`) narrower than its minimum share of the viewport width; every run reports the measured share (#18) |
| `alarm-at-rest` | warning glyphs (⚠), alert-named icons, or red/configured warning colours on icons with no error or warning around them (#21) |
| `cross-surface-naming` | one `data-node-id` labelled differently across the declared surfaces (`checks.naming.surfaces`), such as tree, breadcrumb, selection chip and toolbar (#19) |
| `published-budget` | on `"kind": "published"` flows only: horizontal document overflow (with the measured width), broken images (naturalWidth 0 or a failed/≥400 image request, naming the URL), serious or critical axe violations, and pixel drift beyond `budget.maxDiffRatio` from a recorded pixel baseline; all blockers (#15) |
| `empty-state` | empty lists, tables, grids and declared canvases (`checks.emptyState.regions`) with no call to action or explanatory text (#10) |
| `progress-affordance` | web steps marked `longRunning` with no spinner, progressbar, `aria-busy` or status text change within `checks.progressWithinMs` (default 1000ms) (#10) |
| `shell-visibility` | opt-in flow shell height/viewport bounds and intersections between declared floating overlay peers (dogfooding requests #46 and #47) |
| `compound-control` | opt-in (`checks.compoundControls`): a short token such as a unit shown twice in one field (a select's value and an adornment inside the adjacent input), and short adornments that cross the input's border, sit closer to its inner edge than the input's own padding, or lie over its content box (dogfooding request #70) |
| `sibling-chrome` | opt-in (`checks.siblingChrome.regions` plus state `siblingGroup`/`group`): a named control, matched by role and accessible name, that every other declared sibling state shows inside a chrome region but one state lacks (dogfooding request #72) |
| `page-content` | opt-in page review (`idiom review --page` or `checks.page`): lorem ipsum and placeholder copy, a hero or final section with no button-styled call to action, images with no alt text, and (with a brief) statistics the brief does not contain (#31) |
| `band-edges` | opt-in `checks.bandEdges`: top-level page bands whose foreground content gutters differ from the dominant edges, per viewport; full-bleed media is exempt (#65) |
| `word-break` | opt-in `checks.wordBreak`: heading and button words split across rendered lines without a hyphen, per viewport (#66) |
| `touch-reachability` | opt-in (`checks.touchReachability`): on `touch: true` viewports, enabled controls hidden at rest (`visibility: hidden` or zero effective opacity) that only CSS hover on their painted owner reveals (dogfooding request #67) |
| `liveness` | opt-in (`checks.liveness`): declared or timer-like text sampled twice ~1.5s apart that stays unchanged or all zero (dogfooding request #68) |
| `media-fill` | on by default (`checks.mediaFill.auto`): image, iframe, video or canvas thumbnails in a gallery of three or more repeated cards whose frame, sampled from the screenshot, shows a solid backdrop band at an edge, letterboxing or nothing at all (dogfooding request #73) |
| `collection-actions` | opt-in (`checks.collections`): a minor heuristic when open, rename or delete is not reachable from a declared collection's items, their menu or their context menu (dogfooding request #74) |
| `font-loading` | on by default (`checks.fonts`): a web font used by visible text that failed or never loaded, or renders in the fallback; names the family, the failing URL and the affected selectors |
| `broken-link` | on by default (`checks.links`): visible links answering 4xx/5xx or failing DNS; same-origin major, external minor and opt-in (`checks.links.external`) |
| `focus-visible` | on by default (`checks.focusVisible`, needs the probe): a control whose keyboard focus changes no outline, ring, border, background or shadow |
| `line-length` | on by default (`checks.lineLength`): body paragraphs running more than 90 characters per line (`max`) |
| `orphan-word` | on by default (`checks.orphanWord`): headings and button labels whose last line holds one short word, per viewport |
| `image-distortion` | on by default (`checks.images`): images drawn with `object-fit: fill` more than 3% out of their natural aspect ratio |
| `broken-image` | on by default (`checks.images`): visible images that failed to load or decode |
| `layout-shift` | on by default (`checks.layoutShift`), major: cumulative layout shift during load above 0.1, naming the shifting elements and, with a load timeline, the late content that caused the largest shift |
| `interaction-shift` | on by default (`checks.interactionShift`), major: content outside what a probe click or web step changes moves at least 4px (`minDistance`) without animation because content was inserted, removed or resized; content arriving more than 500ms after input is reported even inside the action's own region |
| `loading-state-missing` | on by default (needs the probe): an action whose result waits on a fetch/XHR request but shows no pending feedback within `checks.progressWithinMs` while the probe holds the response for `checks.loading.delayMs`; client-side route changes that leave the main content empty or unchanged |
| `double-submit` | on by default (needs the probe): a trigger left enabled while its POST/PUT/PATCH/DELETE is pending, where a second activation issues a duplicate (observed and aborted, never sent) |

Every rule, with why it matters, its severity, its source and how to configure or decide it, is listed in [rules.md](rules.md).

By default, a control whose painted text is a single glyph or symbol (`?`, `i`, `ⓘ`) is a minor `unexplained-control` finding when the probe sampled both hover and focus and neither showed a tooltip, even if it has an `aria-label` or native `title`: neither is visible. Painted `aria-describedby` text or a tooltip on either trigger clears it. Bare icon buttons are not covered by this default, and a control without hover/focus evidence (the probe is off, it was skipped, or the tuple is a sibling coordinate) is not reported. Turn it off with `checks.probe.enabled: false`, or skip specific controls with `checks.probe.skip`.

For stricter explanations (dogfooding request #55), opt in with:

```json
{
  "checks": {
    "explanation": "visible"
  }
}
```

In `visible` mode, an icon or glyph control needs meaningful painted label text, visibly rendered text referenced by `aria-describedby`, or a nonempty `role="tooltip"` observed on **both hover and focus** for that control in the same captured state and viewport. An accessible name, native `title`, hidden description, or tooltip attribute alone does not suffice. Unexplained enabled controls remain major findings; unavailable ones remain minor.

The probe (on by default) collects dynamic tooltip evidence; in visible mode it samples every glyph and icon control, in the default mode only text glyphs. Sampling isolates hover from focus, observes delayed and CSS tooltips, and respects `checks.probe.skip`, `maxControls` and `waitMs` (with a 150ms minimum sampling interval). Icon links are sampled without clicking them. Existing web-step pointer/focus transitions and `state.focus` also record evidence; a keyboard `press`/Tab records the element that actually received focus. A capture window proving only one modality does not prove both. Visible associated descriptions present at capture suffice without a probe. The setting alone does not enable a click probe.

Both modes report disabled or `aria-disabled` buttons labelled “Help”, “View terms”, “Learn more” and similar navigation copy as minor `dead-affordance` findings, suggesting a real destination or a visible placeholder anchor (`href="#"`). Native titles explaining the disabled state do not excuse this dead end; ordinary disabled actions such as Save are unaffected. Placeholder links remain minor debt in both modes. It is minor, below the default `--fail-on major` gate, and there is no separate switch: accept individual instances with a decision or ruling.

Omitting `explanation` (or setting `"default"`) keeps the default judgments, which accept native titles and meaningful accessible names except on probed text glyphs as described above. Older artifacts without painted explanation evidence report `unexplained-control` unavailable in visible mode: recapture them. A fresh static capture measures missing explanations and can report findings even without a probe; collect interaction evidence before judging dynamic tooltips. Captured explanations persist in observation artifacts for offline review. Tooltip evidence carries document/control identity so navigation or replacing a control cannot combine unrelated modalities; recapture older tooltip evidence lacking this identity. Off-screen, fully clipped and transparent text does not supply an explanation.

Opt in to page gutter alignment and word-break measurement independently:

```json
{
  "checks": {
    "bandEdges": { "tolerance": 8 },
    "wordBreak": { "enabled": true }
  }
}
```

Both blocks are absent by default, including in `review --page`. Supplying either block enables that check; `"enabled": false` disables its collection and findings. These settings work with page review, published pages and page-oriented flows, without requiring `checks.page`. Recapture after enabling them: older version 1/2 observations or captures made without the option lack the geometry and report unavailable coverage, rather than a clean result.

`band-edges` compares the first foreground content boxes inside top-level header/navigation, stacked sections and footer, including bands below the fold. It preserves container gutters rather than comparing short logo text. Left and right edges are inferred separately within each state, viewport and scheme: the largest group spanning at most `tolerance` pixels must include at least two bands and a strict majority. Its median is the dominant edge. Ties or insufficient consensus are explained in coverage and produce no finding on that side. Deviations **greater than** the tolerance (default 8px; zero allowed) produce one minor finding per band. Full-bleed foreground media is exempt from voting and reporting; a full-width background behind inset text is still assessed.

`word-break` uses text-node ranges, Unicode word/grapheme boundaries and visible line positions in headings and native/ARIA buttons. It reports one major finding per owner at every affected viewport, including inline-markup continuations. Normal space wrapping, explicit/soft hyphens and scripts with native intra-word wrapping conventions remain quiet. Vertical writing, unresolved automatic hyphenation, clamped candidates and defensive work limits produce explicit incomplete/unavailable coverage; independently confirmed splits still report. Merely enabling CSS hyphenation does not produce a finding.

The font, link, focus, typography, image, layout-shift and interaction-shift checks are on by default and configured independently:

```json
{
  "checks": {
    "fonts": { "enabled": true },
    "links": {
      "enabled": true,
      "external": false,
      "timeoutMs": 5000,
      "budgetMs": 30000,
      "concurrency": 4,
      "ignore": ["/logout"]
    },
    "focusVisible": { "enabled": true, "ignore": [".map-canvas"] },
    "lineLength": { "enabled": true, "max": 90 },
    "orphanWord": { "enabled": true, "maxChars": 7 },
    "images": { "enabled": true, "distortionTolerance": 0.03 },
    "layoutShift": { "enabled": true, "max": 0.1 },
    "interactionShift": { "enabled": true, "minDistance": 4 }
  }
}
```

`"enabled": false` reports the check skipped. Capture still records the in-page evidence (it is cheap and lets you re-enable a check without recapturing), except links, which make no requests when disabled. Links are checked once per run, after observation, through a cookie-less request context (HEAD, with a GET fallback), so a link to `/logout` cannot end the capture session. Same-origin links are checked by default and external ones only with `external: true`. `ignore` takes absolute-URL or path prefixes that are never requested. 401, 403, 407 and 429 answers and timeouts are recorded as unchecked, never broken. `concurrency` and `budgetMs` bound the work; once the budget is spent, the remaining links are unchecked and coverage says so. The focus sweep runs in the probe pass, after the screenshot, and also honours `checks.probe.skip`. Electron captures record fonts, line length, orphan words, images and layout shift, but not links or focus.

Configure the craft checks in `.idiom/project.json` (every field is optional); layout invariants live in the flow as shown below:

```json
{
  "checks": {
    "minGap": 3,
    "adjacentGap": { "regions": [], "indicatorMax": 16 },
    "centeringTolerance": 1.5,
    "components": [
      { "name": "override dot", "selector": ".bp-override-dot", "width": 8, "height": 8 }
    ],
    "copy": {
      "locale": "en-CA",
      "retired": [{ "term": "Style guide", "preferred": "Brand" }],
      "jargon": [{ "term": "nodes", "preferred": "items" }],
      "glossary": [{ "term": "Patterns-built", "preferred": "Built from patterns" }],
      "schemaWords": ["Stack", "Container"],
      "properNouns": ["Hero Centered", "CTA Centered"]
    },
    "glyphAllow": ["→"],
    "errorPatterns": ["Renderer failed"],
    "probe": { "enabled": true, "respectControlIntent": true, "skip": ["[data-destructive]"], "maxControls": 80, "waitMs": 350 },
    "selectedState": { "minColorDelta": 32 },
    "disguisedControl": { "placeholderPatterns": ["^Ask Builder\\b"], "ignore": [".cmdk-trigger"] },
    "freshState": {
      "historyNames": ["^revert\\b"],
      "historySelectors": ["[data-history]"],
      "unsavedPatterns": ["\\bdraft not saved\\b"],
      "unsavedSelectors": [".dirty-dot"]
    },
    "mirrored": [{ "name": "panel collapse", "a": "#drawer-collapse", "b": "#inspector-collapse", "axis": "vertical" }],
    "scales": {
      "controlHeights": [28, 32, 40],
      "radius": { "control": [6], "card": [8], "panel": [12], "chip": ["full"] },
      "border": { "divider": ["#E5E7EB"], "control": ["#D1D5DB"] },
      "roles": { "chip": [".tag"] }
    },
    "motion": { "maxMs": 150, "durations": [120, 150], "selectors": [".layers-panel"] },
    "fieldGroups": { "inner": 4, "between": 12 },
    "progressWithinMs": 1000,
    "loading": { "delayMs": 1500 },
    "emptyState": {
      "regions": [{ "selector": "main.canvas", "items": ".block" }],
      "auto": true,
      "ignore": [".toast-list"]
    },
    "luminanceParity": { "primarySelectors": ["#publish"], "ignore": [".artwork-preview"] },
    "frame": { "selector": "#page-frame", "minLuminanceDelta": 0.05 },
    "primaryRegion": { "selector": "main.frame", "minShare": { "desktop": 0.65, "laptop": 0.65 } },
    "alarm": { "colors": ["#F59E0B"], "brand": ["#E5484D"], "ignore": [".rating-star"] },
    "naming": {
      "surfaces": {
        "tree": "[role=tree]",
        "breadcrumb": "nav[aria-label=Breadcrumb]",
        "chip": ".selection-chip",
        "toolbar": ".toolbar .node-label"
      }
    }
  }
}
```

`adjacent-gap` compares interactive controls with each other wherever they sit, so a stepper's −/+ buttons touching their number input, or a composer field's focus ring meeting Send, are reported. A non-interactive bordered shape (a card, a chip) is compared only with neighbours in the same direct parent. Layout regions are never compared: landmarks and `nav`, `main`, `aside`, `header`, `footer`, `section`, `article`, `form` and `dialog` (or the matching roles), direct children of a dialog, and panels that hold a heading or a bordered group of controls. Add selectors to `checks.adjacentGap.regions` for any other region that is flush by design; they are resolved at capture. Non-interactive boxes no larger than `checks.adjacentGap.indicatorMax` (default 16px) in both dimensions, such as status dots and badges, are indicators and are skipped; set it to 0 to compare them. A shape wrapped in an extra unbordered `div` on one side has a different parent and is not compared. Captures from before `outline-offset` was recorded measure the ring by its width alone.

`checks.copy.retired` and `checks.copy.jargon` accept arrays of `{ "term": "...", "preferred": "..." }`. Both values must be nonblank; every hit names the element, observed label, term and concrete replacement and includes an element crop. Retired phrases match case-insensitively anywhere in a longer label ("Style guide: primary colour" → "Brand: primary colour"). Jargon matches whole words or phrases using Unicode letter/number boundaries, so banning `en` does not ban `enabled`. Terms are literal text, with whitespace normalized. Both lists default to empty. The existing `glossary` array uses the same entry shape but allows `preferred` to be omitted for a ban without a replacement. Visible copy is checked once per element and term; matching `aria-label` and `title` values do not add duplicate hits. Hidden text, code, input contents and `translate="no"` text are excluded; recapture to record the translation attribute on older runs.

Copy owners can optionally keep these settings at the root of `.idiom/glossary.json`, without a `checks.copy` wrapper:

```json
{
  "locale": "en-CA",
  "retired": [{ "term": "Style guide", "preferred": "Brand" }],
  "jargon": [{ "term": "Disclosure", "preferred": "Expand" }],
  "glossary": [{ "term": "Patterns-built", "preferred": "Built from patterns" }],
  "schemaWords": ["Stack"],
  "properNouns": ["Hero Centered"]
}
```

A missing file is normal; malformed JSON, invalid fields or read errors name the file and fail validation. File and project arrays are additive; omitted or empty arrays do not erase the other source. Within each term field, trimmed, whitespace-normalized, case-insensitive duplicates collapse, with the last declaration winning within a source and project config winning over the file. Project locale overrides file locale. `schemaWords` and `properNouns` combine by exact string identity and retain their case-sensitive matching. If the same term appears in several fields, `retired` takes precedence over `jargon`, then `glossary`, producing one finding. Loading never rewrites either source.

Set `checks.copy.locale` to `en-GB`, `en-US`, `en-CA` or `en-AU` for explicit spelling preferences. With no locale, the existing British/American majority heuristic remains: it reports minority spellings only when both variants are present. The spelling check covers a small word list, not a dictionary or translation catalogue. Canadian preferences combine `colour(s)`, `favourite(s)`, `behaviour`, `centre/centred`, `grey`, `catalogue` and doubled-l `cancelled/modelling/labelled` with `-ize` verbs (`organize`, `customize`, `optimize`, `recognize`, `synchronize`, `prioritize`, `summarize`, `visualize`, `personalize`) and `analyze`. Australian preferences use `colour(s)` and `organise` and the British forms in that bounded list. The new locales skip `licence/license` because the correct spelling depends on noun/verb context. Each explicit-locale finding gives the observed word and preferred spelling, including plurals and initial or all-capitals casing.

`copy-lint` compares the casing of shared words across sibling labels. Names are not casing slips: list them in `checks.copy.properNouns` (matched case-sensitively as whole phrases, so a mis-cased "Hero centered" is still compared), or mark each item of a picker with `data-idiom-name` when it sits in a list or grid collection (`ul`, `ol`, `li`, `table`, list/grid roles or `display: grid`). A marked item outside a collection is still compared. Glossary, token and locale rules apply to named items as usual.

`overflow-clip` reports boxes that hide part of their content. Crop-to-fit media is the design, so a box with no text of its own whose children are all `iframe`, `img`, `video` or `canvas` elements (or wrappers holding exactly one, such as a scaled thumbnail frame) is not reported, nor is a box marked `data-idiom-crop`. Text clipped inside either is still reported by `clipped-text`. `data-idiom-*` attributes are read at capture, so recapture after adding them.

`element-overlap` reuses browser hit tests across intersecting boxes, keeps menus and dialogs separate from the content beneath them, and avoids repeating narrow-viewport overlap findings. `clipped-text` measures text lines against clipping boxes and reports the owner, overflow and kind of cut; intentional ellipses, line clamps, scrollable content and peeking carousel cards are excluded. `field-group` follows labels to their controls and helper/status text: `checks.fieldGroups.inner` sets the minimum space inside each group (default 4px), and `.between` sets the minimum between groups (default 12px, at least `inner`). These measurements are stored with captures for offline review; older captures show unavailable coverage until recaptured.

`checks.components` compares each rendered component with its declared width and height. When `tolerance` is omitted, each dimension's allowance is the **smaller of 15% of that declared dimension and 1px** (`min(dimension * 0.15, 1)`). An 8×8px declaration allows ±1px: 12×12px is reported, while 8.5×8.5px passes. A 4×20px declaration allows ±0.6px in width and ±1px in height. Both undersize and oversize count; a difference exactly equal to the allowance passes. Findings print the applied pixel allowance for each axis.

An explicitly supplied `tolerance` object keeps the earlier defaults: omitted numeric fields become `ratio: 0.25` and `px: 4`, and omitted `mode` becomes `"looser"`. Thus `"tolerance": {}` allows the **larger** of 25% and 4px, and `"tolerance": { "px": 2 }` allows the larger of 25% and 2px. Set `mode: "tighter"` to use the smaller allowance; mode alone keeps the explicit object's 25%/4px defaults. For example, these component declarations choose both policies explicitly:

```json
[
  { "name": "dot", "selector": ".dot", "width": 8, "height": 8,
    "tolerance": { "ratio": 0.15, "px": 1, "mode": "tighter" } },
  { "name": "badge", "selector": ".badge", "width": 20, "height": 12,
    "tolerance": { "ratio": 0.25, "px": 4, "mode": "looser" } }
]
```

Captures record the selected tolerance policy for offline review. Older captures without `mode` keep the larger-of policy with their stored numbers; recapture to adopt the new omitted default.

Without any declaration, sizes stated in the project's design file (`design.designFile`, `DESIGN.md` by default) next to a name are inferred: "override dots … about 8px" (both axes, for round things such as dots, avatars, swatches, indicators and icons), "chips 24px high" (height only), "panels 280px wide" (width only) and "cards 320×200px". Token tables and type scales ("Spacing steps are 4px and 8px", "Body text is 13px") are ignored, as are fenced blocks. Capture resolves each inferred name to a selector, preferring the class token whose words contain the name in order (`bp-override-dot` for "override dot") and falling back to `aria-label` words, and judges it with the default tolerance. A one-axis statement checks only that axis. Findings cite the line ("inferred from DESIGN.md:12"); `idiom context` lists the inferred sizes, and report coverage shows the selector each one matched, or that nothing matched. An explicit `checks.components` entry with the same name, or with the resolved selector, wins. To stop an inference, reword the sentence or declare the component explicitly. Electron captures do not infer components.

`target-size` checks every captured viewport by input class without configuration: fine-pointer desktop viewports use a 24×24 CSS pixel minimum; widths strictly below 768px and viewports with touch signals use 44×44. `checks.targetSize` overrides these defaults:

```json
{ "checks": { "targetSize": { "fine": 24, "coarse": 44, "narrowBelow": 768 } } }
```

Every captured viewport is checked: widths strictly below `narrowBelow` use `coarse`; wider viewports also use `coarse` when captured input signals show touch points, a coarse pointer or no hover. Otherwise they use `fine`. The 24px figure comes from WCAG 2.2 AA criterion 2.5.8 (Target Size, Minimum); spacing-based exemptions are not assessed. Partial blocks fill in these defaults; values must be positive and `coarse` must be at least `fine`. Findings state the viewport, input class and minimum, and a control may produce a finding at each affected viewport.

A project viewport can set `"touch": true`, for example `{ "name": "tablet", "width": 1024, "height": 768, "touch": true }`, to enable Playwright's `hasTouch`. Capture records pointer, hover and touch-point signals for offline checks. Captures from before these signals were added classify by width alone.

`primary-region` measures the visible width of the widest element matching `checks.primaryRegion.selector` against the viewport width. `minShare` is a fraction (0–1], either one number or a record keyed by viewport name; viewports without a minimum still report the measured share in coverage. `alarm-at-rest` looks only at icon-like ink (top-level SVGs, `<i>`, icon classes, `data-icon`, symbol-only text). It reports warning glyphs and alert/warning/error-named icons, colours within reach of `checks.alarm.colors`, and saturated reds far from the brand palette (`checks.alarm.brand` plus non-warning design tokens) on icon-sized, single-hue icons. Amber is judged only when configured, because it is also a common brand and rating colour. Icons inside `aria-invalid`/`role=alert` regions or error messages, beside status text ("failed", "required", `checks.errorPatterns`), in destructive controls (Delete, Remove), on states whose id names an error, or matched by `checks.alarm.ignore` are exempt. `cross-surface-naming` reads, for each `data-node-id` inside each declared surface, its `aria-label` or the text it owns (excluding nested node rows and `aria-hidden` separators), and reports a node whose labels differ, case-insensitively, as one finding listing every surface's label. Declare at least two surfaces. All three resolve their selectors at capture, so configure them before capturing; older captures report unavailable coverage until recaptured.

A web or Electron flow can declare an app shell:

```json
{ "shell": ".ed-shell" }
```

Every captured tuple checks exact `scrollHeight === clientHeight` equality and that the shell's vertical box stays inside the viewport. Shell findings name measured dimensions and extending descendants, including visually hidden, clipped or absolutely positioned elements that contribute scroll geometry. Independently scrolling panel content is bounded by its own scrollport. A missing, ambiguous or invalid shell selector fails explicitly. Ordinary scrolling pages can omit `shell`.

Declare floating overlay peers in the project's optional checks block:

```json
{
  "checks": {
    "shellVisibility": {
      "floatingOverlays": ["#selection-toolbar", "#selection-breadcrumb"]
    }
  }
}
```

Only these peers are compared, after viewport and ancestor clipping; any positive-area intersection is reported. Hidden or absent overlays are inactive, edge touching passes, and the same element or an ancestor/descendant wrapper pair is excluded. Fixed roots and `pointer-events: none` roots still count. Declarations must be nonblank and unique. Invalid CSS and missing captured measurements report unavailable coverage. Fresh captures without either declaration skip this check; older captures request recapture, as do newly configured overlay selectors absent from the capture. No panel is scrolled automatically. Shell and overlay evidence is retained separately for every tuple, including those sharing a screenshot.

Compound controls and sibling chrome are opt-in too:

```json
{
  "checks": {
    "compoundControls": { "tokenMax": 4, "minInset": 2 },
    "siblingChrome": { "regions": [".left-panel header", "nav.rail"] }
  }
}
```

`compoundControls` turns on `compound-control`; both fields are optional. `tokenMax` (1–8, default 4) is the longest adornment or select value compared, and `minInset` (default 2) is the smallest gap an adornment keeps from the input's inner edge, which is otherwise the input's own leading padding (with a 1px allowance). Adornments are short, non-interactive text painted over a text-like input; pseudo-element (`::after`) suffixes are not seen. Select values are recorded at capture, so older captures report `compound-control` as unavailable until recaptured.

`siblingChrome.regions` lists the chrome regions to compare: headers, rails and toolbars that should look the same in every sibling state. Avoid whole panels, whose content legitimately differs. States are compared only when they declare siblings (see below); a control counts when it appears in every other sibling at the same viewport and colour scheme, with at least two such siblings. Region selectors are resolved at capture.

Touch emulation already existed through per-viewport `"touch": true`; `touch-reachability` adds detection on top of it. Enable it with an empty block:

```json
{ "checks": { "touchReachability": { "ignore": [".intentionally-hover-only"] } } }
```

On a tuple whose captured input is no-hover touch (`hover: none` plus a coarse pointer or touch points; narrow width alone does not count), capture looks for enabled controls in the viewport hidden by `visibility: hidden` or zero effective opacity, including an ancestor's. Display-none chains, `[hidden]`, inert and `aria-hidden` trees, closed dialogs and details, menus, listboxes, tooltips, closed popovers, disabled controls and `ignore` selectors are excluded. After the DOM, observations, screenshot and console are saved, and before the interaction probe, Chromium forces `:hover` on the nearest painted owner and its ancestors and reads the computed result. A finding needs a positive hidden-to-visible reveal and no painted, enabled, tap-focusable target in that owner (the card itself or a companion button) whose CSS `:focus`/`:focus-within` reveals it too. Keyboard focus on the invisible action does not count, because touch users cannot reach it. Hidden controls are never clicked, focused or hovered. The scope is CSS only; JavaScript tap handlers are not explored. At most 100 controls are diagnosed per tuple; the rest are reported as partial coverage. If forced states cannot be cleared, touch evidence is unavailable and the probe is skipped for that tuple. Desktop and Electron captures skip the check. Findings anchor on the visible owner and name the control in their verification params.

`liveness` samples dynamic text twice in a single ~1.5s window per tuple, before static observation and the screenshot:

```json
{ "checks": { "liveness": { "selectors": ["#published-countdown"], "auto": false } } }
```

`selectors` names exact targets, which can be split-digit markup or any text expected to change. `auto` (default `true`) also finds painted `[role="timer"]` elements and elements whose whole text is a countdown with three or more colon-separated fields (`01:23:45`, `0:00:00:00`); prose, dates and two-field times such as `10:30` are not matched. `{}` turns on automatic discovery only. A target whose numbers are all zero in both samples is reported as `idiom:liveness-all-zero`; any other identical pair is `idiom:liveness-unchanged`. Text that changed passes, including a timer that starts at zero and then begins counting. Opted-in timers are expected to update within the interval, so list finished or intentionally static timers, and minute-only counters, under `ignore`. Each tuple with the block pays the ~1.5s wait once, only when it has targets; captures without the block do not wait. Missing, invalid, detached, hidden or empty targets are reported as unavailable coverage, never as stalls. Both checks need fresh capture evidence: older captures, and captures taken with different `touchReachability` or `liveness` blocks, request recapture.

`media-fill` judges gallery thumbnails from the pixels actually captured. A frame is the visible box of an `img`, `iframe`, `video` or `canvas` at least 48×48 px, clipped by its nearest overflow-clipping ancestor inside the card; it belongs to a gallery when the card is one of three or more same-tag, same-class siblings, so a lone hero or brand tile is never sampled. At capture, each frame's edges are sampled from the screenshot: a row (or column) is solid when 98% of its samples are within `tolerance` of its commonest colour, and a band is the run of solid rows of one colour from an edge. A band counts only when its colour is the frame's backdrop (the media's own background or the nearest opaque background behind it), so a screenshot with white margins in a tinted frame is content, not a gap. Findings are one per gallery: an edge band at least `bandThreshold` deep, matching bands on opposite edges each at least half of it (letterboxing), or an entirely blank frame. They are `major` when at least three frames and half the gallery share the defect, otherwise `minor`.

```json
{ "checks": { "mediaFill": { "bandThreshold": 0.2, "tolerance": 8, "ignore": [".hero-art"] } } }
```

`bandThreshold` (default `0.2`, between 0 and 1) is applied when checks run, so changing it re-judges stored evidence without recapturing; `tolerance` (default `8`, 0–64 per channel) is a capture-time measurement parameter. `ignore` excludes media inside matching selectors, and `"auto": false` turns the check off. Images that had not loaded at capture and frames outside the screenshot are noted in coverage, not reported. Captures from earlier versions report the check as unavailable until recaptured.

`collection-actions` is advisory and does nothing until you declare the collections of user-created objects to judge; which actions a product needs is yours to decide:

```json
{ "checks": { "collections": [{ "selector": ".page-card", "name": "page" }, { "selector": ".project-row", "actions": ["open", "delete"] }] } }
```

`actions` defaults to all of `open`, `rename` and `delete`. For up to five rendered items per collection, capture records whether the item opens (it is or contains a link, is a button, is focusable, or has a pointer cursor), the names of every control inside it (hover-revealed ones included) and its menu triggers (`aria-haspopup="menu"`, or buttons named more, options, actions, menu or `⋯`). With `checks.probe` enabled, a read-only pass on the first rendered item opens each menu trigger and right-clicks the item, and records the names of the `[role=menuitem]` entries that appear; menu items are read, never clicked, so a destructive Delete entry is seen without being invoked. Menus that are not `role=menu` (plain popovers of buttons) are not read. Verbs match whole words: open, view or edit; rename or edit name/title/details; delete, remove, trash or discard. A missing verb is a `minor` finding whose explanation starts with "Heuristic:". When an item has a menu trigger the probe did not open, the check does not guess: it notes "menu trigger(s) not probed; enable checks.probe" in coverage instead. Selectors must be unique; invalid, unmatched or newly declared selectors are coverage notes.

`selected-state` compares the selected option's background, border, outline, box-shadow, text colour, weight and indicator elements against its siblings; `selectedState.minColorDelta` (default 24, on a 0–255 channel scale) is how far a colour must move to count as visible. Properties that already vary between unselected options, such as each swatch's own fill, are not used. `dialog-shell` judges only dialogs already open in the captured state; use states or steps to open the ones you want reviewed. Title sizes are compared with the other dialogs captured in the same run at the same viewport, not against a fixed scale. Captures from earlier versions report both checks as unavailable until recaptured.

Patterns are case-insensitive regular expressions and extend the built-in ones (undo/redo names, "unsaved", placeholder copy); selectors are resolved at capture time and stored with the observations. `disguisedControl.ignore` exempts a deliberate field-shaped trigger. Comboboxes, popup buttons (`aria-haspopup`) and launchers that show a keyboard shortcut (`⌘K`, a `<kbd>`) are never reported as disguised, and an ellipsis alone ("Save as…", "Loading…") is not placeholder copy.

`motion` records actual geometry/opacity animation during existing web steps (`click`, `fill`, `press`, `select`) and the opt-in interaction probe. The probe is on by default (as above). Semantic panels, drawers, menus, popovers and dialogs are recognized automatically; `checks.motion.selectors` adds custom surfaces. Tooltips are checked for observed duration and reduced motion, with no missing-transition warning for tiny tooltips. The defaults are `maxMs: 150`, `durations: []` (no discrete scale), `selectors: []`, and `minExtentPx: 24`. Beyond these surfaces, `motion` reads the action timelines for content that snaps: tab and segmented-control swaps, inline expand/collapse, list items added or removed, toasts and status messages, and client-side route changes (`idiom:motion-snap`). A snap is a visible change of at least `minExtentPx` pixels with no animation or transition on the changed element or an ancestor and no View Transition; text-only changes, focus rings and changes to the clicked control are ignored. Each surface and kind of change is one finding listing every action, and its fix names a transition from `durations` (else 150–250ms ease-out) and the property to animate. Durations use milliseconds; delays and disabled effects do not count. Findings name the surface, action, property and measured value. Progressive JavaScript motion avoids a snap finding but has unavailable duration assessment.

Choose the media preference in `.idiom/project.json` for each audit:

```json
{ "capture": { "reducedMotion": false } }
```

This normal-motion capture reports snapped surface toggles as major findings, and judges every content change directly. For a reduced-motion audit, use `"capture": { "reducedMotion": true }` (the default): actual running motion is major, and disabled transitions pass. Under reduced motion an instant change is correct, so in this default capture the probe replays each suspected content snap once under normal motion to confirm it (at most one replay per surface and kind of change, six per state); the replay is evidence only, and the reduced-motion audit is unchanged. Snaps are judged only from normal-motion windows. Web steps are judged in a `reducedMotion: false` capture, or when the probe confirmed the same surface; other unconfirmed changes are listed as not judged in coverage. Overlay surface snaps still need `reducedMotion: false`. Review with `idiom review <flow> --from <runId> --deterministic-only` uses the stored action evidence. Recapture older runs to enable this check. URL-only captures without probing and unsupported capture paths, including Electron, show unavailable coverage; incomplete windows explain their limitations and cannot establish a missing transition.

`mirrored-control` compares declared pairs per capture. Selectors are resolved at capture time; recapture after adding a pair. `axis` describes the mirror line: `vertical` (the default) means left/right panels, `horizontal` means top/bottom. Each panel is inferred as the outermost ancestor on the control's side; if either control has no such panel, distances are measured to the mirror axis through their nearest shared ancestor (or the viewport centre). A selector that matches nothing skips the pair with a coverage note. Kind and type comparisons exclude hidden graphics and clipped accessibility labels, and retain the computed font of visible text inside `display:contents` wrappers and literal `::before`/`::after` glyphs. Unsupported generated content (such as CSS counters) reports unavailable coverage for that pair; other configured pairs still run, with pair-specific coverage notes. Captures without this text/font evidence also show unavailable coverage and need recapturing.

`scale-conformance` judges each property and role against the scale you declare in `checks.scales`, or, where a list is empty, against what the run itself does most of the time. A declared scale reports every value off it, once per value with a count and examples, wherever it appears in the run. Without one, a value is reported only when at least three elements share a prevailing value that outnumbers everything else two to one, and the value is a sharp outlier from it: half or double a height or radius, square corners among rounded ones, a pill or an ellipse among rounded rectangles, or a neutral border colour far from the prevailing one. Products that are uniformly tight, or split between two sizes, are not judged. Roles come from the element: buttons, selects, text inputs and ARIA buttons/comboboxes/tabs/menu items are controls; `article` is a card; `dialog`, `aside` and menus/listboxes are panels; `hr`, `role="separator"` and elements drawn with a single thin border are dividers. Chips have no default. Selectors in `scales.roles` replace the default for their role; they are resolved at capture, so recapture after adding them. Radius `"full"` means a pill or circle (`9999px`, or `50%` on a square); `50%` on a rectangle is an ellipse and never matches `"full"`. Colours may be hex or `rgb()`/`rgba()` and match within a small tolerance after compositing over the element's background. Borders drawn in a control's own fill, and the borders of focused or selected controls, are not judged; nor, without a declared scale, are circular icon buttons or hued accent rules.

`control-anatomy` measures a chevron or icon against the control's single-line label (its text ink centre) when it has one, else against the box's vertical centre, and reports more than 1px. It covers selects (native, `role="combobox"`, and buttons with `aria-haspopup`), icon-only buttons and segmented-control members. A chevron may be an svg/img/icon element, a `▾`-style glyph, or a `background-image`, which capture measures from computed background geometry. Native selects that keep the browser's own chevron are skipped for offset and size; chevrons drawn with `::before`/`::after`, or backgrounds idiom cannot parse, are disclosed in coverage as unmeasured rather than guessed. Captures from earlier versions report the check as unavailable until recaptured.

`luminance-parity` needs both schemes in one run (`"colorSchemes": ["light", "dark"]`); with one scheme it still measures primary-action contrast and reports parity as unavailable. Background samples use hit-tested paint stacks, including sibling backdrops behind translucent surfaces. Elements are paired across the two captures by structural path, so a theme that renames classes still matches. A surface is reported when its background does not cross relative luminance 0.5 (moving at least 0.25) in the direction its nearest painted container does, and a strict majority of its nearest four comparable neighbours (same container, controls with controls, light-scheme luminance within 0.10) flip with the container; with no comparable neighbour it is not judged, so a deliberate accent or a light canvas region stays quiet. Each finding is reported once, on the scheme where the surface disagrees with its surroundings, with both captures as evidence. `luminanceParity.ignore` exempts intentional fixed-colour content (artwork, previews) from parity, never from contrast. Primary actions are form submit buttons, buttons and links marked `data-primary="true"` or `data-variant="primary"`, and anything matching `luminanceParity.primarySelectors`; disabled controls (including inherited fieldset disability) and icon-only actions are skipped. Every label colour (child spans, literal `::before`/`::after` text, a submit input's explicit or browser-provided default label) is measured against its composited background and must reach 4.5:1; this does not replace or suppress the axe-based `contrast` check.

`frame` runs only when `checks.frame.selector` is set. Capture samples each matched frame at 25%, 50% and 75% along every edge, just inside and just outside, and reads the real surround from the page's paint stack, including painted layers with `pointer-events: none` such as a canvas sibling (they are made hit-testable for one synchronous pass, then their exact inline styles are restored). An edge separates when the fill luminance differs by at least `minLuminanceDelta` (default 0.05, on the 0–1 relative-luminance scale), or a painted border or an unclipped shadow shows that much difference; one such edge is enough. Fill, border and shadow measurements retain element and ancestor opacity groups. Solid inset shadows contribute to sampled backgrounds and label contrast within their opacity groups. Solid shadow layers are composited in CSS order, including exposed portions of lower layers; unsupported blurred overlaps and unresolved outer-shadow occlusion are unavailable. Blurred, rounded or transformed inset-shadow geometry is unavailable. Outer shadows that may reach a sample from outside their owner's box (ink overflow the hit stack cannot see) make that frame surround or label backdrop unavailable unless an opaque layer above them covers the point; a 2D-transformed owner's reach maps its shadow offset and blur through the composed transform matrix (translations add nothing), while 3D transforms reach everywhere. Border cues are sampled at the border itself: a border clipped away (by `overflow` or `clip-path`) or painted over is unavailable rather than measured. Unsupported border colours, shaded styles (`inset`, `outset`, `groove`, `ridge`) and border images make the border assessment unavailable; independent measured fill or shadow cues still count. Unsupported pseudo-element decoration makes the affected frame unavailable. Occluded or unresolvable edges make the check unavailable rather than report an invisible frame, and edges outside the viewport are not judged.

Both checks use solid paint only: backgrounds composited through alpha and opacity, over the browser canvas. Non-default background clipping, gradients, background images, bitmap/replaced content (including canvas and SVG), filters and blend modes that reach a measurement are reported as unmeasured in coverage instead of guessed. Selectors are resolved at capture; captures from earlier versions report both checks as unavailable until recaptured.

`fresh-state` runs only on states marked `"fresh": true` — first load, no prior interaction — and reports its coverage as skipped elsewhere. Mark only states reached with no prior interaction; for Electron states, which run after earlier steps, `fresh` is your declaration, not something idiom can enforce:

```json
{ "id": "first-load", "description": "Editor opened cold", "url": "/editor", "expect": {}, "fresh": true }
```

### Layout invariants

Declare structural layout constraints in a flow's optional `invariants` array. Web and Electron states can add their own assertions:

```json
{
  "id": "studio-lab",
  "title": "Studio",
  "intent": ["Keep the editor chrome aligned."],
  "setup": [],
  "invariants": [
    { "name": "controls", "selector": ".ed-controls", "height": 64 },
    { "selector": ".panel", "width": { "min": 280, "max": 480 } },
    { "align": "bottom", "selectors": [".drawer-head", ".ed-controls", ".inspector-head"], "tolerance": 0 },
    { "edge": ".canvas:top", "equals": ".ed-controls:bottom", "offset": 16 }
  ],
  "states": [
    {
      "id": "editor",
      "description": "Editor with inspector",
      "url": "/editor",
      "expect": {},
      "invariants": [
        { "name": "inspector", "selector": ".inspector", "width": 320, "tolerance": 0.5, "optional": true }
      ]
    }
  ]
}
```

State assertions add to flow assertions; an empty state `invariants` array preserves the flow assertions. Route-generated states inherit the flow assertions too. Each assertion may have a `name`. Measurements use live border boxes in CSS pixels at every viewport and colour scheme, including hidden and offscreen matches. Dimensions check every match; alignment compares every matched edge and passes when the largest difference is within `tolerance`. Offsets require exactly one match per selector and mean `edge = equals + offset`; signed offsets and pseudo-classes such as `.canvas:not(.hidden):top` are supported. Edges must share an axis.

Dimensions accept exact nonnegative numbers or inclusive `{ "min": 280, "max": 480 }` ranges. `tolerance` defaults to zero and expands equality or range bounds in pixels. Missing selectors produce a distinct finding. `optional` defaults to false; setting it to true skips the whole assertion only when a required selector is absent. Present mismatches, ambiguous offsets and invalid CSS still fail.

Declarations and selector measurements are stored at capture time, so `idiom review studio-lab --from <runId> --deterministic-only` works without a browser and keeps the captured contract even after a flow edit. Unconfigured captures produce no layout findings. Legacy observations without invariant evidence still load and report this check's coverage as unavailable; recapture to measure the assertions.

A `group` invariant checks that a list only holds items that belong to it — a project's page switcher listing another project's pages. Name the list (`group`), the items inside it (`items`), and exactly one of `attribute` (compared exactly) or `text` (a regular expression; capture group 1, or the whole match without groups, is compared). Without `owner` the list element itself carries the expected value; with `owner` it comes from that selector, which must match exactly one element:

```json
"invariants": [
  { "name": "page switcher", "group": ".page-switcher", "items": ".page-link", "attribute": "data-project-id" },
  { "group": ".page-switcher", "items": "a", "owner": ".project-title", "text": "^(\\S+)" }
]
```

Every matched list is judged on its own and `items` is scoped to it; hidden items count, since a closed switcher still holds its stray pages. An item with no value (attribute missing, pattern not matched) is a stray, and an owner with no value is its own finding rather than a pass. Each polluted list is one `group-invariants` finding naming the stray items. Values are stored at capture time, so `--from <runId> --deterministic-only` re-judges them offline; earlier captures report the check as unavailable.

### Probe

The interaction probe is on by default for web flows, and it clicks things. Turn it off with `"checks": { "probe": { "enabled": false } }`, or per state with `"probe": false`. It runs at each state’s designated coordinate in a disposable context, using the flow assignment and restore ladder described above, never clicks controls whose names look destructive (delete, publish, sign out, pay, …) or match `probe.skip`, and records each control's observable effect. To probe only some states, set `checks.probe.enabled: false` and give those states `"probe": true`.

Set `checks.probe.respectControlIntent` to `true` to skip already-selected options and drag handles (dogfooding request #54). It defaults to `false` and has no effect when probing is off. Omitted or false preserves legacy probe behavior.

With this setting, controls with `aria-pressed`, `aria-selected` or `aria-checked` equal to `"true"`, a meaningful `aria-current`, or a checked native radio are recorded with an `already selected: …` skip reason before hover or click. Empty `aria-current` and `aria-current="false"` mean no current item. Drag handles are recorded with a `drag handle: …` reason when `draggable="true"`, their `aria-roledescription` contains “drag”, or their name contains the whole word move, drag or reorder. These records retain the control's name, selector and region, including menu items; the probe does not first select a sibling. Checked radios and selected tab/radio role elements receive explicit skip records without expanding probing to unselected inputs or links.

The same option records real `filechooser` events and supported native picker activation as `filechooser`/`picker` effects. No file selection or value change is required, and no files are supplied. Successful native `showPicker()` calls and uncanceled, enabled color-input activation count; canceled clicks, disabled inputs, unsupported text inputs, range inputs with datalist ticks, listbox selects (`multiple` or `size` greater than 1), and inert picker-named buttons receive no picker exemption. Single-select dropdowns with omitted `size` or `size="1"` remain eligible. Opened non-file pickers are dismissed with Escape after recording. These effects prevent dead-control findings and count as primary actions rather than duplicate focus destinations. Recapture after enabling the option: offline review honors recorded skips/effects regardless of current settings, while older captures still load with their original evidence.

## Rules

The optional `.idiom/rules.json` is strict and versioned. Missing means the empty default `{ "version": 1, "overrides": [] }`; a present unreadable, malformed, or invalid file fails validation and review. Each ordered override has a unique `id`, a nonempty conjunctive `match` using `fingerprint`, `category`, `flow`, `state`, and/or `rule`, exactly one `action` (`suppress` or `severity`), and a nonblank `reason`. A severity action also requires `severity`; suppress actions forbid it. Suppression always wins, while the last matching severity override supplies the effective severity.

## Baselines

Configure a project-relative or absolute local directory in `.idiom/project.json` if needed:

```json
{
  "baselines": { "directory": ".idiom/baselines" }
}
```

## Coverage

Leave internal fixtures and frozen prototypes out with `coverage.exclude` in `.idiom/project.json`:

```json
{ "coverage": { "exclude": ["/lab/**", "apps/web/**"] } }
```

A glob starting with `/` matches the route; any other matches the project-relative source file. `**` crosses path segments, `*` and `?` stay within one, everything else is literal (so `/p/[id]` names that dynamic route), and a trailing `/**` also matches its base (`/lab/**` matches `/lab`). Source globs exclude only that source, so a route another app also serves stays listed. The header says how many routes were excluded (`6 found, 3 excluded (coverage.exclude), …`), and `--json` lists them under `excluded`. With `--crawl`, sources are URLs, so only route globs apply.

## Autobuild

Add the command under the existing `[commands]` table, append `"idiom-check"` to the existing `[verify].steps` array, and add the verify table:

```toml
[commands]
idiom-check = "idiom check studio-lab --since-baseline --fail-on major"

[verify.idiom-check]
kind = "check"
command = "idiom-check"
```

## GitHub Action

Copy this into `.github/workflows/idiom.yml`, changing `studio-lab` and the setup command for your app:

```yaml
name: Idiom
on: pull_request
permissions:
  contents: read
  pull-requests: write
concurrency:
  group: idiom-${{ github.event.pull_request.number }}
  cancel-in-progress: true
jobs:
  regression:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
        with:
          ref: ${{ github.event.pull_request.head.sha }}
          fetch-depth: 0
          persist-credentials: false
      - uses: mattskilly/idiom@main
        with:
          flow: studio-lab
          project: .
          setup-command: npm ci
          fail-on: major
          version: latest
```

The root `action.yml` installs the published `@mattskilly/idiom` CLI and its matching Chromium, captures the actual PR merge base and head in separate worktrees, forces a private merge-base baseline even when head contains a newer accepted record, and runs `idiom compare` for before/after evidence. A flow missing at the merge base fails explicitly. The caller checkout is preserved. Only the check's new deterministic findings decide the severity gate; pixel changes supply evidence.

`@main` is a moving example; pin a released tag containing this Action or an immutable public snapshot commit for stable consumption. Set `version` to a matching published npm version containing `--baseline-file` and baseline `--out`; the original 0.8.0 package predates these options. Release the Action snapshot and compatible npm package together using [the release procedure](releases.md).

`project` names a directory beneath the repo root, for example `apps/web`. `setup-command` is an explicit shell script run independently at each revision's repository root. It defaults to `npm ci`. For Bun or pnpm, install that runtime in a preceding workflow step and set the command to `bun install --frozen-lockfile` or `pnpm install --frozen-lockfile`. Commit the app's `.idiom` config and flow at both revisions. The Action supplies Node 24; it does not install your app's other package manager.

One marked bot comment is created or updated on reruns, including clean results. It lists new/fixed/pre-existing counts, finding problems and fixes, crop filenames, and changed-tuple composite filenames with artifact download links. Download the GitHub artifact and open `index.html` to see the actual images. Artifacts require GitHub login and expire after 14 days (or earlier removal/repository policy); artifact URLs are downloads, not inline image hosts. Evidence stays on GitHub. The same report appears in the job summary, including unavailable/one-sided evidence disclosures.

`fail-on` accepts `blocker`, `major` (default), `minor` or `never`. Operational failures still fail with `never`. Upload and comment publication precede the final gate. Fork PR tokens can be read-only: unavailable comments produce a warning while artifacts, the job summary and finding gate remain. Ordinary writable-token publication errors fail the action. Keep this on `pull_request`; do not run untrusted PR setup via `pull_request_target`. Outputs are `baseline-sha`, `new-findings` and `artifact-url`.


## Design comparison

See the [design comparison guide](design-compare.md) for source setup, auth,
matching and a worked example. This section defines the settings contract.

Authored web and Electron states may declare `"design": "designs/checkout.html"`,
an HTTP(S) HTML URL, a local design image (`"design": "designs/checkout.png"`), a
live reference site (`"design": { "site": "https://example.com/checkout" }`), or a
[Figma frame URL](#figma-frames). A declaration may also be an object, or an array
of either form, to compare several references:

```json
"design": [
  { "source": "https://www.figma.com/design/AbC123/Checkout?node-id=12-34", "name": "figma", "viewport": "mobile" },
  { "source": "designs/checkout.html", "name": "prototype" }
]
```

An object has either `source` (any string form above) or `site`, plus the optional
fields. `name` is a lowercase slug (default `figma` for Figma URLs, `site` for a live
site, otherwise `design`, de-duplicated as `-2`, `-3`); explicit names must be unique. `viewport` must name a
project viewport, and `colorScheme` (`light`/`dark`) limits a reference to one
scheme. With one reference the run layout is unchanged (`design/` beside the
tuple); with several, each reference is saved under `design/<name>/`. Where two
element references disagree on a matched element, the check reports a design decision for
a person to settle with `idiom decide --choose` instead of drift against either;
image references report their changed regions independently. A state reached `from` another state keeps its own design;
it does not inherit the ancestor's screen. Toggle expansions retain the base state's
design. States without a declaration retain their existing behaviour.

`checks.designDrift` is strict and optional; comparison is enabled by default for
captured declarations. Example:

```json
{
  "checks": {
    "designDrift": {
      "tolerance": { "ratio": 0.15, "px": 1, "mode": "tighter" },
      "gap": { "px": 2 },
      "fontWeight": 100,
      "color": 2
    }
  }
}
```

Numeric policies `size`, `position`, `gap`, `radius`, `borderWidth`, `fontSize` and
`lineHeight` override the common `tolerance`. An omitted or empty override inherits
the common policy, including its mode. The default is the component-size policy:
ratio 0.15, px 1, tighter. `tighter` allows `min(abs(design) * ratio, px)`;
`looser` allows the maximum. All distances and sizes use CSS pixels. Position uses
the reference child's width/height as the tolerance basis and measures offsets
from corresponding matched parents, so translating a whole subtree does not create
child-position drift. Gaps are actual edge-to-edge distances between corresponding
adjacent matched siblings, rather than only the authored CSS `gap`.

A difference must be strictly greater than its allowance. At radius 8 the default
allowance is 1px: 9px passes, 9.01px reports. Zero is a real reference value and
gets a zero allowance under tighter mode. `fontWeight` is an absolute weight-unit
threshold (default 0); `color` is the maximum per-channel RGBA delta on a 0–255 scale
(alpha scaled to 255, default 0). Font-family lists ignore quoting/case and text
ignores whitespace runs. Families, border styles and text compare discretely.
`normal` line height and unknown colour forms remain literal rather than becoming
zero/black. `enabled: false` skips comparison and prevents verification of existing
design findings.

Measured drift is minor unless an explicitly declared scale step is crossed.
For `checks.scales.radius.card: [4, 8, 12, 16]`, a marked card changing from 8 to
12 is major, but 8 to 11 is minor. Control heights use `controlHeights`, and
positions/gaps use declared `spacing` (including `multipleOf`). `full` is the
reference element's pill/circle radius. No scale is inferred from the screenshot.
Copy and extras remain minor. Missing controls, headings, main content and its
illustrations are major; an unmatched subtree may summarize its descendants with
the highest missing-content severity.

### Image references

A local `.png`, `.jpg`/`.jpeg` or `.webp` file (a screenshot or exported frame) is
an image reference. The file's leading bytes must match its extension; GIF, SVG and
remote image URLs are rejected (download the image and reference the file). The
browser scales the image to the app tuple's viewport width and captures it as tall
as it scales, so a 2× export compares like a 1× one. Both sides are then reduced to
one pixel per CSS px, and the design is aligned vertically: the offset search covers
±240 CSS px beyond the height difference, scores every app row, and prefers the
smallest offset on ties.

The aligned images are compared on a 4 CSS px cell grid with a perceptual (YIQ)
colour delta. A cell changes above a normalised delta of 0.012. Faint components
(mean delta below 0.024) are treated as resampling noise. The rest are grouped by
the smallest visible app element that contains them, and groups with fewer than
two changed cells are dropped. Overlapping groups merge, and up to 20 regions are
kept, largest first. Each region is a **minor** `design-drift` finding with a paired
Design / App capture crop and the app elements it covers. Regions are evidence for
judgment, not a pixel-exact gate. Rows with no counterpart on the other side
(an app taller than the design, say) are reported as uncompared bands, not regions.
The saved `design/regions.json` is recomputed from the saved screenshots on every
load, so replay and verification fail closed when it is tampered with or stale.

When a model provider is configured, the critique also receives each aligned
design image and its regions. It may report `design-drift` findings that name the
element and describe the visible difference. Such a finding cites the app
screenshot and the design image label `<state>/<viewport>/design`. Without a model,
only the region findings are reported. Verification of a region finding requires
the same design image bytes in the baseline and both current captures.

### Live-site references

`{ "site": "https://example.com/pricing" }` uses a live page as the intended design
("make staging match production"). The URL is used literally, with no origin or path
joining. It must be an absolute HTTP(S) URL without credentials. Idiom captures it
with the same engine, viewport and colour scheme as the app tuple, and waits the
state's `settleMs`. It then runs the full element comparison described above. A
response that is not 2xx HTML, or a page that looks like a sign-in or access wall,
fails the design capture with a remedy instead of being compared.

### Figma frames

A Figma design is a frame URL with `node-id`
(`https://www.figma.com/design/<file>/<name>?node-id=12-34`; `/file/`, `/proto/`
and `/branch/<key>/` URLs also work, and `version-id=` pins a version). Idiom
reads it through the Figma REST API with a personal access token in
`FIGMA_TOKEN`: in Figma, account menu → Settings → Security → Personal access
tokens → Generate new token, with the `file_content:read` scope (add
`file_variables:read` to resolve variable names). The token is sent only as the
`X-Figma-Token` header and never written to errors, provenance or cache files.

The first fetch stores the node tree, a 2× PNG render, variables (when available)
and `meta.json` under `.idiom/designs/figma/<file>/<node>/<version>/`, with
`current.json` naming the version in use. The cache is pinned: later captures
reuse it with no network and no token until `--refresh-design` refetches. Commit
`.idiom/designs/` so CI and verify compare against the same frame without a
token. The file version, frame link and variable status are recorded in the
design descriptor and shown in reports.

The frame is normalised into the same element model as an HTML capture: bounds
relative to the frame, auto-layout padding and item spacing (measured as
positions and gaps, as for HTML), corner radii, solid strokes as borders, solid
fills, text styles, and bound variable names. A frame or instance holding one
text layer is compared as one element owning that text (a button and its label).
Hidden, zero-opacity and zero-area layers, slices, stickies and connectors are
skipped. Layer names other than Figma's automatic ones (`Frame 12`, `Rectangle 3`)
match an app element's `data-idiom-name` or accessible name; names containing
button/btn/cta, link, or input/field/textbox are treated as those controls. An
app `data-node-id` that looks like a Figma node id (`12:34`) pins the match to
that node; any other `data-node-id` is the app's own vocabulary and never blocks
a match. Findings cite the Figma layer path, link to the node and name the bound
variable.

A Figma reference applies at one viewport: the declared `viewport`, otherwise the
project viewport nearest the frame's width (the earlier one on a tie), and in the
declared `colorScheme`, otherwise `capture.colorScheme`. The page roots span the
viewport and their width and height are not compared (a frame's height is an
artboard size), though the page background is. Layers keep their frame-relative
bounds, so a layout centred in a 375px frame shown at a 390px viewport reports
half the difference as horizontal position drift; declare `viewport` when no
project viewport is close. Figma's frame fill is compared with the app `body`
background, so an app that paints its background on `html` instead reports it.
Strokes compare as borders of the same width whatever their alignment; an
outside stroke's geometry difference appears as size drift. Font families
compare Figma's single family with the first family in the app's stack.

Variable names come from Figma's variables endpoint, which only Enterprise plans
expose. Elsewhere the comparison still runs and provenance records
`variables: "unavailable: …"`.

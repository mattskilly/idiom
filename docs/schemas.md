# Record schemas

Idiom persists project and flow configuration, managed references, findings,
unruled decisions, stable name registries, finding decisions, and recorded
design rulings. Zod schemas in `src/schemas/` and the strict ruling-block parser
are the contracts below. How they flow through the system is described in
[architecture.md](architecture.md).

## 1. Project — `.idiom/project.json`

```ts
const Project = z.object({
  version: z.literal(1),
  app: z.object({ name: z.string(), framework: z.enum(["nextjs", "other"]) }),
  server: z.object({
    build: z.string(),            // "bun run --cwd apps/web build"
    start: z.string(),            // "bun run --cwd apps/web start" (env merged from flow)
    readyUrl: z.string(),         // "http://127.0.0.1:3107/"
    port: z.number(),             // 3107
    fixedPort: z.boolean().optional(), // true keeps the configured port and environment
    env: z.record(z.string(), z.string()),    // { BOOKING_DATABASE_URL: "", BOOKING_DEMO_CALENDAR: "1", PORT: "3107", ... }
    startupTimeoutMs: z.number().default(60_000),
  }),
  viewports: z.array(z.object({ name: z.string(), width: z.number(), height: z.number() }))
    .default([
      { name: "desktop", width: 1440, height: 900 },
      { name: "mobile", width: 390, height: 844 },
    ]),
  surfaces: z.array(z.object({
    id: z.string().trim().min(1),
    name: z.string().trim().min(1),
  }).strict()).default([]),              // ordered; ids unique
  colorSchemes: z.array(z.enum(["light", "dark"])).min(1).optional(),
  capture: z.object({
    timezoneId: z.string().default("America/New_York"),
    locale: z.string().default("en-US"),
    colorScheme: z.enum(["light", "dark"]).default("light"),
    colorSchemeAttribute: z.string().optional(), // e.g. "data-theme"
    reducedMotion: z.boolean().default(true),
    hideWebdriver: z.boolean().optional(), // navigator.webdriver reads false; flows may override
    fullPage: z.boolean().default(true),
    settleMs: z.number().default(250),
    hostPressureThreshold: z.number().finite().positive().optional(), // effective default 1.5
    maxFullPageHeight: z.number().int().positive().optional(), // CSS px, default 16000
    animationSettleMs: z.number().finite().nonnegative().default(1500),
    maxMinutes: z.number().finite().positive().default(30),
    concurrency: z.number().int().min(1).max(8).default(4), // capture lanes at once
  }),
  design: z.object({
    tokensFile: z.string().optional(),   // "packages/design/src/theme.css"
    tokens: z.array(z.object({
      name: z.string().min(1),
      value: z.string().min(1),          // authored CSS string / alias
      kind: z.enum(["color", "spacing", "radius", "control-height", "other"]),
      source: z.object({ path: z.string(), key: z.string().min(1) }).strict(),
      theme: z.string().optional(),    // literal data-theme identity
    }).strict()).optional(),           // unique source path/key/theme identities
    productFile: z.string().default("PRODUCT.md"),
    designFile: z.string().default("DESIGN.md"),
  }),
  baselines: z.object({
    directory: z.string().min(1).optional(),
    ignoreDirty: z.array(z.string()).optional(), // validated repository-root globs; see Baselines
  }).strict().optional(),
  brief: z.object({                      // optional; read only by idiom brief
    $comment: z.string().optional(),
    ticketTemplate: z.object({
      sections: z.array(z.object({
        heading: z.string().trim().min(1).max(80),
        content: z.enum(["decision", "options", "criteria", "outOfScope", "evidence", "references", "text"]),
        body: z.string().trim().min(1).optional(), // required iff content is "text"
      }).strict()).min(1),                // decision, criteria, evidence exactly once each
    }).strict().optional(),
    references: z.array(z.object({
      name: z.string().trim().min(1),
      tier: z.string().regex(/^[a-z][a-z0-9-]*$/), // bar | always | floor
      note: z.string().trim().min(1),
      url: z.string().url().optional(),
    }).strict()).default([]),
    researchBudgetMs: z.number().int().min(60_000).max(3_600_000).optional(), // default 900000
    researchMaxSearches: z.number().int().min(1).max(20).optional(),          // default 5, per question
  }).strict().optional(),
  model: z.object({
    provider: z.enum(["claude-code", "anthropic", "codex"]),
    model: z.string(),                   // model id passed to the selected provider
    maxFindings: z.number().int().min(1).max(5).default(5),
    fallback: z.object({                 // optional; must differ from provider
      provider: z.enum(["claude-code", "anthropic", "codex"]),
      model: z.string().trim().min(1),
    }).strict().optional(),
  }),
})
```

Notes:

- `server.port` — the template port. Web captures reserve a free port by default, substitute it in server commands, environment values, ready and state URLs, and pass it as `PORT` to build and start. `--port` overrides `IDIOM_PORT`; `server.fixedPort: true` preserves the configured port without injecting `PORT` and rejects conflicting overrides. Any process already answering at the selected ready URL prevents startup.
- `server.env` — the always-on environment for capture servers. For the booking example this is where `BOOKING_DATABASE_URL` is pinned to the empty string so an inherited hosted-Postgres URL can never leak into a capture session.
- `surfaces` — the ordered project-wide surface inventory. Empty preserves the
  legacy named-flow path and does not require flow mappings. Once nonempty,
  every flow must name a declared surface; review reads all manifests before
  capture so malformed or missing associations cannot understate coverage.
- Optional `capture.hostPressureThreshold` is a finite positive load/core ratio (default 1.5); either start/end 1-minute load must strictly exceed it. A successful end ready-URL measurement over 10 times the successful start also establishes pressure. Unsupported/failed measurements remain null.
- Optional `capture.maxFullPageHeight` is a positive integer CSS height (default 16000). Optional state `screenshotTimeoutMs` is a positive integer millisecond allowance (default 30000) for web and Electron screenshots, shared across tiles. Screenshot geometry optionally records `croppedFromHeight > height`; drift compares the original full-page size.
- Version-1 `run.json` optionally records `host` (`loadStart`/`loadEnd`: three nonnegative averages or null; positive `coreCount`/`threshold`; positive `readyStartMs`/`readyEndMs` or null; `pressureReasons`: `load` and/or `ready-url-slowdown`), `retryCount`, `retries`, and `deferredTuples`. Retry entries carry a selected coordinate, `phase` (`capture`/`probe`), `firstTimeout` (`kind`: `navigation`/`readiness`, positive `timeoutMs`), `doubledDeadlineMs`, and `outcome` (`passed`/`timed-out`/`failed`). Coordinates are unique, retry counts agree, and deferrals require pressure plus an exhausted capture retry. Tuple failure metadata optionally carries the same typed `timeout` diagnostic. Probe artifacts optionally carry `stateReachTimeout` when replay failed but saved base evidence survived. Old records without these fields remain valid.
- `capture.*` — determinism pins applied to every browser context. `settleMs` is the post-navigation wait before the screenshot.
- `colorSchemes` — the ordered, unique capture axis. When absent, it normalizes to `[capture.colorScheme]`; an explicit list must retain that legacy scalar. `capture.colorSchemeAttribute`, when present, must be an HTML-safe attribute name and receives the selected scheme before application scripts execute.
- `design.tokensFile` — ground truth for the `token-drift` check; optional because not every target has one.
- `design.tokens` — optional typed inline declarations, normally proposed by `idiom system --learn` and saved only on confirmation. Source paths must be project-relative and cannot escape the project. Original names are presentation identities, including dotted DTCG paths; they are never blindly emitted as CSS custom-property names. `other` is display-only. File tokens and inline tokens are merged by source/key/theme identity, retaining inline settings when an identity is already configured.
- `checks.scales.spacing` — defaults to `[]`; entries are nonnegative finite CSS-pixel numbers or strict `{multipleOf: positiveFiniteNumber}` base steps (v4 `--spacing`). Declared values check visible V2 elements' authored computed padding, margin magnitudes and gap axes with 0.5px tolerance; zero/default/auto/normal and unsupported percentages are excluded. Historical observations without authorship facts disclose missing coverage. This does not change geometric `spacing-rhythm` inference.
- Confirmed imports union values into existing control heights, role radii and border lists. Theme variants retain their context in tokens; numeric scales contain the union. Rem conversions use recorded root sizes, or an explicitly disclosed 16px assumption without evidence; incompatible root conversions are omitted from numeric scales. Source dimension purpose mappings are inferred from spacing/space/gap/padding/margin, radius/radii and explicit control/button/input height names, never guessed from DTCG value shape.
- V2 `observations.json` optionally records positive finite `rootFontSize`, literal `theme`, and configured tokens' `typedValues` (`kind`, normalized `value`, optional `name`/`theme`). Configured tokens optionally record `contexts` (at most 16): each subtree whose computed `color-scheme` or referenced app custom properties differ from the body's and change a resolved colour, with its `colorScheme`, measured `usedScheme` (`light` | `dark`), the referenced properties' `environment`, colour `normalizedValues`, and `typedValues` when the root has them. `contextProperties` lists those referenced property names, and an element in such a subtree carries `tokenContext`, its index into `contexts`; token-drift judges its colours (not radii) against that context. Both are absent when no subtree differs. Old artifacts remain valid, with historical untyped token behavior and explicit missing rem coverage. Spacing-only inline tokens are valid. Recapture to enforce newly learned token rules. The system page's drift is value coverage within one selected run, not proof of variable references or project-wide unused code.
- V2 element `styles` optionally record computed `userSelect`, and `attributes` may include `inert`; `dead-affordance` uses both to recognise non-interactive illustration frames. Older artifacts without them stay valid and get no `user-select` exemption.
- Every newly observed element records `painted: { value: true }` or `{ value: false, reason, boundary? }`. Both V1 and V2 accept the optional fact. Missing facts preserve historical offline review behavior; they are never reconstructed from old styles. False reasons include `display-none`, `visibility-hidden`, `visibility-collapse`, `content-visibility-hidden`, `closed-details`, `opacity-0`, `zero-area` and `clipped-by <selector>`. `boundary` names the causal element. Eligibility includes below-fold content and partial clips, without hit testing, viewport intersection or `aria-hidden` exclusion. A closed details element and its first direct summary subtree remain eligible; other descendants do not.
- Element `spacingExcluded?: string` marks an element inside a closed `<details>` (outside its first summary) or a `hidden`, `inert` or `content-visibility: hidden` subtree (`closed-details`, `hidden`, `inert`, `content-visibility-hidden`). Spacing and gap rules (`field-group`, `spacing-rhythm`, `scale-conformance` spacing, `adjacent-gap`) skip it, and newer captures form no field groups from it. Older captures omit it.
- Element `paintedContent?: { selectors, width, height, clipped? }` retains contributor identities and the content extent without wholly unpainted descendants, separately from raw scroll measurements. `clipped: { text, interactive, marquee }` lists up to ten selectors each: painted text and controls partly cut off by the box (excluding `aria-hidden`/`inert` subtrees and content a nearer scroller owns), and the marquee tracks whose cut-off content was excluded. Older captures omit it. Selection members may carry `paintedDecoration` and `decorationOwners` alongside their unchanged raw `decoration`. These additive fields let offline rules filter contributors without changing document overflow or selection-validity checks.
- Check coverage may include `paintedSkipped: Record<string, number>`, keyed by full rule id. Counts are distinct rejected element selectors in that rule's input domain for that tuple, including zero when it ran on new evidence. Older evidence omits the field. Reasons and unavailable/skipped statuses are retained. JSON, Markdown and HTML reports expose these counts. Coverage may also include `inkSkipped: Record<string, number>`, keyed by full rule id: records dropped because the stored screenshot shows no ink where they were measured (currently `idiom:orphan-word`), present only when nonzero. Review/check JSON and MCP quick/check responses add `checkCoverage`, a coordinate-labelled array of check coverage records (without the DOM/observation payload), when painted or ink counts exist; legacy responses omit that field.
- V2 `observations.json` optionally records craft-rule evidence: `fonts` (declared faces with status and stylesheet URLs, the families visible text uses with up to five selectors and a fallback flag, and failed font requests), `links` (visible http(s) links with absolute href, same-origin flag and the run's check result: `ok`, `broken` with code or DNS reason, or `unchecked` with a reason), `focusVisible` (each keyboard focus stop with the `node.property` keys that changed and an optional visible `proxy`), `lineLengths` (paragraphs over 45 rendered characters per line), `orphanWords` (headings and button labels whose last line holds one word; newer captures add optional `rect`, the union of the owner's measured painted word rects, `lastLine`, the stranded word's rect, both viewport-relative like element rects, and `ink`, `{status: "measured", share}` with share in [0, 1] of sampled screenshot pixels under `lastLine` that differ from their modal colour, or `{status: "unavailable", reason}`), `imageRenders` (broken images and `fill` images rendered off their natural ratio) and `layoutShift` (largest session-window score and up to 150 entries with source selectors). Scans use the `{status, reason?, records}` shape; older artifacts without these fields stay valid and the checks report unavailable coverage.
- V2 `observations.json` optionally records `screenshot`: how the tuple screenshot was taken (`strategy` `viewport` | `full-page` | `tiled`, positive device `scale`, CSS `width`/`height`, `tiles` only when tiled) and, only when the full-page size changed between the start of observing and the screenshot, `drift` (`observed` and `captured` sizes) with `rects`, each observed selector's rect re-measured at screenshot time. Crops use `scale` and prefer `rects` over the observed element rect. `metadata.json` mirrors everything but `rects`. Older artifacts without it stay valid and crop as before.
- Version-1 `run.json` optionally records the run's lifecycle: `status` (`running`, `complete` or `interrupted`), `runId`, `owner` (`pid` and, when available, the process `start` time; never its command line or environment), `startedAt`, `updatedAt`, `endedAt`, `completedTuples` (selected coordinates whose evidence is saved, unique, in selected order) and `interruption` (`reason`: `signal`, `process-gone` or `capture-failed`; `signal`: `SIGINT`/`SIGTERM`). A run writes `running` in its first second, adds each finished tuple to `completedTuples`, and writes `complete` (with every selected coordinate in `completedTuples`) as the very last step of publication. Completed is not successful: a tuple whose capture failed is still completed. Readers consume only `complete` runs; a record without `status` is a legacy completed run. `running` and `interrupted` runs are unverified evidence. Older records without these fields remain valid.
- `baselines.ignoreDirty` — optional repository-root globs for safe dirty-path exclusions; syntax and static build-input validation are described under [Baselines](configuration.md#baselines). No exclusions are added by default. `run.json` and tuple `source` objects optionally carry `ignoredDirtyPaths: string[]` and `changedDuringCapture: boolean`; legacy version-1 records need neither field.
- `baselines.directory` — optional project-relative or absolute local directory for compact finding baselines; defaults to `.idiom/baselines`. This location is not part of the checks hash.
- `model.provider` — `claude-code` is the scaffold default and uses the authenticated local CLI without an API key. `anthropic` is the explicit direct-API path and requires `ANTHROPIC_API_KEY`; it sends no `thinking` setting and caps output at 16,000 tokens, so pick a model whose thinking is off by default. A response cut off at that limit is reported as truncation, not malformed output. `codex` uses the authenticated local Codex CLI. Existing files are not migrated or reinterpreted.
- `model.fallback` — optional `{provider, model}` used, visibly, only when the primary provider fails; it must name a different provider. Review, sweep and configured page review honor it; `idiom explore` does not, and explore rejects `codex` as its provider.
- `model.maxFindings` — an integer from 1 through 5 and the material-findings cap across both evaluation layers. There is no overall score field anywhere, by design.

### Capture URL metadata

Web tuple `metadata.json` records the actual served origin in `url.origin`. Literal URLs use `{ kind: "literal", origin, url }`; setup-derived URLs use `{ kind: "setup-stdout", origin, source, pattern, append, template }`, with private seed values replaced by a stable template. Both kinds optionally carry `canonicalOrigin: string` when the served origin differs from the configured one. Derived console, DOM, axe and observation evidence uses the configured origin to keep finding identity stable. Offline review applies the same origin mapping to its document URL, preserving expected-status console suppression. Older records without `canonicalOrigin` retain their original URL interpretation.

Web `console.jsonl` records produced by a browser resource load carry `request: { resourceType, mainFrame }`, where `resourceType` uses Playwright's vocabulary (`document`, `script`, `image`, …) and `mainFrame` says whether the request came from the top-level frame. Script-originated records have no `request`. When capture recorded this provenance, `metadata.json` sets `consoleProvenance: true`, and expected-status suppression applies only to the record whose request is the main-frame document; a matching record without provenance is reported. Older artifacts and Electron tuples have no flag and keep the previous suppression by URL, status and message. The request also carries `method`, `url` (secret-named query values replaced with `[redacted]`, fragment dropped), `status` when a response arrived, and `at`/`endAt`, the epoch milliseconds the request started and its response ended.

A record for a Content Security Policy violation carries `csp: { directive, violatedDirective, blocked, element?, frame?, sample?, sourceFile?, lineNumber?, columnNumber?, documentUrl }`, where `blocked` is `inline`, `eval` or the blocked URL, `element` is the offending element's selector in its frame and `frame` the owner iframe's selector. A violation with no matching console line is recorded as `{ type: "error", text: "Content Security Policy violation", csp }`.

When Idiom started the application server, the run directory holds `server.log`: one line per server output line, `<ISO time> <stdout|stderr> <text>`, redacted and capped at 2 MB.

## 2. Flow manifest — `.idiom/flows/<id>.json`

```ts
const SharedFlow = {
  id: z.string(),                        // "booking"
  surface: z.string().trim().min(1).optional(), // declared project surface id
  title: z.string(),
  intent: z.array(z.string()),           // checkable product-intent sentences
  setup: z.array(z.object({              // sequential; each must exit 0 and fully terminate
    run: z.string(),
    cwd: z.string().optional(),
    env: z.record(z.string(), z.string()).optional(),
    captureStdout: z.boolean().default(false),  // makes setup stdout available to urlFrom
  })),
  viewports: z.array(z.string()).optional(),
  colorSchemes: z.array(z.enum(["light", "dark"])).min(1).optional(),
  hideWebdriver: z.boolean().optional(), // overrides capture.hideWebdriver
  explicitDismiss: z.array(z.string().trim().min(1)).optional(), // modals the dismissal probe does not click outside
}

const WebFlow = z.object({
  ...SharedFlow,
  // Web flows only: published flows may also name viewports by width.
  viewports: z.array(z.union([z.string(), z.number().int().positive()])).optional(),
  kind: z.enum(["app", "published"]).optional(),       // default "app"
  pages: z.array(z.string()).min(1).optional(),        // requires kind "published"
  budget: z.object({ maxDiffRatio: z.number().min(0).max(1) }).optional(),
  target: z.object({ kind: z.literal("web") }).default({ kind: "web" }),
  states: z.array(z.object({
    id: z.string(),
    description: z.string(),
    url: z.string().optional(),          // literal path, OR:
    urlFrom: z.object({
      source: z.literal("setup-stdout"),
      pattern: z.string(),               // regex with exactly one capture group
      append: z.string().optional(),     // query suffix, e.g. "?tz=America/New_York"
    }).optional(),
    expect: z.object({
      status: z.number().default(200),
      path: z.string().regex(/^\/[^\s?#]*$/).optional(), // settled web destination pathname
      textPresent: z.array(z.string()).default([]),
      selectorPresent: z.array(z.string()).default([]),
      selectorAbsent: z.array(z.string()).default([]),
    }),
    mask: z.array(z.string()).default([]),  // CSS selectors for volatile regions
    settleMs: z.number().optional(),
    loading: z.boolean().optional(), // true declares intentional loading
    loadingSettleMs: z.number().int().positive().optional(), // default 5000 ms after ready
    screenshotTimeoutMs: z.number().int().positive().optional(), // ms, default 30000
  })),
})

const ElectronFlow = z.object({
  ...SharedFlow,
  target: z.object({
    kind: z.literal("electron"),
    launch: z.object({
      executablePath: z.string().trim().min(1),
      args: z.array(z.string()).default([]),
      cwd: z.string().optional(),
      env: z.record(z.string(), z.string()).default({}),
      timeoutMs: z.number().positive().default(30000),
    }),
    window: z.object({
      title: z.string().trim().min(1),       // exact, unique renderer title
      timeoutMs: z.number().positive().default(10000),
    }),
  }),
  states: z.array(z.object({
    id: z.string(),
    description: z.string(),
    steps: z.array(z.discriminatedUnion("action", [
      z.object({ action: z.literal("click"), selector: z.string() }),
      z.object({ action: z.literal("fill"), selector: z.string(), value: z.string() }),
      z.object({ action: z.literal("press"), selector: z.string(), key: z.string() }),
    ])).default([]),
    expect: z.object({                         // no HTTP status field
      textPresent: z.array(z.string()).default([]),
      selectorPresent: z.array(z.string()).default([]),
      selectorAbsent: z.array(z.string()).default([]),
    }),
    mask: z.array(z.string()).default([]),
    settleMs: z.number().optional(),
    loading: z.boolean().optional(), // true declares intentional loading
    loadingSettleMs: z.number().int().positive().optional(), // default 5000 ms after ready
    screenshotTimeoutMs: z.number().int().positive().optional(), // ms, default 30000
  })),
})

const Flow = z.union([ElectronFlow, WebFlow])
```

Notes:

- `intent` — per-surface product intent in checkable sentence form ("A recipient decides and books in one screen with zero learned UI"). The model critique layer evaluates against these; they are the bridge from `PRODUCT.md` prose to something an evaluator can be held to.
- `surface` — one declared project surface captured by this flow. Many flows may
  govern one surface. It is optional only while project `surfaces` is empty.
- `target` — explicit on new manifests. Omission retains the historical `{ kind: "web" }` behavior. Target and state shapes are strictly paired.
- `setup` — steps run strictly sequentially with hard process-exit waits (the PGlite single-holder constraint). `${dataDir}` in `env` values expands to the run's fresh data directory.
- Web `url` vs `urlFrom` — exactly one must be present. `urlFrom` exists because seeded URLs (offer slugs, handle codes) are minted at seed time and must be read from setup stdout rather than hardcoded.
- Electron `launch` — exposes Playwright's executable, args, cwd, string environment, and timeout. `${dataDir}` expands in args, cwd, and environment values; every other placeholder is rejected, and `executablePath` accepts none. The directory is fresh per capture run and shared by every tuple in that run, so adopters that need per-tuple profile isolation must clear or namespace the profile themselves. Environment values and expanded private paths are never persisted.
- Electron `window` and `steps` — one loaded renderer must have the exact unique title. Locator actions execute in order after native content sizing and live media synchronization. Electron `expect.status` is invalid.
- Web `expect.path` optionally requires a leading-slash pathname without query, hash, or whitespace. After settling, capture compares that pathname ignoring trailing slashes and checks the navigation URL's runtime origin (including an allocated capture port), then checks again immediately before the screenshot. A mismatch fails at the expectation stage with a setup/redirect diagnostic and saves no DOM, accessibility, observation, or screenshot evidence for that tuple. Existing expectations without `path` and Electron expectations keep their behavior. `expectUrl` steps still assert an intermediate URL during the interaction sequence.
- `explicitDismiss` — selectors of modal dialogs that intentionally need an explicit action. The probe's dismissal pass does not click outside a panel that matches one, contains one or sits inside one; it still presses Escape. `role="alertdialog"` and `<dialog closedby="none">` or `closedby="closerequest"` are exempt without it. See [`popover-dismissal`](rules.md#popover-dismissal).
- `expect` — doubles as the `missing-state` check: a state that fails its `expect` block is itself a finding.
- `mask` — applied at diff time only; screenshots always record the truth.
- `kind: "published"` — a flow of rendered pages held to the `published-budget` check. It requires `pages`, which expand to states `page-<slug>` (`/` → `page-root`, `/p/abc` → `page-p-abc`) after any `routes` states. `pages` and `budget` are rejected on other flows, as are numeric viewports. A numeric viewport `1280` becomes the viewport name `"1280"` with a height of 800 (≥1024px wide), 1024 (≥600px) or 812; a published flow without `viewports` captures `1280`, `768` and `375`. The parsed flow carries these sizes in `viewportSizes`; a project viewport with the same name wins. States may narrow to these names like any other.
- `budget.maxDiffRatio` — the largest fraction of the padded screenshot area that may differ (pixelmatch, threshold 0.1) from the tuple's recorded pixel baseline. Without a recorded image the pixel part is not measured.

## 3. Managed reference — `.idiom/{references,anti-references}/<name>/reference.json`

```ts
const ReferenceMetadata = z.discriminatedUnion("sourceKind", [
  z.object({
    version: z.literal(1),
    name: z.string(),                    // lowercase slug; matches directory
    note: z.string().trim().min(1),      // what specifically to follow/avoid
    image: z.string(),                   // safe entry-relative image filename
    mediaType: z.enum(["image/png", "image/jpeg", "image/webp", "image/gif"]),
    sourceKind: z.literal("url"),
    source: z.string().url(),             // exact requested URL
    capturedAt: z.string().datetime(),
    viewport: z.object({ name: z.string(), width: z.number(), height: z.number() }),
  }),
  z.object({
    version: z.literal(1),
    name: z.string(),
    note: z.string().trim().min(1),
    image: z.string(),
    mediaType: z.enum(["image/png", "image/jpeg", "image/webp", "image/gif"]),
    sourceKind: z.literal("file"),
    source: z.string().trim().min(1),      // invocation-relative source path supplied by user
  }),
])
```

The image and record form one managed ownership boundary. The metadata name must equal the directory name, the image extension must agree with `mediaType`, and the image must be a regular file inside that directory. Loose legacy image/text files have no managed record and remain critique-only context.

## 4. Finding — entries in `.idiom/reports/<runId>/findings.json`

```ts
const Finding = z.object({
  id: z.string(),                        // "finding-<positive integer>"
  idAliases: z.array(z.string()).optional(), // unique historical noncanonical IDs
  fingerprint: z.string(),               // see "Fingerprints" below
  groupKey: z.string().optional(),       // deterministic: fingerprint inputs minus state and scheme; groups repeats
  createdAt: z.string().datetime(),
  commit: z.string(),                    // target-repo HEAD at capture
  flow: z.string(),
  state: z.string(),
  viewport: z.string(),
  colorScheme: z.enum(["light", "dark"]).optional(), // present when the axis is active
  layer: z.enum(["deterministic", "model"]),
  category: z.enum([
    "overflow-clip", "responsive-break", "contrast", "a11y-label", "target-size",
    "heading-structure", "token-drift", "console-error", "missing-state", "spacing-rhythm",
    "hierarchy", "density", "brand-alignment", "generic-pattern", "reference-mismatch",
  ]),
  severity: z.enum(["blocker", "major", "minor", "info"]),
  confidence: z.number().min(0).max(1),  // deterministic checks emit 1.0
  rule: z.string().optional(),           // "axe:color-contrast" | "idiom:token-drift"
  evidence: z.object({
    screenshots: z.array(z.string()),    // paths relative to the report dir
    references: z.array(z.string()).optional(), // exact reference/anti-reference labels cited by model
    artifacts: z.array(z.string()).optional(), // metadata/observation/etc paths for nonvisual evidence
    domSnippet: z.string().optional(),
    consoleExcerpt: z.string().optional(),
    serverLogExcerpt: z.string().optional(), // owned-server log lines around a 5xx; local only
    axeNodes: z.array(z.unknown()).optional(),
  }),
  explanation: z.string(),
  suggestedArea: z.string().optional(),  // surface-level hint, NEVER a repo file path
  basis: z.enum(["measured", "observed", "judged"]),
  basisDetails: BasisDetails,             // rule measurement, action/timing/result, or stated confidence
  acceptance: Acceptance,                // versioned rule, manual or legacy contract
  verification: z.object({
    kind: z.enum(["deterministic-check", "recapture-visual", "manual"]),
    check: z.string().optional(),        // checkId to re-run on verify
    params: z.record(z.string(), z.unknown()).optional(),
  }),
  status: z.enum(["open", "approved", "rejected", "ticketed", "verified-fixed", "verify-failed"]),
  acknowledgement: z.object({            // set while an acknowledgement is in force
    reference: z.string(),
    at: z.string().datetime(),
    until: z.string().optional(),
    note: z.string().optional(),
  }).optional(),
})
```

Notes:

- `commit` — every finding is keyed to the target repo's HEAD at capture time; this is what makes before/after comparisons meaningful.
- `evidence.artifacts` — optional for backward compatibility and nonempty when deterministic review emits a finding. Paths are report-relative, remain inside the run, and are existence-checked before output. This lets failed states cite metadata without pretending it is a screenshot.
- `evidence.references` — optional for stored-history compatibility. New model findings copy locally validated exact labels here; `reference-mismatch` model output cannot omit them.
- `suggestedArea` — deliberately surface language ("expired-state terminal copy block"), never a file path: the dogfood app's spec standard forbids path prediction in tickets, and the finding text flows into tickets verbatim.
- `acceptance.doneWhen` — observable human criteria, retained unchanged in tickets. The surrounding versioned object records whether and how a machine can recheck the rule.
- `acknowledgement` — written by the review run when the finding has an acknowledgement in force (`idiom decide <finding> --ack`); gates leave such a finding out of `--fail-on` and the new count. It is resolved fresh on every run and never carried forward from an earlier one.
- `verification` — how `idiom verify` proves resolution: re-run a named deterministic check, do a masked visual/DOM comparison against this finding's evidence baseline, or (last resort) flag for manual confirmation.

New findings always use the canonical short name. Historical findings without
`idAliases` remain valid. When a canonicalized record retains migration
history, every alias is unique, differs from `id`, and cannot itself be another
`finding-N` name.

## 5. Finding-name registry — `.idiom/finding-names.json`

```ts
const FindingNameRegistry = z.object({
  version: z.literal(1),
  next: z.number().int().positive(),
  entries: z.array(z.object({
    name: z.string().regex(/^finding-[1-9]\\d*$/),
    fingerprints: z.array(z.string().trim().min(1)).min(1),
    legacyIds: z.array(z.string().trim().min(1)),
  }).strict()),
}).strict()
```

`next` is greater than every reserved number. Names, fingerprints, and legacy
IDs have one owner; arrays contain no duplicates; canonical names never appear
in `legacyIds`. The file is committed shared memory like `decisions.jsonl`.
Missing means an unmigrated version-0 project: read-only commands reconstruct
an in-memory projection, and the next name-aware mutating command writes it
atomically. Local and primary-checkout copies are unioned only when their
identity ownership agrees.

## 6. Unruled decision — entries in `.idiom/reports/<runId>/unruled-decisions.json`

```ts
const UnruledDecision = z.object({
  id: z.string().regex(/^ruling-[1-9]\d*$/),
  fingerprint: z.string(),              // normalized choice-key hash
  choiceKey: z.string().trim().min(1),
  question: z.string().trim().min(1),
  nearestLawExcerpt: z.string().trim().min(1),
  occurrences: z.array(z.object({
    state: z.string(),
    viewport: z.string(),
    colorScheme: z.enum(["light", "dark"]).optional(),
    screenshot: z.string(),             // exact current-run screenshot label
  }).strict()).min(2),
  candidates: z.array(z.object({
    wording: z.string().trim().min(1),
    precedent: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("law"), excerpt: z.string().trim().min(1) }),
      z.object({
        kind: z.literal("governed-surface"),
        screenshot: z.string(), state: z.string(), viewport: z.string(),
        colorScheme: z.enum(["light", "dark"]).optional(),
      }),
    ]),
  }).strict()),
}).strict()
```

Qualification is local and deterministic: at least two distinct state ids,
deduplicated coordinates and precedents, recurrence-first stable ordering, and
a fixed maximum of three records. The cap is independent of findings. An empty
candidate list is valid and means Idiom found no checkable precedent. Invalid
or unsupported observations are discarded individually and counted in the
report; they never become findings or trigger finding repair.

## 7. Ruling-name registry — `.idiom/ruling-names.json`

```ts
const RulingNameRegistry = z.object({
  version: z.literal(1),
  next: z.number().int().positive(),
  entries: z.array(z.object({
    name: z.string().regex(/^ruling-[1-9]\d*$/),
    fingerprint: z.string().trim().min(1),
  }).strict()),
}).strict()
```

Names and fingerprints each have one owner and `next` is above every reserved
number. Compatible local and primary-worktree registries union; divergent
ownership fails closed. Review persists reservations before any artifact or
report cites them.

## 8. Recorded ruling — delimited blocks appended to `DESIGN.md`

Each confirmed `idiom ruling` appends a canonical block containing strict JSON
metadata `{ id, fingerprint, choiceKey, outcome, wording?, reason?, recordedAt }` between
`<!-- idiom:ruling:start -->` and `<!-- idiom:ruling:end -->`. `outcome` is
`rule` or `no-rule`; rule outcomes require nonblank `wording`, while no-rule
outcomes forbid both fields. A rule may carry a nonblank `reason`; exploration
uses it to preserve why the chosen direction won, while old ruling blocks stay
valid. IDs and fingerprints are unique across blocks. Markers,
metadata, and placement are parsed strictly, and every pre-existing source byte
must remain an exact prefix of the completed file.

## 8a. Exploration provider output

Exploration accepts exactly three strict candidate records. Each contains a
unique nonblank label and direction, normalized `choiceKey`, generalized
`rule`, inferred `reason`, model finding `category`, repair language, exact
reference labels, and one or more `{ path, oldText, newText }` edits. Paths are
safe project-relative existing files; additions, deletions, renames, output
paths, duplicate paths, and identical old/new text are forbidden. Refinement
uses the same record without a label and is permitted once by the session state.

## 9. Decision — one JSONL line in `.idiom/decisions.jsonl`

```ts
const Decision = z.object({
  at: z.string().datetime(),
  commit: z.string(),
  findingId: z.string(),
  fingerprint: z.string(),
  decision: z.enum(["accept", "reject"]),
  scope: z.enum(["instance", "rule"]).default("instance"),
  reason: z.string().optional(),
  actor: z.string().default("human"),
})
```

Human reference choices can add `provenance: { build: string, escalation?: string }`.
An additive `decision: "ruling"` variant carries `at`, `commit`, `findingId`,
`fingerprint`, `actor`, a required nonblank `reason`, validated `resolution`
(the existing RulingResolution), and optional provenance. Its fingerprint and
findingId must match the resolution fingerprint/id. These records never enter
finding judgment, lifecycle or acknowledgement reduction. Existing log bytes and
unknown future variants are preserved. DESIGN.md and log resolutions form one
effective law, with equivalent answers deduplicated and conflicts rejected.

`check` summaries and executed gate JSON add `decisionNeeded` and
`decisionQuestion`. Each pending question has `kind` (`reference-conflict`,
`unruled`, `scaleCluster`), stable `key`, `fingerprint`, canonical `id`, optional `findingIds` (every finding occurrence
the question stands for, across viewports and schemes), `flow`,
`runDirectory`, source `artifact`, `question`, occurrence `coordinates`, resolved
`evidence` paths, `missingCropEvidence`, `citations`, and `options` with labels
and CLI `args` arrays (plus an optional custom-wording input marker). Artifact
paths remain separate from command arguments. Reference questions require both
`idiom:design-decision` and its structured evidence; category or prose alone
never qualifies. `decide --pending --json` wraps these fields with
`interfaceVersion: 1`. See [pending decisions](commands.md#pending-decisions-and-remembered-answers).

The log also holds acknowledgements (`idiom decide <finding> --ack <reference>`): a finding that is a real problem tracked elsewhere. They are not judgments; every reader of accept/reject decisions ignores them.

```ts
const Acknowledgement = z.object({
  at: z.string().datetime(),
  commit: z.string(),
  findingId: z.string(),
  fingerprint: z.string(),
  decision: z.enum(["acknowledge", "unacknowledge"]),
  reference: z.string().trim().min(1).max(500),  // single line; unacknowledge echoes the one it removed
  until: z.string().optional(),                   // YYYY-MM-DD, inclusive
  note: z.string().optional(),
  evidence: z.object({                            // required for acknowledge
    severity: z.enum(["blocker", "major", "minor", "info"]),
    rule: z.string().optional(),
    category: z.string(),
  }).optional(),
  actor: z.string().default("human"),
})
```

The latest acknowledge or unacknowledge line on a lineage is in force. It lapses after an unacknowledge, when its reference is a ticket in the local tracker that is done, the day after `until`, or when the observed finding is more severe than `evidence.severity` or under a different rule. Idiom versions before acknowledgements reject a log containing these lines.

The file is append-only and committed — the decision history is part of the product context a future agent (or teammate) inherits.

## 10. Decision brief — `.idiom/briefs/<slug>.json`

Written by `idiom brief record` or `idiom brief "<request>" --research` beside the rendered `<slug>.md`. The input is the same object without `version`, `rubricVersion`, `createdAt`, `updatedAt` and `researchRun`, with `slug` optional (derived from the title). Validation rules are in [brief.md](brief.md#validation).

```ts
const StoredBrief = z.object({
  version: z.literal(1),
  slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(64),
  title: z.string().trim().min(1).max(120),
  request: z.string().trim().min(1).max(20_000),   // verbatim
  decision: z.string().trim().min(1),              // the design question
  screenQuestion: z.string().trim().min(1).optional(), // one line; CR/LF rejected
  inventory: z.array(z.string().trim().min(1)).min(1).optional(), // real objects and magnitudes
  requestNamedIdea: z.boolean(),
  triage: z.object({ verdict, reason, questions }).optional(),
  research: z.array(z.object({
    question: z.string(),
    findings: z.union([
      z.array(z.object({ claim: z.string(), source: httpUrl, verified: z.enum(["hands-on", "read"]) })).min(1),
      z.literal("nothing found"),
    ]),
  })).min(1),
  options: z.array(z.object({
    id: slug, title: z.string(), summary: z.string(),
    kind: z.enum(["requester", "alternative", "dont-build"]),
    cost: z.object({ space: z.string(), steps: z.string(), concepts: z.string(), code: z.string() }),
    rejectedBecause: z.string().optional(),       // every option but the recommendation
    label: z.string().max(40).optional(),         // one line; the answer label in the ask
    sketch: z.string().optional(),                // ASCII, ≤16 lines of ≤72 characters; the ask's preview
  })).min(2).max(4),
  recommendation: z.object({ option: slug, reason: z.string() }),
  acceptanceCriteria: z.array(z.object({
    kind: z.enum(["geometry", "input-states", "contrast", "behaviour"]),
    statement: z.string(),
  })).min(1),
  outOfScope: z.array(z.string()).default([]),
  status: z.enum(["proposed", "decided", "superseded"]).default("proposed"),
  decidedBy: z.string().optional(),               // required when decided
  supersededBy: slug.optional(),                  // required when superseded
  stakes: z.enum(["low", "high"]).optional(),     // read as "high" when absent
  reversible: z.boolean().optional(),             // read as false when absent
  chosenOption: slug.optional(),                  // decided only; the recommendation when absent
  rubricVersion: z.number().int().positive(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  researchRun: z.object({                         // Idiom-owned; only --research writes it
    provider: z.enum(["claude-code", "anthropic", "codex"]),
    model: z.string(),
    budgetMs: z.number().int(), durationMs: z.number().int(), calls: z.number().int(),
    turns: z.number().int().optional(),           // each figure only when the provider exposed it
    searches: z.number().int().optional(),
    tokens: z.object({ input: z.number().int(), output: z.number().int() }).optional(),
    incomplete: z.object({                        // the run stopped at its budget or a bound
      stage: z.enum(["research", "options"]),
      note: z.string(),
      unresearched: z.array(z.string()),          // triage questions, verbatim
    }).optional(),
  }).strict().optional(),
});
```

When `researchRun.incomplete` is set, `status` must be `proposed`, `research` may be empty, and `decision`, `requestNamedIdea`, `options`, `recommendation` and `acceptanceCriteria` are either all present or all absent. Without it, every field above is required as shown.

### Stored triage — `.idiom/briefs/triage/<id>.json`

Written by every model `idiom brief triage` (and by `idiom brief plan` when it triages first). The id is `triage-` plus the first 10 hex characters of sha256(`<rubricVersion>\n<request>`), so re-triaging a request overwrites its own record.

```ts
const StoredTriage = z.object({
  version: z.literal(1),
  id: z.string().regex(/^triage-[0-9a-f]{10}$/),
  request: z.string(),
  rubricVersion: z.number().int().positive(),
  createdAt: z.iso.datetime(),
  verdict: z.enum(["design decision", "no design decision"]),
  reason: z.string(),
  questions: z.array(z.string()),
}).strict();
```

### Research plan — `idiom brief plan --json`

```ts
type BriefPlan = {
  request: string;
  triageId?: string;
  noDecision?: true;                              // a no-design-decision triage
  questions: { question: string; check: string[] }[];
  references: Record<string, { name: string; note: string }[]>;   // by tier: bar, always, floor, …
  referencesNote?: string;                        // when none are configured
  checks: { id: "hover" | "touch" | "keyboard" | "small-screen" | "empty-state" | "error-state"; check: string }[];
  standards: { topic: string; look_for: string; url: string }[];
  budget: { minutes: number; searches: { min: 3; max: 6 } };
  rules: string[];
  inventoryInstructions: string[];                // gather screen question and real inventory before options
  stateChecklist: string[];                       // all block/item states and a named opened-state JSON example
  recordShape: object;                            // the brief input skeleton, placeholders to replace
  recordRules: string[];
  next: string[];
};
```

### Record result — `idiom brief record --json`

```ts
type BriefRecordResult = {
  slug: string;
  outcome: "created" | "updated";
  status: "proposed" | "decided" | "superseded";
  markdownPath: string;                           // project-relative
  ask: null | {                                   // null unless proposed
    decision: string;                             // ends with "?"
    recommendation: string;                       // option id
    options: { id: string; label: string; description: string; preview?: string }[];  // recommended first
    proceed: { allowed: boolean; reason: string };
    askUserQuestion: { questions: [{ question: string; header: "Design call"; multiSelect: false;
      options: { label: string; description: string; preview?: string }[] }] };
    text: string;                                 // plain-text version
  };
};
```

## Fingerprints

```
fingerprint = sha256(category | flow | state | [colorScheme] | rule | selectorHint)
```

`colorScheme` participates only when the project has activated the axis; singleton fingerprints remain byte-identical. On opt-in, the scheme equal to `capture.colorScheme` inherits both prior scheme-less hash forms as aliases.

The fingerprint is the identity of a *kind* of problem, independent of the run that observed it. Before hashing, Unicode is normalized to NFKC, whitespace and CSS combinator spacing are canonicalized, and class tokens are sorted within every compound selector. Browser-observation generated/hashed classes are discarded when the compound retains a tag, ID, attribute, or stable class. If every class in a compound is generated and no structural anchor remains, the original class token is retained: identity stability is preferable to collapsing unrelated elements into one permanent memory key. Stable IDs, attributes, tag names, pseudo-selectors, and non-CSS semantic hints remain. The previous normalization/hash is calculated as a private compatibility alias while matching, but newly written findings contain only the canonical fingerprint. Existing decisions and ticket identities therefore remain effective without rewriting append-only history.

The fingerprint serves two roles:

1. **Dedup** — the same issue re-observed in a later run joins the existing finding's lineage rather than appearing as new.
2. **Decision-memory key** — rejections with `scope: "rule"` suppress *every future finding* with a matching fingerprint.

## Finding status lifecycle

```
open ──(idiom decide --accept)──▶ approved ──(idiom tickets)──▶ ticketed ──(idiom verify)──▶ verified-fixed
  │                                                                              └──▶ verify-failed
  └──(idiom decide --reject)──▶ rejected
```

Every review artifact is an occurrence. Occurrences with a canonical fingerprint, compatibility alias, or already-reused ID form one lineage whose first published ID is permanent. The catalog retains all historical fingerprint/ID pairs. Decisions, ticket discovery, and verification checkpoints resolve canonical and historical IDs to that lineage. `idiom decide --list` reduces those sources without writing: it reports first/latest observation, count, aliases, decision, ticket, verification outcome, and the complete ordered path.

Successful canonical tracker ticket creation or generated-filename discovery atomically checkpoints `ticketed` in the latest occurrence. Custom `--out` drafts do not write lifecycle status because they are not tracker tickets and must not suppress a later canonical emission. Emission also scans strict `idiom:finding` blocks in Markdown tickets across every tracker state and matches their exact historical `{ findingId, fingerprint }` pair to a lineage. This embedded record is authoritative even when humans consolidated several findings into an arbitrarily named ticket and removed the redundant standalone files: the lineage is reported already resolved and checkpointed `ticketed`. Any historical `ticketed` or `verified-fixed` occurrence likewise suppresses re-emission even if no matching ticket file remains. The shared catalog writer can subsequently checkpoint `verified-fixed` or `verify-failed`; it rejects verification outcomes before ticketing and never downgrades a verification result on a ticket retry or embedded-record checkpoint. This is the persistence boundary for a future verification command, not verification execution. `verify-failed` means a later verifier found that the implementation did not resolve the finding.

## Decision-memory semantics

- **`scope: "instance"`** — judgment about this occurrence only. It is resolved by stable lineage ID plus the recorded commit: replaying the same commit does not re-prompt or re-ticket, while a re-observation on a later commit is open again and requires a new decision.
- **`scope: "rule"`** — standing judgment. `idiom review` consults `decisions.jsonl` before emitting: the latest rule-scope decision across a lineage's canonical and legacy fingerprints controls suppression, so a later acceptance cancels an earlier rejection. Suppressed candidates are visible, but **never counted against the configured finding cap** and never sent to the model as open issues. Every eligible deterministic finding is sent as duplicate-avoidance context; after model critique succeeds, both layers are deduplicated and ranked by severity, confidence descending, and canonical fingerprint. Only the configured number is written to `findings.json`; the report's evaluated-but-not-selected section retains the remaining eligible findings in that same order.
- `.idiom/rules.json` holds human-authored permanent suppression and severity policy — configuration, as opposed to the judgment history in `decisions.jsonl`. File-backed suppressions have the same partition/cap behavior as rule-scope rejections. Every review contains a suppressed-findings appendix naming the exact decision or rules override and reason; active severity changes name the override and show `original -> effective`.

## Project rules

An absent `.idiom/rules.json` means `{ "version": 1, "overrides": [] }`. If the file is present, read, JSON, and schema errors are fatal and use project-relative field paths. The exact shape is:

```json
{
  "version": 1,
  "overrides": [
    {
      "id": "intentional-compact-booking-action",
      "match": { "flow": "booking", "category": "target-size" },
      "action": "suppress",
      "reason": "This compact control is paired with a larger equivalent action."
    },
    {
      "id": "terminal-density-is-low-impact",
      "match": { "flow": "booking", "state": "expired", "rule": "design:terminal-density" },
      "action": "severity",
      "severity": "minor",
      "reason": "Terminal states are deliberately quiet."
    }
  ]
}
```

Override IDs must be unique and nonblank. `match` must be nonempty and supports only `fingerprint`, `category`, `flow`, `state`, and `rule`; its fields are ANDed. `action` is exactly `suppress` or `severity`. `severity` is required only for a severity action and must be `blocker`, `major`, `minor`, or `info`. `reason` is required and nonblank. Overrides run in file order: suppression dominates any severity match, and the last matching severity override is effective.

## Worked examples

### `.idiom/flows/booking.json` for the booking example

```json
{
  "id": "booking",
  "title": "Recipient booking page",
  "intent": [
    "A recipient understands whose time they are looking at and what is being offered within two seconds.",
    "A recipient decides and books in one screen with zero learned UI.",
    "Terminal states (expired, taken, withdrawn) read as calm, resolved outcomes, not errors."
  ],
  "setup": [
    {
      "run": "bun run seed:booking",
      "env": { "BOOKING_DATA_DIR": "${dataDir}", "BOOKING_DATABASE_URL": "" },
      "captureStdout": true
    }
  ],
  "states": [
    {
      "id": "valid-anonymous",
      "description": "Bookable offer, recipient not known — name and email form shown",
      "urlFrom": {
        "source": "setup-stdout",
        "pattern": "EXPECT ANONYMOUS.*http://localhost:3000(\\S+)",
        "append": "?tz=America/New_York"
      },
      "expect": { "status": 200, "selectorPresent": ["form"] },
      "mask": ["time", "[data-slot-time]"]
    },
    {
      "id": "valid-known",
      "description": "Bookable offer for a known recipient — one-click confirm",
      "urlFrom": {
        "source": "setup-stdout",
        "pattern": "EXPECT KNOWN.*http://localhost:3000(\\S+)",
        "append": "?tz=America/New_York"
      },
      "expect": { "status": 200 },
      "mask": ["time", "[data-slot-time]"]
    },
    {
      "id": "expired",
      "description": "Offer expired before booking",
      "urlFrom": {
        "source": "setup-stdout",
        "pattern": "EXPECT EXPIRED.*http://localhost:3000(\\S+)",
        "append": "?tz=America/New_York"
      },
      "expect": {
        "status": 200,
        "textPresent": ["These times have expired."],
        "selectorAbsent": ["form"]
      },
      "mask": ["time", "[data-slot-time]"]
    },
    {
      "id": "taken",
      "description": "Slot already booked by someone else",
      "urlFrom": {
        "source": "setup-stdout",
        "pattern": "EXPECT TAKEN.*http://localhost:3000(\\S+)",
        "append": "?tz=America/New_York"
      },
      "expect": {
        "status": 200,
        "textPresent": ["That time has been booked."],
        "selectorAbsent": ["form"]
      },
      "mask": ["time", "[data-slot-time]"]
    },
    {
      "id": "confirmed",
      "description": "Recipient's own completed booking",
      "urlFrom": {
        "source": "setup-stdout",
        "pattern": "EXPECT CONFIRMED.*http://localhost:3000(\\S+)",
        "append": "?tz=America/New_York"
      },
      "expect": { "status": 200, "textPresent": ["You said when."] },
      "mask": ["time", "[data-slot-time]"]
    },
    {
      "id": "withdrawn",
      "description": "Host withdrew the offer",
      "urlFrom": {
        "source": "setup-stdout",
        "pattern": "EXPECT WITHDRAWN.*http://localhost:3000(\\S+)",
        "append": "?tz=America/New_York"
      },
      "expect": { "status": 200, "selectorAbsent": ["form"] },
      "mask": ["time", "[data-slot-time]"]
    },
    {
      "id": "not-found",
      "description": "Unknown link",
      "url": "/b/nope/nope?tz=America/New_York",
      "expect": { "status": 404 }
    },
    {
      "id": "error-name",
      "description": "Form validation error: missing name",
      "urlFrom": {
        "source": "setup-stdout",
        "pattern": "EXPECT ANONYMOUS.*http://localhost:3000(\\S+)",
        "append": "?tz=America/New_York&error=name"
      },
      "expect": { "status": 200, "selectorPresent": ["form"] },
      "mask": ["time", "[data-slot-time]"]
    }
  ]
}
```

Exact `urlFrom` patterns and the seed's real stdout labels are pinned down in backlog T2 against actual seed output; the shapes above show the mechanism. Mask selectors likewise get verified against the rendered DOM.

### Example finding

```json
{
  "id": "finding-3",
  "idAliases": [
    "IDM-20260814a-3"
  ],
  "fingerprint": "9f2c41d0e6b8a75c3d1f0e9b2a4c6d8e0f1a2b3c4d5e6f708192a3b4c5d6e7f8",
  "createdAt": "2026-08-14T18:22:04Z",
  "commit": "b1946ac92492d2347c6235b4d2611184e0f7a8c3",
  "flow": "booking",
  "state": "expired",
  "viewport": "mobile",
  "layer": "deterministic",
  "category": "contrast",
  "severity": "major",
  "confidence": 1,
  "rule": "axe:color-contrast",
  "evidence": {
    "screenshots": [
      "expired/mobile/screenshot.png"
    ],
    "axeNodes": [
      {
        "target": [
          ".terminal-note"
        ],
        "contrastRatio": 3.1,
        "required": 4.5
      }
    ]
  },
  "explanation": "The explanatory note on the expired state has insufficient contrast against its background.",
  "suggestedArea": "expired-state terminal copy block",
  "acceptance": {
    "version": 1,
    "kind": "rule",
    "doneWhen": [
      "The expired-state note measures at least 4.5:1 contrast on both viewports."
    ],
    "rule": "axe:color-contrast",
    "check": "contrast",
    "coordinate": {
      "flow": "booking",
      "state": "expired",
      "viewport": "mobile"
    },
    "requiredCoordinates": [
      {
        "flow": "booking",
        "state": "expired",
        "viewport": "mobile"
      },
      {
        "flow": "booking",
        "state": "expired",
        "viewport": "desktop"
      }
    ],
    "target": {
      "kind": "selectors",
      "selectors": [
        ".terminal-note"
      ]
    },
    "condition": {
      "kind": "rule-clear",
      "parameters": {
        "required": 4.5,
        "unit": "ratio"
      },
      "settingsIdentity": "f9fea892daa53d62ed7906ad290b98cc6021dcb38fac12a7e547a9edee99d3d4",
      "allowRemoval": false
    }
  },
  "verification": {
    "kind": "deterministic-check",
    "check": "contrast"
  },
  "status": "open",
  "basis": "measured",
  "basisDetails": {
    "kind": "measured",
    "rule": "axe:color-contrast",
    "summary": "The note measures 3.1:1 contrast; the required minimum is 4.5:1.",
    "measurement": {
      "contrastRatio": 3.1,
      "required": 4.5,
      "unit": "ratio"
    }
  }
}
```

### Example `decisions.jsonl` lines

```jsonl
{"at":"2026-08-14T19:01:12Z","commit":"b1946ac92492d2347c6235b4d2611184e0f7a8c3","findingId":"finding-3","fingerprint":"9f2c41d0e6b8a75c3d1f0e9b2a4c6d8e0f1a2b3c4d5e6f708192a3b4c5d6e7f8","decision":"accept","scope":"instance","reason":"Real readability problem on the only explanatory text in the state.","actor":"human"}
{"at":"2026-08-14T19:03:40Z","commit":"b1946ac92492d2347c6235b4d2611184e0f7a8c3","findingId":"finding-5","fingerprint":"1a7e5c2b9d4f8036e1c7a9b5d3f2e8c4a6b0d9e7f5c3a1b8d6e4f2c0a9b7d5e3","decision":"reject","scope":"rule","reason":"The quiet single-column density on terminal states is intentional; do not raise density findings against booking terminal states again.","actor":"human"}
{"at":"2026-11-06T15:20:02Z","commit":"b1946ac92492d2347c6235b4d2611184e0f7a8c3","findingId":"finding-12","fingerprint":"3c9d0e7a1b5f4826c0e8a6d4b2f1e9c7a5d3b0f8e6c4a2d1b9f7e5c3a0d8b6f4","decision":"acknowledge","reference":"ABC-123","until":"2026-12-01","note":"Tracked in Jira","evidence":{"severity":"major","rule":"idiom:target-size","category":"target-size"},"actor":"human"}
```

## Recorded finding baseline — `.idiom/baselines/<flow>.json`

Published flows also record pixel baselines: `baseline record` copies each
tuple's screenshot to `<baselines>/<flow>.pixels/<state>--<viewport>[--<scheme>][--<combination-slug>].png`,
overwriting what is there and removing images no current tuple maps to. The
directory is committed beside the JSON.

Observation artifacts (version 2) of published tuples carry two optional
fields; other captures omit them, and older artifacts load without them
(the image part of `published-budget` then reports unavailable coverage):

- `images` — every `<img>` after a ~500ms decode wait: `selector`, `src`,
  `currentSrc`, `complete`, `naturalWidth`, `naturalHeight`, `visible`.
  SVG `<image>` is not recorded.
- `failedImageRequests` — `{ url, reason }` per image request that failed
  (`request.failure().errorText`) or answered 400 or above (`HTTP <status>`),
  deduplicated by URL, `data:` URLs ignored.

The strict version-1 schema lives in `src/baseline/schema.ts`. A file has
`version: 1`, `flow`, and `records` (newest recordings first, capped at 20).
Each record contains `commit` (40- or 64-character lowercase hex), ISO
`recordedAt`, `idiomVersion`, `configHash` (`sha256:<64 hex>`), and `tuples`.
Each tuple has `state`, `viewport`, optional `colorScheme` and `combination`,
and `findings`: fingerprint, aliases, category, rule, raw severity, selector.
Empty captured tuples are retained. Screenshots and observation artifacts are
excluded. Recording the same commit replaces its record; tuples and findings
are sorted for stable diffs.

The hash covers the complete schema-normalized project `checks` block and
sorted deterministic check IDs, including capture-affecting settings. Comparison
warns on hash mismatch and uses nearest reachable Git ancestry, then recording
time for ties. `check --since-baseline` JSON exposes `findings` (new),
`preExisting`, `preExistingFindings`, `fixed`, `blocking`, and `baseline`
(commit, recording time, file path, commit distance, original config hash,
optional stale reason, uncovered tuple keys). `review --since-baseline` uses
the same fields in `comparison`, with a separate `unclassified` model count,
and persists that object as `baseline-comparison.json`. Fixed rows retain raw
baseline severity. New and pre-existing rows retain effective severity and
canonical IDs; the same ID can occur at multiple tuple coordinates. A row with
`occurrenceOnly: true` has no separately stored finding at that coordinate;
like a `deferred` row, its text has no standalone Decide command.


Probe budgets are positive integer milliseconds: `checks.probe.controlTimeoutMs`
defaults to `5000`, and `checks.probe.stateTimeoutMs` to `60000`, including when
`probe` or either field is omitted. The control budget spans explanation
hover/focus, actions, the effect window and cheap restoration. Full replay has a
separate deadline. Web captures size one flow allowance from the wall clock.
Each round gets the time left before a 400s run target (less a 20s reserve) on
every capture lane, at most stateTimeoutMs per state; the first round gets at
least stateTimeoutMs per lane. Rounds
divide it by assigned work and refund unused shares. Later rounds probe controls
that an assigned state left unfinished, in another state that shows them. Each
state's nested cap is one quarter of its current share, within that allowance;
in a planned flow, nested check candidates are bounded only by the state deadline. Standalone library probes retain the per-state
budget. Zero never disables a budget. Placement defaults are unchanged.

`checks.probe.flowBudgetMs` is the run target in non-negative integer
milliseconds. It is optional and has no schema default: an omitted key resolves
to 400000 in code, so existing configuration hashes are unchanged. `0` means no
target: each state's lease is the capture's remaining lifetime, and the nested
and held-replay fractions are off. It is scheduling, so it is excluded from the
captured-settings identity. `run.json` records the effective target as
`probe.flowBudgetMs` for web runs; older runs omit it.

`checks.probe.enabled` defaults to `true` (it was `false` through v0.8.0), so
web flows probe once per state at the first selected viewport unless it is set
to `false` or a state sets `probe: false`. Generated toggle-combination states
stay unprobed unless their base sets `probe: true`.

Component observations (`observations.components[]`) gain two optional fields
for sizes inferred from the design file. `inferred` is
`{ source, words, axis?, matchedBy? }`: `source` is `"<designFile>:<line>"`, `words` the
lowercased singular name words the selector was resolved from, and `axis`
(`width` or `height`) marks a one-axis statement, which is judged on that axis
only; the other stored dimension is the first match's measured size.
`matchedBy: "modifier"` marks a shape name (`… dot`, `circle`, `indicator`, …)
whose full word run matched nothing, resolved instead by its modifier words on
textless, non-interactive elements (`layers-override` for "override dot").
`unresolved: true` records an inferred component no class or aria-label words
matched; it has `rects: []` and an empty `selector`, which is allowed only then.
Older observations without these fields remain valid.

`capture.maxMinutes` is a finite positive number (fractional minutes allowed),
default `30`. It bounds one entire capture invocation from source/setup/build
through launch, measurement, tuples, publication and teardown, including Electron
and captures without probing. Timeout diagnostics freeze the active state,
viewport, scheme and step; coordinates are `pending` before tuple work. Owned
resources receive at most five seconds of additional cleanup grace.

V2 observations remain compatible with old probe artifacts. Optional result
fields are `elapsedMs` (finite, nonnegative), `status` (`completed`, `timed-out`
or `not-reached`), `timeoutScope` (`control` or `state`) and `reusedFrom` (the
assigned state whose result for the same control was reused; it may appear
later in tuple order, and reused rows have no attempt `elapsedMs` or `timings`).
Optional `timings` records finite nonnegative `clickMs`, `effectWindowMs`,
`restoreCheckMs`, `escapeMs` and `replayMs` for an attempt. `replayRequired`
marks an attempt that left a persistent change requiring replay before the next
control. A no-replay distribution excludes that flag and attempts with positive
`replayMs`. `not-reached` results were never attempted (`maxControls`, the
flow budget share, repeated-row sample, modal blockage, no state that shows the
control able to finish it, flow probe time exhausted, or the nested-menu budget or
limit) and carry `skipped: "not reached: <reason>"`. Timed-out results retain identity,
partial effects and a `skipped: "timed-out: …"` marker, with no duplicate-entry
signature. The probe's status also accepts `timed-out`, with optional `selector`
and `step` for state expiry. Controls are never retried after timeout; partial
results survive page replacement and state expiry. `print` and `download` join
the effect enum. Native UI is suppressed for the whole disposable probe lifecycle,
independently of `respectControlIntent`.

Quick review's probe artifacts add an optional `safety` ledger; configured flows
and older artifacts omit it. `policy` is `third-party`. `origins` lists the
origins top-level navigation may stay on (the page's URL and its settled origin
after any redirect). `requests.sent` and `requests.blocked` count routed requests
by upper-case HTTP method; every method in `sent` is `GET`, `HEAD` or `OPTIONS`.
`blocked` counts `crossOriginNavigation`, `formSubmission`, `download`, `popup`,
`windowOpen`, `beforeunload` and `permission`, and `skipped.destructive` counts
controls never clicked because of a destructive name. All counts are nonnegative
integers. A blocked action maps to an existing effect so it is never judged a
dead control: a blocked navigation is `navigation`, a vetoed submission is
`network`, and a denied permission prompt is `dialog`.

Live progress is emitted only through an optional library `onProbeProgress`
callback; the CLI writes it to stderr, keeping JSON stdout parseable. `run.json`
timings optionally carry `slowestControls`, at most five entries sorted by elapsed
time descending with stable coordinate/selector/name ties. Entries contain
`state`, `viewport`, `colorScheme`, `selector`, `name`, `elapsedMs` and `outcome`
(`completed` or `timed-out`). Stored reviews replay those historical timings;
old records omit the list. Timings never participate in finding identity.
`run.json` timings also optionally carry `capture`, a phase timing (`status`,
`ms`) for the wall clock from browser (or Electron) launch to the last tuple
settled; older records omit it. Check JSON adds `timing`: `totalMs`,
`phases.{build,serverStart,capture,probe,checks}` (phase timings; `probe` is
summed lane time, included in `capture`), `slowest` (`build`, `server start`,
`capture`, `probe` or `checks`), `probeIncludedInCapture: true`, and
`historical: true` for `--from`/`--latest`. A `--gate` check's summary adds
`gate` (`plan`, `skippedWork`, `estimateMs`, `budgetMs`).

Probe artifacts optionally carry `fingerprints`, a map from control identity
key to a SHA-1 of the control's identity, rounded bounding box, a fixed set
of computed styles and trimmed text, recorded on every probed run. The build
gate (`idiom check --gate`) compares against them to probe only controls that
render differently; controls it leaves out are `not-reached` with
`skipped: "not reached: gate: unchanged since <runId>"`. Older artifacts omit
the map.

`run.json` also records `capture.reducedMotion`, the `prefers-reduced-motion`
mode every tuple was captured under (`project.capture.reducedMotion`). State
coverage reads it; records written before it existed fall back to a tuple's
motion artifact, and otherwise report both modes missing until recaptured.


## First-seen attribution — `.idiom/reports/<runId>/attribution.json`

Written by `check` beside `digest.json`, before the report renders. It is a
separate file so that a reader of `digest.json` never sees new fields. The
report, `digest` and `decide --list` only read it.

```ts
const Cause = z.object({ commit: z.string(), subject: z.string(), tickets: z.array(z.string()) });
const Attribution = z.object({
  version: z.literal(1),
  flow: z.string(),
  runId: z.string(),
  commit: z.string(),             // this run's commit
  dirty: z.boolean(),
  previous: z.object({ runId: z.string(), commit: z.string(), dirty: z.boolean(), completedAt: z.string() }).nullable(),
  configChanged: z.boolean(),     // checks configuration hash differs from previous
  introductions: z.array(z.object({
    id: z.string(),
    fingerprint: z.string(),
    where: z.string(),            // state/viewport[/scheme][#combination]
    state: z.string(),
    range: z.object({
      from: z.string(),           // full SHA, last seen without the finding
      to: z.string(),             // full SHA, this run
      commits: z.number().int().nullable(), // first-parent count; null when not linear
      linear: z.boolean(),
      fromDirty: z.boolean(),
      toDirty: z.boolean(),
    }),
    candidates: z.array(Cause).optional(),     // oldest first
    candidatesOmitted: z.string().optional(),  // why candidates were not computed
    likely: Cause.optional(),                  // exactly one candidate
  })),
});
```

`previous: null` means there was no earlier complete full run of the flow; the
file is still written. An introduction is recorded only for an open, non-info
design occurrence that is new at a coordinate both runs captured.

## Design comparison evidence

State `design` is optional. It is a nonblank string (a local HTML
file/directory, a local PNG/JPEG/WebP image, an absolute HTTP(S) HTML URL, or a
Figma frame URL with `node-id`); a `{ source, name?, viewport?, colorScheme? }` or
`{ site, name?, viewport?, colorScheme? }` object, where `site` is an absolute
HTTP(S) URL without credentials for a live reference site; or a non-empty array of
either (explicit names unique). Filesystem entry-point checks, image content
sniffing and HTTP media/status/access checks happen at capture. URL credentials,
unsupported schemes and remote image inputs are rejected. Both web and Electron
authored state schemas accept the field.

An opted-in app tuple's metadata contains a version-1 `design` descriptor: declared
source, resolved source provenance, exact state/viewport/dimensions/scheme,
reference runtime version, captured/failed status, failure reason, and contained
report-relative paths. Reference files live beneath `<state>/<viewport>[/<scheme>]/design/`:

- `observations.json`: the same V2 schema as the app, with optional border-side styles.
- `screenshot.png`, `dom.html`, `console.jsonl`, `axe.json`: captured reference evidence.
- `source.json`: source descriptor and provenance; deliberately not `metadata.json`.
- `matches.json`: version-1 one-to-one pairs with stable IDs, actual match tiers,
  matched-parent IDs, and unmatched selector sets on both sides.

`resolved.kind` is `file`, `url`, `inline`, `site`, `image` or `figma`. A site reference
writes the same seven files as an HTML design. An image reference instead records
`resolved.mediaType` and `resolved.sha256` (of the original bytes) and writes:

- `screenshot.png`: the image scaled to the tuple's viewport width, full height.
- `reference.<png|jpg|webp>`: the original image bytes.
- `console.jsonl`, `source.json`: as above.
- `regions.json`: version 1, `offset` (CSS px; design y = app y + offset),
  `compared` (the app band that overlapped), `uncompared` bands with their `side`,
  up to 20 `regions` (`region-N` id, app `rect`, `designRect`, `owner` selector or
  null, covered `elements`, `changedCells`, `cells`, `meanDelta`) and `omitted`.

The descriptor schema requires exactly the artifact set for its kind. On load,
image regions are recomputed from both screenshots and the app observations and
must equal `regions.json`; the original bytes must match `sha256`.

A Figma reference has no `dom.html`, `console.jsonl` or `axe.json` (those
descriptor paths are optional); it writes `figma.json`, the frame's node tree, in
their place. Its descriptor has `resolved.kind: "figma"` and a `figma` object:
`fileKey`, `nodeId`, `version`, `lastModified`, frame `width`/`height`,
`variables` (`"resolved"` or `"unavailable: <why>"`), the node `link`, and the
project-relative `cache` directory. With several references, each descriptor
carries its `name`, files live under `design/<name>/`, metadata `design` is the
first descriptor and `designs` lists all of them. When a state's references did
not apply to a tuple (another viewport or scheme), metadata records
`designNotApplicable` and the check's coverage reason says where they apply.

Declared failures keep `source.json` and available evidence. The loader validates
schemas, path containment (including symlinks), coordinates and match agreement.
Missing required reference files yield unavailable comparison coverage. Historical
metadata without a descriptor remains undeclared even if today's manifest adds one.

`Finding.evidence.designDrift` is versioned and contains pair ID/method, property,
design/app raw and normalized values, applied numeric allowance, distinct counterpart
selectors, matched-parent contexts, optional sibling identity for gaps, and labelled
report-relative crop paths. Absent-side values/selectors are null. Image region
findings use method `region`, property `visual`, null values, and an extra `region`
object: `id`, `rect`, `designRect`, `offset`, `owner`, `elements` and
`changedArea` (the 0–1 share of the region's cells that changed). `Finding.fix`
proposes a concrete correction or normal decision-based acceptance. Pair/property
identity does not include measured values, copy, source ports or crop paths.

Figma-backed drift adds `designLayerPath` (layer names from the frame down),
`designLink` (the node URL) and `designVariable` (the bound variable, when
resolved). With several references, a finding against a reference other than the
first names it in `reference`, agreeing references are listed in
`alsoReferences`, and a finding kept after `decide --choose` carries
`chosenReference`. Crop labels are `Design`, `Design: <name>` or `App capture`,
optionally suffixed ` (absent)`.

A disagreement between references is a finding with rule `idiom:design-decision`
whose `designDrift.designDecision` holds `version`, `decisionKey`, `property`,
`appSelector`, `appValue` and `references[]` (`name`, `source`, `value`,
`allowance`, `matchesBuild`, `layerPath`, `link`, `pairId`, `designSelector`).
A decision-log record written by `decide --choose` adds `designChoice: { flow,
state, colorScheme?, decisionKey, reference }`; the last choice per key applies.


## Filmstrip evidence

Each opted-in web tuple may contain optional version-1 `filmstrips.json` and selected PNGs at `filmstrips/<action-id>/<offset-or-settle>.png`. The manifest records configured offsets/limits, stable timeline id, semantic source/kind/control/name/step/held identity, epoch dispatch anchor, timeline clock origin, native settle time and flag, fixed CSS crop region, optional tail geometry, and ordered frame slots. Each slot has requested milliseconds plus either a confined relative PNG path, paint timestamp, actual milliseconds, viewport/scroll/device/page scale geometry, or an explicit unavailable reason. Collections and actions distinguish complete, partial and unavailable evidence. Present malformed manifests or missing referenced frames are artifact errors; absent manifests remain valid historical captures.

`Finding.evidence.filmstrip` optionally records `sheet`, `manifest`, `action`, `status`, `reason`, actual `width`/`height`/`bytes`, optional `generationMs`, and configured sheet `limits`. `sheet` is absent when no usable image can be made. Sheet paths are separate from `evidence.screenshots`, so static crops keep their original filenames and semantics. `CheckTuple.filmstrips` is the validated manifest. Motion action records may have `timelineId`; transient recording keys are never serialized. Hover windows use `hover-N` while existing click, load, step and slow-replay IDs keep their namespaces.

The version-1 verification attachment manifest optionally adds `filmstrips[]`: consecutive `ordinal`, unique canonical `kind` (`idiom-filmstrip-001`, etc.), finding and tuple identity, local `before`/`after` sheet paths or explicit `beforeUnavailable`/`afterUnavailable` reasons, and optional retained `frames` paths. Validation requires every declared file and report links for sheet attachments. Existing composite kinds and ordinals are unchanged; legacy manifests omit the collection.


Failure replay extends observation v2 and timeline v1 without defaulting new fields in old artifacts. `probe.failureReplay` marks coverage even when no eligible actions exist, including queued/ran counts, completed action identities and cap/budget notes. Actions with source `failure-replay` carry strict `failure` facts: origin, source action, mode/status/deadline, response-gating evidence, dispatch/navigation, locally delivered requests, recovery interval, changed feedback, meaningful visible changes, final trigger/pending/main/retry state, completion and truncation. Null represents unknown observations. Page times are relative to trusted dispatch; request start times use the process clock. Private request URLs used for exact routing never serialize; artifacts contain method/path only. Filmstrip identity adds `failureOf` so normal and held siblings cannot own the failure recording.


## Finding basis and acceptance contracts

`basis` separates measured rule results, observed behavior, and judged model suggestions. Both measured and observed findings retain `layer: deterministic`; judged findings retain `layer: model`. `basisDetails` carries the actual measurement or action and timing/result, or the model's stated confidence. Missing historical timing is explicitly unavailable; exploration's synthetic confidence is not presented as model-stated confidence.

`acceptance` is a strict version 1 object. All variants retain `doneWhen: string[]`. A `rule` contract also carries the public `rule`, registry `check`, original `coordinate`, `requiredCoordinates`, a `target` (`selectors`, `document` scope, or stable `action` identity), and `condition: { kind: "rule-clear", parameters, settingsIdentity, allowRemoval }`. Parameters are JSON values. The condition requires the existing rule to emit no violation for that target under the recorded effective settings, with usable target evidence. Timeline IDs locate report evidence; action source/kind/selector/name/step and replay origin identify the action across runs. Structural/document scope hints are never interpreted as CSS selectors. See [the complete example](../examples/booking/records/finding.json).

A `manual` contract records judged human criteria without claiming executable proof. Historical acceptance arrays normalize to `legacy` contracts at the finding loader, without rewriting old ticket sidecars. Missing historical basis is derived only from `layer` (deterministic → measured; model → judged). Unknown versions, malformed new objects and inconsistent layer/basis combinations are rejected. Normalized JSON and embedded finding blocks expose objects; visible lists use `doneWhen`.


New `run.json` records optionally retain `captureSettingsIdentity`, a hash of predicate-relevant capture settings and flow declarations. Loading a retained run reads its original hash rather than recomputing it from edited flow files; the contract separately pins the effective offline check configuration. No URLs, environment values or runtime resources are serialized into this identity. Current expectation declarations and captured invariant/component declarations must still prove that the original condition was rechecked. Design-image targets record their document region and reference; a transient cause element need not survive a repair.

Informational (`info`) findings round-trip through findings, groups, hosted issues,
acknowledgement evidence, rule overrides, baselines and digest records. Existing
three-severity records remain valid without a version change. Effective info
sorts below minor and never trips a severity gate; an override raising it to
major restores normal gating. An acknowledgement at info lapses when severity
rises. Baseline comparison still classifies info as new, pre-existing or fixed;
digest diffs omit info before computing changes and counts.

Version 2 observations add optional `adjacentGapExcluded` on elements,
`textRect` on field-group labels, `cardAction: { card, group, status }` on overlap
pairs (`status` is `intentional` or `ambiguous`), and `openedDisclosure` on probe
results. The latter stores `root`, `kind` (`details`, `popup`, `expanded`), and
paired `trigger`/`panel` rectangles in document coordinates. These fields preserve
legacy replay when absent; recapture to obtain the new browser evidence.

## Explicit size and spacing targets

Additive to interface version 1: `checks.components[]` accepts optional `name`
(defaults to selector) and `width`/`height`, requiring at least one positive finite
dimension. Existing two-axis tolerance defaults are unchanged. One-axis entries
accept exact `{px}` or `{ratio}` allowances; both units accept `mode` (`tighter`
or `looser`). Omitted tolerance remains min(15%, 1px); explicit empty/mode-only
objects keep 25%/4px legacy defaults.

`checks.spacingTargets` defaults to `[]`. Each strict entry has exactly one of
`between: [selectorA, selectorB]` (distinct nonblank selectors) or `within: selector`,
finite nonnegative `gap`, optional `axis` (`vertical` default, or `horizontal`),
and optional tolerance (`px`, `ratio`, `mode`). Single units are exact; omitted
or empty tolerance is 1px. Both units default to the larger allowance. Zero
values are valid. See [spacing targets](configuration.md#declare-spacing-targets).

V2 `observations.components[]` may omit either target dimension but requires
at least one; historical artifacts keep their saved tolerance numbers and mode.
Optional V2 `spacingTargets[]` records `{target, pairs, status, reasons}`. `target`
is the normalized declaration; `pairs` has `first` and `second`, each with concrete
`selector` and unrounded `x`, `y`, `width`, `height`, plus `container` for within
pairs. Status is `measured` or `unmeasurable`; reasons disclose unresolved selectors
and containers while retaining measurable pairs. Absent evidence means an older
capture; `[]` means no targets at capture. Offline review reads these saved
boxes and targets. The appended check/category `spacing-target` emits rule
`idiom:spacing-target` at major by default, with existing rule severity overrides.

### Blank-media and persistent-loading evidence

Project checks add strict, defaulted `visualBlank: { enabled: true, swatchSelectors: [] }` and `loadingStuck: { enabled: true }`. Selector lists contain trimmed nonempty CSS selectors. Both web and Electron states accept optional `loading` and positive integer `loadingSettleMs`, independently of `settleMs`. Readiness is DOM-ready navigation followed by completion of all declared steps. The default 5000 ms observation overlaps visual/animation settling; `loading: true` skips only the loading scan/wait.

V2 observations add optional strict `visualBlank` and `loadingStuck` objects. Each records ran/partial/skipped/unavailable status and reasons. Blank-media evidence retains passing and exempt targets, layout/interior/clipped geometry, scroll origin, masks, swatch declarations, opacity, cover geometry/alpha, video poster/frame facts and measured histogram/crop or unavailability. It stores algorithm `rgb16-v1`, bucket size 16, dominant threshold 0.995, opacity threshold 0.01, overlay alpha threshold 0.98 and edge inset 2 CSS px. Loading evidence retains configured/observed duration, intentional declaration, node identities and continuous visible interval ages with final active/resolved state. Millisecond durations use an in-page monotonic clock. Absence in older V1/V2 observations means unavailable coverage, while a successful empty inventory means no eligible targets. No recapture migration is required to parse old artifacts.

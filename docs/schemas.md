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
    env: z.record(z.string()),    // { BOOKING_DATABASE_URL: "", BOOKING_DEMO_CALENDAR: "1", PORT: "3107", ... }
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
    fullPage: z.boolean().default(true),
    settleMs: z.number().default(250),
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
  baselines: z.object({ directory: z.string().min(1) }).strict().optional(),
  model: z.object({
    provider: z.enum(["claude-code", "anthropic"]),
    model: z.string(),                   // model id passed to the selected provider
    maxFindings: z.number().int().min(1).max(5).default(5),
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
- `capture.*` — determinism pins applied to every browser context. `settleMs` is the post-navigation wait before the screenshot.
- `colorSchemes` — the ordered, unique capture axis. When absent, it normalizes to `[capture.colorScheme]`; an explicit list must retain that legacy scalar. `capture.colorSchemeAttribute`, when present, must be an HTML-safe attribute name and receives the selected scheme before application scripts execute.
- `design.tokensFile` — ground truth for the `token-drift` check; optional because not every target has one.
- `design.tokens` — optional typed inline declarations, normally proposed by `idiom system --learn` and saved only on confirmation. Source paths must be project-relative and cannot escape the project. Original names are presentation identities, including dotted DTCG paths; they are never blindly emitted as CSS custom-property names. `other` is display-only. File tokens and inline tokens are merged by source/key/theme identity, retaining inline settings when an identity is already configured.
- `checks.scales.spacing` — defaults to `[]`; entries are nonnegative finite CSS-pixel numbers or strict `{multipleOf: positiveFiniteNumber}` base steps (v4 `--spacing`). Declared values check visible V2 elements' authored computed padding, margin magnitudes and gap axes with 0.5px tolerance; zero/default/auto/normal and unsupported percentages are excluded. Historical observations without authorship facts disclose missing coverage. This does not change geometric `spacing-rhythm` inference.
- Confirmed imports union values into existing control heights, role radii and border lists. Theme variants retain their context in tokens; numeric scales contain the union. Rem conversions use recorded root sizes, or an explicitly disclosed 16px assumption without evidence; incompatible root conversions are omitted from numeric scales. Source dimension purpose mappings are inferred from spacing/space/gap/padding/margin, radius/radii and explicit control/button/input height names, never guessed from DTCG value shape.
- V2 `observations.json` optionally records positive finite `rootFontSize`, literal `theme`, and configured tokens' `typedValues` (`kind`, normalized `value`, optional `name`/`theme`). Old artifacts remain valid, with historical untyped token behavior and explicit missing rem coverage. Spacing-only inline tokens are valid. Recapture to enforce newly learned token rules. The system page's drift is value coverage within one selected run, not proof of variable references or project-wide unused code.
- V2 element `styles` optionally record computed `userSelect`, and `attributes` may include `inert`; `dead-affordance` uses both to recognise non-interactive illustration frames. Older artifacts without them stay valid and get no `user-select` exemption.
- Every newly observed element records `painted: { value: true }` or `{ value: false, reason, boundary? }`. Both V1 and V2 accept the optional fact. Missing facts preserve historical offline review behavior; they are never reconstructed from old styles. False reasons include `display-none`, `visibility-hidden`, `visibility-collapse`, `content-visibility-hidden`, `closed-details`, `opacity-0`, `zero-area` and `clipped-by <selector>`. `boundary` names the causal element. Eligibility includes below-fold content and partial clips, without hit testing, viewport intersection or `aria-hidden` exclusion. A closed details element and its first direct summary subtree remain eligible; other descendants do not.
- Element `paintedContent?: { selectors, width, height, clipped? }` retains contributor identities and the content extent without wholly unpainted descendants, separately from raw scroll measurements. `clipped: { text, interactive, marquee }` lists up to ten selectors each: painted text and controls partly cut off by the box (excluding `aria-hidden`/`inert` subtrees and content a nearer scroller owns), and the marquee tracks whose cut-off content was excluded. Older captures omit it. Selection members may carry `paintedDecoration` and `decorationOwners` alongside their unchanged raw `decoration`. These additive fields let offline rules filter contributors without changing document overflow or selection-validity checks.
- Check coverage may include `paintedSkipped: Record<string, number>`, keyed by full rule id. Counts are distinct rejected element selectors in that rule's input domain for that tuple, including zero when it ran on new evidence. Older evidence omits the field. Reasons and unavailable/skipped statuses are retained. JSON, Markdown and HTML reports expose these counts. Coverage may also include `inkSkipped: Record<string, number>`, keyed by full rule id: records dropped because the stored screenshot shows no ink where they were measured (currently `idiom:orphan-word`), present only when nonzero. Review/check JSON and MCP quick/check responses add `checkCoverage`, a coordinate-labelled array of check coverage records (without the DOM/observation payload), when painted or ink counts exist; legacy responses omit that field.
- V2 `observations.json` optionally records craft-rule evidence: `fonts` (declared faces with status and stylesheet URLs, the families visible text uses with up to five selectors and a fallback flag, and failed font requests), `links` (visible http(s) links with absolute href, same-origin flag and the run's check result: `ok`, `broken` with code or DNS reason, or `unchecked` with a reason), `focusVisible` (each keyboard focus stop with the `node.property` keys that changed and an optional visible `proxy`), `lineLengths` (paragraphs over 45 rendered characters per line), `orphanWords` (headings and button labels whose last line holds one word; newer captures add optional `rect`, the union of the owner's measured painted word rects, `lastLine`, the stranded word's rect, both viewport-relative like element rects, and `ink`, `{status: "measured", share}` with share in [0, 1] of sampled screenshot pixels under `lastLine` that differ from their modal colour, or `{status: "unavailable", reason}`), `imageRenders` (broken images and `fill` images rendered off their natural ratio) and `layoutShift` (largest session-window score and up to 150 entries with source selectors). Scans use the `{status, reason?, records}` shape; older artifacts without these fields stay valid and the checks report unavailable coverage.
- V2 `observations.json` optionally records `screenshot`: how the tuple screenshot was taken (`strategy` `viewport` | `full-page` | `tiled`, positive device `scale`, CSS `width`/`height`, `tiles` only when tiled) and, only when the full-page size changed between the start of observing and the screenshot, `drift` (`observed` and `captured` sizes) with `rects`, each observed selector's rect re-measured at screenshot time. Crops use `scale` and prefer `rects` over the observed element rect. `metadata.json` mirrors everything but `rects`. Older artifacts without it stay valid and crop as before.
- `baselines.directory` — optional project-relative or absolute local directory for compact finding baselines; defaults to `.idiom/baselines`. This location is not part of the checks hash.
- `model.provider` — `claude-code` is the scaffold default and uses the authenticated local CLI without an API key. `anthropic` is the explicit direct-API path and requires `ANTHROPIC_API_KEY`. Existing files are not migrated or reinterpreted.
- `model.maxFindings` — an integer from 1 through 5 and the material-findings cap across both evaluation layers. There is no overall score field anywhere, by design.

### Capture URL metadata

Web tuple `metadata.json` records the actual served origin in `url.origin`. Literal URLs use `{ kind: "literal", origin, url }`; setup-derived URLs use `{ kind: "setup-stdout", origin, source, pattern, append, template }`, with private seed values replaced by a stable template. Both kinds optionally carry `canonicalOrigin: string` when the served origin differs from the configured one. Derived console, DOM, axe and observation evidence uses the configured origin to keep finding identity stable. Offline review applies the same origin mapping to its document URL, preserving expected-status console suppression. Older records without `canonicalOrigin` retain their original URL interpretation.

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
    env: z.record(z.string()).optional(),
    captureStdout: z.boolean().default(false),  // makes setup stdout available to urlFrom
  })),
  viewports: z.array(z.string()).optional(),
  colorSchemes: z.array(z.enum(["light", "dark"])).min(1).optional(),
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
      env: z.record(z.string()).default({}),
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
  severity: z.enum(["blocker", "major", "minor"]),
  confidence: z.number().min(0).max(1),  // deterministic checks emit 1.0
  rule: z.string().optional(),           // "axe:color-contrast" | "idiom:token-drift" | "impeccable:<id>"
  evidence: z.object({
    screenshots: z.array(z.string()),    // paths relative to the report dir
    references: z.array(z.string()).optional(), // exact reference/anti-reference labels cited by model
    artifacts: z.array(z.string()).optional(), // metadata/observation/etc paths for nonvisual evidence
    domSnippet: z.string().optional(),
    consoleExcerpt: z.string().optional(),
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
    params: z.record(z.unknown()).optional(),
  }),
  status: z.enum(["open", "approved", "rejected", "ticketed", "verified-fixed", "verify-failed"]),
})
```

Notes:

- `commit` — every finding is keyed to the target repo's HEAD at capture time; this is what makes before/after comparisons meaningful.
- `evidence.artifacts` — optional for backward compatibility and nonempty when deterministic review emits a finding. Paths are report-relative, remain inside the run, and are existence-checked before output. This lets failed states cite metadata without pretending it is a screenshot.
- `evidence.references` — optional for stored-history compatibility. New model findings copy locally validated exact labels here; `reference-mismatch` model output cannot omit them.
- `suggestedArea` — deliberately surface language ("expired-state terminal copy block"), never a file path: the dogfood app's spec standard forbids path prediction in tickets, and the finding text flows into tickets verbatim.
- `acceptance.doneWhen` — observable human criteria, retained unchanged in tickets. The surrounding versioned object records whether and how a machine can recheck the rule.
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

The file is append-only and committed — the decision history is part of the product context a future agent (or teammate) inherits.

## Fingerprints

```
fingerprint = sha256(category | flow | state | [colorScheme] | rule | selectorHint)
```

`colorScheme` participates only when the project has activated the axis; singleton fingerprints remain byte-identical. On opt-in, the scheme equal to `capture.colorScheme` inherits both prior scheme-less hash forms as aliases.

The fingerprint is the identity of a *kind* of problem, independent of the run that observed it. Before hashing, Unicode is normalized to NFKC, whitespace and CSS combinator spacing are canonicalized, and class tokens are sorted within every compound selector. Browser-observation generated/hashed classes are discarded when the compound retains a tag, ID, attribute, or stable class. If every class in a compound is generated and no structural anchor remains, the original class token is retained: identity stability is preferable to collapsing unrelated elements into one permanent memory key. Stable IDs, attributes, tag names, pseudo-selectors, and non-CSS semantic hints remain. The previous normalization/hash is calculated as a private compatibility alias while matching, but newly written findings contain only the canonical fingerprint. Existing decisions and ticket identities therefore remain effective without rewriting append-only history.

The fingerprint serves two roles:

1. **Dedup** — the same issue re-observed in a later run joins the existing finding's lineage rather than appearing as new; impeccable-adapter findings dedupe against native ones the same way.
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

Override IDs must be unique and nonblank. `match` must be nonempty and supports only `fingerprint`, `category`, `flow`, `state`, and `rule`; its fields are ANDed. `action` is exactly `suppress` or `severity`. `severity` is required only for a severity action and must be `blocker`, `major`, or `minor`. `reason` is required and nonblank. Overrides run in file order: suppression dominates any severity match, and the last matching severity override is effective.

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

`run.json` also records `capture.reducedMotion`, the `prefers-reduced-motion`
mode every tuple was captured under (`project.capture.reducedMotion`). State
coverage reads it; records written before it existed fall back to a tuple's
motion artifact, and otherwise report both modes missing until recaptured.


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

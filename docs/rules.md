# Rules

Presentation lists rank by severity first (BLOCKER, MAJOR, MINOR, INFO), then by impact, then prominence as measured by the existing salience × prominence score within each tier. Scoring, rule severities and finding identity are unchanged; see [Ranking](#ranking) and [ranking](ranking.md).

Findings have three bases: **measured** means a deterministic rule with its measurement; **observed** means an action, timeline or probe with timing and result; **judged** means model critique, with stated confidence when supplied. Treat judged findings as suggestions. Severity gates count measured and observed findings by default; `--fail-on-judged` includes judged suggestions at the selected severity threshold. Suppression, severity overrides and independent configured published budgets keep their existing behavior.

Deterministic findings retain readable Done when text and an executable `acceptance` rule contract. Verify reruns the existing rule under unchanged settings against the original target/action in both calibrated captures. A matching violation fails even when other evidence is incomplete. A missing action, skipped probe, partial timeline, missing held replay, changed settings or unresolved target produces **not-recheckable**, with a reason, rather than claiming a fix. Current effect-region and animation exclusions remain part of the original rules.


A rule, or check, is a deterministic judgement over the evidence Idiom captured for one state, viewport and colour scheme: the DOM, computed styles and geometry, the screenshot, the axe-core results, the console, and what the interaction probe saw. The same evidence always gives the same findings, so `idiom review <flow> --from <runId> --deterministic-only` re-judges a stored run offline, and `idiom check` gates on it.

Each finding has one of four severities:

- **blocker**: the state did not render as declared, or a published page broke its hard budget. Nothing else about the state can be trusted until it is fixed.
- **major**: a defect people will hit, such as an unreadable label, a dead control or a broken link. `idiom check` fails on major and above by default (`--fail-on major`).
- **minor**: craft debt that is worth fixing but does not block, such as an off-scale value or a lonely last word.

- **info**: informational evidence, ranked below minor. It cannot trip existing severity gates and is omitted from digest alerts.

State coverage is reported next to rule coverage. `idiom coverage --states`, each flow review report and `idiom check` say which viewports, colour schemes, reduced-motion modes, network replays (slow and failure), interactions (probe reach, focus sweep) and declared data states each state was observed in by the latest capture, and the config or flow change that covers each missing one. It measures what was reviewed, not quality. A dimension that cannot apply (no requests to replay, no controls to probe, no data states declared) is not applicable and never counts towards the percentage.

Every check reports coverage as well as findings. A check whose evidence is missing (an older capture, a capture path that cannot record it, or a probe that did not run) reports coverage `unavailable` rather than passing; recapture to measure it. A check you turn off reports `skipped`. A check that intentionally does not evaluate a tuple (`responsive-break` outside the minimum captured CSS width) reports `not-applicable`, shown as "not applicable" in review reports.

Geometry, text and consistency rules judge only painted participants when the capture records that fact. An element is unpainted when it or an ancestor is CSS-hidden, inside a closed details disclosure outside its first summary, at cumulative opacity zero, without rendered area, or fully outside an ancestor's overflow clip. Partially clipped and below-fold elements remain eligible. The gate applies before grouping or majority selection, on both sides of comparisons, to `idiom:elements-overlap`, `idiom:interactive-overlap`, `idiom:text-clipped`, `idiom:element-content-clipped`, `idiom:label-off-centre`, `idiom:adjacent-elements-touch`, `idiom:mixed-label-casing`, `idiom:mixed-locale-spelling`, `idiom:orphan-word`, `idiom:line-too-long`, `idiom:scale-outlier`, `idiom:sibling-select-inconsistent`, `idiom:selected-state-invisible`, `idiom:image-distorted`, `idiom:dead-link-text`, `idiom:native-control-unstyled`, `idiom:popover-covers-control` and `idiom:nested-border`.

Revealed states are checked too. The probe opens every `<details>`, `aria-haspopup` and `aria-expanded` disclosure it reaches and observes what it reveals in place; a menu item one step below a disclosure that switches it into a new mode (a field appears, a surface opens) is followed and observed the same way. `adjacent-gap`, `element-overlap`, `native-control`, `clipped-text` and `overflow-clip` run on each revealed state. Findings are attributed to the state that opened it as `<state> › <disclosure>` (or `<state> › <disclosure> › <item>`), and only what the reveal introduced is reported: a defect the page or the parent disclosure already shows is not repeated. `idiom coverage` lists the disclosures no state showed open and the probe never opened. `idiom coverage` and the report also list the lists, grids, tables, feeds and editors that were empty in every captured state, so you know which to seed.

Coverage reports distinct elements skipped as not painted for each rule and tuple, including zero. This does not turn a running check into a skipped check. Artifacts without painted facts retain their previous findings and coverage. Axe, document overflow, font/link checks, console errors, expectation status and other branches of shared checks retain their existing domains. See [the observation contract](schemas.md) and [animation settling](configuration.md).

Configure checks under `checks.*` in `.idiom/project.json`; every field is optional, and [configuration.md](configuration.md#checks) has the full reference. Some checks are opt-in and do nothing until their block is present.

Decide a finding with `idiom decide`: `--accept` marks it as work worth doing, `--reject` dismisses that occurrence, and `--reject --scope rule` suppresses it in every later run. To change a finding's severity or suppress it by category, flow, state or rule, add an override to `.idiom/rules.json` (see [Rules](configuration.md#rules)). Questions a review cannot settle on its own arrive as `ruling-N` decisions, which `idiom ruling` records in `DESIGN.md`.

## Ranking

Top issues, the report, `sweep`, tickets and `idiom digest` share one deterministic order: severity first; within a severity, impact tier; within each tier, the salience × prominence score; then each list's own stable tie-break.

A finding is in the higher **impact** tier when any of these holds, and in the lower tier only when none does, which is exactly a single-state cosmetic finding:

- **states**: it appears in two or more states;
- **viewports**: it appears at two or more viewports;
- **primary**: its element is a recorded primary action, or sits above the fold in the page's primary region (`<main>` or a marked primary region), at any coordinate where it appears;
- **interactive**: its element is an interactive control (a link, button, input or other focusable control);
- **broken**: its rule reports broken behaviour or obstructed content (salience 9 in the [ranking table](ranking.md#salience)).

The tier never crosses severities: a minor finding on every state still ranks below any major. `check --json` reports each issue's `impact` (1 or 0) and `impactReasons`.

## Checks

### `overflow-clip`

- **Catches:** A document wider than its viewport, and boxes with `overflow: hidden` or `clip` that cut off part of their readable text or a control; a text field whose value is wider than the field is reported separately. A box whose cut-off content is only decoration (a glow, a bleed, a tinted block, imagery) is not reported, nor is content in an `aria-hidden` or `inert` illustration, content a nearer scroller owns, or a marquee track (an infinite translate animation, or repeated text that is translated).
- **Why it matters:** Hidden content is content nobody can read or reach, and a page that scrolls sideways feels broken.
- **Severity:** major; minor for a value truncated inside an `input` or `textarea`.
- **Source:** WCAG 2.2 1.4.10 Reflow, for document overflow; otherwise craft convention: content should not be silently cut off.
- **Configure or decide:** No settings; crop-to-fit media, boxes marked `data-idiom-crop`, and boxes that cut off only decoration, presentational illustrations, scroller-owned content or marquee tracks are exempt. Captures made before this classification keep the previous behaviour. Findings are decided with `idiom decide` or a `.idiom/rules.json` override.

### `responsive-break`

- **Catches:** At the narrowest viewport, two visible interactive elements in normal flow that overlap, confirmed by a hit test at capture. Joined controls (an input group whose shared border overlaps by 1px or less, with squared facing corners) are not reported.
- **Why it matters:** Overlapping controls on small screens hide each other and cause mis-taps.
- **Severity:** major.
- **Source:** WCAG 2.2 1.4.10 Reflow.
- **Configure or decide:** No settings; it runs on the narrowest captured viewport (other viewports report coverage as not applicable), and findings are decided with `idiom decide` or a `.idiom/rules.json` override.

### `contrast`

- **Catches:** Text that fails axe-core's rendered `color-contrast` rule against its background.
- **Why it matters:** Low-contrast text is hard or impossible to read for many people, and in bright light for everyone.
- **Severity:** major for serious or critical axe impact; minor otherwise.
- **Source:** WCAG 2.2 1.4.3 Contrast (Minimum).
- **Configure or decide:** No settings; decide findings with `idiom decide` or a `.idiom/rules.json` override.

### `a11y-label`

- **Catches:** Buttons, links, form fields, selects and ARIA widgets with no accessible name, according to axe-core's naming rules (`button-name`, `link-name`, `label` and similar). This includes enabled SVG-only buttons and links without a name, description or title; default-mode `unexplained-control` delegates fully nameless controls here.
- **Why it matters:** A control without a name is announced as "button" or "edit text", so screen reader and voice control users cannot tell what it does.
- **Severity:** major for serious or critical axe impact; minor otherwise.
- **Source:** WCAG 2.2 4.1.2 Name, Role, Value; for form fields also 3.3.2 Labels or Instructions.
- **Configure or decide:** No settings; decide findings with `idiom decide` or a `.idiom/rules.json` override.

### `target-size`

- **Catches:** Interactive targets without a clickable region containing the required square: 24×24 CSS px for fine pointers, 44×44 for narrow or touch viewports. Native checkbox/radio targets include captured associated label fragments, excluding independent interactive descendants and nonclickable gaps. At the default fine-pointer minimum, undersized targets pass when their centered 24px circle overlaps neither another target nor another undersized target's circle; exact tangency passes. Unpadded inline text links are exempt when their own rendered text sets their size (WCAG 2.5.8's inline exception); icon-only anchors, anchors whose image or inline-block child is taller than the text line, and anchors with a non-link role such as `role="button"` are evaluated like other targets, with no button-role exception. Captures made before this rule change need recapture before icon-only anchors are evaluated.
- **Why it matters:** Small targets are hard to hit, especially by touch or with limited dexterity.
- **Severity:** minor.
- **Source:** WCAG 2.2 2.5.8 Target Size (Minimum) for the 24px figure; the 44px touch figure follows 2.5.5 Target Size (Enhanced) and Apple's Human Interface Guidelines.
- **Configure or decide:** `checks.targetSize` sets `fine`, `coarse` and `narrowBelow` (defaults 24, 44 and 768); spacing relief applies only to the fine-pointer 24px policy. Custom fine minima and narrow/touch captures retain their size requirement. Older captures support spacing but need recapture for label evidence; decide intentional exceptions with `idiom decide`.

### `heading-structure`

- **Catches:** HTML pages with no visible level-one heading or more than one, and headings that skip a level, from axe-core's heading rules and Idiom's own heading scan. Captured non-HTML documents (such as images, JSON and feeds) are skipped. Older captures without a document content type retain the existing checks.
- **Why it matters:** Screen reader users navigate by headings, and a broken outline hides the page's structure from them.
- **Severity:** minor.
- **Source:** WCAG 2.2 1.3.1 Info and Relationships and 2.4.6 Headings and Labels.
- **Configure or decide:** No settings; decide findings with `idiom decide` or a `.idiom/rules.json` override.

### `token-drift`

- **Catches:** Rendered colours and radii on visible elements that do not resolve to a value declared in the project's design tokens. Token values resolve in a separate blank page, so app styles cannot change them and the captured page is never touched. Colours are judged per colour-scheme context: inside a subtree that overrides `color-scheme`, a `light-dark()` token counts only with the value that applies there.
- **Why it matters:** Off-token values drift from the design system one hard-coded colour at a time.
- **Severity:** minor.
- **Source:** Craft convention: rendered values should come from the declared design tokens.
- **Configure or decide:** Runs only when `design.tokensFile` is set in `.idiom/project.json` (otherwise skipped); there are no `checks` settings, so decide findings with `idiom decide` or a `.idiom/rules.json` override.

### `console-error`

- **Catches:** `console.error` calls and uncaught page errors recorded during capture, grouped by message and location. A failed sub-resource is named by its request instead, for example `GET /preview/123?thumbnail=1 returned 500`, with the values of secret-named query keys (`token`, `api_key`, `client_secret` and the like) redacted. When Idiom started the server, a 5xx finding attaches up to 20 lines of the run's `server.log`, from 2 s before the request started to 2 s after its response ended. A Content Security Policy violation names the directive, the blocked resource or `inline`, the offending element, and the owner iframe when it happened inside a frame such as a srcdoc preview. A frame that runs no script at all (`sandbox` without `allow-scripts`) cannot report the element, so its finding keeps the browser's own message.
- **Why it matters:** Errors in the console usually mean something on screen is missing or broken, even when it looks fine.
- **Severity:** major.
- **Source:** Craft convention: a declared state should render without runtime errors.
- **Configure or decide:** A flow's or state's `health.allow.console` patterns exempt expected messages, for route and page states as well as step states. Idiom's own capture scripts add no errors of their own: the only one that runs in sandboxed (opaque-origin) frames such as a `sandbox` srcdoc preview is the CSP listener, which only listens and reports. For a state that declares a non-200 status, only the main-frame document's own load error is ignored (matched against the final document URL after redirects, ignoring any fragment). A subresource that fails with the same URL and status is still reported. Other findings are decided with `idiom decide` or a `.idiom/rules.json` override.

### `missing-state`

- **Catches:** A declared state that failed to capture or failed its `expect` block, and a declared colour scheme that renders identically to the previous one across the whole flow.
- **Why it matters:** If the state you meant to review never rendered, every other judgement about it is unreliable.
- **Severity:** blocker.
- **Source:** Craft convention: every declared state and colour scheme must actually render.
- **Configure or decide:** Configured through the flow's states, `expect` blocks and `colorSchemes`, not `checks`; fix the state or its declaration, or decide with `idiom decide`.

### `spacing-rhythm`

- **Catches:** Buttons, links and inputs whose vertical clearance to the nearest boundary sharply diverges from a strongly prevailing clearance among comparable placements in the same run.
- **Why it matters:** Inconsistent spacing around controls makes a layout feel careless and harder to scan.
- **Severity:** minor.
- **Source:** Craft convention: comparable controls should keep the same spacing rhythm.
- **Configure or decide:** No settings; the rhythm is inferred from the run, so uniformly tight products are not judged. A container edge with no padding or painted border that the measured control itself reaches is the control's own edge, so the clearance is measured past it (content between the control and that edge, such as a padded row, keeps the edge as the boundary); elements parked wholly off the page (a skip link at `left: -9999px` or `top: -40px`) and content in closed disclosures or hidden, inert or `content-visibility: hidden` subtrees are not measured. Findings are decided with `idiom decide` or a `.idiom/rules.json` override.

### `unexplained-control`

- **Catches:** Icon-only or single-glyph controls (`?`, `⋮`) with no visible label, description or tooltip, and disabled controls that give no reason.
- **Why it matters:** People cannot use a control whose meaning they have to guess.
- **Severity:** major for enabled controls; minor for disabled ones and for probed single-glyph controls in the default mode.
- **Source:** Craft convention: a control's purpose should be visible, not only exposed to assistive technology.
- **Configure or decide:** In default mode, fully nameless icons belong to `axe:button-name` / `axe:link-name`; a glyph-only accessible name such as `aria-label="i"` belongs to this check, and a non-empty native `title` counts as the explanation (the browser shows it on hover after a delay no capture can observe). `checks.explanation` set to `"visible"` requires a visible explanation on hover and focus, so a native title alone is not enough; `checks.probe` (on by default) supplies tooltip evidence and its `skip` list exempts controls; decide findings with `idiom decide`.

### `text-centering`

- **Catches:** Single-line labels in chips, buttons and badges sitting off their box's vertical centre; an open box with a single top or bottom rule (a divider or underline) is measured against its content box.
- **Why it matters:** Off-centre labels are a small misalignment people notice without knowing why.
- **Severity:** minor.
- **Source:** Craft convention: labels sit on their box's optical centre.
- **Configure or decide:** `checks.centeringTolerance` sets the allowed offset (default 1.5px). Values below 1.5px are raised to 1.5px, and large type allows 8% of its font size, because font metrics and pixel-snapped line boxes alone put a symmetric label up to about 1.4px off. Filled or fully bordered shapes are still measured edge to edge. Decide findings with `idiom decide`.

### `adjacent-gap`

- **Catches:** Neighbouring controls closer than the minimum gap, including a focused field's ring, and bordered shapes that touch inside the same parent. Targets (and descendants) controlled by collapsed `aria-expanded="false"` triggers, opacity-zero or visibility-hidden subtrees, and transforms that move a subtree fully outside the viewport are excluded. Partially visible transforms and ordinary below-fold content stay eligible. Keycap glyph groups (⌘ K) and the contents of illustrations or static, non-selectable mock-ups with no controls are not compared.
- **Why it matters:** Controls jammed together look like one control and are easy to mis-hit.
- **Severity:** major when they touch or overlap (gap of 0.5px or less); minor otherwise.
- **Source:** Craft convention: separate controls need visible separation.
- **Configure or decide:** `checks.minGap` (default 3px) sets the minimum, and `checks.adjacentGap` takes extra flush `regions` and `indicatorMax` (default 16px). Content in a closed `<details>` (outside its summary) or a `hidden`, `inert` or `content-visibility: hidden` subtree is not compared. Decide findings with `idiom decide`.

### `dead-affordance`

- **Catches:** Text that reads or looks like a link or action ("View terms", "Learn more") but is plain text, disabled buttons with navigation copy, and `href="#"` placeholder links. Text inside a non-interactive illustration frame is not reported as dead link text: an `aria-hidden`, `inert` or `role="img"` subtree, or the root of a `user-select: none` region at least 200×120 px with six or more text pieces, with no focusable descendants (a picture of product UI, such as a launcher window on a marketing page).
- **Why it matters:** An affordance that leads nowhere breaks trust in every other link on the page.
- **Severity:** major for link-like plain text; minor for disabled link-like buttons and `href="#"` placeholders.
- **Source:** Craft convention: anything that looks clickable should do something.
- **Configure or decide:** No settings; accept or dismiss individual instances with `idiom decide`, or override them in `.idiom/rules.json`.

### `dead-control`

- **Catches:** Enabled buttons that change nothing observable when the probe clicks them. Real disclosure mutations, including delayed openings in Radix popper wrappers, count as effects; tooltip-only and transient focus/hover changes do not. A request counts only when the click itself started it and either something visible follows or the request would change data (POST, PUT, PATCH or DELETE); background polling, analytics and keepalive traffic never excuse a control, and the finding lists them as "only background requests observed".
- **Why it matters:** A button that does nothing looks like a broken product.
- **Severity:** major.
- **Source:** Craft convention: every enabled control should have an effect.
- **Configure or decide:** Needs the interaction probe, on by default (`checks.probe`). The probe never clicks a control whose click is a no-op by design: a selected tab or option (`aria-selected`), a checked radio or menu radio (`aria-checked`, `:checked`, or the label of a checked radio) and the current item (`aria-current`). Switches and checkboxes toggle, so they are still probed. `checks.probe.respectControlIntent` additionally skips pressed toggles and drag handles. Exempt controls with `checks.probe.skip` and decide findings with `idiom decide`.

### `duplicate-entry`

- **Catches:** Two or more persistent controls in different places that open the same panel or focus the same field, following one level of menus, and two adjacent triggers (within 16px, in one toolbar, group or row) whose menus list identical items in the same order. Distant triggers with the same menu are not compared.
- **Why it matters:** Duplicate entry points clutter the interface and make people wonder whether they do different things.
- **Severity:** minor.
- **Source:** Craft convention: one destination, one entry point.
- **Configure or decide:** Needs the probe (`checks.probe`, on by default); per-row actions in repeated lists are excluded, and findings are decided with `idiom decide`.

### `component-size`

- **Catches:** Components rendering outside an explicit width, height or both (names optional), or a size stated next to a name in `DESIGN.md`.
- **Why it matters:** Components that grow or shrink unexpectedly break the layout around them.
- **Severity:** minor.
- **Source:** Craft convention: components should render at their declared size.
- **Configure or decide:** Declare components and tolerances in `checks.components`, or state sizes in `DESIGN.md`; decide findings with `idiom decide`.

### `copy-lint`

- **Catches:** Code identifiers and token paths in copy, stuttered words, sibling labels cased two ways, mixed locale spelling, and glossary, retired or jargon terms. Casing comparisons exclude capitalised multi-word linked names with a page destination and either a matching title attribute or `<cite>` ancestry; full anchor text covers inline spans. This evidence-based heuristic can also exempt authored title-case navigation with matching metadata. Ordinary labels without that evidence still compare, and glossary/term checks still apply to linked names. Locale spelling skips text inside a page link that names a titled page (title metadata matching the full link text of two or more words, case-insensitively; `<cite>` ancestry; or a capitalised name with any title metadata) and spans matching declared `properNouns`. Other UI strings, including single-word, untitled and mismatched-title links, still report; a multi-word nav link whose title repeats its text is exempt by the same evidence.
- **Why it matters:** Engineering names and inconsistent wording make a product feel unfinished and harder to learn.
- **Severity:** major for code identifiers, raw token paths and repeated words; minor for casing, spelling and term policy.
- **Source:** Craft convention: copy is written for people, consistently.
- **Configure or decide:** `checks.copy` sets `locale`, `retired`, `jargon`, `glossary`, `schemaWords` and `properNouns` (also readable from `.idiom/glossary.json`); decide findings with `idiom decide`.

Every sub-check excludes `pre`, `code`, `kbd`, `samp`, `textarea`, the effective ARIA `code` role and their descendants. Both copy-lint and error-text also exclude block elements with page-applied monospace typography (generic `monospace`/`ui-monospace`, Menlo, Monaco, Consolas, Courier/Courier New or SFMono-Regular). This requires an authored font declaration or an observed font-family change from the parent; inline emphasis and inline-block controls stay eligible. Custom font names alone do not establish code context.

Balanced straight or curly single/double quotes, `q` and `blockquote` exempt only the repetitions wholly inside the quotation. Other copy checks still inspect quoted wording. Figure captions need quoted content; an unquoted caption remains copy. Fresh captures preserve nested quote context and separate text on either side of inline code. Recapture older observations for those precise boundaries; their fallback uses local balanced quotes and semantic quotation ancestry.

### `glyph-icon`

- **Catches:** Unicode glyphs (`▾ ◉ ▣ ×`) standing in for icons inside controls.
- **Why it matters:** Glyphs render inconsistently across fonts and platforms and are often read aloud literally.
- **Severity:** minor.
- **Source:** Craft convention: icons come from the icon set, not from text.
- **Configure or decide:** `checks.glyphAllow` lists glyphs you use on purpose; decide other findings with `idiom decide`.

### `error-text`

- **Catches:** Engineering failures shown on screen, such as "Renderer failed", stack traces, `[object Object]` and raw JSON.
- **Why it matters:** Internal errors on screen confuse people and expose implementation details.
- **Severity:** major.
- **Source:** Craft convention: failures should be explained in human terms.
- **Configure or decide:** `checks.errorPatterns` adds your own patterns to the built-in ones; decide findings with `idiom decide`.

Uses the same semantic tags, effective `code` role and authored block-monospace exclusions as copy-lint, including nested highlighted spans. Inline monospace emphasis and inline-block controls remain eligible. These exclusions also apply to configured signatures.

Error-text reports a failure message and skips documentation prose that explains one. Text is a failure message when it sits on a failure surface: an element (or ancestor) with role `alert`, `alertdialog`, `status` or `log`, a `polite` or `assertive` live region, an `output`, or a class name with an error-ish part such as `error-banner`, `toast`, `form__error`, `empty-state` or `thumb-failed` (`banner` alone does not count). A short standalone line, any sentence under 8 words, is a failure message wherever it sits. Text is explanatory prose when it sits inside `main` or `article`, off every failure surface, and the sentence naming the signature has 8 or more words and mentions it mid-sentence or in quotes, or the whole paragraph runs to 40 words or more.

Only phrase signatures can be explanatory: render and load failures, generic errors, exception names and messages, and system error codes. Stack traces, `[object Object]`, an unrendered `undefined` or `null`, raw JSON and every `checks.errorPatterns` entry always report, wherever they sit and whatever else the text says.

Still reported:

- An alert banner reading `Renderer failed`.
- A toast showing `TypeError: x is not a function at render (app.js:12:7)`.
- The line `Failed to load images` under an image grid, even inside `main`.
- A help paragraph that prints `[object Object]`, because leaks always report.

Skipped as explanation:

- A help paragraph explaining that when a thumbnail says “Failed to load”, the browser could not fetch the image file.
- A reference entry noting that visible images that failed to load or decode render as broken images.

The trade-off: a real failure written as a long sentence inside `main`, with no alert role, live region or error class, reads as explanation, so give failure messages one of those. Captures without ancestor records still find `main` and `article` by tag, but roles and classes on missing ancestors are not seen; recapture for precise boundaries.

### `native-control`

- **Catches:** Browser-default selects or checkboxes shown beside the product's own styled versions (`idiom:native-control-beside-custom`), and a `file`, `date`, `color` or `range` input painting the browser's default chrome in the product with no styled replacement (`idiom:native-control-unstyled`): the raw "Choose file / No file chosen" control, a default date field, swatch or slider. An input hidden behind a styled label (zero opacity, visually hidden or unpainted) is not flagged. The first rule could never see a lone file input, since it fires only beside a styled sibling of the same kind; the second judges each input on its own, including inside opened menus.
- **Why it matters:** Mixing native and custom controls makes the interface look stitched together, and a raw file input in product chrome reads as unfinished.
- **Severity:** minor; major for a default file input.
- **Source:** Craft convention: one control style per kind of control.
- **Configure or decide:** No settings; decide findings with `idiom decide` or a `.idiom/rules.json` override.

### `layout-invariants`

- **Catches:** Violations of the layout assertions a flow declares: dimensions, edge alignment, offsets between edges, and missing protected structure.
- **Why it matters:** These are the structural promises you made about the layout, so breaking one is a regression by definition.
- **Severity:** major.
- **Source:** Project declaration: the `invariants` you write in the flow manifest.
- **Configure or decide:** Declared in the flow's or state's `invariants` array, not in `checks`; no declaration means no findings, and findings are decided with `idiom decide`.

### `group-invariants`

- **Catches:** Items in a declared list whose attribute or text does not match the list owner's value, such as another project's pages in a page switcher.
- **Why it matters:** A list that mixes in items from somewhere else shows people the wrong data.
- **Severity:** major.
- **Source:** Project declaration: the `group` invariants you write in the flow manifest.
- **Configure or decide:** Declared as `group` entries in the flow's `invariants` array, not in `checks`; decide findings with `idiom decide`.

### `selected-state`

- **Catches:** Radio groups, tabs, listboxes, segmented controls and swatch grids with no option marked selected, several selected in a single-select group, or a selected option that looks the same as the others. Explicit, homogeneous checkbox groups (`fieldset` or `role=group`) also receive the visual comparison; zero or multiple checked options are valid. Native radios and checkboxes use their live checked state; ARIA radio and checkbox controls use `aria-checked`. Custom indicators inside associated labels or an unambiguous single-control wrapper contribute painted borders, fills, SVG and pseudo-elements. Hidden indicators and paint from neighboring options do not establish a visible selection.
- **Why it matters:** People need to see the current choice, and assistive technology needs it exposed.
- **Severity:** major for several selected or an invisible selection; minor when nothing is marked selected.
- **Source:** WCAG 2.2 4.1.2 Name, Role, Value for the exposed state; craft convention for the visible difference.
- **Configure or decide:** `checks.selectedState` sets `minColorDelta` (default 24), how far a colour must move to count as visible; decide findings with `idiom decide`.

### `dialog-shell`

- **Catches:** Open dialogs with a missing or doubled heading, no visible close control, a primary action scrolled out of view without a sticky footer, or a title size the run's other dialogs do not use.
- **Why it matters:** A dialog people cannot identify, close or complete traps them.
- **Severity:** major for a missing heading, a missing close control or an off-screen primary action; minor for a doubled heading or an inconsistent title size.
- **Source:** Craft convention: dialogs share one titled, closable, completable shell.
- **Configure or decide:** No settings; only dialogs open in a captured state are judged, and findings are decided with `idiom decide`.

### `disguised-control`

- **Catches:** Buttons that read or look like text fields, and readonly or disabled fields drawn as editable with no stated reason.
- **Why it matters:** People try to type into a button, or try to edit a field that will not accept input.
- **Severity:** major.
- **Source:** Craft convention: a control should look like what it is.
- **Configure or decide:** `checks.disguisedControl` adds `placeholderPatterns` and `ignore` selectors for deliberate field-shaped triggers; decide findings with `idiom decide`.

### `fresh-state`

- **Catches:** On states marked `fresh`, enabled undo or redo controls and visible "unsaved changes" indicators.
- **Why it matters:** A product that has just opened has nothing to undo or save, so these signals are false.
- **Severity:** major.
- **Source:** Craft convention: a first load shows no history and no unsaved work.
- **Configure or decide:** Runs only on states with `"fresh": true`; `checks.freshState` adds history and unsaved patterns and selectors, and findings are decided with `idiom decide`.

### `mirrored-control`

- **Catches:** Declared mirrored pairs, such as two panel collapse buttons, that differ in size, element kind, type or distance from their panel's edge.
- **Why it matters:** Mirrored controls that do not match make the layout look lopsided.
- **Severity:** minor.
- **Source:** Craft convention: mirrored controls should be mirror images.
- **Configure or decide:** Opt-in through `checks.mirrored` pairs; decide findings with `idiom decide`.

### `motion`

- **Catches:** Panels, drawers, menus and dialogs that snap open with no transition (`idiom:motion-no-transition`); content that snaps after an action (`idiom:motion-snap`): tab and segmented-control content swaps, inline expand/collapse, list items added or removed, toasts and status messages, and client-side route changes that swap the main content; observed durations outside the configured scale or maximum; and motion that still runs under reduced motion. A content snap is a visible change of at least `minExtentPx` with no animation or transition on the changed element or an ancestor and no View Transition. Text-only changes (counters, echoed input, a status line whose existing, unpainted element only receives its text), smaller changes, focus rings and changes to the clicked control itself are not snaps; a toast or status box that paints a background, border or shadow still is. Each surface and kind of change is one finding listing every action that produced it.
- **Why it matters:** When opening or changing something goes boom, boom, the app feels jarring and cheap. Slow motion feels sluggish, and motion that ignores the reduced-motion preference can make people unwell.
- **Severity:** major for snaps (overlay and content) and for motion running under reduced motion; minor for durations.
- **Source:** WCAG 2.2 2.3.3 Animation from Interactions (AAA) for reduced motion; craft convention for timing.
- **Configure or decide:** `checks.motion` sets `maxMs` (default 150), `durations`, extra `selectors` and `minExtentPx` (default 24), and `capture.reducedMotion` picks the audit. Under reduced motion an instant change is correct, so snaps are judged only under normal motion: in a reduced-motion capture (the default) the probe replays each suspected content snap once under normal motion to confirm it (one replay per surface and kind, six per state); web steps are judged in a `reducedMotion: false` capture or when the probe confirmed the same surface. Needs the probe or declared web steps, and findings are decided with `idiom decide`.

### `element-overlap`

- **Catches:** Controls or text in the same layer whose boxes intersect, including partly visible elements, with both selectors and the overlap size (`idiom:elements-overlap`). The deliberate exception to keeping layers apart is `idiom:popover-covers-control`: an open overlay (a menu, listbox, popover, non-modal dialog, or a disclosure's positioned content) whose box covers a visible, enabled field outside it, or the control that opened it beyond a 4px anchor-edge allowance, confirmed by sampling the covered area with the browser's hit test. Tooltips and modal dialogs are excluded.
- **Why it matters:** Overlapping elements hide each other and can make controls unclickable.
- **Severity:** major when a control is involved or the overlap covers at least a quarter of the smaller element; minor otherwise, and always minor when no hit-test point could confirm it (below the fold, geometry only). Ambiguous card actions produce one info finding per repeated card group, with an affected-card count. Confirmed obstructions retain their severity. A popover over a field is major when the hit test confirms it; over its own trigger, or geometry only, minor.
- **Source:** Craft convention: elements in one layer should not collide.
- **Configure or decide:** No settings; menus, dialogs, tooltips (including chart-library tooltip layers) and pointer-events:none overlays are kept apart from content beneath them. A subsidiary action over its own card link is intentional when both belong to the same local card and pointer samples reach the action and the link outside it. This includes grid stacking, partial-cover links and actions extending past their own link edge. A control stacked under the link, or over another card's link, still is. Findings are decided with `idiom decide`.

### `clipped-text`

The carousel-peek exemption examines only ancestors strictly inside the actual clipping owner. Self-clipping text has no such ancestors; unrelated neighboring layout panels cannot exempt it. Ancestor-owned carousel peeks, repeated translating tickers, ellipsis/clamp and harmless font overruns retain their exclusions.

- **Catches:** Single-line or wrapped labels cut off without an ellipsis, including clipped menu items.
- **Why it matters:** A label missing its end can say the wrong thing or nothing at all.
- **Severity:** major.
- **Source:** Craft convention: truncation should be visible and intentional.
- **Configure or decide:** No settings; intentional ellipses, line clamps and scrollable content are excluded. Small overruns below measured font descender space are excluded only when every line is readable and its glyph ink fits. Active repeated tracks translating through a clipping strip are excluded horizontally; independent nested clips and vertical slicing still report. Recapture saved observations to apply these exclusions; findings are decided with `idiom decide`.

### `field-group`

- **Catches:** Label, control and helper text stacks that touch, and too little space between separate field groups. Inner label gaps use text-node client rectangles, including nested and multiline captions, rather than tall line boxes; helper and between-group measurements keep their layout rectangles. Older artifacts without text geometry retain their previous results.
- **Why it matters:** Cramped form groups make it unclear which label belongs to which field.
- **Severity:** major when parts touch (0.5px or less); minor otherwise.
- **Source:** Craft convention: related form parts sit together, separate groups sit apart.
- **Configure or decide:** `checks.fieldGroups` sets `inner` (default 4px) and `between` (default 12px). Fields in a closed `<details>` (outside its summary) or a `hidden`, `inert` or `content-visibility: hidden` subtree are not measured. Decide findings with `idiom decide`.

### `scale-conformance`

- **Catches:** Spacing, control heights, corner radii and border colours off the declared scale, or, without a scale, sharp outliers from the run's prevailing value; control shadows (outliers only).
- **Why it matters:** Values off the scale accumulate into a layout that never quite lines up.
- **Severity:** minor.
- **Source:** Craft convention: dimensions and colours come from a small, declared scale.
- **Configure or decide:** `checks.scales` declares spacing, control heights, radii, border colours and role selectors; decide findings with `idiom decide`. Without a declared scale, a value is compared only with peers in the same viewport, colour scheme and role, and dividers split into heading rules, table borders and other rules. Borders on inline text (dotted underlines, abbreviations) are not dividers, and radius is judged only on boxes with a visible background, border or shadow. Spacing is not read from unpainted elements or from closed disclosures and hidden, inert or `content-visibility: hidden` subtrees. When one off-scale value repeats in one context, it becomes a single design-system question instead of separate findings (see below).

When the same off-scale value keeps appearing in the same place, the system is probably missing a step rather than the page making the same mistake many times. In project runs (review, check, fix, baseline, verify), declared-scale drift (spacing, control heights, radii, border colours) is grouped by property, value and context. Values within 1px of each other count as one value, as do identical colours. The context is the nearest landmark, the component (the nearest `data-node-id`, the matching `checks.scales.roles` selector, the default role, or else the tag and its first class) and the viewport. A group needs at least `checks.scales.suggestAfter` occurrences (default 5) across at least two states or three distinct elements. Light and dark captures of an element count once, and two kinds of value never count toward a question: off-canvas content, such as a carousel's parked slides, and values that fall back from an unresolved custom property. A broken token is a defect, not a missing step. It then becomes one ruling question, for example "17px padding appears 34 times on .row-control in main at desktop, between your 16px and 24px steps. Add a step for this context, or keep reporting it as drift?". Reports and `idiom check` list it under "Design system questions" with the count, the nearest declared steps, a suggested token name and crops of three examples. Its occurrences are not counted as findings, so they never crowd the top issues.

There are three answers. `idiom ruling --decision ruling-N --add-step [--token <name>]` (or `idiom_decide` with `add-step`) appends the step to DESIGN.md as a recorded ruling. Values in that context within 1px of the step are then on scale, and their findings close as resolved by ruling. `--drift` records that the value should keep being reported, and it comes back as one finding that lists every occurrence. To skip, don't answer: nothing is recorded, and the question is asked again next run. Idiom never edits `.idiom/project.json`, and the only thing it writes to DESIGN.md is a ruling you confirmed. Groups that don't qualify, and undeclared outliers, are reported as before. `idiom quick` asks no questions.

### `control-anatomy`

- **Catches:** A select chevron or an icon in an icon button or segmented control more than 1px off its label's centre, and sibling selects with different inner padding or chevron size. Sibling comparisons require matching control family (native select, combobox or labelled listbox trigger), host type and role; icon-only action/menu buttons are excluded.
- **Why it matters:** Misaligned chevrons and icons make controls look slightly broken.
- **Severity:** minor.
- **Source:** Craft convention: a control's parts align on one centre line.
- **Configure or decide:** No settings; decide findings with `idiom decide` or a `.idiom/rules.json` override.

### `luminance-parity`

- **Catches:** In light and dark captures, a field, card or panel that stays light (or dark) while its container and neighbours flip, and primary-action labels under 4.5:1 contrast in either scheme.
- **Why it matters:** A surface that does not follow the theme glares in dark mode or disappears in light mode, and a primary action must be readable in both.
- **Severity:** major.
- **Source:** WCAG 2.2 1.4.3 Contrast (Minimum) for primary-action labels; craft convention for theme parity.
- **Configure or decide:** `checks.luminanceParity` adds `primarySelectors` and `ignore` selectors for fixed-colour content; parity needs both colour schemes in one run, and findings are decided with `idiom decide`.

### `frame`

- **Catches:** The configured primary frame with no fill step, visible border or shadow separating it from its surround on any edge.
- **Why it matters:** A frame that blends into its background loses the boundary of the main working area.
- **Severity:** major.
- **Source:** Craft convention: the main frame should be visibly separate from its surround.
- **Configure or decide:** Opt-in: runs only when `checks.frame` sets a `selector`, with `minLuminanceDelta` defaulting to 0.05; decide findings with `idiom decide`.

### `primary-region`

- **Catches:** The declared primary region narrower than its minimum share of the viewport width.
- **Why it matters:** When chrome crowds out the main region, the work itself gets too little room.
- **Severity:** major.
- **Source:** Craft convention: the primary region gets most of the screen.
- **Configure or decide:** Opt-in through `checks.primaryRegion` with a `selector` and `minShare`; decide findings with `idiom decide`.

### `alarm-at-rest`

- **Catches:** Warning glyphs, alert-named icons, or red or configured warning colours on icons with no error or warning around them.
- **Why it matters:** Alarm colours and icons at rest make people think something is wrong when nothing is.
- **Severity:** minor.
- **Source:** Craft convention: warning signals are reserved for warnings.
- **Configure or decide:** `checks.alarm` sets warning `colors`, `brand` colours and `ignore` selectors, and `checks.errorPatterns` adds status text that counts as an error; decide findings with `idiom decide`.

### `cross-surface-naming`

- **Catches:** One `data-node-id` labelled differently across the declared surfaces, such as a tree, breadcrumb, selection chip and toolbar.
- **Why it matters:** The same object under two names makes people wonder whether they are looking at two things.
- **Severity:** minor.
- **Source:** WCAG 2.2 3.2.4 Consistent Identification.
- **Configure or decide:** Opt-in: declare at least two surfaces in `checks.naming`; decide findings with `idiom decide`.

### `published-budget`

- **Catches:** On published flows, horizontal document overflow, broken images, serious or critical axe violations, and pixel drift beyond the recorded baseline's budget.
- **Why it matters:** Published pages are what visitors see, so they are held to a hard budget.
- **Severity:** blocker.
- **Source:** WCAG 2.2 1.4.10 Reflow and axe-core's serious and critical rules; craft convention for images and pixel drift.
- **Configure or decide:** Runs only on flows with `"kind": "published"`, with `budget.maxDiffRatio` in the flow; a rejected decision from `idiom decide` still suppresses a finding.

### `empty-state`

- **Catches:** Empty lists, tables, grids and declared canvases with no call to action or explanatory text.
- **Why it matters:** A blank region with no guidance leaves people unsure whether something failed or what to do next.
- **Severity:** major for regions you declare; minor for regions found automatically.
- **Source:** Craft convention: an empty state explains itself and offers a next step.
- **Configure or decide:** `checks.emptyState` takes declared `regions`, `auto` (default true) and `ignore` selectors; decide findings with `idiom decide`.

### `progress-affordance`

- **Catches:** Web steps marked `longRunning` that show no spinner, progress bar, `aria-busy` or status text change within the configured time.
- **Why it matters:** Without feedback, people assume a slow action has failed and try again.
- **Severity:** major.
- **Source:** Usability heuristic: visibility of system status.
- **Configure or decide:** Mark steps `longRunning` in the flow; `checks.progressWithinMs` sets the limit (default 1000ms), and findings are decided with `idiom decide`.

### `page-content`

- **Catches:** Lorem ipsum and placeholder copy, a hero or final section with no button-styled call to action, images with no alt text, and, with a brief, statistics the brief does not contain.
- **Why it matters:** Placeholder copy, missing calls to action and invented numbers make a generated page unready to publish.
- **Severity:** major; images without alt text follow axe impact (major for serious or critical, minor otherwise).
- **Source:** WCAG 2.2 1.1.1 Non-text Content for alt text; craft convention for copy and calls to action.
- **Configure or decide:** Opt-in through `idiom review --page` or `checks.page`, which takes `ctaSelectors`, `placeholderPatterns` and `claimsAllow`; decide findings with `idiom decide`.

### `band-edges`

- **Catches:** Top-level page bands whose content gutters differ from the dominant left or right edge by more than the tolerance, per viewport.
- **Why it matters:** Sections that do not share edges make a page look misaligned as it scrolls.
- **Severity:** minor.
- **Source:** Craft convention: page bands share one content gutter.
- **Configure or decide:** Opt-in through `checks.bandEdges`, with `tolerance` defaulting to 8px; full-bleed media is exempt, and findings are decided with `idiom decide`.

### `word-break`

- **Catches:** Words in headings and buttons split across rendered lines without a hyphen, per viewport.
- **Why it matters:** A broken word in a heading or button is hard to read and looks like a layout bug.
- **Severity:** major.
- **Source:** Craft convention: words wrap whole or with a visible hyphen.
- **Configure or decide:** Opt-in through `checks.wordBreak`; decide findings with `idiom decide`.

### `shell-visibility`

- **Catches:** A declared app shell that scrolls or extends beyond the viewport, and declared floating overlays that intersect each other.
- **Why it matters:** An app shell that scrolls as a whole, or overlays that cover each other, hide the controls people need.
- **Severity:** major.
- **Source:** Craft convention: an app shell fits its viewport and its overlays do not collide.
- **Configure or decide:** Opt-in through a flow's `shell` selector and `checks.shellVisibility` `floatingOverlays`; decide findings with `idiom decide`.

### `compound-control`

- **Catches:** A short token such as a unit shown twice in one field, and adornments that cross an input's border, sit too close to its inner edge, or lie over its content.
- **Why it matters:** Doubled units and cramped adornments make compound fields hard to read and type into.
- **Severity:** major when an adornment crosses the border; minor otherwise.
- **Source:** Craft convention: an adornment sits inside the field's padding and says each thing once.
- **Configure or decide:** Opt-in through `checks.compoundControls`, with `tokenMax` (default 4) and `minInset` (default 2); decide findings with `idiom decide`.

### `sibling-chrome`

- **Catches:** A named control that every other declared sibling state shows inside a chrome region, but one state lacks.
- **Why it matters:** Chrome that changes between sibling screens makes people hunt for controls that moved or vanished.
- **Severity:** major.
- **Source:** Craft convention: sibling screens share the same chrome.
- **Configure or decide:** Opt-in through `checks.siblingChrome` `regions` plus sibling groups on the states; decide findings with `idiom decide`.

### `touch-reachability`

- **Catches:** On touch viewports without hover, enabled controls hidden at rest that only CSS hover on their owner reveals.
- **Why it matters:** Touch screens have no hover, so these controls cannot be reached by touch at all.
- **Severity:** major.
- **Source:** Craft convention: every action must be reachable without hover on a touch device.
- **Configure or decide:** Opt-in through `checks.touchReachability`, which takes `ignore` selectors, on viewports declared with `"touch": true`; decide findings with `idiom decide`.

### `liveness`

- **Catches:** Declared or timer-like text, sampled twice about 1.5 seconds apart, that stays unchanged or shows all zeros.
- **Why it matters:** A countdown or live counter that never moves looks broken or misleads people about time.
- **Severity:** major.
- **Source:** Craft convention: live values should visibly update.
- **Configure or decide:** Opt-in through `checks.liveness`, with `selectors`, `auto` (default true) and `ignore`; decide findings with `idiom decide`.

### `media-fill`

- **Catches:** Thumbnails in a gallery of three or more repeated cards whose frame shows a solid backdrop band at an edge, letterboxing, or nothing at all.
- **Why it matters:** Thumbnails that do not fill their frames make a gallery look unfinished.
- **Severity:** major when at least three frames and half the gallery share the defect; minor otherwise.
- **Source:** Craft convention: gallery media fills its frame.
- **Configure or decide:** On by default; `checks.mediaFill` sets `bandThreshold` (0.2), `tolerance` (8), `ignore`, and `auto: false` turns it off; decide findings with `idiom decide`.

### `visual-blank`

- **Catches:** `idiom:visual-blank`: visible media at least 120 × 80 CSS px whose screenshot interior has a dominant quantized colour covering at least 99.5%, effective opacity at most 1%, a rectangular cover with at least 98% alpha over at least 99.5% of the visible area, or a video without a poster or painted frame. Includes lone images, pictures, canvases, iframe previews, background images and empty skeleton/media placeholders.
- **Why it matters:** A preview can remain a tinted box without producing a load error.
- **Severity:** minor, including multiple affected surfaces.
- **Source:** Original Idiom screenshot measurement and fixtures authored for blank media; 16-level RGB buckets over every interior pixel, excluding border, padding and a 2 CSS px edge inset.
- **Configure or decide:** On by default; `checks.visualBlank.enabled: false` disables it. `checks.visualBlank.swatchSelectors` exempts colour swatches, including matching wrappers; accessible names or role descriptions identifying a colour/swatch also exempt them. Mask intersections and unavailable crops cannot prove a blank or an acceptance. Old captures disclose unavailable coverage; recapture to measure, or decide findings with `idiom decide`.

### `loading-stuck`

- **Catches:** `idiom:loading-stuck`: a visible spinner, skeleton, busy region or indeterminate progress indicator continuously active for the state's ready-relative loading window (default 5000 ms), with its observed duration. Replaced nodes and separate intervals never add together.
- **Why it matters:** Feedback that never resolves can leave a page unusable while appearing to load normally.
- **Severity:** minor.
- **Source:** Original Idiom continuous observation and authored timing fixtures; monotonic interval ages, mutation tracking and 50 ms visibility sampling.
- **Configure or decide:** On by default; `checks.loadingStuck.enabled: false` disables the added scan/wait. A state may set positive integer `loadingSettleMs` independently of visual `settleMs`, or `loading: true` to declare intentional loading. Readiness means DOM-ready navigation plus all declared steps; the window overlaps existing settle/animation waits. Determinate progress and decorative rotating icons pass. Old or shortened/missing observations cannot prove acceptance; decide findings with `idiom decide`.

### `collection-actions`

- **Catches:** Declared collections of user-created objects whose items do not offer open, rename or delete from the item, its menu or its context menu.
- **Why it matters:** People expect to manage the things they create where they see them.
- **Severity:** minor (an advisory heuristic).
- **Source:** Craft convention: objects people create can be opened, renamed and deleted in place.
- **Configure or decide:** Opt-in through `checks.collections`, each with a `selector` and optional `actions`; reading menus needs `checks.probe`, and findings are decided with `idiom decide`.

### `font-loading`

- **Catches:** A web font used by visible text that failed or never loaded, or renders in the fallback font, naming the family, the failing URL and the affected selectors.
- **Why it matters:** A missing web font changes the product's typography and often its layout, without any visible error.
- **Severity:** major.
- **Source:** Craft convention: the typeface you ship is the one people see.
- **Configure or decide:** On by default; `checks.fonts` with `enabled: false` turns it off, and findings are decided with `idiom decide`.

### `broken-link`

- **Catches:** Visible links that answer 4xx or 5xx or fail to resolve; 401, 403, 407 and 429 answers and timeouts are left unchecked and never reported.
- **Why it matters:** A broken link is a dead end that sends people away from what they came for.
- **Severity:** major for same-origin links; minor for external links.
- **Source:** Craft convention: every link should lead somewhere.
- **Configure or decide:** On by default for same-origin links; `checks.links` sets `enabled`, `external` (default false), `timeoutMs` (5000), `budgetMs` (30000), `concurrency` (4) and `ignore` prefixes, and findings are decided with `idiom decide`.

### `focus-visible`

- **Catches:** A control whose keyboard focus changes no outline, ring, border, background or shadow.
- **Why it matters:** Keyboard users cannot see where they are without a visible focus indicator.
- **Severity:** major.
- **Source:** WCAG 2.2 2.4.7 Focus Visible.
- **Configure or decide:** On by default and needs the probe pass; `checks.focusVisible` sets `enabled` and `ignore` selectors, `checks.probe.skip` also applies, and findings are decided with `idiom decide`.

### `line-length`

- **Catches:** Multiline body paragraphs whose longest rendered text line exceeds the maximum character count (grapheme clusters, including rendered internal spaces). Single-line paragraphs are exempt.
- **Why it matters:** Very long lines are tiring to read and make it hard to find the start of the next line.
- **Severity:** minor.
- **Source:** WCAG 2.2 1.4.8 Visual Presentation (AAA), which recommends at most 80 characters; the default allows 90.
- **Configure or decide:** On by default; `checks.lineLength` sets `enabled` and `max` (default 90), and findings are decided with `idiom decide`. Recapture older saved observations to replace their width-based estimates with measured rendered-line counts.

### `orphan-word`

- **Catches:** Headings and button labels whose last line holds a single short word, per viewport. Only words whose own text is painted and not clipped away by an ancestor count, and a stranded word that leaves no ink in the captured screenshot is skipped (counted in coverage as not visible in the captured screenshot). Inline buttons running through copy (for example `role="button"` sentences) are not labels, like inline links. The crop shows the measured text block.
- **Why it matters:** A lone word on the last line makes a heading or label look unbalanced.
- **Severity:** minor.
- **Source:** Craft convention: typographic orphans weaken short display text.
- **Configure or decide:** On by default; `checks.orphanWord` sets `enabled` and `maxChars` (default 7), and findings are decided with `idiom decide`.

### `image-distortion`

- **Catches:** Images drawn with `object-fit: fill` more than the tolerance out of their natural aspect ratio and by at least 1px on either axis after the best proportional scaling; SVG is exempt.
- **Why it matters:** Stretched or squashed images look broken and distort people and products.
- **Severity:** major.
- **Source:** Craft convention: images keep their natural proportions.
- **Configure or decide:** On by default; `checks.images` sets `enabled` and `distortionTolerance` (default 0.03), shared with `broken-image`. The 1px floor is fixed and applies to existing captures without recapture. Findings are decided with `idiom decide`.

### `broken-image`

- **Catches:** Visible images that failed to load or decode and render as broken images.
- **Why it matters:** A broken image leaves a hole in the page and signals neglect.
- **Severity:** major.
- **Source:** Craft convention: every image on the page should load.
- **Configure or decide:** On by default; `checks.images` with `enabled: false` turns it off together with `image-distortion`, and findings are decided with `idiom decide`.

### `layout-shift`

- **Catches:** Cumulative layout shift during load above the maximum, naming the elements that moved. When the capture recorded a load timeline, it also names the late-arriving content (inserted, removed or resized) behind the largest shift, with its measured size, and the fix reserves that space.
- **Why it matters:** Content that jumps after load makes people lose their place or click the wrong thing.
- **Severity:** major (a "feel" law: content never moves under the reader).
- **Source:** Core Web Vitals: Cumulative Layout Shift, where 0.1 or less is good.
- **Configure or decide:** On by default; `checks.layoutShift` sets `enabled` and `max` (default 0.1), and findings are decided with `idiom decide`. Older captures without a load timeline keep the previous text; recapture to get the cause.

### `interaction-shift`

- **Catches:** Content displaced by at least 4px after a probe click or web step, without animation, because content was inserted, removed or resized, outside what the action changes (the control, its `aria-controls` targets, and a local container of what it inserted or removed). Content that arrives more than 500ms after input (async data, lazy images, banners) is reported even inside that region, because the reader had already started reading it. Not a shift: scrolling, sorting or filtering rows within a list, gradual (animated) movement, overlays that displace nothing, pinned content that stays put on screen, containers that collapse to nothing, movement entirely outside the viewport, and, within 500ms, the panel the control opens, closes or dismisses, including a recorded DOM ancestor whose control overflows its measured box or that the action hides without removing it, and a container beside the clicked one that the action collapses (a sidebar toggle), when the clicked container and its content close up exactly the space released (whether it snaps is the transition rules' concern). Also within 500ms: the region a control expanded (its `aria-expanded` went to true without `aria-controls`; the appeared element closest to it in the DOM, recorded only when that is unambiguous), and inline validation it raised (fields in its form marked `aria-invalid`, the messages they reference and the form's live regions). Anything else the same click inserts, such as a banner elsewhere, is still reported. Descendants of newly inserted or removed and replaced content are new content even when their selectors are reused, and so are the members of a list whose results were taken out and re-rendered in the same batch (filtering, re-rendering). A placeholder swapped for content in its own slot (a spinner replaced by results) is not a re-rendered list: what it pushes is still reported. Attribution requires a cause that changes space in the direction of the movement and can account for its distance; a shrinking label cannot explain a downward jump. Inserted and removed slots allow for gap or margin outside their measured rectangle; resize deltas use tighter rounding slack. A chain of pushes, such as table columns widening one after another, is one finding named after the first cause. Probe clicks and replays measure real layout scrollbars while saved state captures keep their existing hidden-scrollbar environment. Scrollbar removal/addition attribution requires an actual gutter-width change and excludes stable gutters and right-side padding or margin compensation. Scrollbar-cause findings are currently withheld: the public precision gate (at least 80% with five findings) has not been met; measurements and attribution remain available in action timelines. This also prevents the same scrollbar movement from being attributed to an unrelated insertion. Each finding names the cause, the distance and direction, the time after input and up to five moved elements, ranked by area times distance, and its fix is generated from the measured size: reserve the height or aspect ratio, render a skeleton at the final size, overlay instead of pushing, or reserve the scrollbar's space.
- **Why it matters:** Content that jumps after you act makes you lose your place or click the wrong thing, and agents that only see static screenshots never notice it.
- **Severity:** major (a "feel" law: content never moves under the reader).
- **Source:** Craft law over the action timeline. Core Web Vitals deliberately exempts shifts within 500ms of input; this rule does not, because the shifts people complain about are the ones they cause.
- **Configure or decide:** On by default; `checks.interactionShift` sets `enabled` and `minDistance` (default 4px). The 500ms late boundary is fixed. Runs captured before action timelines need a recapture. Findings are decided with `idiom decide`.

### `design-drift`

- **Catches:** A state whose render departs from its declared intended design. Against an HTML design or a live reference site: size, position, gap, radius, border, typography, colour or text drift on matched elements, and design content missing from or extra in the app. Against a design image (PNG, JPEG, WebP): visibly changed regions after alignment, naming the app elements they cover. Each is shown as labelled design and app crops.
- **Why it matters:** The screen people get should be the one that was designed, and small drift adds up across a product.
- **Severity:** minor for measured drift, copy, extras and image regions; major when a declared scale step is crossed, or when controls, headings, main content or its illustrations are missing.
- **Source:** Craft convention: the built screen matches its intended design.
- **Configure or decide:** Opt-in per state through `design` (or `idiom design add`); `checks.designDrift` sets `enabled`, the common `tolerance` and per-property overrides, `fontWeight` and `color`, and findings are decided with `idiom decide`.

### `loading-state-missing`

- **Catches:** An action whose visible result waits on a fetch or XHR request but shows nothing while that request is pending. The interaction probe replays each probe click and web step that sent requests with those responses held for `checks.loading.delayMs`, as a slow network would. It reports when nothing indicates pending work within `checks.progressWithinMs` and the page changes only after a response. Pending work means a spinner or progress bar, `aria-busy`, a skeleton or placeholder, a status or live-region text change, a disabled, busy or pressed trigger, or any visible content change. A class, data or style change on content that remains hidden (including through an ancestor) is not feedback, nor is removing already hidden content. Reveals and disappearance of previously rendered content still count. A client-side route change is judged only by indicators, progress text, a disabled trigger and changes inside the main region; a highlighted nav link or route announcer does not count. Carousels and tickers are never feedback and never a change after the response: subtrees marked as carousels, slides, marquees or autoplay (by ARIA, attribute or class name), subtrees seen changing before the action, and subtrees that change on a regular period of their own during the replay (a timer in step with the click or the response is the action's own and still counts). The finding names the trigger, the requests and the measured silent time. Not reported: full-page document navigations (the browser shows progress; coverage notes them once as "main-frame document navigation"), requests whose response nothing visible waits on, and declared `longRunning` steps that `progress-affordance` judged. A web step's held replay depends only on the steps through it, so it runs once per flow and every state reached through those steps receives the same evidence.
- **Why it matters:** Locally every response is instant. On a real network, a click that shows nothing for a second reads as broken, and people click again or leave.
- **Severity:** major.
- **Source:** Usability heuristic: visibility of system status.
- **Configure or decide:** `checks.loading.delayMs` sets the hold (default 1500ms; it must exceed `checks.progressWithinMs`, default 1000ms); the interaction probe must run. Skeletons whose swap displaces content are left to layout rules reading the same timeline. Findings are decided with `idiom decide` or a `.idiom/rules.json` override.

### `double-submit`

- **Catches:** A trigger that stays enabled while its non-safe request (POST, PUT, PATCH, DELETE) is pending, where activating it again issues a duplicate of that request. During the held replay Idiom activates the trigger a second time; the duplicate is observed at the route layer and aborted, never sent. A request nothing visible waits on (a beacon) is not reported.
- **Why it matters:** A double click or an impatient user submits the same order, message or payment twice.
- **Severity:** major.
- **Source:** Usability heuristic: error prevention.
- **Configure or decide:** `checks.loading.delayMs` sets how long the request is held, and `checks.progressWithinMs` sets when the second activation is tried; the interaction probe must run. Findings are decided with `idiom decide` or a `.idiom/rules.json` override.


### `error-state-missing`

- **Catches:** A response-gated fetch/XHR action that silently returns to rest after a locally injected failure. New or changed alert/status/live-region text, relevant aria-invalid, generic failure copy, or a meaningful visible result prevents a finding. Full-page navigation, beacons and independent/optimistic results are excluded. A handled failure or a usable action-related retry suppresses both failure rules.
- **Why it matters:** A silent failure makes people assume their action worked.
- **Severity:** major; enabled by default.
- **Source:** Usability heuristic: visibility of system status and recovery from errors.
- **Configure or decide:** `checks.failure.mode` is `status` (default) or `network`; `status` defaults to 500 (400–599); `feedbackWithinMs` defaults to 2000ms. The probe replays at most six actions per state within the shared probe/quick budget. Matched requests terminate locally without reaching the server; every other request retains the probe guard. Findings link the failure-replay timeline and filmstrip. Old captures require recapture. Use `idiom decide` or `.idiom/rules.json` overrides for decisions.

### `retry-blocked`

- **Catches:** After a locally injected failure and a complete recovery window, the activated trigger remains disabled, busy, hidden or inert, a pending indicator remains, or the main/action region lost its content. A visible failure message or a usable action-related retry suppresses the rule; initially empty content and replaced usable triggers are excluded.
- **Why it matters:** People need a way to recover without reloading the page.
- **Severity:** major; enabled by default.
- **Source:** Usability heuristic: user control and recovery from errors.
- **Configure or decide:** Shares `checks.failure` and the bounded replay scheduler with `error-state-missing`. The default recovery deadline is 2000ms after the last injected response. Interrupted or truncated windows cannot prove absence. Old captures require recapture. Findings name the requests and stuck UI, with timeline/filmstrip evidence and a measured recovery fix. Use `idiom decide` or `.idiom/rules.json` overrides for decisions.

### `nested-border`

- **Catches:** An element with a visible border on all four sides that contains, within 4px on every side, exactly one descendant with its own visible border of a different corner radius or border style, with nothing else painted between them (no fill, border, shadow or text on the wrappers in between or beside it). Concentric corners (the outer radius less the gap) and two pills count as the same shape. Outlines and box shadows, including focus rings, are not borders, and borders coloured by a `:focus` or `:focus-within` rule are skipped.
- **Why it matters:** Two frames that nearly coincide read as one doubled, mismatched edge, typically a wrapper rule (`.palette button { border: … }`) also matching a component that draws its own.
- **Severity:** minor.
- **Source:** Craft convention: one edge per surface.
- **Configure or decide:** On by default; `checks.nestedBorder` sets `enabled`, and findings are decided with `idiom decide`. Border style is compared only in captures that record it; recapture older runs.

### `parent-selection`

- **Catches:** A button-like or link-like element (its own fill or four-sided border, link styling, or a pointer cursor) whose click marks an ancestor as selected (`aria-selected`, `aria-current`, `data-selected`, `data-current`, `data-state` `active` or `selected`, or a `selected`, `active` or `current` class) while neither selection nor focus moves to anything that matches the clicked element: an element with the same accessible name, or one that refers to it through `aria-controls`, `aria-labelledby`, `aria-describedby`, `aria-owns`, `aria-activedescendant` or `for`. Selection on the element itself or inside it, an element with its own selection role (tab, option, radio, checkbox, switch, tree item, grid cell, row), a click inside a `label`, a click that navigated or opened a popup, and a wrapper that holds nothing but the clicked element (`<li class="active"><a>`) and is less than twice its size are not reported. Besides the controls the probe clicks anyway, a selection pass clicks links and look-alike controls that sit inside a selectable container (a focusable block, or one carrying a selection attribute, `draggable` or a pointer, move or grab cursor), at most 12 per state, with link navigation suppressed after the page's own handlers ran. Like every probe click, it skips destructive names (delete, remove, publish, pay, …) and, with `respectControlIntent`, elements already selected or acting as drag handles. One finding per selected ancestor names the first clicked element and lists the others.
- **Why it matters:** In a page editor, a navigation link or call to action that selects the whole navigation block looks like a working click, but the person cannot select or edit the thing they pointed at.
- **Severity:** major.
- **Source:** Craft convention: a click acts on what was clicked.
- **Configure or decide:** Needs the interaction probe, on by default (`checks.probe`). Exempt elements with `checks.probe.skip` and decide findings with `idiom decide` or a `.idiom/rules.json` override. Recapture to pick this up.

### `selection-outline`

- **Catches:** A selection or focus ring drawn by a separate positioned frame (an absolutely or fixed positioned element with no text and no fill whose only paint is an outline, a zero-blur spread `box-shadow` or a border on all four sides, and whose box matches an element's within 8px) that runs across an open menu, listbox, popover, non-modal dialog, `aria-expanded` panel or open `<details>` panel more than 4px inside its edge, when the popover is stacked above the framed element and the frame is stacked above the popover. Stacking is read from hit testing where both elements are hit-testable, otherwise from the top layer and CSS stacking contexts; a case it cannot judge is left out and named in coverage. An element's own outline, ring or border is never reported: it paints beneath a popover stacked above the element. Rings of the control that opened the popover are left to `idiom:popover-covers-control`. Popovers the probe opens are judged in their revealed state.
- **Why it matters:** A selection frame that cuts through an open dropdown draws a line across the menu's items, so the editor looks broken exactly where the person is choosing something.
- **Severity:** major.
- **Source:** Craft convention: an open popover sits above the surface it opened from, chrome included.
- **Configure or decide:** On by default. Revealed states follow `checks.probe.disclosures`; decide findings with `idiom decide` or a `.idiom/rules.json` override. Recapture to pick this up.

### `disabled-highlight`

- **Catches:** A menu or listbox row marked disabled (`aria-disabled="true"`, a `disabled` attribute, or a disabled control inside the row) whose background or text colour changes under the pointer to exactly the highlight an enabled row in the same menu takes. The probe hovers up to three disabled rows and the first enabled row of each menu it opens, waiting at most 250ms for transitions; a disabled row with its own distinct highlight, or no highlight, is not reported. Pointer highlights that libraries set on hover (`data-highlighted`, `aria-activedescendant`) are covered; the pressed `:active` state is not sampled, so a disabled row is never pressed.
- **Why it matters:** A row that lights up like the others looks clickable, so people try it and nothing happens.
- **Severity:** minor.
- **Source:** Craft convention: disabled rows don't respond.
- **Configure or decide:** Needs the interaction probe (`checks.probe`, on by default); only menus the probe opens are sampled, not lists that are always visible. Decide findings with `idiom decide` or a `.idiom/rules.json` override. Recapture to pick this up.

### `brief-mismatch`

- **Catches:** A decided design brief's acceptance criteria that the built UI breaks. A criterion may carry assertions tied to a flow state and a selector: a size (`width`/`height` as pixels or a `{min,max}` range), the same size as a reference element (`sameSizeAs`), containment inside another element's rectangle (`within`), visible at rest on touch viewports (`visibleWithoutHover`), no layout shift outside the element when it is hovered (`stableOnHover`), or a minimum contrast ratio (`minContrast`). Each failing element is one finding naming the brief, the criterion and the measured values, for example `.drawer-item height 100, expected 56 (tolerance 1)` or `.drawer-item .pin extends 44px below .tile`. A subject, reference or container that matched nothing is a mismatch. An assertion that cannot be measured (a capture older than the brief, an invalid selector, no touch viewport, no hover probe reaching the element, no match with a painted foreground) is not a finding; coverage lists it with the reason. Only decided briefs are judged, and not when the decision was "don't build it" or chose an option other than the one the criteria were written for.
- **Why it matters:** The shipped UI contradicts what the requester decided. A build that doubles a drawer's height can pass every other check, and only the brief's own criteria would have failed it.
- **Severity:** major.
- **Source:** Project declaration: the assertions on a decided brief's acceptance criteria.
- **Configure or decide:** Add assertions to criteria in `.idiom/briefs/<slug>.json` with `idiom brief record`; decide findings with `idiom decide`; re-decide or supersede the brief to change the contract. Changing an assertion reopens the findings decided against it; an unchanged assertion keeps its decisions. Recapture after recording a brief so its selectors are measured.

### `popover-dismissal`

- **Catches:** A popover, menu or dialog the probe opened that stays open after Escape, after a click on an empty, non-interactive point outside it and its trigger, or after a click inside a visible same-origin or `srcdoc` iframe on the page (`idiom:popover-not-dismissed`). The probe tests what a click opens through `aria-expanded`, `aria-controls` or `aria-haspopup`, and native `popover` and `<dialog>` openings; it presses Escape first, then clicks outside, then clicks into the iframe, reopening the panel between tests. Only overlays are tested: a panel in the top layer, positioned (`absolute` or `fixed`), or with a `menu`, `listbox`, `dialog` or `alertdialog` role. An in-flow panel that pushes content down, such as an accordion section, is not a popover and is not tested, and neither is `<details>`. An iframe-click failure names the iframe. Alert dialogs (`role="alertdialog"`), dialogs matching the flow's `explicitDismiss`, and `<dialog closedby="none">` or `closedby="closerequest"` are exempt from the outside and iframe clicks, not from Escape. Cross-origin iframes, hover-opened menus and touch gestures are not tested.
- **Why it matters:** A panel that ignores clicks elsewhere or Escape traps people: it covers the page until they find its own trigger again. Clicks into an embedded canvas or preview are the easiest to miss, because the parent page never sees them.
- **Severity:** major.
- **Source:** WAI-ARIA Authoring Practices menu button and dialog patterns (Escape closes); craft convention for closing on outside clicks.
- **Configure or decide:** Needs the interaction probe (`checks.probe`, on by default) with disclosures on (`checks.probe`'s `disclosures`). Mark modals that intentionally need an explicit action with the flow's `explicitDismiss` selectors. At most 12 overlays per state are tested, inside each control's probe budget; the rest are reported as not reached in probe coverage. Decide findings with `idiom decide` or a `.idiom/rules.json` override. Recapture to pick this up.

### `focus-return`

- **Catches:** Escape closed a popover, menu or dialog the probe opened, but focus did not return to the control that opened it (`idiom:focus-not-returned`): it went to the page body or to an unrelated element. Focus counts as returned when it is on the trigger, on an element that references the panel through `aria-controls` or `aria-owns`, or anywhere but the body when the trigger itself is gone. When focus was neither on the trigger nor in the panel before Escape, the probe focuses the trigger first, as a keyboard user's focus would be.
- **Why it matters:** Keyboard and screen-reader users lose their place and have to tab from the top of the page again.
- **Severity:** minor.
- **Source:** WCAG 2.2 success criterion 2.4.3 Focus Order; WAI-ARIA Authoring Practices menu button and dialog patterns.
- **Configure or decide:** Measured by the same dismissal pass as `popover-dismissal`: needs `checks.probe` with disclosures on, and shares its limit and budget. Decide findings with `idiom decide` or a `.idiom/rules.json` override. Recapture to pick this up.

### `spacing-target`

- **Catches:** Ordered border-box gaps outside an authored target and its inclusive tolerance, between two selectors or consecutive visible direct children within each container.
- **Why it matters:** A layout can drift from intended spacing while remaining internally consistent.
- **Severity:** major by default; configurable through project rule overrides.
- **Source:** Project declaration: explicit spacing targets measured at capture time.
- **Configure or decide:** Declare `checks.spacingTargets`; override `idiom:spacing-target` in `.idiom/rules.json` or use `idiom decide`. Missing, invalid or ambiguous matches disclose unavailable coverage; recapture older evidence or after changing targets.

### `detached-flyout`

- **Catches:** A successfully opened disclosure panel whose nearest edge is strictly more than 24px from its trigger. Distance is Euclidean for diagonal separation; touching or overlapping rectangles have zero separation. The finding includes the measured pixel distance and nested disclosure name.
- **Why it matters:** A panel far from its opener is hard to associate with the action that revealed it.
- **Severity:** minor.
- **Source:** Craft convention: disclosure content stays near its trigger.
- **Configure or decide:** Needs successful interaction-probe geometry, captured while the panel is open. Recapture stored runs without this evidence; missing or timed-out geometry is unavailable, not a passing measurement. The 24px threshold is fixed; decide findings with `idiom decide` or override them in `.idiom/rules.json`.

### `disclosure-affordance`

- **Catches:** A disclosure trigger (a control whose `aria-expanded` toggles from false to true, or a `<details>` summary) where nothing inside or next to it looks different collapsed and expanded (`idiom:disclosure-affordance`). The probe reads the trigger just before its click and again once the opening is confirmed: graphics inside it (SVG geometry, images, background or mask images, one- or two-character glyphs such as ▸ or +), its own `::before` and `::after`, and an adjacent non-interactive sibling within 8px. Each graphic's shape, composed transform and visibility are compared. A rotated chevron, swapped plus/minus, an icon that appears or disappears, a native `<details>` marker or a change in the trigger's own text ("Show details" to "Hide details") all pass. Colour changes alone do not count. Menu buttons whose label says what they open are exempt: a text-only trigger that advertises a popup (`aria-haspopup`, such as "Sort" or "File"), a text-only trigger named "More", "Menu", "Options" or "Actions", and an icon-only popup trigger with such a name (a ⋯ button labelled "More options"). So is a help toggletip whose whole visible text is a help glyph (`?`, `ⓘ`, `ℹ`), which already says it reveals an explanation. A text-only expander that reveals content in place, such as a "Settings" section, is not exempt.
- **Why it matters:** Without an indicator, people can't tell that an item has more below it or that it is open. They find the content by accident or not at all.
- **Severity:** minor.
- **Source:** WAI-ARIA Authoring Practices disclosure pattern: the expanded state is shown visually as well as programmatically.
- **Configure or decide:** Needs the interaction probe (`checks.probe`, on by default) with disclosures on (`checks.probe`'s `disclosures`). Captures from before this check have no indicator readings and report it unavailable; recapture to pick it up. Decide findings with `idiom decide` or a `.idiom/rules.json` override.

### `opener-cannot-close`

- **Catches:** A control that opened a panel, where a second click on the same control leaves the panel open and no close control sits within 24px of where the control was (`idiom:opener-cannot-close`). After the dismissal tests, the probe reopens the panel if needed and clicks the opener again at its original position. It only clicks when the opener is still visible at the same place (each edge within 4px) and is what a click there would hit. A covered or moved opener, or a modal panel (`aria-modal="true"` or a modal `<dialog>`), is recorded as not tested and never reported. A close control is any visible control within 24px of the opener's original box named close, dismiss, hide, collapse, cancel, done or back, an `×`, one with `aria-expanded="true"`, or one whose `aria-controls` names the panel. Disclosure triggers are tested, and so are plain controls that open a dialog or popover; `<details>` toggles natively and is skipped.
- **Why it matters:** People close things the way they opened them. A logo or menu button that opens a drawer but ignores the next click leaves them looking for another way out.
- **Severity:** minor.
- **Source:** Craft convention: a toggle closes what it opened.
- **Configure or decide:** Measured by the interaction probe (`checks.probe`) with disclosures on, inside each control's probe budget. At most 12 panels per state are re-clicked; the rest are counted as not reached in probe coverage. Captures from before this check report it unavailable; recapture to pick it up. Decide findings with `idiom decide` or a `.idiom/rules.json` override.

### `icon-meaning`

- **Catches:** One icon that stands for two or more different things across a flow's states (`idiom:icon-meaning`). Capture fingerprints the single icon of each interactive control: an SVG by its `viewBox` and shape geometry (paths, circles, rects, lines, polygons, and `<use>` references resolved), an icon font by its glyph and font family. Colour, class and size are ignored, so the same shape in two colours is one icon. Controls whose icon is their only visible content count, and so do leading icons on controls that are not disclosures. Trailing icons (row chevrons, external-link arrows, dropdown carets) and icons on disclosure triggers with text are affordances, not meanings, and are skipped. Two controls mean the same thing when their accessible names share a meaning word after case, stopwords, numbers, plurals and a small synonym table ("Close" and "Close panel", "Dismiss" and "Close"); same-named controls are split when the probe saw both clicked and their effects share nothing. Repeated identical controls, such as "Delete" on every row, count once. The finding is reported once per icon, on the first state that carries it, and lists each meaning with the states it appears in, including probe-opened panels.
- **Why it matters:** When one icon means "collapse panel" in one place and "3-column layout" in another, people can't learn what it does and hesitate every time they see it.
- **Severity:** minor.
- **Source:** WCAG 2.2 success criterion 3.2.4 Consistent Identification.
- **Configure or decide:** Runs on every capture; it does not judge whether an icon suits its meaning, only whether it keeps one. Captures from before icon fingerprints report it unavailable; recapture to pick it up. Decide findings with `idiom decide` or a `.idiom/rules.json` override.

### `empty-frame`

- **Catches:** A visible box at least 48px wide and 24px tall that draws a border, or a background different from the one behind it, with nothing visible inside it: no text, image, icon, form field or focusable element, and no drawn `::before`/`::after`. It is judged per viewport, so a header bar whose only child is hidden above some width is reported at the widths where it is empty, and the explanation counts the children hidden there (`idiom:empty-frame`). Spacers without border or fill, loading placeholders (`aria-busy`, skeleton or shimmer classes, running animations), named graphics (an `aria-label` or `title`, `role="img"`, progress and meter parts), fills drawn by an image, background-only overlays, table cells and boxes inside a control are not reported. Content faded to opacity 0 for a scroll reveal counts as content. When an empty box contains another, only the outer one is reported.
- **Why it matters:** A frame promises content. An empty bar or card reads as broken or still loading, and takes space without telling anyone anything.
- **Severity:** minor.
- **Source:** Craft convention: a drawn container holds something.
- **Configure or decide:** On by default; `checks.emptyFrame` sets `enabled`, and its `ignore` selectors exempt boxes everywhere. Mark a box that a state shows empty on purpose (a drop zone before a drop) with the state's `intentionallyEmpty` selectors; the box and everything inside it is skipped. Decide findings with `idiom decide` or a `.idiom/rules.json` override. Recapture to pick this up.

### `repeated-row-ornament`

- **Catches:** In a list, table, grid, feed, tab list, menu or navigation rail of at least 5 visible items, a chip, badge, icon or status mark that appears on at least 80% of the items in the same position with identical size, colours, text and icon (`idiom:repeated-row-ornament`). It is reported once per collection and decoration, naming the decoration and how many items carry it, such as `repeats on 6 of 6 items`. A decoration whose value differs between items (a status column of Paid and Pending) never counts, and neither does an icon inside a per-row action button such as copy or a row menu. Decorations inside the item's own link count. A rail whose links sit in a list is judged once, as the list.
- **Why it matters:** A mark every item carries tells items apart from nothing. It adds noise to every row and dilutes the marks that do carry meaning.
- **Severity:** info.
- **Source:** Craft convention: per-item marks distinguish items; a fact true of every item is stated once.
- **Configure or decide:** On by default; `checks.repeatedRowOrnament` sets `enabled`. Whether a repeated decoration is wanted is a design call: decide findings with `idiom decide` or a `.idiom/rules.json` override. Recapture to pick this up.

### `glyph-over-icon`

- **Catches:** Inside a link, button, tab, menu item or option smaller than 64×64px, a small glyph or badge under 16px (an icon, or a unicode symbol such as an arrow) whose box overlaps another, larger icon's box by more than 25% of its own area (`idiom:glyph-over-icon`). The finding names the control, the glyph and the icon, with the overlap. Numeric count badges (`3`, `9+`), plain status dots and live regions (`role="status"`, `aria-live`) are the usual unread indicators drawn over an icon on purpose and are not reported.
- **Why it matters:** A badge drawn over an icon's corner merges with it, so neither shape reads cleanly at small sizes, and the icon looks damaged.
- **Severity:** minor.
- **Source:** Craft convention: small icons keep clear space; only count and status indicators sit over them.
- **Configure or decide:** On by default; `checks.glyphOverIcon` sets `enabled`. Decide findings with `idiom decide` or a `.idiom/rules.json` override. Recapture to pick this up.

# Rules

Findings have three bases: **measured** means a deterministic rule with its measurement; **observed** means an action, timeline or probe with timing and result; **judged** means model critique, with stated confidence when supplied. Treat judged findings as suggestions. Severity gates count measured and observed findings by default; `--fail-on-judged` includes judged suggestions at the selected severity threshold. Suppression, severity overrides and independent configured published budgets keep their existing behavior.

Deterministic findings retain readable Done when text and an executable `acceptance` rule contract. Verify reruns the existing rule under unchanged settings against the original target/action in both calibrated captures. A matching violation fails even when other evidence is incomplete. A missing action, skipped probe, partial timeline, missing held replay, changed settings or unresolved target produces **not-recheckable**, with a reason, rather than claiming a fix. Current effect-region and animation exclusions remain part of the original rules.


A rule, or check, is a deterministic judgement over the evidence Idiom captured for one state, viewport and colour scheme: the DOM, computed styles and geometry, the screenshot, the axe-core results, the console, and what the interaction probe saw. The same evidence always gives the same findings, so `idiom review <flow> --from <runId> --deterministic-only` re-judges a stored run offline, and `idiom check` gates on it.

Each finding has one of three severities:

- **blocker**: the state did not render as declared, or a published page broke its hard budget. Nothing else about the state can be trusted until it is fixed.
- **major**: a defect people will hit, such as an unreadable label, a dead control or a broken link. `idiom check` fails on major and above by default (`--fail-on major`).
- **minor**: craft debt that is worth fixing but does not block, such as an off-scale value or a lonely last word.

State coverage is reported next to rule coverage. `idiom coverage --states`, each flow review report and `idiom check` say which viewports, colour schemes, reduced-motion modes, network replays (slow and failure), interactions (probe reach, focus sweep) and declared data states each state was observed in by the latest capture, and the config or flow change that covers each missing one. It measures what was reviewed, not quality. A dimension that cannot apply (no requests to replay, no controls to probe, no data states declared) is not applicable and never counts towards the percentage.

Every check reports coverage as well as findings. A check whose evidence is missing (an older capture, a capture path that cannot record it, or a probe that did not run) reports coverage `unavailable` rather than passing; recapture to measure it. A check you turn off reports `skipped`.

Geometry, text and consistency rules judge only painted participants when the capture records that fact. An element is unpainted when it or an ancestor is CSS-hidden, inside a closed details disclosure outside its first summary, at cumulative opacity zero, without rendered area, or fully outside an ancestor's overflow clip. Partially clipped and below-fold elements remain eligible. The gate applies before grouping or majority selection, on both sides of comparisons, to `idiom:elements-overlap`, `idiom:interactive-overlap`, `idiom:text-clipped`, `idiom:element-content-clipped`, `idiom:label-off-centre`, `idiom:adjacent-elements-touch`, `idiom:mixed-label-casing`, `idiom:mixed-locale-spelling`, `idiom:orphan-word`, `idiom:line-too-long`, `idiom:scale-outlier`, `idiom:sibling-select-inconsistent`, `idiom:selected-state-invisible`, `idiom:image-distorted` and `idiom:dead-link-text`.

Coverage reports distinct elements skipped as not painted for each rule and tuple, including zero. This does not turn a running check into a skipped check. Artifacts without painted facts retain their previous findings and coverage. Axe, document overflow, font/link checks, console errors, expectation status and other branches of shared checks retain their existing domains. See [the observation contract](schemas.md) and [animation settling](configuration.md).

Configure checks under `checks.*` in `.idiom/project.json`; every field is optional, and [configuration.md](configuration.md#checks) has the full reference. Some checks are opt-in and do nothing until their block is present.

Decide a finding with `idiom decide`: `--accept` marks it as work worth doing, `--reject` dismisses that occurrence, and `--reject --scope rule` suppresses it in every later run. To change a finding's severity or suppress it by category, flow, state or rule, add an override to `.idiom/rules.json` (see [Rules](configuration.md#rules)). Questions a review cannot settle on its own arrive as `ruling-N` decisions, which `idiom ruling` records in `DESIGN.md`.

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
- **Configure or decide:** No settings; it runs on the narrowest captured viewport, and findings are decided with `idiom decide` or a `.idiom/rules.json` override.

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

- **Catches:** Interactive targets without a clickable region containing the required square: 24×24 CSS px for fine pointers, 44×44 for narrow or touch viewports. Native checkbox/radio targets include captured associated label fragments, excluding independent interactive descendants and nonclickable gaps. At the default fine-pointer minimum, undersized targets pass when their centered 24px circle overlaps neither another target nor another undersized target's circle; exact tangency passes.
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

- **Catches:** Rendered colours and radii on visible elements that do not resolve to a value declared in the project's design tokens.
- **Why it matters:** Off-token values drift from the design system one hard-coded colour at a time.
- **Severity:** minor.
- **Source:** Craft convention: rendered values should come from the declared design tokens.
- **Configure or decide:** Runs only when `design.tokensFile` is set in `.idiom/project.json` (otherwise skipped); there are no `checks` settings, so decide findings with `idiom decide` or a `.idiom/rules.json` override.

### `console-error`

- **Catches:** `console.error` calls and uncaught page errors recorded during capture, grouped by message and location.
- **Why it matters:** Errors in the console usually mean something on screen is missing or broken, even when it looks fine.
- **Severity:** major.
- **Source:** Craft convention: a declared state should render without runtime errors.
- **Configure or decide:** No settings; the expected load error of a state that declares a non-200 status is ignored, and other findings are decided with `idiom decide` or a `.idiom/rules.json` override.

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
- **Configure or decide:** No settings; the rhythm is inferred from the run, so uniformly tight products are not judged, and findings are decided with `idiom decide` or a `.idiom/rules.json` override.

### `unexplained-control`

- **Catches:** Icon-only or single-glyph controls (`?`, `⋮`) with no visible label, description or tooltip, and disabled controls that give no reason.
- **Why it matters:** People cannot use a control whose meaning they have to guess.
- **Severity:** major for enabled controls; minor for disabled ones and for probed single-glyph controls in the default mode.
- **Source:** Craft convention: a control's purpose should be visible, not only exposed to assistive technology.
- **Configure or decide:** In default mode, fully nameless icons belong to `axe:button-name` / `axe:link-name`; a glyph-only accessible name such as `aria-label="i"` belongs to this check. `checks.explanation` set to `"visible"` requires a visible explanation on hover and focus; `checks.probe` (on by default) supplies tooltip evidence and its `skip` list exempts controls; decide findings with `idiom decide`.

### `text-centering`

- **Catches:** Single-line labels in chips, buttons and badges sitting off their box's vertical centre; an open box with a single top or bottom rule (a divider or underline) is measured against its content box.
- **Why it matters:** Off-centre labels are a small misalignment people notice without knowing why.
- **Severity:** minor.
- **Source:** Craft convention: labels sit on their box's optical centre.
- **Configure or decide:** `checks.centeringTolerance` sets the allowed offset (default 1.5px); filled or fully bordered shapes are still measured edge to edge. Decide findings with `idiom decide`.

### `adjacent-gap`

- **Catches:** Neighbouring controls closer than the minimum gap, including a focused field's ring, and bordered shapes that touch inside the same parent. Keycap glyph groups (⌘ K) and the contents of illustrations or static, non-selectable mock-ups with no controls are not compared.
- **Why it matters:** Controls jammed together look like one control and are easy to mis-hit.
- **Severity:** major when they touch or overlap (gap of 0.5px or less); minor otherwise.
- **Source:** Craft convention: separate controls need visible separation.
- **Configure or decide:** `checks.minGap` (default 3px) sets the minimum, and `checks.adjacentGap` takes extra flush `regions` and `indicatorMax` (default 16px); decide findings with `idiom decide`.

### `dead-affordance`

- **Catches:** Text that reads or looks like a link or action ("View terms", "Learn more") but is plain text, disabled buttons with navigation copy, and `href="#"` placeholder links. Text inside a non-interactive illustration frame is not reported as dead link text: an `aria-hidden`, `inert` or `role="img"` subtree, or the root of a `user-select: none` region at least 200×120 px with six or more text pieces, with no focusable descendants (a picture of product UI, such as a launcher window on a marketing page).
- **Why it matters:** An affordance that leads nowhere breaks trust in every other link on the page.
- **Severity:** major for link-like plain text; minor for disabled link-like buttons and `href="#"` placeholders.
- **Source:** Craft convention: anything that looks clickable should do something.
- **Configure or decide:** No settings; accept or dismiss individual instances with `idiom decide`, or override them in `.idiom/rules.json`.

### `dead-control`

- **Catches:** Enabled buttons that change nothing observable when the probe clicks them.
- **Why it matters:** A button that does nothing looks like a broken product.
- **Severity:** major.
- **Source:** Craft convention: every enabled control should have an effect.
- **Configure or decide:** Needs the interaction probe, on by default (`checks.probe`); exempt controls with `checks.probe.skip` and decide findings with `idiom decide`.

### `duplicate-entry`

- **Catches:** Two or more persistent controls in different places that open the same panel or focus the same field, following one level of menus.
- **Why it matters:** Duplicate entry points clutter the interface and make people wonder whether they do different things.
- **Severity:** minor.
- **Source:** Craft convention: one destination, one entry point.
- **Configure or decide:** Needs the probe (`checks.probe`, on by default); per-row actions in repeated lists are excluded, and findings are decided with `idiom decide`.

### `component-size`

- **Catches:** Named components rendering outside their declared width or height, or a size stated next to a name in `DESIGN.md`.
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

### `native-control`

- **Catches:** Browser-default selects or checkboxes shown beside the product's own styled versions.
- **Why it matters:** Mixing native and custom controls makes the interface look stitched together.
- **Severity:** minor.
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

- **Catches:** Controls or text in the same layer whose boxes intersect, including partly visible elements, with both selectors and the overlap size.
- **Why it matters:** Overlapping elements hide each other and can make controls unclickable.
- **Severity:** major when a control is involved or the overlap covers at least a quarter of the smaller element; minor otherwise, and always minor when no hit-test point could confirm it (below the fold, geometry only).
- **Source:** Craft convention: elements in one layer should not collide.
- **Configure or decide:** No settings; menus, dialogs, tooltips (including chart-library tooltip layers) and pointer-events:none overlays are kept apart from content beneath them, and findings are decided with `idiom decide`.

### `clipped-text`

The carousel-peek exemption examines only ancestors strictly inside the actual clipping owner. Self-clipping text has no such ancestors; unrelated neighboring layout panels cannot exempt it. Ancestor-owned carousel peeks, repeated translating tickers, ellipsis/clamp and harmless font overruns retain their exclusions.

- **Catches:** Single-line or wrapped labels cut off without an ellipsis, including clipped menu items.
- **Why it matters:** A label missing its end can say the wrong thing or nothing at all.
- **Severity:** major.
- **Source:** Craft convention: truncation should be visible and intentional.
- **Configure or decide:** No settings; intentional ellipses, line clamps and scrollable content are excluded. Small overruns below measured font descender space are excluded only when every line is readable and its glyph ink fits. Active repeated tracks translating through a clipping strip are excluded horizontally; independent nested clips and vertical slicing still report. Recapture saved observations to apply these exclusions; findings are decided with `idiom decide`.

### `field-group`

- **Catches:** Label, control and helper text stacks that touch, and too little space between separate field groups.
- **Why it matters:** Cramped form groups make it unclear which label belongs to which field.
- **Severity:** major when parts touch (0.5px or less); minor otherwise.
- **Source:** Craft convention: related form parts sit together, separate groups sit apart.
- **Configure or decide:** `checks.fieldGroups` sets `inner` (default 4px) and `between` (default 12px); decide findings with `idiom decide`.

### `scale-conformance`

- **Catches:** Spacing, control heights, corner radii and border colours off the declared scale, or, without a scale, sharp outliers from the run's prevailing value; control shadows (outliers only).
- **Why it matters:** Values off the scale accumulate into a layout that never quite lines up.
- **Severity:** minor.
- **Source:** Craft convention: dimensions and colours come from a small, declared scale.
- **Configure or decide:** `checks.scales` declares spacing, control heights, radii, border colours and role selectors; decide findings with `idiom decide`. Without a declared scale, a value is compared only with peers in the same viewport, colour scheme and role, and dividers split into heading rules, table borders and other rules. Borders on inline text (dotted underlines, abbreviations) are not dividers, and radius is judged only on boxes with a visible background, border or shadow. When one off-scale value repeats in one context, it becomes a single design-system question instead of separate findings (see below).

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

- **Catches:** Content displaced by at least 4px after a probe click or web step, without animation, because content was inserted, removed or resized, outside what the action changes (the control, its `aria-controls` targets, and a local container of what it inserted or removed). Content that arrives more than 500ms after input (async data, lazy images, banners) is reported even inside that region, because the reader had already started reading it. Not a shift: scrolling, sorting or filtering rows within a list, gradual (animated) movement, overlays that displace nothing, pinned content that stays put on screen, containers that collapse to nothing, movement entirely outside the viewport, and, within 500ms, the panel the control opens, closes or dismisses, including a recorded DOM ancestor whose control overflows its measured box or that the action hides without removing it, and a container beside the clicked one that the action collapses (a sidebar toggle), when the clicked container and its content close up exactly the space released (whether it snaps is the transition rules' concern). Descendants of newly inserted or removed and replaced content are new content even when their selectors are reused, and so are the members of a list whose results were taken out and re-rendered in the same batch (filtering, re-rendering). A placeholder swapped for content in its own slot (a spinner replaced by results) is not a re-rendered list: what it pushes is still reported. Attribution requires a cause that changes space in the direction of the movement and can account for its distance; a shrinking label cannot explain a downward jump. Inserted and removed slots allow for gap or margin outside their measured rectangle; resize deltas use tighter rounding slack. A chain of pushes, such as table columns widening one after another, is one finding named after the first cause. Locking or unlocking page scroll (`overflow: hidden` or a fixed body, as modals do) on a page that overflows, without `scrollbar-gutter: stable` on html or right-side padding compensation, is one finding on `html` per action: on systems with classic scrollbars the scrollbar's width is given to or taken from all content. This cause is reported only when a real layout scrollbar is measured; the content it moved sideways is named and attributed to the scrollbar rather than to content inserted beside it. Headless captures have no layout scrollbar and cannot see this cause; no shift is inferred from a scroll lock alone. Each finding names the cause, the distance and direction, the time after input and up to five moved elements, ranked by area times distance, and its fix is generated from the measured size: reserve the height or aspect ratio, render a skeleton at the final size, overlay instead of pushing, or reserve the scrollbar's space.
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

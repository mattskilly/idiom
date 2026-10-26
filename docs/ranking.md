# How check ranks Top issues

`check` ranks presentation issues by **salience × prominence**, then worst
severity, then first-seen bucket order. Scores use full precision. `--top N`
limits the displayed prefix; JSON always contains the entire ranked catalogue.
Detection, thresholds, finding fingerprints, durable groups, decisions, baseline
comparison and failure gates are independent of this presentation.

## Salience

This single normative table is fixed; there are no project overrides.
Rule-specific rows override category defaults. `*` matches generated suffixes,
including invariant keys, expectation kinds, scale properties and axe rule IDs.
All unlisted rules within a known category use its category default.

| Category | Rule or rule pattern | Salience | Rationale |
| --- | --- | ---: | --- |
| `overflow-clip` | All except the clipping overrides below | 4 | Document overflow is a broader layout signal. |
| `overflow-clip` | `idiom:input-value-truncated`, `idiom:element-content-clipped` | 9 | Rendered content is obstructed. |
| `responsive-break` | All rules | 4 | General interactive-overlap heuristic; explicit visible overlap checks are stronger. |
| `contrast` | All rules | 4 | General consistency, semantics or contextual quality. |
| `a11y-label` | All rules (including `axe:*`) | 4 | General consistency, semantics or contextual quality. |
| `target-size` | All rules | 1 | Broad hygiene pattern with low visual salience. |
| `heading-structure` | All rules | 4 | General consistency, semantics or contextual quality. |
| `token-drift` | All rules | 7 | Visible misalignment, off-system sizing or unexplained controls. |
| `console-error` | All rules | 4 | General consistency, semantics or contextual quality. |
| `missing-state` | All rules (including `idiom:tuple-failure:*`, `idiom:expectation-*`, `idiom:missing-color-scheme`) | 9 | Broken behaviour or obstructed content. |
| `spacing-rhythm` | All rules | 1 | Broad hygiene pattern with low visual salience. |
| `unexplained-control` | All rules | 7 | Visible misalignment, off-system sizing or unexplained controls. |
| `text-centering` | All rules | 7 | Visible misalignment, off-system sizing or unexplained controls. |
| `adjacent-gap` | All rules | 7 | Visible misalignment, off-system sizing or unexplained controls. |
| `dead-affordance` | All except `idiom:placeholder-link` | 9 | Dead or disabled navigation is broken behaviour. |
| `dead-affordance` | `idiom:placeholder-link` | 4 | An explicit placeholder communicates its unfinished state. |
| `dead-control` | All rules | 9 | Broken behaviour or obstructed content. |
| `duplicate-entry` | All rules | 9 | Broken behaviour or obstructed content. |
| `component-size` | All rules | 7 | Visible misalignment, off-system sizing or unexplained controls. |
| `copy-lint` | All rules | 4 | General consistency, semantics or contextual quality. |
| `glyph-icon` | All rules | 4 | General consistency, semantics or contextual quality. |
| `error-text` | All rules | 9 | Broken behaviour or obstructed content. |
| `native-control` | All rules | 4 | General consistency, semantics or contextual quality. |
| `layout-invariants` | All rules (including `idiom:layout-invariants:*:*`) | 4 | General consistency, semantics or contextual quality. |
| `group-invariants` | All rules (including `idiom:group-invariants:*:*`) | 4 | General consistency, semantics or contextual quality. |
| `selected-state` | All rules (including `idiom:selected-state-*`) | 4 | General consistency, semantics or contextual quality. |
| `dialog-shell` | All rules (including `idiom:dialog-*`) | 4 | General consistency, semantics or contextual quality. |
| `disguised-control` | All except `idiom:input-rejects-text` | 4 | Appearance mismatch alone is contextual. |
| `disguised-control` | `idiom:input-rejects-text` | 9 | An input rejects the expected interaction. |
| `fresh-state` | All rules | 4 | General consistency, semantics or contextual quality. |
| `mirrored-control` | All rules | 4 | General consistency, semantics or contextual quality. |
| `motion` | All rules | 4 | General consistency, semantics or contextual quality. |
| `element-overlap` | All rules | 9 | Broken behaviour or obstructed content. |
| `clipped-text` | All rules | 9 | Broken behaviour or obstructed content. |
| `field-group` | All rules | 4 | General consistency, semantics or contextual quality. |
| `scale-conformance` | All rules (including `idiom:scale-outlier`, `idiom:off-scale-*`) | 7 | Visible misalignment, off-system sizing or unexplained controls. |
| `control-anatomy` | All rules | 1 | Broad hygiene pattern with low visual salience. |
| `luminance-parity` | All rules | 4 | General consistency, semantics or contextual quality. |
| `frame` | All rules | 4 | General consistency, semantics or contextual quality. |
| `primary-region` | All rules | 4 | General consistency, semantics or contextual quality. |
| `alarm-at-rest` | All rules | 4 | General consistency, semantics or contextual quality. |
| `cross-surface-naming` | All rules | 4 | General consistency, semantics or contextual quality. |
| `published-budget` | All rules (including `published:*`) | 4 | General consistency, semantics or contextual quality. |
| `empty-state` | All rules | 4 | General consistency, semantics or contextual quality. |
| `progress-affordance` | All rules | 4 | General consistency, semantics or contextual quality. |
| `page-content` | All rules | 4 | General consistency, semantics or contextual quality. |
| `band-edges` | All rules | 4 | General consistency, semantics or contextual quality. |
| `word-break` | All rules | 4 | General consistency, semantics or contextual quality. |
| `shell-visibility` | All rules (including `idiom:shell-visibility-*`) | 4 | General consistency, semantics or contextual quality. |
| `compound-control` | All rules | 4 | General consistency, semantics or contextual quality. |
| `sibling-chrome` | All rules | 4 | General consistency, semantics or contextual quality. |
| `touch-reachability` | All rules | 4 | General consistency, semantics or contextual quality. |
| `liveness` | All rules (including `idiom:liveness-*`) | 9 | Broken behaviour or obstructed content. |
| `media-fill` | All rules | 4 | General consistency, semantics or contextual quality. |
| `collection-actions` | All rules | 4 | General consistency, semantics or contextual quality. |
| `font-loading` | All rules | 4 | General consistency, semantics or contextual quality. |
| `broken-link` | All rules | 4 | General consistency, semantics or contextual quality. |
| `focus-visible` | All rules | 4 | General consistency, semantics or contextual quality. |
| `line-length` | All rules | 4 | General consistency, semantics or contextual quality. |
| `orphan-word` | All rules | 4 | General consistency, semantics or contextual quality. |
| `image-distortion` | All rules | 4 | General consistency, semantics or contextual quality. |
| `broken-image` | All rules | 4 | General consistency, semantics or contextual quality. |
| `layout-shift` | All rules | 4 | General consistency, semantics or contextual quality. |
| `design-drift` | All rules | 4 | General consistency, semantics or contextual quality. |
| `hierarchy` | All rules | 4 | General consistency, semantics or contextual quality. |
| `density` | All rules | 4 | General consistency, semantics or contextual quality. |
| `brand-alignment` | All rules | 4 | General consistency, semantics or contextual quality. |
| `generic-pattern` | All rules | 4 | General consistency, semantics or contextual quality. |
| `reference-mismatch` | All rules | 4 | General consistency, semantics or contextual quality. |
| `spec-mismatch` | All rules | 4 | General consistency, semantics or contextual quality. |
| `direction-drift` | All rules | 4 | General consistency, semantics or contextual quality. |
| `offer-change` | All rules | 4 | General consistency, semantics or contextual quality. |
| `unsupported-claim` | All rules | 4 | General consistency, semantics or contextual quality. |
| Unknown category or missing rule | Fallback | 4 | Neutral policy when classification is unavailable. |

The general `responsive-break` interactive-overlap heuristic has value 4.
The explicit visible `element-overlap` and `clipped-text` checks have value 9
because their evidence establishes obstructed content more directly.

## Prominence

For each exact observed selector at an affected tuple coordinate:

```text
A = area(intersection(target.rect, viewport rectangle)) / viewport area
F = 1 if the visible target intersects the captured viewport, otherwise 0
R = 1 if the target is a primary action OR in the primary region, otherwise 0
base = 1 + sqrt(clamp(A, 0, 1)) + 0.5*F + 0.5*R

S = min(1, log2(max(1, distinct affected states)) / 3)
B = min(1, log2(max(1, distinct places)) / 6)
prominence = max(base over matching affected targets, default 1) + 0.25*S + 0.25*B
score = salience * prominence
```

Area uses CSS pixels and the captured viewport dimensions, independent of the
full-page screenshot height. Rectangles are already relative to the viewport;
scroll offsets are not applied again. The clipped rendered box approximates
painted area; this does not measure individual painted pixels. Above the fold
means visible in the captured viewport, including intentionally scrolled states.
Hidden, offscreen and zero-size targets contribute base 1. Missing selectors,
composite selectors without an exact observed match, missing observations and
invalid viewport dimensions also contribute base 1 without inferred area,
fold or region evidence. All values remain finite. V1 captures contribute
area/fold geometry even without newer signals.

Primary actions use the recorded `signals.paint.primaryAction` at that exact
coordinate. Primary regions use resolved `selectorMarks` with purpose
`primary-region`; if no matches resolve, observed `main` tags or role `main`
elements supply the fallback. A target belongs to a region if it is the region
or records its selector in `ancestorSelectors`. Class names and other states'
primary-action signals do not supply evidence. Hidden/offscreen targets receive
no primary-region/action bonus.

States count distinct state IDs. Places count distinct full
`state/viewport[/scheme][#combination]` coordinate keys across the issue's
original groups, including deferred findings and equivalent combinations.
Repeated siblings and duplicate coordinates do not increase these counts.
Breadth has bounded, logarithmic weight; element count adds no score.
Prominence stays in [1, 3.5].

## Grouping and examples

Known deterministic categories with a rule and selector form one presentation
issue per category and exact rule, even across unrelated selectors. Two explicit
repair families combine rules: `adjacent-gap` combines
`idiom:adjacent-elements-touch` with `idiom:focus-ring-collision`;
`overflow-clip` combines `idiom:input-value-truncated` with
`idiom:element-content-clipped`. Document overflow remains separate.
Categories always remain separate. Unknown categories and missing rules retain
selector-pattern fallback: normalize selectors and erase positional indices and
digit runs in IDs and quoted attribute values, preserving tags and stable
classes. Selectorless groups remain independent.

Each group belongs to exactly one issue. The most prominent member group supplies
the example. Defensively, if a bucket has different saliences, compare each
member's own salience × prominence after applying shared state/place bonuses;
never combine one group's salience with another's geometry. Equal products use
member severity then original order. The winning group supplies `id`, the first
entry of `groups`, and the explanation; remaining groups retain original order.
The issue heading reports the worst severity across all its groups. Final issue
sorting uses score, worst issue severity, then original bucket order.

Compact text shows one example and the family occurrence count. `--all` shows
every original group's own rule, problem, evidence and decision command. Commands
still target an individual original group or finding. Mixed-rule issues expose
`rules` and omit the singular `rule`. JSON retains all findings and coordinates;
`primaryAction` is the union across affected occurrences, while
`explanation.primaryAction` describes the winning geometry only.

## Root causes

Groups from **different rules** that share one source collapse into a single
root-cause issue. Sources are tried in confidence order; assignment is greedy
and deterministic. Each tier buckets the groups not yet assigned by candidate
key; buckets are taken largest first, then by confidence, then by key, and a
bucket becomes a root cause only when its unassigned groups meet the tier's
threshold.

| Tier | Key | Threshold | Confidence |
| --- | --- | --- | ---: |
| Token | A custom property referenced by the winning declaration of an offending property on at least half of a symptom's measured targets | 2 groups | 0.9 unresolved on every element, else 0.8 |
| Component | A declared `checks.components` name, else the nearest `data-idiom-name`, else a tag + stable-class signature shared by two or more elements, on at least half of the targets | 2 distinct rule families | 0.7 |
| Style rule | The stylesheet + selector of the winning declaration for an offending property, on at least half of the measured targets | 2 groups | 0.6 |
| Region | The nearest ancestor that is a component boundary and not an app shell | 3 distinct rule families | 0.4 |

Targets come from a finding's `verification.params`: `targets`
(`scale-conformance`, spacing) or `selector` + `property` (`token-drift`),
else the group's selector (component and region tiers only). Authoring
evidence comes from each element's captured `styleSources`, which approximate
the cascade by `!important`, inline style, specificity and order (cascade
layers and shadow scopes are ignored); captures without it skip the token and
style-rule tiers.

A root-cause issue states its cause in one sentence, its confidence, the
grouping evidence and, where one exists, a single suggested fix. Its winning
symptom is the best-scoring group under the shared state/place counts, and

```text
score = winning symptom score * (1 + 0.25 * min(1, log2(max(1, symptoms)) / 3))
```

with the breadth factor in `explanation.breadth`. The issue's `id` is still the
winning group's id and leads `groups`. Every symptom keeps its own group,
finding ids, fingerprints, status and decisions in `rootCause.symptoms`, so
`--fail-on`, the blocking count, decisions and the JSON `findings` and
`groups` arrays are unchanged. Root causes need captured element evidence;
without a ranking context (for example the MCP's recomputed issues) issues
are formed as above.

## Worked example and JSON

An affected primary action occupies 1% of the viewport and is visible in one
state/place. With salience 9, A=.01, F=1, R=1, S=B=0:
`prominence = 1 + .1 + .5 + .5 = 2.1` and `score = 18.9`.
Value-1 hygiene is capped at 3.5 even across forty occurrences, below a single
value-9 broken-behaviour issue with missing geometry (score 9).

```json
{
  "id": "group-example",
  "category": "dead-control",
  "rule": "idiom:control-does-nothing",
  "rules": ["idiom:control-does-nothing"],
  "family": "idiom:control-does-nothing",
  "severity": "major",
  "groups": ["group-example"],
  "elements": 1,
  "places": 1,
  "findings": 1,
  "primaryAction": true,
  "salience": 9,
  "prominence": 2.1,
  "score": 18.9,
  "explanation": {
    "selector": "#save",
    "coordinate": "editor/desktop",
    "areaRatio": 0.01,
    "aboveFold": true,
    "primaryRegion": false,
    "primaryAction": true,
    "states": 1,
    "places": 1,
    "geometryAvailable": true
  }
}
```

Explanation fields expose the winning selector/coordinate when known, area,
fold and primary flags, unique state/place counts and geometry availability.
These inputs reproduce the formula, including neutral fallbacks. Scores and
explanations are issue-summary metadata and are never persisted on findings or
durable groups.

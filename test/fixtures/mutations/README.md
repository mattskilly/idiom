# Seeded UI defects

`catalog.ts` contains fourteen deterministic DOM/CSS transforms. Each review
starts with the original fixture bytes in a fresh browser context. No operator
writes fixtures, changes reviewer settings, adds a new control, or supplies
finding/evidence data. The dead-button operator replaces its existing node with
an identical clone, dropping only its non-delegated event listener.

Generic targets must be unique, visible, stable-ID elements, selected in DOM
order. Text targets are plain leaves with more than 18 characters; buttons must
be enabled, single-line, non-disclosure controls with an existing hit box at
least 44×44. Icon targets contain SVG and an accessible name; the operator
replaces that name with the glyph `i` and strips title, tooltip and description
(a nameless control is axe button-name's finding, which unexplained-control
defers). Gap targets are
identified flex parents with exactly two identified input/button children and
an existing gap of at least 8px. These deliberate preconditions bound this
corpus; every inapplicable operator/page pair is reported with a reason.

Temporal/dead-control targets use explicit fixture behavior capabilities in
`capabilityFor`. The load fixture already inserts a promo after 300ms; the
operator removes its reserved height. The interaction fixture already inserts a
fixed notice; scoped CSS moves just that future notice into document flow. The
loading fixture has one visible pending indicator and an ordinary GET request;
the operator hides the indicator. The motion fixture has a working accordion;
the operator removes its transition. Fixtures use local data and system fonts.

| Operator | Expected check | Expected rule | Exact finding locus |
| --- | --- | --- | --- |
| low-contrast | contrast | axe:color-contrast | selected text |
| small-target | target-size | idiom:minimum-target-size | selected button, 390px viewport |
| off-scale-spacing | scale-conformance | idiom:off-scale-spacing | selected button, paddingLeft, 37px |
| off-scale-radius | scale-conformance | idiom:off-scale-radius | selected button, borderTopLeftRadius, 19px |
| off-centre-label | text-centering | idiom:label-off-centre | selected button |
| touching-controls | adjacent-gap | idiom:adjacent-elements-touch | either member of selected pair |
| unexplained-icon | unexplained-control | idiom:unexplained-control | selected icon button |
| dead-button | dead-control | idiom:control-does-nothing | #action |
| retired-copy | copy-lint | idiom:retired-term | selected text |
| unreserved-load | layout-shift | idiom:layout-shift | attributed inserted aside.promo |
| unreserved-interaction | interaction-shift | idiom:interaction-shift | inserted div[role="status"] |
| missing-pending | loading-state-missing | idiom:loading-state-missing | #load and GET /api/items |
| snapping-content | motion | idiom:motion-snap | #details, expand-collapse, Show more action |
| clipped-copy | clipped-text | idiom:text-clipped | selected text |

The mutation locus and finding locus can differ: hiding `#pending` is judged at
`#load`; removing `#promo-slot`'s reservation is judged by the production load
cause attribution. The latter rule's emitted crop selector names a displaced
bystander, so matching uses `largestShiftCause` on the actual tuple. It never
accepts an unrelated load finding just because its category matches.

`finding-N` IDs depend on a review's other findings. Match the declared rule,
target and property/action/request first, then resolve that candidate through
`buildDeterministicDrafts` and the production fingerprint path, including
`fingerprintHint` for aggregated spacing, radius, loading and motion findings.
The report retains the actual finalized IDs and fingerprints. Adjacent-gap
matching requires both selected endpoints in the verification pair; either may
be the emitted crop selector. Multiple exact matches are retained; rank is the best one and only those matches are excluded
from `otherFindings`.

The runner keeps all deterministic findings. Production finalization assigns
IDs and deduplicates; individual-finding rank is separately computed with
`buildIssueRankingContext`, `affectedCounts` and `scoreGroup` (salience ×
prominence), then severity and stable draft order for ties. This is neither the
severity-first finding-ID order nor the collapsed presentation issue order.

Add an operator by declaring its edit locus, deterministic structural
preconditions and exact expected identity. Give action-dependent operators an
explicit fixture capability, without adding behavior inside the transform.
Add a clean fixture when no existing after page meets those preconditions. Run
the full script, inspect clean controls and replay evidence, and record every
miss as follow-up work. Never change a detection rule to improve this report.

`baseline.json` is the independently measured, fixed twelve-case CI selection.
It includes static rules, dead-control, load shift and content snap; interaction
shift and missing-loading-state are full-script-only. Selection, denominators,
rule membership, per-rule recall, overall recall and previously caught case IDs
are guarded. Tests never regenerate it. See [the field-test procedure](../../../docs/field-test.md#seeded-defect-recall)
for commands and the explicit review process for baseline updates.

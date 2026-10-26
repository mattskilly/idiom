# Compare a build against its intended design

Attach the intended screen to an authored flow state, then run `idiom check <flow>`.
Idiom compares what renders and saves Design / App capture evidence. HTML, live
sites and Figma frames support measured element comparison; images produce
changed-region evidence. Comparison does not edit either side.

## Choose a source

| Source | Declaration or attachment |
| --- | --- |
| HTML export | `idiom design add checkout ./designs/checkout.html` (a directory also works) |
| Public prototype or Claude share | `idiom design add checkout "https://example.com/prototype"` |
| Figma frame | `idiom design add checkout "https://www.figma.com/design/AbC123/Checkout?node-id=12-34"` |
| Image | `idiom design add checkout ./designs/checkout.png` |
| Live site | Put `"design": { "site": "https://example.com/checkout" }` in the state |

### HTML and Claude Design

A local `.html`/`.htm` file is served with assets from its containing folder.
An export directory uses `index.html`, or its sole top-level HTML file. Ambiguous
entries fail with a candidate list. Export a standalone page: Idiom does not
build the reference or install its dependencies, and assets outside the entry
folder are unavailable.

An absolute HTTP(S) HTML prototype URL must load without credentials. Claude
Design/artifact shares use one accessible rendered preview: a visible iframe
(including `srcdoc`) or explicit `rel="preview"` link. The editor/share shell is
never the target. Missing, ambiguous, restricted or expired previews fail with
an export-HTML remedy; not every share wrapper exposes a usable preview.
Public previews need no Claude account integration.

### Figma frames and authentication

Copy a link to the selected frame, including `node-id`. Idiom accepts HTTPS
`figma.com`/`www.figma.com` URLs with `/design/`, `/file/` or `/proto/`, including
`/<file>/branch/<key>/...` and optional `version-id=<version>`.

For the first fetch, set `FIGMA_TOKEN` in the environment running Idiom. Create a
personal access token in Figma's account Settings → Security → Personal access
tokens with `file_content:read`. Idiom sends it as `X-Figma-Token`; it is not saved
in the cache or provenance. See Figma's [token instructions](https://developers.figma.com/docs/rest-api/personal-access-tokens/).
The token's account must have access to the file. Optional `file_variables:read`
resolves variable names where available and requires Enterprise; lacking variables
does not prevent the frame comparison. See Figma's [scopes and permissions](https://developers.figma.com/docs/rest-api/scopes/).
A connected Figma MCP server can provide intent/context to an agent, but does not
replace Idiom's REST token.

The first fetch pins the node tree, 2× PNG render, available variables and metadata
under `.idiom/designs/figma/<file>/<node>/<version>/`; `current.json` selects the
cached version. Commit `.idiom/designs/` so later captures and CI can reuse it
offline without a token. `capture`, `review`, `check` and `verify` accept
`--refresh-design` to refetch. Verify refreshes before its first recapture only;
`fix` keeps the pinned cache. Quick has no refresh flag.

Without an explicit `viewport`, a Figma frame applies at the project viewport
closest to its width (first declared on ties). An explicit viewport name wins.
It defaults to `project.capture.colorScheme`; declare `colorScheme` to override.
Tuples outside that viewport/scheme do not compare this frame. Geometry retains
frame coordinates; the frame does not scale to fit like an image. Layer bounds,
auto-layout spacing, corners, solid strokes/fills, typography and variable names
are normalized for measurement; the PNG supplies visual evidence.

### Images

Use local PNG, JPEG (`.jpg`/`.jpeg`) or WebP files. Download remote images first;
GIF, SVG and remote image URLs are unsupported. Leading bytes must agree with
the extension. Images must have readable dimensions no greater than 8000px on
either axis and a base64-encoded size no greater than 10 MiB.

The browser scales an image to the app viewport width with its aspect ratio
preserved, then both captures are reduced to one pixel per CSS px. Vertical
alignment searches beyond their height difference by ±240 CSS px. A 2× export
therefore compares like a 1× export. Changed regions use a deterministic 4 CSS px
cell grid and perceptual colour difference, discard faint/resampling noise and
very small groups, merge overlaps and keep up to 20 regions, largest first.
Each region is a **minor** finding with paired crops and the app elements it
covers. Rows lacking a counterpart are disclosed as uncompared bands.

These regions are evidence for judgment, without a pixel-perfect guarantee.
They have no reference DOM matching and no property-level reference choices.
`checks.designDrift` numeric tolerances do not configure the region algorithm.
When model critique is configured, it can separately critique the aligned design
image and regions; `check` needs no model for deterministic region findings.

### Live sites and application auth

A flow's `{ "site": "https://example.com/checkout" }` uses the URL literally,
without joining it to the app origin/path. It must be absolute HTTP(S), without
embedded credentials. The reference uses the app tuple's viewport and colour
scheme, and the state's `settleMs` (falling back to project capture settings).
HTML/image references otherwise apply across captured viewports and schemes
unless explicitly limited.

Browser references load in fresh contexts. They do not replay the application's
login/setup steps or inherit a signed-in desktop session. Configure authenticated
**app** states through their own flow setup and steps. References must be
accessible independently: non-2xx/non-HTML responses, sign-in/access walls and
empty/error previews fail with a remedy to use an accessible page or export.

## Declare and attach references

The `design` field accepts a bare source string, an object with `source` or
`site`, or a nonempty array. Objects may set `name`, `viewport` and `colorScheme`.
For example, this is a state-field fragment, not a complete flow:

```json
"design": [
  { "source": "designs/checkout.html", "name": "prototype", "viewport": "desktop", "colorScheme": "light" },
  { "site": "https://example.com/checkout", "name": "production" }
]
```

Names are lowercase slugs. Defaults are `figma`, `site` and otherwise `design`,
de-duplicated with `-2`, `-3`; explicit names must be unique. Without `--name`,
`idiom design add <state> <source>` replaces the entire declaration. With
`--name`, it adds or replaces that explicitly named entry, preserving others.
`--viewport <name>` limits the attachment to a project viewport. Set scheme in
the flow JSON. Use `--flow <id>` when state IDs repeat across flows.

Attachment changes only an authored state's `design` field in its original
manifest. Generated pages/routes/combinations need an explicit authored state.
Repeating an assignment is a no-op. Local command paths resolve from the invocation
directory and are stored project-relative when possible; paths authored directly
in flows resolve from the project root. A state reached `from` another state keeps
its own design rather than inheriting its ancestor's screen; toggle expansions
retain the base state's design.

## Understand matches and measurements

Element matching tries strong `data-node-id` and `data-idiom-name` keys first,
then accessible role/name and text. Matched content can anchor containers;
container/position fallback handles limited wrapper changes. Ambiguous repeated
candidates are not arbitrarily paired. Give corresponding HTML elements the same
unique `data-idiom-name` to make intent explicit.

For Figma, meaningful layer names match `data-idiom-name` or accessible names;
automatic names such as `Frame 12` are ignored. An app `data-node-id="12:34"`
pins to that Figma node. App-specific non-Figma node IDs do not block a Figma match.
If a difference looks implausible, inspect the reported match method, selectors,
values and paired crops before changing the app. Add stronger names or correct a
misleading layer name and capture again.

Measurements include width/height, position relative to matched parents, actual
edge gaps between adjacent matched siblings, corner radii, border widths/styles,
font size/line height/weight/family, colours and owned text. Translating a subtree
does not produce a position finding for every descendant. Missing and extra
content are reported too; an unmatched subtree can summarize its descendants.
Reports show full Design / App capture views even when clean. Findings include
both values, match evidence, a proposed fix and paired design/app crops in the
Markdown, HTML and JSON evidence.

## Set tolerances and severity

The following **designDrift settings** go under `checks.designDrift` in
`.idiom/project.json` (not in the flow):

```json
{
  "tolerance": { "ratio": 0.15, "px": 1, "mode": "tighter" },
  "gap": { "px": 2 },
  "fontWeight": 100,
  "color": 2
}
```

The default common tolerance is ratio 0.15, px 1, `tighter`.
`tighter` allows `min(abs(design) * ratio, px)`; `looser` allows the maximum.
Per-property `size`, `position`, `gap`, `radius`, `borderWidth`, `fontSize` and
`lineHeight` overrides inherit omitted fields from the common policy. Position
uses the reference child's width/height as its basis. Measurements use CSS px.
A difference must be **strictly greater** than its allowance: radius 8 → 9 passes,
while 8 → 9.01 reports under defaults. Zero is a real reference value and has
zero allowance in tighter mode.

`fontWeight` is an absolute weight-unit threshold (default 0); `color` is the
maximum per-channel RGBA delta on a 0–255 scale, including alpha (default 0).
Font families ignore case/quoting; Figma compares its family with the first app
family. Text ignores whitespace runs. Text, families and border styles compare
discretely; `normal` line height and unknown colours stay literal.

Measured drift, copy, extras and image regions are normally minor. A declared
scale step can make numeric drift major: a marked card with
`checks.scales.radius.card: [4, 8, 12, 16]` changing 8 → 12 is major, but 8 → 11
is minor. No scale is inferred from a screenshot. Missing controls, headings,
main content and its illustrations are major. `enabled: false` skips design
comparison and prevents verification of existing design findings. See the full
[settings contract](configuration.md#design-comparison) and [design-drift rule](rules.md#design-drift).

## Resolve conflicting intent and verify repairs

When element references disagree about one matched element/property, Idiom emits
`idiom:design-decision`, showing each reference's value and what the app matches.
It is a question for a person, rather than a defect against either reference.
Use the actual finding ID from the report:

```sh
idiom decide --finding <id> --choose <name> --reason "This is the approved reference for this property."
```

The recorded choice applies to that element/property in its flow/state/scheme
scope; it does not make one reference win across the project. It is stored in
`.idiom/decisions.jsonl`; commit the log immediately. Later comparisons use the
chosen reference for that property. `--choose` is CLI-only, requires a design
decision, and cannot combine with `--accept`, `--reject` or `--group`.
For an intentional departure from an agreed design, record an ordinary finding
rejection with a human reason instead.

Capture once, then replay with
`idiom review <flow> --from <run-id> --deterministic-only` for offline review of
saved evidence without reopening the source. Verification needs continuous,
comparable reference evidence in the source run and both current captures;
missing/changed references cannot prove a repair. Image-region verification
requires the same source image bytes in all three. Keep Figma caches pinned and
references stable during repairs. See [commands](commands.md#intended-designs)
and the [MCP repair sequence](mcp.md#repair-sequence).

## Worked example: an 8px card rendered at 12px

Install Idiom and its matching Chromium browser as in the [README](../README.md#browser-setup).
Use a disposable directory. Run `idiom init --yes` there; retain the generated
project configuration and PRODUCT.md/DESIGN.md. Configure the project with a
`desktop` viewport (1440×900), light colour scheme and no `checks.scales` for this
example. Create `designs/` and `app/` directories. Set the project's
**server settings** below, keeping the rest of the generated project object.
Python 3 must be installed. Idiom starts and stops the static server on its allocated port;
leave that port free rather than starting the server yourself.

```json
{
  "build": "true",
  "start": "python3 -m http.server 3000 --bind 127.0.0.1 --directory app",
  "readyUrl": "http://127.0.0.1:3000/",
  "port": 3000,
  "env": {}
}
```

`true` is the no-op build command on macOS/Linux. Idiom substitutes the allocated
port for 3000 in the start command and ready URL. See [server configuration](configuration.md#project-file).

Save this as `designs/card.html`:

```html
<!doctype html>
<html lang="en">
<meta charset="utf-8">
<title>Card example</title>
<style>
  body { margin: 32px; font: 16px/24px Arial, sans-serif; }
  article { width: 320px; padding: 24px; border: 1px solid #777; border-radius: 8px; }
</style>
<article data-idiom-name="checkout-card">Order summary</article>
</html>
```

Copy it to `app/index.html`, changing only `border-radius: 8px` to
`border-radius: 12px`. Both sides keep the same `data-idiom-name`.
Create `.idiom/flows/store.json` with this complete **worked flow**:

```json
{
  "id": "store",
  "title": "Store card",
  "intent": ["Render the approved order summary card"],
  "setup": [],
  "target": { "kind": "web" },
  "viewports": ["desktop"],
  "colorSchemes": ["light"],
  "states": [
    {
      "id": "checkout",
      "description": "Order summary card",
      "url": "/",
      "steps": [],
      "expect": { "status": 200 },
      "design": { "source": "designs/card.html", "name": "approved" }
    }
  ]
}
```

From the project root, validate and attach (the identical attachment is a no-op):

```sh
idiom validate store
idiom design add checkout ./designs/card.html --flow store --name approved
idiom check store --all --fail-on never
```

`--all` displays minor findings and bypasses baseline bootstrap/comparison.
`--fail-on never` permits findings while still failing operational errors. With
no configured scales, this 8 → 12 drift is minor and does not fail the default
major gate. Illustrative measurement, not a stable output/ID:

```text
[minor] idiom:design-drift
borderTopLeftRadius: design "8px"; app "12px" (allowance 1). Match: data-idiom-name.
```

Other corners can produce findings too. Follow the command's printed `report.md`
or `report.html` under `.idiom/reports/<run-id>/`. In `report.md`, each finding's
`Evidence:` paths resolve relative to that run directory and show paired
Design / App capture crops;
use its `findings.json` for exact IDs and measurements.

To exercise a decision, copy `designs/card.html` to `designs/card-round.html` and
change its radius to 16px. Add it beside the named original reference:

```sh
idiom design add checkout ./designs/card-round.html --flow store --name round
idiom check store --all --fail-on never
```

Find an `idiom:design-decision` for the card's radius in this report.
Ask the person responsible which reference is intended, then use that decision's
actual ID in place of `<id>` (repeat for other properties/corners as needed):

```sh
idiom decide --finding <id> --choose approved --reason "The approved order-summary card uses 8px corners."
idiom check store --all --fail-on never
```

Choosing `approved` returns that property to ordinary 8px-versus-12px drift.
Change the app to 8px and recapture to check the repair.

For a separate one-page image comparison, start the app yourself (for this static
example, `python3 -m http.server 3000 --directory app`). Run quick outside any
configured project:

```sh
cd /path/to/uninitialized-directory
idiom quick http://127.0.0.1:3000/ --design /absolute/path/to/checkout.png
```

Quick accepts exactly one page with `--design`. A Figma URL stays Figma, a
recognized Claude share stays an HTML design, and other HTTP(S) URLs become live
sites. MCP `idiom_quick` has no design argument; use configured flow declarations
with `idiom_check`, `idiom_fix_plan` and `idiom_verify`. See [MCP setup](mcp.md).

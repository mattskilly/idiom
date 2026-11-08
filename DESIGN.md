# Design context

This file describes the design of idiom.build, the public landing page and documentation site, as read from `site/index.html` and `site/docs/docs.css`. It is not a description of the Idiom CLI.

## Visual character

A designer's redline on an off-white sheet. Calm, editorial and precise: a left rail of monospace labels, a hairline spine, and a single red accent used the way a reviewer marks up a layout (selection frames, ticks, the current item). Nothing decorative competes with the content.

## Colour

Tokens are CSS custom properties on `:root` in `site/index.html`, shared by the docs.

| Token | Light | Dark | Use |
| --- | --- | --- | --- |
| `--bg` | `#fafaf8` | `#0d0d0e` | page background |
| `--surface` | `#ffffff` | `#151517` | cards, code blocks, inputs, pager |
| `--sunk` | `#f2f2ee` | `#1b1b1e` | inline code, table headers, image wells |
| `--fg` | `#111113` | `#f2f2ef` | body text and headings |
| `--muted` | `#5c5c63` | `#a3a3aa` | secondary text, navigation |
| `--faint` | `#76767d` | `#8b8b92` | markers, prompts, table header text |
| `--rule` / `--rule-strong` | `#e3e3de` / `#c9c9c2` | `#26262a` / `#3a3a40` | hairlines, borders |
| `--redline` / `--redline-ink` / `--redline-wash` | `#e0352b` / `#b8271f` / `#fdecea` | `#ff5a4c` / `#ff7a6e` / `#2c1513` | the accent: focus rings, current item, hover ink, major severity |
| `--pass` / `--pass-wash` | `#0a7c52` / `#e6f3ed` | `#3bd99a` / `#10261d` | passing results |

Dark follows `prefers-color-scheme` until the reader picks a theme with the header toggle; the choice is stored and applied as `data-theme="light|dark"` on the root, which overrides the system setting.

## Typography and hierarchy

- Archivo (display, 500–800) states: headings, the wordmark, pager titles.
- Instrument Sans (body) explains: paragraphs, lists, tables.
- IBM Plex Mono measures: rail labels, the masthead, kickers, table headers, code, the docs sidebar group labels. Usually uppercase with wide tracking at `--step--1`.
- Fluid scale: `--step--1` (~0.75–0.8rem), `--step-0` (1–1.1rem, body), `--step-1` (1.25–1.6rem), `--step-2` (1.9–3rem), `--step-3` (2.6–5.4rem, landing headline). Headings use tight negative tracking; body line height is 1.6.
- Fonts are inlined as woff2 so the page renders offline.

## Density and layout

- Landing: a 72rem shell; each section is a two-column grid with a 9rem rail for its mono label and a content column, separated by a 2.5rem gap and a hairline spine with a red tick where each section meets it. Section padding is fluid (48–96px). Below 760px the rail collapses above the content and the spine disappears.
- Docs: a three-column grid (13rem sidebar, reading column capped at 58ch, 12rem on-page contents) with 48px gaps. Below 1160px the on-page contents hide; below 900px the sidebar becomes a collapsible "menu" disclosure above the content.
- Page gutters scale with `clamp(16px, 4vw, 48px)`.

## Components and patterns

- Masthead: wordmark with a red full stop, a mono meta line, navigation, and the theme toggle (a 34px square button).
- Docs sidebar: grouped mono labels, links with a left hairline; the current page is bold `--fg` with a red left rule (`aria-current="page"`). Search sits above it and filters titles and headings in place.
- Prose: `h2` sections start with a top hairline; heading anchors reveal `#` on hover; blockquotes carry a red left rule.
- Code blocks and the landing terminal: `--surface` box, hairline border, 6px radius, horizontal scroll.
- Tables: wrapped in `.table-scroll` (bordered, scrolls horizontally); mono uppercase headers on `--sunk`; first column mono.
- Pager: previous/next cards at the foot of each docs page.

## Interaction conventions

- Links are underlined with a `--rule-strong` underline that turns to the redline ink on hover.
- Focus is always visible: a 2px redline outline with a 3px offset.
- Colour transitions are 0.15s. Landing entrance animations (selection frame, terminal lines, reveals) run only under `prefers-reduced-motion: no-preference`; content is fully present without them.

## References

- A designer's markup on a printed proof: hairlines, a single accent colour and measured labels convey precision without decoration.
- Well-edited technical reference: a stable sidebar, a readable column and anchors for every section.

## Anti-references

- Generic SaaS landing pages with gradient blobs, stock illustration and card grids of features: they read as unconsidered, the opposite of what a design checker should look like.
- Docs sites where navigation disappears on phones or tables overflow the page.

## We do

- Use only the tokens above; the redline accent marks attention, never decoration.
- Keep every page readable at 390px: navigation reachable, tables and code scrolling in place.
- Keep light and dark at parity.

## We do not

- Add new colours, fonts or shadows outside the token set.
- Animate content when reduced motion is requested, or hide content behind animation.
- Use placeholder text, broken images or controls that do nothing.

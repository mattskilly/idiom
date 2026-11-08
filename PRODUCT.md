# Product context

This file describes idiom.build, the public landing page and documentation site for Idiom, as checked by this repository's own `idiom check`. It is not documentation for the Idiom CLI; that lives in `README.md` and `docs/`.

## Target user

- Builders evaluating Idiom: people shipping UI with coding agents who arrive from a link, a search or a package page and want to know in a minute whether Idiom is worth installing.
- Readers of the docs, people and agents alike: someone who has installed Idiom and needs to set up a flow, understand a finding, or look up a rule or a configuration key. Agents also read the plain-text twins (`.md`, `llms.txt`), which are not checked here.

## Job to be done

- Understand what Idiom does (it opens the running app, checks the states a person sees, and tells the agent how to fix what it finds) and how it differs from code review.
- Install it and get a first result in minutes.
- Look something up in Reference quickly and land on the right section.

## Flow objective

The `site` flow covers the landing page, the docs overview, the getting-started page, both guides, and the rules and configuration reference pages at phone, tablet and desktop widths in light and dark.

## What must be obvious

- On the landing page: what Idiom is, from the headline and lede, and the install command.
- On every docs page: where you are (the current page is marked in the sidebar), how to get to the other pages (sidebar or, at narrow widths, the menu), and the page title.
- On reference pages: that the page is long and scannable, with headings, an on-page table of contents at wide widths, and tables that scroll rather than overflow.

## Success criteria

- Every page renders its title, navigation and content at 390, 768 and 1440 pixels wide with no horizontal page overflow; wide tables and code blocks scroll inside their own box.
- Light and dark schemes are both readable, with body text, muted text and links meeting contrast in each.
- Every link and control works and has a visible keyboard focus.
- Nothing on a page is broken: no missing images, no console errors, no placeholder text.

## Hard constraints

- The site is a static build of `site/` and the docs markdown; it must render without a network connection (fonts are inlined) and without JavaScript for its content.
- Docs reference pages render from the same markdown the repository ships, so content stays in sync with the CLI; the site never carries hand-maintained copies of reference content.
- Respect `prefers-reduced-motion` and `prefers-color-scheme`.

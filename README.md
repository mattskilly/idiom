# Idiom

Design acceptance for AI-built software: Idiom opens your running app in a real browser, finds the design defects your coding agent left behind, fixes them, and keeps them from coming back.

## Who it's for

Anyone building UI with AI coding agents such as Claude Code, Codex or Cursor. Idiom judges what actually renders, across every state, viewport and colour scheme, rather than the source code. It runs on its own from the terminal or CI. If you use Autobuild, it plugs in as a verify step, but it doesn't need Autobuild.

## How it works

1. **Check**: `idiom quick <url>` or `idiom check <flow>` renders every state, viewport and colour scheme, then reports ranked issues.
2. **Fix**: `idiom fix <flow>` hands the findings to your coding agent, then recaptures to prove each one is fixed.
3. **Guard**: the first `idiom check` on a committed HEAD records today's findings as a baseline. After that, checks and the GitHub Action fail only on new findings.

Under the hood the loop is Learn → Render → Critique → Repair → Verify → Remember.

## Before and after

![Before: the benchmark page editor, with a bare "?" beside Layers, 12px override dots and the Name this version button flush against the Versions cards](docs/images/benchmark-before.png)

![After: the same editor with the Layers shortcut help shown, 8px override dots, labelled toolbar buttons and spaced Versions controls](docs/images/benchmark-after.png)

This is the benchmark fixture in `test/fixtures/benchmark/`: an AI-built editor with seven defects that a human found and an earlier Idiom missed. With no configuration beyond the fixture's `DESIGN.md`, Idiom reports all seven on the before page and none on the after page:

- a bare "?" beside the Layers heading
- Page settings reachable three ways
- override dots at 12px against an 8px design
- Button / Highlight specimen text below centre
- composer input touching Send; Versions cards flush with their button
- "Name this version" does nothing
- "View terms" and the top-bar Help as disabled navigation buttons

## Install

You need Node 20 or newer. Install the CLI globally with npm or Bun:

```sh
npm install -g @mattskilly/idiom
# or: bun add -g @mattskilly/idiom
idiom --version
```

The version command prints `<version> (<short source commit>)`, for example `0.9.0 (a6439b1)`. To pin a project to an exact release instead, add it as a dev dependency (`bun add -d --exact @mattskilly/idiom@0.9.0`) and run it with `bunx idiom` or `npx idiom`.

### Browser setup

Capture also needs the Playwright-managed Chromium binary once per machine. Its version deliberately matches the exact runtime dependency in this tag:

```sh
bunx playwright@1.62.1 install chromium
```

In a Linux CI image, install Chromium and its operating-system dependencies with:

```sh
bunx playwright@1.62.1 install --with-deps chromium
```

Browser installation is separate because it may require network and elevated system-package access.

## Try Idiom in two minutes

Start the application yourself, then point Idiom at one or more public pages from the same origin:

```sh
cd /path/to/any/uninitialized-directory
idiom quick http://127.0.0.1:3000/
```

Add explicit pages to the same command when you already know the routes; Idiom preserves their order and does not crawl links or submit forms:

```sh
idiom quick \
  http://127.0.0.1:3000/ \
  http://127.0.0.1:3000/pricing \
  http://127.0.0.1:3000/contact
```

The command captures every supplied page at desktop (1440×900) and mobile (390×844) sizes in both light and dark colour schemes. It runs the deterministic checks and prints the exact `report.md` and `report.html` paths, beneath `idiom-quick-reports/` unless you pass `--out <dir>`.

Quick review needs no Idiom files, flow manifest or model credentials. Its final **Quick-review limits** section names what a public-page pass cannot cover, such as authenticated surfaces and fixture-driven states; run `idiom init` to cover those. Details are in [docs/commands.md](docs/commands.md#quick).

## Go deeper with configured flows

Quick review is the entry point, not the coverage ceiling. Configure a flow when you need authenticated surfaces, interaction destinations, error and empty states, product-specific design guidance, durable decisions, or before/after verification:

```sh
idiom init --yes          # scaffold PRODUCT.md, DESIGN.md and .idiom/
idiom validate home       # after defining .idiom/flows/home.json
idiom check home          # every deterministic finding; records the baseline
idiom review home         # deterministic + model critique
```

- [docs/commands.md](docs/commands.md): every command, its flags and its output.
- [docs/configuration.md](docs/configuration.md): the project file, flows, checks and baselines.
- [GitHub Action](docs/configuration.md#github-action) and [Autobuild wiring](docs/configuration.md#autobuild) for pull-request and build gates.

## Update Idiom

```sh
npm install -g @mattskilly/idiom@latest
# or: bun add -g @mattskilly/idiom@latest
idiom --version
```

Check [CHANGELOG.md](CHANGELOG.md) for new configuration before updating a pinned project.

## Local development

Maintainers working from a clone can build and link the checkout instead:

```sh
bun install
bun run build
bun link
```

`npm link` is the Node-only alternative. These clone/link instructions are for repository development, not external installation.

## Documentation

| Doc | Purpose |
| --- | --- |
| [docs/commands.md](docs/commands.md) | Every command, its flags and its output |
| [docs/configuration.md](docs/configuration.md) | Project file, flows, checks, baselines, Autobuild and the GitHub Action |
| [CHANGELOG.md](CHANGELOG.md) | User-visible changes in every released version |
| [docs/architecture.md](docs/architecture.md) | Technical architecture and Autobuild seam |
| [docs/releases.md](docs/releases.md) | Maintainer release checklist |
| [docs/schemas.md](docs/schemas.md) | Project, flow, finding, and decision record schemas |

**Every state, not every page. Build in your idiom.**

## License

Idiom is licensed under the [Apache License 2.0](LICENSE).

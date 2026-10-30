---
title: Getting started
description: Install the Idiom CLI, review a running page with no setup, hand the tools to your coding agent, then declare a flow for the full loop.
---

# Getting started

You need Node 20 or later and an app running locally. The first review takes a few minutes and needs no configuration and no model key.

## 1. Install

```sh
npm install -g https://github.com/mattskilly/idiom/releases/download/v0.16.1/mattskilly-idiom-0.16.1.tgz
npx playwright@1.62.1 install chromium
```

The first line installs the CLI from the GitHub release. npm still serves an older release; once the current one is published there, `npm install -g @mattskilly/idiom` works too. The second line installs the browser Idiom captures with, once per machine.

## 2. Review a page

```sh
idiom quick http://localhost:3000
```

Idiom opens the page at desktop and mobile widths, in light and dark, clicks through its controls with a probe that only lets read-only requests leave the browser, and runs every measured check. It writes `report.html` with each finding, a crop of the problem and how to fix it, plus a list of what a no-setup pass cannot reach (signed-in pages, error states that need fixtures).

## 3. Hand it to your agent

The Claude Code plugin bundles MCP tools, the Idiom skill and reminders after UI edits; in Codex the plugin adds the skill and `codex mcp add` adds the tools. A global CLI install is optional for plugin use. It needs Node 20 or later, npm/npx and the matching Chromium from step 1. The first MCP launch downloads the exact GitHub release named by the plugin.

In Claude Code:

```text
/plugin marketplace add mattskilly/idiom
/plugin install idiom@idiom
```

For Codex, in your shell:

```sh
codex plugin marketplace add mattskilly/idiom
codex plugin add idiom@idiom
codex mcp add idiom -- npx -y --package=https://github.com/mattskilly/idiom/releases/download/v0.16.1/mattskilly-idiom-0.16.1.tgz idiom mcp
```

Codex starts a plugin's MCP server inside the plugin's own directory rather than your project, so the Codex plugin supplies the Idiom skill and `codex mcp add` registers the MCP server, which Codex starts in each thread's project directory.

Update Claude Code with `/plugin marketplace update idiom`, then `/plugin update idiom@idiom`. Run `/reload-plugins` or start a new session to apply it. For Codex, run `codex plugin marketplace upgrade idiom`, then `codex plugin add idiom@idiom`, rerun the `codex mcp add` line above with the new release (it replaces the entry), and start a new session.

Remove a duplicate standalone server when switching (`claude mcp remove idiom` for Claude Code). For standalone clients, credentials, long-running tool timeouts and local plugin development, see [MCP](/docs/mcp). [Design QA for Claude Code](/docs/design-qa-for-claude-code) walks through the repair loop.

## 4. Declare a flow

`idiom quick` sees what a visitor sees. To cover the states a visitor rarely reaches, set up the project:

```sh
idiom init
```

`init` reads your repo, asks what code can't answer, and writes three things:

- `PRODUCT.md` and `DESIGN.md`: your product's purpose and design law, which your agent reads before it writes UI.
- `.idiom/project.json`: how to start your app, viewports and check settings.
- `.idiom/flows/*.json`: flows, each a list of named states with how to reach them.

Then run the loop on a flow:

```sh
idiom check home          # every finding, in fix order
idiom fix home            # hand the top findings to your agent
idiom verify home         # prove they are gone
```

See [Configuration](/docs/configuration#flows) for the flow format and [Testing loading, empty and error states](/docs/testing-loading-empty-error-states) for forcing the hard states.

## 5. Gate pull requests

```sh
idiom check home                  # the first run records a baseline; commit .idiom/baselines
idiom check home --fail-on major  # later runs fail only on new problems
```

The first check on a clean commit records a baseline. After that, `check` reports only findings the baseline didn't have, and `idiom baseline accept home` accepts intentional changes. The [GitHub Action](/docs/configuration#github-action) runs this on every pull request and posts one comment.

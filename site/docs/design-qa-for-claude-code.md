---
title: Design QA for Claude Code
description: Give your coding agent a repeatable UI review: capture the intended states, inspect the findings, repair the source and verify the same evidence.
---

# Design QA for Claude Code

Give your coding agent a repeatable UI review: capture the intended states, inspect the findings, repair the source and verify the same evidence.

_For Idiom v0.16.1_

## Start by looking

**Review the experience, then the evidence.**

A useful UI review begins with tasks a person can finish. These checks work with or without Idiom:

1. Follow the main task at a narrow and a wide viewport, in light and dark. Look for clipped labels, overlap, unreadable contrast and broken images.
2. Use the keyboard: controls need names, a visible focus indicator and a reachable primary action.
3. Wait for data, try an empty account and force a request to fail. The interface should explain each condition and offer a next step.
4. Compare against the intended design. Ask the human about intentional differences; record their choice and reason.

Repeat a **check–fix–verify** cycle after source edits. A check producing a report is evidence of checking; it does not establish that its findings were repaired.

## Install

**Use the local CLI and a real browser.**

Install Node 20 or newer, then Idiom and its matching Playwright Chromium. The browser pin below matches this release's package metadata.

```sh example=shell
npm install -g https://github.com/mattskilly/idiom/releases/download/v0.16.1/mattskilly-idiom-0.16.1.tgz
npx playwright@1.62.1 install chromium
idiom init --yes
```

Run initialization from your application's repository. It scaffolds `.idiom/`, `PRODUCT.md`, `DESIGN.md` and the vendored `/idiom` skill, preserving changed files. Review the generated design documents with the human.

Deterministic checks run locally without a paid Idiom service or model key. Model critique in review or sweep is optional and uses your configured model provider. Figma references separately need a token in the server environment.

## Configure

**Make one flow reproducible.**

This complete `.idiom/project.json` example assumes a Vite-style application with working `npm run build` and `npm run dev` scripts. Adapt the start command and port to your application. Confirm that `http://127.0.0.1:3000/settings` is real HTML and renders a Settings heading, including in a fresh browser context.

```json example=project
{
  "version": 1,
  "app": {
    "name": "Example app",
    "framework": "other"
  },
  "server": {
    "build": "npm run build",
    "start": "npm run dev -- --host 127.0.0.1 --port 3000",
    "readyUrl": "http://127.0.0.1:3000/",
    "port": 3000,
    "env": {},
    "startupTimeoutMs": 60000
  },
  "viewports": [
    {
      "name": "desktop",
      "width": 1440,
      "height": 900
    },
    {
      "name": "mobile",
      "width": 390,
      "height": 844
    }
  ],
  "surfaces": [],
  "colorSchemes": [
    "light",
    "dark"
  ],
  "capture": {
    "timezoneId": "America/New_York",
    "locale": "en-US",
    "colorScheme": "light",
    "reducedMotion": true,
    "fullPage": true,
    "settleMs": 250
  },
  "design": {
    "productFile": "PRODUCT.md",
    "designFile": "DESIGN.md"
  },
  "model": {
    "provider": "claude-code",
    "model": "claude-sonnet-5-5",
    "maxFindings": 5
  }
}
```

Save this complete flow as `.idiom/flows/settings.json`. Replace the route and expectations with an actual task. Configure authentication and deterministic setup for protected routes before capturing.

```json example=flow
{
  "id": "settings",
  "title": "Settings",
  "intent": [
    "Settings remain readable and usable."
  ],
  "setup": [],
  "states": [
    {
      "id": "settings",
      "description": "Settings page at rest",
      "url": "/settings",
      "steps": [],
      "expect": {
        "textPresent": [
          "Settings"
        ],
        "selectorPresent": [
          "h1"
        ]
      }
    }
  ]
}
```

```sh example=shell
idiom validate settings
idiom check settings
idiom report
```

A finding gate can make `check` exit nonzero after writing a valid report. Startup or capture errors need fixing before a clean UI claim. Read the report's coverage alongside the findings.

## Connect

**Install the plugin from the marketplace.**

In a Claude Code session:

```text
/plugin marketplace add mattskilly/idiom
/plugin install idiom@idiom
```

The plugin supplies MCP, the conversational `/idiom:idiom` skill and reminders together. It needs Node 20 or newer, npm/npx and the matching Chromium shown above. You can use it without a global CLI install. Its first MCP launch downloads the exact GitHub release named by the plugin; the server inherits your application's working directory.

Update Claude Code with `/plugin marketplace update idiom`, then `/plugin update idiom@idiom`. Run `/reload-plugins` or start a new session to apply it. For Codex, run `codex plugin marketplace upgrade idiom`, then `codex plugin add idiom@idiom`, rerun the `codex mcp add` line above with the new release (it replaces the entry), and start a new session.

In Codex, the plugin supplies the portable skill and one more line adds the MCP server:

```sh
codex plugin marketplace add mattskilly/idiom
codex plugin add idiom@idiom
codex mcp add idiom -- npx -y --package=https://github.com/mattskilly/idiom/releases/download/v0.16.1/mattskilly-idiom-0.16.1.tgz idiom mcp
```

Codex starts a plugin's MCP server inside the plugin's own directory rather than your project, so the Codex plugin supplies the Idiom skill and `codex mcp add` registers the MCP server, which Codex starts in each thread's project directory.

### Standalone MCP

For a separate connection using the CLI installed above, run from the application directory:

```sh example=shell
claude mcp add idiom -- idiom mcp
```

To bind a different root, use `claude mcp add idiom -- idiom mcp --project /absolute/path/to/app`. Remove that registration with `claude mcp remove idiom` before switching to the plugin to avoid duplicate connections. See [MCP](/docs/mcp) for timeouts and credentials and the [Claude Code MCP reference](https://code.claude.com/docs/en/mcp) for scopes and diagnostics.

### Local plugin development

For a source checkout or unpacked package:

```sh example=shell
claude plugin validate /path/to/checkout
claude --plugin-dir /path/to/checkout
```

The release manifest still starts the pinned release server. To develop changed MCP code, run `bun run build` in the checkout, then use a separate `claude mcp add idiom-dev -- node /path/to/checkout/dist/cli.js mcp` registration. Use one connection at a time. The project-vendored skill remains `/idiom`.

## Reminders

**Hooks prompt; the agent performs the review.**

The plugin's PostToolUse hook reminds Claude after Edit, Write or legacy MultiEdit changes a matching UI file. It names files and configured flows/states, with a changed-check suggestion. With no usable flow it points to initialization. Neither hook launches captures.

The Stop hook blocks once per reminder epoch when UI differs from the last successful live check, asking the agent to check or explain why that is impractical. Further edits do not reset that reminder. A successful check begins a new epoch. The hook does not inspect the quality of the explanation; a check that finds problems still counts as checking.

These are partial project settings to merge into `.idiom/project.json`. This example replaces the default matching patterns:

```json example=project-partial
{
  "agent": {
    "uiGlobs": [
      "src/**/*.tsx",
      "src/**/*.css"
    ]
  }
}
```

Or opt out of the reminders and their bookkeeping:

```json example=project-partial
{
  "agent": {
    "hooks": false
  }
}
```

Set a separate findings-completion policy in the agent's task instructions: blocking measured or observed findings must be resolved and verified, or explicitly waived by the human before UI work is declared complete. An acknowledgment of a reminder provides no repair evidence.

## Close the loop

**Keep the original evidence through repair.**

1. Read `idiom_context {}` and `idiom_flows {}` for the design brief and applicable flows.
2. Call `idiom_check` with `{"flow":"settings"}`. The default can compare or bootstrap a baseline on clean committed HEAD; commit a new baseline deliberately. Use `all:true` when you need every live finding without baseline changes.
3. Inspect a returned ID with `idiom_issue`. Read its rule, selector, measurement and screenshot or temporal filmstrip. Missing evidence must be reported.
4. For requested repairs, call `idiom_fix_plan` with `{"flow":"settings"}`. It takes a full snapshot and returns the repair prompt, selected original records and a next call.
5. Make authorized application source edits, then pass the returned `next.arguments` unchanged to `idiom_verify`. Do not invent finding bodies or reconstruct references from a newer run.
6. Inspect each fixed, reproduced or unverifiable result and the introduced findings. Verify uses two calibrated captures; a target passing alone does not establish regression freedom.

Scoped or incomplete source evidence needs a full successful check or fix-plan before calibrated verification. Quick review is useful for a public, unconfigured page but cannot supply configured-flow verification references. Authentication, fixtures and deeper states require a configured flow.

Report unresolved targets, introduced findings and coverage limits. Keep model suggestions separate from deterministic evidence, and leave design judgment with the human. Never infer acceptance, rejection or a waiver. Repairs belong to the calling agent within its authorized task; review-only invocation does not authorize source changes.

Next: build the [loading, empty and error state checklist](/docs/testing-loading-empty-error-states), or read the [docs](/docs).


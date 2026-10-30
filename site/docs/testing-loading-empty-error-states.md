---
title: Testing loading, empty and error states
description: A fast happy path hides waiting, missing content and failed requests. Make those conditions repeatable, check their feedback and keep the evidence through repair.
---

# Testing loading, empty and error states

A fast happy path hides waiting, missing content and failed requests. Make those conditions repeatable, check their feedback and keep the evidence through repair.

_For Idiom v0.16.1_

## Start by looking

**Test the moments between useful content.**

You can use this checklist in any browser before configuring a tool:

1. **Loading:** show visible pending feedback close to the action. Reserve space so the result does not push other content around.
2. **Repeat activation:** protect pending writes against duplicate submission, including keyboard activation.
3. **Empty:** explain why content is absent and offer a useful next action, such as creating an item or changing a filter.
4. **Error:** describe the failure in human terms. Keep entered work, clear the pending state and provide a usable retry.
5. Repeat at narrow and wide viewports, in light and dark, and with keyboard focus visible.

## Arrange

**Make the app provide repeatable conditions.**

This example assumes an application you own with `npm run build` and a Vite-style `npm run dev` server on port 3000. Implement these test fixtures in the app before copying the flow:

- `/library?fixture=items` renders “Your library”, a `#results` region with `.result` items, and a `#refresh` button that fetches items.
- `/library?fixture=empty` returns an empty collection, shows “No items yet” and a `#create-item` action inside `#results`.
- `/library?fixture=error` deterministically shows “Could not load items” in a visible `role="alert"`, with `#retry` enabled and wired to attempt the read again.

These URLs and selectors are an application fixture contract, not routes or mocks created by Idiom. Keep fixture controls restricted to your test environment. Provide deterministic accounts and data; configure authentication if the app needs it. Confirm each URL manually in a fresh browser. This example needs no setup command because the app selects its fixture from the query parameter; use flow `setup` commands for your own seeding if necessary.

Install Node 20 or newer and initialize from the app repository:

```sh example=shell
npm install -g https://github.com/mattskilly/idiom/releases/download/v0.16.1/mattskilly-idiom-0.16.1.tgz
npx playwright@1.62.1 install chromium
idiom init --yes
```

## Configure

**Hold responses and inject failures.**

Complete `.idiom/project.json` for the assumed app:

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
  },
  "checks": {
    "progressWithinMs": 1000,
    "loading": {
      "delayMs": 1500
    },
    "failure": {
      "mode": "status",
      "status": 500,
      "feedbackWithinMs": 2000
    },
    "emptyState": {
      "regions": [
        {
          "selector": "#results",
          "items": ".result"
        }
      ],
      "auto": true,
      "ignore": [
        ".toast-list"
      ]
    }
  }
}
```

`checks.progressWithinMs` is the deadline for pending feedback. `checks.loading.delayMs` controls the response hold. The probe replays eligible request-producing actions with responses held, exposing loading UI that an instant local response can hide.

`checks.failure.mode` can be `status` or `network`. Status accepts an integer HTTP error from 400–599. Network simulates a failed connection and ignores the status value. `feedbackWithinMs` is a positive deadline measured after injection. Matching requests terminate locally; other requests retain the probe's guard.

`checks.emptyState.regions` names a region and its item selector. `auto:true` also discovers empty lists, tables and grids. Use `ignore` for regions where absence is intentional, after inspecting evidence. The empty fixture makes this condition reachable; the setting does not manufacture empty data.

## Declare

**Capture empty and error screens explicitly.**

Save this complete flow as `.idiom/flows/library.json`. Each state has a deterministic URL and explicit expectations:

```json example=flow
{
  "id": "library",
  "title": "Library states",
  "intent": [
    "Explain waiting, empty results and failed requests; keep recovery usable."
  ],
  "setup": [],
  "states": [
    {
      "id": "ready",
      "description": "Items loaded; Refresh sends a fetch request.",
      "url": "/library?fixture=items",
      "steps": [],
      "expect": {
        "textPresent": [
          "Your library"
        ],
        "selectorPresent": [
          "#refresh",
          "#results .result"
        ]
      }
    },
    {
      "id": "empty",
      "description": "An account with no items.",
      "url": "/library?fixture=empty",
      "steps": [],
      "expect": {
        "textPresent": [
          "No items yet"
        ],
        "selectorPresent": [
          "#create-item"
        ],
        "selectorAbsent": [
          "#results .result"
        ]
      }
    },
    {
      "id": "error",
      "description": "A deterministic failed-read fixture with retry.",
      "url": "/library?fixture=error",
      "steps": [],
      "expect": {
        "textPresent": [
          "Could not load items"
        ],
        "selectorPresent": [
          "[role=\"alert\"]",
          "#retry"
        ]
      }
    }
  ]
}
```

`expect.textPresent`, `selectorPresent` and `selectorAbsent` assert that the fixture reached the intended screen. Expectation failures mean that capture did not satisfy the declared state; investigate them instead of treating an unrelated screenshot as coverage. A visible retry still needs a manual or declared-step exercise to prove its product behavior.

For a genuinely long action, add `longRunning:true` on its web click, fill, press or select step. This partial state example assumes the app also provides `#export`:

```json example=state-partial
{
  "steps": [
    {
      "action": "click",
      "selector": "#export",
      "longRunning": true
    }
  ]
}
```

Such steps use `progress-affordance` to check for visible spinner, progressbar, `aria-busy` or changed status text within the configured deadline. They are excluded from `loading-state-missing` and `double-submit` replay findings; the label is not a reason to omit pending feedback.

## Inspect

**Understand what each finding proves.**

- `loading-state-missing`: an eligible response-gated action has no pending feedback within the deadline and only changes after the response. A highlighted navigation link alone is not content-loading feedback.
- `double-submit`: a pending POST, PUT, PATCH or DELETE leaves its trigger enabled and a second activation issues a duplicate. The duplicate is observed and aborted before leaving the browser.
- `empty-state`: an empty detected or configured region lacks explanatory content or an enabled button/link. It requires both; configured regions search inside the region itself.
- `error-state-missing`: an injected request failure silently returns the action to rest without visible error/status feedback or a visible result.
- `retry-blocked`: after failure the action remains disabled, busy or hidden, a spinner persists, or its region loses content and recovery is unusable.

Read the action timeline, request and timing evidence, and any filmstrip or crop. Loading and failure replays consume probe budgets and depend on eligible requests and successful restores. Not reached, skipped, no eligible action, and unavailable evidence do not establish that a missing state is handled. A handled failure or visible usable retry can suppress failure findings; inspect the experience as well as the absence of findings.

Full-page navigations and beacons that nothing waits on are excluded from loading-state findings. Failure injection targets response-gated fetch/XHR actions. Quick review has a bounded public-page probe, blocks writes and unsafe interactions, and cannot supply authenticated or fixture-dependent state coverage. Configure the flow for those cases. No replay provides a guarantee that every state or request was tested.

## Fix and verify

**Keep coverage and repair evidence together.**

```sh example=shell
idiom validate library
idiom check library
idiom report
idiom fix library
idiom verify library --spec /absolute/path/to/repair-spec.md
```

`check` writes ranked findings and evidence; inspect the report even when its findings gate exits nonzero. `fix` hands requested repairs to your configured coding agent and verifies them; `verify --spec` rerenders to test original findings. Replace the example spec path with the actual repair spec emitted by fix or a ticket containing `idiom:finding` blocks; it is not a product requirements document. Neither a startup error nor an incomplete capture is a clean pass.

With MCP, use `idiom_check`, inspect `idiom_issue`, request `idiom_fix_plan`, make authorized source edits and pass its returned `next.arguments` to `idiom_verify`. Inspect unresolved targets and all introduced findings.

Practical fixes include a visible pending label with an accessible status, a disabled submit trigger while a write is in flight, a skeleton sized to the final content, explanatory empty text with a create action, and error handling that clears busy state in a final cleanup path while preserving entered values. Re-run the same states after each repair.

The deterministic loop needs no paid Idiom service or model key; model critique is optional. For installation, MCP and hook behavior, read [Design QA for Claude Code](/docs/design-qa-for-claude-code). The [docs](/docs) cover the wider workflow.


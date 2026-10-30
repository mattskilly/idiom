---
title: How it works
description: Idiom runs a six-step loop around your running app (Learn, Render, Critique, Repair, Verify, Remember) over flows of named states.
---

# How it works

Idiom looks at the app your users see, not the code. It runs a six-step loop around your running app, and each pass ends by remembering what you decided, so the next pass starts from it.

## The loop

| Step | What happens | Command |
| --- | --- | --- |
| **Learn** | Reads your design tokens, `PRODUCT.md` and `DESIGN.md`, or writes them with you. | `idiom init` |
| **Render** | Starts your app, drives a real browser through every declared state at each viewport and colour scheme, and records what happens during each load and click. | `idiom capture` |
| **Critique** | Runs more than 60 measured checks, compares against your intended design, and ranks the findings. | `idiom check` |
| **Repair** | Hands each accepted finding to your coding agent as a bounded fix. | `idiom fix` |
| **Verify** | Renders the same states again and confirms each finding is gone. No model is involved. | `idiom verify` |
| **Remember** | Records your accept and reject decisions in the repo and folds rulings into your design law. | `idiom decide` |

## Flows and states

A **flow** is one journey through your product, such as checkout or onboarding. A **state** is one named condition of that flow: empty cart, payment failed, signed in, expired link. Each state says how to reach it (a URL, steps to click through, fixtures to load) and what must be true once there.

Idiom captures every state at every viewport, in light and dark: the declared **tuples**. For each tuple it stores the screenshot, DOM, computed styles, geometry, accessibility results and console, tied to the commit. "Every state, not every page" is the point: most defects live in states nobody visits by hand.

## Between states

A screenshot can't show what happens when someone clicks. During every load and action, Idiom records layout shifts, content inserted or removed, animations, and the requests each action started. It replays requests as a slow network would, and as a failing one would, to see what the user waits through and whether they can recover.

That is how it catches content that jumps, a button that shows nothing while its request is pending or can be pressed twice, an action that fails silently or can't be retried, and panels that snap into place with no transition. It never sends requests that change your data.

## What gets judged

Capture waits for entrance animations to finish, then judges only what is painted. Anything in a closed menu, a collapsed section or still invisible is skipped and counted, not measured. Every report states what it could not check and why.

## Next

- [Findings](/docs/findings): what a finding contains and how findings are ranked.
- [Memory](/docs/memory): decisions, rulings and design law.

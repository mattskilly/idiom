---
title: Memory
description: Idiom records accept and reject decisions in your repo, turns open design questions into rulings in DESIGN.md, and hands the accumulated judgment to the next agent.
---

# Memory

Idiom remembers what you decided, in your repo, so a settled finding doesn't come back and the next agent starts from your judgment instead of from zero.

## Decisions

`idiom decide` accepts or rejects a finding, with a reason.

- **Accept** marks it as work worth doing. Accepted findings become paste-ready instructions (`idiom instruction`), repair tickets (`idiom tickets`) or input to `idiom fix`.
- **Reject** dismisses that occurrence. `--scope rule` suppresses the pattern in every later run.

Decisions live in `.idiom/decisions.jsonl`. Commit it with your code.

## Rulings and design law

Some questions a review can't settle on its own: "you style inputs three ways; which is law?", or "17px padding appears 34 times; add a step to your scale or keep reporting it?". These arrive as rulings. `idiom ruling` records your answer in `DESIGN.md`, your product's design law, so it becomes a rule rather than a one-off fix.

`idiom learn "<observation>"` does the same for a problem a person found and Idiom missed: it turns it into a new check or a ruling, and shows the diff first.

## Handing it on

`idiom context` prints the accumulated brief (design law, rulings, prohibitions, tokens, open work), sized to paste into any agent before it writes UI. Over MCP, agents fetch it themselves.

`idiom system` opens your design system as one visual page: the token palette, the colours and type that actually shipped, your rules and rulings, and your standing rejections with their evidence.

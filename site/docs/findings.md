---
title: Findings
description: Each Idiom finding names the element, the measurement, a cropped screenshot and a Done when condition, and says whether it was measured, observed or judged.
---

# Findings

A finding is one problem Idiom found in one place, with the evidence to prove it and a condition that proves the fix.

## What a finding contains

```
1. [major] dead-control — editor/desktop — #name-version
   Problem: "Name this version" is enabled, but clicking it changed nothing.
   Done when: clicking it shows a result, or it is disabled with a reason.
   Evidence: .idiom/reports/…/editor/desktop/crops/7b9fe0bf.png
```

- **Severity and rule**: how bad it is and which check found it. Every rule is listed in [Rules](/docs/rules).
- **Where**: the state, viewport and element.
- **Problem**: what is wrong, with the measurement.
- **Done when**: the condition that counts as fixed. `idiom verify` checks it.
- **Evidence**: a cropped screenshot, plus the full capture in the report.

## Three bases

Every finding says how Idiom knows:

- **Measured**: a deterministic rule with its measurement, such as contrast of 3.1:1 against a 4.5:1 minimum. The same capture always gives the same measured findings.
- **Observed**: something seen during an action, with timing and result, such as a click that changed nothing.
- **Judged**: a model critique, with stated confidence. Treat these as suggestions.

Gates count measured and observed findings. Judged findings gate only if you opt in.

## Severity

- **Blocker**: the state did not render as declared. Nothing else about it can be trusted until it is fixed.
- **Major**: a defect people will hit, such as an unreadable label, a dead control or a broken link. `idiom check` fails on major and above by default.
- **Minor**: craft debt worth fixing that doesn't block, such as an off-scale value or a lonely last word.

## Ranking

Findings come in fix order, severity first: every blocker comes before every major, and every major before every minor; within each tier, findings are ranked by salience × prominence: how noticeable the problem is and how prominent the element is. Symptoms that share one cause, such as one component misbehaving in six places, become one issue.

## Coverage

A report says what it reviewed as well as what it found: which viewports, colour schemes, slow and failing network replays and interactions each state was observed in. A check whose evidence is missing reports *unavailable* rather than passing.

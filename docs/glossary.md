# Glossary

The words Idiom uses in its commands, reports and docs, each with a link to where it is covered in full. This page is not the same as `.idiom/glossary.json`, the product copy glossary described in [configuration](configuration.md).

## Flow

A JSON file in `.idiom/flows/` that names the states of one part of your app, how to reach each one and which viewports and colour schemes to capture them at. See [Flows](configuration.md#flows).

## State

One screen of a flow that Idiom captures and judges: a route, a page reached by steps, or a chained state that follows the previous one. A state can also declare its data, such as `empty` or `error`. See [Flows](configuration.md#flows).

## Surface

A named area of your product, listed in the project's `surfaces` inventory, that a flow says it captures. Reports use surfaces to say what the review judged and what no flow covers. See [Project file](configuration.md#project-file).

## Viewport

A named screen size, such as `desktop` at 1440×900 or `mobile` at 390×844, that every selected state is captured at. See [Project file](configuration.md#project-file).

## Tuple

One state captured at one viewport and one colour scheme, the unit every capture records and every check judges. See [Capture pipeline](architecture.md#capture-pipeline).

## Capture

A run that starts your app, renders each tuple in Chromium and stores screenshots, observations, timelines and probe results under `.idiom/reports/<run>/`. See [capture](commands.md#capture).

## Observation

The facts a capture records about a tuple in `observations.json`: geometry, computed styles, hit tests, headings and token values, with no verdicts. Checks judge observations; they never re-render the page. See [Capture pipeline](architecture.md#capture-pipeline).

## Check

A deterministic judgement over captured evidence, such as contrast or a dead control, that always gives the same result for the same evidence. `idiom check` is also the command that captures a flow and runs them all. See [check](commands.md#check).

## Rule

A check with an id, a severity and a reason, such as `idiom:dead-control`. Every rule is listed with how to configure or decide it in [Rules](rules.md).

## Finding

One problem a check or the model critique reported, naming the element, the measurement, a crop and when it counts as fixed. Each finding says whether it was measured, observed or judged. See [Finding basis, severity gates and acceptance verification](commands.md#finding-basis-severity-gates-and-acceptance-verification).

## Finding name

The short, stable name of a finding, such as `finding-12`, kept in `.idiom/finding-names.json` so the same problem keeps its name across runs. See [Finding names](configuration.md#finding-names).

## Severity

How much a finding matters: blocker, major or minor. Reports rank by severity first, and `--fail-on` gates on it. See [Rules](rules.md).

## Ruling

A design-system question Idiom found recurring across states, published as `ruling-N` and answered with `idiom ruling`. Your answer is written into `DESIGN.md`, so later reviews follow it. See [ruling](commands.md#ruling).

## Decision

Your accept or reject of a finding, recorded with `idiom decide` in `.idiom/decisions.jsonl` and committed, so a settled finding stays settled. See [decide](commands.md#decide).

## Baseline

The findings recorded for a flow at a clean commit. Later checks compare against it and fail only on new findings. See [Baselines](configuration.md#baselines).

## Gate

A pass or fail on a run's findings, set with `--fail-on`, that decides the exit code in CI or a build. `idiom check --gate` is the fast build gate that checks only what a change affects within a time budget. See [Gate a build](commands.md#gate-a-build).

## Probe

The interaction probe: during capture it clicks, hovers and focuses the controls it reaches, without sending requests that change data, to find controls that do nothing, duplicate entry points and what menus reveal. See [Probe](configuration.md#probe).

## Verification

Rechecking a finding after a repair: `idiom verify` captures before and after and reports each finding's acceptance check as passed, failed or not re-checkable. See [verify](commands.md#verify).

## Brief

A design decision brief: the researched options for a design decision in a request, the requester's choice and the acceptance criteria the build is then checked against. See [Design decision briefs](brief.md).

## Triage

Two meanings. Brief triage decides whether a request holds a design decision before a ticket is written ([Triage output](brief.md#triage-output)). Ticket triage is the review of the repair tickets Idiom emits before any are built ([tickets](commands.md#tickets)).

## Reference

An image or page that shows what the product should look like, which the model critique compares against. See [reference](commands.md#reference).

## Anti-reference

An image or page that shows what the product must not look like, which binds the critique as strongly as a reference. See [reference](commands.md#reference).

## Intended design

The design a state is meant to match, such as a Figma frame, HTML, an image or a live site, which Idiom measures the build against for drift. See [Compare a build against its intended design](design-compare.md).

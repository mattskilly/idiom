# Design decision briefs

`idiom brief` is a design decision gate that runs before a ticket is written. It decides in seconds whether a request contains a design decision and, when it does, turns the calling agent's research and options into a stored, ticket-ready decision brief. How to run each subcommand is in [commands.md](commands.md#brief); the project settings are in [configuration.md](configuration.md#briefs).

Everything else Idiom does happens after the UI exists. The costliest design misses happen before: an agent turns a request into a ticket and quietly decides what the control is, where it lives, how big it is and how it behaves on hover, touch and keyboard. The build ships the guess, every test and check passes, and the person who asked rejects it on sight. A large, tidy, accessible button that doubles a drawer's height is not a defect a deterministic check should flag, so the decision has to be made, with the requester, before the ticket exists.

`idiom brief` is the pre-ticket decision brief. It is not `idiom context`, whose output is a write-time design brief for an agent that is already building; that brief does list the decisions made here.

## The flow

1. **Triage.** `idiom brief triage "<request or path to draft ticket>"` returns `no design decision` with a one-line reason, or `design decision` with the specific open questions it found, and a triage id. With no design decision, write the ticket as usual.
2. **Plan.** `idiom brief plan <triage-id>` turns the open questions into research instructions for the calling agent: what to check in which reference products, the standards to look for, a time budget, the research rules and the exact JSON shape `record` accepts.
3. **Research.** The calling agent researches each open question with its own tools (web search, subagents, the product itself) within the budget and drafts 2–4 options, one of which is "don't build it". On this path Idiom does not search the web. Without an agent, `idiom brief "<request>" --research` does this step and the next through your review provider (see [Two ways to research](#two-ways-to-research)).
4. **Record.** The agent sends its findings and options to `idiom brief record`. Idiom validates them, stores the brief with `status: "proposed"`, and returns the question to ask the requester.
5. **Ask or proceed.** The agent asks the requester that question verbatim (in Claude Code, with AskUserQuestion). Only a low-stakes, reversible decision may go ahead on the recommendation without asking.
6. **Decide.** `idiom brief decide <slug> --option <id>` records the requester's choice, and the rendered Markdown becomes the ticket.
7. **Gate.** When the ticket is filed, `idiom brief gate <ticket.md>` warns if it holds a design decision and carries no decided brief (see [Gate tickets](#gate-tickets)).
8. **Build, then check.** After the build, `idiom check <flow>` judges the decided brief's assertions against the shipped UI and reports a `brief-mismatch` finding for each criterion it breaks ([Checking the build](#checking-the-build)).

Idiom owns the process: the rubric, the research plan, the answer shapes, validation, the question, storage and rendering. `triage` calls a model once, with a bounded text prompt: no tools, no capture, a 90-second limit and a 2,000-token answer. It uses the project's configured review provider (`model.provider`, with `model.fallback` tried once, visibly, if the primary fails). `plan` given a request without `--question` runs that same triage first. The only other command that calls a model is `idiom brief "<request>" --research`. `record`, `decide`, `list` and `show` never touch the network.

## Two ways to research

**Agent-driven** (`triage` → `plan` → your agent's own tools → `record`): use it inside a coding agent. The agent can try the product hands-on, use subagents and search as widely as it needs, and it costs nothing beyond the agent session you already have.

**`--research`** (`idiom brief "<request>" --research`): use it from the CLI alone or in CI, where no agent is driving. Idiom runs the research itself through the configured review provider's web search, and the result is the same validated, stored brief.

```sh
idiom brief "Add a pin button to every tile" --research
idiom brief drafts/pinned-group.md --research --json
```

The run has three stages, all under one wall-clock budget:

1. **Triage**, exactly as `idiom brief triage`. With no design decision, nothing else runs and nothing is stored.
2. **Research**: one call per triage question, in order, with web search on. Idiom fills in each question verbatim; the provider answers only its `findings`, in the same shape `record` takes, with a source URL on every claim.
3. **Options**: one call with no tools, which sees every validated finding and answers the rest of the brief input (`title`, `decision`, `requestNamedIdea`, `options`, `recommendation`, `acceptanceCriteria`, `outOfScope`). Idiom then validates the assembled brief exactly as `record` would and stores it as `proposed`.

**Providers.** `claude-code` (web search and fetch only, through `claude -p --safe-mode` with subscription auth, so no ambient `ANTHROPIC_*` override applies) and `codex` (`codex exec` with `web_search="live"`, and `ANTHROPIC_API_KEY` removed) can research. Idiom uses the first of `model.provider` and `model.fallback` that is one of these. If that provider is unavailable or fails, Idiom switches once, visibly, to the other configured research-capable provider for the rest of the run. The `anthropic` API provider has no web access in Idiom, so a project configured only with it is refused before triage; use the agent-driven path there.

**Bounds.** `brief.researchBudgetMs` (default 15 minutes) covers the whole run; at the deadline the call in progress is stopped. `brief.researchMaxSearches` (default 5) bounds the searches for each question: Claude Code runs with `--max-turns` at twice the bound plus 2, and Idiom counts Codex's streamed web-search events and stops the call past the bound. A question stopped by a bound is left unresearched, and the run carries on with the next one.

**Invalid answers.** A research or options answer that fails validation is sent back once, with every `path: message` issue. A second invalid answer fails the run and stores nothing, not even the questions that had validated.

**Incomplete briefs.** When the budget runs out or a bound stops a question, Idiom stores what it validated, never filled-in guesses. The brief stays `proposed`, its status line reads `Status: proposed · research incomplete · rubric v1`, and a note under it says what stopped the run and lists the unresearched questions. In the Evidence section each unresearched question reads `Not researched (research incomplete).`, never "nothing found", which would claim a search happened. If options were never reached (the deadline, or no question researched), the decision, options and criteria sections read `Not reached: research incomplete.` and the title is the request's first line. If options were drafted after a bound stopped some questions, they are kept and the note says they rest on partial research. `idiom brief list` marks such briefs `(research incomplete)`, and `decide` refuses them. To finish one, research the open questions (either way) and record a complete brief over the same slug.

**Labels.** Findings keep the `verified` label the provider gave them. The prompt says `read` is the default and `hands-on` is only for a product the provider operated itself; Idiom never upgrades or rewrites a label.

**Cost.** The stored brief records `researchRun`: the provider and model, the budget, the run's duration, the number of calls and, when the provider reports them, turns, searches and input/output tokens. A figure the provider does not report is left out, never shown as 0. The CLI prints it as a `Cost:` line, and the rendered Evidence section adds a `Research run:` line. Deciding a researched brief (with `decide`, or by recording it again) keeps its `researchRun`; recording a complete brief over an incomplete one drops the run, since it no longer describes the brief.

A request whose whole text is `triage`, `plan`, `gate`, `record`, `decide`, `list` or `show` runs that subcommand instead (quoting does not help); put such a request in a draft-ticket file and pass its path.

## The rubric

The rubric is a versioned file shipped with Idiom at `templates/brief/rubric.md`; this page describes version 1. Both triage modes embed it verbatim, and every stored brief records the rubric version it was triaged under.

A request is a **design decision** if any trigger applies to any part of it, and **no design decision** only when every part is a non-trigger. A bug is a non-trigger only when it has one clear right answer.

| Trigger | Meaning |
| --- | --- |
| `new-control-or-surface` | a new visible control or surface |
| `new-interaction-or-mode` | a new interaction or mode |
| `placement-or-timing` | where something lives or when it appears |
| `input-modality` | hover, touch or keyboard differences |
| `density` | density or use of space |
| `concept-naming` | naming a user-facing concept |
| `per-item-addition` | anything added to every item in a repeated collection |
| `raw-technical-input` | a raw technical input (URL, ID, JSON) exposed to end users |

| Non-trigger | Meaning |
| --- | --- |
| `copy-fix` | a typo or wording fix that changes no meaning |
| `single-answer-bug` | a bug with one clear right answer |
| `tests` | adding or changing tests |
| `refactor` | changing code without changing what users see |

Each open question names the specific thing to decide in this request ("how large is the per-tile pin control, and does it double the tile's height?"), not the trigger's name.

## Triage output

`--json` prints exactly:

```json
{
  "id": "triage-3f9c0a1b2d",
  "verdict": "design decision",
  "reason": "Adds a pin control to every tile in the Add drawer.",
  "questions": [
    "How large is the per-tile pin control, and does it increase tile height?",
    "Is the pin visible only on hover, and how does it work on touch and from the keyboard?"
  ]
}
```

`reason` is one line. `questions` has 1–8 entries for a design decision and is `[]` otherwise. Both verdicts exit 0: the verdict is information, not a gate. Without `--json`, triage prints the verdict line, one line per question, then `Triage id: <id>` and, for a design decision, `Next: idiom brief plan <id>`.

Every model triage is stored as `.idiom/briefs/triage/<id>.json` (`{ version, id, request, rubricVersion, createdAt, verdict, reason, questions }`), so `plan` can find it by id. The id is `triage-` plus the first 10 hex characters of the SHA-256 of the rubric version and the request, so triaging the same request again overwrites its own record instead of piling up. `brief list` ignores this directory.

`--no-model` makes no call. It prints the rubric, the request, the project context (PRODUCT.md and reference products, when run inside a project) and the answer rules with the JSON shape above, for the calling agent to apply itself. It works outside an Idiom project. With `--json` it prints `{ rubricVersion, rubric, request, context, answerShape, rules }`. It stores nothing and returns no id; pass your own questions to `plan` with `--question`.

## Research plan

`idiom brief plan <target>` prints research instructions for the calling agent. The target is a triage id, the request text, or a path to a draft ticket:

- **A triage id** reads the stored triage. No model call.
- **A request with `--question`** (repeatable, up to 8) uses those questions. No model call, and it works outside an Idiom project.
- **A request alone** runs a model triage first, stores it and plans from it. It needs an Idiom project.

`--minutes <n>` sets the budget (1–60, default 10). `--json` prints the plan object; otherwise it renders as Markdown with the record shape in a JSON block. The plan contains:

- **questions**: each open question, with what to check for it.
- **references**: the project's reference products grouped by tier (`bar`, `always`, `floor`). With none configured, a note asks the agent to name 2–3 established products in the category and treat them as read, not hands-on, unless it used them.
- **checks**: hover and mouse, touch, keyboard (focus order, visible focus, accessible name), small screen (390px wide or less), empty state and error state.
- **standards**: what to look for and where, matched to the request's words: WCAG 2.2 target size, content on hover or focus, keyboard and focus visible, non-text contrast and reflow. The WAI-ARIA Authoring Practices patterns index is always included.
- **budget**: `{ "minutes": 10, "searches": { "min": 3, "max": 6 } }`.
- **rules**: cite every claim with a source URL; label each finding hands-on or read; say "nothing found" rather than guess; treat "a competitor has it" as a signal to investigate, not a reason to build.
- **recordShape**: a skeleton of the exact `record` input, with placeholders, the request prefilled verbatim and the triage carried over. **recordRules** summarizes [validation](#validation).
- **next**: record, ask or proceed, decide.

A plan for a `no design decision` triage has no questions and `noDecision: true`, and renders as "No design decision: write the ticket as usual."

## Recording a brief

`idiom brief record <file.json>` reads the agent's brief; omit the file or pass `-` to read stdin.

**brief input**

```json
{
  "title": "Pinned group in the Add drawer",
  "request": "Add a default Pinned group at the top of the Add drawer that users can customize.",
  "decision": "How does a user pin an item without making every tile bigger?",
  "requestNamedIdea": true,
  "research": [
    {
      "question": "How do established tools let users pin items in a dense grid?",
      "findings": [
        {
          "claim": "A small corner pin icon, outlined when off and filled when on, appears on hover.",
          "source": "https://example.com/pinning-patterns",
          "verified": "hands-on"
        }
      ]
    },
    { "question": "Is right-click pinning discoverable?", "findings": "nothing found" }
  ],
  "options": [
    {
      "id": "sibling-button",
      "title": "A pin button beside every tile",
      "summary": "A full-size button, visible without hover.",
      "kind": "requester",
      "cost": { "space": "roughly doubles the drawer's height", "steps": "one click", "concepts": "pinning", "code": "small" },
      "rejectedBecause": "it doubles the drawer's height for a secondary action"
    },
    {
      "id": "corner-pin",
      "title": "A small corner pin icon inside the tile",
      "summary": "Shown on hover and focus, always visible on touch, filled when pinned.",
      "kind": "alternative",
      "cost": { "space": "none", "steps": "one click", "concepts": "pinning", "code": "small" }
    },
    {
      "id": "dont-build",
      "title": "Keep the drawer as it is",
      "summary": "No pinned group.",
      "kind": "dont-build",
      "cost": { "space": "none", "steps": "none", "concepts": "none", "code": "none" },
      "rejectedBecause": "the requester wants quicker access to frequent items"
    }
  ],
  "recommendation": { "option": "corner-pin", "reason": "Established pattern, no added height, works on touch." },
  "acceptanceCriteria": [
    {
      "kind": "geometry",
      "statement": "The pin icon is at most 20px square and tile height is unchanged at 56px.",
      "assertions": [
        { "flow": "add-drawer", "state": "open", "selector": ".drawer-item", "height": 56 },
        { "flow": "add-drawer", "state": "open", "selector": ".drawer-item .pin", "within": ".tile" }
      ]
    },
    { "kind": "input-states", "statement": "On touch the pin is visible without hover; with a keyboard it appears on focus." },
    { "kind": "contrast", "statement": "The outline icon meets 3:1 against the tile background." }
  ],
  "outOfScope": ["Reordering pinned items"]
}
```

Optional fields: `slug` (otherwise derived from the title), `triage` (the `--json` verdict, without its `id`, carried over), `status` (`proposed` by default), `decidedBy`, `supersededBy` and `chosenOption` (set by `decide`). Two more say whether the agent may proceed without asking: `stakes` (`"low"` or `"high"`, default `"high"`) and `reversible` (default `false`). Each option may also carry a `label`, a short answer label of at most 40 characters on one line (the title otherwise), and a `sketch`, a low-fidelity ASCII sketch of at most 16 lines of 72 characters, for options where layout is the question.

`--json` prints `{ slug, outcome, status, markdownPath, ask }`; `ask` is `null` once a brief is decided or superseded. Without `--json`, record prints the stored line and then the question to ask.

### Validation

A rejected brief lists every issue as `path: message` (for example `options[1].cost.space: Invalid input: expected string, received undefined`), so the agent can fix them all in one round.

- Every research finding has a `source` http(s) URL and `verified: "hands-on"` (you tried it) or `"read"` (you read about it).
- A question with no findings says `"findings": "nothing found"`. An empty list is rejected.
- 2–4 options with unique `id`s, exactly one of `kind: "dont-build"`.
- `requestNamedIdea: true` requires exactly one `kind: "requester"` option (the requester's own idea); `false` forbids one.
- Exactly one recommendation, naming an existing option, with a reason. Every other option has `rejectedBecause`; the recommended one has none.
- Each option's `cost` states `space`, `steps`, `concepts` (new concepts) and `code`.
- Acceptance criteria are checkable. A `geometry` statement includes a measurement with a unit (`20px`, `1.5rem`, `50%`). A `contrast` statement includes a ratio (`3:1`). An `input-states` statement names an input (mouse, hover, pointer, touch, tap, keyboard or focus). `behaviour` statements are free text.
- `status: "decided"` requires `decidedBy`; `status: "superseded"` requires `supersededBy`, naming another stored brief.
- `chosenOption` names an existing option and only appears on a decided brief. A decided brief without one chose the recommendation.
- An option's `label` is one line of at most 40 characters; its `sketch` has at most 16 lines of at most 72 characters each.
- A criterion's `assertions`, when present, is a non-empty list. Each assertion has exactly one form ([Checking the build](#checking-the-build)), a non-empty `selector`, and a `flow` and `state` the project declares: `record` and `decide` both check them against the flows as they are then, for example `acceptanceCriteria[0].assertions[1].state: flow add-drawer declares no state "pinned"; states: closed, open`. A brief with no assertions never reads the flows.

## Asking the requester

`record` returns `ask`, the decision as a question the agent can ask verbatim:

```json
{
  "decision": "How does a user pin an item without making every tile bigger?",
  "recommendation": "corner-pin",
  "options": [
    { "id": "corner-pin", "label": "A small corner pin icon inside the tile (Recommended)", "description": "Shown on hover and focus, always visible on touch, filled when pinned. — Established pattern, no added height, works on touch." },
    { "id": "sibling-button", "label": "A pin button beside every tile", "description": "A full-size button, visible without hover. — it doubles the drawer's height for a secondary action" },
    { "id": "dont-build", "label": "Don't build it", "description": "No pinned group. — the requester wants quicker access to frequent items" }
  ],
  "proceed": { "allowed": false, "reason": "must ask: the recommendation overrides the requester's own idea" },
  "askUserQuestion": { "questions": [ { "question": "…", "header": "Design call", "multiSelect": false, "options": [ { "label": "…", "description": "…" } ] } ] },
  "text": "…"
}
```

The recommendation comes first and its label ends in " (Recommended)". Each description is one line: the option's summary, then its trade-off (the recommendation's reason, or why the option was rejected). An option's `sketch` becomes its `preview`. `askUserQuestion` is exactly the input of Claude Code's AskUserQuestion tool; `text` is a plain-text version for agents without it.

`proceed.allowed` is true only when the brief is `stakes: "low"` and `reversible: true`, the recommendation is not "don't build it", and it does not override an idea the requester named. Then the agent may go ahead on the recommendation, but must tell the requester what it chose and that `idiom brief decide` can change it. Otherwise it must ask; that is the default.

## Deciding

`idiom brief decide <slug> --option <id> [--by <name>] [--json]` records the requester's choice: it sets `status: "decided"`, `decidedBy` (default `requester`) and `chosenOption`, keeps the creation time and regenerates the Markdown. It prints `Decided brief <slug>: <chosen title> (by <who>) — .idiom/briefs/<slug>.md`. An unknown option fails and lists the valid ids; a superseded brief fails and names the brief to decide instead. Deciding again replaces the choice.

A decided brief's decision section leads with `**Decision:** <chosen option> (decided by <who>)`, then lists the other options. When the requester chose something other than the recommendation, it notes what was recommended and why, and `decide` warns that the acceptance criteria were written for the recommendation: re-record the brief with criteria for the chosen option. The Markdown says so too, so it is never mistaken for a ticket: the status line adds `not ticket-ready`, and the acceptance criteria section opens with a **Not ticket-ready** notice naming both options and lists the criteria without checkboxes. When the choice is "don't build it", that section instead reads **Nothing to build** and drops the criteria. Deciding the recommendation again restores the checklist.

## The rendered brief

Each brief is stored as `.idiom/briefs/<slug>.json` and rendered to `.idiom/briefs/<slug>.md`. The Markdown starts with the title and a status line (`Status: decided · decided by requester · rubric v1`), then one `##` section per template entry. By default the headings follow autobuild's spec standard:

| Heading | Content |
| --- | --- |
| `## What and why` | `decision`: the question, the recommended option with its reason and cost, and every rejected option with its reason and cost; once decided, the chosen option first and then the others |
| `## Acceptance criteria` | `criteria`: `- [ ]` statements grouped as geometry, input states, contrast and behaviour |
| `## Out of scope` | `outOfScope` |
| `## Evidence` | `evidence`: each research question with its findings, sources and how they were verified, then the original request |

A project changes the headings, order and extra blocks with `brief.ticketTemplate.sections` in `.idiom/project.json`. Each section is `{ "heading", "content" }`, where `content` is one of `decision`, `options` (a cost comparison table), `criteria`, `outOfScope`, `evidence`, `references` (the project's reference products) or `text` (a fixed `body` of Markdown). `decision`, `criteria` and `evidence` must each appear exactly once; no other kind except `text` may repeat. A project that titles its evidence "Why (evidence)":

```json
{
  "brief": {
    "ticketTemplate": {
      "sections": [
        { "heading": "What and why", "content": "decision" },
        { "heading": "Why (evidence)", "content": "evidence" },
        { "heading": "Acceptance criteria", "content": "criteria" },
        { "heading": "Out of scope", "content": "outOfScope" },
        { "heading": "Notes", "content": "text", "body": "Ask the requester before widening scope." }
      ]
    }
  }
}
```

## Gate tickets

`idiom brief gate <ticket.md ...> [--strict] [--json]` checks tickets as they are written. It warns when a ticket holds a design decision and carries no decided brief. Nothing in a ticket pipeline otherwise asks whether a prescribed control ("a sibling pin button, visible without hover") is a decision anyone made.

A ticket carries a brief in one of two ways:

- **A link**: a line `brief: <slug>` naming a stored brief. A bullet (`- brief: pinned-group`), YAML front matter, `**Brief:** \`pinned-group\`` and, in a leading `+++` TOML block such as an autobuild file-tracker ticket's, `brief = "pinned-group"` all count. The slug must end the line, so prose such as `Brief: we should…` is not a link.
- **An embedded brief**: the rendered `.idiom/briefs/<slug>.md` pasted into the ticket, found by its `Status: … · rubric v<N>` line.

Lines inside code fences are ignored. For each ticket the gate looks for a brief first:

| Ticket | Outcome |
| --- | --- |
| carries a `decided` brief | passes silently, with no model call |
| carries a `proposed` brief | warns that the decision is still open: ask the requester, then `idiom brief decide` |
| carries a `superseded` brief | warns, naming the brief that replaced it |
| links a slug with no stored brief | warns `missing-brief` |
| carries no brief | is triaged once: no design decision passes silently; a design decision warns with each open question, `idiom brief plan <triage-id>` and `idiom brief "<ticket>" --research` |

When a ticket carries several briefs, the worst one decides. Triage stores its record under `.idiom/briefs/triage/` exactly as `idiom brief triage` does, so the printed `plan` command works. Research never runs from the gate.

The gate warns first. It prints nothing when every ticket passes, prints one warning per ticket and a `N of M ticket(s) need a decided brief.` summary otherwise, and exits 0 either way. `--strict` exits 1 when any ticket warns. A triage that fails (provider down, invalid answer) is reported as an error for that ticket and counts as a warning, so a provider outage never blocks a commit unless you chose `--strict`. A missing, empty or over-64 KB ticket file, or a missing project when a ticket needs triage or links a brief, always exits 1, before any model call.

`--json` prints `{ strict, warnings, tickets }`. Each ticket is `{ path, outcome, reason, briefs, triage?, message?, next? }`: `outcome` is `pass`, `warn` or `error`; `reason` is `decided`, `no-decision`, `no-brief`, `proposed`, `superseded`, `missing-brief` or `triage-failed`; `briefs` lists every brief found (`{ source: "link", slug, status }` or `{ source: "embedded", status }`, with `status: "missing"` and an `error` for an unreadable link); `triage` is present only when triage ran.

### Recipes

**Autobuild ticket lint.** Run the gate at the repository root while filing or grooming tickets, before moving them into the ready state, for example as the last step of a grooming routine:

```sh
find .autobuild/tickets/triage .autobuild/tickets/ready -name '*.md' -exec idiom brief gate {} +
```

Or check one ticket right after creating it: `idiom brief gate .autobuild/tickets/triage/file-<n>.md`. `find … -exec … {} +` works the same in sh, bash and zsh, and never runs the gate when both directories are empty. This is deliberately not a `[verify]` step: a `kind = "check"` step runs in the build worktree with no agent session, where the gitignored ticket file is not present, and it would run after the ticket was dispatched, too late to help. The same recipe is in `templates/autobuild.idiom.toml`.

**Git pre-commit.** For repositories that commit their tickets, for example in a `tickets/` directory (autobuild's file-tracker directory is usually gitignored, so this hook does not see it), save as `.git/hooks/pre-commit` and make it executable:

```sh
#!/bin/sh
files=$(git diff --cached --name-only --diff-filter=AM -- 'tickets/*.md')
[ -z "$files" ] || idiom brief gate $files
```

The `[ -z ]` guard stands in for `xargs -r`, which macOS `xargs` lacks. Add `--strict` to either recipe once the team trusts triage.

**Agent instructions.** The CLAUDE.md or AGENTS.md lines `idiom init` offers (see [below](#agents-mcp-skill-and-the-instruction-offer)), with an optional gate sentence:

```markdown
## Design decisions (Idiom)
Before writing a ticket or code that involves a design decision, run `idiom brief triage "<request>"` (or the `idiom_brief_triage` MCP tool) and follow it.
Before filing the ticket, run `idiom brief gate <ticket.md>`.
```

## Checking the build

A brief is only half the loop: once the build ships, Idiom checks the UI against what was decided. Any acceptance criterion may carry `assertions`, each tied to a flow state and a CSS selector:

| Form | Keys | Holds when |
| --- | --- | --- |
| Size | `width` and/or `height`: pixels, or `{ "min", "max" }` | every element the selector matches is that size. Write the pre-build size here to say "unchanged". |
| Same size as | `sameSizeAs: "<selector>"`, `axis`: `width`, `height` or `both` (default) | every match is the same size as the reference selector's first match. |
| Contained | `within: "<selector>"` | every match lies inside a container's rectangle: the nearest enclosing container when the element sits inside one, otherwise any container. |
| Visible without hover | `visibleWithoutHover: true` | on touch viewports (no hover, or a coarse pointer), every match is visible at rest: rendered, opacity above 0, not `visibility: hidden`, with a non-zero size. Desktop viewports are not judged. |
| No layout shift on hover | `stableOnHover: true` | when the interaction probe hovers the element or anything inside it, nothing outside the element moves. |
| Minimum contrast | `minContrast: <1–21>` | every match's foreground meets the ratio against its background. For an icon (an `svg` or anything inside one) the foreground is its painted stroke, else its fill; otherwise its text colour. |

Every assertion also takes `flow`, `state` (a declared state id; it also covers that state's combinations), `selector`, an optional `name`, and `tolerance` in CSS pixels (default `1`).

Capture measures each decided brief's selectors on the states its assertions name, including elements hidden at rest, so a capture taken before the brief was recorded cannot judge it: recapture. `idiom check` and `idiom review` then report one `brief-mismatch` finding (major) per element that breaks an assertion, naming the brief, the criterion and the measured values:

```text
Brief "Pinned group in the Add drawer" (pinned-group), criterion "The pin icon is at most 20px square and tile height is unchanged at 56px.": .drawer-item height 100, expected 56 (tolerance 1)
```

A subject, reference or container selector that matched nothing is a mismatch. An assertion Idiom cannot measure is not a finding; coverage names why: the capture predates the brief, the selector is invalid, a match was not observed, no touch viewport was captured, no hover probe reached the element, or it has no painted foreground.

Only `decided` briefs are checked. A brief decided as "don't build it", or decided on an option other than the recommendation its criteria were written for, is skipped until it is re-recorded. The check summary and the report's coverage list every decided brief relevant to the flow:

```text
Decided briefs: 2 apply to this flow.
- Pinned group in the Add drawer (pinned-group): checked; 1 passed, 1 mismatched, 0 unmeasured
- Sidebar density (sidebar-density): decided, not checkable
```

Briefs whose assertions all name other flows are left out. A brief with no assertions is listed as "decided, not checkable"; one whose states this run did not capture is "not captured".

`idiom context` lists decided briefs under "Decided design briefs", so an agent writing code sees the decision: the title and file, the chosen option, and each criterion, marked `[checked]` when it carries assertions. With a flow, it keeps briefs with an assertion on that flow and briefs with none.

When a human rejects a build anyway, `idiom learn --from-brief <slug> "<what is wrong>"` turns the rejection into something checkable. The state comes from the brief when its assertions name exactly one flow state; otherwise pass `--state`. Words Idiom can measure become a check entry as usual. Otherwise the brief's size assertions for that state become state invariants in the flow manifest, judged by `layout-invariants` whatever happens to the brief later; when they are already declared, the rejection becomes a design-law ruling that names the brief. The `.idiom/learned.jsonl` line records the brief.

## Reference products

`brief.references` lists the products that set the bar for this project's UI. Triage reads them, together with PRODUCT.md (`design.productFile`, capped at 6,000 characters), as context for its questions. Each entry is `{ "name", "tier", "note" }` with an optional `url`. The tiers are:

- `bar`: match or beat it.
- `always`: always compare against it.
- `floor`: never fall below it.

`idiom init` scaffolds an empty list with a `$comment` explaining it.

## Storage and status

Commit `.idiom/briefs/`: the briefs are the record of what was decided and why. A brief's status is `proposed` when recorded, `decided` once the requester picks (with `decidedBy` and `chosenOption`, set by `idiom brief decide`), and `superseded` when a later brief replaces it (with `supersededBy`). Recording the same slug again updates the brief and keeps its creation time. Triage records under `.idiom/briefs/triage/` are working state; committing them is optional. `idiom brief list` shows every brief, newest first; `idiom brief show <slug>` prints one.

## Agents: MCP, skill and the instruction offer

Agents reach the same flow three ways:

- **MCP.** `idiom_brief_triage`, `idiom_brief_plan`, `idiom_brief_record` and `idiom_brief_decide` mirror the CLI ([mcp.md](mcp.md)). The triage tool's description tells agents to call it before writing a ticket, spec or code that adds or changes visible UI.
- **The Idiom skill.** The vendored skill is model-invocable. Its description names the trigger ("before writing a ticket, spec or code that adds or changes UI, or when a request involves a design decision"), and its "Before you spec UI" section walks the flow above. `idiom upgrade` delivers it to existing installs.
- **The instruction offer.** `idiom init` and `idiom upgrade` offer to append two lines to the project's CLAUDE.md or AGENTS.md:

  ```markdown
  ## Design decisions (Idiom)
  Before writing a ticket or code that involves a design decision, run `idiom brief triage "<request>"` (or the `idiom_brief_triage` MCP tool) and follow it.
  ```

  The offer asks once per agent file and only when run interactively. `--yes`, `--json`, `--dry-run`, a non-interactive terminal and MCP never write: they report the lines as available for you to place. Idiom never creates an agent file. A CLAUDE.md that links to or imports (`@AGENTS.md`) AGENTS.md counts once, and a file that already mentions `idiom brief triage` is left alone.

## Does an agent reach for it?

The feature only helps if agents use it without being told. `scripts/brief-eval.mjs` measures that: it copies a small page-editor fixture into a temporary directory, runs `idiom init --yes` there (installing the skill), puts `idiom` and its MCP server on hand, and asks headless Claude Code to "Write a ticket for this request and save it in tickets/" with the pinned-group request. Nothing in the prompt or the fixture mentions Idiom. It reports, per run, whether the agent loaded the skill, triaged, and triaged before writing the ticket. `--with-instruction` adds a second arm with the two-line instruction in CLAUDE.md.

```sh
bun run build
node scripts/brief-eval.mjs --runs 3 --with-instruction
```

**Results (2026-10-31, Claude Code 2.1.312, default model, 3 runs per arm):**

| Arm | Triaged before writing a ticket | Loaded the skill | Wrote a ticket |
| --- | --- | --- | --- |
| skill | 3/3 | 3/3 | 0/3 |
| skill + instruction | 3/3 | 1/3 | 2/3 |

Every run triaged before writing anything, including the two in the instruction arm that acted on CLAUDE.md without loading the skill. In 4 of 6 runs the agent stopped after `record` with a proposed brief, because the ask said it must ask and a headless session has no one to answer; that is the intended behaviour. Of the two runs that wrote a ticket, one marked its own brief low-stakes and reversible, proceeded on the recommendation and decided it as "agent (recommendation; low-stakes, reversible)"; the other wrote the ticket while its brief was still proposed. The agent sets stakes and reversibility itself, so review a self-decided brief's `decidedBy` before treating it as the requester's choice. User-level memory (`~/.claude/CLAUDE.md`) is not excluded by `--setting-sources project` and may have been read.

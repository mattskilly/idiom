---
name: idiom
description: Use when UI is created or changed, before declaring a UI task complete, and before a PR with UI changes. Review public pages with Idiom quick, check configured flows against intended designs, and hand off requested repairs through fix-plan and verify.
---

# /idiom

When UI is created or changed, before declaring a UI task complete, and before a PR with UI changes: run the relevant check, inspect its evidence, hand authorized repairs to the caller, and verify. Do not declare UI work complete while blocking measured or observed findings remain under the applicable configured gates, unless the human explicitly waives them. Report outstanding findings and the human waiver. Suggestions alone are not blockers. A successful check proves it ran, not that findings were fixed; missing capture or verification evidence is not a clean pass. This policy withholds completion claims; it grants no new repair or decision authority.

For automatic or natural-language invocation, select applicable configured flow(s) with `idiom_flows` and use `idiom_check` (CLI equivalents if MCP is absent). Inspect returned evidence; use `idiom_fix_plan` and `idiom_verify` for requested repairs within the caller's authorized task. For a suitable unconfigured public page use `idiom_quick`, disclosing authentication, fixture and probe-coverage limits. Errors are errors, not clean results. After reporting the automatic check/repair outcome, stop; do not enter the conversational review loop. Explicit modes below take precedence; `$ARGUMENTS` means the requested mode/flow text when the host supplies it, not a required host variable.

Findings are measured (a deterministic rule with its measurement), observed (an action or probe with its timing and result), or judged (model critique with stated confidence when supplied). Treat judged findings as suggestions: severity gates count measured and observed findings by default; --fail-on-judged opts judged suggestions in.

Ask only for design judgment; report execution errors. When available, prefer MCP tools: `idiom_quick`, `idiom_check`, `idiom_context`, `idiom_flows`, `idiom_fix_plan`, `idiom_verify`, `idiom_decide`, `idiom_init` (init), `idiom_design_add` (design add), `idiom_choose` (decide --choose), `idiom_tickets` (clustered tickets), `idiom_sweep` (sweep), `idiom_coverage` (coverage) and `idiom_baseline` (baseline show/record). Keep human judgment and an explicit reason for decisions. Use CLI for absent tools or CLI-only workflows (page review, explore, rulings/learn, references, per-finding tickets and instructions, spec-based verify, report/system); never silently retry a tool error via CLI. Verify mode owns verification only; fix-plan hands repairs to the caller only when requested. Figma: when Figma's own MCP server is connected, use it to read the frame for intent and context, then pass the frame URL (with `node-id`) to Idiom (prefer `idiom_design_add` when present, else `idiom design add <state> <frame-url>`, or `review --page <url> --design <frame-url>`) for the measured comparison; never transcribe Figma values by hand. The first fetch needs `FIGMA_TOKEN` (a personal access token with `file_content:read`), in the MCP server's environment for tools. When references disagree, a finding is a design decision: ask the human which reference is intended and their reason, then record exactly that with `idiom_choose` when present, else `idiom decide --finding <id> --choose <name> --reason <reason>`.

## Verify mode

When `$ARGUMENTS` is `verify <flow> <ticket-or-spec>`, run exactly:

`idiom verify <flow> --spec <ticket-or-spec>`

Report the verdict and evidence paths. Do not repair anything yourself.

## Check mode

When `$ARGUMENTS` is `check <flow>`, run `idiom check <flow>`; present findings
in its order: severity first, then prominence (salience × prominence) within a tier, with each `Evidence:` image. If asked, fix blockers and majors and
rerun until clean. Never decide, suppress or reword findings; ask the human.

## Init mode

When `$ARGUMENTS` is `init`, read `references/init.md` relative to this file. Scaffold with
`idiom init --yes`, mine evidence, capture liked/disliked references, and hand
`PRODUCT.md` and `DESIGN.md` back. Never overwrite either without approval.

## Explore mode

When `$ARGUMENTS` starts with `explore`, run the requested generation command
`idiom explore <flow> --state <state> (--question <text> | --decision <id>)`.
Generation publishes a run and exits successfully; do not answer a TTY prompt.
Resolve the printed run directory, then read `exploration.json` and
`exploration.md`. In A/B/C order, present every candidate's direction, rule,
reasoning, references, and all screenshots below its stored `capture` path with
the available image-viewing facility. Evidence comes before judgment.

Ask the human for A, B, C, or explicit no choice; their reason; confirmation;
and, for a candidate, whether to create repair tickets. Pass the human's reason
text unchanged as one shell-safe CLI argument. Run exactly one command:
`idiom explore resolve <runId> --candidate <A|B|C> --reason <reason> --yes`
(add `--repairs` only when requested), or
`idiom explore resolve <runId> --none --reason <reason> --yes`.
Never infer a choice, offer refinement in this detached flow, apply candidate
code, or leave the outcome only in the conversation.

## Sweep mode

When `$ARGUMENTS` starts with `sweep`, route it here, including `sweep --all`.
After a batch of builds lands, run `idiom sweep --all --emit-tickets .autobuild/tickets/triage`
(or MCP `idiom_sweep` with `{all:true,emitTickets:".autobuild/tickets/triage"}`).
Use `--deterministic-only` without model credentials; `--max-tickets` defaults to 10.
Inspect polish Markdown/HTML reports in severity-first order, then prominence (salience × prominence) within a tier, omitted counts and probe/model coverage limits.
Present bounded triage proposals without inventing accept/reject decisions. Never
promote them, launch dispatch or implement cleanup. Groom manually; after repairs,
run every ticket's printed verification-sidecar command for its flow and tuple.

## Review mode

Otherwise `$ARGUMENTS` is an optional flow id — never `init`, `verify` or `check`.
Explore and sweep were routed above. With no flow, process `.idiom/flows/*.json` in
deterministic filename order.

Before review, manage visual context only with
`idiom reference add <name> --url <url> --viewport <viewport> --note <text>
[--anti]`, `idiom reference add
<name> --file <path> --note <text> [--anti]`, `idiom reference list`, and
`idiom reference remove <name> [--anti]`. Never invent the required note or
delete a loose legacy file. Reference management happens before the immutable review.

Run `idiom validate [flow]` once before capture; omit the argument to validate
all configured flows.

For each flow:

1. Run `idiom capture <flow>`. A nonzero result that reports failed tuples but
   publishes a run is reviewable evidence: tell the human the failure count and
   continue. Stop only when capture publishes no unambiguous run; never recapture.
2. Extract that immutable run ID and run
   `idiom review <flow> --from <runId>`.
3. Disclose any degraded-review warning. Resolve the run directory from the
   printed path; read sibling `findings.json` and `unruled-decisions.json`.
4. For each unruled decision, present recurrence, nearest law passage, and each
   candidate beside its citation. Ask candidate, custom wording, or no rule;
   run `idiom ruling --decision <id> --candidate <n>`, `--wording <text>`, or
   `--no-rule`. Never route rulings through accept/reject or tickets.
5. Run `idiom decide --list` and do not revisit an occurrence already decided.
6. For every still-open finding, present its explanation, violated rule, and
   acceptance evidence. Resolve every `evidence.screenshots` path from
   `findings.json` against the run directory and show it with the available
   image-viewing facility alongside that finding. If none exist, report that
   visual evidence is absent and present the remaining recorded evidence.
7. Ask accept or reject, plus the human's reason; for rejection also ask whether
   scope is `instance` or `rule`. Record one non-interactive command:
   - `idiom decide --finding <id> --accept --reason <reason>`
   - `idiom decide --finding <id> --reject --scope <scope> --reason <reason>`
   Pass the reason text unchanged as one CLI argument, without shell
   interpolation.
8. If at least one ID was accepted in this pass, emit exactly those IDs with one
   `idiom tickets --finding <id>...` command and report the triage paths. If none
   were accepted, do not run `idiom tickets`; never run it without at least one
   `--finding`.
9. For each accepted ID, run `idiom instruction --finding <id>` and present its
   stdout as an optional external handoff for the human to check and paste. Never
   apply the instruction or send it to any tool yourself.

Never edit product code, run repair commands, promote tickets, start Autobuild
or any other dispatcher, infer findings, or override prior human decisions.

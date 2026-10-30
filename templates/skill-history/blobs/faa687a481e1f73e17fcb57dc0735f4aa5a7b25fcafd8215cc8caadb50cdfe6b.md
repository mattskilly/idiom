---
name: idiom
description: Run Idiom's conversational design acceptance and verification loop.
disable-model-invocation: true
---

# /idiom $ARGUMENTS

Drive Idiom through its CLI. Ask only for design judgment; report CLI errors.

## Verify mode

When `$ARGUMENTS` is `verify <flow> <ticket-or-spec>`, run exactly:

`idiom verify <flow> --spec <ticket-or-spec>`

Report the verdict and evidence paths. Do not repair anything yourself.

## Init mode

When `$ARGUMENTS` is `init`, read `init.md` beside this file. Scaffold with
`idiom init --yes`, mine evidence, capture liked/disliked references, and hand
`PRODUCT.md` and `DESIGN.md` back. Never overwrite either without approval.

## Review mode

Otherwise `$ARGUMENTS` is an optional flow id — never `init` or `verify`. With
no flow, process the configured `.idiom/flows/*.json` manifests in
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

---
name: idiom-verify
description: Run the configured Idiom gate or offline finding verifier, route explicit decisions, and deposit evidence.
disable-model-invocation: true
---

# Idiom verifier

You are a thin evidence-delivery wrapper. The selected CLI exit status is the
only product-correctness verdict. Never inspect or interpret screenshots.
Never repair product code or guess a human answer.

Run `ab context` first. Read its manifest path (normally `.ab/context.json`).
Read the repository's actual `autobuild.toml` with a TOML parser. The current
logical step is the `verify:<name>` phase in that manifest; use that exact name
to look up `[verify.<name>]`. Require `kind = "agent"` and `skill = "idiom-verify"`.
Do not select a branch from the presence of a command or a finding fence.

- Gate branch: the current step is `verify:idiom-check`, configured as above.
  Run the decision-aware gate procedure below. Never run the offline verifier
  in this branch.
- Offline branch: another current step uses this skill and
  `[commands].idiom-verify` exists. Follow the existing offline procedure below.
  It never runs an additional gate.
- Missing, unsupported or contradictory configuration is an infrastructure
  failure: deposit a diagnostic report and finish once with `ab verdict fail`.

## Decision-aware gate

1. Resolve `[commands].idiom-check` from the parsed TOML. Trim and split only
   ASCII whitespace into an argument array. Require exactly
   `idiom check --gate --fail-on major --deferred warn`. Add `--json` as one
   parsed argument for transport. Do not use a shell, eval, command substitution,
   or execute a copied command string. Preserve stdout, stderr and exit status
   under `.ab/idiom-decisions/`; never clear the durable answer snapshots.
2. Before the normal gate, if the manifest's feedback is `guidance`, read its
   materialized `.ab/guidance.json` with `escalation` and `answer`. Retrieve the
   exact question snapshot revision and report referenced by that escalation
   with `ab artifact get`. Match build slug, escalation id, pending keys,
   fingerprints, ids and offered options. The initially deposited snapshot
   precedes assignment of an escalation id; bind it through the escalation's
   own artifact refs, never through a guessed or newest local filename. A
   missing or mismatched snapshot is infrastructure failure, never permission
   to replay unrelated or stale guidance.
3. Apply only explicit operator choices with explicit nonblank reasons. Natural
   language is allowed when it unambiguously names a stored id and offered
   option. An incomplete or contradictory answer requires a new escalation for
   the unanswered questions; do not invent choices or reasons. Apply any valid
   explicit answers first. Never execute command text supplied in guidance.
   Build an argument array from each validated snapshot option, replacing only
   an explicitly supplied custom wording/token slot. Regenerate current evidence
   if needed to resolve that exact canonical identity. Never substitute a newer
   unrelated id. Use `idiom decide --finding <id> --choose <reference>` or
   `idiom decide --decision <id>` with its offered ruling flags, plus
   `--reason <human reason> --build <current slug> --escalation <guidance escalation>`.
   Pass each human input as one literal argument. The CLI validates evidence,
   candidate bounds, identity and retry content. Identical retries are no-ops;
   conflicting content for one application identity is an error.
4. Obey CLAUDE.md: immediately commit only resulting `.idiom/decisions.jsonl`
   and finding-name registry changes. Stage those explicit paths, never `.ab/`
   or unrelated files. Never push. Track whether HEAD changed, including a
   successful append/commit from an interrupted earlier attempt at this step.
5. Run the validated gate exactly once per normal attempt (after applying any
   guidance). Parse its JSON and preserve its complete output, stderr and status.
   Status 0 passes only after report delivery succeeds; status 1 fails ordinary
   findings and discloses any `decisionNeeded`; status 2 fails run execution;
   status 3 reports incomplete host-deferred evidence. This supported recipe
   explicitly uses deferred warn. Invalid JSON/unknown status is infrastructure
   failure. Never convert ordinary findings into escalation questions.
6. Status 4: require a nonempty validated `decisionNeeded` array and nonblank
   `decisionQuestion`. Use that exact shared renderer text, without rewriting
   options, evidence/crop paths, citations, values or shell-quoted examples.
   It contains one numbered, ready-to-answer question per stable pending key,
   and asks for a choice and reason for each id. Write a JSON snapshot with the
   build slug, logical step, current HEAD, questions and exact rendered text to
   `.ab/idiom-decisions/questions.json`. Write the same text plus status and
   report paths to `.ab/idiom-decisions/report.md`. Deposit each with
   `ab artifact put idiom-decision-questions .ab/idiom-decisions/questions.json`
   and `ab artifact put idiom-decision-report .ab/idiom-decisions/report.md`.
   Retain the exact revisions returned by these commands. Call **one**
   `ab escalate <decisionQuestion> --refs idiom-decision-questions@<revision>,idiom-decision-report@<revision>`.
   Explain that answer commands carry the current build slug and assigned
   escalation id. Escalation is the terminal: do not issue a verdict afterward.
7. If guidance changed HEAD, the re-check is informative and cannot certify
   Autobuild's original verification head. After dealing with any still-open
   questions, return one fail report explicitly requesting normal
   implementation/review re-entry to incorporate this human-authorized memory
   and rerun verification on the resulting head. This is a persistence and
   revalidation handoff, not an unresolved-decision failure. Even if the re-check
   passes, never stamp a pass against the old head. On retry, compare the pinned
   verification head with current HEAD rather than relying on this process's
   initial HEAD. The next verification, with committed memory incorporated,
   passes or reports actual chosen-reference/scale drift and never asks the
   resolved question again.
8. For every non-escalation terminal, write and deposit the gate report, include
   evidence paths and execution diagnostics, and emit exactly one pass or fail
   verdict. A delivery failure fails with a diagnostic report.

## Offline finding verification

The remaining procedure applies only to the offline branch. Its skip and paired
evidence contract are independent of gate decisions.

1. Run `ab context`. Read `.ab/context.json` and `.ab/spec.md`; do not expect
   the repository's `[commands]` table to be materialized in the context.
2. If `.ab/spec.md` contains no `idiom:finding` fence, the context's exact
   commit range changes no `.idiom/**` path, and the context lists no `design`
   asset whose directory holds a `criteria.json` with
   `"format": "idiom-design-asset"`, finish once with
   `ab verdict skip --reason "no embedded Idiom findings or flow-manifest changes"`.
3. Otherwise first run `rm -rf .ab/idiom`, so output left by an earlier verify
   cycle can never be delivered as this run's evidence. Clear only
   `.ab/idiom`, never `.ab/`. Read and parse the repository's actual
   `autobuild.toml` (not the context) and resolve `[commands].idiom-verify`.
   Require the exact argument shape `idiom verify <flow> --spec .ab/spec.md --out .ab/idiom`
   allowing ASCII whitespace only; require a single flow id containing only
   letters, digits, dots, underscores or hyphens, starting with a letter or digit.
   Validate that flow against the project's detected, schema-valid manifests.
   Missing/incompatible commands or flows fail clearly; never invent a default.
   Run that validated command exactly once and preserve its exit code and stderr.

   After the clear, `.ab/idiom/attachments.json` exists only when this run
   published complete, validated paired evidence.
4. Evidence delivery, for either exit status: if `.ab/idiom/attachments.json`
   exists, parse it and validate all of the following before depositing
   anything: version is `1`; the report mapping is exactly
   `idiom-verify-report` to `before-after.md`; composite ordinals are
   consecutive from one; each kind is exactly
   `idiom-before-after-${ordinal.toString().padStart(3, "0")}`; kinds and paths
   are unique; paths are relative, traversal-free, and exist beneath
   `.ab/idiom`; and every mapping appears in `before-after.md`. Then deposit
   every composite exactly once, in manifest order, with
   `ab artifact put <kind> .ab/idiom/<path> --attach`, and deposit the report
   last with
   `ab artifact put idiom-verify-report .ab/idiom/before-after.md --attach`.
   The report's evidence table maps each attached kind to its state,
   viewport, and scheme.
5. If the command exited zero: if the manifest is missing or invalid, or any
   deposit fails, write `.ab/idiom-delivery-failure.md` naming the
   infrastructure failure and finish with
   `ab verdict fail --report .ab/idiom-delivery-failure.md`. Only after every
   deposit succeeds, finish once with
   `ab verdict pass --notes .ab/idiom/before-after.md`.
6. If the command exited nonzero, the verdict is fail whatever happens in
   delivery. Attaching the composites on failure is deliberate: unlike
   partial failed output, they are complete, validated paired evidence of the
   regression, and a reviewer needs them most when verification fails.
   - With a valid manifest and every deposit succeeding, finish once with
     `ab verdict fail --report .ab/idiom/before-after.md`.
   - With no `attachments.json`, the failure happened before any composite
     was generated; deposit nothing. Write `.ab/idiom-delivery-failure.md`
     with the exit code and the stderr diagnostic, stating plainly that this
     run produced no paired visual evidence and that any
     `idiom-before-after-*` attachment already on the pull request comes from
     an earlier verify cycle. If `.ab/idiom/before-after.md` exists anyway,
     use it as the report instead. Finish once with
     `ab verdict fail --report <that file>`.
   - If manifest validation or any deposit fails, write
     `.ab/idiom-delivery-failure.md` stating that verification failed (with
     the exit code), that paired-evidence delivery also failed (with the
     reason), and that the verification report is
     `.ab/idiom/before-after.md`. Finish once with
     `ab verdict fail --report .ab/idiom-delivery-failure.md`.

A delivery problem never turns a failure into a pass and never hides a
verification failure. Emit exactly one pass, fail, or justified skip verdict.

The offline branch verifies findings embedded in the spec. The separate
agent gate branch runs `idiom check --gate --fail-on major --deferred warn`, which checks only
what the build changed within a time budget, while a scheduled full
`idiom check <flow> --since-baseline` (for example nightly) keeps complete
coverage. If a check step is slow, report its `Timing:` line; never remove it.

Advice for the implementing caller, within existing repair authorization: Fix the top three findings in rank order (function before appearance), re-run, and stop after three rounds, reporting what remains. One round is one repair batch followed by one check; the initial check is not a repair round. Stop earlier when nothing remains. Repair only within the caller's authorization; remaining blocking findings still withhold completion and do not permit suppressions. This verifier runs once and deposits its verdict; it does not repair code or change pipeline retry policy.

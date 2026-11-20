---
name: idiom-fix
description: Run the configured Idiom gate on the build's change, fix up to three new major UI findings per round in the build worktree, re-verify, and report.
disable-model-invocation: true
---

# Idiom fix

You are the director's stand-in at verify time. Run the gate on this build's
change; when it finds new blocking UI findings, fix them in the application
source, re-verify, and return only what you could not fix. The gate's own
JSON and its handoff files are the only product-correctness evidence. Never
interpret screenshots to overrule the gate, never weaken the evidence, and
never guess a human answer.

Autobuild certifies the head it verified. A verify phase that commits a fix
must not then pass that head: when you commit fixes, you **fail** with a
"fixed in-build" report so the build returns to implement, which keeps your
commits and publishes them; the next verify cycle's first gate run is then
clean and passes. The only `pass` this skill issues is a gate run with nothing
blocking on an unmodified head.

## 1. Configuration

Run `ab context`. Read its manifest path (normally `.ab/context.json`). Read
the repository's actual `autobuild.toml` with a TOML parser. The current
logical step is the `verify:<name>` phase in that manifest; use that exact
name to look up `[verify.<name>]`. Require all of:

- that table has `kind = "agent"` and `skill = "idiom-fix"`;
- `[commands].idiom-check`, trimmed and split only on ASCII whitespace into an
  argument array, is exactly `idiom check --gate --fail-on major --deferred warn`.

Otherwise this is an infrastructure failure: write a short diagnostic to
`.ab/idiom-fix-config.md` and finish once with
`ab verdict fail --report .ab/idiom-fix-config.md`.

Record `startHead` (`git rev-parse HEAD`) and whether
`.idiom/finding-names.json` is clean (`git status --porcelain -- .idiom/finding-names.json`
prints nothing). Do not use a shell, eval or command substitution to run the
gate; run the validated argument array plus the extra arguments named below,
each as one argument.

## 2. Guidance round

When the manifest's feedback is `guidance`, apply it before any gate run with
the shared decision procedure below (it is the same text the `idiom-verify`
skill follows). Preserve its gate output under `.ab/idiom-decisions/`.

<!-- idiom:shared decision-guidance:start -->
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
<!-- idiom:shared decision-guidance:end -->

## 3. Initial gate (round 0)

Clear only this skill's own output with `rm -rf .ab/idiom-fix`, never `.ab/`.
Run the validated gate with `--json --handoff .ab/idiom-fix` appended. Save
stdout, stderr and the exit status to `.ab/idiom-fix/gate-0.json`,
`.ab/idiom-fix/gate-0.err` and `.ab/idiom-fix/gate-0.status`. Parse the JSON.

- `gate.skipped` is true (the change touches no UI): finish at once with
  `ab verdict skip --reason "<gate.line>"`. Do nothing else.
- Status 4 (a decision is needed): escalate exactly as the shared escalation
  procedure below says. Escalation is the terminal.
- Status 2 (run execution failed) or invalid JSON / unknown status: fail with
  a diagnostic report naming the status and the stderr's last lines.
- Status 3 cannot occur with `--deferred warn`; treat it as status 2 if it does.
- Status 0, or `handoff.next` is `pass`: go to Finish (pass).
- Status 1 with `handoff.next` `repair`: go to the repair loop.

<!-- shared escalation procedure, the same text idiom-verify follows -->
<!-- idiom:shared decision-escalation:start -->
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
<!-- idiom:shared decision-escalation:end -->

## 4. Repair loop

At most **three** repair rounds; round 0 above is the initial check, not a
repair round. Repeat while the newest round's `handoff.next` is `repair`:

1. Pick the round to work from: the newest round's `handoff.repairFrom` when
   it has one, otherwise the newest round (round 0). After a reverted round,
   `repairFrom` names the last kept round, because only that round's findings
   describe HEAD; the reverted round's own findings are what your discarded
   edits caused, worth reading so you do not repeat them, never targets.
   Read `.ab/idiom-fix/round-<that>/handoff.md` (and `handoff.json` for the
   same fields as data). It lists at most three targets in rank order, each
   with selector, state and viewport, measured value, the rule in the
   director's words with its labelled source, a suggested fix, done-when
   criteria and crops.
2. Edit **application source only**, for the listed targets only. Never touch
   `.idiom/**`, DESIGN.md, PRODUCT.md, rules, decisions, baselines, flows,
   tests' expectations or suppressions, and never add an Idiom acknowledgement.
   A rule written as `rule-reference` is Idiom's shipped rule, not the
   director's words; the others are the director's and outrank your taste.
3. Keep a list of every path you edited or created this round.
4. Re-run the same gate with `--json --handoff .ab/idiom-fix`, saving
   `gate-<M>.json`, `.err` and `.status` the same way, where M is the new
   round number the CLI reports. The CLI compares the new round with the last
   kept round, records `progress` (`fixed`, `persisting`, `introduced`) and
   decides `outcome`: `commit` when the edits fixed a target and introduced
   nothing, otherwise `revert`.
5. Status 2 or 4 on a re-run: revert this round's edits (step 7), then handle
   the status exactly as in round 0.
6. If the new round's `handoff.outcome` is `commit`: stage only the tracked
   paths (`git add -- <paths>`) and commit with the message
   `idiom-fix: <progress.fixed ids> (verify round <M>)` followed by a blank
   line and the repository's commit attribution trailer, if it has one.
7. If it is `revert`: revert only the tracked paths
   `git restore --source=HEAD --staged --worktree -- <paths>` for tracked
   files, and delete files you created. Never `git stash`, `git reset` or
   `git clean`, and never touch paths you did not edit. Always follow
   `outcome`; never keep edits the CLI judged `revert`, because the next
   round and the summary are computed as if they were reverted.
8. Write `.ab/idiom-fix/round-<M>/edits.md` (the new round, which judged
   these edits): the files changed, one line of what and why per target, and
   whether the edits were committed or reverted. The next gate call folds it
   into `transcript.md`; after the last round, append it to `transcript.md`
   yourself.

Stop the loop when `next` is `pass` or `stop`.

## 5. Finish

1. If `.idiom/finding-names.json` was clean at the start, restore it
   (`git restore --source=HEAD --worktree -- .idiom/finding-names.json`).
   Leave the worktree clean apart from `.ab/`.
2. Deposit evidence: each `.ab/idiom-fix/round-*/crops/*` image in round order
   as `ab artifact put idiom-fix-crop-NNN <path> --attach` (NNN counts from
   001), then `ab artifact put idiom-fix-report .ab/idiom-fix/transcript.md --attach`.
3. Exactly one terminal:
   - **Pass** — the initial gate passed and HEAD equals `startHead`:
     `ab verdict pass --notes .ab/idiom-fix/transcript.md`.
   - **Fixed in-build** — `next` is `pass` and HEAD differs from `startHead`:
     write `.ab/idiom-fix/fixed.md`. Say that Idiom fixed and re-verified N
     findings in this build in commits `<sha list>` (`git log --format=%H startHead..HEAD`),
     that the re-verify passed on that head, and that implement must keep
     these commits and finish without reverting them. Append the output of
     `git format-patch --stdout startHead..HEAD` in a fenced block as a
     fallback if the commits are missing. Then
     `ab verdict fail --report .ab/idiom-fix/fixed.md`.
   - **Stopped** — `next` is `stop` (three repair rounds and blockers remain):
     `ab verdict fail --report .ab/idiom-fix/summary.md`. You may add at most
     one "why it remains" line per finding under the CLI's summary; never
     rewrite the CLI's text. Fixes that did verify stay committed and are
     listed there.
   A delivery failure (a deposit that fails) fails with a diagnostic report;
   it never turns a failure into a pass.

If the gate is slow, report its `Timing:` line; never remove the step. The
role's `sessionBudgetSeconds` bounds this session: four gate runs of about
three minutes each plus edits fit the default hour.

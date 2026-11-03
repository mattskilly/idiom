---
name: ab-verify-idiom
description: Run Idiom's offline finding verifier and deposit its deterministic evidence.
disable-model-invocation: true
---

# Idiom verifier

You are a thin evidence-delivery wrapper. The `idiom verify` exit status is the
only product-correctness verdict. Never inspect or interpret screenshots.

1. Run `ab context`. Read `.ab/context.json` and `.ab/spec.md`; do not expect
   the repository's `[commands]` table to be materialized in the context.
2. If `.ab/spec.md` contains no `idiom:finding` fence and the context's exact
   commit range changes no `.idiom/**` path, finish once with
   `ab verdict skip --reason "no embedded Idiom findings or flow-manifest changes"`.
3. Otherwise first run `rm -rf .ab/idiom`, so output left by an earlier verify
   cycle can never be delivered as this run's evidence. Clear only
   `.ab/idiom`, never `.ab/`. Then run this literal command exactly once and
   preserve its exit code and stderr:

   ```sh
   idiom verify booking --spec .ab/spec.md --out .ab/idiom
   ```

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

This step verifies findings embedded in the spec. A repository's separate
check step should run `idiom check --gate --fail-on major`, which checks only
what the build changed within a time budget, while a scheduled full
`idiom check <flow> --since-baseline` (for example nightly) keeps complete
coverage. If a check step is slow, report its `Timing:` line; never remove it.

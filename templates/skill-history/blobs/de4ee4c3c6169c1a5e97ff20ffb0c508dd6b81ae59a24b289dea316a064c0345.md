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
3. Otherwise run this literal command exactly once and preserve its exit code:

   ```sh
   idiom verify booking --spec .ab/spec.md --out .ab/idiom
   ```

4. If it exits nonzero, attach nothing. If
   `.ab/idiom/before-after.md` exists, finish with
   `ab verdict fail --report .ab/idiom/before-after.md`. Otherwise write a
   short `.ab/idiom-delivery-failure.md` naming the missing report and use that
   file with `ab verdict fail --report`.
5. If it exits zero, parse `.ab/idiom/attachments.json` and validate all of the
   following before depositing anything: version is `1`; the report mapping is
   exactly `idiom-verify-report` to `before-after.md`; composite ordinals are
   consecutive from one; each kind is exactly
   `idiom-before-after-${ordinal.toString().padStart(3, "0")}`; kinds and paths
   are unique; paths are relative, traversal-free, and exist beneath
   `.ab/idiom`; and every mapping appears in `before-after.md`.
6. Deposit every composite exactly once, in manifest order, with
   `ab artifact put <kind> .ab/idiom/<path> --attach`. Then deposit the report
   with
   `ab artifact put idiom-verify-report .ab/idiom/before-after.md --attach`.
   If validation or any deposit fails, write `.ab/idiom-delivery-failure.md`
   naming the infrastructure failure and finish with
   `ab verdict fail --report .ab/idiom-delivery-failure.md`.
7. Only after every deposit succeeds, finish once with
   `ab verdict pass --notes .ab/idiom/before-after.md`.

Emit exactly one pass, fail, or justified skip verdict.

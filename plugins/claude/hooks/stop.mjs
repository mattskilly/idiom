import {
  claimStop,
  createBudget,
  flowReminder,
  initialChanges,
  readInput,
  readState,
  resolveContext,
  snapshot,
} from "./lib.mjs";

const budget = createBudget();
try {
  const input = await readInput(budget);
  if (
    input &&
    (input.stop_hook_active === undefined || input.stop_hook_active === false)
  ) {
    const context = await resolveContext(input.cwd, budget);
    if (context?.globs.length && typeof input.session_id === "string") {
      const state = await readState(context, budget);
      // Acknowledgments survive every subsequent edit in the same epoch.
      if (
        state.sessions[input.session_id]?.epoch !==
        (state.check?.id ?? "initial")
      ) {
        const current = await snapshot(
          context,
          budget,
          state.pending.map((entry) => entry.path),
          state.overflow === true,
        );
        const initial =
          state.check || state.pending.length
            ? false
            : await initialChanges(context, current, budget);
        if (
          await claimStop(context, current, initial, input.session_id, budget)
        ) {
          console.log(
            JSON.stringify({
              decision: "block",
              reason: `UI changed since the last successful Idiom check. ${await flowReminder(context, budget)} If checking is impractical, explain why. This reminder blocks once per session until a successful check starts a new epoch.`,
            }),
          );
        }
      }
    }
  }
} catch {
  /* An unavailable snapshot or persistence must never trap the agent. */
} finally {
  budget.close();
}

# Fix-step fixture

The fixture repository for the `idiom-fix` verify step
(`scripts/prove-idiom-fix.mjs`, `test/check-gate-handoff.test.ts`,
`test/prove-idiom-fix.test.ts`; `scripts/idiom-fix-fixture.mjs` builds it).

- `server.mjs` serves `/orders` and inlines `components/Toolbar.module.css`,
  read on each request from the server's working directory, so a stylesheet
  edit changes what renders and a base capture in its own worktree serves the
  base's stylesheet. The `.tsx` files exist only for Idiom's import graph.
- One flow (`orders`) with one state (`list`) at one viewport and scheme.
- **The director's catch:** `.idiom/learned.jsonl` `learned-1`, "Buttons in a
  toolbar keep at least 8px apart.", imported against the `adjacent-gap`
  check. It is the words the handoff quotes.
- **Severity:** `.idiom/rules.json` raises `idiom:adjacent-elements-touch` to
  `major` with the reason in the director's words. Without it a 2px gap is a
  minor finding (the check is major only at 0.5px or less).
- **Which check:** `adjacent-gap`, not `control-gap`. `control-gap` measures
  parts inside one control; toolbar buttons are separate controls, so a real
  gate run reports the collapsed toolbar as `adjacent-gap` /
  `idiom:adjacent-elements-touch`, two findings (one per neighbouring pair).
- **Planted regression:** on the `ab/fixture` branch, one "UI change" commit
  centres the toolbar's buttons and drops its `gap: 8px` to `gap: 2px`. The
  fix restores 8px; the centring stays, so the branch still changes UI.
- `autobuild.toml` wires the gate as the fix step, as `idiom init` or
  `idiom upgrade` would.

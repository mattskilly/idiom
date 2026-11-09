# Idiom

Read `docs/session-handoff.md` first for current state and open threads.

## Process safety

- **Never use `pkill` or `killall` by name or pattern.** Stop only processes you started, using their PIDs, or processes whose actual working directory is inside your own worktree. Parallel builds share this host; broad cleanup kills sibling verification runs. Use `kill <pid>` for a known owned PID, or `node scripts/stop-my-tests.mjs` for verified local Vitest cleanup (`--dry-run` to inspect first). A process group or host-wide name-search result does not establish ownership.

Project hooks in `.codex/hooks.json` require review/trust through `/hooks` in a supporting Codex client. Older, disabled or untrusted clients have only this instruction rule. The rule applies whether hooks run or not.

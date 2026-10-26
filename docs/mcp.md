# Idiom tools for coding agents

`idiom mcp` exposes eight tools over stdio using the official TypeScript MCP SDK. It works with Claude Code, Codex, Cursor, Claude Desktop and other local MCP clients. No HTTP service, model credentials or repair agent is required.

Install Node 20 or newer and the matching Playwright Chromium browser. After installing Idiom, run `npx playwright install chromium`. The application must be reachable for quick review; configured flows use their normal setup/build/server settings.

## Setup

### Claude Code

Run from the application directory:

```sh
claude mcp add idiom -- npx -y @mattskilly/idiom mcp
```

To bind a fixed root:

```sh
claude mcp add idiom -- npx -y @mattskilly/idiom mcp --project /path/to/project
```

See [Claude Code MCP configuration](https://code.claude.com/docs/en/mcp).

### Codex

Add to `~/.codex/config.toml`:

```toml
[mcp_servers.idiom]
command = "npx"
args = ["-y", "@mattskilly/idiom", "mcp", "--project", "/absolute/path/to/project"]
tool_timeout_sec = 3900
```

[Codex MCP configuration](https://developers.openai.com/codex/mcp) defaults tool calls to 60 seconds. Full-flow captures and two-pass verification may take longer; the example allows two default 30-minute capture budgets plus processing. Adjust this for your project. Client timeouts can cancel work before the capture budget expires. Progress notifications do not extend every client's timeout.

### Cursor

Create `.cursor/mcp.json` in the application:

```json
{
  "mcpServers": {
    "idiom": {
      "command": "npx",
      "args": ["-y", "@mattskilly/idiom", "mcp", "--project", "/absolute/path/to/project"]
    }
  }
}
```

See [Cursor MCP configuration](https://cursor.com/docs/mcp).

### Claude Desktop

Open Settings → Developer → Edit Config and add this to `claude_desktop_config.json`, then restart Desktop:

```json
{
  "mcpServers": {
    "idiom": {
      "command": "npx",
      "args": ["-y", "@mattskilly/idiom", "mcp", "--project", "/absolute/path/to/project"]
    }
  }
}
```

Use an absolute project path because the desktop process may start in an unrelated directory. Ensure its environment can find Node and `npx`. See [local server setup](https://modelcontextprotocol.io/docs/2026-07-28/develop/connect-local-servers).

## Project roots and evidence

The server resolves `--project` relative to its launch directory once; without it, the launch directory is the root. Configured operations search upward for `.idiom/project.json`. Tool arguments cannot switch projects. Quick review always reviews the explicit URL with literal defaults, including inside configured projects, and never substitutes a flow or reads its configuration. It writes under the bound root's `idiom-quick-reports/`.

The server starts without `.idiom`. Quick works there; configured tools return an actionable initialization error. All returned report and crop paths are absolute. `idiom_issue` returns PNG image content alongside structured detail, preferring the crop over a full-page screenshot. A finding with no visual evidence says so; missing or unreadable referenced images are errors.

Configured findings and groups keep their canonical IDs. Quick IDs are opaque and qualified, for example `quick:<runId>:finding-1`; they can be read again after restarting the server at the same root. Quick evidence cannot receive project decisions or calibrated flow verification. Group decisions apply only to that group's members, even when a presentation issue contains several sibling groups.

## Tools and inputs

Every input is a strict JSON object. Lists, when present, must be nonempty and duplicate-free. Flow/run identifiers cannot contain path separators or equal `.` or `..`. The server advertises the complete JSON schemas through MCP discovery.

| Tool | Input | Result |
| --- | --- | --- |
| `idiom_quick` | `{"url":"https://example.com","viewports":["desktop","mobile"]}`; viewports optional | Ranked Top 5, all deterministic findings, counts and Markdown/HTML/findings paths. Presets are 1440×900 and 390×844, both by default, in light/dark. |
| `idiom_check` | `{"flow":"checkout","states":["cart"],"viewports":["mobile"],"all":false}`; selections and all optional | Top issues with selectors, measurements, fixes, crops, counts, baseline new/fixed/pre-existing collections and coverage. `all:true` returns complete live findings and bypasses baseline bootstrap/comparison. |
| `idiom_issue` | `{"id":"group-…"}` | Full original record(s), coordinates, group members/siblings, verification references and crop image content. |
| `idiom_fix_plan` | `{"flow":"checkout","top":5}`; top optional positive integer | Exact `idiom fix` repair prompt, selected original findings, source run and next verification arguments. A clean snapshot has an empty prompt and no next call. |
| `idiom_verify` | `{"flow":"checkout","findings":[{"id":"finding-1","runId":"…"}]}` | Two full-flow recaptures, calibrated per-finding verdicts, all-severity introduced findings, coverage, report paths, target `passed`, separate `regressionFree` and combined `success`. |
| `idiom_context` | `{}` | Bounded design brief: tokens, scales, rules, craft checks, prohibitions and accepted work. |
| `idiom_flows` | `{}` | Sorted validated flows with ordered states, selected viewports and schemes; suggests `idiom init --flows` if empty. |
| `idiom_decide` | `{"id":"finding-1","decision":"accept","reason":"Intentional product choice"}` | Accept/reject counts and decision log path. Reason must be nonblank and is preserved verbatim; instance scope only. |

Captures, fix-plan and verify write reports and may start the configured app. Decide writes judgment; context/flows/issue are read-only. None changes Git or launches a coding agent.

## Repair sequence

1. Read `idiom_context` and `idiom_flows` before building UI.
2. Call `idiom_check` for the flow. The default preserves recorded-baseline semantics, including an automatically recorded first baseline on clean committed HEAD; its response explains this. Commit that baseline deliberately. Use `all:true` for the complete live issue list without baseline changes.
3. Inspect issues with `idiom_issue`, then call `idiom_fix_plan`. The plan takes a fresh full snapshot and excludes rejected findings. Use its exact source references for verification.
4. Edit the application source as requested. The caller owns repairs and human judgment.
5. Pass the returned `next.arguments` to `idiom_verify`. Verification resolves original records from that exact run even if another check has happened. It never accepts caller-authored finding bodies. Scoped/incomplete or failed source coverage must be replaced by a full successful check/fix-plan first.

Reproduced/unverifiable targets and introduced findings are completed verification results, not tool execution errors. `success` requires every target fixed and no introduced finding at any severity. Failed calibration yields no claim of regression freedom (`regressionFree:null`). Capture/startup/invalid-input failures return MCP tool errors with recovery instructions; the next call can still run. Report the error instead of silently rerunning via the CLI.

When a flow's states declare a Figma frame, `idiom_check`, `idiom_fix_plan` and `idiom_verify` compare against it like any other design reference. When Figma's own MCP server is connected, use it to read the frame for intent and context, and pass the frame URL (with `node-id`) to Idiom for the measured comparison through `idiom design add <state> <frame-url>`; never transcribe Figma values by hand. The first fetch needs `FIGMA_TOKEN`; later runs reuse the pinned cache. Choosing between disagreeing references (`idiom decide --choose`) is a CLI decision. See the [design comparison guide](design-compare.md) for all reference sources, attachment, auth and a worked example; MCP `idiom_quick` has no design input.

This deterministic loop complements model review. Use the CLI for model review, exploration, initialization, references, rule-scope decisions, and ticket emission.

## Progress, cancellation and limits

Captures emit increasing progress notifications when the request supplies a progress token, including setup, tuple and probe activity. Verification keeps one increasing sequence across both captures. Counters describe activity, not percentages. Calls are serialized to avoid concurrent report/decision writes; discovery stays immediate. Cancelling queued work skips it; active cancellation aborts capture resources and guards later publication. Disconnect, stdin EOF, SIGINT and SIGTERM abort work and close the session. Cleanup has a five-second grace for capture-owned resources, including late-acquired browsers/workspaces.

The existing capture limits apply: `capture.maxMinutes` defaults to 30 per capture, probe control/state budgets default to 5000/60000 milliseconds. Missing Chromium errors suggest `npx playwright install chromium`; pinned-port errors tell you to free the port or correct server settings. Stdout is reserved for protocol JSON; diagnostics go to stderr.

## Claude Code plugin

The package bundles `.claude-plugin/plugin.json` with the MCP launcher and the existing skill plus adjacent `init.md`. From a source checkout or unpacked package:

```sh
claude plugin validate /absolute/path/to/idiom
claude --plugin-dir /absolute/path/to/idiom
```

The skill is namespaced as `/idiom:idiom`, for example `/idiom:idiom check checkout`. Its supported operations prefer MCP tools when present; unsupported workflows keep their CLI route and human judgment boundaries. The plugin launcher uses the session working directory. Use the explicit fixed-root MCP setup above for another project. See the [plugin manifest reference](https://code.claude.com/docs/en/plugins-reference).

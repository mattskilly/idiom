# Agent discovery and publication

This repository prepares `server.json` and `skills/idiom/` for discovery. Their presence is not a claim that an external registry or directory already lists Idiom. Matt performs the external steps below after a release. This build publishes nothing.

## Prepared surfaces

- MCP Registry identity: `io.github.mattskilly/idiom`, authorized by Matt's GitHub identity. The npm package identity is separately `@mattskilly/idiom`.
- `server.json` describes one local stdio package launched by npx with the positional `mcp` argument. The launch directory binds the project; use [MCP setup](mcp.md#setup) with `--project` for a fixed root. There is no hosted server or required model credential. Credential-dependent Figma and optional model workflows are explained in [MCP credentials](mcp.md#credentials).
- The schema has no standard top-level tool catalog. The short catalog is in `_meta["io.modelcontextprotocol.registry/publisher-provided"].tools`; only that publisher extension is preserved by the official registry, with a 4096-byte limit. Full input schemas come from MCP tools/list. The offline schema test compares names against the actual server's tools/list response.
- `templates/idiom/SKILL.md` and adjacent `init.md` remain the authoring source used by the plugin and project installer. `bun run generate:skill` emits `skills/idiom/SKILL.md` and `references/init.md`. It removes only the manual-invocation frontmatter flag and redirects the init reference. The portable frontmatter follows the [Agent Skills specification](https://agentskills.io/specification).

Provider references: [MCP schema](https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json), [official registry requirements](https://github.com/modelcontextprotocol/registry/blob/main/docs/reference/server-json/official-registry-requirements.md), [publishing quickstart](https://modelcontextprotocol.io/registry/quickstart), and [publisher command reference](https://github.com/modelcontextprotocol/registry/blob/main/cmd/publisher/main.go).

## Prepare and validate locally

From the release candidate checkout:

```sh
bun install --frozen-lockfile
bun run generate:skill
bun run generate:skill --check
bun run typecheck && bun run test && bun run lint && bun run build
bun run build:site
```

Review the generated skill diff and both rendered articles. The tutorials describe the dated release named by `package.json`, not Unreleased changes. Their tests validate complete project/flow JSON, CLI option names, offline rendering, metadata, links, keyboard focus, theme behavior and mobile/desktop accessibility. The fixture [provenance and refresh command](../test/fixtures/mcp-registry/README.md) pins the official schema and digest. To compare upstream without modifying the fixture:

```sh
schema_candidate="$(mktemp)"
curl -fsSL https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json -o "$schema_candidate"
cmp test/fixtures/mcp-registry/server.schema.json "$schema_candidate"
rm "$schema_candidate"
```

Inspect the package payload in a disposable directory:

```sh
pack_root="$(mktemp -d)"
bun pm pack --ignore-scripts --filename "$pack_root/idiom.tgz"
tar -tzf "$pack_root/idiom.tgz"
tar -xzf "$pack_root/idiom.tgz" -C "$pack_root"
cat "$pack_root/package/server.json"
cat "$pack_root/package/package.json"
test -f "$pack_root/package/skills/idiom/SKILL.md"
test -f "$pack_root/package/skills/idiom/references/init.md"
rm -rf "$pack_root"
```

The public snapshot procedure in [releases.md](releases.md#publish-the-public-snapshot-and-npm-package) excludes internal `.agents/` skills, while tracked `skills/`, `templates/` and `server.json` are public files. Commit the generated files before snapshotting; inspect them in that snapshot too. No install-time generation is needed.

## Smoke the portable installer without listing anything

The tested Skills CLI version is **1.7.4**, whose npm `engines.node` requires **>=22.20.0**. This is the installer's requirement; Idiom itself requires Node >=20. Consult the [Skills CLI command reference](https://github.com/vercel-labs/skills/blob/main/docs/commands.md) and `npm view skills@1.7.4 engines --json` when changing the pin.

This recipe installs only from an absolute local directory, into a temporary project for Claude Code and Codex. It disables telemetry and never uses global agent settings:

```sh
(
  set -eu
  skill_source="$(pwd -P)/skills/idiom"
  smoke_root="$(mktemp -d)"
  trap 'rm -rf "$smoke_root"' EXIT
  cd "$smoke_root"
  DISABLE_TELEMETRY=1 npx --yes skills@1.7.4 add "$skill_source" \
    --agent claude-code --agent codex --yes
  for skill_directory in .agents/skills/idiom .claude/skills/idiom; do
    test -f "$skill_directory/SKILL.md"
    test -f "$skill_directory/references/init.md"
    cmp "$skill_source/SKILL.md" "$skill_directory/SKILL.md"
    cmp "$skill_source/references/init.md" "$skill_directory/references/init.md"
  done
  node --input-type=module <<'JS'
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
for (const directory of ['.agents/skills/idiom', '.claude/skills/idiom']) {
  const skill = await readFile(`${directory}/SKILL.md`, 'utf8');
  assert.ok(skill.includes('`references/init.md` relative to this file'));
  assert.ok((await readFile(`${directory}/references/init.md`, 'utf8')).length > 0);
}
JS
)
```

Implementation smoke on 2026-10-28: Skills CLI 1.7.4, Node 24.4.0, macOS; both project locations contained the matching skill and resolved init reference. Claude Code links to the universal `.agents/skills/idiom` copy used by Codex. Record this again when changing installer versions; the main test suite does not fetch an installer.

## Matt's external MCP publication steps

First cut a **new npm release** using [the existing release procedure](releases.md). Do not publish this branch's Unreleased code under the existing package version, and do not attempt to mutate an already-published version to add the marker. A release containing `package.json.mcpName` must exist before registry publication. During that release, update all three exact versions together: `package.json.version`, `server.json.version` and `server.json.packages[0].version`. Keep `package.json.mcpName` equal to `server.json.name`.

After the public snapshot and npm publication, verify the exact release (set `version` to its real published number):

```sh
version="$(node -p "require('./package.json').version")"
npm view "@mattskilly/idiom@$version" version mcpName --json
```

The result must contain that exact version and `mcpName: io.github.mattskilly/idiom`. A missing marker means the release is unsuitable for registration; cut a new version. Confirm the packed/public manifest names that same package version.

On macOS, install the official publisher and validate the prepared manifest without publishing:

```sh
brew install mcp-publisher
mcp-publisher --help
mcp-publisher validate
```

Use a current publisher that advertises `validate`. Resolve schema/identity/version errors before continuing. Local validation does not prove npm ownership or GitHub authorization. Then Matt authenticates as `mattskilly` and publishes from the directory containing `server.json`:

```sh
mcp-publisher login github
mcp-publisher publish
curl -fsSL 'https://registry.modelcontextprotocol.io/v0.1/servers?search=io.github.mattskilly/idiom'
```

Inspect readback for the exact server name, version, npm identifier and stdio package. Search can return other records; match the exact identity. For permission errors, check that GitHub login authorizes `io.github.mattskilly/`; for package validation failures, recheck the published npm marker and exact version; for expired credentials, log in again. Do not rename the server to bypass an ownership error.

## Matt's public skill installation and listing steps

The public `mattskilly/idiom` snapshot must first contain `skills/idiom/SKILL.md` and `skills/idiom/references/init.md`. Then users can inspect or install:

```sh
npx skills add mattskilly/idiom --list
npx skills add mattskilly/idiom --skill idiom
npx skills add mattskilly/idiom --skill idiom --agent claude-code --agent codex
```

Explicit directory fallback:

```sh
npx skills add https://github.com/mattskilly/idiom/tree/main/skills/idiom
```

These public-source commands are instructions for Matt and users, not steps performed by the build. The [skills.sh listing FAQ](https://www.skills.sh/docs/faq) describes discovery through normal installation telemetry, not a separate submission command. Matt chooses when to perform a telemetry-enabled public install. Installation does not guarantee immediate indexing or placement. `DISABLE_TELEMETRY=1` or `DO_NOT_TRACK=1` opts out; see the [CLI telemetry implementation](https://github.com/vercel-labs/skills/blob/main/src/telemetry.ts).

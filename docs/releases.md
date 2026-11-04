# Cutting an Idiom release

Idiom releases have a matching annotated Git tag, GitHub Release and runtime tarball. The npm package is `@mattskilly/idiom`; the maintainer publishes it manually from the inspected release tarball. The disabled publish workflow is not part of the plugin release path. Releases are cut in the private workshop repository (`mattskilly/idiom-dev`) and then copied to the public repository (`mattskilly/idiom`) as one commit per release; npm publishes from that public snapshot.

## Prepare the tag

Start from a clean `main` checkout with the intended release commit integrated. Move the candidate's user-visible changes from `## [Unreleased]` into a new `## [v<version>] - YYYY-MM-DD` section in `CHANGELOG.md`. Choose a semantic version and make these values agree:

- The newest dated changelog heading contains the exact candidate version.
- In [upgrading.md](upgrading.md#action-required-by-release), rename `### Unreleased` to `### v<version>` and start a new `### Unreleased` above it reading `None.` Check that the renamed subsection lists everything the release's changelog section asks a user to do (config keys renamed or added with new defaults, captures to recapture, skills to re-vendor with `idiom upgrade`), or reads `None.` Every release gets a subsection; the docs tests fail without one. Add an item under `### Unreleased` whenever a merged change needs user action.
- `package.json` contains the exact version without a `v` prefix.
- `plugins/claude/.claude-plugin/plugin.json.version`, root `plugin.json.version` and `.claude-plugin/marketplace.json.metadata.version` equal the package version. Both plugin names and marketplace names stay `idiom`.
- The MCP definition in `plugins/claude/.claude-plugin/plugin.json` and the documented `codex mcp add` lines (README, `docs/mcp.md`, the site and its guides) select `--package=https://github.com/mattskilly/idiom/releases/download/v<version>/mattskilly-idiom-<version>.tgz`. Update both the URL path and filename versions. Never use a latest selector. The Codex plugin ships no MCP definition: Codex starts plugin MCP servers in the plugin directory, so there is no root `mcp.json`, and `check:plugins` fails if one appears.
- `.agents/plugins/marketplace.json` points at the root portable plugin with `source: {"source":"local","path":"./"}`. Keep its catalog discoverable in the public snapshot.
- The Claude plugin lives in `plugins/claude/` (manifest, `hooks/` and its own `skills/idiom/`), and `.claude-plugin/marketplace.json` points at it with `source: "./plugins/claude"`. That directory must hold no `package.json`, lockfile or `node_modules`. Claude Code copies only the plugin directory into its cache and runs `bun install` or `npm ci` whenever that directory's root has `package.json` plus a lockfile. If bun is missing it shows a "packages it lists are not installed … needs bun" note instead. Neither [the loading reference](https://code.claude.com/docs/en/plugins/loading.md) ("Node.js package dependencies": "You can't turn the automatic install off. No setting or environment variable disables it.") nor Claude Code 2.1.312 offers a switch. Pointing the catalog at the repository root pulled Idiom's development dependencies into every install, 292 MB in the v0.16.0 smoke. `check:plugins` fails if any of those files appears in `plugins/claude/`, if a root `.claude-plugin/plugin.json` returns, or if a hook imports anything other than a `node:` built-in or a sibling file.
- Each plugin ships the generated portable skill in its own root through default `skills/` discovery: `plugins/claude/skills/idiom/` for Claude and `skills/idiom/` for Codex and other portable hosts. `plugins/claude/.claude-plugin/plugin.json` and root `plugin.json` declare no `skills` field. `templates/idiom/` is the authoring source for `generate:skill` and `idiom init`; no plugin points at it. `check:plugins` fails unless each manifest resolves to exactly one `idiom` skill.
- Run `bun run check:plugins`; the same guard runs before build and public snapshot check/export, and in the disabled publication workflow's identity checks if that workflow is ever deliberately enabled again.
- The annotated tag will be `v<version>`.
- `server.json.version` and its npm package version match `package.json.version` exactly; `package.json.mcpName` equals `server.json.name`. Audit tool catalog parity, publisher metadata size and the marker-bearing npm release prerequisite in [distribution.md](distribution.md).
- Before the following release, add each newly released tag to the offline skill catalog: run `node scripts/generate-skill-history.mjs` with all immutable release tags available, then `node scripts/generate-skill-history.mjs --check`. Review tag/peeled-commit provenance, exact blob digests and absence-aware file mappings in `templates/skill-history/`, and commit the generated data. Generation is a maintainer action, never an installation/runtime hook.
- Run `bun run generate:skill` and `bun run generate:skill --check`; commit both generated copies (`skills/idiom/` and `plugins/claude/skills/idiom/`) and inspect them in the public snapshot and npm pack.
- `playwright` is pinned to an exact version in `package.json` and `bun.lock`.
- Both browser-install commands in `README.md` use that exact Playwright version.
- The README installs with `npm install -g @mattskilly/idiom`; its printed-version example and exact-version pin name this exact Idiom version.
- The update-smoke candidate `version` names this exact Idiom version.
- The update-smoke `previous_version` names the immediately older release heading in the newest-first changelog.
- The update-smoke `interface_version` literal equals `INTERFACE_VERSION` in `src/interface/version.ts`. The smoke runs outside the checkout, so it cannot read the constant.
- **Interface check.** Run `bun run contract:update`. If `test/contract/interface.json` changed, or `INTERFACE_VERSION` moved since the previous tag, list every change in its diff under an `### Interface` heading in the release's CHANGELOG section, and commit the snapshot. A breaking change names the interface bump and the replacement ([stability](stability.md)). Otherwise the section has no Interface heading.
- `site/index.html` and the hand-written docs in `site/docs/*.md` (including the two guides) describe exactly this release: the install lines in the landing page, `getting-started.md` and both guides use `npm install -g @mattskilly/idiom`, the `codex mcp add` lines and the guides' "For Idiom" version tags name it, and every user-visible command, rule, default and MCP tool added or changed in its changelog section is reflected, while nothing unreleased is claimed. idiom.build production serves the `release` branch, which only this process moves ([Move idiom.build to the release](#move-idiombuild-to-the-release)); `main` and pull requests deploy as previews. A feature PR may update the site alongside the behaviour it ships, and those changes go live when the release moves `release`. This pass still confirms the site describes exactly this release. The reference pages under idiom.build/docs (commands, rules, configuration, MCP, design comparison) are rendered from `docs/*.md` at build time and need no separate pass. The README (the public GitHub page, carried by the public snapshot) gets the same pass: what Idiom does, how it works and why it helps, accurate to this release.

The current smoke pair is `previous_version="0.18.0"` and `version="0.19.0"`. When preparing the next release, advance both literals — the candidate becomes `version` and the newest released heading becomes `previous_version` — as part of the source commit. The published `v0.6.0` predates embedded provenance and prints a bare version; `v0.7.0` is the first release that prints `<version> (<short source commit>)`.

Before recording the source, check that `release` carries nothing `main` lacks, so the release push below is a fast-forward:

```sh
git fetch origin release
git merge-base --is-ancestor origin/release HEAD
```

If the check fails, `release` holds site-only fixes not yet on `main` ([Fixing the live site between releases](#fixing-the-live-site-between-releases)). Run `git merge --no-edit origin/release` and include the merge in the source commit.

### Record the source, then commit the distribution

The embedded commit is the checkout HEAD **at build time**. A generated bundle cannot contain the hash of the later commit recording itself. Finish and commit every intended source, version, lockfile, and documentation change first (stage those paths explicitly, leaving `dist/cli.js` for the next commit). Start this sequence with a clean worktree:

```sh
build_source_commit="$(git rev-parse --verify HEAD)"
version="$(node -p "require('./package.json').version")"
interface_version="$(sed -n 's/^export const INTERFACE_VERSION = \([0-9][0-9]*\);$/\1/p' src/interface/version.ts)"
expected_display="$version ($(printf '%s' "$build_source_commit" | cut -c1-7)) · interface $interface_version"
```

Record that full source hash in the release record. Run the complete configured gate from this source commit, stopping if any command fails:

```sh
bun install --frozen-lockfile &&
bun run typecheck &&
bun run test &&
bun run lint &&
bun run build
```

`bun run test` builds before testing the packed payload. Confirm `node dist/cli.js --version` prints exactly `$expected_display`, `<version> (<short source commit>) · interface <n>`, where `<n>` is `INTERFACE_VERSION` in `src/interface/version.ts`. Review the generated diff, then commit **only** the tracked bundle:

```sh
test "$(node dist/cli.js --version)" = "$expected_display" &&
git ls-files --error-unmatch dist/cli.js &&
git add -u -- dist/cli.js &&
git commit -m "Build Idiom distribution from ${build_source_commit}" &&
test "$(git diff --name-only "$build_source_commit" HEAD)" = "dist/cli.js" &&
test -z "$(git status --porcelain)" &&
test "$(node dist/cli.js --version)" = "$expected_display"
```

The source-to-distribution diff must contain only `dist/cli.js`. Any further source change restarts the sequence with a new source commit and a rebuilt bundle. Do not rebuild at the distribution commit and expect identical bytes: its HEAD is different.

Check reproducibility from the recorded source commit in a detached temporary checkout, using the same locked toolchain and offline dependency tree:

```sh
(
  set -eu
  : "${build_source_commit:?Set the recorded source commit}"
  release_root="$(pwd -P)"
  repro_root="$(mktemp -d)"
  repro_checkout="$repro_root/source"
  trap 'git -C "$release_root" worktree remove --force "$repro_checkout"; rm -rf "$repro_root"' EXIT
  git worktree add --detach "$repro_checkout" "$build_source_commit"
  ln -s "$release_root/node_modules" "$repro_checkout/node_modules"
  (cd "$repro_checkout" && bun run build)
  cmp "$release_root/dist/cli.js" "$repro_checkout/dist/cli.js"
)
```

Record both full commits: the build-source commit embedded in the payload, and the distribution commit that will be the tag's peeled installation commit. The annotated tag object's SHA is neither of those identities.

From that clean checkout, create and push an annotated tag that exactly matches `package.json`:

```sh
version="$(node -p "require('./package.json').version")"
git tag -a "v${version}" -m "Idiom v${version}"
git push origin main "v${version}"
```

Do not move a published release tag. If its smoke test fails, fix the release and cut a new version.

### Move idiom.build to the release

idiom.build production builds from the `release` branch. Fast-forward it to the tag's peeled distribution commit:

```sh
git fetch origin release
if git rev-parse --verify -q origin/release >/dev/null &&
   ! git merge-base --is-ancestor origin/release "v${version}^{commit}"; then
  printf >&2 'release is not an ancestor of v%s: merge origin/release into main and cut a new tag.\n' "$version"
  exit 1
fi
git push origin "v${version}^{commit}:refs/heads/release"
```

Never `--force` this push. Git rejects a non-fast-forward anyway; the preflight turns that into an actionable message. Vercel's Git integration then builds production from that commit. The hosted-review Functions (`api/hosted-*.ts`) and `vercel.json` ship from `release` with the site, so a hosted-review change goes live with a release too.

### One-time: point Vercel production at `release`

1. Create the branch at the current release, so it holds the released site: `git push origin v0.18.0^{commit}:refs/heads/release` (or the newest release tag).
2. In Vercel, project `idiom` → Project Settings → Git → **Production Branch** = `release`.
3. Confirm with the idiom.build check in [Done when](#done-when).

Because step 1 comes first, flipping the setting is safe at any time. No Vercel credentials or API calls are involved. Until the setting flips, production still deploys from `main`.

### Fixing the live site between releases

A typo or broken link on idiom.build can be fixed without a version bump:

1. Land the fix on `main` by pull request first.
2. Cherry-pick it onto `release`:

   ```sh
   git fetch origin release
   git switch -c site-fix origin/release
   git cherry-pick -x <sha>
   git diff --name-only origin/release..HEAD
   ```

3. The diff may list only `site/`, the `docs/*.md` pages rendered into the site (`docs/design-compare.md`, `docs/commands.md`, `docs/rules.md`, `docs/configuration.md`, `docs/troubleshooting.md`, `docs/upgrading.md`, `docs/stability.md`, `docs/glossary.md`, `docs/brief.md`, `docs/mcp.md`, the set `scripts/site-docs.mjs` renders), `vercel.json` and `api/`. Anything else is not site-only; stop.
4. `git push origin HEAD:refs/heads/release`. It is a fast-forward; never force it.
5. Merge `origin/release` back into `main` by pull request, so the next release push stays a fast-forward. The content is already on `main`, so the merge is clean.

Anything that describes new behaviour waits for the next release.

## Publish the GitHub Release

Publish the changelog entry as the release body only after the annotated tag has been pushed. The extractor matches the canonical dated heading literally, stops at the next release heading, and refuses to call GitHub when the requested heading is absent or its body is empty:

```sh
(
  version="$(node -p "require('./package.json').version")"
  release_heading="## [v${version}]"
  release_notes="$(mktemp)"
  trap 'rm -f "$release_notes"' EXIT

  awk -v heading="$release_heading" '
    index($0, heading " - ") == 1 { found = 1; next }
    found && index($0, "## [") == 1 { exit }
    found { print }
    END { if (!found) exit 1 }
  ' CHANGELOG.md > "$release_notes"
  extractor_status="$?"
  if test "$extractor_status" -ne 0; then
    printf >&2 'No changelog heading found for Idiom %s.\n' "$version"
    exit 1
  fi

  if ! test -s "$release_notes"; then
    printf >&2 'The changelog entry for Idiom %s is empty.\n' "$version"
    exit 1
  fi

  if ! published_url="$(gh release create "v${version}" \
      --verify-tag \
      --title "Idiom v${version}" \
      --notes-file "$release_notes")"; then
    exit 1
  fi
  if ! published_body="$(gh release view "v${version}" --json body --jq .body)"; then
    exit 1
  fi

  if test "$published_body" != "$(cat "$release_notes")"; then
    printf >&2 'Published release body does not match CHANGELOG.md.\n'
    exit 1
  fi

  printf 'Published %s with this changelog body:\n\n%s\n' \
    "$published_url" "$published_body"
)
```

The subshell removes the temporary notes file on success or failure. Inspect the reported URL and body before continuing.

## Publish the public snapshot and npm package

The tag and GitHub Release above live in the workshop repository. The public repository receives one commit per release, built from the public file set. `scripts/public-snapshot.mjs` excludes internal documents, internal agent skills and Autobuild configuration. The sole exception under `.agents/` is `.agents/plugins/marketplace.json`; unrelated files there remain excluded. Both Claude manifests, root `plugin.json`/`mcp.json`, portable `skills/`, `templates/`, `server.json` and `scripts/check-plugins.mjs` remain included. The package allowlist also ships all plugin metadata, without shipping internal agent skills. The script refuses to copy when any public file names a private product or contains a local path. It is not part of the snapshot.

```sh
(
  set -eu
  version="$(node -p "require('./package.json').version")"
  node scripts/public-snapshot.mjs --check
  public_root="$(mktemp -d)"
  git clone --quiet git@github.com:mattskilly/idiom.git "$public_root/idiom"
  (cd "$public_root/idiom" && git rm -rq --ignore-unmatch . )
  node scripts/public-snapshot.mjs --out "$public_root/idiom"
  cd "$public_root/idiom"
  git add -A
  git add -f dist/cli.js
  git commit -m "Idiom v${version}"
  git tag -a "v${version}" -m "Idiom v${version}"
  # Publish the immutable snapshot/tag without advancing the advertised catalog.
  git push origin "v${version}"
  pack_record="$(mktemp)"
  npm pack --ignore-scripts --json > "$pack_record"
  tarball="$(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))[0].filename)' "$pack_record")"
  test "$tarball" = "mattskilly-idiom-${version}.tgz"
  packed_root="$(mktemp -d)"
  tar -xzf "$tarball" -C "$packed_root"
  node scripts/check-plugins.mjs "$packed_root/package"
  cmp dist/cli.js "$packed_root/package/dist/cli.js"
  gh release create "v${version}" "$tarball" --repo mattskilly/idiom --verify-tag \
    --title "Idiom v${version}" --notes-file "$release_notes"
  # Prove the unchanged public launcher URL is readable before advertising it.
  curl --fail --location --retry 3 \
    "https://github.com/mattskilly/idiom/releases/download/v${version}/mattskilly-idiom-${version}.tgz" \
    --output "$packed_root/downloaded.tgz"
  cmp "$tarball" "$packed_root/downloaded.tgz"
  git push origin main
  rm -rf "$packed_root"
  rm -f "$pack_record"
  # Keep the inspected tarball here for later manual npm publication.
)
```

Set `release_notes` to the extracted changelog body first (the extractor above). The first public release creates the repository with `gh repo create mattskilly/idiom --public` instead of cloning. Every plugin-bearing release must attach the exact prepared snapshot's `mattskilly-idiom-<version>.tgz`, packed with scripts disabled and the committed bundle intact. A GitHub source-code archive is not a runtime package. Inspect its package and plugin manifests, skills and hooks, and compare the downloaded asset bytes before advancing public `main`. The public default branch is the advancing release catalog; do not pin users to a permanent old tag. Published versions, tags and assets are immutable. A failure after publishing requires a new version, never replacement of an existing asset.

npm publishing is manual and done by the maintainer, after the public snapshot and its GitHub Release asset are published and inspected. The maintainer runs it in their own terminal, never through an agent session, signed in interactively with web authentication. Publish the exact tarball attached to the public release:

```sh
mkdir -p ~/idiom-publish && cd ~/idiom-publish
curl -LO https://github.com/mattskilly/idiom/releases/download/v<version>/mattskilly-idiom-<version>.tgz
openssl dgst -sha512 -binary mattskilly-idiom-<version>.tgz | base64
npm login
npm whoami
npm publish mattskilly-idiom-<version>.tgz --access public --auth-type=web
```

The `openssl` output must equal the integrity of the tarball inspected above, without its `sha512-` prefix, and `npm whoami` must print the maintainer's account before publishing. If a publish fails, stop and read the exact error. Don't retry it and don't change account security settings: repeated attempts triggered an npm account hold in October 2026. A `404 Not Found - PUT` on a package that already exists means the terminal isn't signed in; `npm whoami` returns 401. Then verify with `npm view @mattskilly/idiom@<version> version mcpName --json` and `npm view @mattskilly/idiom dist-tags` (`latest` should name the new version), and follow [the separate registry and skill-listing handoff](distribution.md). Do not enable or dispatch `.github/workflows/publish.yml`, and do not make npm publication a prerequisite for plugin installation: the plugin's MCP launcher pins the GitHub release tarball. The disabled workflow retains identity checks for any future deliberate reactivation; no activation is implied here.

## Smoke plugin installation and update

Run these release gates with the real Claude Code and Codex CLIs in a disposable container/account or an isolated temporary home per host. For the latter, create fresh directories and set `HOME`, `XDG_CONFIG_HOME`, `XDG_DATA_HOME` and `XDG_CACHE_HOME` inside that host's temporary directory; also set `CLAUDE_CONFIG_DIR` for Claude and `CODEX_HOME` for Codex, creating those directories before invoking the host. Use an isolated npm cache and an environment without inherited authentication tokens. Never copy credentials or log in for this development smoke. If a host refuses plugin commands without authentication, record the exact error as **not run** and retain its authenticated native smoke as a public release gate. Remove all temporary directories afterwards.

Hash the real home's `.claude`, `.codex` and plugin caches before and after, recording aggregate checksums and any changed paths. Verify that configuration files and plugin caches have identical bytes before and after; if concurrent agent sessions change session logs or SQLite journals, identify those paths explicitly instead of claiming the entire home was unchanged. Record OS, Node/npm, Claude/Codex versions, public snapshot SHA/tag and the exact asset URL.

1. In a fresh application directory, install matching Chromium (`npx playwright@1.62.1 install chromium`). Use Claude's `/plugin marketplace add mattskilly/idiom` and `/plugin install idiom@idiom` (shell equivalents: `claude plugin marketplace add mattskilly/idiom` and `claude plugin install idiom@idiom`). For Codex, use `codex plugin marketplace add mattskilly/idiom`, then `codex plugin add idiom@idiom --json`, then the documented `codex mcp add idiom -- npx -y --package=<release URL> idiom mcp`. Record the reported installed path/version and launcher in each host. For each host, also record the installed plugin directory's size (`du -sh <installed path>`), whether it contains a `node_modules`, and any dependency note in `claude plugin list` or `/plugin` (Claude) or in the `codex plugin` output (Codex). Run the Claude install twice, in separate fresh homes: once with `bun` on `PATH`, and once with a `PATH` that holds only the Node directory. Expected for Claude, in both runs: no dependency note, no `node_modules`, and a cache directory holding only `.claude-plugin/`, `hooks/` and `skills/`. No global CLI is needed.
2. Start a fresh session in each host. Inspect the twenty-two MCP tools and confirm each host lists exactly one `idiom` skill: Claude loads `plugins/claude/skills/idiom` (the cache holds it as `skills/idiom`), and Codex loads root `skills/idiom`; Claude must also discover both original PostToolUse and Stop reminders. Write a UI fixture and observe the edit reminder and the one-time stop reminder. Codex must discover the portable skill from the plugin and the MCP server from `codex mcp add`, without inheriting Claude hooks: root `plugin.json` explicitly supplies `extensions.com.openai.hooks: {"hooks":{}}`.
3. Launch the cached MCP definition from the application directory using its unmodified HTTPS URL. With the MCP SDK, initialize, inspect `serverInfo.version` (`client.getServerVersion().version`), list tools and call `idiom_flows` or `idiom_context` against an application with a distinct configuration. Record that the version equals the cached plugin/package version and that project resolution uses the application directory. A catalog/manifest version alone is insufficient. Launching the server yourself cannot show where the host starts it, so also record each host's resolved MCP working directory (for Codex, `codex mcp get idiom --json`), and from a native session or thread opened in the application directory make one project-bound tool call (`idiom_flows` or `idiom_context`) and confirm it reads that application's configuration.
4. In another fresh disposable environment, install the preceding plugin-bearing release, record the same evidence, then advance its Git-backed marketplace to the candidate default branch. Claude: `claude plugin marketplace update idiom`, `claude plugin update idiom@idiom`, then `/reload-plugins` or a new session. Codex: `codex plugin marketplace upgrade idiom`, inspect the installed version, then `codex plugin add idiom@idiom --json` and start a new session. Record whether marketplace upgrade refreshed the configured plugin directly or re-add was needed. Prove the installed path/version, cached launcher and MCP version all advance to the candidate; a refreshed catalog is insufficient.

For the first plugin release, the historical preceding public release has no marketplace. First exercise the install/update sequence with two disposable local Git snapshots A and B with distinct coherent fixture versions, normal default-branch tracking and the real native loaders. A loopback smart HTTP Git endpoint supports both loaders, including Claude's shallow clone; `file://` source syntax and dumb HTTP are insufficient for Claude. Do not manually replace plugin caches. For runtime development smoke, pack a built candidate and serve it on a loopback tarball URL; change only that test copy's URL. Use the actual `npx -y --package=<fixture-url> idiom mcp` arguments, an isolated npm cache, and a competing local/global Idiom of another version. Check protocol-clean stdout, all tools, application-root binding and the candidate MCP initialization version. Never substitute a fake npx or mock the server version.

The local fixture exercise does not prove a public asset exists. After publication, repeat fresh add/install from `mattskilly/idiom` with its unchanged HTTPS launcher; repeat updates between public plugin releases when available. Copy all before/after versions, installed paths, tool/skill/hook inventories, reminder observations and MCP handshakes into the release record. This public smoke remains a release gate until the candidate files are actually published.

## Smoke a first install

The SSH and global-link checks are credentialed release gates. They are intentionally not part of `bun run test`, which must remain offline and independent of maintainer credentials.

Bun **1.4.4** is the minimum verified installer for this procedure; Node remains the runtime. This is a verified floor, not evidence that all older Bun versions fail. Prepare an unrelated application's project configuration and one flow using docs/configuration.md, then set `smoke_application` to its absolute directory and `smoke_flow` to that flow. The installed candidate below runs `init --yes`, validate, and capture there; choose a disposable application checkout and review its initialized files.

Set `build_source_commit` to the full source hash recorded above. This candidate smoke must run only after the candidate tag exists. It runs outside the Idiom checkout, installs the quoted tag in a fresh prefix, and independently installs the peeled commit in a second fresh prefix/cache:

```sh
(
  set -eu
  : "${build_source_commit:?Set the full recorded build-source commit}"
  : "${smoke_application:?Set an unrelated configured application directory}"
  : "${smoke_flow:?Set its configured flow}"
  version="$(node -p "require('./package.json').version")"
  interface_version="$(sed -n 's/^export const INTERFACE_VERSION = \([0-9][0-9]*\);$/\1/p' src/interface/version.ts)"
  expected_display="$version ($(printf '%s' "$build_source_commit" | cut -c1-7)) · interface $interface_version"
  printf '%s\n' "$build_source_commit" | LC_ALL=C grep -Eq '^([0-9a-f]{40}|[0-9a-f]{64})$'
  tag_ref="refs/tags/v${version}"
  refs="$(git ls-remote --exit-code git@github.com:mattskilly/idiom.git \
    "$tag_ref" "${tag_ref}^{}")"
  install_commit="$(printf '%s\n' "$refs" | awk -v tag="$tag_ref" '
    $2 == tag { direct = $1 }
    $2 == tag "^{}" { peeled = $1 }
    END { print (peeled != "" ? peeled : direct) }
  ')"
  printf '%s\n' "$install_commit" | LC_ALL=C grep -Eq '^([0-9a-f]{40}|[0-9a-f]{64})$'

  smoke_root="$(realpath "$(mktemp -d)")"
  trap 'rm -rf "$smoke_root"' EXIT
  mkdir "$smoke_root/work"
  cd "$smoke_root/work"
  printf 'Platform: %s\nBun: %s\nNode: %s\nTag: %s\nInstall commit: %s\nBuild source: %s\n' \
    "$(uname -sm)" "$(bun --version)" "$(node --version)" \
    "$tag_ref" "$install_commit" "$build_source_commit"

  for install_kind in tag commit; do
    # The cache is a separate sibling, outside this install's fresh prefix.
    export BUN_INSTALL="$smoke_root/$install_kind-prefix"
    export BUN_INSTALL_CACHE_DIR="$smoke_root/$install_kind-cache"
    mkdir "$BUN_INSTALL" "$BUN_INSTALL_CACHE_DIR"
    selected_cache="$(bun pm cache)"
    test "$selected_cache" = "$BUN_INSTALL_CACHE_DIR"
    bun pm cache rm
    printf 'Cleared isolated cache: %s; prefix: %s\n' "$selected_cache" "$BUN_INSTALL"
    if test "$install_kind" = tag; then
      install_ref="v${version}"
    else
      install_ref="$install_commit"
    fi
    bun add -g "git+ssh://git@github.com/mattskilly/idiom.git#${install_ref}"
    idiom_bin="$BUN_INSTALL/bin/idiom"
    test -L "$idiom_bin"
    resolved_bin="$(realpath "$idiom_bin")"
    test "$resolved_bin" = "$BUN_INSTALL/install/global/node_modules/@mattskilly/idiom/dist/cli.js"
    installed_display="$("$idiom_bin" --version)"
    installed_version="${installed_display%% *}"
    test "$installed_display" = "$expected_display"
    test "$installed_version" = "$version"
    printf '%s install PASS: display=%s; version=%s; bin=%s; target=%s\n' \
      "$install_kind" "$installed_display" "$installed_version" "$idiom_bin" "$resolved_bin"
  done

  # Exercise the installed payload in the unrelated application before cleanup.
  cd "$smoke_application"
  "$idiom_bin" init --yes
  "$idiom_bin" validate "$smoke_flow"
  "$idiom_bin" capture "$smoke_flow"
)
```

The subshell owns both prefixes/caches, restores the caller's environment on exit, and removes its temporary directories on success or failure. Canonicalizing the temporary root keeps expected paths identical to `realpath` on macOS. `bun pm cache` must name the isolated cache **before** clearing it; never delete the maintainer's default cache. A failed tag install stops the smoke: fallback success never excuses tag failure. Both installs must report the exact candidate version and recorded build-source hash; existing historical tags cannot test this new suffix.

The installer-created symlink and exact resolved target prove execution beneath the isolated prefix into the package's `dist/cli.js`. Confirm the external report contains baseline, screenshot, DOM, console, accessibility, observations, and metadata artifacts. Copy the platform, Bun/Node versions, tag, full peeled installation commit, full build-source commit, both cache paths and isolation checks, reported displays/parsed versions, resolved bins, report path, and results into the release record before giving the tag to another engineer. Captured application metadata describes that application's commit, independently of Idiom's embedded build identity.

## Smoke an update

Every release after the first must also prove replacement in place. Create another fresh, empty `BUN_INSTALL` prefix and separate cache; do not reuse either first-install prefix. Set the full `build_source_commit` from the release record, and the same `smoke_application`/`smoke_flow` used above. Set `previous_version` to the immediately preceding released tag and `version` to the candidate, then install and replace within that same update-test prefix:

```sh
(
  set -eu
  : "${build_source_commit:?Set the recorded build-source commit}"
  : "${smoke_application:?Set the unrelated application directory}"
  : "${smoke_flow:?Set its configured flow}"
  smoke_root="$(realpath "$(mktemp -d)")"
  trap 'rm -rf "$smoke_root"' EXIT
  export BUN_INSTALL="$smoke_root/prefix"
  export BUN_INSTALL_CACHE_DIR="$smoke_root/cache"
  mkdir "$BUN_INSTALL" "$BUN_INSTALL_CACHE_DIR" "$smoke_root/work"
  test "$(bun pm cache)" = "$BUN_INSTALL_CACHE_DIR"
  bun pm cache rm
  cd "$smoke_root/work"
  previous_version="0.18.0"
  version="0.19.0"
  interface_version="1"
  expected_display="$version ($(printf '%s' "$build_source_commit" | cut -c1-7)) · interface $interface_version"
  idiom_bin="$BUN_INSTALL/bin/idiom"

  if bun add -g "git+ssh://git@github.com/mattskilly/idiom.git#v${previous_version}"; then
    previous_display="$("$idiom_bin" --version)"
    previous_bare="${previous_display%% *}"
    printf 'Preceding display: %s; parsed version: %s\n' "$previous_display" "$previous_bare"
    if test -L "$idiom_bin" &&
      test "$previous_bare" = "$previous_version" &&
      test "$(realpath "$idiom_bin")" = \
        "$BUN_INSTALL/install/global/node_modules/@mattskilly/idiom/dist/cli.js"; then
      printf 'Verified preceding Idiom %s link at %s.\n' \
        "$previous_version" "$idiom_bin"
      if git ls-remote --exit-code git@github.com:mattskilly/idiom.git "refs/tags/v${version}"; then
        if bun remove -g idiom && test ! -e "$idiom_bin"; then
          if bun add -g "git+ssh://git@github.com/mattskilly/idiom.git#v${version}"; then
            candidate_display="$("$idiom_bin" --version)"
            candidate_bare="${candidate_display%% *}"
            printf 'Candidate display: %s; parsed version: %s\n' "$candidate_display" "$candidate_bare"
            if test -L "$idiom_bin" &&
              test "$candidate_bare" = "$version" &&
              test "$candidate_display" = "$expected_display" &&
              test "$(realpath "$idiom_bin")" = \
                "$BUN_INSTALL/install/global/node_modules/@mattskilly/idiom/dist/cli.js"; then
              printf 'Verified in-place update to Idiom %s at %s.\n' \
                "$version" "$idiom_bin"
            else
              printf >&2 'Updated Idiom link, version, or resolved target is invalid.\n'
              false
            fi
          else
            if bun add -g "git+ssh://git@github.com/mattskilly/idiom.git#v${previous_version}"; then
              printf >&2 'Update failed; restored Idiom %s.\n' "$previous_version"
            else
              printf >&2 'Update and rollback both failed; reinstall Idiom %s manually.\n' \
                "$previous_version"
            fi
            false
          fi
        else
          printf >&2 'Could not remove the preceding isolated Idiom link; smoke stopped.\n'
          false
        fi
      else
        printf >&2 'Candidate tag preflight failed; preceding Idiom remains installed.\n'
        false
      fi
    else
      printf >&2 'Preceding Idiom link, version, or resolved target is invalid.\n'
      false
    fi
  else
    printf >&2 'Could not install preceding Idiom %s; update smoke stopped.\n' \
      "$previous_version"
    false
  fi

  # Commit the target's initialized managed files before this update smoke.
  cd "$smoke_application"
  test -z "$(git status --porcelain)"
  "$idiom_bin" validate "$smoke_flow"
  "$idiom_bin" capture "$smoke_flow"
  test -z "$(git status --porcelain)"
)
```

The remove assertion followed by the symlink and exact-version assertions proves that Bun recreated the command at the same absolute bin path and that it now runs the new package. Its resolved target correctly remains the same version-independent global package path across the replacement. Direct `bun add -g` over the installed pinned ref and `bun update -g` are not substitutes: Bun 1.3.14 does not reliably retarget this Git dependency.

Before the update capture, commit the initialized target application's managed files and record their hashes or clean Git status. Run the same external-repository validate/capture smoke with the new binary and confirm those initialized files remain unchanged; only ignored report output may be added. If replacement fails after removal, the guarded command restores the preceding tag. Record both full reported displays and their parsed bare versions, the stable bin path and resolved target, unchanged project state, and the new report path. Preceding releases may print a bare version; a candidate containing this change must match the exact expected commit-bearing display.

Copy the output and report path to the release record. The subshell trap removes the temporary prefix/cache and leaves the caller's environment intact. Never use the normal global Bun prefix for this test.

## Smoke the public GitHub Action

Release the root `action.yml` and every `scripts/github-action/*.mjs` helper in the same public snapshot, alongside a compatible npm version containing `check --baseline-file`, `baseline record --out` and summary finding fingerprints. The snapshot script includes these tracked paths automatically; inspect the staged public snapshot before publishing. The original 0.8.0 CLI cannot run the new Action. Pin the workflow's `version` to the candidate package and `uses` to its public snapshot commit or release tag.

In a disposable configured application repository, use the `pull_request` workflow in docs/configuration.md with full history, head checkout, `persist-credentials: false`, `contents: read` and `pull-requests: write`. Make the base branch advance independently after branching so its tip differs from the merge base. Open a PR that introduces an intentional deterministic regression and includes a nearer head-accepted baseline. Confirm:

- `baseline-sha` is the actual merge base, and the head record cannot conceal the new finding.
- One managed comment shows Blocks merge, Should fix and Opportunities with exact counts, three expanded entries per tier (Problem, Fix, evidence and Done when), and tier-local details for the rest. Include a question and more than three findings in a tier. Verify filmstrip contact-sheet filenames for timeline issues, crop/composite filenames otherwise, explicit missing/partial evidence, and the authenticated artifact link. Download it; open `index.html` and verify actual PNG thumbnails/contact sheets and full before/after evidence. The PR comment contains filenames and the download link, not inline GitHub thumbnails. Overflow points to the full HTML and stays within 55,000 UTF-8 bytes.
- The artifact uploads and the comment/job summary publish before the final severity gate fails.
- Push a fix to the same PR for a regression absent from the merge base. Keep a non-gating regression and a pre-existing finding. The same comment ID updates, tier counts change, and the final gate passes. Resolved names the introduced-then-fixed regression with the previous/current SHA labels and real before/after files in the new artifact; surviving and pre-existing findings are not labelled resolved. Verify separate merge-base resolution counts. Synchronize adds at most one previous-head capture and reuses the current capture; missing or stale historical evidence is disclosed.
- A fork PR with a read-only token warns about unavailable comments, retains artifacts and job summary, and still gates findings. No `pull_request_target` workaround is needed.

Record the public Action ref, npm version, workflow runs, merge-base/previous-head/current-head SHAs, tier and resolved counts, comment ID, artifact URL and fail-then-pass results with the release evidence. This credentialed GitHub smoke is a release gate; offline tests exercise the same helpers and real built CLI without publishing or making GitHub writes.

## Done when

A release is finished only when every surface below names the same version `X` and each one has been checked, not assumed. Report each check's result in the release record and to the maintainer.

| Surface | What must show `X` | Updated by |
| --- | --- | --- |
| Workshop GitHub | `vX` tag peeling to the distribution commit, and a `vX` release whose body is the changelog section | This guide |
| Public GitHub | `vX` as Latest with the `mattskilly-idiom-X.tgz` asset; public `main` is the `vX` snapshot | The public snapshot step |
| Public README | Install lines, the printed-version example and the exact-version pin | The release PR (the snapshot copies it) |
| Plugin and registry manifests | `.claude-plugin/marketplace.json`, `plugins/claude/.claude-plugin/plugin.json`, root `plugin.json`, `server.json` and `package.json` on public `main` | The release PR's version bump |
| npm | `latest` dist-tag, matching integrity, and a fresh `npx` printing `X` | The maintainer's `npm publish` |
| idiom.build landing page | Install section and the `codex mcp add` launcher URL | The release PR, deployed to production when `release` moves |
| idiom.build docs | `/docs/getting-started`, both guides' "For Idiom vX" labels, `/llms.txt` | The release PR, deployed to production when `release` moves |
| idiom.build production commit | `https://idiom.build/version.txt` and the landing page's `<meta name="idiom-source">` equal `git rev-parse "vX^{commit}"` (or `git rev-parse origin/release` if a site-only fix has landed since) | [Move idiom.build to the release](#move-idiombuild-to-the-release) |
| Session handoff | `docs/session-handoff.md` names `X` as the current release and npm's state | The release PR or a follow-up |

Check them all in one pass after `release` has moved, production has deployed and npm is published. Check `https://idiom.build` itself; a `main` preview is not production:

```sh
(
  X="0.19.0"
  gh release view "v$X" --repo mattskilly/idiom-dev --json tagName --jq .tagName
  gh release list --repo mattskilly/idiom --limit 1
  gh release view "v$X" --repo mattskilly/idiom --json assets --jq '.assets[].name'
  for f in README.md .claude-plugin/marketplace.json plugins/claude/.claude-plugin/plugin.json plugin.json server.json package.json; do
    printf '%s: ' "$f"
    curl -fsSL "https://raw.githubusercontent.com/mattskilly/idiom/main/$f" | grep -c "$X"
  done
  npm view @mattskilly/idiom dist-tags
  npm view "@mattskilly/idiom@$X" dist.integrity
  npm_config_cache="$(mktemp -d)" npx -y "@mattskilly/idiom@latest" --version
  printf 'idiom.build/version.txt: '
  curl -fsSL https://idiom.build/version.txt
  git rev-parse "v$X^{commit}"
  printf 'idiom-source meta: '
  curl -fsSL https://idiom.build/ | grep -o '<meta name="idiom-source" content="[^"]*"'
  for page in / /docs/getting-started /docs/design-qa-for-claude-code /docs/testing-loading-empty-error-states /llms.txt; do
    printf 'idiom.build%s: ' "$page"
    curl -fsSL "https://idiom.build$page" | grep -c "v$X"
  done
)
```

Every count must be at least 1, the public release list must show `vX` as Latest, and both `npm view` lines and the `npx` output must name `X`. `version.txt` and the `idiom-source` meta must both equal the tag's peeled commit (or `origin/release` after a site-only fix). The integrity must equal the attached tarball's: `printf 'sha512-%s\n' "$(openssl dgst -sha512 -binary mattskilly-idiom-X.tgz | base64)"`.

idiom.build production serves `release`, so merged site changes wait for the next release, while the README on workshop `main` still runs ahead of it. Keep the gap short:

- Cut a release after each merged wave instead of letting `## [Unreleased]` accumulate.
- At release time, check that the site and README describe nothing that is missing from the release's changelog section, and nothing in that section is missing from them.

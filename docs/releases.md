# Cutting an Idiom release

Idiom is published to npm as `@mattskilly/idiom`, with a matching annotated Git tag and GitHub Release. Releases are cut in the private workshop repository (`mattskilly/idiom-dev`) and then copied to the public repository (`mattskilly/idiom`) as one commit per release; npm publishes from that public snapshot.

## Prepare the tag

Start from a clean `main` checkout with the intended release commit integrated. Move the candidate's user-visible changes from `## [Unreleased]` into a new `## [v<version>] - YYYY-MM-DD` section in `CHANGELOG.md`. Choose a semantic version and make these values agree:

- The newest dated changelog heading contains the exact candidate version.
- `package.json` contains the exact version without a `v` prefix.
- The annotated tag will be `v<version>`.
- `server.json.version` and its npm package version match `package.json.version` exactly; `package.json.mcpName` equals `server.json.name`. Audit tool catalog parity, publisher metadata size and the marker-bearing npm release prerequisite in [distribution.md](distribution.md).
- Run `bun run generate:skill` and `bun run generate:skill --check`; commit both portable outputs and inspect them in the public snapshot and npm pack.
- `playwright` is pinned to an exact version in `package.json` and `bun.lock`.
- Both browser-install commands in `README.md` use that exact Playwright version.
- The README's copy-ready install command, printed-version instruction, and update literals name this exact Idiom version.
- The update-smoke candidate `version` names this exact Idiom version.
- The update-smoke `previous_version` names the immediately older release heading in the newest-first changelog.
- `site/index.html`, `site/guide.html`, `site/design-qa-for-claude-code.html` and `site/testing-loading-empty-error-states.html` describe exactly this release: the field guide's version label names it, and every user-visible command, rule, default and MCP tool added or changed in its changelog section is reflected, while nothing unreleased is claimed. idiom.build deploys from `main`, so the site changes land in the release PR, never earlier. The README (the public GitHub page, carried by the public snapshot) gets the same pass: what Idiom does, how it works and why it helps, accurate to this release.

The current smoke pair is `previous_version="0.14.0"` and `version="0.15.0"`. When preparing the next release, advance both literals — the candidate becomes `version` and the newest released heading becomes `previous_version` — as part of the source commit. The published `v0.6.0` predates embedded provenance and prints a bare version; `v0.7.0` is the first release that prints `<version> (<short source commit>)`.

### Record the source, then commit the distribution

The embedded commit is the checkout HEAD **at build time**. A generated bundle cannot contain the hash of the later commit recording itself. Finish and commit every intended source, version, lockfile, and documentation change first (stage those paths explicitly, leaving `dist/cli.js` for the next commit). Start this sequence with a clean worktree:

```sh
build_source_commit="$(git rev-parse --verify HEAD)"
version="$(node -p "require('./package.json').version")"
expected_display="$version ($(printf '%s' "$build_source_commit" | cut -c1-7))"
```

Record that full source hash in the release record. Run the complete configured gate from this source commit, stopping if any command fails:

```sh
bun install --frozen-lockfile &&
bun run typecheck &&
bun run test &&
bun run lint &&
bun run build
```

`bun run test` builds before testing the packed payload. Confirm `node dist/cli.js --version` prints exactly `$expected_display`. Review the generated diff, then commit **only** the tracked bundle:

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

The tag and GitHub Release above live in the workshop repository. The public repository receives one commit per release, built from the public file set. `scripts/public-snapshot.mjs` excludes internal documents, `.agents/` skills and autobuild configuration; tracked portable `skills/`, `templates/` and `server.json` remain included. The script refuses to copy when any public file names a private product or contains a local path. It is not part of the snapshot.

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
  git push origin main "v${version}"
  gh release create "v${version}" --repo mattskilly/idiom --verify-tag \
    --title "Idiom v${version}" --notes-file "$release_notes"
)
```

Set `release_notes` to the extracted changelog body first (the extractor above). The first public release creates the repository with `gh repo create mattskilly/idiom --public` instead of cloning. Publishing the public GitHub Release starts `.github/workflows/publish.yml` in the public repository, which publishes to npm with [trusted publishing](https://docs.npmjs.com/trusted-publishers): GitHub's OIDC identity replaces an npm token or a local 2FA prompt, and npm attaches provenance. The workflow checks out the release tag, stops unless the tag, `package.json` and `server.json` versions agree, skips a version that is already on npm, and keeps `latest` on the newest version (an older version published later gets the `backport` dist-tag). It publishes exactly the `files` in `package.json` (the committed `dist/`, `templates/`, `skills/`, `server.json`, plugin and hooks); it does not rebuild, so the embedded build-source commit is the workshop commit recorded above. To publish an existing tag by hand, run `gh workflow run publish.yml --repo mattskilly/idiom -f tag=v<version>`. The workflow runs only in `mattskilly/idiom`. The package's trusted publisher on npmjs.com names user `mattskilly`, repository `idiom`, workflow `publish.yml` and environment `npm`. Confirm with `npm view @mattskilly/idiom version`. For registry publication, verify the exact release with `npm view @mattskilly/idiom@<version> version mcpName --json`, then follow [the separate registry and skill-listing handoff](distribution.md).

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
  expected_display="$version ($(printf '%s' "$build_source_commit" | cut -c1-7))"
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
    test "$resolved_bin" = "$BUN_INSTALL/install/global/node_modules/idiom/dist/cli.js"
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
  previous_version="0.14.0"
  version="0.15.0"
  expected_display="$version ($(printf '%s' "$build_source_commit" | cut -c1-7))"
  idiom_bin="$BUN_INSTALL/bin/idiom"

  if bun add -g "git+ssh://git@github.com/mattskilly/idiom.git#v${previous_version}"; then
    previous_display="$("$idiom_bin" --version)"
    previous_bare="${previous_display%% *}"
    printf 'Preceding display: %s; parsed version: %s\n' "$previous_display" "$previous_bare"
    if test -L "$idiom_bin" &&
      test "$previous_bare" = "$previous_version" &&
      test "$(realpath "$idiom_bin")" = \
        "$BUN_INSTALL/install/global/node_modules/idiom/dist/cli.js"; then
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
                "$BUN_INSTALL/install/global/node_modules/idiom/dist/cli.js"; then
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

# promote

Promote staging → main — pre-flight, version bump, changelog, deploy preview, PR, and tag.

## Why

Releasing to production involves a checklist: verify CI, bump the version, write a changelog, trigger a deploy preview, create a promotion PR, and tag the release. `/R-promote` automates this sequence with guard rails, so you don't accidentally promote with open PRs on staging or failing CI.

## Usage

```
/R-promote                  Full flow: pre-flight → version → changelog → preview → PR
/R-promote --skip-preview   Skip deploy preview step
/R-promote --dry-run        Show what would be promoted, create nothing
/R-promote --finalize       Post-merge: tag + GitHub Release (run after merging the promotion PR)
```

Triggers: `"promote staging"` | `"cut a release"` | `"--finalize"` | `"promote to production"` | `"tag and release"` | `"publish release"`

## How it works

1. **Pre-flight** — checks commits ahead of main, open PRs on staging, CI status. Refuses if nothing to promote.
1b. **Pin-swap** — detects `branch=` git deps in `[tool.uv.sources]`, resolves each to a release tag at the locked SHA, rewrites `pyproject.toml`, regenerates `uv.lock`. No-op if zero `branch=` git deps. Fails loud if SHA has no matching tag (forces upstream to cut a release first).
2. **Version + changelog** — bumps version, writes changelog (see `references/release-artifacts.md`).
3. **Deploy preview** (optional) — triggers `deploy-preview.yml` workflow and waits for it.
4. **Summary** — shows version, commit count, file count, CI status, preview result.
5. **Changelog commit** — creates a temp branch (if staging is protected), commits changelog, merges via PR.
6. **Promotion PR** — **forced** via `create-promote-pr.sh` (always harvests + injects Closes; refuses on degraded harvest unless `--allow-degraded`). No free-form `gh pr create` for promote. GitHub auto-closes listed issues when the promote merges into `main`.
7. **Post-merge reminder** — merge commit only, never squash (see `../shared/references/release-convention.md`).

## Finalize (`--finalize`)

After merging the promotion PR manually:

```
/R-promote --finalize
```

Verifies the merge, detects the version from CHANGELOG.md, creates a git tag, and publishes a GitHub Release.

## Safety

- Never force-pushes to `main` or `staging`
- Never auto-merges — user merges the PR after review
- Always warns about open PRs on staging before proceeding

## Chain position

Standalone — never auto-triggered by `/R-dev`. Run manually when ready to ship.

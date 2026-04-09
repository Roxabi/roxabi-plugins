# promote

Promote staging → main — pre-flight, version bump, changelog, deploy preview, PR, and tag.

## Why

Releasing to production involves a checklist: verify CI, bump the version, write a changelog, trigger a deploy preview, create a promotion PR, and tag the release. `/promote` automates this sequence with guard rails, so you don't accidentally promote with open PRs on staging or failing CI.

## Usage

```
/promote                  Full flow: pre-flight → version → changelog → preview → PR
/promote --skip-preview   Skip deploy preview step
/promote --dry-run        Show what would be promoted, create nothing
/promote --finalize       Post-merge: tag + GitHub Release (run after merging the promotion PR)
```

Triggers: `"promote staging"` | `"release"` | `"deploy"` | `"cut a release"` | `"merge to main"` | `"ship a release"` | `"tag and release"`

## How it works

1. **Pre-flight** — checks commits ahead of main, open PRs on staging, CI status. Refuses if nothing to promote.
2. **Version + changelog** — bumps version, writes changelog (see `references/release-artifacts.md`).
3. **Deploy preview** (optional) — triggers `deploy-preview.yml` workflow and waits for it.
4. **Summary** — shows version, commit count, file count, CI status, preview result.
5. **Changelog commit** — creates a temp branch (if staging is protected), commits changelog, merges via PR.
6. **Promotion PR** — `gh pr create --base main --head staging`.
7. **Post-merge reminder** — warns to use a **merge commit** (not squash) to avoid history divergence.

## Finalize (`--finalize`)

After merging the promotion PR manually:

```
/promote --finalize
```

Verifies the merge, detects the version from CHANGELOG.md, creates a git tag, and publishes a GitHub Release.

## Safety

- Never force-pushes to `main` or `staging`
- Never auto-merges — user merges the PR after review
- Always warns about open PRs on staging before proceeding

## Chain position

Standalone — never auto-triggered by `/dev`. Run manually when ready to ship.

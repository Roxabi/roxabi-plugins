---
name: promote
argument-hint: [--dry-run | --skip-preview | --finalize]
description: Promote staging→main — pre-flight, version bump, changelog, PR & tag. Triggers: "promote staging" | "release" | "deploy" | "cut a release" | "--finalize" | "merge to main" | "promote to production" | "ship a release" | "tag and release" | "publish release".
version: 0.4.0
allowed-tools: Bash, Read, Grep, Write, Edit, ToolSearch
---

# Promote

## Success

I₀ := PR created (staging→main) | I₁ := tag pushed + release created (--finalize)
V₀ := `gh pr list --base main --head staging --state open` | V₁ := `git tag -l $VERSION` ∧ `gh release view $VERSION`

Let: σ := staging | μ := main | V := release version (vX.Y.Z) | Q := DP(A)

σ → μ for production. Pre-flight → version → changelog → commit → preview → PR.
`--finalize`: post-merge tag + GitHub Release.

## Pipeline

| Step | ID | Required | Verifies via | Notes |
|------|----|----------|---------------|-------|
| 1 | pre-flight | ✓ | ¬REFUSE | — |
| 2 | version | ✓ | V detected | — |
| 3 | changelog | ✓ | CHANGELOG.md updated | — |
| 4 | commit | ✓ | `git log` shows commit | — |
| 5 | preview | — | deploy success | `--skip-preview` skips |
| 6 | summary | ✓ | summary printed | — |
| 6b | changelog-commit | — | PR merged → staging | branch protection |
| 7 | create-pr | ✓ | PR URL shown | — |
| 8 | post-merge | — | — | reminder |
| 9 | finalize | — | tag + release ∃ | `--finalize` only |

## Pre-flight

Success: PR created (promote) ∨ tag+release (finalize)
Evidence: PR URL shown ∨ `git tag -l $VERSION`
Steps: pre-flight → version → changelog → commit → preview → create-pr
¬clear → STOP + ask: "Full promote or --finalize?"

## Usage

```
/promote                   → Full flow
/promote --skip-preview    → Skip deploy preview
/promote --dry-run         → Show what would be promoted, create nothing
/promote --finalize        → Post-merge: tag + GitHub Release
```

## Step 1 — Pre-flight

```bash
bash ${CLAUDE_SKILL_DIR}/preflight.sh
```

Emits: `commits_ahead`, `status`, commit log, diff stat, open PRs on staging, CI check results.

| Check | Condition | Action |
|-------|-----------|--------|
| No commits | `commits_ahead=0` | **REFUSE.** Stop. |
| Open PRs on σ | open_prs section non-empty | **WARN** + Q: **Continue** \| **Wait** |
| CI status | ci section | **WARN** if ¬passing |

## Steps 2-4 — Version, Changelog, Commit

Read [references/release-artifacts.md](${CLAUDE_SKILL_DIR}/references/release-artifacts.md) for full procedure.

## Step 5 — Deploy Preview

¬`--skip-preview` ⇒

```bash
gh workflow run deploy-preview.yml --ref staging -f target=both
sleep 5
RUN_ID=$(gh run list --workflow=deploy-preview.yml --limit=1 --json databaseId --jq '.[0].databaseId')
gh run watch $RUN_ID --exit-status
```

Q: **Looks good — proceed** | **Issues — abort** | **Skip preview, proceed**

`--skip-preview` ⇒ skip.

## Step 6 — Summary

```
Promotion Summary
=================
  Version:   {$VERSION}
  Commits:   {N} commits ahead of main
  PRs:       {N} merged PRs
  Files:     {N} files changed
  CI:        passing/failing/pending
  Preview:   verified/skipped
```

`--dry-run` ⇒ display + stop. "Run `/promote` to create the promotion PR."

## Step 6b — Changelog Commit

σ may have branch protection. Direct push fails →
1. Branch: `git branch chore/$VERSION-changelog staging`
2. Push: `git push origin chore/$VERSION-changelog`
3. PR: `gh pr create --base staging --head chore/$VERSION-changelog --title "chore(release): add $VERSION changelog"`
4. Merge: `gh pr merge <N> --squash --delete-branch`
5. Sync: `git fetch origin staging && git reset --hard origin/staging`

## Step 7 — Create Promotion PR

```bash
gh pr create \
  --base main --head staging \
  --title "chore: promote staging to main ($VERSION)" \
  --body "$(cat <<EOF
## Promotion: staging → main ($VERSION)

{changelog}

## Pre-flight
- [x] CI passing on staging
- [x] No open PRs targeting staging (or acknowledged)
- [{preview_check}] Deploy preview verified
- [x] Release notes committed to staging

---
Generated with [Claude Code](https://claude.com/claude-code) via \`/promote\`
EOF
)"
```

Display PR URL.

## Step 8 — Post-merge Reminder

**CRITICAL: Use merge commit (not squash) for promotion PR.** Squash causes history divergence → conflicts + resurrected files on next promotion.

```
Promotion PR created: {URL}

⚠️  MERGE WITH MERGE COMMIT (not squash) to keep histories reconciled.

After merge:
  1. Vercel auto-deploys to production
  2. Verify production at your domain
  3. Run /promote --finalize to tag + create GitHub Release
  4. Run /cleanup to clean up merged branches
```

## Step 9 — Finalize (`--finalize` only)

Skip Steps 1-8. Post-merge only.

**9a.** Verify merge:
```bash
git fetch origin main && git checkout main && git pull origin main
gh pr list --base main --head staging --state merged --limit 1 --json number,title,mergedAt
```
¬merged → REFUSE: "Merge the promotion PR first."

**9b.** Detect V:
```bash
grep -oP '## \[\Kv[0-9]+\.[0-9]+\.[0-9]+' CHANGELOG.md | head -1
```
Q: **Use {detected}** | **Custom version**

**9c.** Tag:
```bash
git tag -l "$VERSION" | grep -q "$VERSION" && echo "Tag exists — abort" && exit 1
git tag -a "$VERSION" -m "Release $VERSION"
git push origin "$VERSION"
```

**9d.** Release:
```bash
gh release create "$VERSION" --title "$VERSION" --notes "$CHANGELOG_CONTENT"
```

Inform: "Release $VERSION finalized. Run `/cleanup` to clean branches."

## Options

| Flag | Description |
|------|-------------|
| (none) | Full flow: pre-flight → version → changelog → commit → preview → PR |
| `--skip-preview` | Skip deploy preview |
| `--dry-run` | Show summary + changelog, create nothing |
| `--finalize` | Post-merge: tag + GitHub Release |

## Edge Cases

| Scenario | Behavior |
|----------|----------|
| Nothing to promote | REFUSE: σ up to date with μ |
| Open PRs on σ | Warn, list, Q |
| CI failing | Warn, show failures, Q |
| Preview fails | Show error, Q |
| PR already exists | Detect via `gh pr list`, offer update |
| `--dry-run` | Summary only, ¬create PR/commit |
| ¬merged (`--finalize`) | REFUSE: merge first |
| Tag exists (`--finalize`) | REFUSE |
| Invalid version | REFUSE: ask for valid `vX.Y.Z` |

## Safety Rules

1. ¬force-push to μ ∨ σ
2. ¬auto-merge — user merges after review
3. Always show changelog before creating PR
4. Always check CI before promoting
5. Always warn about open PRs on σ
6. ¬push directly to μ — changelog reaches μ via promotion PR

## Chain Position

- **Phase:** Ship
- **Predecessor:** — (standalone, NOT auto-triggered by `/dev`)
- **Successor:** — (manual `--finalize` follow-up)
- **Class:** standalone (user explicitly invokes `/promote`, never chained from a feature pipeline)

## Task Integration

- `/dev` SKIPS this step by default (Step 4 skip logic: `promote → skip`)
- This skill does NOT participate in dev-pipeline tasks
- Sub-tasks created: none
- When invoked manually: runs without any `/dev`-owned task lifecycle

## Exit

- **Success standalone:** print PR URL + manual next step (`--finalize` after merge). Stop.
- **Failure:** return error to user. No `/dev` recovery path (standalone).

$ARGUMENTS

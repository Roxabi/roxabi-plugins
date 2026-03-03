---
name: promote
argument-hint: [--dry-run | --skip-preview | --finalize]
description: Promote staging→main — pre-flight, version bump, changelog, PR & tag. Triggers: "promote staging" | "release" | "deploy" | "cut a release" | "--finalize".
version: 0.2.0
allowed-tools: Bash, Read, Grep, Write, Edit
---

# Promote

`staging` → `main` for production. Pre-flight → version → changelog → commit → preview → PR.
`--finalize`: post-merge tag + GitHub Release.

## Usage

```
/promote                   → Full flow
/promote --skip-preview    → Skip deploy preview
/promote --dry-run         → Show what would be promoted, create nothing
/promote --finalize        → Post-merge: tag + GitHub Release
```

## Step 1 — Pre-flight

```bash
git fetch origin staging main
git checkout staging && git pull origin staging
git log main..staging --oneline
git diff main...staging --stat
gh pr list --base staging --state open --json number,title,headRefName
```

Guard rails:

| Check | Condition | Action |
|-------|-----------|--------|
| No commits | `git log main..staging` empty | **REFUSE.** Nothing to promote. Stop. |
| Open PRs on staging | `gh pr list --base staging` → results | **WARN** + AskUserQuestion: **Continue** \| **Wait** |
| CI status | Check latest staging commit | **WARN** if ¬passing |

CI check:
```bash
gh api repos/:owner/:repo/commits/staging/check-runs \
  --jq '[.check_runs[] | {name, conclusion}] | group_by(.conclusion) | map({conclusion: .[0].conclusion, count: length})'
```

## Steps 2–4 — Version, Changelog, Commit

Read [references/release-artifacts.md](references/release-artifacts.md) for full procedure.

## Step 5 — Deploy Preview

¬`--skip-preview` ⇒

```bash
gh workflow run deploy-preview.yml --ref staging -f target=both
sleep 5
RUN_ID=$(gh run list --workflow=deploy-preview.yml --limit=1 --json databaseId --jq '.[0].databaseId')
gh run watch $RUN_ID --exit-status
```

AskUserQuestion: **Looks good — proceed** | **Issues found — abort** | **Skip preview, proceed**

`--skip-preview` ⇒ skip entirely.

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

`--dry-run` ⇒ display summary + changelog, stop. Inform: "Run `/promote` to create the promotion PR."

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

Inform:
```
Promotion PR created: {URL}

After merge:
  1. Vercel auto-deploys to production
  2. Verify production at your domain
  3. Run /promote --finalize to tag + create GitHub Release
  4. Run /cleanup to clean up merged branches
```

## Step 9 — Finalize (`--finalize` only)

Skip Steps 1–8 entirely. Runs post-merge only.

**9a. Verify merge:**
```bash
git fetch origin main && git checkout main && git pull origin main
gh pr list --base main --head staging --state merged --limit 1 --json number,title,mergedAt
```
¬merged PR found ⇒ REFUSE: "Merge the promotion PR first."

**9b. Detect version:**
```bash
grep -oP '## \[\Kv[0-9]+\.[0-9]+\.[0-9]+' CHANGELOG.md | head -1
```
AskUserQuestion: **Use {detected version}** | **Custom version**

**9c. Tag:**
```bash
git tag -l "$VERSION" | grep -q "$VERSION" && echo "Tag exists — abort" && exit 1
git tag -a "$VERSION" -m "Release $VERSION"
git push origin "$VERSION"
```

**9d. Release:**
```bash
gh release create "$VERSION" --title "$VERSION" --notes "$CHANGELOG_CONTENT"
```

Inform: "Release $VERSION finalized: tag + GitHub Release created. Run `/cleanup` to clean up merged branches."

## Options

| Flag | Description |
|------|-------------|
| (none) | Full flow: pre-flight → version → changelog → commit → preview → PR |
| `--skip-preview` | Skip deploy preview |
| `--dry-run` | Show summary + changelog, create nothing |
| `--finalize` | Post-merge: tag + GitHub Release (changelog already deployed) |

## Edge Cases

| Scenario | Behavior |
|----------|----------|
| Nothing to promote | REFUSE: staging is up to date with main |
| Open PRs on staging | Warn, list, AskUserQuestion: continue or wait |
| CI failing | Warn, show failures, AskUserQuestion: proceed or fix |
| Deploy preview fails | Show error, AskUserQuestion: abort or proceed |
| Promotion PR already exists | Detect via `gh pr list --base main --head staging`, offer update |
| `--dry-run` | Show summary + changelog only, ¬create PR ∨ commit |
| ¬merged promotion PR (`--finalize`) | REFUSE: merge first |
| Tag already exists (`--finalize`) | REFUSE: tag exists |
| Invalid version | REFUSE: ask for valid `vX.Y.Z` |

## Safety Rules

1. ¬force-push to main ∨ staging
2. ¬auto-merge — user merges after review
3. Always show changelog before creating PR
4. Always check CI before promoting
5. Always warn about open PRs on staging
6. ¬push directly to main — changelog reaches main via promotion PR

$ARGUMENTS

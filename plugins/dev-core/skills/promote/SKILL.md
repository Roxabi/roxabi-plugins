---
name: promote
argument-hint: [--dry-run | --skip-preview | --finalize]
description: Promote staging→main — pre-flight, version bump, changelog, PR & tag. Triggers: "promote staging" | "release" | "deploy" | "cut a release" | "--finalize".
version: 0.1.0
allowed-tools: Bash, AskUserQuestion, Read, Grep, Write, Edit
---

# Promote

Promote `staging` to `main` for production deployment. Runs pre-flight checks, computes the version, generates changelog and release notes, commits them to staging, optionally triggers a deploy preview, and creates a staging→main PR. After merge, `--finalize` tags and creates a GitHub Release.

## Usage

```
/promote                   → Full promotion flow with preview verification
/promote --skip-preview    → Skip deploy preview, go straight to PR creation
/promote --dry-run         → Show what would be promoted without creating anything
/promote --finalize        → After merge: tag and create GitHub Release
```

## Instructions

### 1. Pre-flight Checks

Run all of these and collect the output:

```bash
# Ensure we're on staging and it's up to date
git fetch origin staging main
git checkout staging
git pull origin staging

# Commits on staging that aren't on main
git log main..staging --oneline

# Changed files summary
git diff main...staging --stat

# Check for open PRs targeting staging (unmerged work)
gh pr list --base staging --state open --json number,title,headRefName
```

**Guard rails:**

| Check | Condition | Action |
|-------|-----------|--------|
| **No commits ahead** | `git log main..staging` is empty | **REFUSE.** Nothing to promote. Stop. |
| **Open PRs targeting staging** | `gh pr list --base staging` returns results | **WARN.** Show the list and ask via `AskUserQuestion` whether to continue or wait. |
| **CI status on staging** | Check latest commit status | **WARN** if CI hasn't passed on the latest staging commit. |

Check CI status:

```bash
gh api repos/:owner/:repo/commits/staging/check-runs --jq '[.check_runs[] | {name, conclusion}] | group_by(.conclusion) | map({conclusion: .[0].conclusion, count: length})'
```

### 2–4. Version, Changelog, Commit

Read [references/release-artifacts.md](references/release-artifacts.md) for full procedure (version computation, changelog generation, CHANGELOG.md + Fumadocs page + meta.json updates, commit to staging).

### 5. Deploy Preview (unless `--skip-preview`)

If `--skip-preview` was NOT passed:

1. **Trigger the Deploy Preview workflow:**
   ```bash
   gh workflow run deploy-preview.yml --ref staging -f target=both
   ```

2. **Wait for completion** and present the preview URLs:
   ```bash
   # Get the latest run
   sleep 5
   RUN_ID=$(gh run list --workflow=deploy-preview.yml --limit=1 --json databaseId --jq '.[0].databaseId')
   gh run watch $RUN_ID --exit-status
   ```

3. **Ask the user to verify** via `AskUserQuestion`:
   - **Looks good, proceed** — Continue to PR creation
   - **Issues found, abort** — Stop the promotion
   - **Skip preview, proceed anyway** — Continue without verification

If `--skip-preview` was passed, skip this step entirely.

### 6. Present Summary

Show the full promotion summary before creating the PR:

```
Promotion Summary
=================
  Version:   {$VERSION}
  Commits:   {N} commits ahead of main
  PRs:       {N} merged PRs
  Files:     {N} files changed
  CI:        {passing/failing/pending}
  Preview:   {verified/skipped}

Changelog:
  {formatted changelog from step 3}
```

If `--dry-run` was passed, stop here. Show the summary and inform the user:

> "Dry run complete. Run `/promote` to create the promotion PR."

### 7. Create Promotion PR

```bash
gh pr create \
  --base main \
  --head staging \
  --title "chore: promote staging to main ($VERSION)" \
  --body "$(cat <<EOF
## Promotion: staging → main ($VERSION)

{changelog from step 3}

## Pre-flight
- [x] CI passing on staging
- [x] No open PRs targeting staging (or acknowledged)
- [{preview_check}] Deploy preview verified
- [x] Release notes committed to staging

---
Generated with [Claude Code](https://claude.com/claude-code) via `/promote`
EOF
)"
```

After creation, display the PR URL.

### 8. Post-merge Reminder

After the PR is created, inform the user:

> "Promotion PR created: {URL}
>
> After merge:
> 1. Vercel will auto-deploy to production (changelog and release notes included)
> 2. Verify production at your domain
> 3. Run `/promote --finalize` to tag the release and create the GitHub Release
> 4. Run `/cleanup` to clean up merged branches"

### 9. Finalize Release (`--finalize`)

**Only runs when `--finalize` is passed.** This step executes after the promotion PR has been merged. Skip steps 1–8 entirely.

`--finalize` only creates the git tag and GitHub Release. The changelog and release notes are already deployed (committed to staging in step 4, merged to main via the promotion PR).

#### 9a. Verify promotion PR was merged

```bash
git fetch origin main
git checkout main
git pull origin main

# Verify the latest promotion PR is merged
gh pr list --base main --head staging --state merged --limit 1 --json number,title,mergedAt
```

If no merged promotion PR is found, **REFUSE** and inform the user to merge the promotion PR first.

#### 9b. Detect version from CHANGELOG.md

Read the latest version from `CHANGELOG.md` (the first `## [vX.Y.Z]` entry):

```bash
grep -oP '## \[\Kv[0-9]+\.[0-9]+\.[0-9]+' CHANGELOG.md | head -1
```

Confirm the version with the user via `AskUserQuestion`:
- **Use {detected version}** (Recommended)
- **Custom version** — let user type a version

#### 9c. Create annotated git tag

Before tagging, check if the tag already exists (idempotency guard for repeated `--finalize` runs):

```bash
# Check if tag already exists
if git tag -l "$VERSION" | grep -q "$VERSION"; then
  echo "Tag $VERSION already exists. Aborting."
  exit 1
fi

git tag -a "$VERSION" -m "Release $VERSION"
git push origin "$VERSION"
```

#### 9d. Create GitHub Release

```bash
gh release create "$VERSION" --title "$VERSION" --notes "$CHANGELOG_CONTENT"
```

Use the same changelog content from `CHANGELOG.md` for the release notes.

Inform the user:

> "Release $VERSION finalized:
> - Git tag: $VERSION
> - GitHub Release: {URL}
> - CHANGELOG.md and docs page were already deployed with the promotion PR
>
> Run `/cleanup` to clean up merged branches."

## Options

| Flag | Description |
|------|-------------|
| (none) | Full flow: pre-flight → version → changelog → commit → preview → PR |
| `--skip-preview` | Skip deploy preview verification |
| `--dry-run` | Show what would be promoted without creating anything |
| `--finalize` | Post-merge: tag and create GitHub Release (changelog already deployed) |

## Edge Cases

| Scenario | Behavior |
|----------|----------|
| Nothing to promote | Refuse, inform user staging is up to date with main |
| Open PRs on staging | Warn, list them, ask user to proceed or wait |
| CI failing on staging | Warn, show failures, ask user to proceed or fix first |
| Deploy preview fails | Show error, ask user to abort or proceed anyway |
| Promotion PR already exists | Detect via `gh pr list --base main --head staging`, offer to update instead |
| `--dry-run` | Show summary and changelog, do not create PR or commit changelog |
| Promotion PR not merged (`--finalize`) | Refuse, tell user to merge the promotion PR first |
| No commits since last tag | Refuse, nothing to release |
| Tag already exists (`--finalize`) | Refuse, inform user the tag already exists |
| Invalid version format | Refuse, ask user to provide a valid `vX.Y.Z` version |

## Safety Rules

1. **NEVER force-push** to main or staging
2. **NEVER merge** the PR automatically — the user merges after review
3. **ALWAYS show the changelog** before creating the PR
4. **ALWAYS check CI status** before promoting
5. **ALWAYS warn about open PRs** targeting staging
6. **NEVER push directly to main** — changelog is committed to staging and reaches main via the promotion PR

$ARGUMENTS

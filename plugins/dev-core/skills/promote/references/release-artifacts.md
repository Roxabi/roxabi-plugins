# Release Artifacts — Version, Changelog, Commit

## Compute Version (Step 2)

Determine the next SemVer version based on commits since the last tag:

```bash
# Get latest tag (if any)
LATEST_TAG=$(git describe --tags --abbrev=0 2>/dev/null || echo "")

# Get commits since last tag (or all commits if no tag)
if [ -z "$LATEST_TAG" ]; then
  COMMITS=$(git log main..staging --oneline --format="%s")
else
  COMMITS=$(git log ${LATEST_TAG}..staging --oneline --format="%s")
fi
```

Version bump rules:
- If no tags exist → `v0.1.0`
- If any commit starts with `feat` → **minor** bump (e.g., `v0.1.0` → `v0.2.0`)
- If any commit contains `!:` (breaking) → **minor** bump while pre-1.0
- Otherwise → **patch** bump (e.g., `v0.1.0` → `v0.1.1`)

AskUserQuestion: **Use {computed version}** (Recommended) | **Custom version**.

Validate format:

```bash
if [[ ! "$VERSION" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "Invalid version format: $VERSION (expected vX.Y.Z)"
  exit 1
fi
```

If validation fails, ask user for valid version.

## Generate Changelog (Step 3)

Build changelog from all PRs merged to staging since last promotion:

```bash
# Find merge base
MERGE_BASE=$(git merge-base main staging)

# List merge commits (PRs) since merge base
git log $MERGE_BASE..staging --merges --oneline

# Or list all commits with PR references
git log $MERGE_BASE..staging --oneline --grep="(#"
```

Also fetch merged PRs via GitHub API:

```bash
SINCE=$(git log -1 --format="%aI" $MERGE_BASE)
gh pr list --base staging --state merged --json number,title,mergedAt,author,labels --jq "[.[] | select(.mergedAt > \"$SINCE\")]"
```

Format as changelog grouped by commit type (feat, fix, docs, chore, etc.). Include PR numbers and titles.

## Commit Changelog to Staging (Step 4)

### 4a. Update CHANGELOG.md

Prepend new release entry in [Keep a Changelog](https://keepachangelog.com/) format:

```markdown
## [$VERSION] - YYYY-MM-DD

### Added
- feat(web): add user profile page (#42)

### Fixed
- fix(api): resolve timeout on large queries (#43)

### Changed
- docs: update deployment guide (#44)
```

Use Edit tool to prepend after the header (after "Entries are generated automatically by `/promote` and committed to staging before the promotion PR.").

### 4b. Update Fumadocs changelog page (grouped by minor version)

Pages grouped by **minor version**: one page per `vX.Y` (e.g., `docs/changelog/v0-2.mdx`). Patch releases appended to existing minor page, newest first.

**∃ minor page** (e.g., releasing v0.2.2 and `docs/changelog/v0-2.mdx` exists):
1. Read existing page
2. Prepend new patch entry **after frontmatter**, before previous entries
3. Separate entries with `---`

**¬∃ minor page** (e.g., releasing v0.3.0):
1. Create `docs/changelog/vX-Y.mdx`
2. Add frontmatter + first entry

Page format:

```mdx
---
title: vX.Y.x
description: All vX.Y releases
---

## vX.Y.Z — Month DD, YYYY

### Features
- feat(web): add user profile page (#42)

### Fixes
- fix(api): resolve timeout on large queries (#43)

---

## vX.Y.0 — Month DD, YYYY

### Features
- feat(api): initial release (#1)
```

### 4c. Update docs/changelog/meta.json

Only update if **new minor page** created. Insert minor slug (e.g., `v0-3`) at **beginning** of `pages` array:

```json
{
  "title": "Changelog",
  "pages": ["v0-3", "v0-2", "v0-1-0", "index"]
}
```

Patch release → no meta.json change.

### 4d. Commit to staging

`git add CHANGELOG.md docs/changelog/` + commit per CLAUDE.md Rule 5.

> Commits to staging, not main. Release notes included in staging→main PR.

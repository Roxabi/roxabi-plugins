# Release Artifacts — Version, Changelog, Commit

Let: V := version | Δ := changelog entry

## Compute Version (Step 2)

`$VERSION` is a **pure derivation** — never typed, never guessed. The sole deriver is
[`price.sh`](../price.sh) (spec S2): component-scoped tag glob, **reachability-based** `BASE`,
payload `rev-list --no-merges ^BASE_SHA <heads>`, bump per D18. It is the *only* place a version is
computed; the PR title, CHANGELOG heading and version file are all **witnesses** of it, never sources.

### 2a. Resolve the component (guard)

```bash
COMPONENT=$(yq -r '.release.component // "null"' .claude/stack.yml 2>/dev/null \
  || python3 -c 'import yaml;print((yaml.safe_load(open(".claude/stack.yml")).get("release") or {}).get("component") or "null")')
```

`COMPONENT` is `null`/empty → **REFUSE** (S6/D13). Never fall back to a bare tag —
`null/v0.1.0` is silent and wrong. Print a paste-ready block (component = the newest `*/v*` tag prefix):

```yaml
release:
  class: NONE            # or PRODUCER / TRIGGER — see stack.yml.example
  component: <name>
  version_files: []
```

### 2b. Preview via price.sh

```bash
PREVIEW=$(bash "${CLAUDE_SKILL_DIR}/price.sh" "$COMPONENT" origin/main origin/main origin/staging); RC=$?
```

| `price.sh` exit | Meaning | Action |
|---|---|---|
| `0` | `$PREVIEW` = bare `X.Y.Z` | `VERSION="${COMPONENT}/v${PREVIEW}"` |
| `10` | no reachable tag = **first release** | `VERSION="${COMPONENT}/v0.1.0"`; if `git tag -l "${COMPONENT}/v*"` is **non-empty** (tags exist but unreachable), **warn** — a higher tag may live on a staging lineage |
| `≥1` other | git/arg error | **REFUSE** — never invent a version |

The preview is a **proposal**, not a decision. `Custom version` is **retained** as the escape hatch
for the multi-component repos `/promote` does not yet handle (factory, cortex); it is no longer
*required* on single-component repos.

→ present choice: **Use {VERSION}** (Recommended) | **Custom version**.

## Stamp Version Files (Step 2b)

Write the previewed version into every path in `release.version_files` **before** the promotion PR,
so each file becomes a witness of the derivation (S4/D12/D14).

```bash
FILES=$(yq -r '.release.version_files[]?' .claude/stack.yml 2>/dev/null \
  || python3 -c 'import yaml;[print(p) for p in ((yaml.safe_load(open(".claude/stack.yml")).get("release") or {}).get("version_files") or [])]')
```

- `version_files: []` → **no-op, green.** 9 of 14 repos ship this — a file that does not exist cannot drift.
- A listed path that is **missing** → **REFUSE** (config lies).
- Otherwise replace the version token in each file with `${PREVIEW}` (bare `X.Y.Z`, no tag prefix
  inside the file), and stage it alongside the changelog in Step 4.

> The stamp is intentionally pre-merge, so between step 2b and the post-merge tag the file is
> *legitimately ahead* of the newest tag — `release-consistency` (push path) fails only when a file
> is **behind** its tag, never ahead (D14).

## Generate Changelog (Step 3)

Build Δ from all PRs merged to staging since last promotion:

```bash
# Find merge base
MERGE_BASE=$(git merge-base main staging)

# List merge commits (PRs) since merge base
git log $MERGE_BASE..staging --merges --oneline

# Or list all commits with PR references
git log $MERGE_BASE..staging --oneline --grep="(#"
```

Fetch merged PRs via GitHub API:

```bash
SINCE=$(git log -1 --format="%aI" $MERGE_BASE)
gh pr list --base staging --state merged --json number,title,mergedAt,author,labels --jq "[.[] | select(.mergedAt > \"$SINCE\")]"
```

Format as Δ grouped by commit type (feat, fix, docs, chore, etc.). Include PR numbers + titles.

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

Use Edit to prepend after header (after "Entries are generated automatically by `/promote` and committed to staging before the promotion PR.").

### 4b. Update changelog page (grouped by minor V)

Pages grouped by **minor version**: one page per `vX.Y` (e.g., `docs/changelog/v0-2.md`). Patch releases appended to existing minor page, newest first.

Prefer `.md`. If only a legacy `.mdx` page exists for that minor, read it and write updates there (do not rename; do not create new `.mdx`).

**∃ minor page** (e.g., releasing v0.2.2 ∧ `docs/changelog/v0-2.md` ∃, or legacy `.mdx`):
1. Read existing page
2. Prepend new patch entry **after frontmatter**, before previous entries
3. Separate entries w/ `---`

**¬∃ minor page** (e.g., releasing v0.3.0):
1. Create `docs/changelog/vX-Y.md`
2. Add frontmatter + first entry

Page format:

```md
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


### 4d. Commit to staging

`git add CHANGELOG.md docs/changelog/` + commit per CLAUDE.md Rule 5.

> Commits to staging, ¬main. Release notes included in staging→main PR.

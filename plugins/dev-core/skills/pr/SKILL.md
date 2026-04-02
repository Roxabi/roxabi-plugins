---
name: pr
argument-hint: [--draft | --base <branch>]
description: Create/update PRs with Conventional Commits title, issue linking & guard rails. Triggers: "create PR" | "open PR" | "submit PR" | "update PR" | "/pr --draft" | "open a pull request" | "make a PR" | "open pull request" | "submit a pull request" | "create a draft PR" | "raise a PR".
version: 0.4.0
allowed-tools: Bash, Read, Grep, ToolSearch
---

# Pull Request

Let:
  β := `staging` (∃ origin/staging) ∨ `main`
  Β := current branch
  N := issue# (first number after `/` in Β)

Β → PR: Conventional Commits title, issue linking, guard rails.

**Flow: single continuous pipeline. ¬stop between steps. Stop only on: REFUSE, explicit Cancel, or Step 6 completion.**

## Step 1 — Gather State

```bash
BRANCH=$(git branch --show-current)
BASE=$(git branch -r | grep -q 'origin/staging' && echo staging || echo main)
git log ${BASE}..HEAD --oneline
git diff ${BASE}...HEAD --stat
gh pr list --head "$BRANCH" --json number,title,url,state
```

## Step 2 — Guard Rails

| Check | Condition | Action |
|-------|-----------|--------|
| Protected branch | Β ∈ {staging, main, master} | **REFUSE.** Create feature branch first. Stop. |
| No commits | `git log ${β}..HEAD` empty | **REFUSE.** Nothing to PR. Stop. |
| PR exists | gh pr list → result | → DP(A) **Update** (`gh pr edit`) \| **Cancel** |
| Branch not pushed | `git ls-remote --heads origin $BRANCH` empty | `git push -u origin $BRANCH` |
| Behind base | `git rev-list HEAD..${β} --count` > 0 | Warn + present decision via protocol: read `${CLAUDE_PLUGIN_ROOT}/../shared/references/decision-presentation.md` (Pattern A): **Continue** \| **Rebase first** |
| Quality gates | `{commands.lint} && {commands.typecheck}` | Warn on failure, ¬block. Note in PR body if proceeding. |

## Step 3 — Generate Content

**3a. Commits + diff:**
```bash
git log ${BASE}..HEAD --format="%h %s%n%b"
git diff ${BASE}...HEAD --stat
```

**3b. Lifecycle artifacts:**
```bash
ISSUE_NUM=$(echo "$BRANCH" | grep -oP '(?<=/)\d+')
ls artifacts/analyses/${ISSUE_NUM}-*.mdx 2>/dev/null
ls artifacts/specs/${ISSUE_NUM}-*.mdx 2>/dev/null
gh issue view "$ISSUE_NUM" --json title,state,labels 2>/dev/null
git diff ${BASE}...HEAD --name-only | grep -c '\.test\.\|\.spec\.' || echo 0
```

N detection: first number after `/` in Β (e.g. `feat/42-slug` → `#42`). ¬found → → DP(B) "Which issue number does this PR close, if any?"

**3c. Title:** `<type>(<scope>): <desc>` (≤70 chars). Type from primary commit purpose. Scope from files: `web | api | ui | config` ∨ omit if cross-cutting.

**3d. Body:** template below.

## Step 4 — Create + Update Issue

Show generated title + body → create immediately (¬ask how). `--draft` → draft.
Failure ∨ explicit edit request → → DP(A) **Edit title/body** | **Cancel**

```bash
gh pr create --title "<title>" --body "<body>" --base ${BASE} [--draft]
# --base <branch> if flag specified (overrides BASE)
```

Display PR URL. ∃ N →
```bash
bun ${CLAUDE_PLUGIN_ROOT}/skills/issue-triage/triage.ts set <ISSUE_NUMBER> --status Review
```

Updating existing PR → `gh pr edit <number> --title "<title>" --body "<body>"`.

## Step 5 — Watch CI

Inform: "CI is running on the PR — use `/ci-watch` to monitor it live."

## PR Body Template

```markdown
## Summary
- {what changed and why}
- {secondary change if applicable}

## Lifecycle

| Phase | Artifact | Status |
|-------|----------|--------|
| Intent | #{N}: {title} | {state} |
| Analysis | [{filename}](artifacts/analyses/{filename}) | Present/Absent |
| Spec | [{filename}](artifacts/specs/{filename}) | Present/Absent |
| Implementation | {N} commits on `{branch}` | Complete |
| Verification | Lint {✅/❌} Typecheck {✅/❌} Tests {✅/❌} ({N} new) | Passed/Failed |

## Test Plan
- [ ] {how to verify}
- [ ] {edge case}

Closes #{N}

---
Generated with [Claude Code](https://claude.com/claude-code) via `/pr`
```

Lifecycle notes: S-tier → Intent + Implementation + Verification only. ¬issue → omit Lifecycle + Closes.

## Options

| Flag | Description |
|------|-------------|
| (none) | Target auto-detected base branch |
| `--draft` | Create as draft |
| `--base <branch>` | Override base branch |

## Edge Cases

| Scenario | Behavior |
|----------|----------|
| Β ∈ {staging, main, master} | REFUSE: "Create a feature branch first" |
| ¬commits ahead | REFUSE: "Nothing to create a PR for" |
| PR already exists | Offer `gh pr edit` to update |
| ¬N in branch | → DP(B) link issue or skip |
| Multiple commit types | Use primary type only |
| Lint/typecheck fail | Warn + present decision via protocol: read `${CLAUDE_PLUGIN_ROOT}/../shared/references/decision-presentation.md` (Pattern A): **Proceed anyway** \| **Fix first** |

## Safety Rules

1. ¬PR from `staging`, `main`, `master`
2. ¬force-push
3. Always show PR content before creation
4. → DP(A)for all decisions (proceed despite warnings, edit)
5. Always display PR URL after creation

$ARGUMENTS

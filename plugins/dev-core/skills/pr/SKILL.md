---
name: pr
argument-hint: [--draft | --base <branch>]
description: Create/update PRs with Conventional Commits title, issue linking & guard rails. Triggers: "create PR" | "open PR" | "submit PR" | "update PR" | "/pr --draft".
version: 0.1.0
allowed-tools: Bash, Read, Grep
---

# Pull Request

Create or update a pull request with a consistent format, proper issue linking, and guard rails. Natural pair with `/commit`.

**⚠ Flow: single continuous pipeline. ¬stop between steps. AskUserQuestion response → immediately execute next step. Stop only on: explicit Cancel, REFUSE condition, or Step 6 completion.**

## Instructions

### 1. Gather State

Run all these commands and collect the output:

```bash
# Current branch
BRANCH=$(git branch --show-current)
echo "Branch: $BRANCH"

# All commits on this branch vs staging
git log staging..HEAD --oneline

# Changed files summary
git diff staging...HEAD --stat

# Check if PR already exists for this branch
gh pr list --head "$BRANCH" --json number,title,url,state
```

### 2. Guard Rails

Check each condition **before** proceeding:

| Check | Condition | Action |
|-------|-----------|--------|
| **Branch is staging/main/master** | `$BRANCH` is `staging`, `main`, or `master` | **REFUSE.** Tell user to create a feature branch first. Stop here. |
| **No commits ahead** | `git log staging..HEAD` is empty | **REFUSE.** Nothing to PR. Stop here. |
| **PR already exists** | `gh pr list` returned a result | Offer to **update** the existing PR description with `gh pr edit` instead of creating a new one. Use `AskUserQuestion` to confirm. |
| **Branch not pushed** | `git ls-remote --heads origin $BRANCH` is empty | Push with `git push -u origin $BRANCH` before creating PR. |
| **Behind staging** | `git rev-list HEAD..staging --count` > 0 | **Warn** the user that the branch is behind staging and suggest rebasing. Use `AskUserQuestion` to ask whether to continue anyway or rebase first. |
| **Quality gates** | Run `bun lint && bun typecheck` | **Warn** if failing but do NOT block. Show the output and note it in the PR body if user chooses to proceed. |

### 3. Generate PR Content

**Analyze ALL commits** on the branch (not just the latest) to understand the full scope of changes:

```bash
# Full commit messages
git log staging..HEAD --format="%h %s%n%b"

# Diff stat for scope
git diff staging...HEAD --stat
```

**Build lifecycle section** (gather artifacts linked to this PR):

```bash
# Extract issue number from branch name (e.g., feat/42-slug → 42)
ISSUE_NUM=$(echo "$BRANCH" | grep -oP '(?<=/)\d+')

# Check for analysis file
ls artifacts/analyses/${ISSUE_NUM}-*.mdx 2>/dev/null

# Check for spec file
ls artifacts/specs/${ISSUE_NUM}-*.mdx 2>/dev/null

# Get issue title + status (if issue exists)
gh issue view "$ISSUE_NUM" --json title,state,labels 2>/dev/null

# Count new test files in this branch
git diff staging...HEAD --name-only | grep -c '\.test\.\|\.spec\.' || echo 0

# Check lint + typecheck status (already run in guard rails)
```

For each artifact found, add a row to the lifecycle table. Omit rows for artifacts that don't exist (e.g., no spec for S-tier changes). See the PR Body Template below.

**Detect issue number** from the branch name:

- Branch `feat/42-user-auth` -> issue `#42`
- Branch `fix/15-login-timeout` -> issue `#15`
- Pattern: extract the first number after the `/` in the branch name
- If no issue number found, ask the user via `AskUserQuestion`

**Generate title** in Conventional Commits format:

- Analyze the commits to determine the primary type (`feat`, `fix`, `docs`, `refactor`, `chore`, `test`, `ci`, `perf`)
- Analyze the changed files to determine the scope (`web`, `api`, `ui`, `config`, or omit if cross-cutting)
- Format: `<type>(<scope>): <description>` (under 70 characters)
- The description should summarize what the PR accomplishes, not list individual commits

**Generate body** using the template below.

### 4. Create by Default

Show the generated title and body to the user, then **create the PR immediately** (unless `--draft` was passed, in which case create as draft).

Do NOT ask the user how they want to create it — just create it.

If creation fails or the user explicitly asks to edit before creating, use `AskUserQuestion` with options: **Edit title/body** / **Cancel**.

### 5. Create PR

```bash
# Standard PR (defaults to staging as base)
gh pr create --title "<title>" --body "<body>" --base staging

# If --draft flag or user chose "Create as Draft"
gh pr create --title "<title>" --body "<body>" --base staging --draft

# If --base flag specified (overrides default)
gh pr create --title "<title>" --body "<body>" --base <branch>
```

After creation, display the PR URL.

### 6. Update Issue Status to "Review"

If an issue number was detected (from the branch name or user input), move it to **Review** on the project board:

```bash
bun ${CLAUDE_PLUGIN_ROOT}/skills/issue-triage/triage.ts set <ISSUE_NUMBER> --status Review
```

Skip this step if no issue is associated with the PR.

If updating an existing PR instead:

```bash
gh pr edit <number> --title "<title>" --body "<body>"
```

## PR Body Template

```markdown
## Summary
- {bullet 1: what changed and why}
- {bullet 2: secondary change if applicable}
- {bullet 3: if needed}

## Lifecycle

| Phase | Artifact | Status |
|-------|----------|--------|
| Intent | #{issue_number}: {issue title} | {issue state} |
| Analysis | [{analysis filename}](artifacts/analyses/{filename}) | {Present/Absent} |
| Spec | [{spec filename}](artifacts/specs/{filename}) | {Present/Absent} |
| Implementation | {N} commits on `{branch}` | Complete |
| Verification | Lint {✅/❌} Typecheck {✅/❌} Tests {✅/❌} ({N} new) | {Passed/Failed} |

## Test Plan
- [ ] {how to verify the change works}
- [ ] {edge case to test}

Closes #{issue_number}

---
Generated with [Claude Code](https://claude.com/claude-code) via `/pr`
```

**Notes on the template:**

- Summary bullets should focus on **what** changed and **why**, not list commits
- **Lifecycle table:** Include only rows where artifacts exist. For S-tier changes (no spec/analysis), show only Intent + Implementation + Verification. Omit the entire Lifecycle section if there's no linked issue.
- Test Plan should have actionable items a reviewer can follow
- `Closes #XX` auto-links and auto-closes the issue on merge
- If no issue number was detected, omit the `Closes` line and the Lifecycle section

## Options

| Flag | Description |
|------|-------------|
| (none) | Create PR targeting `staging` (default branch) |
| `--draft` | Create as draft PR |
| `--base <branch>` | Target a specific base branch instead of `staging` |

## Edge Cases

- **Branch is staging/main/master:** Refuse immediately. Tell user: "Cannot create a PR from staging. Create a feature branch first: `git checkout -b feature/<issue>-<description>`"
- **No commits ahead of staging:** Refuse. Tell user: "No commits ahead of staging. Nothing to create a PR for."
- **PR already exists:** Offer to update the existing PR description with `gh pr edit`. Show the existing PR URL.
- **No issue number in branch name:** Ask the user via `AskUserQuestion` if they want to link an issue (provide issue number) or skip issue linking.
- **Multiple types of changes:** If commits span multiple types (e.g., feat + test + docs), use the primary type (the one representing the main purpose of the PR).
- **Lint/typecheck failures:** Show the failures as a warning, ask user whether to proceed or fix first. If proceeding, add a note in the PR body under Summary.

## Safety Rules

1. **NEVER create a PR from `staging`, `main`, or `master`**
2. **NEVER force-push** as part of this skill
3. **ALWAYS show the PR content** to the user when creating
4. **ALWAYS use `AskUserQuestion`** for decisions (proceed despite warnings, edit content, etc.)
5. **ALWAYS display the PR URL** after successful creation

$ARGUMENTS

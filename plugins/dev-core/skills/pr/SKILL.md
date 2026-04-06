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
bash ${CLAUDE_SKILL_DIR}/gather-state.sh
```

Emits: `branch`, `base`, commit log, diff stat, existing PR, issue number, lifecycle artifacts (analysis, spec), test file count.

## Step 2 — Guard Rails

| Check | Condition | Action |
|-------|-----------|--------|
| Protected branch | Β ∈ {staging, main, master} | **REFUSE.** Create feature branch first. Stop. |
| No commits | `git log ${β}..HEAD` empty | **REFUSE.** Nothing to PR. Stop. |
| PR exists | gh pr list → result | → DP(A) **Update** (`gh pr edit`) \| **Cancel** |
| Branch not pushed | `git ls-remote --heads origin $BRANCH` empty | `git push -u origin $BRANCH` |
| Quality gates | `{commands.lint} && {commands.typecheck}` | Warn on failure, ¬block. Note in PR body if proceeding. |

(Note: "behind base" is no longer a guard rail — Step 5 rebases post-create automatically.)

## Step 3 — Generate Content

**3a. Commits + diff:**
```bash
git log ${BASE}..HEAD --format="%h %s%n%b"
git diff ${BASE}...HEAD --stat
```

**3b. Lifecycle artifacts:** already emitted by Step 1 (`issue`, `analysis`, `spec`, `issue_data`, `test_files`).

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

## Step 5 — Rebase on Base (post-create)

After PR creation, rebase Β on latest β → force-push with lease → PR updates with current base.

```bash
git fetch origin ${BASE}
BEHIND=$(git rev-list HEAD..origin/${BASE} --count)
```

`BEHIND == 0` → skip rebase, skip push. Log: "Already up to date with origin/${BASE}."

`BEHIND > 0`:
```bash
git rebase origin/${BASE}
# On conflict: → DP(A) **Resolve manually then re-run /pr** | **Abort rebase** (`git rebase --abort`)
git push --force-with-lease origin ${BRANCH}
```

**Safety:** only `--force-with-lease` (not `--force`) — refuses push if remote moved unexpectedly. Only on the feature branch (Β ∉ {staging, main, master} is already enforced in Step 2).

**Why post-create:** ensures the PR reflects the latest base from the moment it lands, so reviewers see a minimal diff and CI runs against current base. Staging can move between branch creation and PR create — this step closes that gap.

## Step 6 — Watch CI

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
2. ¬`git push --force` — only `--force-with-lease`, and only during Step 5 rebase on feature branches
3. Always show PR content before creation
4. → DP(A) for all decisions (proceed despite warnings, edit)
5. Always display PR URL after creation
6. Rebase conflicts → abort + defer to user — ¬auto-resolve

## Chain Position

- **Phase:** Build
- **Predecessor:** `/implement` (worktree with commits)
- **Successor:** `/ci-watch`
- **Class:** adv (continuous flow, no gate)

## Task Integration

- `/dev` owns the dev-pipeline task lifecycle externally
- This skill does NOT update its own dev-pipeline task
- Sub-tasks created: none

## Exit

- **Success via `/dev`:** PR created + rebased + pushed → return control silently. ¬write summary. ¬ask user. ¬announce `/ci-watch`. `/dev` re-scans and advances.
- **Success standalone:** print PR URL + `Next: /ci-watch --pr {PR#}`. Stop.
- **Failure (REFUSE, rebase conflict, gh error):** return error. `/dev` presents Retry | Skip | Abort.

$ARGUMENTS

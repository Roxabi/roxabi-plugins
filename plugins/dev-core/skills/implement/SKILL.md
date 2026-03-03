---
name: implement
argument-hint: '[--issue <N> | --plan <path>]'
description: Execute plan — setup worktree, spawn agents, write code + tests. Triggers: "implement" | "build this" | "execute plan" | "start coding".
version: 0.1.0
allowed-tools: Bash, Read, Write, Edit, Glob, Grep, Task, Skill
---

# Implement

Plan → worktree → agents (test-first) → passing quality gate.

**⚠ Flow: single continuous pipeline. ¬stop between steps. AskUserQuestion response → immediately execute next step. Stop only on: explicit Cancel/Abort, or Step 6 completion.**

```
/implement --issue 42        Execute plan for issue #42
/implement --plan artifacts/plans/42-dark-mode-plan.mdx   Execute from explicit plan path
```

Does NOT create a PR — that is `/pr` (next step).

## Pipeline

| Step | ID | Required | Notes |
|------|----|----------|-------|
| 1 | locate-plan | ✓ | — |
| 2 | setup | ✓ | rollback on failure |
| 3 | context-inject | — | tier F only |
| 4 | implement | ✓ | parallel: conditional, retry 3 |
| 5 | quality-gate | ✓ | retry 3, rollback on failure |
| 6 | summary | ✓ | — |

## Step 1 — Locate Plan

`--issue N` → `ls artifacts/plans/N-*.mdx` → read full → extract tasks, agents, tier, slug.
`--plan <path>` → read directly.
¬found ⇒ suggest `/plan`. **Stop.**

**S-tier exception:** τ == S ∧ ¬plan found ⇒ locate spec (`ls artifacts/specs/N-*.mdx`) or issue body (`gh issue view N --json body`). Skip to [Step 4 — Implement (Tier S)](#tier-s--direct). ¬require plan for S-tier.

Extract from plan frontmatter: `issue`, `tier`, `spec` path. Extract from body: agent list, task list, slice structure.

## Step 2 — Setup

**2a. Issue check:** `gh issue view <N>` — ¬∃ ⇒ draft + AskUserQuestion (Create|Edit|Skip) + `gh issue create`.

**2b. Repo + base branch:**

```bash
REPO=$(gh repo view --json name --jq '.name')
BASE=$(git branch -r | grep -q 'origin/staging' && echo staging || echo main)
```

Worktree dir: `../${REPO}-<N>`. Branch base: `${BASE}`.

**2c. Status:**

```bash
bun ${CLAUDE_PLUGIN_ROOT}/skills/issue-triage/triage.ts set <N> --status "In Progress"
```

**2d. Pre-flight:**

```bash
git branch --list "feat/<N>-*"
ls -d ../${REPO}-<N> 2>/dev/null
git fetch origin ${BASE}
```

∃ branch ⇒ AskUserQuestion: Reuse | Recreate | Abort

∃ worktree at `../${REPO}-<N>` ⇒ check dirty state:
```bash
cd ../${REPO}-<N> && git status --porcelain
```
¬empty ⇒ AskUserQuestion: **Stash changes** (`git stash`) | **Reset** (`git checkout .`) | **Continue with dirty state** | **Abort**

**2e. Worktree:**

```bash
git worktree add ../${REPO}-<N> -b feat/<N>-<slug> ${BASE}
cd ../${REPO}-<N> && cp .env.example .env 2>/dev/null; {package_manager} install
# Optional: {commands.worktree_setup} <N>  (configure in stack.yml for DB branch creation etc.)
```

XS exception: AskUserQuestion → if approved, `git checkout -b feat/<N>-<slug> ${BASE}`.

## Step 3 — Context Injection (Tier F only)

∀ agent: inject read instructions in Task prompt. Section headers only (¬numeric prefixes).

Template: "Read `{doc}` sections: {sections}. Read `{ref_file}` for conventions."

| Agent | Standards → Sections | +ref |
|-------|---------------------|:---:|
| frontend-dev | frontend-patterns: Component Patterns, AI Quick Ref · testing: FE Testing | ✓ |
| backend-dev | backend-patterns: Design Patterns, Error Handling, AI Quick Ref · testing: BE Testing | ✓ |
| tester | testing: Test Structure (AAA), Coverage, Mocking, AI-Assisted TDD | ✓ |
| architect | frontend-patterns + backend-patterns: AI Quick Ref | ✗ |
| devops, security-auditor, doc-writer | ∅ | ✗ |

Reference file paths come from `/plan` Step 3 (ref patterns). Inject the 1-2 ref files stored there.

## Step 4 — Implement

### Tier S — Direct

Read spec + ref patterns → create + implement → tests → `{commands.lint} && {commands.typecheck} && {commands.test}` → loop until ✓. Single session, no agent spawning.

### Tier F — Agent-Driven (test-first)

Spawn via `Task` (subagent/domain). Sequential ∨ parallel (2-3 max).

**RED → GREEN → REFACTOR:**

1. **RED** — tester: write failing tests from spec. Structural verify only (grep test structure). Tests expected to fail pre-impl. Create RED-GATE sentinel per slice.
2. **GREEN** — domain agents in parallel: implement to pass. `ready` verify → run now; `deferred` → wait RED-GATE.
3. **REFACTOR** — domain agents: refactor, keep tests ✓.
4. **Verify** — tester: coverage + edge cases.

**Per-task:** verify → ✓ | ✗ fix (max 3) | 3✗ → escalate to lead. Track first-try pass rate.

Agents create files from scratch (¬stubs). Include target path, shape/skeleton, ref pattern file in each Task prompt.

## Step 5 — Quality Gate

```bash
cd ../${REPO}-<N>
{commands.lint} && {commands.typecheck} && {commands.test}
```

✓ → continue to Step 6.
✗ → fix loop (max 3 attempts). Spawn domain fixer agents as needed. 3✗ → AskUserQuestion: **Escalate to lead** | **Continue with failures** | **Abandon worktree** (removes worktree + branch).

## Step 6 — Summary

```
Implement Complete
  Issue:    #N — title
  Branch:   feat/N-slug
  Worktree: ../${REPO}-N
  Tier:     S|F-lite|F-full
  Agents:   list
  Files:    created/modified list
  Verify:   N/total first-try (%)
  Next:     /pr → /review → /1b1 → merge
```

## Rollback

```bash
REPO=$(gh repo view --json name --jq '.name')
git worktree remove ../${REPO}-<N>
git branch -D feat/<N>-<slug>
# Optional: {commands.worktree_teardown} <N>
```

## Edge Cases

Read [references/edge-cases.md](references/edge-cases.md).

| Merge conflict (worktree setup) | `git rebase --abort` → AskUserQuestion: **Resolve manually** (fix conflicts → `git rebase --continue`) \| **Abort** |
| Abandon after 3✗ gate failures | `git worktree remove ../${REPO}-<N> --force && git branch -D feat/<N>-<slug>` |

## Safety

1. ¬`git add -A` ∨ `git add .` — specific files only
2. ¬push without PR via `/pr`
3. ¬create issue without user approval
4. Always worktree (XS exception w/ explicit lead approval)
5. Always HEREDOC for commit messages
6. Pre-commit hook failure → fix, re-stage, NEW commit (¬amend)

$ARGUMENTS

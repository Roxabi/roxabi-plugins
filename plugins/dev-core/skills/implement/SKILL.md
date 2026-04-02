---
name: implement
argument-hint: '[--issue <N> | --plan <path> | --audit]'
description: Execute plan — setup worktree, spawn agents, write code + tests. Triggers: "implement" | "build this" | "execute plan" | "start coding".
version: 0.2.0
allowed-tools: Bash, Read, Write, Edit, Glob, Grep, EnterWorktree, ExitWorktree, Task, Skill, ToolSearch
---

# Implement

Let:
  π := artifacts/plans/{N}-{slug}.mdx
  τ := tier (S | F-lite | F-full)
  ω := worktree (managed via EnterWorktree/ExitWorktree)
  β := base branch (staging if ∃ origin/staging, else main)
  QG := `{commands.lint} && {commands.typecheck} && {commands.test}`

Plan → ω → agents (test-first) → passing QG.

**Flow: single continuous pipeline. ¬stop between steps. Decision response → immediately execute next step. Stop only on: explicit Cancel/Abort or Step 6 completion.**

```
/implement --issue 42        Execute plan for issue #42
/implement --plan artifacts/plans/42-dark-mode-plan.mdx   Execute from explicit plan path
/implement --issue 42 --audit   Show reasoning checkpoint before coding
```

Does NOT create a PR — that is `/pr` (next step).

## Pipeline

| Step | ID | Required | Notes |
|------|----|----------|-------|
| 1 | locate-plan | ✓ | — |
| 2 | setup | ✓ | rollback on failure |
| 3 | context-inject | — | τ=F only |
| 4 | implement | ✓ | parallel: conditional, retry 3 |
| 5 | quality-gate | ✓ | retry 3, rollback on failure |
| 6 | summary | ✓ | — |

## Step 1 — Locate Plan

`--issue N` → `ls artifacts/plans/N-*.mdx` → read full → extract tasks, agents, τ, slug.
`--plan <path>` → read directly.
¬found ⇒ suggest `/plan`. **Stop.**

**S-tier exception:** τ=S ∧ ¬π → locate spec (`ls artifacts/specs/N-*.mdx`) or issue body (`gh issue view N --json body`). Skip to Step 4 (Tier S). ¬require π for τ=S.

Extract from frontmatter: `issue`, `tier`, `spec` path. From body: agent list, task list, slice structure.

## Step 2 — Setup

**2a. Issue check:** `gh issue view <N>` — ∄ ⇒ draft + present decision via protocol: read `${CLAUDE_PLUGIN_ROOT}/../shared/references/decision-presentation.md` (Pattern A): **Create** | **Edit** | **Skip** + `gh issue create`.

**2b. Repo + β:**

```bash
REPO=$(gh repo view --json name --jq '.name')
BASE=$(git branch -r | grep -q 'origin/staging' && echo staging || echo main)
```

ω: `.claude/worktrees/{N}-{slug}` (via EnterWorktree). Branch base: `${BASE}`.

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

∃ branch ⇒ Present decision via protocol: read `${CLAUDE_PLUGIN_ROOT}/../shared/references/decision-presentation.md` (Pattern A): **Reuse** | **Recreate** | **Abort**

∃ ω → check dirty state:
```bash
git status --porcelain
```
¬empty ⇒ Present decision via protocol: read `${CLAUDE_PLUGIN_ROOT}/../shared/references/decision-presentation.md` (Pattern A): **Stash changes** (`git stash`) | **Reset** (`git checkout .`) | **Continue with dirty state** | **Abort**

**2e. Worktree:**

```
EnterWorktree(name: "{N}-{slug}")
```

Inside ω:
```bash
git checkout -b feat/<N>-<slug> origin/${BASE}
cp .env.example .env 2>/dev/null; {package_manager} install
# Optional: {commands.worktree_setup} <N>
```

XS exception: Present decision via protocol: read `${CLAUDE_PLUGIN_ROOT}/../shared/references/decision-presentation.md` (Pattern A): **Skip worktree (XS exception)** | **Use worktree** → approved → skip ω, `git checkout -b feat/<N>-<slug> ${BASE}` in main repo.

## Step 3 — Context Injection (τ=F only)

∀ agent: inject read instructions in Task prompt. Section headers only (¬numeric prefixes).

Template: "Read `{doc}` sections: {sections}. Read `{ref_file}` for conventions."

| Agent | Standards → Sections | +ref |
|-------|---------------------|:---:|
| frontend-dev | frontend-patterns: Component Patterns, AI Quick Ref · testing: FE Testing | ✓ |
| backend-dev | backend-patterns: Design Patterns, Error Handling, AI Quick Ref · testing: BE Testing | ✓ |
| tester | testing: Test Structure (AAA), Coverage, Mocking, AI-Assisted TDD | ✓ |
| architect | frontend-patterns + backend-patterns: AI Quick Ref | ✗ |
| devops, security-auditor, doc-writer | ∅ | ✗ |

Ref file paths from `/plan` Step 3.

## Step 3b — Reasoning Audit (optional)

`--audit` → present reasoning audit per [reasoning-audit.md](${CLAUDE_PLUGIN_ROOT}/skills/shared/references/reasoning-audit.md). Read π/spec in full first.
→ Present decision via protocol: read `${CLAUDE_PLUGIN_ROOT}/../shared/references/decision-presentation.md` (Pattern A): **Proceed** | **Adjust approach** | **Abort**
¬`--audit` → skip to Step 4.

## Step 4 — Implement

### Tier S — Direct

Read spec + ref patterns → create + implement → tests → QG → loop until ✓. Single session, ¬agent spawning.

### Tier F — Agent-Driven (test-first)

Spawn via `Task` (subagent/domain). Sequential ∨ parallel (2–3 max).

**RED → GREEN → REFACTOR:**
1. **RED** — tester: write failing tests from spec. Structural verify only (grep test structure). Tests expected to fail pre-impl. Create RED-GATE sentinel per slice.
2. **GREEN** — domain agents ∥: implement to pass. `ready` verify → run now; `deferred` → wait RED-GATE.
3. **REFACTOR** — domain agents: refactor, keep tests ✓.
4. **Verify** — tester: coverage + edge cases.

**Per-task:** verify → ✓ | ✗ fix (max 3) | 3✗ → escalate to lead. Track first-try pass rate.

Agents create files from scratch (¬stubs). Include target path, shape/skeleton, ref pattern file in each Task prompt.

## Step 5 — Quality Gate

Run QG inside ω (session already in ω after EnterWorktree):

```bash
{commands.lint} && {commands.typecheck} && {commands.test}
```

✓ → Step 6.
✗ → fix loop (max 3). Spawn domain fixer agents as needed. 3✗ → Present decision via protocol: read `${CLAUDE_PLUGIN_ROOT}/../shared/references/decision-presentation.md` (Pattern A): **Escalate to lead** | **Continue with failures** | **Abandon ω** (`ExitWorktree(action: "remove")` + delete branch).

## Step 6 — Summary

```
Implement Complete
  Issue:    #N — title
  Branch:   feat/N-slug
  Worktree: .claude/worktrees/{N}-{slug}
  Tier:     S|F-lite|F-full
  Agents:   list
  Files:    created/modified list
  Verify:   N/total first-try (%)
  Next:     /pr → /code-review → /1b1 → merge
```

## Rollback

```
ExitWorktree(action: "remove", discard_changes: true)
```

```bash
git branch -D feat/<N>-<slug>
# Optional: {commands.worktree_teardown} <N>
```

## Edge Cases

Read [references/edge-cases.md](${CLAUDE_SKILL_DIR}/references/edge-cases.md).

| Merge conflict (ω setup) | `git rebase --abort` → present decision via protocol: read `${CLAUDE_PLUGIN_ROOT}/../shared/references/decision-presentation.md` (Pattern A): **Resolve manually** (fix conflicts → `git rebase --continue`) \| **Abort** |
| Abandon after 3✗ gate failures | `ExitWorktree(action: "remove", discard_changes: true)` then `git branch -D feat/<N>-<slug>` |

## Safety

1. ¬`git add -A` ∨ `git add .` — specific files only
2. ¬push without PR via `/pr`
3. ¬create issue without user approval
4. Always ω (XS exception w/ explicit lead approval)
5. Always HEREDOC for commit messages
6. Pre-commit hook failure → fix, re-stage, NEW commit (¬amend)

$ARGUMENTS

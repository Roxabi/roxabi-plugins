---
name: implement
argument-hint: '[--issue <N> | --plan <path>]'
description: Execute plan — setup worktree, spawn agents, write code + tests. Triggers: "implement" | "build this" | "execute plan" | "start coding".
version: 0.1.0
allowed-tools: Bash, AskUserQuestion, Read, Write, Edit, Glob, Grep, Task, Skill
---

# Implement

Plan → worktree → agents (test-first) → passing quality gate.

**⚠ Flow: single continuous pipeline. ¬stop between steps. AskUserQuestion response → immediately execute next step. Stop only on: explicit Cancel/Abort, or Step 6 completion.**

```
/implement --issue 42        Execute plan for issue #42
/implement --plan artifacts/plans/42-dark-mode.mdx   Execute from explicit plan path
```

Does NOT create a PR — that is `/pr` (next step).

## Step 1 — Locate Plan

`--issue N` → `ls artifacts/plans/N-*.mdx` → read full → extract tasks, agents, tier, slug.
`--plan <path>` → read directly.
¬found ⇒ suggest `/plan`. **Stop.**

**S-tier exception:** τ == S ∧ ¬plan found ⇒ locate spec (`ls artifacts/specs/N-*.mdx`) or issue body (`gh issue view N --json body`). Skip to [Step 4 — Implement (Tier S)](#tier-s--direct). ¬require plan for S-tier.

Extract from plan frontmatter: `issue`, `tier`, `spec` path. Extract from body: agent list, task list, slice structure.

## Step 2 — Setup

**2a. Issue check:** `gh issue view <N>` — ¬∃ ⇒ draft + AskUserQuestion (Create|Edit|Skip) + `gh issue create`.

**2b. Status:**

```bash
bun ${CLAUDE_PLUGIN_ROOT}/skills/issue-triage/triage.ts set <N> --status "In Progress"
```

**2c. Pre-flight:**

```bash
git branch --list "feat/<N>-*"
ls -d ../roxabi-<N> 2>/dev/null
git fetch origin staging
```

∃ branch ⇒ AskUserQuestion: Reuse | Recreate | Abort

∃ worktree at `../roxabi-<N>` ⇒ check dirty state:
```bash
cd ../roxabi-<N> && git status --porcelain
```
¬empty ⇒ AskUserQuestion: **Stash changes** (`git stash`) | **Reset** (`git checkout .`) | **Continue with dirty state** | **Abort**

**2d. Worktree:**

```bash
git worktree add ../roxabi-<N> -b feat/<N>-<slug> staging
cd ../roxabi-<N> && cp .env.example .env && bun install
cd apps/api && bun run db:branch:create --force <N>
```

XS exception: AskUserQuestion → if approved, `git checkout -b feat/<N>-<slug> staging`.

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

Read spec + ref patterns → create + implement → tests → `bun lint && bun typecheck && bun run test` → loop until ✓. Single session, no agent spawning.

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
cd ../roxabi-<N>
bun lint && bun typecheck && bun run test
```

✓ → continue to Step 6.
✗ → fix loop (max 3 attempts). Spawn domain fixer agents as needed. 3✗ → AskUserQuestion: **Escalate to lead** | **Continue with failures**.

## Step 6 — Summary

```
Implement Complete
  Issue:    #N — title
  Branch:   feat/N-slug
  Worktree: ../roxabi-N
  Tier:     S|F-lite|F-full
  Agents:   list
  Files:    created/modified list
  Verify:   N/total first-try (%)
  Next:     /pr → /review → /1b1 → merge
```

## Rollback

```bash
cd ../roxabi_boilerplate
git worktree remove ../roxabi-<N>
git branch -D feat/<N>-<slug>
```

## Edge Cases

Read [references/edge-cases.md](references/edge-cases.md).

## Safety

1. ¬`git add -A` ∨ `git add .` — specific files only
2. ¬push without PR via `/pr`
3. ¬create issue without user approval
4. Always worktree (XS exception w/ explicit lead approval)
5. Always HEREDOC for commit messages
6. Pre-commit hook failure → fix, re-stage, NEW commit (¬amend)

$ARGUMENTS

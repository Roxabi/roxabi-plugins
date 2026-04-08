---
name: implement
argument-hint: '[--issue <N> | --plan <path> | --audit]'
description: Execute plan — setup worktree, spawn agents, write code + tests. Triggers: "implement" | "build this" | "execute plan" | "start coding" | "write the code" | "code this up" | "let's build it" | "build it out" | "ship it".
version: 0.2.0
allowed-tools: Bash, Read, Write, Edit, Glob, Grep, EnterWorktree, ExitWorktree, Task, TaskCreate, TaskUpdate, TaskList, TaskGet, Skill, ToolSearch
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

## Chain Position

- **Phase:** Build
- **Predecessor:** `/plan` (artifact: `artifacts/plans/{N}-{slug}-plan.mdx`)
- **Successor:** `/pr`
- **Class:** adv (continuous flow, no gate)

## Task Integration

- `/dev` owns the dev-pipeline task lifecycle externally (TaskUpdate in_progress before invoke, completed after return)
- This skill does NOT update its own dev-pipeline task
- Sub-tasks managed: reads plan-tasks created by `/plan` (Step 6a), flips their lifecycle as agents execute them (Step 1b + Step 4)

## Exit

- **Success via `/dev`:** return control silently. ¬write summary. ¬ask user. ¬announce `/pr`. `/dev` re-scans and advances.
- **Success standalone:** print final status block (below) + `Next: /pr`. Stop.
- **Failure:** return error. `/dev` presents Retry | Skip | Abort.

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

### Step 1b — Attach to Plan Tasks

Parse π's `## Task IDs` section → {T1: id, T2: id, ...} map. ¬section → `/plan` pre-dates task-tool integration → fall through to 1b.3 (re-seed).

**1b.1 Verify ids:** ∀ id → `TaskGet(id)`. All succeed → cache map, goto Step 2.
**1b.2 Partial miss:** ¬some id (session restart invalidated state) → re-seed only the missing ones by running Step 6a logic from `/plan` on the corresponding micro-tasks, then rewrite `## Task IDs` section in π with refreshed ids.
**1b.3 Total miss (legacy plan):** section absent → run Step 6a from `/plan` for every micro-task, append `## Task IDs` section to π, commit the update (`git add` π + commit `chore(plan): attach task ids`).

τ=S without π → `TaskCreate` 3–6 coarse tasks directly from spec acceptance criteria: `{ kind: "plan-task", issue: N, tier: "S" }`. No artifact update.

## Step 2 — Setup

**2a. Issue check:** `gh issue view <N>` — ∄ ⇒ draft + present decision via protocol: read `${CLAUDE_PLUGIN_ROOT}/../shared/references/decision-presentation.md` (Pattern A): **Create** | **Edit** | **Skip** + `gh issue create`.

**2b+2d. Repo, base + pre-flight:**

```bash
bash ${CLAUDE_SKILL_DIR}/setup-preflight.sh {N} {slug}
```

Emits: `repo`, `base`, `branch_exists`, `legacy_worktree`, `worktree`, `dirty` (if worktree found), `fetch`.

ω: `.claude/worktrees/{N}-{slug}` (via EnterWorktree). Branch base: `base` from output.

**2c. Status:**

```bash
bun ${CLAUDE_PLUGIN_ROOT}/skills/issue-triage/triage.ts set <N> --status "In Progress"
```

`branch_exists` ≠ false ⇒ → DP(A) **Reuse** | **Recreate** | **Abort**

`worktree` ≠ false ∧ `dirty=true` ⇒ → DP(A) **Stash changes** (`git stash`) | **Reset** (`git checkout .`) | **Continue with dirty state** | **Abort**

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

XS exception: → DP(A) **Skip worktree (XS exception)** | **Use worktree** → approved → skip ω, `git checkout -b feat/<N>-<slug> ${BASE}` in main repo.

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
→ → DP(A) **Proceed** | **Adjust approach** | **Abort**
¬`--audit` → skip to Step 4.

## Step 4 — Implement

**Task lifecycle (all tiers):**
- Before starting a micro-task → `TaskUpdate(id, status: "in_progress", owner: "{agent-name or 'lead'}")`.
- Success (verify ✓) → `TaskUpdate(id, status: "completed")`.
- Retry (≤3) → leave `in_progress`, add comment via `TaskUpdate(id, metadata: { last_error: "..." })`.
- 3× fail → leave `in_progress`, escalation decision (see Step 5).

### Tier S — Direct

Read spec + ref patterns → create + implement → tests → QG → loop until ✓. Single session, ¬agent spawning. Flip each task `in_progress` → `completed` as you progress through the list.

### Tier F — Agent-Driven (test-first)

Spawn via `Task` tool (subagent/domain). Sequential ∨ parallel (2–3 max).

**Per agent spawn:**
1. `TaskUpdate(task_id, status: "in_progress", owner: "{agent}")`.
2. `TaskGet(task_id)` → inject `description` + `metadata` verbatim into the subagent's prompt. The agent reads its own task context from the task list.
3. Spawn:
   ```
   Task(
     subagent_type: "dev-core:{agent}",
     description: "{agent}: {phase} — #{N} {slug}",
     prompt: "Issue #{N}. Task: {TaskGet.description}. Target: {file_path}. Skeleton: {code_snippet}. Verify: {verify_command}. Ref pattern: {pattern_file}. ¬TaskCreate — task lifecycle managed by lead."
   )
   ```
   Agent name map: `tester` → `dev-core:tester` | `frontend-dev` → `dev-core:frontend-dev` | `backend-dev` → `dev-core:backend-dev` | `devops` → `dev-core:devops` | `doc-writer` → `dev-core:doc-writer` | `architect` → `dev-core:architect` | `security-auditor` → `dev-core:security-auditor`
4. Subagent returns → verify → ✓ → `TaskUpdate(task_id, status: "completed")`. ✗ → retry (≤3).

**RED → GREEN → REFACTOR:**
1. **RED** — tester: write failing tests from spec. Structural verify only (grep test structure). Tests expected to fail pre-impl. Create RED-GATE sentinel per slice. RED tasks flip `completed` as each test file lands.
2. **GREEN** — domain agents ∥: implement to pass. `ready` verify → run now; `deferred` → wait RED-GATE. Blocked-by wiring from Step 6a/6b of `/plan` means task list already reflects these dependencies — advance in `blockedBy`-clear order.
3. **REFACTOR** — domain agents: refactor, keep tests ✓.
4. **Verify** — tester: coverage + edge cases.

**Parallel spawn:** `TaskList` → pick N tasks with empty `blockedBy` and matching phase → spawn N agents simultaneously, each with its own `TaskGet`-injected prompt.

**Per-task:** verify → ✓ | ✗ fix (max 3) | 3✗ → escalate to lead. Track first-try pass rate.

Agents create files from scratch (¬stubs). Include target path, shape/skeleton, ref pattern file in each Task prompt (in addition to `TaskGet` content).

## Step 5 — Quality Gate

Run QG inside ω (session already in ω after EnterWorktree):

```bash
{commands.lint} && {commands.typecheck} && {commands.test}
```

✓ → Step 6.
✗ → fix loop (max 3). Spawn domain fixer agents as needed. 3✗ → → DP(A) **Escalate to lead** | **Continue with failures** | **Abandon ω** (`ExitWorktree(action: "remove")` + delete branch).

## Step 6 — Summary

Before printing summary → `TaskList` → assert every plan-task with `metadata.issue == N` is `completed`. ¬all completed → highlight stragglers in the summary (blockers for `/pr`).

```
Implement Complete
  Issue:    #N — title
  Branch:   feat/N-slug
  Worktree: .claude/worktrees/{N}-{slug}
  Tier:     S|F-lite|F-full
  Agents:   list
  Files:    created/modified list
  Tasks:    N/total completed (stragglers: ...)
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

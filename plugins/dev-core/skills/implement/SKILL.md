---
name: implement
argument-hint: '[--issue <N> | --plan <path> | --audit]'
description: Execute plan — setup worktree, spawn agents, write code + tests. Triggers: "implement" | "build this" | "execute plan" | "start coding" | "write the code" | "code this up" | "let's build it" | "build it out" | "ship it".
version: 0.3.0
allowed-tools: Bash, Read, Write, Edit, Glob, Grep, EnterWorktree, ExitWorktree, Task, TaskCreate, TaskUpdate, TaskList, TaskGet, Skill, ToolSearch
---

# Implement

## Success

I := QG pass ∧ worktree ∃ ∧ commits > 0
V := `cd .claude/worktrees/{N}-{slug} && {commands.format} && {commands.lint} && {commands.typecheck} && {commands.test}` → exit 0

Let:
  π := artifacts/plans/{N}-{slug}.mdx
  τ := tier (S | F-lite | F-full)
  ω := worktree (managed via EnterWorktree/ExitWorktree)
  β := base branch (staging if ∃ origin/staging, else main)
  QG := `{commands.format} && {commands.lint} && {commands.typecheck} && {commands.test}`
  bar := mechanical floor (format/lint/typecheck/test pass), ¬the quality bar — output must read as hand-authored by a dev-core maintainer: match surrounding idiom, naming, and comment density; calibrate against `plugins/dev-core/`

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

| Step | ID | Required | Verifies via | Notes |
|------|----|----------|---------------|-------|
| 1 | locate-plan | ✓ | π ∃ ∨ σ ∃ (S-tier) | — |
| 2 | setup | ✓ | ω ∃ ∧ branch ∃ | rollback on failure |
| 3 | context-inject | — | — | τ=F only |
| 4 | implement | ✓ | tasks `completed` | parallel: conditional, retry 3 |
| 5 | quality-gate | ✓ | QG exit 0 | retry 3, rollback on failure |
| 6 | summary | ✓ | all tasks done | — |

## Pre-flight

Success: QG pass ∧ worktree ∃ ∧ commits > 0
Evidence: QG exit 0 inside .claude/worktrees/{N}-{slug}
Steps: locate-plan → setup → context-inject → implement → quality-gate → summary
¬clear → STOP + ask: "Do you have a plan to implement?"

## Step 1 — Locate Plan

`--issue N` → `ls artifacts/plans/N-*.mdx` → read full → extract tasks, agents, τ, slug.
`--plan <path>` → read directly.
¬found ⇒ suggest `/plan`. **Stop.**

**S-tier exception:** τ=S ∧ ¬π → locate spec (`ls artifacts/specs/N-*.mdx`) or issue body (`gh issue view N --json body`). Skip to Step 4 (Tier S). ¬require π for τ=S.

Extract from frontmatter: `issue`, `tier`, `spec` path. From body: agent list, task list, slice structure.

### Step 1b — Attach to Plan Tasks

Parse π's `## Task IDs` section → {T1: id, T2: id, ...} map. ¬section → `/plan` pre-dates task-tool integration → fall through to 1b.3 (re-seed).

**1b.1 Verify ids:** ∀ id → `TaskGet(id)`. All succeed → cache map, goto Step 2.
**1b.2 Partial miss:** ¬some id (session restart invalidated state) → re-seed only the missing ones using the canonical schema from [plan-task-schema.md](${CLAUDE_PLUGIN_ROOT}/skills/shared/references/plan-task-schema.md) on the corresponding micro-tasks, then rewrite `## Task IDs` section in π with refreshed ids.
**1b.3 Total miss (legacy plan):** section absent → re-seed all micro-tasks using [plan-task-schema.md](${CLAUDE_PLUGIN_ROOT}/skills/shared/references/plan-task-schema.md), append `## Task IDs` section to π, commit the update (`git add` π + commit `chore(plan): attach task ids`).

τ=S without π → `TaskCreate` 3–6 coarse tasks directly from spec acceptance criteria: `{ kind: "plan-task", issue: N, tier: "S" }`. No artifact update.

## Step 2 — Setup

**2a. Issue check:** `gh issue view <N>` — ∄ ⇒ draft + present choice: **Create** | **Edit** | **Skip** + `gh issue create`.

**2b+2d. Repo, base + pre-flight:**

```bash
bash ${CLAUDE_SKILL_DIR}/setup-preflight.sh {N} {slug}
```

Emits: `repo`, `base`, `branch_exists`, `legacy_worktree`, `worktree`, `dirty` (if worktree found), `fetch`.

ω: `.claude/worktrees/{N}-{slug}` (via EnterWorktree). Branch base: `base` from output.

**2c. Branch guard:**

`branch_exists` ≠ false ∧ `worktree` = false → branch exists but no worktree → present choice **Recreate worktree** (invoke `skill: "setup-worktree", args: "{N:+--issue $N }--slug {slug}"`) | **Abort**

`worktree` ≠ false ∧ `dirty=true` ⇒ → present choice **Stash changes** (`git stash`) | **Reset** (`git checkout .`) | **Continue with dirty state** | **Abort**

**2e. Worktree:**

Enter existing worktree (created by `/setup-worktree` or prior `/dev` run):
```
EnterWorktree(path: ".claude/worktrees/{N}-{slug}")
```

`worktree` = false → fallback: invoke `skill: "setup-worktree", args: "{N:+--issue $N }--slug {slug}"` first, then enter.

Inside ω:
```bash
cp .env.example .env 2>/dev/null; {package_manager} install
# Optional: {commands.worktree_setup} <N>
```

ω **mandatory** ∀ τ (XS, S, F-lite, F-full) — ¬exception. ¬"skip worktree" branch.

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
→ present choice **Proceed** | **Adjust approach** | **Abort**
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

**Worktree isolation:** Main context is already inside ω (Step 2). Subagents spawned via `Task` inherit this CWD. All file operations must stay within `.claude/worktrees/{N}-{slug}`. Do not `cd` to repo root or other paths outside ω.

**Per agent spawn:**
1. `TaskUpdate(task_id, status: "in_progress", owner: "{agent}")`.
2. `TaskGet(task_id)` → inject `description` + `metadata` verbatim into the subagent's prompt. The agent reads its own task context from the task list.
3. Spawn:
   ```
   Task(
     subagent_type: "dev-core:{agent}",
     description: "{agent}: {phase} — #{N} {slug}",
     prompt: "Issue #{N}. Task: {TaskGet.description}. Target: {file_path}. Skeleton: {code_snippet}. Verify: {verify_command}. Ref pattern: {pattern_file}. Worktree: `.claude/worktrees/{N}-{slug}` — you are already inside it; do not leave this directory. ¬TaskCreate — task lifecycle managed by lead."
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
{commands.format} && {commands.lint} && {commands.typecheck} && {commands.test}
```

> format before lint — auto-format first so the linter never flags style the formatter would have fixed (¬format-induced lint noise).

✓ → Step 6.
✗ → fix loop (max 3). Spawn domain fixer agents as needed. 3✗ → present choice **Escalate to lead** | **Continue with failures** | **Abandon ω** (`ExitWorktree(action: "remove")` + delete branch).

## Step 6 — Summary

Before printing summary → `TaskList` → assert every plan-task with `metadata.issue == N` is `completed`. ¬all completed → highlight stragglers in the summary (blockers for `/pr`).

### Step 6a — SC→Test Matrix (τ ≠ S)

**Tier S exemption:** τ=S (no `/plan` artifact, no SC-N labels) → skip this step entirely. ¬emit matrix.

For τ=F (F-lite or F-full):

1. Read spec (`artifacts/specs/{N}-*.mdx`) → extract all SC-N lines (e.g. `SC1: …`, `SC2: …`).
2. Read tester deliverable (from task outputs or grep test files in ω): collect `{file} :: {test name}` pairs.
3. For each SC:
   - ≥1 named test mapped → row: `| SC-N: {text} | {file} :: {test name}[, …] | ⏳ not run |`
   - ¬mapped → row: `| SC-N: {text} | — | ⚠ NO TEST — {reason} |` (NO TEST is a Status verdict, per the schema below)
     - `reason` MUST ∈ `{infra-not-wired, prompt-logic-only, ui-manual-only, out-of-scope}` (closed enum — ¬free-form). Unmapped SC with ¬reason from enum = **blocking gap**: highlight in summary, ¬proceed to `/pr`.
4. Persist matrix as a fenced markdown block in the summary output (consumed by `/pr` Step 3d).

**Status column schema** (for `/pr` and falsification gate #280):
- `⏳ not run` — test exists, not yet executed against this change
- `✓ proven` — test ran green + falsification check passed (set by #280 gate)
- `✗ failed` — test ran red (set by #280 gate; note: `broke X → test failed with Y`)
- `⚠ NO TEST — {reason}` — no test; reason ∈ enum

### Step 6b — Falsification Gate (#280)

Runs immediately after SC→Test Matrix is built. Scope: unit + fast-integration tests only. e2e tests are **exempt** — annotate each e2e row `⚠ NO FALSIFY — e2e` in the evidence log and leave Status unchanged.

**Precondition:** the implement agent must `git add` all newly created source files before the gate runs — the Write tool does NOT auto-stage, and unstaged new files are invisible to `git diff HEAD`.

∀ new/modified test mapped in the matrix (¬e2e):

1. **Stash source** (¬test files):
   ```bash
   SRC=$(  { git diff HEAD --name-only; git ls-files --others --exclude-standard; } \
           | grep -v '\.test\.' | grep -v '\.spec\.' )
   git stash -- $SRC
   ```
   This enumerates both tracked-dirty AND untracked source files, then excludes test/spec files.
2. **Run the test**: `{commands.test} {test_file}`.
3. **Assert FAIL**: if exit 0 → test is **tautological** (passes without the implementation) → blocking gap. Do NOT pop stash. Restore worktree: `git stash pop`. Report: `TAUTOLOGICAL: {file} :: {test name} — passed with implementation stashed`. ¬proceed to `/pr` until test is rewritten.
4. **Pop stash** (success path only): `git stash pop`.
5. **Assert GREEN**: re-run `{commands.test} {test_file}` → exit 0. If ✗ → stash pop corrupted state → escalate to lead.
6. **Record evidence**: one line per test:
   ```
   broke {source file} → test failed with {error/assertion message}
   ```
7. **Update Status**: set matrix row to `✓ proven` (green + falsified) or `✗ failed` (red on green run).

**After all tests falsified**: append evidence block to summary output:

```
## Falsification Evidence
broke {source A} → test failed with {error A}
broke {source B} → test failed with {error B}
```

**Success path only:** ¬stash residue in working tree after gate completes — verify with `git status`. (On the tautological-blocking path the run halts before `/pr`; stash is popped as part of stopping, so no diff residue reaches the PR.)

**Matrix format (fixed columns — parseable):**

````markdown
## SC → Test Matrix

| SC | Test(s) | Status |
|----|---------|--------|
| SC1: {text} | `{file} :: {test name}` | ⏳ not run |
| SC2: {text} | `{file} :: {test name}`, `{file2} :: {test name2}` | ⏳ not run |
| SC3: {text} | — | ⚠ NO TEST — prompt-logic-only |
````

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
  SC Matrix: N/total mapped (gaps: ...)
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

| Merge conflict (ω setup) | `git rebase --abort` → present choice: **Resolve manually** (fix conflicts → `git rebase --continue`) \| **Abort** |
| Abandon after 3✗ gate failures | `ExitWorktree(action: "remove", discard_changes: true)` then `git branch -D feat/<N>-<slug>` |

## Safety

1. ¬`git add -A` ∨ `git add .` — specific files only
2. ¬push without PR via `/pr`
3. ¬create issue without user approval
4. Always ω ∀ τ — ¬exception (XS, S, F-lite, F-full all require ω)
5. Always HEREDOC for commit messages
6. Pre-commit hook failure → fix, re-stage, NEW commit (¬amend)

$ARGUMENTS

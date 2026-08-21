---
name: implement
argument-hint: '[--issue <N> | --plan <path> | --audit]'
description: Execute plan — setup worktree, spawn agents, write code + tests. Triggers: "implement" | "build this" | "execute plan" | "start coding" | "write the code" | "code this up" | "let's build it" | "build it out".
version: 0.3.3
allowed-tools: Bash, Read, Write, Edit, Glob, Grep, EnterWorktree, ExitWorktree, Task, TaskCreate, TaskUpdate, TaskList, TaskGet, Skill, ToolSearch
---

# Implement

## Success

I := QG pass ∧ worktree ∃ ∧ commits > 0 ∧ principal on β
V := `cd "$WT_PATH" && {commands.format} && {commands.lint} && {commands.typecheck} && {commands.test}` → exit 0

Let:
  π := artifacts/plans/{N}-{slug}.md
  τ := tier (S | F-lite | F-full)
  ω := non-principal worktree on `feat/{N}-{slug}` (path = harness layout — see harness-worktree.md)
  β := base branch (staging if ∃ origin/staging, else main)
  principal := main checkout — **always stays on β** (¬switch to feat)
  H_wt := claude-enter | harness-default
  QG := `{commands.format} && {commands.lint} && {commands.typecheck} && {commands.test}`
  bar := mechanical floor (format/lint/typecheck/test pass), ¬the quality bar — output must read as hand-authored by a dev-core maintainer: match surrounding idiom, naming, and comment density; calibrate against `plugins/dev-core/`

Plan → ω → agents (test-first) → passing QG.

**Flow: single continuous pipeline. ¬stop between steps. Decision response → immediately execute next step. Stop only on: explicit Cancel/Abort or Step 6 completion.**

```
/implement --issue 42        Execute plan for issue #42
/implement --plan artifacts/plans/42-dark-mode-plan.md   Execute from explicit plan path
/implement --issue 42 --audit   Show reasoning checkpoint before coding
```

Does NOT create a PR — that is `/pr` (next step).

## Chain Position

- **Phase:** Build
- **Predecessor:** `/plan` (artifact: `artifacts/plans/{N}-{slug}-plan.md`)
- **Successor:** `/pr`
- **Class:** adv (continuous flow, no gate)

## Task Integration

- `/dev` owns the dev-pipeline task lifecycle externally (mark in_progress before invoke, completed after return — host-mapped)
- This skill does NOT update its own dev-pipeline task
- Sub-tasks: attach/re-seed plan-tasks from `/plan` (Step 6a), flip lifecycle as agents execute (Step 1b + Step 4)
- **Host mapping SSoT:** [harness-task-list.md](${CLAUDE_PLUGIN_ROOT}/skills/shared/references/harness-task-list.md) — probe once, use H for all task ops
- **Worktree SSoT:** [harness-worktree.md](${CLAUDE_PLUGIN_ROOT}/skills/shared/references/harness-worktree.md) — principal freezes on β; code only in ω

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

Success: QG pass ∧ worktree ∃ ∧ commits > 0 ∧ principal on β
Evidence: QG exit 0 inside ω (`worktree=` from setup-preflight)
Steps: locate-plan → setup → context-inject → implement → quality-gate → summary
¬clear → STOP + ask: "Do you have a plan to implement?"

## Step 1 — Locate Plan

`--issue N` → `ls artifacts/plans/N-*.md*` → read full → extract tasks, agents, τ, slug.
`--plan <path>` → read directly.
¬found ⇒ suggest `/plan`. **Stop.**

**S-tier exception:** τ=S ∧ ¬π → locate spec (`ls artifacts/specs/N-*.md*`) or issue body (`gh issue view N --json body`). Skip to Step 4 (Tier S). ¬require π for τ=S.

Extract from frontmatter: `issue`, `tier`, `spec` path. From body: agent list, task list, slice structure.

### Step 1b — Attach to Plan Tasks (dual harness)

**Probe H** (once per `/implement` run) per [harness-task-list.md](${CLAUDE_PLUGIN_ROOT}/skills/shared/references/harness-task-list.md):

```
tools ∋ TaskCreate ∧ TaskUpdate ∧ TaskList  → H := claude-tasks
else tools ∋ todo_write                     → H := grok-todos
else                                        → H := artifact-only
```

Fields / seed shape: [plan-task-schema.md](${CLAUDE_PLUGIN_ROOT}/skills/shared/references/plan-task-schema.md).  
Blueprint source: π `## Task Seeding Blueprint` (or micro-task table). Cache map M := `{T# → host_id}` (claude) or `{T# → T#}` (grok stable ids).

#### H = claude-tasks

Parse π's `## Task IDs` section → M. ¬section → fall through to 1b.3.

| Step | Action |
|------|--------|
| **1b.1 Verify** | ∀ id ∈ M → `TaskGet(id)`. All succeed → cache M, goto Step 2 |
| **1b.2 Partial miss** | Session restart wiped some ids → re-seed **missing** rows only via `TaskCreate` (schema), rewrite `## Task IDs` in π |
| **1b.3 Total miss** | Section absent / all dead → re-seed **all** micro-tasks via `TaskCreate` + `blockedBy` wiring, append `## Task IDs`, commit `chore(plan): attach task ids` |

τ=S without π → `TaskCreate` 3–6 coarse tasks from spec AC: `{ kind: "plan-task", issue: N, tier: "S" }`. No artifact update.

#### H = grok-todos

Host has no durable id graph and no `TaskGet`. Stable ids = blueprint `T{n}`.

| Step | Action |
|------|--------|
| **1b.1 Verify** | If session already has todos with ids `T1…Tn` matching blueprint → reuse (merge=true only for status updates). Goto Step 2 |
| **1b.2 Partial miss** | Some `T#` missing from current todos → `todo_write` merge=true with those ids only (`status: pending`, content from schema portable encoding) |
| **1b.3 Total miss** | No matching todos → seed **all** from blueprint: `todo_write` merge=false, id=`T{n}`, content=`[{phase}] {agent_instance} — {subject} \| Verify: {cmd} \| {spec_trace}`. **¬** write `## Task IDs` host-sha section (nothing durable). Optional: note `host: grok-todos` in π frontmatter if useful |

Deps: **¬** invent `blockedBy` on host. Ready-set = rows whose blueprint `blockedBy` are all `completed` (track status in todo list).

τ=S without π → `todo_write` 3–6 coarse todos from AC (`id: S1…`, content = criterion text).

#### H = artifact-only

No host task list. Skip attach/re-seed. Work from π micro-task table only; progress in the reply / Step 6 summary.

## Step 2 — Setup

**2a. Issue check:** `gh issue view <N>` — ∄ ⇒ draft + present choice: **Create** | **Edit** | **Skip** + `gh issue create`.

**2b+2d. Repo, base + pre-flight:**

```bash
bash ${CLAUDE_SKILL_DIR}/setup-preflight.sh {N} {slug}
```

Emits: `repo`, `base`, `principal`, `principal_branch`, `principal_ok`, `branch_exists`, `legacy_worktree`, `worktree`, `worktree_branch`, `dirty` (if worktree found), `fetch`.

**Probe H_wt** (once): `EnterWorktree` ∃ → `claude-enter`; else `harness-default`.  
SSoT: [harness-worktree.md](${CLAUDE_PLUGIN_ROOT}/skills/shared/references/harness-worktree.md).

ω path = `worktree=` from preflight (branch-first detect). Branch base: `base` from output.

**2c. Guards:**

`principal_ok` = false → **STOP**. Principal must be on β. Present choice **Switch principal to base** | **Abort**. **¬** `git switch feat/…` on principal to “fix” this.

`branch_exists` ≠ false ∧ `worktree` = false → branch exists but no ω → present choice **Recreate worktree** (invoke `skill: "setup-worktree", args: "{N:+--issue $N }--slug {slug}"`) | **Abort**

`worktree` ≠ false ∧ `dirty=true` ⇒ → present choice **Stash changes** (`git -C "$WT_PATH" stash`) | **Reset** (`git -C "$WT_PATH" checkout .`) | **Continue with dirty state** | **Abort**

**2e. Worktree:**

`worktree` = false → invoke `skill: "setup-worktree", args: "{N:+--issue $N }--slug {slug}"`, re-run preflight.

Enter existing ω (`WT_PATH` from preflight):

- **H_wt = claude-enter:** `EnterWorktree(path: "$WT_PATH")`
- **H_wt = harness-default:** all code ops use `cwd` / absolute paths under `$WT_PATH` — **¬** switch principal to BRANCH

Inside ω:
```bash
cd "$WT_PATH"   # or git -C / Write under WT_PATH
cp .env.example .env 2>/dev/null; {package_manager} install
# Optional: {commands.worktree_setup} <N>
```

ω **mandatory** ∀ τ (XS, S, F-lite, F-full) — ¬exception. ¬"skip worktree" branch. ¬feature commits on principal.

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

Use **H from Step 1b** for every lifecycle op (mapping below). Generic ops: claim → inject context → spawn → mark done.

### Task lifecycle (all tiers) — by H

| Generic | H = claude-tasks | H = grok-todos | H = artifact-only |
|---------|------------------|----------------|-------------------|
| Claim / start | `TaskUpdate(id, status: in_progress, owner: …)` | `todo_write` merge=true, id=`T#`, status=`in_progress` | Note start in reply |
| Load context | `TaskGet(id)` → description + metadata | Blueprint row + todo `content` for `T#` | π micro-task row only |
| Mark done | `TaskUpdate(id, status: completed)` | `todo_write` merge=true, id=`T#`, status=`completed` | Check off in summary |
| Retry note | `TaskUpdate` metadata `last_error` | Append error to todo `content` or leave `in_progress` | Note in reply |
| 3× fail | leave in_progress → escalate (Step 5) | same | same |
| List ready | `TaskList` → empty `blockedBy` + phase | Blueprint: deps all `completed` + matching phase | Same from π table |
| List all done? | `TaskList` + metadata.issue == N | All seeded `T#` status=`completed` | All π rows done |

### Tier S — Direct

Read spec + ref patterns → create + implement → tests → QG → loop until ✓. Single session, ¬agent spawning. Flip each task start → completed via H mapping as you progress.

### Tier F — Agent-Driven (test-first)

Spawn via host subagent tool (`Task` / `spawn_subagent`). Sequential ∨ parallel (2–3 max).

**Worktree isolation:** Code only in ω (`$WT_PATH`). Principal stays on β.

| H_wt | Lead | Subagents |
|------|------|-----------|
| claude-enter | session CWD = ω after EnterWorktree | inherit CWD |
| harness-default | ops under `$WT_PATH` | `spawn_subagent(..., cwd: WT_PATH)` — **¬** `isolation: worktree` (anonymous trees break BRANCH link) |

**Per agent spawn:**
1. Claim task (H table).
2. Load context (H table) → inject into subagent prompt.
3. Spawn:
   ```
   Task(   # or spawn_subagent on Grok with cwd: WT_PATH
     subagent_type: "dev-core:{agent}",
     description: "{agent}: {phase} — #{N} {slug}",
     prompt: "Issue #{N}. Task: {task_description}. Target: {file_path}. Skeleton: {code_snippet}. Verify: {verify_command}. Ref pattern: {pattern_file}. Worktree: {WT_PATH} — stay inside this directory only; ¬checkout feat on principal. ¬seed host tasks — task lifecycle managed by lead."
   )
   ```
   Agent name map: `tester` → `dev-core:tester` | `frontend-dev` → `dev-core:frontend-dev` | `backend-dev` → `dev-core:backend-dev` | `devops` → `dev-core:devops` | `doc-writer` → `dev-core:doc-writer` | `architect` → `dev-core:architect` | `security-auditor` → `dev-core:security-auditor`
4. Subagent returns → verify → ✓ → mark done (H). ✗ → retry (≤3).

**RED → GREEN → REFACTOR:**
1. **RED** — tester: write failing tests from spec. Structural verify only (grep test structure). Tests expected to fail pre-impl. Create RED-GATE sentinel per slice. RED tasks flip completed as each test file lands.
2. **GREEN** — domain agents ∥: implement to pass. `ready` verify → run now; `deferred` → wait RED-GATE. Advance only when blueprint deps are satisfied (claude: `blockedBy` clear; grok/artifact: deps completed in checklist).
3. **REFACTOR** — domain agents: refactor, keep tests ✓.
4. **Verify** — tester: coverage + edge cases.

**Parallel spawn:** list ready tasks (H table) for current phase → spawn ≤N agents, each with its own context-injected prompt.

**Per-task:** verify → ✓ | ✗ fix (max 3) | 3✗ → escalate to lead. Track first-try pass rate.

Agents create files from scratch (¬stubs). Include target path, shape/skeleton, ref pattern file in each spawn prompt (in addition to loaded task context).

## Step 5 — Quality Gate

Run QG inside ω (`cd "$WT_PATH"` or `git -C` / shell with cwd=ω):

```bash
cd "$WT_PATH"
{commands.format} && {commands.lint} && {commands.typecheck} && {commands.test}
```

> format before lint — auto-format first so the linter never flags style the formatter would have fixed (¬format-induced lint noise).

✓ → Step 6.
✗ → fix loop (max 3). Spawn domain fixer agents as needed. 3✗ → present choice **Escalate to lead** | **Continue with failures** | **Abandon ω** (H_wt claude: `ExitWorktree(action: "remove")`; harness-default: `git worktree remove "$WT_PATH"`) + delete branch.

## Step 6 — Summary

Before printing summary → assert all plan-tasks for issue N are completed (**H table**: claude `TaskList` + metadata.issue; grok all `T#` completed; artifact-only π rows). ¬all completed → highlight stragglers (blockers for `/pr`).

### Step 6a — SC→Test Matrix (τ ≠ S)

**Tier S exemption:** τ=S (no `/plan` artifact, no SC-N labels) → skip this step entirely. ¬emit matrix.

For τ=F (F-lite or F-full):

1. Read spec (`artifacts/specs/{N}-*.md*`) → extract all SC-N lines (e.g. `SC1: …`, `SC2: …`).
2. Read tester deliverable (from task outputs or grep test files in ω): collect `{file} :: {test name}` pairs.
3. For each SC:
   - ≥1 named test mapped → row: `| SC-N: {text} | {file} :: {test name}[, …] | ⏳ not run |`
   - ¬mapped → row: `| SC-N: {text} | — | ⚠ NO TEST — {reason} |` (NO TEST is a Status verdict, per the schema below)
     - `reason` MUST ∈ `{infra-not-wired, prompt-logic-only, ui-manual-only, out-of-scope}` (closed enum — ¬free-form). Unmapped SC with ¬reason from enum = **blocking gap**: highlight in summary, ¬proceed to `/pr`.
4. Persist matrix as a fenced markdown block in the summary output (consumed by `/pr` Step 3d).

**Status column schema** (for `/pr` and falsification gate #280):
- `⏳ not run` — test exists, not yet executed against this change **or** ran without a recorded evidence line
- `✓ proven` — test ran green + falsification check passed **and** evidence line recorded (set by #280 gate)
- `✗ failed` — test ran red (set by #280 gate; note: `broke X → test failed with Y`)
- `⚠ NO TEST — {reason}` — no test; reason ∈ enum

Spec SCs with a priced-quantity block: map tests to `priced` + `oracles`, never to `not`.

### Step 6b — Falsification Gate (#280)

Runs immediately after SC→Test Matrix is built. Scope: unit + fast-integration tests only. e2e tests are **exempt** — annotate each e2e row `⚠ NO FALSIFY — e2e` in the evidence log and leave Status unchanged.

**Precondition:** the implement agent must `git add` all newly created source files before the gate runs — the Write tool does NOT auto-stage, and unstaged new files are invisible to `git diff HEAD`.

**Evidence is mandatory.** A mapped test without a `broke {file} → {error}` line stays `⏳ not run`, never `✓ proven`. ¬mental-only check.

**Runner — prefer mechanical** (consumer repo):

```
1. `{commands.test:falsify}` defined in stack.yml     → run it
2. else package.json has script `test:falsify`        → `{package_manager} run test:falsify`
3. else `scripts/test-falsify.sh` exists              → `bash scripts/test-falsify.sh`
4. else **fallback** — LLM-operated git stash (below)
```

Mechanical runner: collect `broke {file} → {error}` lines from its output. Missing line for a mapped test → leave that row `⏳ not run`. Tautological (pass-without-impl / exit 0 with no broke lines) → blocking gap; ¬proceed to `/pr`.

**Fallback — stash source (¬test files).** ∀ new/modified test mapped in the matrix (¬e2e):

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
7. **Update Status**: set matrix row to `✓ proven` (green + falsified + evidence) or `✗ failed` (red on green run). ¬evidence → stay `⏳ not run`.

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
  Worktree: {WT_PATH}
  Principal: {principal} @ {β}
  Tier:     S|F-lite|F-full
  Agents:   list
  Files:    created/modified list
  Tasks:    N/total completed (stragglers: ...)
  Verify:   N/total first-try (%)
  SC Matrix: N/total mapped (gaps: ...)
  Next:     /pr → /code-review → /1b1 → merge
```

## Rollback

H_wt = claude-enter:
```
ExitWorktree(action: "remove", discard_changes: true)
```

H_wt = harness-default:
```bash
git worktree remove --force "$WT_PATH"
```

```bash
git branch -D feat/<N>-<slug>
# Optional: {commands.worktree_teardown} <N>
# Principal must still be on β after teardown
```

## Edge Cases

Read [references/edge-cases.md](${CLAUDE_SKILL_DIR}/references/edge-cases.md).

| Merge conflict (ω setup) | `git rebase --abort` → present choice: **Resolve manually** (fix conflicts → `git rebase --continue`) \| **Abort** |
| Abandon after 3✗ gate failures | remove ω (H_wt) then `git branch -D feat/<N>-<slug>`; principal stays on β |
| Principal not on β | STOP — restore β before any feature work |

## Safety

1. ¬`git add -A` ∨ `git add .` — specific files only
2. ¬push without PR via `/pr`
3. ¬create issue without user approval
4. Always ω ∀ τ — ¬exception (XS, S, F-lite, F-full all require ω)
5. Always HEREDOC for commit messages
6. Pre-commit hook failure → fix, re-stage, NEW commit (¬amend)
7. **¬** `git switch` / `checkout` feat on principal — principal freezes on β
8. Grok: **¬** `isolation: worktree` for implement workers — use `cwd: WT_PATH`
9. AGENTS.md / `standards.testing` / lefthook comments: **ban enumerating** `validate:full` steps — point at the package script (`{package_manager} run validate:full` / `{commands.*}`). A copied step list is `parallel-path-drift`.

$ARGUMENTS

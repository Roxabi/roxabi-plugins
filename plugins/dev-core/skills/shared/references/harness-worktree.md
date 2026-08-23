# Harness worktree (dual: Claude + Grok)

> **SSoT for portable worktree ops.** Skills speak **generic** vocabulary; this file maps to host tools.  
> Prefer **one skill body + capability branch** — never fork full SKILL.md per host.  
> Pair with [harness-task-list.md](harness-task-list.md) (tasks) — same dual-harness pattern.

## Principle

| Layer | Rule |
|-------|------|
| Skill prose | Host-neutral: « ensure feature branch linked », « ensure ω isolated from principal », « work only in ω » |
| Capability probe | Detect which tools exist **in this session** (schema / known names) |
| **Branch + issue link** | **dev-core invariant** — harness-agnostic |
| **Path / enter / exit** | **Harness owns layout** — do not dual-hardcode opaque Grok hash paths in skills |
| **Principal freeze** | Principal checkout **always** stays on β (`staging` \| `main` \| `master`) — **never** `git switch` / `checkout` of `feat/…` there. Agent: plugin Pre **deny**. Persist: lefthook (`check-principal-branch.sh`, `/ci-setup` 2e). |

## Invariants (all harnesses)

Let:

- β := `detect_base_branch` (staging if `origin/staging` ∃, else main/master)
- BRANCH := `feat/{N}-{slug}` (∃N) ∨ `feat/{slug}` (¬N frame-only)
- principal := main worktree path (`principal_worktree_path` in `lib.sh`)
- ω := **non-principal** worktree whose HEAD branch is BRANCH

| Invariant | Check |
|-----------|--------|
| Principal on β | `principal_branch` ∈ {staging, main, master} after setup |
| Feature work only in ω | `git -C ω rev-parse --abbrev-ref HEAD` = BRANCH |
| Issue link (∃N) | `gh issue develop` at **create** time (create-only GraphQL) |
| ¬code on β for the feature | commits land in ω only |

## Detection (orchestrator)

```
if tools ∋ EnterWorktree ∧ ExitWorktree → H_wt := claude-enter
else if tools ∋ todo → H_wt := omp-default      # OMP (no EnterWorktree)
else                                    → H_wt := harness-default   # Grok (and other hosts without EnterWorktree)
```

¬probe by OS name. Probe **tools available in the current harness**.

**Locate ω (scripts):** `find_feature_worktree N [slug]` in `skills/shared/lib.sh` —

1. **Branch-first:** porcelain worktree whose `branch` is `refs/heads/feat/{N}-*` (excludes principal)
2. **Path fallback:** Claude `.claude/worktrees/{N}-*` or legacy `../${REPO}-{N}`
3. Grok hash dirs under `~/.grok/worktrees/` are found via (1) when they check out BRANCH

Principal on β + ω on feat elsewhere = **healthy** (not “missing worktree”).

## Capability matrix

| Operation (generic) | Claude (`claude-enter`) | OMP (`omp-default`) | Grok (`harness-default`) | Notes |
|---------------------|-------------------------|---------------------|--------------------------|-------|
| Ensure BRANCH + link | bash `gh issue develop` | idem | idem | From **principal** CWD; ¬switch principal |
| Create ω if missing | `git worktree add .claude/worktrees/{N}-{slug} BRANCH` | `git worktree add "${OMP_WORKTREE_DIR:-~/.omp/wt}/{N}-{slug}" BRANCH` | `git worktree add "$(suggested_grok_worktree_path N slug)" BRANCH` | Path is layout only; detection stays branch-first |
| Enter ω (lead) | `EnterWorktree(path)` | CWD = ω path for all code ops; session may already be in ω | CWD = ω path for all code ops; session may already be in ω | **¬** `git checkout BRANCH` on principal |
| Spawn workers | inherit CWD after Enter | `spawn_subagent(..., cwd: ω)` — **¬** `isolation: worktree` | `spawn_subagent(..., cwd: ω)` — **¬** `isolation: worktree` for `/dev` implement | Isolation:worktree creates anonymous trees + apply; breaks issue-linked BRANCH |
| Install / hooks | run inside ω | same | same | `worktree_setup` if project has it |
| Teardown | `ExitWorktree` / `git worktree remove` | `git worktree remove` + orphan-shell scan (`/cleanup`) | `git worktree remove` + orphan-shell scan (`/cleanup`) | |
| Detect resume | `find_feature_worktree` | same | same | |

### Create path conventions (only when creating)

| H_wt | Path when creating |
|------|--------------------|
| claude-enter | `{principal}/.claude/worktrees/{N}-{slug}` |
| omp-default | `${OMP_WORKTREE_DIR:-~/.omp/wt}/{N}-{slug}` (absolute or `~/` only) |
| harness-default | `~/.grok/worktrees/{grok_repo_slug}/{N}-{slug}` via `suggested_grok_worktree_path` |

## Setup procedure (generic)

Run from principal (or any CWD; all git ops that touch principal use `-C` when needed):

1. `BASE=$(detect_base_branch)` · `BRANCH=feat/{N}-{slug}`
2. Assert or restore principal on BASE — if principal is on a feat branch: **warn + stop** (user must switch principal back to β; skill does not force-switch without explicit user choice)
3. Ensure remote BRANCH + issue link (`gh issue develop` when N set and remote absent)
4. `WT=$(find_feature_worktree N slug)`
5. If empty → create via H_wt path table + `git worktree add "$WT" "$BRANCH"` (after `git fetch origin "$BRANCH"`)
6. Enter per H_wt · install deps inside ω
7. Re-assert `principal_branch` ∈ base set

## Work rules (implement / code)

- All Write/Edit/commit/QG: **inside ω only**
- Orchestration (`/dev` scan, `gh`, read principal artifacts): may stay on principal
- Artifact sync principal → ω: `rsync -a "$PRINCIPAL/artifacts/" "$WT/artifacts/"` (absolute paths — ¬`../../../` relative)

## Anti-patterns

| Don’t | Do |
|-------|----|
| `git switch feat/…` on principal | Create/use separate ω |
| Force `.claude/worktrees/` under Grok | `H_wt` path table / existing harness ω |
| Encode `~/.grok/worktrees/.../<hash>` in skills | Branch-first detect; stable create path only if missing |
| `isolation: worktree` on every implement agent | Share session ω via `cwd` |
| Detect ω only by Claude path | `find_feature_worktree` |
| Leave Grok naming as `worktree-agent-*` | `gh issue develop` → BRANCH before coding |
| Treat principal dirty on β as feature ω | Feature ω is always non-principal |

## Consumers

| Skill / script | Uses |
|----------------|------|
| `/setup-worktree` | Full setup procedure + H_wt |
| `/dev` Step 7 bootstrap | invoke setup-worktree; artifact sync absolute |
| `/implement` Step 2 | locate ω, enter per H_wt, work only in ω |
| `/analyze` spike | throwaway ω; principal stays on β |
| `scan-state.sh` / `setup-preflight.sh` | `find_feature_worktree`, principal ok flags |
| `/cleanup` | remove ω by path; orphan Grok shells |

## Related

- Shared bash: `skills/shared/lib.sh` (`detect_base_branch`, `find_feature_worktree`, …)
- Tasks dual-harness: [harness-task-list.md](harness-task-list.md)
- Orphan shells: `skills/cleanup/scan-orphan-worktree-shells.sh`

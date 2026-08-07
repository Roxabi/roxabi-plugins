---
title: "ADR-017: Principal freeze via state assert (not shell argv denylist)"
description: >
  Principal HEAD pin for agent shells uses PostToolUse state measurement
  (principal branch ∈ {staging,main,master}) plus a thin PreToolUse UX nudge.
  Rejects expanding a full shell/git parser as the primary control.
---

## Status

Accepted — 2026-08-07.

## Context

dev-core skills (`harness-worktree.md`) require **principal freeze**: the principal
worktree stays on β (`staging` \| `main` \| `master`); feature work runs in a
dedicated worktree ω.

A PreToolUse hook attempted to enforce this by **parsing the agent command string**
(shell segments, nested `bash -c`, `env`, `GIT_DIR`, `cd` tracking, git globals,
ref-moves, …). That design grew to ~1.2k LOC + ~800 LOC tests across multiple
adversarial fix loops. Each closed hole predicted a new encoding (scripts,
`node -e`, aliases, heredocs, `git -c alias…`).

**Root mismatch:** the priced invariant is **git state** (closed, one `rev-parse`);
the control measured **argv shape** (open language).

## Options considered

### A — Keep expanding the argv denylist
- Pros: blocks some common forms before execution.
- Cons: unbounded maintenance; residual set infinite; tests prove the parser, not I.
- **Rejected** as primary strategy.

### B — PostToolUse state assert only
- Pros: measures I directly; closes script/node/alias holes.
- Cons: damage already done when the hook fires (agent must restore).

### C — Coarse allowlist of all `git` on principal
- Pros: smaller Pre surface.
- Cons: still bypassed by non-inline git; blocks legitimate ops unless carefully listed.

### D — Hybrid: state primary + thin Pre UX (chosen)
- Pros: state **detect** of I after shell tools; soft pre for high-traffic `git switch feat`; hatch unchanged.
- Cons: two hooks; Pre never claimed complete; post is not an OS-level session halt.

## Decision

**Option D.**

1. **Primary control — `principal-branch-post.cjs` (PostToolUse Bash / `run_terminal_command`)**  
   After the tool runs, resolve principal worktree path and  
   `git -C <principal> rev-parse --abbrev-ref HEAD` (probes use stripped `GIT_DIR`/`GIT_WORK_TREE` env).  
   Outcomes:
   - branch ∈ β → allow  
   - branch ∉ β (or detached `HEAD`) → deny payload + restore guidance (exit 2) — **detect + nudge**, not a guaranteed agent-loop halt  
   - not a git repo → allow  
   - git probe error while in a repo context → fail-closed deny (cannot verify I)  
   Escape: `DEV_CORE_ALLOW_PRINCIPAL_SWITCH=1` (process env only; not in deny text).

2. **Soft control — `principal-branch-pre.cjs` (PreToolUse)**  
   High-traffic patterns only (`git switch|checkout -b|branch -m|-M|stash branch|…`)  
   when CWD is principal. No nested-shell completeness, no full `env` matrix, no script body open.  
   Does **not** price `git reset --hard` (branch name may stay β). Residual encodings → post.

3. **Shared helpers — `hooks/lib/principal-freeze.cjs`**  
   `isBaseBranch`, principal path, principal HEAD, hatch, emit helpers.  
   Align with `skills/shared/lib.sh` principal-first porcelain entry.

4. **Explicit non-goals of PreToolUse**  
   Script bodies, `source`, aliases, `xargs git`, `node -e` / `python -c` — documented residual;  
   closed by post state detect, not more parser features.

5. **Stop rule**  
   Further work on principal freeze must **not** grow Pre into a shell interpreter.  
   Prefer post assert, restore UX, or skill discipline (`principal_branch` checks).

## Consequences

- Delete / replace the large argv-parser guard; ~400 LOC hybrid instead of ~2k LOC parser+tests arms race.
- Post detect can fire **after** a bad switch (agent must `git switch` back to β) — acceptable for agent loops; hatch for humans. Edit/Write are not re-asserted until the next shell tool.
- Pre red ≠ “I violated”; post is SSoT for I. Pre false positives kept low (no bare path checkout / no reset --hard).
- Skills that run `bash preflight.sh` with inner `git checkout staging` remain OK (post sees β).

## Related

- `plugins/dev-core/skills/shared/references/harness-worktree.md` — principal freeze invariant
- `plugins/dev-core/hooks/README.md` — operator docs
- ADR-010 — pipeline chain contract (skills already re-assert principal after setup)

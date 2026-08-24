---
title: "ADR-017: Principal freeze — lefthook persist + plugin agent deny"
description: >
  Principal HEAD pin (HEAD ∈ {staging,main,master} on the principal worktree).
  Persist law = lefthook / pre-commit seeded by /dev-init → /ci-setup.
  Agent layer = plugin PreToolUse deny + PostToolUse deny-after-exec.
  Still rejects a full shell/git argv parser.
---

## Status

Accepted — 2026-08-07. **Amended 2026-08-14** — lefthook persist gate offered by
`/dev-init`; plugin Pre/Post kept as **agent deny** (not the persist law).
**Amended 2026-08-15** — persist law repriced to lefthook 2.1.10 staged-file
gate. `git commit --allow-empty` skip is a named residual, not a closed
every-commit law.

## Context

dev-core skills (`harness-worktree.md`) require **principal freeze**: the principal
worktree stays on β (`staging` \| `main` \| `master`); feature work runs in a
dedicated worktree ω.

A PreToolUse hook that **parsed the agent command string** grew to ~1.2k LOC.
The priced invariant is **git state**, not argv shape.

2026-08-14: Grok listed plugin hooks but did not execute them (plugin trust;
fail-open). `git checkout -b feat/…` on the principal succeeded. Lefthook cannot
block checkout (no Git `pre-checkout`). Two agents on the same principal can
still flip HEAD — isolation is ω, not lefthook.

2026-08-15 (live lefthook 2.1.10 + adversarial): lefthook **does** deny a
**staged-file** commit on principal when HEAD is `feat/*`. lefthook 2.1.10
**skips** `git commit --allow-empty` ("no matching staged files"). That skip
**is** persist — accepted named residual, not a miss. Lefthook is **not** a
closed persist law on every commit.

## Decision

**Lefthook = persist law. Plugin = agent deny. ω = isolation.**

1. **Persist — `scripts/check-principal-branch.sh`** (lefthook `pre-commit` +
   `pre-push`, or pre-commit framework equivalent). Persist **iff** lefthook
   **binds and runs** the canonical script under **both** hooks
   (`principal-freeze:` + uncommented `run:` containing
   `check-principal-branch.sh`). Comment, stub, or one hook only = not persist.
   Detect = `lefthook-persist.ts` bind, not grep/includes of the script name.

   If CWD is not principal → allow. If principal HEAD ∈ β → allow. Else deny
   **when lefthook runs the hook**. lefthook 2.1.10 runs it on commit/push
   **with matching staged files**. Probe errors fail-closed.
   Offered by `/dev-init` → `/ci-setup` 2e (`bun init.ts seed-principal-freeze`).

2. **Agent Pre — `principal-branch-pre.cjs`**  
   **Deny** (`{"decision":"deny"}`, exit 2) on high-traffic
   `git switch` / `checkout -b` / `branch -M` / `stash branch` off β when CWD
   is principal. Not a complete shell parser. Blocks the tool **before** exec
   if the hook actually runs (plugin trusted).

3. **Agent Post — `principal-branch-post.cjs`**  
   After any shell tool: measure principal HEAD. Off β → **deny payload**
   (same JSON). Does **not** undo the checkout; nudges restore. Not an OS halt.

4. **Stop rule** — do not grow a git-argv interpreter. Measure state. Hatch:
   `DEV_CORE_ALLOW_PRINCIPAL_SWITCH=1` (not printed).

## Consequences

- Trusted plugin: agent `git checkout -b feat` on principal is **denied**.
- Untrusted plugin / human terminal / other harness: lefthook refuses
  commit/push **with matching staged files** on principal off β.
- Named residual: lefthook 2.1.10 skips `git commit --allow-empty`
  ("no matching staged files"). Accepted; not a bug.
- Lefthook cannot block checkout (no `pre-checkout`). Isolation = ω.
- Two agents on the **same** worktree still conflict; give each ω.

## Related

- `plugins/dev-core/scripts/check-principal-branch.sh`
- `plugins/dev-core/hooks/principal-branch-pre.cjs`
- `plugins/dev-core/skills/dev-init/lib/seed-principal-freeze.ts`
- `plugins/dev-core/skills/shared/lefthook-persist.ts`
- `plugins/dev-core/skills/ci-setup/cookbooks/hooks.md`
- `plugins/dev-core/skills/shared/references/harness-worktree.md`

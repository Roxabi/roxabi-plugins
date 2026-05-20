---
name: init
argument-hint: '[--force]'
description: 'Initialize project for dev-core — orchestrates env-setup, github-setup, ci-setup, release-setup. Triggers: "init" | "setup dev-core" | "initialize dev-core".'
version: 0.8.0
allowed-tools: Bash, Read, Skill, ToolSearch
---

# Init

Let:
  I_TS := `${CLAUDE_PLUGIN_ROOT}/skills/init/init.ts`
  F    := `--force` flag present in `$ARGUMENTS`
  args := F ? "--force" : ""

Full project initialization harness. Orchestrates three focused sub-skills in sequence, each independently re-runnable:

| Sub-skill | Concern |
|-----------|---------|
| `/env-setup` | stack.yml, CLAUDE.md rules, docs stubs, VS Code, LSP |
| `axial-adr` (agent) | **Axis of decomposition ADR** — mandatory drift prevention (N×M trap). See `shared/references/axial-decomposition.md` |
| `/github-setup` | GitHub Project V2 board, labels, branch protection, workspace |
| `/ci-setup` | GitHub Actions, TruffleHog, Dependabot, hooks, marketplace plugins |
| `/release-setup` | Commit standards (Commitizen), hook additions, release automation (semantic-release / Release Please) |

Run sub-skills directly to reconfigure a single concern without re-running the full init.

## Phase 1 — Parse Input + Idempotency

¬F → check existing: `test -f .claude/dev-core.yml && echo "1" || grep -c 'dev-core' .env 2>/dev/null || echo "0"`.
result > 0 → → DP(A) **Re-configure** (≡F) | **Skip** (abort).

## Phase 2 — Prerequisites

Run: `bun $I_TS prereqs`. Parse JSON → display ✅/❌ table for bun, gh, git remote.

∃ ❌ → show install links:
- bun: https://bun.sh/
- gh: https://cli.github.com/ then `gh auth login`
- git remote: `git remote add origin <url>`

→ DP(A) **Abort** | **Continue anyway** (warn: some features won't work).

## Phase 3 — Orchestrate

Call sub-skills in order. Each runs its own phases, asks its own questions, displays its own progress.

```
skill: "env-setup", args: "{args}"
```

### Phase 3a — Axial ADR (mandatory drift prevention)

Foundational decision: which axis of variation is **primary** in this system. `/init` is the only moment where the cost of asking is zero — post-scaffold, the axis is implicit in code structure and changing it costs a refactor. Without this ADR, projects drift N×M (target × concern duplication).

Reference: `${CLAUDE_PLUGIN_ROOT}/../shared/references/axial-decomposition.md`

1. Check existing:
   ```bash
   grep -rli "^axial: true\|axis of decomposition" docs/architecture/adr/ 2>/dev/null | head -1
   ```
2. ∃ → D("Axial ADR", "✅ Already present"), continue.
3. ∄ → spawn the `axial-adr` sub-agent via Agent tool:
   ```
   subagent_type: "axial-adr"
   description:   "Elicit axial decomposition decision"
   prompt:        "Conduct the axial-decomposition interview for this project. Read ${CLAUDE_PLUGIN_ROOT}/../shared/references/axial-decomposition.md first. Output: ADR file in docs/architecture/adr/ with `axial: true` frontmatter (grep-discoverable canonical marker — no YAML pointer needed)."
   ```
4. Agent exit status:
   - `created` ∨ `superseded` ∨ `kept` → D("Axial ADR", "✅ {status}"), continue.
   - `cancelled` ∧ ¬F → halt `/init`:
     ```
     ⛔ Axial ADR required before scaffolding can continue.
        Re-run /init when ready, or invoke the axial-adr agent standalone.
        Rationale: shared/references/axial-decomposition.md
     ```
   - `cancelled` ∧ F → ⚠️ warn "axial ADR skipped via --force — drift risk acknowledged", continue.

```
skill: "github-setup", args: "{args}"
```

```
skill: "ci-setup", args: "{args}"
```

```
skill: "release-setup", args: "{args}"
```

## Phase 4 — Report

```
dev-core initialized
====================

  Run /checkup   to verify full configuration health
  Run /seed-docs to populate docs stubs from CLAUDE.md + codebase

Next steps:
  /checkup               Verify full configuration health
  /seed-docs             Populate scaffolded docs with content from CLAUDE.md + codebase
  roxabi dashboard       Launch the issues dashboard  (restart shell or: source ~/.bashrc)
  /issues                View issues in CLI
  /dev #N                Start working on an issue
  /init --force          Re-configure anytime
  /env-setup             Re-run environment setup only
  /github-setup          Re-run GitHub project setup only
  /ci-setup              Re-run CI/CD setup only
  /release-setup         Re-run release setup only
```

## Safety Rules

1. **Never commit secrets** — `.env` must be gitignored (`.claude/dev-core.yml` contains only public GitHub Project node IDs — commit it)
2. **Always present decisions via protocol** before destructive operations (delegated to sub-skills)
3. **Idempotent** — safe to re-run; sub-skills merge rather than overwrite

$ARGUMENTS

---
name: R-dev-init
disable-model-invocation: true
argument-hint: '[--force] [--skip-axial]'
description: Initialize project — env-setup, ci-setup, release-setup + axial ADR. Not host /init.
version: 0.9.4
---

# Dev-init

Let:
  I_TS       := `${CLAUDE_PLUGIN_ROOT}/skills/dev-init/init.ts`
  F          := `--force` flag present in `$ARGUMENTS`
  SKIP_AXIAL := `--skip-axial` flag present in `$ARGUMENTS`
  args       := join(F ? "--force" : "", SKIP_AXIAL ? "--skip-axial" : "")

Full project initialization harness. Orchestrates focused sub-skills in sequence (env-setup, `/R-adr --axial`, ci-setup, release-setup), each independently re-runnable.

**Invoke:** `/R-dev-init` (skill name = plugin name). Claude Code / Grok built-in `/init` (scaffold CLAUDE.md only) is a **different** command.

| Sub-skill | Concern |
|-----------|---------|
| `/R-env-setup` | stack.yml, AGENTS.md rules, docs stubs, LSP |
| `/R-adr --axial` | **Axis of decomposition ADR** — mandatory drift prevention (N×M trap). Skippable via `--skip-axial` for trivial single-axis projects. See `shared/references/axial-decomposition.md` |
| `/R-ci-setup` | GitHub Actions, TruffleHog (**seed** `scripts/trufflehog-check.sh` + exclude + lefthook + CI `secret-scan.yml`), principal freeze lefthook gate (offer), Dependabot, marketplace plugins |
| `/R-release-setup` | Commit standards (Commitizen), hook additions, release automation (semantic-release / Release Please) |

Run sub-skills directly to reconfigure a single concern without re-running the full init.

## Dual harness (Claude Code + Grok)

Keep this skill **portable** across hosts:

| Do | Don't |
|----|--------|
| Prefer **semantic steps** (what to run, what to check, what to write) | Hardcode host-only tool names in frontmatter (`allowed-tools: Bash, Agent, …`) |
| Use portable env: `CLAUDE_PLUGIN_ROOT` **or** `GROK_PLUGIN_ROOT` (Grok sets both) | Require one host's tool whitelist to load the skill |
| Invoke sub-skills by **stable slash id** (`/R-env-setup`) | Assume Claude `Skill` / `Agent` tool shape is available |
| Invoke `/R-adr --axial` by **stable slash id** | Embed Claude-only or Grok-only APIs as the only path |
| Shell via the host's bash tool (Claude `Bash` / Grok `run_terminal_command`) | Rely on `allowed-tools` for discovery |

When a step needs a subagent, instruct: *“spawn the project agent for role X with prompt …”* — each host maps that to its Task / spawn_subagent / Agent tool.

## Phase 1 — Parse Input + Idempotency

¬F → check existing: `test -f .dev/dev-core.yml && echo "1" || grep -c 'dev-core' .env 2>/dev/null || echo "0"`.
result > 0 → present choice **Re-configure** (≡F) | **Skip** (abort).

## Phase 2 — Prerequisites

Run: `bun $I_TS prereqs`. Parse JSON → display ✅/❌ table for bun, gh, git remote.

∃ ❌ → show install links:
- bun: https://bun.sh/
- gh: https://cli.github.com/ then `gh auth login`
- git remote: `git remote add origin <url>`

→ present choice **Abort** | **Continue anyway** (warn: some features won't work).

## Phase 3 — Orchestrate

Call sub-skills in order. Each runs its own phases, asks its own questions, displays its own progress.

```
skill: "R-env-setup", args: "{args}"
```

### Phase 3a — Axial ADR (mandatory drift prevention)

Foundational decision: which axis of variation is **primary** in this system. Project init is the only moment where the cost of asking is zero — post-scaffold, the axis is implicit in code structure and changing it costs a refactor. Without this ADR, projects drift N×M (target × concern duplication).

Reference: `${CLAUDE_PLUGIN_ROOT}/../shared/references/axial-decomposition.md`

**Skip path:** `SKIP_AXIAL ∨ F` → emit `D("Axial ADR", "⏭️  skipped via --skip-axial")` (or `--force` for blanket override), continue. Trivial single-axis projects (single-purpose CLI utilities, libraries with no transport/adapter axis) legitimately exit here.

**Gate path** (¬SKIP_AXIAL ∧ ¬F):

1. Check existing:
   ```
   Grep tool: pattern="^axial: true|axis of decomposition", path="docs/architecture/adr/", -l, -i
   ```
2. Exactly 1 match → D("Axial ADR", "✅ Already present"), continue.
3. ∅ ∨ >1 match → invoke the skill (host: Skill / slash):
   ```
   skill: "R-adr", args: "--axial"
   ```
   >1 match: `/R-adr --axial` Phase 1 offers auto-fix for the singleton violation. ∅: full interview.
4. Skill exit status:
   - `created` ∨ `superseded` ∨ `kept` → D("Axial ADR", "✅ {status}"), continue.
   - `cancelled` ∧ ¬F → halt `/R-dev-init`:
     ```
     ⛔ Axial ADR required before scaffolding can continue.

        State: env-setup has already completed (idempotent on re-run).
               ci-setup, release-setup have NOT run.

        Options:
          • Re-run `/R-dev-init` — will redo env-setup (idempotent) + re-prompt `/R-adr --axial`.
          • Invoke `/R-adr --axial` standalone, then re-run `/R-dev-init`.
          • Skip if this is a trivial single-axis project: `/R-dev-init --skip-axial` (re-runs env-setup; documents the skip in dev-core.yml).

        Rationale: shared/references/axial-decomposition.md
     ```
   - `cancelled` ∧ F → ⚠️ warn "axial ADR skipped via --force — drift risk acknowledged", continue.

```
skill: "R-ci-setup", args: "{args}"
```
```
skill: "R-release-setup", args: "{args}"
```

## Phase 4 — Report

```
dev-init complete
=================

  Run /R-dev-checkup   to verify full configuration health
  Run /R-seed-docs to populate docs stubs from AGENTS.md + codebase

Next steps:
  /R-dev-checkup           Verify full configuration health
  /R-seed-docs         Populate scaffolded docs with content from AGENTS.md + codebase
  /R-dev #N            Start working on an issue
  /R-dev-init --force           Re-configure anytime
  /R-env-setup         Re-run environment setup only
  /R-ci-setup          Re-run CI/CD setup only
  /R-release-setup     Re-run release setup only
```

## Safety Rules

1. **Never commit secrets** — `.env` must be gitignored (`.dev/dev-core.yml` contains only public repo configuration — commit it)
2. **Always present choices and wait for user reply** before destructive operations (delegated to sub-skills)
3. **Idempotent** — safe to re-run; sub-skills merge rather than overwrite

$ARGUMENTS

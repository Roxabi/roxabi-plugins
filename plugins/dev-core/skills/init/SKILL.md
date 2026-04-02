---
name: init
argument-hint: '[--force]'
description: 'Initialize project for dev-core — orchestrates env-setup, github-setup, ci-setup, release-setup. Triggers: "init" | "setup dev-core" | "initialize dev-core".'
version: 0.7.0
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
| `/github-setup` | GitHub Project V2 board, labels, branch protection, workspace |
| `/ci-setup` | GitHub Actions, TruffleHog, Dependabot, hooks, marketplace plugins |
| `/release-setup` | Commit standards (Commitizen), hook additions, release automation (semantic-release / Release Please) |

Run sub-skills directly to reconfigure a single concern without re-running the full init.

## Phase 1 — Parse Input + Idempotency

¬F → check existing: `test -f .claude/dev-core.yml && echo "1" || grep -c 'dev-core' .env 2>/dev/null || echo "0"`.
result > 0 → Present decision via protocol: read `${CLAUDE_PLUGIN_ROOT}/../shared/references/decision-presentation.md` (Pattern A): **Re-configure** (≡F) | **Skip** (abort).

## Phase 2 — Prerequisites

Run: `bun $I_TS prereqs`. Parse JSON → display ✅/❌ table for bun, gh, git remote.

∃ ❌ → show install links:
- bun: https://bun.sh/
- gh: https://cli.github.com/ then `gh auth login`
- git remote: `git remote add origin <url>`

Present decision via protocol: read `${CLAUDE_PLUGIN_ROOT}/../shared/references/decision-presentation.md` (Pattern A): **Abort** | **Continue anyway** (warn: some features won't work).

## Phase 3 — Orchestrate

Call sub-skills in order. Each runs its own phases, asks its own questions, displays its own progress.

```
skill: "env-setup", args: "{args}"
```

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

1. **Never commit secrets** — `.claude/dev-core.yml`, `.env` must be gitignored
2. **Always present decisions via protocol** before destructive operations (delegated to sub-skills)
3. **Idempotent** — safe to re-run; sub-skills merge rather than overwrite

$ARGUMENTS

# init

Full project initialization — orchestrates env-setup, ci-setup, release-setup + axial ADR in one shot.

## Why

Setting up a project for dev-core involves three distinct concerns (stack config, CI pipelines, commit standards). `/dev-init:init` runs them in the correct order, each idempotently, so you can safely re-run after partial failures or configuration changes.

## Usage

```
/dev-init:init                Initialize project (skips already-configured components)
/dev-init:init --force        Re-run all components, overwriting existing config
/dev-init:init --skip-axial   Skip axial ADR interview
```

**Not** the same as Claude Code's built-in `/init` (CLAUDE.md scaffold). Always use the namespaced form `/dev-init:init`.

Triggers: `"dev-init"` | `"setup project"` | `"initialize project"`

## How it works

1. **Idempotency check** — detects existing `.claude/dev-core.yml` or `.env` config; asks to re-configure or skip.
2. **Prerequisites** — verifies `bun`, `gh`, and `git remote` are available; shows install links for missing tools.
3. **Sub-skills** (from **dev-core**) — calls in order:
   - `/dev-core:env-setup` — stack.yml, CLAUDE.md rules, docs stubs, LSP
   - `axial-adr-create` — axis of decomposition ADR (unless `--skip-axial`)
   - `/dev-core:ci-setup` — GitHub Actions, TruffleHog, Dependabot, hooks, marketplace plugins
   - `/dev-core:release-setup` — Commitizen, commitlint, semantic-release / Release Please
4. **Report** — shows next steps: `/checkup`, `/seed-docs`, `/dev #N`.

## Sub-skills

Each sub-skill is independently re-runnable to reconfigure a single concern:

| Sub-skill | Concern |
|-----------|---------|
| `/dev-core:env-setup` | Stack config, governance rules, docs stubs |
| `/dev-core:ci-setup` | GitHub Actions workflows, secret scanning, hooks |
| `/dev-core:release-setup` | Commit standards, hook runner, release automation |

## Safety

- Never commits secrets — `.env` is gitignored. `.claude/dev-core.yml` contains only the public `github_repo` slug and is committed.
- Idempotent — sub-skills skip already-configured items unless `--force`.
- On a repo that already has CI/hooks: prefer `/dev-core:env-setup` alone, or `/dev-init:init --force` only with intent.

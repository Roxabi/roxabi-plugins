# dev-init

Full project initialization — orchestrates env-setup, ci-setup, release-setup + axial ADR in one shot.

## Why

Setting up a project for dev-core involves three distinct concerns (stack config, CI pipelines, commit standards). `/R-dev-init` runs them in the correct order, each idempotently, so you can safely re-run after partial failures or configuration changes.

## Usage

```
/R-dev-init                Initialize project (skips already-configured components)
/R-dev-init --force        Re-run all components, overwriting existing config
/R-dev-init --skip-axial   Skip axial ADR interview
```

**Not** the same as the host built-in `/init` (CLAUDE.md scaffold). Use `/R-dev-init`.

Triggers: `"dev-init"` | `"setup project"` | `"initialize project"`

## How it works

1. **Idempotency check** — detects existing `.claude/dev-core.yml` or `.env` config; asks to re-configure or skip.
2. **Prerequisites** — verifies `bun`, `gh`, and `git remote` are available; shows install links for missing tools.
3. **Sub-skills** — calls in order:
   - `/R-env-setup` — stack.yml, CLAUDE.md rules, docs stubs, LSP
   - `R-axial-adr-create` — axis of decomposition ADR (unless `--skip-axial`)
   - `/R-ci-setup` — GitHub Actions, TruffleHog, Dependabot, hooks, marketplace plugins
   - `/R-release-setup` — Commitizen, commitlint, semantic-release / Release Please
4. **Report** — shows next steps: `/R-dev-checkup`, `/R-seed-docs`, `/R-dev #N`.

## Sub-skills

Each sub-skill is independently re-runnable to reconfigure a single concern:

| Sub-skill | Concern |
|-----------|---------|
| `/R-env-setup` | Stack config, governance rules, docs stubs |
| `/R-ci-setup` | GitHub Actions workflows, secret scanning (seeds `scripts/trufflehog-*` + lefthook + CI), hooks |
| `/R-release-setup` | Commit standards, hook runner, release automation |

## Safety

- Never commits secrets — `.env` is gitignored. `.claude/dev-core.yml` contains only the public `github_repo` slug and is committed.
- Idempotent — sub-skills skip already-configured items unless `--force`.
- On a repo that already has CI/hooks: prefer `/R-env-setup` alone, or `/R-dev-init --force` only with intent.

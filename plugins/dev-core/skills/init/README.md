# init

Full project initialization — orchestrates env-setup, github-setup, ci-setup, release-setup in one shot.

## Why

Setting up a project for dev-core involves four distinct concerns (stack config, GitHub project board, CI pipelines, commit standards). `/init` runs them in the correct order, each idempotently, so you can safely re-run after partial failures or configuration changes.

## Usage

```
/init           Initialize project (skips already-configured components)
/init --force   Re-run all components, overwriting existing config
```

Triggers: `"init"` | `"setup dev-core"` | `"initialize dev-core"`

## How it works

1. **Idempotency check** — detects existing `.claude/dev-core.yml` or `.env` config; asks to re-configure or skip.
2. **Prerequisites** — verifies `bun`, `gh`, and `git remote` are available; shows install links for missing tools.
3. **Sub-skills** — calls in order:
   - `/env-setup` — stack.yml, CLAUDE.md rules, docs stubs, VS Code, LSP
   - `/github-setup` — GitHub Project V2, labels, branch protection, workspace
   - `/ci-setup` — GitHub Actions, TruffleHog, Dependabot, hooks, marketplace plugins
   - `/release-setup` — Commitizen, commitlint, semantic-release / Release Please
4. **Report** — shows next steps: `/checkup`, `/seed-docs`, `/issues`, `/dev #N`.

## Sub-skills

Each sub-skill is independently re-runnable to reconfigure a single concern:

| Sub-skill | Concern |
|-----------|---------|
| `/env-setup` | Stack config, governance rules, docs stubs |
| `/github-setup` | GitHub Project board, labels, branch protection |
| `/ci-setup` | GitHub Actions workflows, secret scanning, hooks |
| `/release-setup` | Commit standards, hook runner, release automation |

## Safety

- Never commits secrets — `.claude/dev-core.yml` and `.env` are gitignored automatically.
- Idempotent — sub-skills skip already-configured items unless `--force`.

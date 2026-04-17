# ci-setup

Set up CI/CD — GitHub Actions workflows, TruffleHog secret scanning, Dependabot, pre-commit hooks, and marketplace plugins.

## Why

A project without CI is a liability: no automatic checks on PRs, no secret scanning, and no dependency updates. `/ci-setup` wires all of these up from a single command — adapting to your stack (Node/Bun/Python), your hook runner (Lefthook/Husky), and your test framework.

## Usage

```
/ci-setup           Configure CI/CD (skips already-configured items)
/ci-setup --force   Re-run all steps
```

Triggers: `"ci setup"` | `"setup ci"` | `"configure ci"` | `"setup hooks"` | `"setup github actions"`

## Phases

**Phase 1 — GitHub Actions workflows** — generates workflow files for lint, typecheck, test, and build adapted to your runtime (commands from `stack.yml`). Handles monorepos with turbo/nx cache.

**Phase 1b — Secret scanning** — configures TruffleHog as a CI check (`trufflehog.yml` workflow). Scans commits for leaked credentials.

**Phase 1c — Dependabot** — creates `.github/dependabot.yml` for automated dependency update PRs (npm/pip/github-actions depending on stack).

**Phase 1d — Fumadocs Vercel** — if `docs.framework: fumadocs` in stack.yml, adds a Vercel deploy preview workflow for the docs site.

**Phase 2 — Pre-commit hooks** — installs and configures Lefthook or Husky with hooks for lint, typecheck, and commit message validation. Adds a Python license checker for Python projects.

**Phase 3 — Marketplace plugins** — offers to install curated marketplace plugins (e.g., dev-core, roxabi-vault) into the project.

## Output summary

```
CI Setup Complete
  CI/CD workflows   ✅ Created
  TruffleHog        ✅ Configured
  Dependabot        ✅ Created
  Pre-commit hooks  ✅ Lefthook configured
  License checker   ✅ Copied
  Marketplace       ✅ 2 plugins installed
```

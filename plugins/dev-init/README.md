# dev-init

Project initialization harness. Orchestrates environment setup, GitHub project configuration, CI/CD scaffolding, and release automation in one shot.

## Install

```bash
claude plugin marketplace add Roxabi/roxabi-plugins
claude plugin install dev-init
```

## Usage

```
/init           Initialize project (skips already-configured components)
/init --force   Re-run all components, overwriting existing config
```

Triggers: `"init"` | `"setup project"` | `"initialize project"`

## What it does

Runs three sub-skills in sequence, each idempotent:

| Step | Skill | Concern |
|------|-------|---------|
| 1 | `/env-setup` | stack.yml, CLAUDE.md rules, docs stubs, VS Code, LSP |
| 2 | `/ci-setup` | GitHub Actions, TruffleHog, Dependabot, hooks, marketplace plugins |
| 3 | `/release-setup` | Commit standards (Commitizen), release automation |

Between steps 1 and 2, `/init` also spawns the `axial-adr-create` agent to capture the project's primary axis of decomposition (prevents N×M drift). Skippable with `--skip-axial` for trivial single-axis projects.

## Dependencies

Requires `dev-core` plugin to be installed — `/init` calls `env-setup`, `ci-setup`, and `release-setup` from dev-core.

## License

MIT

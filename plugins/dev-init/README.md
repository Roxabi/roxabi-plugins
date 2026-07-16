# dev-init

Project initialization harness. Orchestrates environment setup, CI/CD scaffolding, release automation, and the axial-decomposition ADR gate in one shot.

## Install

```bash
claude plugin marketplace add Roxabi/roxabi-plugins
claude plugin install dev-init
claude plugin install dev-core   # required dependency
```

Enable both plugins for the project (`.claude/settings.json` or via `/plugin`).

## Usage

```
/dev-init:init                Initialize project (skips already-configured components)
/dev-init:init --force        Re-run all components, overwriting existing config
/dev-init:init --skip-axial   Skip axial ADR interview (trivial single-axis projects)
```

**Slash form is namespaced.** Plugin skills always invoke as `/<plugin>:<skill>`:

| Command | What it is |
|---------|------------|
| `/dev-init:init` | This harness (Roxabi) |
| `/init` | Claude Code **built-in** (scaffold CLAUDE.md) — **not** this plugin |

If autocomplete only shows `/init`, type `/dev-init` to filter the plugin skill. After install/enable mid-session, run `/reload-plugins` or restart Claude Code.

Triggers (model auto-invoke): `"dev-init"` | `"setup project"` | `"initialize project"`

## What it does

Runs three sub-skills in sequence (from **dev-core**), each idempotent:

| Step | Skill | Concern |
|------|-------|---------|
| 1 | `/dev-core:env-setup` | stack.yml, CLAUDE.md rules, docs stubs, VS Code, LSP |
| 2 | `/dev-core:ci-setup` | GitHub Actions, TruffleHog, Dependabot, hooks, marketplace plugins |
| 3 | `/dev-core:release-setup` | Commit standards (Commitizen), release automation |

Between steps 1 and 2, `/dev-init:init` also spawns the `axial-adr-create` agent (dev-core) to capture the project's primary axis of decomposition (prevents N×M drift). Skippable with `--skip-axial` for trivial single-axis projects.

## Dependencies

| Dep | Role |
|-----|------|
| **dev-core** | `env-setup`, `ci-setup`, `release-setup`, agent `axial-adr-create` |
| **bun** | runs `skills/init/init.ts` (prereqs + scaffold helpers) |
| **gh** | GitHub API (workflows, protection) when CI setup runs |
| **git remote** | origin must exist for full setup |

## License

MIT

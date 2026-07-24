# dev-init

Project initialization harness. Orchestrates environment setup, CI/CD scaffolding, release automation, and the axial-decomposition ADR gate in one shot.

## Install

```bash
claude plugin marketplace add Roxabi/roxabi-plugins
claude plugin install dev-init
claude plugin install dev-core   # required dependency
```

Enable both plugins for the project (`.claude/settings.json` or via `/plugin`). On Grok: marketplace install + `[plugins].enabled` includes `dev-init` and `dev-core`.

## Usage

```
/dev-init                Initialize project (skips already-configured components)
/dev-init --force        Re-run all components, overwriting existing config
/dev-init --skip-axial   Skip axial ADR interview (trivial single-axis projects)
```

| Command | What it is |
|---------|------------|
| `/dev-init` | This harness (Roxabi) — skill name matches plugin name |
| `/init` | Host **built-in** (scaffold CLAUDE.md only) — **not** this plugin |

After install/enable mid-session, reload plugins or restart the host (Claude `/reload-plugins`, Grok Plugins `r`).

Triggers (model auto-invoke): `"dev-init"` | `"setup project"` | `"initialize project"`

## What it does

Runs three sub-skills in sequence (from **dev-core**), each idempotent:

| Step | Skill | Concern |
|------|-------|---------|
| 1 | `/dev-core:env-setup` | stack.yml, CLAUDE.md rules, docs stubs, LSP |
| 2 | `/dev-core:ci-setup` | GitHub Actions, TruffleHog, Dependabot, hooks, marketplace plugins |
| 3 | `/dev-core:release-setup` | Commit standards (Commitizen), release automation |

Between steps 1 and 2, `/dev-init` also spawns the `axial-adr-create` agent (dev-core) to capture the project's primary axis of decomposition (prevents N×M drift). Skippable with `--skip-axial` for trivial single-axis projects.

## Dual harness (Claude + Grok)

- No host-specific `allowed-tools` frontmatter (avoids load filters).
- Skill id = `dev-init` → slash `/dev-init` on both hosts.
- Body is **semantic**: shell helpers via `bun`, sub-skills by slash id, agents by role name — each host maps tools itself.

## Dependencies

| Dep | Role |
|-----|------|
| **dev-core** | `env-setup`, `ci-setup`, `release-setup`, agent `axial-adr-create` |
| **bun** | runs `skills/dev-init/init.ts` (prereqs + scaffold helpers) |
| **gh** | GitHub API (workflows, protection) when CI setup runs |
| **git remote** | origin must exist for full setup |

## License

MIT

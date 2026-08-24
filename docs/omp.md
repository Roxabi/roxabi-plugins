# Oh My Pi (OMP) install

Roxabi plugins load on [Oh My Pi](https://github.com/can1357/oh-my-pi) via `.omp-plugin/marketplace.json` and per-plugin `package.json` `omp.extensions`.

## Add the marketplace

```bash
omp plugin marketplace add Roxabi/roxabi-plugins
```

Local checkout — repo root, not the catalog file:

```bash
omp plugin marketplace add /path/to/roxabi-plugins
```

## Install

Bare names resolve as npm packages. Qualify with the catalog name:

```bash
omp plugin install dev-core@roxabi-marketplace
```

`--scope project` for one repo. Do not install `--scope user` until safety hooks are project-gated and verified.

A marketplace install exposes the registered slash commands below.
Other skills resolve via `skill://` when the plugin is linked (`omp plugin link` / `-e`).

## Slash commands

| Command | What it does |
|---------|--------------|
| `/dev` | Full development lifecycle orchestrator |
| `/ship` | Land ready code (PR, review, CI) |
| `/dev-init` | Project initialization harness |
| `/dev-plan` | Implementation plan (not native `/plan`) |
| `/dev-review` | Multi-domain review (not native `/review`) |
| `/dev-checkup` | Project health check (not native `/checkup`) |

## Safety hooks

`plugins/dev-core/omp/index.ts` registers:

- Blocks bare `bun test` (use `bun run test` / Vitest)
- Principal-branch freeze (pre) on high-traffic `git switch` / `checkout` forms
- Security scan on `write` and OMP `edit` hashline payloads (fail-open on very large payloads)

Guards no-op unless a project contract file exists: `stack.yml`, `.omp/stack.yml`, `dev-core.yml`, or `.omp/dev-core.yml`. Missing contract → one stderr warning per cwd, then silent no-op. `.claude/stack.yml` is not a contract.

No post-bash nudge (OMP would treat it as a user turn). No format hook (v1). Escape: `DEV_CORE_ALLOW_PRINCIPAL_SWITCH=1`.

## Paths

Bundled files: `skill://<skill>/<file>`.
`registerCommand` dumps `SKILL.md` as a fallback until marketplace install exposes `/skill:<name>`.
Legacy `$CLAUDE_PLUGIN_ROOT` / `$CLAUDE_SKILL_DIR` in skill bodies are expanded at dump time.

# Oh My Pi (OMP) install

Roxabi plugins work on [Oh My Pi](https://github.com/can1357/oh-my-pi) via the repo-root `.omp-plugin/marketplace.json` catalog and per-plugin `package.json` `omp.extensions` entry points.

## Add the marketplace

```bash
omp plugin marketplace add Roxabi/roxabi-plugins
```

Or point OMP at a local checkout (repo root, not the catalog file):

```bash
omp plugin marketplace add /path/to/roxabi-plugins
```

## Install plugins

Bare names resolve as npm packages. Qualify with the catalog name:

```bash
omp plugin install dev-core@roxabi-marketplace
omp plugin install dev-init@roxabi-marketplace   # requires dev-core
```

A marketplace install exposes the five registered slash commands below.
The other skills resolve via `skill://` only when the plugin is linked
(`omp plugin link` / `-e`).

## Slash commands

| Command | Plugin | What it does |
|---------|--------|--------------|
| `/dev` | dev-core | Full development lifecycle orchestrator |
| `/ship` | dev-core | Land ready code (PR, review, CI) |
| `/dev-plan` | dev-core | Implementation plan (not native `/plan`) |
| `/dev-review` | dev-core | Multi-domain review (not Claude `/code-review`) |
| `/dev-checkup` | dev-core | Project health check (not Claude `/doctor`) |
| `/dev-init` | dev-init | Project initialization harness |

## Safety hooks

`dev-core` registers an OMP extension (`plugins/dev-core/omp/index.ts`) that mirrors Claude/Grok hooks:

- Blocks bare `bun test` (use `bun run test` / Vitest)
- Principal-branch freeze (pre) on high-traffic `git switch` / `checkout` forms
- Security scan on `write` and OMP `edit` hashline payloads (fail-open on very large payloads)

No post-bash nudge and no format hook (v1). Escape hatch: `DEV_CORE_ALLOW_PRINCIPAL_SWITCH=1`.

## Paths

Bundled files: `skill://<skill>/<file>` (see `skill://shared-refs/harness-paths.md`).
`registerCommand` remains a fallback dump until marketplace install exposes `/skill:<name>`.
The extension does **not** rewrite `$CLAUDE_*`.


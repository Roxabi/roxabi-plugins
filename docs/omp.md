# Oh My Pi (OMP) install

Roxabi plugins work on [Oh My Pi](https://github.com/can1357/oh-my-pi) via the repo-root `.omp-plugin/marketplace.json` catalog and per-plugin `package.json` `omp.extensions` entry points.

## Add the marketplace

```bash
omp plugin marketplace add Roxabi/roxabi-plugins
```

Or point OMP at a local checkout:

```bash
omp plugin marketplace add /path/to/roxabi-plugins/.omp-plugin/marketplace.json
```

## Install plugins

```bash
omp plugin install dev-core
omp plugin install dev-init   # requires dev-core
```

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
- Principal-branch freeze on high-traffic `git switch` / `checkout` forms
- Security scan on `write` / `edit` content (fail-open on very large payloads)

Escape hatch: `DEV_CORE_ALLOW_PRINCIPAL_SWITCH=1`.

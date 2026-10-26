# Roxabi Plugins

Open-source plugins maintained by Roxabi for Claude Code and Oh My Pi (OMP).

## Install

```bash
# Claude Code: issue-triage
claude plugin marketplace add Roxabi/roxabi-plugins
claude plugin install issue-triage

# OMP: issue-triage or omp-build
omp plugin marketplace add Roxabi/roxabi-plugins
omp plugin install issue-triage@roxabi-marketplace
omp plugin install omp-build@roxabi-marketplace
```

Restart OMP after installing or upgrading a plugin; do not use `/reload-plugins`.

## Retained plugins

| Plugin | Host | Description |
|--------|------|-------------|
| [issue-triage](plugins/issue-triage/README.md) | Claude Code, OMP | Create and triage GitHub issues with labels and native relations; no Projects V2. |
| [omp-build](plugins/omp-build/README.md) | OMP | Bounded delivery workflow: frame → implement → native review/fix → land. Confirmed checkpoints come from GitHub records and Git; it does not require a local business store. |

`issue-triage` is in both host catalogs. `omp-build` is OMP-only and appears only in [`.omp-plugin/marketplace.json`](.omp-plugin/marketplace.json).

## Active external curation

The active external catalog is the `status: active` projection of
[`.claude-plugin/external-registry.json`](.claude-plugin/external-registry.json), mirrored by
[`.claude-plugin/curated-marketplaces.json`](.claude-plugin/curated-marketplaces.json). The
registry retains deprecated entries as historical records; they are not install recommendations.
Upstream Watch is separate: it monitors only explicit omp-build `watched_paths`, not this catalog.

| Marketplace | Source |
|-------------|--------|
| agent-browser | [vercel-labs/agent-browser](https://github.com/vercel-labs/agent-browser) |
| claude-plugins-official | [anthropics/claude-plugins-official](https://github.com/anthropics/claude-plugins-official) |
| knowledge-work-plugins | [anthropics/knowledge-work-plugins](https://github.com/anthropics/knowledge-work-plugins) |
| anthropic-agent-skills | [anthropics/skills](https://github.com/anthropics/skills) |
| context7-marketplace | [upstash/context7](https://github.com/upstash/context7) |
| visual-explainer | [nicobailon/visual-explainer](https://github.com/nicobailon/visual-explainer) |
| ui-ux-pro-max-skill | [nextlevelbuilder/ui-ux-pro-max-skill](https://github.com/nextlevelbuilder/ui-ux-pro-max-skill) |
| roxabi-forge | [Roxabi/roxabi-forge](https://github.com/Roxabi/roxabi-forge) |
| roxabi-video-engine | [Roxabi/roxabi-production](https://github.com/Roxabi/roxabi-production) |
| impeccable | [pbakaus/impeccable](https://github.com/pbakaus/impeccable) |
| frontend-slides | [zarazhangrui/frontend-slides](https://github.com/zarazhangrui/frontend-slides) |
| mattpocock-skills | [mattpocock/skills](https://github.com/mattpocock/skills) |

See [External marketplace curation](CONTRIBUTING.md#external-marketplace-curation) for the curation and retirement lifecycle.

## Documentation

- [Contributing](CONTRIBUTING.md) — workflow, plugin creation, release and curation
- [Issue tracker contract](docs/agents/issue-tracker.md) — relations, tiers and labels read by `issue-triage`
- [Historical archive](archived/README.md) — inert source, former guides, ADRs, analyses and playbooks; not runtime dependencies

## License

AGPL-3.0

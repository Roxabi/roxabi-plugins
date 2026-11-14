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

GitHub drafts require semantic confidentiality review; existing-tool scanning is best-effort, not a new automatic publisher gate. See the [issue-triage instructions](plugins/issue-triage/skills/issue-triage/SKILL.md#public-safe-publication) and [omp-build instructions](plugins/omp-build/skills/feature/SKILL.md#public-safe-publication). No scanner dependency or native adapter is added.

## Retained plugins

| Plugin | Host | Description |
|--------|------|-------------|
| [issue-triage](plugins/issue-triage/README.md) | Claude Code, OMP | Autonomous GitHub triage CLI plus an importable complete-observation writer, guarded native close/reopen effects and κ tier calculator; labels and native relations, no Projects V2. |
| [omp-build](plugins/omp-build/README.md) | OMP | Criterion-id delivery with evidence-backed verdicts, versioned inherited constraints, explicit child coverage and bottom-up calculated completion; live canonical Spec currentness, fresh whole-observation continuation and full-proof guarded closure preserve accepted authority. Identity-stable portable input manifests retain exact PR/Epic review roots and read-only UW snapshots, while authorized roles explore technical code in the worktree. Durable per-cause decisions use producer-pinned review classes, original-UW reports, operator-adjudicated historical holds and genuinely confirmed sister/promotion operations. Strict Spec grammar and `/uw` writes retain authority in GitHub records and Git, not local artifacts or PR prose. Delivery discovery excludes provably unrelated PR bindings without trusting their historical mandates; relevant and ambiguous authority stays fail-closed. Explicit succession authenticates its own terminal antecedent, preserves hierarchy commitments and preflights the same PR binding. Interruption resolution requires current-process proof that native dispatch was prevented; uncertain or admitted execution stays blocked. Engine-led continuation preserves recoverable landing holds and business-state visibility in the owning session. Native root capture and late reports follow the live session mappings; state-aware confirmation feedback never grants authority. Worktree-only `/cleanup` inventories multiple repositories and preserves branches. |

`issue-triage` is in both host catalogs. `omp-build` is OMP-only and appears only in [`.omp-plugin/marketplace.json`](.omp-plugin/marketplace.json).

Covered delivery discovery searches relevant mandate branches across all PR states; canonical bindings remain the association authority. New-policy bindings require the mandate's branch and base to match the PR. The first uncovered legacy succession retains two exhaustive observations; incomplete historical coverage refuses rather than silently scanning or assuming absence. See the [discovery contract](plugins/omp-build/README.md#storage-and-recovery).

Pause, abandon and control-disarm require complete ordinary authority; uncovered legacy history refuses rather than confirming containment. The one-time historical succession path remains available under its existing preconditions.

Initial `/feature` framing preserves the selected source and requires genuine aggregate confirmation. `ctrl+alt+u` opens a readable proposal with explicit confirm, refuse and defer actions; it does not approve. Escape or `Plus tard` keeps that exact proposal pending for the same shortcut in the same live session and location, including confirmations other than framing. Commands receive an immediate UI receipt before long reads; phase status and shortcut feedback distinguish preparation, pending decisions and started actions without adding model progress messages. omp-build 0.19.0 is a manual source change until an applicable activation decision; it does not move the tooling pin. If a move is needed, the operator performs `/move`, attests its observed success at the destination, and continues the same UW without retyping. Framing is not a Mandate; host and provider behavior requires separate qualification. See the [omp-build guide](plugins/omp-build/README.md).

For merge-on-green repositories using the Kit gate, omp-build authorizes the reviewed
head with a scoped protocol receipt; a `reviewed` label alone is not authority.
See [landing safeguards](plugins/omp-build/README.md#existing-review-and-landing-safeguards)
for configuration and limits.

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

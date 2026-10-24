# Archived source and documents

This directory contains retired plugins and their archive-only support files,
plus historical playbooks, analyses, former contributor guides and ADRs. It is inert historical material: it is
not catalogued, installed, executed, validated, indexed or formatted by active
repository controls. Active code and instructions must not import or execute it.

## Navigation

| Path | Historical material |
| --- | --- |
| [plugins/](plugins/) | Retired plugin source; not an installation target or fallback runtime. |
| [roxabi_sdk/](roxabi_sdk/) | Retired shared SDK, retained with the archived consumers. |
| [tests/](tests/) | Archive-only tests; not the active test suite. |
| [playbooks/](playbooks/) | All eleven former root playbooks, including avatar experiment history, forge/brand/codebase guidance, meeting regeneration, multi-agent audit, Syncthing and video/voice procedures. |
| [docs/](docs/) | The former root `docs/` tree (contributor guides, ADRs 001–024, architecture index, Fumadocs changelog page), historical analyses and the retired plugin-wrapping/subtree authoring procedure. |

## Archived documentation

| Document | Classification |
| --- | --- |
| [Review/fix strategy](docs/analysis-review-fix-strategy.md) | Original dev-core strategy and sliced implementation proposal; historical design input, not the current native OMP review/correction contract. |
| [Task Master workflow state](docs/analysis-taskmaster-workflow-state.md) | Dated external-system comparison and dev-core state proposal; not permission to add a local workflow ledger. |
| [Plugin wrapping/subtree authoring](docs/legacy-plugin-authoring.md) | Retired fork/wrapper and upstream-sync procedure preserved from the former contributor path; not supported runtime wrapper behavior. |
| [Architecture index](docs/architecture/README.md) and [ADRs](docs/architecture/adr/) | Decision records 001–024 with their original statuses, plus the applicability index written before archiving. Rationale only; the index's "current" classifications describe the repository at the time of archiving. |
| Former guides: [plugin creation](docs/CREATE-PLUGIN-GUIDE.md), [external ecosystem](docs/EXTERNAL-ECOSYSTEM.md), [plugin cache](docs/plugin-cache.md), [data management](docs/data-management.md), [release convention](docs/release-convention.md), [cookbook convention](docs/COOKBOOK-CONVENTION.md), [OMP install](docs/omp.md) | Contributor and install guidance as of archiving. The maintained procedure is [CONTRIBUTING.md](../CONTRIBUTING.md), [AGENTS.md](../AGENTS.md) and the plugin READMEs. |
| [Changelog pages](docs/changelog/) | Retired Fumadocs changelog page; GitHub Releases are the release record. |

The eleven playbooks moved from `playbooks/` to `archived/playbooks/`, and the two
analyses from `docs/` to `archived/docs/`, with basenames and bytes unchanged.
Together those thirteen documents contain 277,822 bytes. The remaining 34 files of
the root `docs/` tree (236,864 bytes) then moved to `archived/docs/` under the same
relative paths, also byte-identical; only `docs/agents/issue-tracker.md` stays in place
because `issue-triage` and omp-build's `/feature` read it at runtime.

Original commands, statuses, relative paths and external references remain historical
evidence. Links that left the former `docs/` tree resolve against its original location,
and some references already depended on another checkout or on filename casing not
present here; follow the actual archived paths rather than treating those references
as active contributor instructions.

## Current references

Use the maintained [issue-triage](../plugins/issue-triage/README.md) and
[omp-build](../plugins/omp-build/README.md) documentation for supported behavior.
The archived [architecture index](docs/architecture/README.md) classifies all ADRs
without rewriting their historical status. The
[artifact index](../artifacts/README.md) distinguishes proof dossiers from current
authority and links the separate frozen pre-consolidation snapshots.

Archive presence does not reactivate a product or procedure. Reading an archived
decision for rationale does not create a runtime dependency on this directory.

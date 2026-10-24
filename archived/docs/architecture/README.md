# Architecture decision index

This is an applicability guide for the maintained marketplace, not a new ADR or a
rewrite of the decision log. All 24 records remain at their original paths with
their authored `status`, `normative`, amendments and supersession links unchanged.
**Historically accepted does not mean current policy for a maintained product.**

## Current authority and reading order

- **Product/host scope:** the [Claude catalog](../../.claude-plugin/marketplace.json)
  contains `issue-triage`; the [OMP catalog](../../.omp-plugin/marketplace.json)
  contains `issue-triage` and OMP-only `omp-build`. Retired dev-core, CLI, SDK and
  forge paths in older records do not enlarge that maintained surface.
- **Implementation and operational contract:** start with the maintained
  [issue-triage README](../../plugins/issue-triage/README.md),
  [omp-build README](../../plugins/omp-build/README.md) and
  [tracker contract](../agents/issue-tracker.md). For omp-build consolidation,
  [#873](https://github.com/Roxabi/roxabi-plugins/issues/873) and its
  [resolution](https://github.com/Roxabi/roxabi-plugins/issues/873#issuecomment-6369583128)
  identify the C1–C5 contract; the issue's closure alone does not certify a later
  source tree, installation or activation.
- **Decision history:** use the per-record scope below and follow explicit
  amendments. A record retained for rationale or an inherited guard is not a
  mandate to restore its former product, command, configuration or runtime.
- **Evidence:** [artifacts](../../artifacts/README.md) and
  [archived material](../../archived/README.md) preserve historical dossiers,
  not a second Spec, execution permission or current runtime dependency.

## Maintained OMP and repository decisions

| Record | Authored status | Applicability now and evidence |
| --- | --- | --- |
| [020 — OMP delivery](adr/020-omp-delivery-feature-cycle.md) | accepted | **Current boundary, mixed execution history.** OMP owns delivery in omp-build; tracker mutations belong to issue-triage; absorbed helpers remain plugin-local snapshots, not resynced dev-core imports. Current consumers cite this record in `omp/guards.ts`, `hooks/lib/contract-paths.cjs` and `skills/shared/lib.sh`. Its old Claude/Grok dev-core distribution, `/wt`, skill-driven lifecycle and five-role roster describe an earlier surface; use the current omp-build README for commands, native profiles and generated distribution. ADR-024 already amends §3/4/8/9. |
| [021 — Explicit releases](adr/021-release-is-an-explicit-act.md) | accepted | **Current release decision.** A merge does not cut a release; the annotated tag is deliberate. Evidence: [release workflow](../../.github/workflows/release.yml), [release convention](../release-convention.md), `.dev/stack.yml` and omp-build's promote skill. Historical SHA-only/version observations are not the current OMP package-version contract. |
| [022 — Bun dependencies](adr/022-bun-repos-use-the-bun-dependabot-ecosystem.md) | accepted | **Current dependency-management rationale and limits.** The Bun ecosystem, frozen CI installs and repo-local audit remain relevant. Evidence: [Dependabot config](../../.github/dependabot.yml), [audit workflow](../../.github/workflows/dependency-audit.yml) and [audit script](../../scripts/dependency-audit.ts). Generator/fleet observations and dated advisory counts are historical; they do not prove another repository's security posture. |
| [023 — Marketplace cache refresh](adr/023-plugin-cache-refresh-via-marketplace-install.md) | accepted | **Current cache principle, host-scoped procedure.** Source is maintained repo code; caches are host-owned, not a second writer via rsync. The operational reference is [plugin-cache](../plugin-cache.md). Its literal `claude plugin install` procedure is Claude-specific; OMP install/upgrade and local-link instructions live in the maintained plugin README. |
| [024 — Epic goals](adr/024-one-goal-per-epic.md) | accepted | **Retained proof/isolation rationale; historical goal authority.** Proof is not a second Spec, adapter-backed AssertLedger is not ADR-019's oracle, and worktree/base isolation remains useful. However, its session `/goal` authority and legacy `landPr`/comment-marker mechanism are not the current execution contract: the omp-build README's Process/Storage/Epic/Records sections describe confirmed mandates, canonical records, `/move`, bounded review and the installed coordinator. Retaining this record does not authorize goal-based execution or revive old record readers. |

## Retained conventions and inherited mechanisms

| Record | Authored status | Applicability now and evidence |
| --- | --- | --- |
| [001 — User-data storage](adr/001-user-data-storage-convention-roxabi-vault.mdx) | accepted | **Mixed.** The outside-repo data root, override and zero-personal-data principle remain in [data-management](../data-management.md). The five original consumers, in-repo vault implementation, vendored Python helpers and detailed old manifest schema are historical; do not restore them as current dependencies. |
| [008 — dev-core configuration](adr/008-dev-core-yml-config-resolution.mdx) | accepted | **Historical resolution, surviving config pin.** The `.claude/dev-core.yml`/ProjectV2 schema and YAML-before-env order are not the maintained reader. `issue-triage/skills/shared/adapters/config-helpers.ts` reads explicit env overrides before `.dev/dev-core.yml`; `github_repo` still matters. Keep [`.dev/dev-core.yml`](../../.dev/dev-core.yml); follow the maintained issue-triage instructions rather than deleting the pin because of its legacy name. |
| [016 — Plain Markdown](adr/016-plain-markdown-docs-no-fumadocs.md) | accepted | **Current documentation convention.** New docs use `.md`; existing `.mdx` records are retained for reading, not an instruction to restore Fumadocs. Evidence: `.dev/stack.yml` declares `docs.framework: none` / `format: md`; ADR-007 is explicitly superseded. Retired scaffold commands are historical. |
| [017 — Principal freeze](adr/017-principal-freeze-state-assert.md) | accepted | **Inherited active guard rationale.** State assertions, worktree isolation and the distinction between persist hooks and agent deny remain relevant. Evidence: [principal script](../../scripts/check-principal-branch.sh), [lefthook](../../lefthook.yml) and omp-build's `hooks/principal-branch-pre.cjs` (explicit ADR-017 reference). The old dev-core seed paths and dated Lefthook observations do not certify every current host or every commit path. |
| [018 — Skill homes/composition](adr/018-skill-system-homes-and-composition.md) | accepted | **Historical dev-core cadastre, reusable rationale.** One home per fact and the OMP split explain later decisions; the amendment also records the dev-init merge. Its old folder roster, copy-sync references, invocation counts and claim about OMP's `disable-model-invocation` gate are not current host contracts. The maintained omp-build README distinguishes command/tool authority from reference-skill visibility. No dev-core factory or old layout is restored by this record. |

## Historical CLI, SDK and migration records

| Record | Authored status | Historical scope and retained value |
| --- | --- | --- |
| [002 — CLI/plugin boundary](adr/002-cli-plugin-boundary-multi-project-workspace.mdx) | accepted | The removed root CLI, workspace dashboard and dev-core vendoring arrangement. Self-contained installability is still a useful rationale, but this is not authority to recreate `cli/`, a shared SDK or manual copy-sync. Current package/distribution boundaries are documented with the maintained plugins. |
| [003 — Typed workspace fields](adr/003-typed-workspace-projects-field-resolution.mdx) | accepted; partially superseded by #268 | Multi-project CLI/ProjectV2 field discovery and `.env` migration. Its own amendment records removal of `fieldIds`, `resolveFieldIds` and the board path. The maintained issue-triage catalog describes labels/native relations, not Projects V2. |
| [004 — Audit/cleanup consolidation](adr/004-reasoning-audit-and-context-cleanup-consolidation.mdx) | accepted | dev-core `/dev` reasoning-audit placement, shared prose templates and memory-audit/cleanup-context consolidation. Not a current marketplace entry list or permission to add a second install path. |
| [005 — Hexagonal migration](adr/005-clean-architecture-hexagonal-migration.mdx) | accepted; partially superseded by ADR-015 and #452 | Historical six-plugin migration, ports, shims and deferred SDK gate. The record already narrows TS and linkedin-apply portions. Remaining Python decisions describe their original products; they do not impose that migration or SDK dependencies on the two maintained plugins. |
| [006 — Slice V1 review](adr/006-slice-v1-port-boundary-review.mdx) | accepted; partially superseded by ADR-015 | Findings from the same historical migration, including Python models/ports. Preserve as review evidence, not a present implementation checklist or proof that any old follow-up is complete. |

## Historical documentation, profile and forge records

| Record | Authored status | Historical scope and retained value |
| --- | --- | --- |
| [007 — Fumadocs strategy](adr/007-documentation-strategy.mdx) | superseded by ADR-016 | Retired Fumadocs/Next.js scaffold. Keep the original trade-off and replacement link; current docs do not require its framework, topology or toolchain. |
| [009 — Profile infrastructure](adr/009-github-profile-infrastructure-banner-and-external-dependencies.mdx) | accepted | Personal/org profile banner and external-widget decisions, outside this marketplace's maintained plugin contract. This index makes no claim about completion or current configuration of those separate repositories. |
| [010 — Pipeline chain](adr/010-dev-core-pipeline-chain-contract.mdx) | superseded by ADR-023 | Old dev-core `/dev` chain and retired atomic cache-sync mechanism. Its successor explicitly leaves the original chain decision intact in that historical product; neither that note nor its skill list turns the old pipeline into current OMP authority. |
| [011 — Forge design system](adr/011-forge-design-system-extraction.mdx) | accepted | Retired forge template extraction, CSS/JS shells and aesthetics. Retained rationale for historical generated visuals, not current runtime/template dependencies. |
| [012 — Architecture diagrams](adr/012-foreignobject-architecture-diagrams.mdx) | accepted | Forge-chart foreignObject/CSS dispatch and rendering limits. Historical generator guidance, not a new mandatory diagram engine for maintained plugins. |

## Historical review and shared-layer governance

| Record | Authored status | Historical scope and retained value |
| --- | --- | --- |
| [013 — Candidate write helper](adr/013-t2-taxonomy-review-class-design-decisions.mdx) | accepted | dev-core `candidate-classes.jsonl` write procedure and graduation pipeline. omp-build's snapshotted `review-classes.yml` explicitly says that graduation cron was not absorbed. Do not infer that the old candidate writer is the current native review/correction record format. |
| [014 — Shared TS governance](adr/014-shared-ts-governance-scope.mdx) | superseded by ADR-018 | Retired dev-core/dev-init copy-sync and shared-test governance. Its own banner records retirement; do not recreate its manifest, generated-copy overrides or sync gate. |
| [015 — Direct-call TS layer](adr/015-direct-call-over-role-interface-ports-typescript.mdx) | accepted; partially superseded by ADR-018 | Rationale for removing unused ports/DI and later mirror scope. Useful history, not a blanket architecture mandate for the maintained plugins or a reversal of the record's original Python scope. |
| [019 — Falsify oracle](adr/019-plugin-owned-falsify-oracle.md) | accepted; partially superseded by ADR-020/024 | Claude/Grok dev-core oracle history, executable-evidence limits and the explicit cut of claim-axis spawning (§6). The `R-pr` / `oracle_ok` producer was never absorbed into OMP. Preserve this distinction when reading #417/#419 artifacts; AssertLedger is a separate producer, not restoration of this oracle. |

## Preservation boundary

No ADR was moved, renumbered, reactivated, deprecated or superseded by this index.
Existing active references to ADR-017/020/021/022/024 keep their locations; legacy
`.mdx` records and historical cross-references remain readable. Applicability is
classified here without falsifying an accepted decision's original status.

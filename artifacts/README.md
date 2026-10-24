# Artifact dossiers

These files preserve proposals, analyses, plans, reviews, visuals and their
original evidence. **An artifact's historical `approved`, `validated`, `done` or
green result is not current product authority, fresh proof for another HEAD,
or permission to execute its plan.** Existing statuses, findings, raw records
and provenance remain unchanged; this index asserts no new completion or activation.

## Current authority

- **Maintained products and hosts:** [Claude catalog](../.claude-plugin/marketplace.json),
  [OMP catalog](../.omp-plugin/marketplace.json),
  [issue-triage README](../plugins/issue-triage/README.md) and
  [omp-build README](../plugins/omp-build/README.md), together with their maintained source.
- **Current work:** the selected tracker issue and its explicit decisions;
  [#873](https://github.com/Roxabi/roxabi-plugins/issues/873) and its
  [resolution](https://github.com/Roxabi/roxabi-plugins/issues/873#issuecomment-6369583128)
  define the omp-build consolidation C1–C5 contract. Its resolution distinguishes
  the plan from implementation, proof, installation and activation.
- **Decision applicability:** the archived [architecture index](../archived/docs/architecture/README.md)
  separates repository/OMP decision rationale from retired dev-core, CLI, SDK and
  forge history. For release operations, use [CONTRIBUTING.md](../CONTRIBUTING.md#workflow)
  and the actual release workflow, not a dated plan.
- **Runtime proof:** the current producer/admission contract determines whether a
  record applies to the selected inputs. A checked-in historical review JSON,
  markdown verdict or execution checklist is not a replacement for that contract.

## Directory index

| Directory | Classification | How to read it |
| --- | --- | --- |
| [frames/](frames/) | Historical problem framing and scoped proposals | Preserves the question and constraints at the recorded date; not a current feature backlog or authorization. |
| [analyses/](analyses/) | Historical investigation and design comparisons | Claims keep their original repository/version/coverage limits. In particular, the release-model survey is not current fleet policy. |
| [specs/](specs/) | Historical local specifications and retrospective contracts | Retains approved, superseded and other original statuses. OMP's maintained tracker/mandate contract is not replaced by these files. |
| [plans/](plans/) | Historical implementation plans and attributed execution evidence | Distinguish planned/owed work from observed receipts and their exact heads. The #768 integration matrix retains both; it is not blanket certification of current source. |

| Directory | Classification | How to read it |
| --- | --- | --- |
| [reviews/](reviews/) | Historical review inventories, maps and producer outputs | Preserve findings and machine-readable evidence for their original scope. Do not use a stored green result as a live gate bypass. |
| [visuals/](visuals/) | Historical design illustrations/generated HTML | Evidence of the design alternatives and relationships then considered; not executable plugin dependencies or current architecture authority. |
| [archive/omp-build-pre-consolidation/](archive/omp-build-pre-consolidation/) | Frozen, byte-preserved pre-consolidation snapshots | Read its [original README](archive/omp-build-pre-consolidation/README.md) for snapshot origins, SHA-256/byte receipts and the #873 boundary. Its contents and README remain unchanged. |

## Topic-specific caveats

| Dossier | Historical applicability / current reference |
| --- | --- |
| dev-core/dev-init shared layers, CLI/ProjectV2, compress modes, old scaffolds | Retired product proposals and execution history. Their presence does not add a maintained plugin, SDK dependency, copy-sync job or pipeline step. Source history is also retained under [archived/](../archived/README.md). |
| #417 oracle, #419 claim-axis roster, #485 agent consolidation | Distinct decisions, not a composite current roster spec. The [#419 spec](specs/419-claim-axis-code-review-roster-spec.md) explicitly records claim-axis spawning as **cut**, not pending. [ADR-019](../archived/docs/architecture/adr/019-plugin-owned-falsify-oracle.md) narrows its oracle to the old Claude/Grok product; the maintained OMP runtime/docs own today's review/correction behavior. |
| #371 release-model work and #500 trunk tagger removal | Keep the staging-train history and the subtraction rationale. [ADR-021](../archived/docs/architecture/adr/021-release-is-an-explicit-act.md) plus the current release workflow describe this repository's deliberate annotated-tag release path. |
| #768 integration matrix and pre-consolidation archive | Evidence remains attributed to its recorded inputs and era, including superseding routes and unproved gaps. The frozen archive is **not current Spec**; #873's later contract and maintained source/docs are the current reference. The principal-dirty diagnosis in #873 is preservation-only, not cleanup/reset/merge/activation permission. |

Historical links inside the dossiers are retained as evidence, not rewritten into
current instructions. No artifact was deleted, moved, regenerated, re-statused or
promoted to authority by this classification.

---
title: "Dev-core: consolidate durable review agent roles"
description: "Retrospective F-lite contract for the seven-role evidence-prioritized review roster and isolated procedural workers."
type: spec
status: approved
issue: 485
tier: F-lite
date: 2026-09-16
---

## Context

**Promoted from:** [approved frame](../frames/485-dev-core-agent-consolidation-frame.md)
**GitHub issue:** #485
**Implemented by:** commit `51882b8c`

The previous review roster carried narrow roles whose mandates overlapped or represented procedures rather than durable expertise. This retrospective spec records the implemented contract: a smaller durable roster, bounded per-chunk dispatch, explicit compatibility behavior, and native isolated workers for procedural side paths.

## Intent

Reduce review coordination and maintenance cost without making reviewer choice arbitrary. Concrete diff evidence must determine which durable expertise receives the limited specialist slots, while axial and cross-chunk procedures retain their behavior without permanent agent manifests.

## Goal

Each review chunk deterministically receives the adversarial floor and no more than two evidence-relevant specialists by default; axial review, procedural recall, option-space analysis, configuration, documentation, and tests all describe the same consolidated model.

## Users

- **Primary:** contributors and maintainers running dev-core review workflows who need focused, predictable expert feedback.
- **Secondary:** dev-core maintainers evolving roster configuration, compatibility behavior, documentation, and tests.

## Constraints

- Preserve the existing review lifecycle, findings contract, and approval flow.
- Keep `always` and `never` roster overrides, including explicit migration behavior for removed keys.
- Keep procedural recall and option-space analysis isolated and read-only.
- Limit implementation scope to dev-core review configuration, directly associated skills, documentation, and tests.

## Out of Scope

- Adding review roles or increasing the default per-chunk concurrency.
- Replacing deterministic evidence with free-form reviewer selection.
- Redesigning finding rendering, deduplication, or approval decisions.

## Expected Behavior

### Durable roster and per-chunk selection

`DISPATCHABLE` contains exactly seven durable review roles:

| Order | Role | Evidence responsibility |
|---:|---|---|
| 1 | `R-adversarial` | Immutable floor in every chunk |
| 2 | `R-security-auditor` | Strong auth, secret, or crypto path/diff evidence |
| 3 | `R-architect` | Axial or conservative structural evidence |
| 4 | `R-frontend-dev` | Configured frontend/shared-UI paths, or frontend extensions when unconfigured |
| 5 | `R-backend-dev` | Configured backend paths |
| 6 | `R-devops` | Infrastructure, configuration, or deployment evidence independent of tier |
| 7 | `R-tester` | Test delta with a false executable oracle result |

`review.roster.max_agents` defaults to `3` per chunk, including the `R-adversarial` floor. Candidate priority is deterministic: floor → security path → architect axial mode → dominant frontend/backend domain by file count → devops → tester → architect structural mode → secondary frontend/backend domain. `always` and `never` remain authoritative; forced roles are retained, and the effective cap rises with a warning only when forced roles exceed the configured value.

### Axial and compatibility behavior

An `axial: true` ADR plus a root axial-path delta (`infrastructure/`, `adapters/`, `domains/`, or `stages/`) selects `R-architect` with an explicit read-only axial-mode prompt. The same agent also performs the structural pass for that chunk. Axial review no longer has a separate durable manifest.

A legacy `R-axial-adr-review` override is parsed as an axial-mode override and emits a rename warning. A canonical non-default `R-architect` override applies globally and wins a conflict regardless of key order, with a conflict warning. Legacy recall, finding-verifier, recall-size, and confidence-filter settings are accepted only as warned no-ops where retained for migration.

### Procedural workers and ADR creation

Multi-chunk recall builds a deterministic canonical-class index and starts a fresh host-native read-only exploration worker only for a class reported in at least two chunks with at least three callsites. The worker receives the class, callsites, ten lines of local context, and cross-chunk index—not the implementation context or full diff. `R-recall` is not a dispatchable manifest.

The `/R-analyze` options side path starts a fresh host-native read-only exploration worker with an empty context and `options-lattice.md`; `R-options` is not a durable manifest. Axial ADR creation, singleton repair, and supersession run through `/R-adr --axial`; `R-architect` axial mode only reviews.

## Data Model & Consumers

### Data structure

| Field | Shape | Meaning |
|---|---|---|
| `DISPATCHABLE` | ordered seven-role tuple | Complete durable review-role set |
| `max_agents` | positive integer, default `3` | Per-chunk total including floor and forced roles |
| `gates` | `{agent, spawn, reason}[]` | Evidence decision and reason per durable role |
| `candidates` / `agents` / `capped` | ordered role arrays | Prioritized inputs, selected output, and cap removals |
| `chunk_agents` | role array per chunk | Exact per-chunk spawn set |
| `axialOverride` | `default | always | never` | Legacy axial-only compatibility value |
| `warnings` | string array | Migration, cap, parse, and compatibility notices surfaced by the workflow |

### Consumers

| Consumer | Consumes | Purpose |
|---|---|---|
| `dev-review/roster.ts` and `roster.sh` | diff paths, stack paths, oracle result, axial ADR state, roster config | Compute deterministic global and per-chunk outputs |
| `/R-dev-review` | `chunk_agents`, reasons, warnings | Spawn exact durable roles and isolated recall workers |
| `R-architect` | dispatch mode and assigned artifact/chunk | Run normal structural review or read-only axial review |
| `/R-analyze` | `options-lattice.md` and analysis path | Run isolated option-space analysis on demand |
| `/R-adr` and `/R-dev-init` | `--axial` flow and axial ADR state | Create, retain, repair, or supersede the unique axial ADR |
| Stack examples, READMEs, and tests | durable roles, defaults, compatibility text | Keep advertised and executable behavior aligned |

## Breadboard

| ID | Element | Handler | Data |
|---|---|---|---|
| U1 | Durable role catalog | `DISPATCHABLE` | Seven ordered role names |
| U2 | Evidence classifier and priority | `computeRoster` / `prioritizeCandidates` | Paths, domain counts, oracle result, axial state |
| U3 | Per-chunk allocator | `allocateReview` | `max_agents`, `chunk_agents`, `capped`, warnings |
| U4 | Axial review mode | `R-architect` + `/R-dev-review` prompt | Axial ADR, axial delta, structural scope |
| U5 | Legacy config translation | `parseRosterConfig` | Removed keys, canonical overrides, warnings |
| U6 | Native procedural workers | `/R-dev-review` recall + `/R-analyze` options side path | Class index or option lattice inputs |
| U7 | Axial ADR writer | `/R-adr --axial` invoked by `/R-dev-init` | Unique axial ADR lifecycle |
| U8 | Parity surfaces | stack examples, SKILL/README files, Vitest suites | Roster contract and compatibility behavior |

Wiring: U1 + U2 → U3 → exact review dispatch. U4 + U5 feed U2. U6 runs outside the durable roster. U7 owns axial ADR writes consumed by U4. U8 checks every public surface against U1–U7.

## Slices

| # | Name | Scope | Demo |
|---|---|---|---|
| V1 | Bounded durable roster | U1, U2, U3 | A mixed-evidence chunk returns the adversarial floor plus the two highest-priority specialists under the default cap |
| V2 | Axial consolidation and migration | U4, U5, U7 | Axial evidence selects `R-architect` axial mode; legacy and canonical overrides produce order-independent results and notices; ADR creation enters `/R-adr --axial` |
| V3 | Procedural isolation and parity | U6, U8 | Recall/options run as isolated native workers while examples, docs, and tests expose only the seven durable roles and current defaults |

## Success Criteria

- [ ] **SC-1:** The exported dispatch tuple and `/R-dev-review` dispatch table contain exactly the seven entries in the Durable roster table, in the same order, and contain no phase-agent entries. (`skill-roster-parity.test.ts`)

- [ ] **SC-2:** With no `max_agents` setting, each chunk reports `max_agents: 3` and selects no more than three total roles, including the adversarial floor. (`roster.test.ts`)

- [ ] **SC-3:** For identical diff paths, stack paths, oracle result, axial state, and overrides, candidate and capped ordering equals the priority sequence in Expected Behavior; frontend/backend dominance is determined by matching file counts, and configured `always` roles remain selected with a cap-raise notice when required. (`roster.test.ts` cap and domain-dominance cases)

- [ ] **SC-4:** An axial ADR plus an axial-path delta selects `R-architect` with an `axial:*` reason and a read-only axial-mode prompt; a legacy axial-review override emits the rename notice and applies only to axial mode, while a conflicting non-default `R-architect` override wins globally with identical results for either YAML key order and emits the conflict notice. (`roster.test.ts`, `skill-roster-parity.test.ts`, `always-panel-floor.test.ts`)

- [ ] **SC-5:** Multi-chunk recall and the analysis `options` reaction use fresh host-native read-only exploration workers with the documented isolated inputs, no `R-recall` or `R-options` dispatch manifest remains, and axial ADR creation, repair, and supersession route through `/R-adr --axial`. (`always-panel-floor.test.ts` plus structural assertions over the review, analyze, dev-init, ADR, and architect skill files)

- [ ] **SC-6:** Root and plugin stack examples advertise `max_agents: 3` and only the seven durable role keys, while dev-review documentation and focused tests describe the same per-chunk priority, axial compatibility notices, isolated-worker ownership, and ADR routing. (`roster-example-keys.test.ts`, `skill-roster-parity.test.ts`, `always-panel-floor.test.ts`, and precise documentation assertions)

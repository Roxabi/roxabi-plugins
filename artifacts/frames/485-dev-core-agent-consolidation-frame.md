---
title: "Dev-core: consolidate durable review agent roles"
issue: 485
status: approved
tier: F-lite
date: 2026-09-16
---

## Problem

The dev-core review workflow dispatches too many narrowly specialized agents. Their overlapping mandates increase selection and coordination cost, while each additional pass contributes less distinct review value and makes the roster harder to maintain.

**Why now:** the workflow already has a three-agent default cap, but capping the same fragmented roster only suppresses excess dispatch. It does not define which expertise is durable, ensure the highest-value reviewers win the cap from concrete diff evidence, or remove procedural roles that do not justify permanent manifests.

## Who

- **Primary:** contributors and maintainers running dev-core review workflows who need focused, predictable expert feedback without agent-sprawl overhead.
- **Secondary:** dev-core maintainers evolving roster configuration, compatibility behavior, documentation, and tests over time.

## Constraints

- Consolidate the roster to seven durable expert review roles and select within the three-agent default cap deterministically from concrete diff evidence.
- Preserve isolated, read-only execution for procedural recall and option-space analysis without retaining dedicated review-agent manifests.
- Support axial drift review through `R-architect` axial mode.
- Handle legacy axial-review roster overrides explicitly with migration warnings rather than silently ignoring or misrouting them.
- Keep documentation and automated tests aligned with the same roster behavior; their fan-out does not expand the change beyond dev-core review configuration.

## Out of Scope

- Redesigning the full review lifecycle, its findings contract, or its approval gates.
- Adding new specialist roles or increasing the default concurrent-agent cap.
- Replacing evidence-based reviewer selection with free-form model discretion.
- Changing implementation outside dev-core review configuration, its compatibility path, documentation, and directly associated tests.

## Premise Validity

**Success in 6 months:** the shipped default roster still contains exactly seven durable review roles; a review dispatches at most three of them by deterministic diff-evidence priority; axial drift work routes through `R-architect` axial mode; procedural recall and option analysis run as isolated read-only workers; and legacy axial-review overrides produce an explicit migration warning. Maintainers update one durable role map rather than parallel specialist manifests, with documentation and tests describing the same behavior.

**Failure in 6 months:** the roster has regrown beyond seven durable roles, default reviews routinely exceed three agents, or identical diff evidence selects different reviewers. Failure also includes axial or procedural work requiring restored dedicated manifests, or legacy overrides being silently accepted, dropped, or routed without a warning.

**Simplest alternative:** only lower `max_agents` to three while leaving the specialized roster and dispatch model unchanged.

**Why not simplest:** a cap controls quantity after selection, not role quality or ownership. The overlapping manifests, ambiguous evidence priority, procedural-role permanence, and migration behavior remain; relevant expertise can lose an arbitrary slot while maintainers still carry the full fragmented roster.

## Complexity

**Tier: F-lite** — from `size:F-lite`. The scope is clear and contained to one dev-core review-configuration domain; documentation and test updates are contract fan-out, not additional product domains or an architectural redesign.

Signals observed:
- Issue label `size:F-lite`.
- One bounded roster consolidation with explicit target roles, cap, routing, and compatibility behavior.
- No unresolved product or architecture choices.

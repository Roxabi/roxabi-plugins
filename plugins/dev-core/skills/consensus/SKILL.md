---
name: consensus
argument-hint: '["problem" | --issue <N> | --analysis <path>]'
description: Multi-expert panel consensus — spawn 3 domain agents to debate and agree on best long-term solution. Triggers: "consensus" | "panel review" | "expert panel" | "get a consensus" | "multiple perspectives" | "tribunal" | "3-man panel" | "panel decision".
version: 0.1.0
allowed-tools: Bash, Read, Write, Edit, Glob, Grep, Agent, ToolSearch
---

# Consensus

## Success

I := κ written ∧ committed ∧ `status: consensus-reached`
V := `git log --oneline -1 | grep consensus` ∧ `ls artifacts/analyses/*consensus*.mdx`

Let:
  κ := artifacts/analyses/{N}-{slug}-consensus.mdx
  φ := frame doc (optional input)
  α := analysis doc (optional input)
  P := panel (|P| = 3)
  αᵢ ∈ P := panel agent
  ρ := recommendation
  ω := option/choice
  ξ := concern(s)
  δ := recorded dissent
  DP := read `${CLAUDE_PLUGIN_ROOT}/../shared/references/decision-presentation.md`

Spawn P → ∥ analysis → debate → consensus → κ.

## Entry

```
/consensus "text" | --issue N | --analysis <path>
```

## Pipeline

| Step | ID | Req | Verifies | Notes |
|------|----|----|----------|-------|
| 0 | resolve | ✓ | input parsed | — |
| 1 | select | ✓ | P assigned | context-aware |
| 2 | analyze | ✓ | ∀αᵢ returns | ∥ spawn |
| 3 | debate | ✓ | convergence ∨ deadlock | — |
| 4 | resolve | ✓ | consensus | — |
| 5 | write | ✓ | κ written | — |

## Pre-flight

Steps: resolve → select → analyze → debate → resolve → write
¬clear → STOP + ask: "What problem needs consensus?"

## Step 0 — Resolve Input

| Input | Action |
|-------|--------|
| `"text"` | Use verbatim |
| `--issue N` | `gh issue view N --json title,body,labels` + glob frame/analysis |
| `--analysis <path>` | Read → extract problem, shapes, constraints |

∃ φ ∨ α → pre-fill, skip framing. ¬input → ask.

## Step 1 — Select Panel

P₁ := **architect** (always). P₂, P₃ context-selected:

| Slot | Candidates | Select when |
|------|------------|-------------|
| P₂ | devops, security-auditor | infra/deploy/CI → devops; auth/data/security → security-auditor |
| P₃ | product-lead, backend-dev, frontend-dev | UX/business → product-lead; pure backend → backend-dev; UI-heavy → frontend-dev |

Default: architect + devops + product-lead.

Context unclear → DP: panel composition options.

## Step 2 — Independent Analysis (∥)

∀ αᵢ ∈ P → spawn ∥ `Agent(subagent_type: "<αᵢ>", prompt: ANALYSIS_PROMPT)`.

**ANALYSIS_PROMPT:**
```
You are {αᵢ} on a 3-expert consensus panel.
Context: {problem, constraints, existing analysis}
Role: {ROLE}

Analyze:
1. Best long-term ρ?
2. Top 3 trade-offs?
3. Rejected ω + why?
4. Blocking ξ?

Format: **ρ:** | **Trade-offs:** | **Rejected:** | **Blocking ξ:**
```

**Roles by α:**

| α | Focus |
|---|-------|
| architect | arch soundness, maintainability, scalability |
| devops | ops impact, deploy, monitoring, infra cost |
| security-auditor | security, attack surface, compliance |
| product-lead | user impact, business value, time-to-market |
| backend-dev | impl complexity, API design |
| frontend-dev | UX, component arch, client perf |

Collect |P| responses → Step 3.

## Step 3 — Structured Debate

### 3a. Convergence Check

| Scenario | Action |
|----------|--------|
| ∀ αᵢ agree | → Step 4 |
| 2 agree, 1 differs | → 3b (reconciliation) |
| ∀ αᵢ differ | → 3c (extended debate) |

### 3b. Reconciliation (2-1 split)

Present to dissenting αᵢ:
```
Majority ρ: {ρ_maj}
Your ρ: {ρ_dis}
Majority ξ about your ω: {ξ_maj}

Options: Accept (δ recorded) | Hybrid | Escalate
```

- Accept → record δ → Step 4
- Hybrid → new ω → majority vote
- Escalate → DP to user

### 3c. Extended Debate (∀ differ)

Present ∀ ρᵢ to each αᵢ:
```
Panel ρ: {ρ₁, ρ₂, ρ₃}
Cross-ξ: {each αᵢ's ξ about others}

Task: Rank ω (1=best, 3=worst). Propose compromise if no winner.
```

Collect rankings:
- ∃ ω ranked #1 by ≥2 αᵢ → consensus (δ recorded)
- No winner → mediator round (architect proposes hybrid addressing ∀ ξ)

Mediator: architect hybrid → panel vote → accept ∨ escalate.

## Step 4 — Consensus Resolution

Record: ρ, confidence (high/med/low), trade-offs, δ, alternatives.

## Step 5 — Write κ

```mdx
---
title: "{title} — Expert Consensus"
issue: {N | null}
status: consensus-reached
date: {YYYY-MM-DD}
panel: {α₁}, {α₂}, {α₃}
confidence: {high|medium|low}
---

## Problem

{problem}

## Panel

| α | Focus |
|---|-------|
| {α₁} | {focus₁} |
| {α₂} | {focus₂} |
| {α₃} | {focus₃} |

## Consensus ρ

{agreed ω}

### Rationale

{why won}

### Trade-offs

- {t₁}, {t₂}, {t₃}

## Alternatives

| ω | Proposed by | Rejected because |
|---|-------------|------------------|
| {ω₁} | {α} | {reason} |

## Dissent

{δ if ∃; else "None — unanimous."}

## Implementation Notes

{guidance}

## Next

{/spec, /plan, etc.}
```

## Completion

κ written → commit: `docs(consensus): {title}`.

## Edge Cases

| Scenario | Behavior |
|----------|----------|
| αᵢ fails | Retry ×1; still fails → 2-agent consensus, note missing |
| Deadlock ×3 rounds | DP to user |
| Hybrid mid-debate | Full panel vote |
| No frame/analysis | Proceed with issue text |

## Chain Position

- **Phase:** Shape (pre-spec)
- **Predecessor:** `/frame` ∨ `/analyze` ∨ raw issue
- **Successor:** `/spec`
- **Class:** gate

## Task Integration

- `/dev` may invoke (F-full analyze phase)
- Standalone: callable anytime
- Sub-tasks: none (spawns α, not tasks)

## Exit

- Consensus → write κ, commit, summary. Stop.
- Escalated → present ω + ξ → user decides → write κ. Stop.
- Failed → report error, suggest retry.

$ARGUMENTS

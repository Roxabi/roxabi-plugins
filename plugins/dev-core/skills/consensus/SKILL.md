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
  P := panel (3 agents: architect + 2 context-selected)
  DP := Present decision via protocol: read `${CLAUDE_PLUGIN_ROOT}/../shared/references/decision-presentation.md`

Spawn 3 domain experts → independent analysis → structured debate → consensus on best long-term solution.
Outputs: recommendation + alternatives + trade-offs + dissent notes.

## Entry

```
/consensus "problem text"      → seed from free text
/consensus --issue N           → seed from issue + existing frame/analysis
/consensus --analysis <path>   → seed from existing analysis doc
```

## Pipeline

| Step | ID | Required | Verifies via | Notes |
|------|----|----------|---------------|-------|
| 0 | resolve | ✓ | input parsed | — |
| 1 | select | ✓ | P assigned | context-aware panel composition |
| 2 | analyze | ✓ | 3 agents return | ∥ spawn |
| 3 | debate | ✓ | convergence ∨ deadlock | structured exchange |
| 4 | resolve | ✓ | consensus reached | — |
| 5 | write | ✓ | κ written | — |

## Pre-flight

Success: κ written ∧ committed ∧ consensus reached
Evidence: `ls artifacts/analyses/*consensus*.mdx`
Steps: resolve → select → analyze → debate → resolve → write
¬clear → STOP + ask: "What problem needs consensus?"

## Step 0 — Resolve Input

Parse args:

| Input | Action |
|-------|--------|
| `"problem text"` | Use verbatim as context |
| `--issue N` | `gh issue view N --json title,body,labels` + glob frame/analysis for N |
| `--analysis <path>` | Read doc → extract problem, shapes, constraints |

∃ φ ∨ α → pre-fill context, skip framing questions.

¬input → ask: "Describe the problem requiring expert consensus."

## Step 1 — Select Panel

Auto-select P based on context. Always: **architect** (system design lead).

| Slot | Agents | Select when |
|------|--------|-------------|
| 2 | devops, security-auditor | ∃ infra/deploy/CI concerns → devops; ∃ auth/data/security → security-auditor |
| 3 | product-lead, backend-dev, frontend-dev | ∃ user/UX/business impact → product-lead; pure backend → backend-dev; UI-heavy → frontend-dev |

Default panel: **architect** + **devops** + **product-lead**.

If context unclear → DP: "Select panel composition:
1. **Architect + DevOps + Product-Lead** (default — covers tech + ops + business)
2. **Architect + DevOps + Security-Auditor** (infra/security focus)
3. **Architect + Backend-Dev + Frontend-Dev** (pure implementation focus)
4. **Custom** (specify 3 from: architect, devops, security-auditor, product-lead, backend-dev, frontend-dev)"

## Step 2 — Independent Analysis (∥)

∀ a ∈ P → spawn ∥ `Agent(subagent_type: "<a>", prompt: "{ANALYSIS_PROMPT}")`.

**ANALYSIS_PROMPT template:**

```
You are {a.name} on a 3-expert consensus panel.

Context:
{problem statement, constraints, existing analysis if ∃}

Your role: {ROLE}

Analyze from your domain perspective:
1. What is the best long-term solution?
2. What are the top 3 trade-offs?
3. What alternatives did you reject and why?
4. What concerns would block your approval?

Format your response:
- **Recommendation:** {your top choice}
- **Trade-offs:** {bullets}
- **Rejected alternatives:** {bullets with reason}
- **Blocking concerns:** {bullets or "None"}
```

**Roles by agent:**

| Agent | Role |
|-------|------|
| architect | Evaluate architectural soundness, maintainability, scalability, system coherence |
| devops | Evaluate operational impact, deploy complexity, monitoring, reliability, infra cost |
| security-auditor | Evaluate security posture, attack surface, compliance, data protection |
| product-lead | Evaluate user impact, business value, time-to-market, opportunity cost |
| backend-dev | Evaluate implementation complexity, code maintainability, API design |
| frontend-dev | Evaluate UX impact, component architecture, client performance |

Collect all 3 responses → proceed to Step 3.

## Step 3 — Structured Debate

### 3a. Convergence Check

Compare recommendations:

| Scenario | Action |
|----------|--------|
| All 3 agree | → Step 4 (consensus reached) |
| 2 agree, 1 differs | → structured reconciliation |
| All differ | → extended debate round |

### 3b. Reconciliation (2-1 split)

Present split to dissenting agent:

```
Panel majority recommends: {majority choice}
Your recommendation: {dissenting choice}

Respond to these concerns from the majority:
{majority's blocking concerns about your choice}

Options:
1. Accept majority recommendation with recorded dissent
2. Propose hybrid/compromise that addresses majority concerns
3. Escalate to user decision
```

Dissenting agent chooses:
- **Accept** → record dissent → Step 4
- **Hybrid** → new option → majority vote on hybrid
- **Escalate** → DP to user

### 3c. Extended Debate (all differ)

Present all 3 options to each agent:

```
Panel recommendations:
1. {agent1}: {rec1}
2. {agent2}: {rec2}
3. {agent3}: {rec3}

Cross-concerns:
{each agent's concerns about the others' choices}

Task: Rank all 3 options (1=best, 2=acceptable, 3=worst).
Provide compromise proposal if no clear winner emerges.
```

Collect rankings:

- ∃ option ranked #1 by ≥2 agents → consensus (minority dissent recorded)
- No clear winner → spawn **mediator** round (architect leads compromise synthesis)

Mediator round:
1. Architect proposes hybrid solution addressing all blocking concerns
2. Panel votes: accept hybrid ∨ escalate to user
3. Accept → consensus; Escalate → DP to user

## Step 4 — Consensus Resolution

Consensus reached. Record:

| Field | Value |
|-------|-------|
| Recommendation | Agreed solution |
| Confidence | high/medium/low (based on debate rounds) |
| Trade-offs | Agreed trade-offs |
| Dissent | Any recorded dissent with rationale |
| Alternatives considered | All options evaluated |

## Step 5 — Write Consensus Doc

Write κ:

```mdx
---
title: "{title} — Expert Consensus"
issue: {N | null}
status: consensus-reached
date: {YYYY-MM-DD}
panel: {agent1}, {agent2}, {agent3}
confidence: {high|medium|low}
---

## Problem

{problem statement}

## Panel

| Agent | Role |
|-------|------|
| {a1} | {role1} |
| {a2} | {role2} |
| {a3} | {role3} |

## Consensus Recommendation

{agreed solution}

### Rationale

{why this solution won the panel debate}

### Trade-offs

- {agreed trade-off 1}
- {agreed trade-off 2}
- {agreed trade-off 3}

## Alternatives Considered

| Option | Proposed by | Rejected because |
|--------|-------------|------------------|
| {alt1} | {agent} | {reason} |
| {alt2} | {agent} | {reason} |

## Dissent

{If ∃ dissent: agent — rationale. If none: "None — unanimous consensus."}

## Implementation Notes

{Key guidance from panel for implementation}

## Next Steps

{Recommended follow-up: /spec, /plan, etc.}
```

## Completion

κ written. Commit:

```bash
git add artifacts/analyses/{N}-{slug}-consensus.mdx
git commit -m "docs(consensus): {title}"
```

Inform: "Consensus reached. Panel recommendation: {solution}. Doc: artifacts/analyses/{slug}-consensus.mdx"

## Edge Cases

| Scenario | Behavior |
|----------|----------|
| Agent fails to return | Retry once; still fails → proceed with 2-agent consensus, note missing perspective |
| Deadlock after 3 rounds | DP to user with options + trade-offs; user decides |
| Hybrid proposed mid-debate | Full panel votes on hybrid as new option |
| Issue lacks frame/analysis | Proceed with issue text as context; note missing depth |

## Chain Position

- **Phase:** Shape (pre-spec)
- **Predecessor:** `/frame` ∨ `/analyze` ∨ raw issue
- **Successor:** `/spec` (use consensus recommendation as input)
- **Class:** gate (consensus must be reached before proceeding)

## Task Integration

- `/dev` may invoke this as sub-step in analyze phase for F-full
- Standalone: callable anytime for expert panel review
- Sub-tasks created: none (spawns agents, not tasks)

## Exit

- **Consensus reached:** write κ, commit, print summary line. Stop.
- **Escalated to user:** present options + trade-offs → user decides → write κ with user choice. Stop.
- **Failed:** report error (e.g., all agents failed). Suggest retry with different panel.

$ARGUMENTS

---
name: frame
argument-hint: '["idea" | --issue <N>]'
description: Problem framing — capture problem, constraints, scope, tier. Triggers: "frame" | "frame this" | "what's the problem" | "define the problem" | "scope this out" | "define the scope" | "what are we solving" | "help me think through this problem" | "problem statement".
version: 0.5.0
allowed-tools: Bash, Read, Write, Edit, Glob, Grep, ToolSearch
---

# Frame

## Success

I := φ written ∧ status: approved
V := `cat artifacts/frames/{N}-{slug}-frame.md | head -10 | grep "status: approved"`

Let:
  φ := artifacts/frames/{N}-{slug}-frame.md (∃N) ∨ artifacts/frames/{slug}-frame.md (frame-only)
  N := issue number (∅ if free text)
  τ := tier ∈ {S, F-lite, F-full}
  AQ := present choice, wait for user reply
  gap := field/answer not extractable from seed with high confidence

idea | issue → approved frame doc. Interview → detect τ → write φ → approve.
**Default-auto when unambiguous:** AQ only for real gaps. ¬re-ask confirmations whose answer is already determined.
Standalone-safe: callable without `/dev`. Output consumed by `/analyze`, `/spec`, `/dev`.

## Entry

```
/frame "text"       → seed from free text
/frame --issue N    → seed from GitHub issue title + body
```

## Pipeline

| Step | ID | Required | Verifies via | Notes |
|------|----|----------|---------------|-------|
| 0 | parse | ✓ | `gh issue view N` → JSON | auto-reuse approved; auto-continue draft |
| 1 | interview | — | — | only missing gaps; 0 AQ if seed complete |
| 1b | premise | ✓ | 3 fields non-empty | extract from seed if present; AQ only gaps |
| 2 | tier | ✓ | τ ∈ frontmatter | auto if label/signals unanimous; AQ if contested |
| 3 | write | ✓ | φ ∃ | — |
| 4 | approval | ✓ | `status: approved` | auto if zero gaps this run; else AQ |

## Pre-flight

Success: φ written ∧ status: approved
Evidence: `ls artifacts/frames/` after execution
Steps: parse → interview → premise-gate → tier → write → approval
¬clear → STOP + ask: "What problem are you solving?"

## AQ policy (global)

```
if answer is uniquely determined by seed/labels/existing artifact → act, print one-line note, ¬AQ
if ≥2 plausible paths with different outcomes → AQ
```

Never invent premise fields. Prefer extract-from-seed over asking.

## Step 0 — Parse + Seed

`--issue N` →
```bash
gh issue view N --json number,title,body,labels
```
Extract: title, body, labels → seed context (S/M/L/XL label → τ hint).
Free text → use verbatim as seed.

Derive slug: lowercase, kebab-case, ≤5 words.

Check ∃ φ:
```bash
# glob artifacts/frames/*{slug}*
```

### Existing artifact (auto when unambiguous)

| State | Action | AQ? |
|-------|--------|-----|
| ∃ φ ∧ `status: approved` | **Reuse** — print `Reusing approved frame {path} (tier={τ}).` → **Exit** (already done). ¬re-approve. | ¬ |
| ∃ φ ∧ `status: draft` ∧ all required sections non-empty | **Continue draft** — print `Continuing draft frame {path}.` → Step 2 (re-detect τ if missing) → Step 3 overwrite → Step 4 | ¬ at Step 0 |
| ∃ φ ∧ `status: draft` ∧ incomplete (empty Problem / Premise / …) | **Continue draft** silently → Step 1 for remaining gaps only | ¬ at Step 0 |

¬offer "Re-frame" / "Start fresh" as a blocking prompt. User can say "re-frame" or "start fresh" in chat to force Step 1 from scratch — reactive, not proactive AQ.

## Step 1 — Interview

3–5 questions max. **Skip any answer clear from seed.** Group remaining into **at most one** AQ call. If zero gaps → print nothing for this step, continue.

| # | Question | Skip if |
|---|----------|---------|
| 1 | What is the problem/pain? What triggers this? | Issue body has clear problem |
| 2 | Who is affected? Primary + secondary users. | Issue body names users |
| 3 | What constraints apply? (time, tech, dependencies) | Labels or body imply these |
| 4 | What is explicitly out of scope? | Scope already narrow or body lists non-goals |
| 5 | Related work, prior attempts, adjacent issues? | always optional — skip unless seed is thin |

¬ask all 5 if seed is rich — ask only what's missing.
Track `interview_gaps = count of questions actually asked` (0 when fully skipped).

## Step 1b — Premise-Validity Gate

**Gate: cannot proceed to Step 2 without all 3 fields filled** — but fill from seed first.

### 1b.0 Extract from seed (no AQ)

Scan issue body / free-text / draft φ for sections or headings matching (case-insensitive):
- success / success criteria / outcome in 6 months / definition of done
- failure / failure mode / abort if / kill criteria
- simplest / alternative / why not / MVP insufficient

If a field is already present and meets evaluation rules → use it, mark filled.

### 1b.1 AQ only for remaining gaps

| Field | Prompt | Requirement |
|-------|--------|-------------|
| `success_in_6mo` | "What does success look like in 6 months?" | Concrete, observable outcome — ¬vague ("things are better") |
| `failure_in_6mo` | "What does failure look like in 6 months?" | Must be **falsifiable** — measurable outcome + time horizon |
| `simplest_alternative` | "What's the simplest version that would meet the goal — and why isn't it enough?" | Both halves required |

- All 3 extractable → print one line `Premise extracted from seed.` → Step 2. ¬AQ.
- Partial → single AQ with **only the missing fields** (not the full triad again).
- None → single AQ with all 3 (present together).

Evaluation rules:

- `failure_in_6mo` ¬falsifiable (e.g. "people aren't happy") → reject, re-ask that field only.
- `simplest_alternative` omits "why not" → re-ask that half only.
- Any field empty or ≤5 words → treat as unanswered.

**Abort signal:** if `failure_in_6mo` matches proxy-metric patterns (bookkeeping compliance, annotation density, ticket-close rate as sole success, etc.) → surface: "This failure mode suggests the premise may be invalid." AQ: **Reframe** | **Abort**.

Canonical proxy-metric patterns (LLM anchors — any of these triggers the abort signal):
- "compliance count stays the same / unchanged"
- "annotation density doesn't move"
- "ticket-close rate doesn't improve"
- "dashboard stays red / metric won't budge"
- "we'd still have the underlying problem but with extra bookkeeping"

Origin: Roxabi/lyra#1162 — quality-debt annotation infrastructure where the ratchet measured bookkeeping, not quality.

Track `premise_gaps = count of fields that required AQ`.

## Step 2 — Tier Detection

Auto-detect τ from complexity signals:

| Signal | Infers |
|--------|--------|
| ≤3 files, single domain, ¬new arch | S |
| Clear scope, single domain, ¬unknowns | F-lite |
| Multiple domains ∨ new patterns ∨ unknowns ∨ XL label | F-full |
| Issue label S ∨ XS | S |
| Issue label M | F-lite |
| Issue label L ∨ XL | F-full |

See [tier-classification.md](${CLAUDE_PLUGIN_ROOT}/skills/shared/references/tier-classification.md) for canonical rules.

### Auto vs AQ

| Condition | Action |
|-----------|--------|
| Issue has size label XS/S/M/L/XL | τ from label (label wins). Print `Tier {τ} (from size label).` ¬AQ |
| No size label ∧ signals unanimous (all point to same τ) | use that τ. Print `Tier {τ} (auto).` ¬AQ |
| No size label ∧ signals contested (split) | default higher τ; AQ: **Confirm {τ}** \| **Override → S** \| **Override → F-lite** \| **Override → F-full** |
| `/dev` already passed τ via context (φ.tier already set this session) | reuse. ¬AQ |

Track `tier_aq = true` only if Confirm AQ fired.

## Step 3 — Write Frame Doc

Write φ with `status: draft`:

```md
---
title: {title}
issue: {N | null}
status: draft
tier: {τ}
date: {YYYY-MM-DD}
---

## Problem

{1–3 paragraphs: what, why now, observable impact}

## Who

- **Primary:** {user + their workflow}
- **Secondary:** {other affected parties if ∃}

## Constraints

- {technical / time / dependency constraints as bullets}

## Out of Scope

- {explicit non-goals as bullets}

## Premise Validity

**Required — populated from Step 1b. ¬leave blank.**

**Success in 6 months:** {concrete, observable outcome}

**Failure in 6 months:** {falsifiable condition — observable ∧ actionable}

**Simplest alternative:** {minimal version that meets the goal}
**Why not simplest:** {explicit reason the simpler path is insufficient}

## Complexity

**Tier: {τ}** — {1-sentence rationale}

{Signals observed: bullets from Step 2 detection}
```

## Step 4 — User Approval

### Auto-approve when unambiguous

```
unambiguous := interview_gaps == 0 ∧ premise_gaps == 0 ∧ ¬tier_aq
```

If unambiguous:
1. Present a short summary (problem one-liner, τ, constraints) as **prose/output — not AQ**.
2. Set `status: approved` immediately.
3. Print: `Frame auto-approved (seed complete, no gaps).`
4. Continue to Completion.

If ¬unambiguous (any gap required AQ this run):
1. Present summary: problem statement, τ, key constraints, scope boundary.
2. AQ: **Approve** | **Revise** (specify what to change).
3. **Revise** → apply edits → re-present → loop until Approve.
4. **Approve** → update frontmatter `status: approved` via Edit.

## Completion

φ written with `status: approved`.

Commit: `git add artifacts/frames/{N}-{slug}-frame.md` + commit per CLAUDE.md Rule 5.

∃ N →
```bash
bun ${CLAUDE_PLUGIN_ROOT}/skills/issue-triage/triage.ts set N --status Analysis
```

- **Via `/dev`:** return silently after commit. ¬ask "proceed to /analyze?".
- **Standalone:** print one line: `Approved. Next: /analyze --issue N` (F-full) or `/spec --issue N` (F-lite).

## Edge Cases

- Free text ∧ ¬clear slug → derive from first 4 nouns/verbs. AQ only if two equally good slugs (rare); else auto.
- Issue ¬exists (gh 404) → proceed in free-text mode using title as seed.
- Tier contested (signals split evenly) → default to higher τ; AQ Confirm (only contested path).
- User says "re-frame" after auto-reuse → reset, run Step 1 fresh.
- User approves then requests major change → reset `status: draft`, revise, re-approve (AQ).

## Chain Position

- **Phase:** Frame
- **Predecessor:** `/issue-triage` (or free-text entry)
- **Successor:** `/analyze` (F-full) ∨ `/spec` (F-lite)
- **Class:** gate (approved artifact required; AQ only when gaps remain)

## Task Integration

- `/dev` owns the dev-pipeline task lifecycle externally
- This skill does NOT update its own dev-pipeline task
- Sub-tasks created: none

## Exit

- **Approved via `/dev`:** write artifact with `status: approved`, commit, return silently. ¬ask "proceed to /analyze?". `/dev` re-scans and auto-chains to successor in the same turn.
- **Approved standalone:** print one line: `Approved. Next: /analyze --issue N` (F-full) or `/spec --issue N` (F-lite). Stop.
- **Reuse existing approved:** print one-line reuse note, return (Σ.frame already true).
- **Modify requested:** loop in-skill, re-present.
- **Rejected/aborted:** return → `/dev` marks task `cancelled`.

$ARGUMENTS

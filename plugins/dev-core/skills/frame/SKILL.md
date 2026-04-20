---
name: frame
argument-hint: '["idea" | --issue <N>]'
description: Problem framing — capture problem, constraints, scope, tier. Triggers: "frame" | "frame this" | "what's the problem" | "define the problem" | "scope this out" | "define the scope" | "what are we solving" | "help me think through this problem" | "problem statement".
version: 0.2.0
allowed-tools: Bash, Read, Write, Edit, Glob, Grep, ToolSearch
---

# Frame

## Success

I := φ written ∧ status: approved
V := `cat artifacts/frames/{N}-{slug}-frame.mdx | head -10 | grep "status: approved"`

Let:
  φ := artifacts/frames/{N}-{slug}-frame.mdx (∃N) ∨ artifacts/frames/{slug}-frame.mdx (frame-only)
  N := issue number (∅ if free text)
  τ := tier ∈ {S, F-lite, F-full}
  AQ := Present decision via protocol: read `${CLAUDE_PLUGIN_ROOT}/../shared/references/decision-presentation.md`

idea | issue → approved frame doc. Interview → detect τ → write φ → user approves.
Standalone-safe: callable without `/dev`. Output consumed by `/analyze`, `/spec`, `/dev`.

## Entry

```
/frame "text"       → seed from free text
/frame --issue N    → seed from GitHub issue title + body
```

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

∃ φ ∧ `status: approved` → AQ: **Use existing** (→ Step 4) | **Re-frame** (→ Step 1, fresh).
∃ φ ∧ `status: draft` → AQ: **Continue draft** (→ Step 3) | **Start fresh** (→ Step 1).

## Step 1 — Interview

3–5 questions max. Skip answers clear from seed. Group into 1–2 AQ calls.

| # | Question | Skip if |
|---|----------|---------|
| 1 | What is the problem/pain? What triggers this? | Issue body has clear problem |
| 2 | Who is affected? Primary + secondary users. | Issue body names users |
| 3 | What constraints apply? (time, tech, dependencies) | Labels or body imply these |
| 4 | What is explicitly out of scope? | Scope already narrow |
| 5 | Related work, prior attempts, adjacent issues? | ∅ context → optional |

¬ask all 5 if seed is rich — ask only what's missing.

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

AQ: **Confirm {τ}** | **Override → S** | **Override → F-lite** | **Override → F-full**

## Step 3 — Write Frame Doc

Write φ with `status: draft`:

```mdx
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

## Complexity

**Tier: {τ}** — {1-sentence rationale}

{Signals observed: bullets from Step 2 detection}
```

## Step 4 — User Approval

Present summary: problem statement, τ, key constraints, scope boundary.
AQ: **Approve** | **Revise** (specify what to change).

**Revise** → apply edits inline → re-present → loop until Approve.
**Approve** → update frontmatter `status: approved` via Edit.

## Completion

φ written with `status: approved`.

Commit: `git add artifacts/frames/{N}-{slug}-frame.mdx` + commit per CLAUDE.md Rule 5.

∃ N →
```bash
bun ${CLAUDE_PLUGIN_ROOT}/skills/issue-triage/triage.ts set N --status Analysis
```

Inform: "Frame approved. Run `/dev #N` to continue, or `/analyze --issue N` for deep technical exploration."

## Edge Cases

- Free text ∧ ¬clear slug → derive from first 4 nouns/verbs. AQ to confirm if ambiguous.
- Issue ¬exists (gh 404) → proceed in free-text mode using title as seed.
- Tier contested (signals split evenly) → default to higher τ; note: "Defaulted to {τ} — downgrade if scope narrows."
- User approves then requests major change → reset `status: draft`, revise, re-approve.

## Chain Position

- **Phase:** Frame
- **Predecessor:** `/issue-triage` (or free-text entry)
- **Successor:** `/analyze` (F-full) ∨ `/spec` (F-lite)
- **Class:** gate (user approval of frame artifact required)

## Task Integration

- `/dev` owns the dev-pipeline task lifecycle externally
- This skill does NOT update its own dev-pipeline task
- Sub-tasks created: none

## Exit

- **Approved via `/dev`:** write artifact with `status: approved`, commit, return silently. ¬ask "proceed to /analyze?". `/dev` re-scans and auto-chains to successor in the same turn.
- **Approved standalone:** print one line: `Approved. Next: /analyze --issue N` (F-full) or `/spec --issue N` (F-lite). Stop.
- **Modify requested:** loop in-skill, re-present.
- **Rejected/aborted:** return → `/dev` marks task `cancelled`.

$ARGUMENTS

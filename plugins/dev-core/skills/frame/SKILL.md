---
name: frame
argument-hint: '["idea" | --issue <N>]'
description: Problem framing — capture problem, constraints, scope, tier. Triggers: "frame" | "frame this" | "what's the problem" | "define the problem".
version: 0.1.0
allowed-tools: Bash, Read, Write, Edit, Glob, Grep
---

# Frame

Let:
  φ := artifacts/frames/{slug}.mdx
  N := issue number (∅ if free text)
  τ := tier (S | F-lite | F-full)

idea | issue → approved frame doc. Interview → detect tier → write φ → user approves.
Standalone-safe: callable without `/dev`. Output consumed by `/analyze`, `/spec`, `/dev`.

## Entry

```
/frame "text"       → seed from free text
/frame --issue N    → seed from GitHub issue title + body
```

## Step 0 — Parse + Seed

`--issue N` ⇒

```bash
gh issue view N --json number,title,body,labels
```

Extract: title, body, labels → seed context (S/M/L/XL label → tier hint).
Free text ⇒ use verbatim as seed.

Derive slug from title/text: lowercase, kebab-case, ≤5 words.

Check for ∃ φ:

```bash
# glob artifacts/frames/*{slug}*
```

∃ φ with `status: approved` ⇒ AskUserQuestion: **Use existing** (→ Step 4, show + confirm) | **Re-frame** (→ Step 1, fresh).
∃ φ with `status: draft` ⇒ AskUserQuestion: **Continue draft** (→ Step 3, present draft) | **Start fresh** (→ Step 1).

## Step 1 — Interview

3–5 questions max. Skip questions whose answers are already clear from seed context. Group into 1–2 AskUserQuestion calls.

**Core questions (adapt to gaps in seed):**

| # | Question | Skip if |
|---|----------|---------|
| 1 | What is the problem or pain point? What triggers this? | Issue body has clear problem |
| 2 | Who is affected? Primary user + secondary users. | Issue body names users |
| 3 | What constraints apply? (time, tech, dependencies) | Labels or body imply these |
| 4 | What is explicitly out of scope? What are we NOT solving? | Scope already narrow |
| 5 | Any related work, prior attempts, or adjacent issues? | ∅ context → optional |

¬ask all 5 if seed is rich — only ask what's missing.

## Step 2 — Tier Detection

Auto-detect τ from complexity signals:

| Signal | Infers |
|--------|--------|
| ≤3 files mentioned, single domain, no new arch | S |
| Clear scope, single domain, no unknowns | F-lite |
| Multiple domains, new patterns, unknowns, XL label | F-full |
| Issue label S ∨ XS | S |
| Issue label M | F-lite |
| Issue label L ∨ XL | F-full |

AskUserQuestion: **Confirm {τ}** | **Override → S** | **Override → F-lite** | **Override → F-full**.

## Step 3 — Write Frame Doc

Write φ as `artifacts/frames/{slug}.mdx` with `status: draft`.

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

Present frame summary: problem statement, tier, key constraints, scope boundary.
AskUserQuestion: **Approve** | **Revise** (specify what to change).

**Revise** ⇒ apply edits inline → re-present → loop until Approve.

**Approve** ⇒ update frontmatter `status: approved` via Edit.

## Completion

φ written at `artifacts/frames/{slug}.mdx` with `status: approved`.

Commit artifact: `git add artifacts/frames/{slug}.mdx` + commit per CLAUDE.md Rule 5.

∃ N ⇒ update issue status:
```bash
bun ${CLAUDE_PLUGIN_ROOT}/skills/issue-triage/triage.ts set N --status Analysis
```

Inform user: "Frame approved. Run `/dev #N` to continue, or `/analyze --issue N` for deep technical exploration."

## Edge Cases

- Free text with no clear slug ⇒ derive from first 4 nouns/verbs. AskUserQuestion to confirm slug if ambiguous.
- Issue ¬exists (gh returns 404) ⇒ proceed with free-text mode using title as seed.
- Tier is contested (signals split evenly) ⇒ default to higher tier, note in doc: "Defaulted to {τ} — downgrade if scope narrows."
- User approves then requests major change ⇒ reset `status: draft`, revise, re-approve.

$ARGUMENTS

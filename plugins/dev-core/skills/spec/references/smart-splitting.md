# Gate 2.5: Smart Splitting

Let: N := parent issue number | τ := tier

After spec approve (optional). Decomposes feature → sub-issues. Always optional — user opts in via free-form chat ("split"). **¬AskUserQuestion.**

## Pre-checks

1. τ S ⇒ skip entirely
2. Check ∃ sub-issues:

```bash
gh api graphql -f query='{ repository(owner: "{owner}", name: "{repo}") { issue(number: {N}) { subIssues(first: 10) { nodes { number title state } } } } }'
```

∃ sub-issues ⇒ print them as prose. Ask in free text whether to keep / replace / add — interpret next message (no tool menu).

## Trigger Detection

Read spec, count:
- Acceptance criteria: `- [ ]` in `## Success Criteria`
- Slices: rows in `## Slices` table

**Trigger:** criteria > 8 ∨ slices > 3.
¬trigger ∨ ¬(criteria ∧ slices sections) ⇒ skip (unless user explicitly said "split").

## Propose Sub-Issues

Split heuristics (priority order):
1. **Phases** (if present) → 1 sub-issue/phase
2. **Slices** → 1 sub-issue/slice (group related if >5)
3. **Domains** → group criteria by FE/BE/infra

∀ sub-issue:

| Field | Derivation |
|-------|-----------|
| Title | `feat(<scope>): <description>` |
| Scope | Which slices/affordances/criteria |
| Dependencies | Infer from slice order ∨ phase deps |
| Tier | Score via complexity rubric (Step 1a) |
| Size | XS/S/M/L/XL from τ |
| Priority | Inherit parent ∨ default Medium |

Present as **prose table** (chat), then stop:

```
## Smart Split proposal — #{N} {title}
Trigger: {criteria} criteria / {slices} slices

| # | Title | Scope | Size | Deps |
|---|-------|-------|------|------|
| 1 | … | … | S/M/L | none |
| 2 | … | … | S/M/L | #1 |

Reply free text: create / adjust … / skip
```

¬tool menus. Create only after free-form confirm.

## Create Sub-Issues

> **Decomposition pattern** (¬deferral): smart-splitting *plans* sub-deliverables, so sub-issues are `--parent <N>` of the original (N becomes the epic). This is distinct from `/fix` Phase 5 Defer, which uses the **sibling rule** (deferred issue gets the origin's parent, not the origin itself). See `issue-triage` SKILL "Deferred Follow-Ups — Sibling Rule".

```bash
bun ${CLAUDE_PLUGIN_ROOT}/skills/issue-triage/triage.ts create \
  --title "<title>" --body "<body>" \
  --parent <parent_N> --size <XS|S|M|L|XL> --priority <priority>
```

**Body template:**

```markdown
## Scope
{slices/affordances/criteria covered}

**Parent spec:** artifacts/specs/{issue}-{slug}-spec.md | **Parent issue:** #{parent}

## Acceptance Criteria
{subset from parent spec}

## Dependencies
{sibling deps}
```

Parse output `Created #N: <title>` → store mapping. Wire deps:

```bash
bun ${CLAUDE_PLUGIN_ROOT}/skills/issue-triage/triage.ts set <B> --blocked-by <A>
```

**Generate sub-specs** ∀ sub-issue at `artifacts/specs/{sub_N}-{sub_slug}-spec.md` (same frontmatter contract as parent — [artifact-frontmatter.md](${CLAUDE_PLUGIN_ROOT}/skills/shared/references/artifact-frontmatter.md); title hygiene on the sub-issue title):

```markdown
---
title: "{sub-issue title|yaml-escaped}"
description: "{one-line scope from parent}"
type: spec
status: draft
parent_spec: "artifacts/specs/{parent_issue}-{parent_slug}-spec.md"
parent_issue: {parent_N}
---

## Scope
{subset from parent}

## Success Criteria
{subset from parent}

## Reference
Full spec: [artifacts/specs/{parent_issue}-{parent_slug}-spec.md](../specs/{parent_issue}-{parent_slug}-spec.md)
```

Inform: "Created {N} sub-issues under #{parent}. Run `/dev #N` for each sub-issue in dependency order."

## Edge Cases

| Scenario | Behavior |
|----------|----------|
| Only 1 sub-issue | Skip — no value |
| Circular deps | Reject split, inform user |
| Partial creation failure | Report success/fail in prose; wait free-form retry/continue |
| Spec revised after split | Warn stale in prose; re-run Gate 2.5 on request |
| All criteria tightly coupled | Recommend skip in prose |

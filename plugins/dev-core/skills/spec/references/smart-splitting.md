# Gate 2.5: Smart Splitting

After Gate 2 approval. Decomposes feature into sub-issues. Always optional — user can skip.

## Pre-checks

1. Tier S ⇒ skip entirely
2. Check ∃ sub-issues:

```bash
gh api graphql -f query='{ repository(owner: "{owner}", name: "{repo}") { issue(number: {N}) { subIssues(first: 10) { nodes { number title state } } } } }'
```

∃ sub-issues ⇒ AskUserQuestion: Keep existing | Replace (close old) | Add additional

## Trigger Detection

Read spec, count:
- Acceptance criteria: `- [ ]` checkboxes in `## Success Criteria`
- Slices: rows in `## Slices` table

**Trigger when:** criteria > 8 ∨ slices > 3.
¬trigger ∨ ¬(criteria ∧ slices sections) ⇒ skip.

## Propose Sub-Issues

Split heuristics (priority order):
1. **Phases** (if present) → 1 sub-issue per phase
2. **Slices** → 1 sub-issue per slice (group related if >5)
3. **Domains** → group criteria by FE/BE/infra

∀ sub-issue:

| Field | Derivation |
|-------|-----------|
| Title | `feat(<scope>): <description>` |
| Scope | Which slices/affordances/criteria |
| Dependencies | Infer from slice order ∨ phase deps |
| Tier | Score via complexity rubric (Step 1a) |
| Size | XS/S/M/L/XL from tier |
| Priority | Inherit parent ∨ default Medium |

Present via AskUserQuestion:

```
Smart Split: {title}
Parent: #{N} | Trigger: {criteria}/{slices}/{phases}

  1. {title} — {scope} [Size: {S/M/L}] Deps: none
  2. {title} — {scope} [Size: {S/M/L}] Deps: #1
```

Options: **Approve** | **Adjust** (re-propose) | **Skip** (no split)

## Create Sub-Issues

```bash
bun ${CLAUDE_PLUGIN_ROOT}/skills/issue-triage/triage.ts create \
  --title "<title>" --body "<body>" \
  --parent <parent_N> --size <XS|S|M|L|XL> --priority <priority>
```

**Body template:**

```markdown
## Scope
{slices/affordances/criteria covered}

**Parent spec:** artifacts/specs/{issue}-{slug}.mdx | **Parent issue:** #{parent}

## Acceptance Criteria
{subset from parent spec}

## Dependencies
{sibling deps}
```

Parse output `Created #N: <title>` → store mapping. Wire deps:

```bash
bun ${CLAUDE_PLUGIN_ROOT}/skills/issue-triage/triage.ts set <B> --blocked-by <A>
```

**Generate sub-specs** ∀ sub-issue at `artifacts/specs/{sub_N}-{sub_slug}.mdx`:

```markdown
---
title: "{sub-issue title}"
parent_spec: "artifacts/specs/{parent_issue}-{parent_slug}.mdx"
parent_issue: {parent_N}
---

## Scope
{subset from parent}

## Success Criteria
{subset from parent}

## Reference
Full spec: [artifacts/specs/{parent_issue}-{parent_slug}.mdx](../specs/{parent_issue}-{parent_slug}.mdx)
```

Inform: "Created {N} sub-issues under #{parent}. Run `/dev #N` for each sub-issue in dependency order."

## Edge Cases

| Scenario | Behavior |
|----------|----------|
| Only 1 sub-issue | Skip — no value |
| Circular deps | Reject split, inform user |
| Partial creation failure | Report success/fail, ask: Retry ∨ Continue partial |
| Spec revised after split | Warn stale, offer re-run Gate 2.5 |
| All criteria tightly coupled | Recommend "Skip" |

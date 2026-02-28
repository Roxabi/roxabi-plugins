---
name: 1b1
description: 'Walk through items 1-by-1 (findings, tasks, issues, TODOs). Triggers: "one by one" | "walk through" | "1b1" | "process each item".'
version: 0.1.0
argument-hint: '[items description]'
allowed-tools: Read, Bash, Grep, Glob
---

# 1b1 — One by One

Let:
  ι := single item from the list
  Ι := full list of items to process
  D := [] — deferred items accumulator

Walk through Ι from conversation one at a time. ∀ ι: brief context → ask decision → execute.

## Instructions

### 1. Identify Ι

Scan conversation for most recent list (review findings, plan tasks, GitHub issues, TODOs, any enumerated list).

Argument ∃ (e.g. `/1b1 review findings`) → narrow to matching list.

| Condition | Action |
|-----------|--------|
| Ι ∄ | `AskUserQuestion`: what items to walk through |
| Multiple lists ∃ | `AskUserQuestion`: which list to process |

### 2. ∀ ι ∈ Ι (sequential)

#### 2a. Brief

```
── Item {N}/{|Ι|}: {title} ──

{2-5 lines: what, why, current state}
```

ι references file → read relevant lines. ι references issue → `gh issue view`. Keep concise — enough to decide.

#### 2b. Ask Decision

`AskUserQuestion` with options adapted to ι type. Always include **Skip**.

| Item type | Options |
|-----------|---------|
| Code findings | **Fix now** (apply fix) · **Reject** (invalid, discard) · **Skip** · **Defer** (valid, not urgent) |
| Tasks / plan items | **Do it** (execute) · **Skip** · **Modify** (change approach first) · **Remove** (drop) |
| Issues / TODOs | **Act on it** (triage/assign/close) · **Skip** · **Defer** |
| Generic | **Act** · **Skip** · **Defer** |

#### 2c. Execute

| Decision | Behavior |
|----------|----------|
| Fix / Do it / Act | Perform action, show brief confirmation |
| Reject | Acknowledge invalid, discard, continue |
| Skip | Next ι silently |
| Defer | Append to D, continue |
| Modify | `AskUserQuestion` for changes → execute modified |
| Remove | Acknowledge, continue |

### 3. Summary

```
── 1b1 Complete ──

Processed: {|Ι|} items
  Acted on:  {count}
  Rejected:  {count}
  Skipped:   {count}
  Deferred:  {count}
  Removed:   {count}

Deferred items:
  1. {title}
  2. {title}
```

D ≠ ∅ → `AskUserQuestion`: **Process deferred now** | **Done**.

## Edge Cases

| Scenario | Behavior |
|----------|----------|
| Ι ∄ | Ask user what to walk through |
| Multiple lists ∃ | Ask user which list |
| User stops mid-way | End early, show summary of processed |
| ι references files | Read relevant sections before brief |
| ι already resolved | Note in brief, ask user to confirm skip |
| \|Ι\| = 1 | Still brief + ask — ¬skip flow |

## Safety Rules

1. Always brief before asking — ¬present decision without context
2. One ι at a time — ¬batch multiple into one question
3. Track all decisions — maintain tally for summary
4. Respect user pace — ¬rush or skip ahead

$ARGUMENTS

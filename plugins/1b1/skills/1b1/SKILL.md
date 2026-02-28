---
name: 1b1
description: 'Walk through items 1-by-1 (findings, tasks, issues, TODOs). Triggers: "one by one" | "walk through" | "1b1" | "process each item".'
version: 0.1.0
argument-hint: '[items description]'
allowed-tools: AskUserQuestion, Read, Bash, Grep, Glob
---

# 1b1 — One by One

Walk through a list of items from the conversation (tasks, findings, issues, suggestions, etc.) one at a time. For each item, provide a brief context summary, then ask the user what to do.

## Instructions

### 1. Identify the Items

Look back through the conversation to find the most recent list of items. These could be:

- Review findings
- Implementation plan tasks
- GitHub issues
- TODO items or action items
- Any enumerated list the user was discussing

If the user passed an argument (e.g., `/1b1 review findings`), use that to narrow down which list to use.

**If no list is found:** Ask the user via `AskUserQuestion` what items they want to walk through, with options based on what's visible in the conversation.

**If multiple lists exist:** Ask the user via `AskUserQuestion` which list to process.

### 2. Walk Through Each Item

For each item in the list, **sequentially**:

#### 2a. Brief the User

Present a short context block:

```
── Item {N}/{total}: {title or summary} ──

{2-5 lines of context: what this item is, why it matters, current state}
```

If the item references a file, read the relevant lines to provide accurate context. If it references an issue, fetch it with `gh issue view`. Keep it concise — the user needs just enough to make a decision, not a full analysis.

#### 2b. Ask for Decision

Use `AskUserQuestion` with options appropriate to the item type:

**For code review findings / code issues:**
- **Fix now** — Accept the finding and apply the fix immediately
- **Reject** — Finding is invalid or incorrect, discard it
- **Skip** — Move to the next item without deciding
- **Defer** — Finding is valid but not urgent, note it for later

**For tasks / plan items:**
- **Do it** — Execute this task now
- **Skip** — Move to the next item
- **Modify** — Change the approach before executing
- **Remove** — Drop this item entirely

**For issues / todos:**
- **Act on it** — Take action (triage, assign, comment, close)
- **Skip** — Move to the next item
- **Defer** — Come back to it later

**For generic items:**
- **Act** — Take the appropriate action
- **Skip** — Move on
- **Defer** — Save for later

Adapt the options to what makes sense for the specific item. Always include **Skip** as an option.

#### 2c. Execute the Decision

- **Fix / Do it / Act:** Perform the action. Show a brief confirmation of what was done.
- **Reject:** Acknowledge the finding is invalid, discard it, and continue.
- **Skip:** Move to the next item silently.
- **Defer:** Add to a running "deferred" list. Continue to the next item.
- **Modify:** Ask the user what to change via `AskUserQuestion`, then execute the modified version.
- **Remove:** Acknowledge and continue.

### 3. Summary

After processing all items, show a summary:

```
── 1b1 Complete ──

Processed: {N} items
  Acted on:  {count}
  Rejected:  {count}
  Skipped:   {count}
  Deferred:  {count}
  Removed:   {count}

Deferred items:
  1. {item title}
  2. {item title}
```

If there are deferred items, ask the user via `AskUserQuestion`:
- **Process deferred items now** — Run through deferred items the same way
- **Done** — End the session

## Edge Cases

| Scenario | Behavior |
|----------|----------|
| No items found in conversation | Ask user what to walk through |
| Multiple lists in conversation | Ask user which list to process |
| User wants to stop mid-way | If user selects a custom response indicating they want to stop, end early and show summary of what was processed |
| Item requires reading files | Read the relevant file sections before briefing |
| Item is already done/resolved | Note it as already handled in the brief, still ask user to confirm skip |
| Single item in list | Still brief and ask — don't skip the flow |

## Safety Rules

1. **Always brief before asking** — never present a decision without context
2. **One item at a time** — never batch multiple items into one question
3. **Track all decisions** — maintain the running tally for the final summary
4. **Respect user pace** — do not rush or skip ahead

$ARGUMENTS

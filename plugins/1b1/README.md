# 1b1 — One by One

A Claude Code plugin that walks through a list of items one at a time, briefing you on each one and asking what to do before moving to the next.

## What it does

When you have a list of items to process — review findings, tasks, issues, TODOs — this plugin steps through them sequentially. For each item it:

1. Shows a brief context summary (what the item is, why it matters, current state)
2. Asks you for a decision (fix, skip, defer, reject, etc.)
3. Executes your decision immediately
4. Moves to the next item

At the end, it shows a summary of all decisions made and lets you go back to any deferred items.

## Install

```bash
claude plugin marketplace add Roxabi/roxabi-plugins
claude plugin install 1b1
```

## Usage

- `1b1` — walks through the most recent list in the conversation
- `1b1 review findings` — walks through review findings specifically
- `1b1 open issues` — walks through issues

The decision options adapt to the item type:

| Item type | Options |
|-----------|---------|
| Code findings | Fix now, Reject, Skip, Defer |
| Tasks / plan items | Do it, Skip, Modify, Remove |
| Issues / TODOs | Act on it, Skip, Defer |
| Generic items | Act, Skip, Defer |

## License

MIT

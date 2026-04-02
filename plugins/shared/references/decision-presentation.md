# Decision Presentation Protocol

Use this protocol whenever a user decision is required. Never use AskUserQuestion.

## Pattern A — Decision with options

Use when: presenting a choice between 2+ alternatives (approach, action, direction).

```
── Decision: {topic} ──

Context:     {why this decision is needed — root cause / current state / trigger}
Target:      {what we're trying to achieve}
Path:        {how we get there once a choice is made}

Options:
  1. {option} — {one-line description}
  2. {option} — {one-line description}
  3. {option} — {one-line description}

Recommended: Option N — {1-line rationale}
```

Wait for user reply. Execute immediately on receipt — no confirmation loop.

## Pattern B — Plain input request

Use when: a single piece of information is needed with no alternatives (URL, path, text, name).

Ask directly in 1–2 sentences. State what you need and why. No preamble.

## Pattern C — Batch intake / multi-select

Use when: collecting several inputs at once, or letting the user pick multiple items from a list.

```
── {topic} ──

{numbered list of items or questions}

→ Enter numbers (comma-separated), or answer each question inline.
```

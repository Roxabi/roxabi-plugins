# Decision Presentation Protocol — DP(n)

Shorthand used in SKILL.md files: `→ DP(A)` | `→ DP(B)` | `→ DP(C)`
Load this file via `Read \`${CLAUDE_PLUGIN_ROOT}/../shared/references/decision-presentation.md\`` when a pattern is invoked.

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
  1. {option} — {what it improves} / {what it costs}
  2. {option} — {what it improves} / {what it costs}
  3. {option} — {what it improves} / {what it costs}

Recommended: Option N — {1-line rationale}
```

**Frame functionally, not technically** — the user is deciding intent and consequences, not reviewing syntax:
- Context / Target / Options in business/user terms: the intention, what each option **improves or fixes**, and the upstream→downstream history (where it comes from → what it unblocks).
- Avoid file paths, symbol/class names, and infra jargon (Quadlet, nkey, ACL, JetStream, KV-store) **unless the user already used the term**. Gloss the unavoidable in plain language ("internal bus" ¬ "NATS KV", "vault" ¬ "Fernet keyring").
- OK to use: epic/issue numbers, and business concepts (bot, channel, alert, identity, isolation, credentials).
- Implementation detail belongs in the issue-body update **after** the decision — not in the prompt.

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

# fix

Apply code review findings — auto-apply high-confidence ones, walk through the rest one by one.

## Why

After a code review, manually triaging and applying dozens of findings is tedious and error-prone. `/fix` automates the high-confidence, multi-agent-validated fixes (threshold C≥80, verified by 2+ agents), then guides you through the remaining findings one by one, committing and pushing as it goes.

## Usage

```
/fix           Apply findings from the current conversation (latest /code-review output)
/fix #42       Gather findings from PR #42 comments
```

Triggers: `"fix findings"` | `"fix review"` | `"apply fixes"` | `"apply review comments"` | `"address review feedback"` | `"fix PR comments"`

## How it works

**Phase 1 — Gather** — parses PR comments (Conventional Comments format) or scans the conversation for `/code-review` output. Parses label, file:line, agent, root cause, solutions, confidence.

**Phase 2 — Triage** — splits findings into:
- `Q_auto`: actionable, C≥80, verified by 2+ agents → auto-apply
- `Q_1b1`: everything else → one-by-one walkthrough

Single-agent high-C findings get a fresh verifier agent before being promoted to `Q_auto`.

**Phase 3 — Auto-apply** — applies all `Q_auto` findings sequentially; failed ones are demoted to `Q_1b1`.

**Phase 4 — Push** — commits and pushes auto-applied changes.

**Phase 5 — 1b1 walkthrough** — presents each remaining finding with root cause and solutions; you choose: Solution 1 | Solution 2 | Defer (creates issue) | Skip.

**Phase 6 — Apply 1b1 decisions** — applies chosen solutions (inline if ≤2, agent-spawned if ≥3); retries up to 3×.

**Phase 7 — Final push + label** — commits, pushes, adds `reviewed` label to PR.

**Phase 8 — PR comment** — posts a "Review Fixes Applied" summary to the PR.

## Safety

- Stages specific files only — never `git add -A`
- Never auto-merges — adds `reviewed` label only; human merges

## Chain position

**Predecessor:** `/code-review` | **Successor:** `/code-review` (re-review, max 2 iterations)

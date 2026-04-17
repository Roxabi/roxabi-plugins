# code-review

Multi-domain code review via fresh domain agents → Conventional Comments findings + verdict.

## Why

A single reviewer (even a good one) misses domain-specific issues. `/code-review` spawns fresh, unbiased agents per domain (security, architecture, tests, frontend, backend, devops, product) simultaneously, merges their findings using Conventional Comments labels, deduplicates overlaps, and produces a structured verdict: Approve, Approve with comments, or Request changes.

## Usage

```
/code-review         Review current branch vs staging/main
/code-review #42     Review PR #42
```

Triggers: `"code review"` | `"review changes"` | `"review PR #42"` | `"check my code"` | `"do a code review"`

## How it works

1. **Gather changes** — reads full diff and all changed files; warns if > 50 files.
2. **Secret scan** — grep for hardcoded passwords, API keys, tokens; warns and asks before proceeding.
3. **Spec compliance** (if spec exists) — checks each acceptance criterion against the diff.
4. **Multi-domain review** — spawns agents in parallel:

   | Agent | Condition | Focus |
   |-------|-----------|-------|
   | security-auditor | always | OWASP, injection, secrets, auth |
   | architect | |Δ| > 5 or arch changes | patterns, circular deps |
   | product-lead | spec exists | spec compliance, product fit |
   | tester | test files changed | coverage, AAA, edge cases |
   | frontend-dev | frontend files changed | components, hooks |
   | backend-dev | backend files changed | API, errors |
   | devops | config/CI files changed | infra, deploy |

5. **Merge & present** — deduplicates by file:line, sorts by confidence, groups Blockers → Warnings → Suggestions → Praise.
6. **Post to PR** — posts formatted comment with `## Code Review` header.
7. **Next step** — asks: Fix now (`/fix`) | Merge as-is | Stop.

## Finding format

```
<label>: <description>
  file.ts:42
  -- agent-name
  Root cause: <why>
  Solutions:
    1. <primary> (recommended)
    2. <alternative>
  Confidence: 87%
```

## Verdict

| Condition | Verdict |
|-----------|---------|
| Any blocking findings | Request changes |
| Warnings only | Approve with comments |
| Suggestions/praise only | Approve |
| No findings | Approve (clean) |

## Chain position

**Predecessor:** `/validate` | **Successor:** `/fix` (changes) or merge (approved)

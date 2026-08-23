# dev-review

Multi-domain code review via fresh domain agents → Conventional Comments findings + verdict.

## Why

A single reviewer (even a good one) misses domain-specific issues. `/dev-review` spawns a **conditional** roster (adversarial always, with an OWASP lens — not a default 8-agent swarm), merges findings using Conventional Comments labels, deduplicates by `(file, class)` keep-max-C, and produces a structured verdict: Approve, Approve with comments, or Request changes.

## Usage

```
/dev-review         Review current branch vs staging/main
/dev-review #42     Review PR #42
```

Triggers: `"dev-review"` | `"code review"` | `"review changes"` | `"review PR #42"` | `"check my code"` | `"do a code review"`

## How it works

1. **Gather changes** — reads full diff and all changed files; warns if > 50 files.
2. **Secret scan** — grep for hardcoded passwords, API keys, tokens; warns and asks before proceeding.
3. **Spec compliance** (if spec exists) — checks each acceptance criterion against the diff.
4. **Multi-domain review** — conditional spawn (not an 8-agent always-table):

   | Agent | When | Focus |
   |-------|------|-------|
   | adversarial | always | red-team + OWASP lens (secrets, injection, auth) |
   | frontend-dev | Δ intersects FE / `{frontend.path}` / `{shared.ui}` | components, hooks |
   | product-lead | spec exists | spec compliance, product fit |
   | tester | mechanical parse of PR body or `artifacts/reviews/{N}-falsify.md` **fails** (heading alone is ¬sufficient) | coverage, AAA, tautology |
   | architect / devops | τ=F-full or Δ intersects `scripts/`, CI, `lefthook.yml`, wrangler, deploy | patterns / infra |
   | backend-dev | τ=F-full or Δ intersects those **or** `{backend.path}` | API, errors |
   | recall | multi-chunk **and** canonical class tagged **and** ≥3 raw_callsites | class-join (skip single-chunk) |
   | security-auditor | **`spawn_security_auditor`** from `claim-roster.sh` (path ∨ claim tags on approved σ when Δ≠∅ ∨ invalid claim — #419); path globs retained in `path_hit` | OWASP |
   | axial-adr-review | existing structural condition | N×M drift |

5. **Merge & present** — one finding per `(file, class)` keep max C; also dedup file:line; sorts by confidence; groups Blockers → Warnings → Suggestions → Praise.
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

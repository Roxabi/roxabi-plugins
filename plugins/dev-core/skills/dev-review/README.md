# dev-review

Multi-domain code review via fresh domain agents → Conventional Comments findings + verdict.

## Why

A single reviewer misses domain-specific issues; an 8-agent swarm over-spawns. `/dev-review` runs one oracle (`roster.sh`) — adversarial always, everything else gated — then a keep/drop filter over low-C findings, merges Conventional Comments, deduplicates by `(file, class)` keep-max-C, and produces a structured verdict: Approve, Approve with comments, or Request changes.

## Usage

```
/dev-review         Review current branch vs staging/main
/dev-review #42     Review PR #42
```

Triggers: `"code review"` | `"review changes"` | `"review PR #42"` | `"check my code"` | `"do a code review"`

## How it works

1. **Gather changes** — reads full diff and all changed files; warns if > 50 files.
2. **Secret scan** — grep for hardcoded passwords, API keys, tokens; warns and asks before proceeding.
3. **Spec compliance** (if spec exists) — checks each acceptance criterion against the diff.
4. **Multi-domain review** — spawn exactly `roster.sh` `agents[]` (project knob: `.claude/stack.yml` `review.roster` — `max_agents` default 4, `verify_below_confidence` default 90, per-agent `default|always|never`):

   | Agent | When | Focus |
   |-------|------|-------|
   | adversarial | always (floor) | red-team + OWASP lens |
   | security-auditor | `path_hit` only | OWASP |
   | tester | Δ ∩ tests ∧ `oracle_ok=false` | coverage, AAA, tautology |
   | frontend-dev | Δ ∩ `{frontend.path}` / `{shared.ui}` | components, hooks |
   | backend-dev | Δ ∩ `{backend.path}` | API, errors |
   | devops | τ=F-full ∧ Δ ∩ infra | infra (the single infra agent) |
   | architect | τ=F-full ∧ Δ ∩ infra = ∅ | patterns (xor devops) |
   | axial-adr-review | existing structural condition | N×M drift |
   | recall | multi-chunk ∧ `|Δ| > recall_min_delta` | class-join (not in `agents[]`) |

5. **Keep/drop filter** — one `finding-verifier` pass over findings with `C < 90` (`verify_below_confidence`). Dropped findings disclosed in a collapsed `Filtered` block. Fail-open when the verifier returns nothing.
6. **Merge & present** — one finding per `(file, class)` keep max C; also dedup file:line; sorts by confidence; groups Blockers → Warnings → Suggestions → Praise.
7. **Post to PR** — posts formatted comment with `## Code Review` header.
8. **Next step** — asks: Fix now (`/fix`) | Merge as-is | Stop.

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

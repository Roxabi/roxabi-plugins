# dev-review

Multi-domain code review via fresh domain agents → Conventional Comments findings + verdict.

## Why

A single reviewer misses domain-specific issues; an 8-agent swarm over-spawns. `/R-dev-review` runs one oracle (`roster.sh`) — R-adversarial always, everything else gated — then a keep/drop filter over low-C findings, merges Conventional Comments, deduplicates by `(file, class)` keep-max-C, and produces a structured verdict: Approve, Approve with comments, or Request changes.

## Usage

```
/R-dev-review         Review current branch vs staging/main
/R-dev-review #42     Review PR #42
```

Triggers: `"code review"` | `"review changes"` | `"review PR #42"` | `"check my code"` | `"do a code review"`

## How it works

1. **Gather changes** — reads full diff and all changed files; warns if > 50 files.
2. **Secret scan** — grep for hardcoded passwords, API keys, tokens; warns and asks before proceeding.
3. **Spec compliance** (if spec exists) — checks each acceptance criterion against the diff.
4. **Multi-domain review** — spawn exactly `roster.sh` `agents[]` (project knob: `.dev/stack.yml` `review.roster` — `max_agents` default 4, `verify_below_confidence` default 90, per-agent `default|always|never`):

   | Agent | When | Focus |
   |-------|------|-------|
   | R-adversarial | always (floor) | red-team + OWASP lens |
   | R-security-auditor | `path_hit` only | OWASP |
   | R-tester | Δ ∩ tests ∧ `oracle_ok=false` | coverage, AAA, tautology |
   | R-frontend-dev | Δ ∩ `{frontend.path}` / `{shared.ui}` | components, hooks |
   | R-backend-dev | Δ ∩ `{backend.path}` | API, errors |
   | R-devops | τ=F-full ∧ Δ ∩ infra | infra (the single infra agent) |
   | R-architect | τ=F-full ∧ Δ ∩ infra = ∅ | patterns (xor R-devops) |
   | R-axial-adr-review | existing structural condition | N×M drift |
   | R-recall | multi-chunk ∧ `|Δ| > recall_min_delta` | class-join (not in `agents[]`) |

5. **Keep/drop filter** — one `R-finding-verifier` pass over findings with `C < 90` (`verify_below_confidence`). Dropped findings disclosed in a collapsed `Filtered` block. Fail-open when the verifier returns nothing.
6. **Merge & present** — one finding per `(file, class)` keep max C; also dedup file:line; sorts by confidence; groups Blockers → Warnings → Suggestions → Praise.
7. **Post to PR** — `## Code Review` comment: `## Spec` (Σ mirror of the Phase 2 met/missing call, cited) → `## Standards` (Fowler judgement smells from `review-smells.md`, orchestrator-only — convention breaks live in the findings pile, ¬in a rollup line) → grouped findings (each finding rendered once) → filtered/capped disclosure → verdict. Both axis blocks are **non-CC-shaped** display — `/R-fix` parses the whole comment body and would otherwise open a second fix task per duplicated finding. `review-smells.md` is ¬pasted into Lane A.
8. **Next step** — asks: Fix now (`/R-fix`) | Merge as-is | Stop.

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

## Honesty

- **Findings are hypotheses, ¬verdicts on intent.** A finding is one agent's reading of the diff at one moment; `Confidence:` prices that reading, ¬the author's intent. The `R-finding-verifier` keep/drop pass is fail-open — it trims noise, it does ¬certify what survives.
- **The review does ¬converge.** Re-running `/R-dev-review` on the same diff can surface a different judgement set: roster gates key off τ/labels, chunking keys off the active context window, and the agents are LLMs. A clean second run ¬proves the first was wrong — nor the reverse.
- **Read-only is a contract, ¬a capability.** The five review-only agents (`R-adversarial`, `R-security-auditor`, `R-axial-adr-review`, `R-finding-verifier`, `R-recall`) are read-only **by contract**: there is deliberately no `tools:` frontmatter on any `R-*` agent, because dev-core is multi-harness (Claude / Codex / Grok / OMP) and host-only tool names ¬belong in portable frontmatter. Nothing in the harness restricts them. Their bodies state ¬`Write`/¬`Edit` and ¬spawn; two keep a **read-only** shell on purpose (`R-adversarial`: `git show|diff|log|rev-parse`; `R-security-auditor`: `npm audit` + version checks). Dual-use roster members (`R-tester`, `R-frontend-dev`, `R-backend-dev`, `R-devops`, `R-architect`) write by design in `/R-dev-implement`; in review they carry ¬spawn **only** through the Phase 3 dispatch prompt.
- **Recursion is unbounded, ¬merely unenforced.** No capability deny can tell a legitimate Phase 3 spawn from a Lane A re-spawn (`hooks/lib/hook-input.cjs` exposes no caller identity), **and no cap catches it**: the max-2 loop cap counts `/R-dev` fix→review iterations via `metadata.iteration`, which a nested `/R-dev-review` never increments. The prompt rule is the only control.
- **Smells are judgement, ¬blockers.** `review-smells.md` (Fowler ch.3) is read once by the orchestrator into `## Standards`. Re-runs will surface a different smell set. Rows never enter F, never carry `Class:`, never bind `/R-fix`.

## Chain position

**Predecessor:** `/R-validate` | **Successor:** `/R-fix` (changes) or merge (approved)

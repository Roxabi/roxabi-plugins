---
name: review
argument-hint: [#PR]
description: Multi-domain code review (agents + Conventional Comments → findings + verdict). Triggers: "review changes" | "review PR #42" | "code review" | "check my code".
version: 0.1.0
allowed-tools: Bash, AskUserQuestion, Read, Write, Glob, Grep, Task, Skill
---

# Code Review

Review branch/PR changes via fresh domain-specific agents → Conventional Comments → findings + verdict.

**⚠ Flow: single continuous pipeline (Phases 1→4 + 6 + 8). ¬stop between phases. AskUserQuestion response → immediately execute next phase. Stop only on: |Δ|=0, explicit Cancel, or Phase 8 completion.**

```
/review          → diff staging...HEAD
/review #42      → gh pr diff 42
```

## Definitions

```
F         = set of all findings
f ∈ F     = a single finding
C(f)      ∈ [0,100] ∩ ℤ        — confidence score
cat(f)    ∈ {issue, suggestion, todo, nitpick, thought, question, praise}
Δ         = set of changed files
```

## Phase 1 — Gather Changes

1. target = PR# provided → `gh pr diff <#>` | else → `git diff staging...HEAD`
2. Δ = `git diff --name-only staging...HEAD` (or `gh pr diff <#> --name-only`)
3. Read all files ∈ Δ in full (skip binaries, note in report)
4. |Δ| = 0 → inform, halt
5. |Δ| > 50 → warn quality degradation, suggest split

## Phase 2 — Spec Compliance

1. issue_num ← `git branch --show-current | grep -oP '\d+' | head -1`
2. spec ← `ls artifacts/specs/<issue_num>-*.mdx 2>/dev/null`
3. spec ∃ → ∀ criterion ∈ spec.success_criteria:
   - met by diff → ∅
   - ¬met → emit `issue(blocking):` with criterion text
   - ∀ met → emit `praise:` (spec compliance)
4. spec ∄ → skip silently

## Phase 3 — Multi-Domain Review (Fresh Agents)

Spawn fresh agents via Task (¬implementation context → ¬bias).

### Agent dispatch

| Agent | Condition | Focus |
|-------|-----------|-------|
| **security-auditor** | always | OWASP, secrets, injection, auth |
| **architect** | |Δ| > 5 ∨ src ⊇ {arch, pattern, structure, service, module} | patterns, structure, circular deps |
| **product-lead** | spec(issue_num) ∃ | spec compliance, product fit |
| **tester** | Δ ∩ {`src/`, `test/`, `*.test.*`, `*.spec.*`} ≠ ∅ | coverage, AAA, edge cases |
| **frontend-dev** | Δ ∩ {`apps/web/`, `packages/ui/`} ≠ ∅ | FE patterns, components, hooks |
| **backend-dev** | Δ ∩ {`apps/api/`, `packages/types/`} ≠ ∅ | BE patterns, API, errors |
| **devops** | Δ ∩ {configs, CI} ≠ ∅ | config, deploy, infra |

**Notes:**
- **architect skip:** XS changes (≤5 files) ∧ no arch keywords → faster feedback
- **product-lead skip:** Phase 2 auto-detects spec; if missing, skip entirely
- **tester skip:** config/docs/infra only → skip (test reviewers handled by domain-specific agents)

**Subdomain split:** |files_domain| ≥ 8 ∧ distinct modules → N same-type agents, 1/module group. Default: 1 agent/domain.

### Security-auditor scoping (this agent only)

1. ∀ f ∈ Δ: extract imports(f) = static `from '...'` ∪ dynamic `import('...')` paths
2. Resolve aliases:

   | Pattern | Resolution |
   |---------|-----------|
   | `./`, `../` | relative, try `.ts`, `/index.ts` |
   | `@repo/<pkg>` | → `packages/<pkg>/src/index.ts` (skip vitest-config, playwright-config) |
   | `@/*` (web only) | → `apps/web/src/` + rest, try `.ts`, `.tsx`, `/index.{ts,tsx}` |
   | External | skip |

3. scope = Δ ∪ ⋃{resolve(imports(f)) | f ∈ Δ} ∪ `apps/api/src/auth/**` — deduplicate

### Agent payload

Each **spawned** agent receives: full diff + Δ + spec (if ∃) + "output Conventional Comments". Only agents matching Phase 2 conditions are spawned.

### Review dimensions (scoped per domain)

correctness | security | performance | architecture | tests | readability | observability

### Finding format (ALL fields mandatory)

```
<label>: <description>
  <file>:<line>
  -- <agent>
  Root cause: <why, not what>
  Solutions:
    1. <primary> (recommended)
    2. <alternative>
    3. <alternative> [optional]
  Confidence: <0-100>%
```

**C(f) = min(diagnostic_certainty, fix_certainty)**

| Band | C | Criteria |
|------|---|----------|
| Certain | 90-100 | Unambiguous diagnosis + fix |
| High | 70-89 | Clear diagnosis, 1-2 fix approaches |
| Moderate | 40-69 | Probable, context-dependent |
| Low | 0-39 | Speculative, competing explanations |

**Validation:** missing fields ∨ C ∉ ℤ ∩ [0,100] → C(f) := 0 (noted in findings; `/fix` routes to 1b1).

### Finding categories

| Category | Label | Blocks merge? |
|----------|-------|:---:|
| Bug / Security / Spec gap | `issue:` / `todo:` | ✓ |
| Standard violation | `suggestion(blocking):` | ✓ |
| Style | `suggestion(non-blocking):` / `nitpick:` | ✗ |
| Architecture | `thought:` / `question:` | ✗ |
| Good work | `praise:` | ✗ |

## Phase 4 — Merge & Present

1. Collect F from all agents
2. Dedup: same file:line + issue → keep max C, original agent
3. Sort: C desc within category
4. Group: Blockers → Warnings → Suggestions → Praise

**Verdict:**

| Condition | Verdict |
|-----------|---------|
| ∃f: blocks(f) | Request changes |
| ∃f: warns(f) ∧ ¬∃f: blocks(f) | Approve with comments |
| suggestions/praise only | Approve |
| F = ∅ | Approve (clean) |

## Phase 6 — Post to PR

1. PR# = provided ∨ `gh pr list --head "$(git branch --show-current)" --json number --jq '.[0].number'`; ¬∃ → skip
2. `/tmp/review-comment.md` → `gh pr comment <#> --body-file /tmp/review-comment.md`
3. `## Code Review` header, grouped findings + summary + verdict. ∀C included.

**→ immediately continue to Phase 8 (¬stop).**

## Phase 8 — Next Step

AskUserQuestion:
- **Fix now (`/fix`)** — invoke `/fix` skill to auto-apply + 1b1 + spawn fixers
- **Merge as-is** — rebase + label + squash merge (see below)
- **Stop** — exit (findings posted to PR, no further action)

**If Merge as-is:**

1. `git fetch origin staging && git rev-list HEAD..origin/staging --count`
   - count > 0 → `git rebase origin/staging` + `git push --force-with-lease`
   - conflict → inform user, halt (¬label)
2. AskUserQuestion: "Add `reviewed` label?" → Yes / No
3. Yes → `gh api repos/:owner/:repo/issues/<#>/labels -f "labels[]=reviewed"` → squash merge on green CI
4. No → inform manual

> `/review` ¬fixes code. Fixing = `/fix` skill (auto-apply + /1b1 + fixer agents).

## Edge Cases

| Scenario | Behavior |
|----------|----------|
| |Δ| = 0 | Inform, halt |
| Binary ∈ Δ | Skip, note |
| |Δ| > 50 | Warn, suggest split |
| F = ∅ | Clean approve, post comment, Phase 8 → user choice |
| Critical security | Escalate immediately in findings, flag in verdict |
| Agents disagree | Present both findings with respective C values |
| ¬∃ PR | Skip Phase 6, go to Phase 8 local only |
| Missing root cause/solutions | C(f) := 0 — noted in findings |
| architect skipped (|Δ| ≤ 5 + no arch keywords) | No arch review → faster, still security/spec/test |
| product-lead skipped (no spec) | Skip compliance check → Phase 2 validation skipped |
| tester skipped (pure config/docs) | No test coverage review → focus on security/devops |

## Safety Rules

1. Fresh agents only — ¬implementation context
2. ¬auto-merge, ¬approve PRs on GitHub
3. ¬fix code — findings only. Fixing = `/fix` skill
4. ∃ PR → must post comment (Phase 6)
5. Human decides next action at Phase 8 — ¬proceed without AskUserQuestion

$ARGUMENTS

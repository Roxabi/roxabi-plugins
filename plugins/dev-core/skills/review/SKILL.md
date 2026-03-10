---
name: review
argument-hint: [#PR]
description: Multi-domain code review (agents + Conventional Comments → findings + verdict). Triggers: "review changes" | "review PR #42" | "code review" | "check my code".
version: 0.2.0
allowed-tools: Bash, Read, Write, Glob, Grep, Task, Skill, ToolSearch, AskUserQuestion
---

# Code Review

Review branch/PR via fresh domain-specific agents → Conventional Comments → findings + verdict.

**⚠ Flow: single continuous pipeline (Phases 1→4 + 6 + 8). ¬stop between phases. AskUserQuestion response → immediately execute next phase. Stop only on: |Δ|=0, explicit Cancel, or Phase 8 completion.**

```
/review          → diff ${BASE}...HEAD  (BASE = staging if exists, else main)
/review #42      → gh pr diff 42
```

Let:
  F := set of all findings | f ∈ F := single finding
  C(f) ∈ [0,100] ∩ ℤ — confidence | cat(f) ∈ {issue, suggestion, todo, nitpick, thought, question, praise}
  Δ := changed files | BASE := staging ∨ main

## Pipeline

| Phase | ID | Required | Notes |
|-------|----|----------|-------|
| 1 | gather-changes | ✓ | — |
| 1.5 | secret-scan | ✓ | — |
| 2 | spec-compliance | — | spec ∃ |
| 3 | multi-domain-review | ✓ | parallel |
| 4 | merge-and-present | ✓ | — |
| 6 | post-to-pr | — | PR ∃ |
| 8 | next-step | ✓ | — |

## Phase 1 — Gather Changes

0. `BASE=$(git branch -r | grep -q 'origin/staging' && echo staging || echo main)`
1. PR# → `gh pr diff <#>` | else → `git diff ${BASE}...HEAD`
2. Δ = `git diff --name-only ${BASE}...HEAD` (or `gh pr diff <#> --name-only`)
3. ∀ f ∈ Δ: read full (skip binaries, note)
4. |Δ| = 0 → halt
5. |Δ| > 50 → warn, suggest split

## Phase 1.5 — Secret Scan

```bash
git diff ${BASE}...HEAD | grep -iE '(password|passwd|secret|api[_-]?key|auth[_-]?token|access[_-]?token|private[_-]?key)\s*[:=]\s*["\x27`][^"\x27`]{8,}' | head -20
```

∃ matches → WARN (redact to first 2 + last 2 chars):
```
⚠️  Potential secrets found in diff — review before proceeding:
  <file>: <matched line with secret value redacted to first 2 + last 2 chars>
```
AskUserQuestion: **Review and proceed** | **Abort**
∅ → continue silently.

## Phase 2 — Spec Compliance

1. issue_num ← `git branch --show-current | grep -oP '\d+' | head -1`
2. spec ← `ls artifacts/specs/<issue_num>-*.mdx 2>/dev/null`
3. spec ∃ → ∀ criterion: met → ∅ | ¬met → `issue(blocking):` | ∀ met → `praise:`
4. spec ∄ → skip

## Phase 3 — Multi-Domain Review (Fresh Agents)

Spawn fresh agents via Task (¬implementation context → ¬bias).

### Agent dispatch

| Agent | Condition | Focus |
|-------|-----------|-------|
| **security-auditor** | always | OWASP, secrets, injection, auth |
| **architect** | \|Δ\| > 5 ∨ src ⊇ {arch, pattern, structure, service, module} | patterns, structure, circular deps |
| **product-lead** | spec ∃ | spec compliance, product fit |
| **tester** | Δ ∩ {`src/`, `test/`, `*.test.*`, `*.spec.*`} ≠ ∅ | coverage, AAA, edge cases |
| **frontend-dev** | Δ ∩ {`{frontend.path}`, `{shared.ui}`} ≠ ∅ | FE patterns, components, hooks |
| **backend-dev** | Δ ∩ {`{backend.path}`, `{shared.types}`} ≠ ∅ | BE patterns, API, errors |
| **devops** | Δ ∩ {configs, CI} ≠ ∅ | config, deploy, infra |

Skip rules: architect → |Δ| ≤ 5 ∧ ¬arch keywords | product-lead → spec ∄ | tester → Δ ⊂ {config, docs, infra}

**Subdomain split:** |files_domain| ≥ 8 ∧ distinct modules → N agents, 1/module. Default: 1/domain.

### Security-auditor scoping

1. ∀ f ∈ Δ: imports(f) = static `from '...'` ∪ dynamic `import('...')`
2. Resolve aliases:

   | Pattern | Resolution |
   |---------|-----------|
   | `./`, `../` | relative, try `.ts`, `/index.ts` |
   | `@repo/<pkg>` | → `packages/<pkg>/src/index.ts` (skip vitest/playwright config) |
   | `@/*` | → `{frontend.path}/src/` + rest, try `.ts`, `.tsx`, `/index.{ts,tsx}` |
   | External | skip |

3. scope = Δ ∪ ⋃{resolve(imports(f)) | f ∈ Δ} ∪ `{backend.path}/src/auth/**` — deduplicate

### Agent payload

Each agent receives: full diff + Δ + spec (if ∃) + "output Conventional Comments".

### Review dimensions
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

C(f) = min(diagnostic_certainty, fix_certainty)

| Band | C | Criteria |
|------|---|----------|
| Certain | 90-100 | Unambiguous diagnosis + fix |
| High | 70-89 | Clear diagnosis, 1-2 approaches |
| Moderate | 40-69 | Probable, context-dependent |
| Low | 0-39 | Speculative, competing explanations |

**Validation:** missing fields ∨ C ∉ ℤ ∩ [0,100] → C(f) := 0 (noted; `/fix` routes to 1b1).

### Finding categories

| Category | Label | Blocks? |
|----------|-------|:---:|
| Bug / Security / Spec gap | `issue:` / `todo:` | ✓ |
| Standard violation | `suggestion(blocking):` | ✓ |
| Style | `suggestion(non-blocking):` / `nitpick:` | ✗ |
| Architecture | `thought:` / `question:` | ✗ |
| Good work | `praise:` | ✗ |

## Phase 4 — Merge & Present

1. Collect F from all agents
2. Dedup: same file:line + issue → keep max C
3. Sort: C desc within category
4. Group: Blockers → Warnings → Suggestions → Praise

**Verdict:**

| Condition | Verdict |
|-----------|---------|
| ∃f: blocks(f) | Request changes |
| ∃f: warns(f) ∧ ¬blocks | Approve with comments |
| suggestions/praise only | Approve |
| F = ∅ | Approve (clean) |

## Phase 6 — Post to PR

1. PR# = provided ∨ `gh pr list --head "$(git branch --show-current)" --json number --jq '.[0].number'`; ¬∃ → skip
2. `/tmp/review-comment.md` → `gh pr comment <#> --body-file /tmp/review-comment.md`
3. `## Code Review` header; grouped findings + summary + verdict; ∀C included

**→ immediately continue to Phase 8.**

## Phase 8 — Next Step

AskUserQuestion:
- **Fix now (`/fix`)** — invoke `/fix` (auto-apply + 1b1 + spawn fixers; `/fix` Phase 8 offers rebase + label + merge)
- **Merge as-is** — rebase + label + squash merge (below)
- **Stop** — exit

**If Merge as-is:**

1. `git fetch origin ${BASE} && git rev-list HEAD..origin/${BASE} --count`
   - count > 0 → `git rebase origin/${BASE}` + `git push --force-with-lease`
   - conflict → halt (¬label)
2. AskUserQuestion: "Add `reviewed` label?" → Yes / No
3. Yes → `gh api repos/:owner/:repo/issues/<#>/labels -f "labels[]=reviewed"` → squash merge on green CI
4. No → inform manual

> `/review` ¬fixes code. Fixing = `/fix` skill.

## Edge Cases

| Scenario | Behavior |
|----------|----------|
| |Δ| = 0 | Halt |
| Binary ∈ Δ | Skip, note |
| |Δ| > 50 | Warn, suggest split |
| F = ∅ | Clean approve, post, Phase 8 |
| Critical security | Escalate in findings, flag in verdict |
| Agents disagree | Present both with respective C |
| ¬∃ PR | Skip Phase 6, Phase 8 local only |
| Missing root cause/solutions | C(f) := 0 |
| architect skipped | ¬arch review → faster |
| product-lead skipped | Phase 2 skipped |
| tester skipped | ¬test coverage review |

## Safety Rules

1. Fresh agents only — ¬implementation context
2. ¬auto-merge, ¬approve PRs on GitHub
3. ¬fix code — findings only. Fixing = `/fix` skill
4. ∃ PR → must post comment (Phase 6)
5. Human decides at Phase 8 — ¬proceed without AskUserQuestion

$ARGUMENTS

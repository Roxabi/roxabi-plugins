# Security Audit Findings — Issue #23

**Date:** 2026-03-10
**Scope:** 22 dev-core skills + 9 agents
**Spec:** `artifacts/specs/23-security-audit-hooks-spec.mdx`

## Executive Summary

Audited all dev-core SKILL.md files and agent definitions for dangerous git patterns, allowed-tools excess, and compliance with Claude Code security best practices.

**Key findings:**
- **0 critical** risks (no unguarded + undocumented destructive actions)
- **6 warning** findings across 4 skills (promote, fix, pr, implement)
- **4 agent matches** in 2 agents (fixer, security-auditor) — direct git commands instead of skill delegation
- **15 of 22 skills** have excess `allowed-tools` in frontmatter
- **0 `--no-verify`** flags found (regression guard: passing)
- **0 `--force`** flags found (only `--force-with-lease` in review, correctly gated)

---

## 1. Dangerous Git Patterns (T1)

### Summary

| Risk Level | Count | Skills |
|------------|-------|--------|
| Safe (gate + rule) | 8 | cleanup, fix (Phase 7), pr (none — see below), promote (tag push), implement (abandon), review, init, stack-setup |
| Warning (gate OR rule, not both) | 6 | promote (3), fix (1), pr (1), implement (1) |
| Critical (neither) | 0 | — |

### Warning Findings

#### F1 — `promote/SKILL.md` line 86: `gh pr merge` without user gate

Step 6b auto-merges the changelog PR (`gh pr merge <N> --squash --delete-branch`) without AskUserQuestion. Safety Rule #2 states `¬auto-merge — user merges after review`, but this sub-flow contradicts the rule.

**Recommendation:** Add AskUserQuestion gate before `gh pr merge` in Step 6b. Align Rule #2 with actual behavior or gate the action.

#### F2 — `promote/SKILL.md` line 87: `git reset --hard` without user gate

Immediately follows F1 in Step 6b. Discards local working tree changes. No AskUserQuestion gate. No safety rule covers `--hard` reset specifically.

**Recommendation:** Add AskUserQuestion gate. Add explicit safety rule for `git reset --hard`.

#### F3 — `promote/SKILL.md` line 84: `git push` changelog branch without user gate

Step 6b pushes `chore/$VERSION-changelog` branch unconditionally. Safety rules cover force-push prohibition but don't gate regular pushes.

**Recommendation:** Bundle with F1/F2 — a single AskUserQuestion before the Step 6b sub-flow would cover all three actions.

#### F4 — `fix/SKILL.md` line 80: `git push` after auto-apply without user gate

Phase 4 pushes auto-applied high-confidence findings to remote immediately after quality gate passes. Phase 2 displays a fix plan but no AskUserQuestion before the push.

**Recommendation:** Add AskUserQuestion gate before Phase 4 push: "Push auto-applied fixes to remote? **Push** | **Review first** | **Abort**"

#### F5 — `pr/SKILL.md` line 37: `git push -u origin` without user gate

Step 2 auto-pushes feature branch if not yet on remote. Safety Rule #4 states `AskUserQuestion for all decisions`, but this push is automatic. Low blast-radius (feature branch only).

**Recommendation:** Add AskUserQuestion or at minimum an informational message before push. Alternatively, document as intentional exception.

#### F6 — `implement/SKILL.md` line 167: `git branch -D` in Rollback section without gate

The `## Rollback` section presents `git branch -D` as a direct command block without AskUserQuestion. Compare with the gated abandon path at line 176 which correctly uses AskUserQuestion.

**Recommendation:** Add AskUserQuestion gate to the Rollback section, or mark it as "manual reference only — do not execute without user confirmation."

---

## 2. Agent Git Command Usage (T2)

### Summary

| Agent | Matches | Commands | Risk |
|-------|---------|----------|------|
| fixer.md | 2 | `git stash push/drop/pop` (lines 64-65) | Warning — direct state mutation |
| security-auditor.md | 2 | `git diff --name-only` (line 141), general `git` grant (line 150) | Low — read-only commands |
| Other 7 agents | 0 | — | Safe |

### Findings

**F7 — fixer.md: Direct `git stash` commands**

The fixer agent hardcodes a `git stash push/drop/pop` rollback protocol in its auto-apply failure handling. These are state-mutating git commands executed directly by the agent, not delegated to a skill. While the pattern serves as a safety net (stash before applying, pop on failure), it violates the "agents delegate to skills" principle.

**Recommendation:** Accept as intentional (tightly coupled to apply loop) or extract into a `/stash-rollback` helper skill. Document the exception.

**F8 — security-auditor.md: `git diff --name-only` and general `git` grant**

The security-auditor uses `git diff --name-only` for scoping (read-only) and explicitly grants itself Bash access to `git` commands in its Boundaries section. These are non-destructive.

**Recommendation:** Accept as intentional. `git diff` is read-only. Document in Boundaries section that only read-only git commands are permitted.

---

## 3. Allowed-Tools Minimality Audit (T3)

### Summary

- **7 skills** have minimal (correct) allowed-tools: adr, cleanup-context, cleanup, doctor, init, issue-triage, pr
- **15 skills** have excess tools in frontmatter

### Excess Tools by Skill

| Skill | Excess tools | Impact |
|-------|-------------|--------|
| **dev** | Write, Edit, Glob, Grep, Task | 5 excess — orchestrator delegates via Skill only |
| **fix** | Glob, Grep, Skill, WebFetch | 4 excess — WebFetch never referenced |
| **review** | Glob, Skill | 2 excess — uses `git diff` in Bash for file discovery |
| **implement** | Grep, Skill | 2 excess — uses `ls` in Bash for file scans |
| **plan** | Edit, Skill | 2 excess — writes fresh via Write, no sub-skill calls |
| **analyze** | Edit | 1 excess |
| **doc-sync** | Glob | 1 excess — uses Bash `find` |
| **frame** | Grep | 1 excess |
| **interview** | Edit | 1 excess |
| **issues** | Read | 1 excess — presents Bash script output only |
| **promote** | Edit | 1 excess — Steps 2-4 delegated to reference doc |
| **spec** | Edit | 1 excess |
| **stack-setup** | Glob | 1 excess — uses Bash for discovery |
| **test** | Grep | 1 excess |
| **validate** | Read | 1 excess — all ops via Bash |

**Total excess tool declarations:** 25 across 15 skills.

---

## 4. Best Practices Compliance Matrix (T4)

Cross-referenced against the three knowledge resources identified in the issue.

### From `32be5f8e` — Blocking accidental merges by agents

| Practice | Status | Notes |
|----------|--------|-------|
| Intercept `git push` to protected branches | Gap | No hook intercepts agent pushes to staging/main. Skills have safety rules but no runtime enforcement. |
| Block accidental PR merges by agents | Gap | `promote` Step 6b auto-merges without gate (F1). |

### From `4e56c7f3` — 15 best practices for Claude Code in production

| # | Practice | Status | Notes |
|---|----------|--------|-------|
| 1 | Use hooks for safety guardrails | Compliant | lefthook config with lint, typecheck, trufflehog, conventional-commits |
| 2 | Never skip hooks (`--no-verify`) | Compliant | 0 occurrences across all skills |
| 3 | Never force-push | Compliant | 0 `--force` flags; `--force-with-lease` in review is gated + documented |
| 4 | Minimal permissions per skill | Gap | 15/22 skills have excess allowed-tools |
| 5 | AskUserQuestion before destructive actions | Gap | 6 warning findings (F1-F6) lack gates |
| 6 | Review gates for PRs | Compliant | /review skill with multi-agent review + user gate |
| 7 | Isolation via worktrees | Compliant | /implement creates worktrees for all F-tier work |
| 8 | No secrets in code | Compliant | TruffleHog in pre-commit hook |
| 9 | Conventional commits enforced | Compliant | commit-msg hook validates format |
| 10 | Agents delegate to skills | Gap | fixer.md has direct `git stash` commands (F7) |
| 11 | Safety rules documented per skill | Partial | High-risk skills have rules, but some rules contradict behavior (F1: promote) |
| 12 | Specific file staging (`¬git add -A`) | Compliant | Safety rules in implement, fix explicitly forbid `git add -A` |
| 13 | No `--amend` on existing commits | Compliant | 0 occurrences; CLAUDE.md prohibits |
| 14 | Feature branch workflow | Compliant | /implement creates `feat/N-slug` branches |
| 15 | User controls merge timing | Gap | promote auto-merges (F1), fix auto-pushes (F4) |

### From `47a21af1` — Permission architecture

| Practice | Status | Notes |
|----------|--------|-------|
| Skills declare minimal tool sets | Gap | 15/22 have excess (T3) |
| Commands separate from skills | Compliant | Commands dir exists, skills are separate |
| Hook architecture for runtime enforcement | Partial | lefthook covers pre-commit/commit-msg; no runtime hook for push/merge interception |

---

## 5. Recommendations for S2 (Fix Slice)

### Priority 1 — Gate missing destructive actions

| Finding | Fix |
|---------|-----|
| F1 + F2 + F3 | Add AskUserQuestion in `promote/SKILL.md` before Step 6b sub-flow |
| F4 | Add AskUserQuestion in `fix/SKILL.md` before Phase 4 push |
| F5 | Add AskUserQuestion or document as exception in `pr/SKILL.md` |
| F6 | Add gate or "manual reference" annotation in `implement/SKILL.md` Rollback |

### Priority 2 — Trim excess allowed-tools

Remove 25 excess tool declarations across 15 skills. Highest impact: dev (5), fix (4), review (2), implement (2).

### Priority 3 — Document safety patterns

| Deliverable | Content |
|-------------|---------|
| CONTRIBUTING.md "Security Patterns" section | Force-push prohibition, AskUserQuestion gate placement, `--no-verify` prohibition, allowed-tools minimality, ToolSearch/AskUserQuestion atomic pair |
| CLAUDE.md SKILL.md template | Add "Safety Rules" subsection to the template |
| `review/SKILL.md` safety rules | Document `--force-with-lease` rationale |

### Priority 4 — Agent exceptions

| Finding | Fix |
|---------|-----|
| F7 (fixer `git stash`) | Document as intentional exception with rationale |
| F8 (security-auditor `git diff`) | Document read-only constraint in Boundaries |

---

## Regression Guards (must remain passing)

- [x] Zero `--no-verify` flags across all skills
- [x] Zero `--force` flags (only `--force-with-lease` in review, with gate)
- [x] Zero `--amend` flags across all skills

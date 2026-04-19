---
name: seed-community
argument-hint: '[--only <file,...>] [--force]'
description: 'Bootstrap OSS community health files — CONTRIBUTING.md, LICENSE, SECURITY.md, CODE_OF_CONDUCT.md, README sections (Getting Started, Badges), .github/PULL_REQUEST_TEMPLATE.md, .github/ISSUE_TEMPLATE/. Reads project metadata and CLAUDE.md; generates missing files idempotently. Triggers: "seed community" | "bootstrap community files" | "add contributing" | "add license" | "add security policy" | "github community files".'
version: 0.1.0
allowed-tools: Bash, Read, Write, Edit, Glob, Grep, ToolSearch
---

# Seed Community

Let:
  σ := `.claude/stack.yml` config
  M := project metadata (name, description, license, author, repo URL)
  χ := community health file
  θ := stub threshold (< 20 lines of real content)
  MISSING := χ not present or below θ
  GENERATED := [] — accumulator

**Goal:** detect MISSING χ, generate with project-specific content, leave existing populated files untouched.

**Idempotent** — files ≥ 20 lines skipped unless `--force`.

```
/seed-community                          → detect + generate all MISSING
/seed-community --only SECURITY,CoC     → comma-separated subset
/seed-community --force                 → overwrite even populated files
```

## Phase 1 — Load Metadata

**1a.** Read σ (`cat .claude/stack.yml 2>/dev/null`). Extract: `runtime`, `package_manager`, `commands.*`, `build.formatter`.

**1b.** Read project metadata:
```bash
# JS/TS
cat package.json 2>/dev/null | grep -E '"name"|"description"|"license"|"author"|"version"|"repository"'
# Python
cat pyproject.toml 2>/dev/null | grep -E '^name|^description|^license|^authors|^version'
# Go
cat go.mod 2>/dev/null | head -5
```

**1c.** Git remote → repo URL:
```bash
gh repo view --json nameWithOwner,description,licenseInfo,url 2>/dev/null
```

**1d.** Read `CLAUDE.md` (∃). Extract: purpose (1–3 sentences), commit format, branch conventions, PR/review process, stack notes. Merge into M: `{name, description, license, author, repo_url, commit_format, pr_process, stack}`.

## Phase 2 — Detect Missing Files

Check presence + line count ∀ target:

| Target | Path | Stub if |
|--------|------|---------|
| README sections | `README.md` | Missing "Getting Started" or "Installation" heading |
| CONTRIBUTING | `CONTRIBUTING.md` | ∄ or < 20 lines |
| LICENSE | `LICENSE` | ∄ |
| SECURITY | `SECURITY.md` | ∄ or < 10 lines |
| Code of Conduct | `CODE_OF_CONDUCT.md` | ∄ |
| PR Template | `.github/PULL_REQUEST_TEMPLATE.md` | ∄ |
| Issue: Bug | `.github/ISSUE_TEMPLATE/bug_report.md` | ∄ |
| Issue: Feature | `.github/ISSUE_TEMPLATE/feature_request.md` | ∄ |

`--only X,Y` → filter MISSING to those names. `--force` → include all targets regardless of line count.

Display:
```
Community health file audit:
  README.md                              ⚠ missing Getting Started section
  CONTRIBUTING.md                        ✅ populated (47 lines) — skip
  LICENSE                                ✅ exists — skip
  SECURITY.md                            ❌ missing
  CODE_OF_CONDUCT.md                     ❌ missing
  .github/PULL_REQUEST_TEMPLATE.md       ❌ missing
  .github/ISSUE_TEMPLATE/bug_report.md   ❌ missing
  .github/ISSUE_TEMPLATE/feature_request.md ❌ missing

5 files to generate.
```

MISSING = ∅ → "All community files are present. Use --force to regenerate." → exit.

## Phase 3 — Confirm + Gather Options

→ DP(C)
1. **License type** (LICENSE ∈ MISSING) → MIT | Apache-2.0 | GPL-3.0 | Skip
2. **Author / org name** (∄ in M) → → DP(B)
3. **Optional extras** (multiSelect) → FUNDING.yml | CODEOWNERS | Contributor Covenant v2.1 wording (for CoC)

## Phase 4 — Generate Files

Process MISSING in order: LICENSE → CODE_OF_CONDUCT → SECURITY → CONTRIBUTING → PR Template → Issue Templates → README sections.

### LICENSE

`git log --reverse --format="%ad" --date=format:"%Y" | head -1` → year (else current year). Generate standard SPDX text. Author = M.author or org from repo URL.

### CODE_OF_CONDUCT.md

Contributor Covenant v2.1. Replace `[INSERT CONTACT METHOD]` with M.author email if available, else leave placeholder.

### SECURITY.md

```markdown
# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| latest  | ✅        |

## Reporting a Vulnerability

Please **do not** open a public GitHub issue for security vulnerabilities.

Report privately via GitHub Security Advisories:
[Report a vulnerability]({M.repo_url}/security/advisories/new)

Or email: {M.author_email or "[MAINTAINER EMAIL]"}

We aim to respond within 48 hours and patch within 14 days.
```

### CONTRIBUTING.md (if stub/missing)

Pull from M + σ:
- **Dev setup** — clone, `{commands.install}`, `{commands.dev}`
- **Tests** — `{commands.test}`
- **Commit format** — M.commit_format or conventional commits default
- **Branch naming** — `feat/`, `fix/`, `chore/` prefixes
- **PR process** — M.pr_process or standard checklist
- **Code style** — `{build.formatter}` + `{build.formatter_fix_cmd}`

### .github/PULL_REQUEST_TEMPLATE.md

```markdown
## Summary

<!-- What does this PR do? Link the issue: Closes #N -->

## Type of change

- [ ] Bug fix
- [ ] New feature
- [ ] Refactoring
- [ ] Documentation
- [ ] CI/Infrastructure

## Checklist

- [ ] Tests pass (`{commands.test}`)
- [ ] Lint passes (`{commands.lint}`)
- [ ] Docs updated if needed
- [ ] Commit messages follow `{commit_format}`
```

### Issue Templates

**bug_report.md** — Steps to reproduce, Expected behavior, Actual behavior, Environment (OS, runtime version, plugin version), Additional context.

**feature_request.md** — Problem statement, Proposed solution, Alternatives considered, Additional context.

### README.md — missing sections

Read existing README. Inject **after first `##`** or at end if ¬sections:
- **Getting Started** — prerequisites, install command, quick usage
- **Installation** — if ∄ as heading
- **Badges** — ∄ badge lines near top → add CI status + license badge using M.repo_url

¬overwrite existing content — append missing sections or insert badges at top only.

After each file: display `✅ {path} — generated ({N} lines)` and append to GENERATED.

## Phase 5 — Summary + Commit

```
Seed Community Complete
=======================

  Generated ({|GENERATED|} files):
    LICENSE                                  ✅ MIT, 2026
    CODE_OF_CONDUCT.md                       ✅ Contributor Covenant v2.1
    SECURITY.md                              ✅ vulnerability reporting policy
    .github/PULL_REQUEST_TEMPLATE.md         ✅ PR checklist
    .github/ISSUE_TEMPLATE/bug_report.md     ✅
    .github/ISSUE_TEMPLATE/feature_request.md ✅
    README.md                                ✅ badges + Getting Started added

  Skipped (already populated):
    CONTRIBUTING.md                          ⏭ 47 lines
    LICENSE                                  ⏭ exists
```

→ DP(A) **Commit generated files** | **Review first, commit manually** | **Skip**

"Commit" → `git add {GENERATED}` + commit:
```
chore: add community health files (SECURITY, CoC, issue templates)
```

## Edge Cases

| Scenario | Behavior |
|----------|----------|
| ¬git repo | Skip badges + GitHub-specific files; generate root files only |
| ¬package.json ∧ ¬pyproject.toml | Use git remote for name; prompt for author |
| LICENSE already exists | Skip regardless of `--force` (license changes are intentional) |
| Private repo | Omit public security advisory link; use email only |
| Monorepo | Generate at root; note sub-packages may need own LICENSE |
| README.md has badges already | Skip badge insertion |
| ¬.github dir | `mkdir -p .github/ISSUE_TEMPLATE` before writing templates |

$ARGUMENTS

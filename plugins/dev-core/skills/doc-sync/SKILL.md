---
name: doc-sync
argument-hint: '[description of change]'
description: 'Sync all project docs after a code change — scans every doc for stale references, updates affected sections. Triggers: "sync docs" | "update docs" | "doc sync" | "sync plugin docs" | "update skill docs" | "update the docs".'
version: 0.4.0
allowed-tools: Bash, Read, Write, Edit, Glob, Grep, ToolSearch
---

# Doc Sync

Let:
  δ := change description | K := keywords from δ (tools, config fields, CLI flags, paths, functions)
  SRC ∈ {working-tree, staged, last-commit} | D := {doc files referencing K}
  EDITED := [] — accumulator of modified files

Code change → find **every** doc referencing affected concepts → update.

**⚠ Continuous pipeline. Stop only on: Cancel or Phase 6 completion.**

```
/doc-sync                             → auto-detect from working tree or last commit
/doc-sync "gitleaks → trufflehog"     → user-supplied description
```

## Phase 1 — Parse Input

δ := `$ARGUMENTS` ∨ derive from git (first non-empty wins):

```bash
git diff --stat            # 1. unstaged
git diff --cached --stat   # 2. staged
git diff HEAD~1..HEAD --stat && git log -1 --format="%s%n%b"  # 3. last commit
```

Record SRC. ¬δ after scan → → DP(B) describe change.

## Phase 2 — Discover Context

**2a.** `cat .claude/stack.yml 2>/dev/null` → ∃ `docs.path` → DOCS_ROOT = docs.path; else project root.

**2b.** `ls .claude-plugin/marketplace.json 2>/dev/null` → ∃ → `PLUGINS_REPO=$(pwd)`. Skip to 2d.

**2c.** Locate plugin repo:
```bash
[ -n "$ROXABI_PLUGINS_DIR" ] && echo "$ROXABI_PLUGINS_DIR"
for d in ../*/; do [ -f "${d}.claude-plugin/marketplace.json" ] && [ -d "${d}plugins" ] && echo "$d" && break; done
```
First hit → `PLUGINS_REPO`. ¬found → warn + skip plugin docs.

**2d.** Plugin name:
```bash
REPO=$(gh repo view --json name --jq '.name')
ls "$PLUGINS_REPO/plugins/"
```
Exact ∨ kebab-case match → auto-set. Multiple/¬match → → DP(B) ¬found → warn + skip SKILL.md.

**2e.** `ls "$PLUGINS_REPO/plugins/$PLUGIN_NAME/skills/"` → one → use. Multiple → → DP(B)

## Phase 3 — Read Changes + Extract K

```bash
git diff --name-only                  # SRC=working-tree
git diff --cached --name-only         # SRC=staged
git diff HEAD~1..HEAD --name-only     # SRC=last-commit
```

Read changed files. Extract K: tool/library names (added/removed/replaced), config fields, CLI flags, env vars, paths, functions, classes, renamed concepts.

K must include **both old and new** names for renames (grep finds stale refs).

## Phase 4 — Scan Docs for Stale References

```bash
# Project docs (exclude node_modules, .venv, vendor, dist, .git)
find . -type f \( -name "*.md" -o -name "*.mdx" \) \
  -not -path "*/node_modules/*" \
  -not -path "*/.venv/*" \
  -not -path "*/vendor/*" \
  -not -path "*/dist/*" \
  -not -path "*/.git/*"
```

∀ k ∈ K: grep across docs. D = {file | ∃ k ∈ K : k ∈ file.content}.

Always include (even if K ∉ content): `CLAUDE.md`, root `README.md`, plugin `README.md` (∃ PLUGINS_REPO), matching `SKILL.md` files.

Display:
```
Docs referencing changed concepts:
  CLAUDE.md                              2 matches (gitleaks)
  docs/guides/deployment.mdx             1 match (gitleaks)
  plugins/dev-core/hooks/README.md       3 matches (gitleaks, .gitleaks.toml)
  README.md                              0 matches (always checked)
  ...

{|D|} docs to review.
```

|D| = 0 (only always-included, 0 matches) → → DP(A) **Force update core docs** | **Skip** → Skip: Phase 6.

## Phase 5 — Update Docs

∀ file ∈ D (order: CLAUDE.md → README.md → SKILL.md → rest alphabetically):

Targeted edits only — find affected section, update those lines. ¬rewrite unrelated. Append to EDITED after each.

| Doc type | Audience | Guidelines |
|----------|----------|------------|
| `CLAUDE.md` | LLM | Codebase instructions, paths, conventions. Precise. |
| `README.md` (root) | Humans | User perspective. ¬implementation details. |
| `SKILL.md` | LLM | Skill instructions. ¬bump version unless behavior changed. |
| Plugin `README.md` | Humans | Usage, install, triggers. |
| `docs/**/*.md{,x}` | Devs | Standards, guides. Match style. |
| ADRs (`adr/`) | Devs | ¬edit (immutable). Warn if stale. |
| `references/*.md` | LLM | Reference material. Keep factual. |
| Agent files | LLM | Update tool/config references. |

**Per file:** grep K → locate lines → read ±10 context → replace old with new. ¬match but always-included → add section only if δ introduces relevant concept.

**Stale ADR:** ∀ ADR ∈ D: ¬edit. Display: `⚠️  ADR {number} references {keyword} — consider new ADR if decision changed.`

## Phase 6 — Summary

```
Doc Sync Complete
=================

  Change:  <one-line δ>
  Source:  <SRC>
  Scanned: <N> doc files for <|K|> keywords

  Updated:
    CLAUDE.md                           ✅ <section>
    plugins/dev-core/hooks/README.md    ✅ <section>
    ...

  Skipped:
    README.md                           ⏭ no references found
    docs/architecture/adr/005-...       ⏭ ADR (immutable)
    ...

  {|EDITED|} files updated, {|D| - |EDITED|} skipped.
```

→ DP(A) **Commit project docs** | **Commit all (project + plugin)** | **Skip**

Commit → `git add ${EDITED}` + `docs:` prefix. Plugin repo ≠ CWD ∧ plugin files ∈ EDITED → "Commit `$PLUGINS_REPO` separately."

## Edge Cases

| Scenario | Behavior |
|----------|----------|
| ¬git repo | Read docs from CWD, skip git context |
| ¬CLAUDE.md ∨ ¬README.md | Skip, warn |
| ¬PLUGINS_REPO | Project docs only |
| ¬plugin dir | Project docs only, warn |
| δ vague | → DP(B) narrow to one feature |
| Unrelated files changed | Focus on δ only |
| SRC=working-tree ∧ ¬PLUGINS_REPO | Warn to set `$ROXABI_PLUGINS_DIR` |
| Rename A → B | K includes both; grep finds stale A |
| ADR references K | Warn, ¬edit |
| |D| > 20 | List, present decision via protocol: read `${CLAUDE_PLUGIN_ROOT}/../shared/references/decision-presentation.md` (Pattern A): **Update all** ∨ **Select** ∨ **Skip** |

$ARGUMENTS

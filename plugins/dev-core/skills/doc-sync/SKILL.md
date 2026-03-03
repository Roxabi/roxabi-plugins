---
name: doc-sync
argument-hint: '[description of change]'
description: Sync project docs (CLAUDE.md, README.md) and the matching plugin SKILL.md after a code change. Triggers: "sync docs" | "update docs" | "doc sync" | "sync plugin docs" | "update skill docs" | "update the docs".
version: 0.3.0
allowed-tools: Bash, Read, Write, Edit, Glob, Grep
---

# Doc Sync

Let:
  δ := change description
  SRC ∈ {working-tree, staged, last-commit}

Code change → keep three docs in sync:
- `CLAUDE.md` — Claude-facing codebase instructions
- `README.md` — human-facing docs
- `SKILL.md` — LLM-facing skill instructions (in plugin repo)

**⚠ Flow: single continuous pipeline. Stop only on: explicit Cancel, or Phase 5 completion.**

```
/doc-sync                             → auto-detect from working tree or last commit
/doc-sync "walk-up config discovery"  → user-supplied description
```

## Phase 1 — Parse Input

δ := `$ARGUMENTS` ∨ derive from git.

¬δ → detect in priority order (first non-empty wins):

```bash
git diff --stat            # 1. unstaged
git diff --cached --stat   # 2. staged
git diff HEAD~1..HEAD --stat && git log -1 --format="%s%n%b"  # 3. last commit
```

Record SRC. ¬δ after scan → AskUserQuestion: describe the change in one sentence.

## Phase 2 — Discover Context

**2a. Stack config:**
```bash
cat .claude/stack.yml 2>/dev/null
```
∃ `docs.path` → use as base for CLAUDE.md/README.md. Else: project root.

**2b. Self-referential check:**
```bash
ls .claude-plugin/marketplace.json 2>/dev/null
```
∃ → `PLUGINS_REPO=$(pwd)`. Skip to 2d.

**2c. Locate plugin repo:**
```bash
[ -n "$ROXABI_PLUGINS_DIR" ] && echo "$ROXABI_PLUGINS_DIR"
for d in ../*/; do [ -f "${d}.claude-plugin/marketplace.json" ] && echo "$d" && break; done
```
First hit → `PLUGINS_REPO`. ¬found → warn + skip Phase 4c.

**2d. Plugin name:**
```bash
REPO=$(gh repo view --json name --jq '.name')
ls "$PLUGINS_REPO/plugins/"
```
Exact ∨ kebab-case match → `PLUGIN_NAME` auto-set.
Multiple candidates ∨ ¬match → AskUserQuestion: select plugin.
¬found → warn + skip SKILL.md update.

**2e. Locate SKILL.md:**
```bash
ls "$PLUGINS_REPO/plugins/$PLUGIN_NAME/skills/"
```
∃ one → use it. Multiple → AskUserQuestion: select skill.

## Phase 3 — Read Changed Code

```bash
git diff --name-only                  # SRC=working-tree
git diff --cached --name-only         # SRC=staged
git diff HEAD~1..HEAD --name-only     # SRC=last-commit
```

Read changed files (most relevant if many). Extract:
- feature/behavior changed
- user-visible concepts added/modified/removed
- config fields, CLI flags, file paths, default values

`EDITED_FILES = []` — append each file modified in Phase 4.

## Phase 4 — Update Docs

Targeted edits only — find affected section, update those lines. ¬rewrite unrelated sections. Append to `EDITED_FILES` after each edit.

**4a. CLAUDE.md:** Grep for relevant keywords → update section. ¬match → add subsection under nearest heading.

**4b. README.md:** Same approach, user perspective only (¬implementation details).

**4c. SKILL.md** (∃ `PLUGINS_REPO`):
```
TARGET = "$PLUGINS_REPO/plugins/$PLUGIN_NAME/skills/<skill>/SKILL.md"
```
Same targeted edit, adapted to LLM-facing language. ¬bump version unless behavior fundamentally changed.

## Phase 5 — Summary

```
Doc Sync Complete
=================

  Change:  <one-line description>
  Source:  <SRC>

  CLAUDE.md   ✅ updated — <section>  |  ⏭ skipped
  README.md   ✅ updated — <section>  |  ⏭ skipped
  SKILL.md    ✅ updated — <plugin>/<skill> § <section>  |  ⏭ skipped — plugin repo not found
```

AskUserQuestion: **Commit project docs** | **Commit all (project + plugin)** | **Skip**

Commit approved → `git add ${EDITED_FILES}` + commit with `docs:` prefix.
Plugin repo updated → inform: "Commit `$PLUGINS_REPO` separately."

## Edge Cases

| Scenario | Behavior |
|----------|----------|
| ¬git repo | Read docs from CWD, skip git-derived context |
| ¬CLAUDE.md ∨ ¬README.md | Skip that file, warn |
| ¬PLUGINS_REPO | Project docs only |
| ¬plugin dir in PLUGINS_REPO | Project docs only, warn |
| δ vague | AskUserQuestion: narrow to one feature |
| Unrelated files changed | Focus on δ feature only |
| SRC=working-tree ∧ ¬PLUGINS_REPO set | Warn to set `$ROXABI_PLUGINS_DIR` |

$ARGUMENTS

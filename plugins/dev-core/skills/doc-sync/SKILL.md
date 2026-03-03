---
name: doc-sync
argument-hint: '[description of change]'
description: Sync project docs (CLAUDE.md, README.md) and the matching plugin SKILL.md after a code change. Triggers: "sync docs" | "update docs" | "doc sync" | "sync plugin docs" | "update skill docs" | "update the docs".
version: 0.2.0
allowed-tools: Bash, Read, Write, Edit, Glob, Grep
---

# Doc Sync

After a code change, keep three docs in sync:
1. `CLAUDE.md` — codebase instructions for Claude (in the project repo)
2. `README.md` — human-facing docs (in the project repo)
3. Plugin `SKILL.md` — LLM-facing skill instructions (in `roxabi-plugins`)

**⚠ Flow: single continuous pipeline. Stop only on: explicit Cancel, or Phase 5 completion.**

```
/doc-sync                        → auto-detect changes from working tree or last commit
/doc-sync "walk-up config discovery"  → user-provided description
```

## Phase 1 — Parse Input

δ := `$ARGUMENTS` if provided, else derive from git.

¬δ — detect changes in priority order:

```bash
# 1. Unstaged changes
git diff --stat

# 2. Staged changes
git diff --cached --stat

# 3. Last commit
git diff HEAD~1..HEAD --stat
git log -1 --format="%s%n%b"
```

Use the first non-empty result. Record source: `working-tree | staged | last-commit`.

If still unclear → AskUserQuestion: describe the change in one sentence.

## Phase 2 — Discover Context

**2a. Stack config:**

```bash
cat .claude/stack.yml 2>/dev/null
```

If present, extract `docs.path` (custom docs dir) and `docs.format`. Falls back to project root for CLAUDE.md/README.md if not set.

**2b. Self-referential check:**

```bash
ls .claude-plugin/marketplace.json 2>/dev/null
```

∃ → this IS the plugin repo. Set `PLUGINS_REPO=$(pwd)`. Skip to Phase 2d.

**2c. Locate plugin repo:**

Priority order:
1. `$ROXABI_PLUGINS_DIR` env var
2. Sibling dirs: `ls ../` → find dir containing `.claude-plugin/marketplace.json`

```bash
[ -n "$ROXABI_PLUGINS_DIR" ] && echo "$ROXABI_PLUGINS_DIR"
for d in ../*/; do [ -f "${d}.claude-plugin/marketplace.json" ] && echo "$d" && break; done
```

First hit that exists → `PLUGINS_REPO`.
¬found → warn: "Plugin repo not found. Set ROXABI_PLUGINS_DIR or place roxabi-plugins as a sibling directory." Update project docs only (skip Phase 4c).

**2d. Plugin name:**

```bash
ls "$PLUGINS_REPO/plugins/"
```

1. Get current repo name: `gh repo view --json name --jq '.name'`
2. Check if a plugin dir matches (exact or kebab-case): use it automatically
3. Multiple candidates or no match → AskUserQuestion: select which plugin to update
4. ¬found → warn + skip SKILL.md update

**2e. Locate SKILL.md:**

```bash
ls "$PLUGINS_REPO/plugins/$PLUGIN_NAME/skills/"
```

∃ one skill dir → use it. Multiple → AskUserQuestion: select which skill to update.

## Phase 3 — Read Changed Code

Read the files that changed (using the source detected in Phase 1):

```bash
# unstaged
git diff --name-only

# staged
git diff --cached --name-only

# last commit
git diff HEAD~1..HEAD --name-only
```

Read each changed file (or the most relevant ones if many). Understand:
- What feature/behavior changed
- Which user-visible concepts were added/modified/removed
- Any config fields, CLI flags, file paths, or default values that changed

Track `EDITED_FILES = []` — populated in Phase 4 as each file is modified.

## Phase 4 — Update Docs

For each target doc, make **targeted edits only** — find the section(s) affected by the change and update those lines. ¬rewrite unrelated sections. Append file path to `EDITED_FILES` after each edit.

**4a. CLAUDE.md** (at project root or `docs.path` from stack.yml):

- Locate the section describing the changed feature (grep for relevant keywords)
- Update the description, add/remove fields, fix examples
- If no matching section exists → add a new subsection under the most relevant heading

**4b. README.md** (at project root or `docs.path` from stack.yml):

- Same targeted approach: find the user-facing section for the changed feature
- Update examples, behavior descriptions, flags, config fields
- Keep the user perspective (¬implementation details)

**4c. Plugin SKILL.md** (if `PLUGINS_REPO` found):

```
TARGET = "$PLUGINS_REPO/plugins/$PLUGIN_NAME/skills/<skill>/SKILL.md"
```

- Find the section in SKILL.md that describes the changed feature
- Make the same targeted edit as CLAUDE.md/README.md, adapted to LLM-facing language
- ¬bump version unless the skill's behavior fundamentally changed

## Phase 5 — Summary

Display:

```
Doc Sync Complete
=================

  Change:   <one-line description of what changed>
  Source:   working-tree | staged | last-commit

  CLAUDE.md       ✅ updated — <section name>
  README.md       ✅ updated — <section name>
  SKILL.md        ✅ updated — <plugin>/<skill> § <section name>
                  (or ⏭ skipped — plugin repo not found)

  Commit?   git add <edited files> && git commit -m "docs: ..."
            (and a separate commit in roxabi-plugins if SKILL.md updated)
```

AskUserQuestion: **Commit project docs** | **Commit all (project + plugin)** | **Skip commit**

If commit approved → `git add` only files in `EDITED_FILES` + commit with `docs:` prefix.
If plugin repo updated → inform: "Commit `$PLUGINS_REPO` separately."

## Edge Cases

| Scenario | Behavior |
|----------|----------|
| ¬git repo | Read CLAUDE.md/README.md from CWD, skip git-derived context |
| No CLAUDE.md | Skip, warn |
| No README.md | Skip, warn |
| Plugin repo not found | Update project docs only |
| Plugin dir not in plugin repo | Update project docs only, warn |
| δ vague / too broad | AskUserQuestion: narrow down which feature changed |
| Multiple files changed, unrelated | Focus on the feature described in δ |
| Running from plugin repo | PLUGINS_REPO = CWD, skip discovery (self-referential) |
| No $ROXABI_PLUGINS_DIR + no sibling | Update project docs only, warn to set env var |

$ARGUMENTS

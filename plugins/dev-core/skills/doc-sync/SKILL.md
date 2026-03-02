---
name: doc-sync
argument-hint: '[description of change]'
description: Sync project docs (CLAUDE.md, README.md) and the matching plugin SKILL.md after a code change. Triggers: "sync docs" | "update docs" | "doc sync" | "sync plugin docs" | "update skill docs" | "update the docs".
version: 0.1.0
allowed-tools: Bash, Read, Write, Edit, Glob, Grep
---

# Doc Sync

After a code change, keep three docs in sync:
1. `CLAUDE.md` — codebase instructions for Claude (in the project repo)
2. `README.md` — human-facing docs (in the project repo)
3. Plugin `SKILL.md` — LLM-facing skill instructions (in `roxabi-plugins`)

**⚠ Flow: single continuous pipeline. Stop only on: explicit Cancel, or Phase 5 completion.**

```
/doc-sync                        → auto-detect changes from git diff
/doc-sync "walk-up config discovery"  → user-provided description
```

## Phase 1 — Parse Input

δ := `$ARGUMENTS` if provided, else derive from git.

¬δ:
```bash
git diff HEAD~1..HEAD --stat
git log -1 --format="%s%n%b"
```
Extract changed feature from diff stat + last commit message.

If still unclear → AskUserQuestion: describe the change in one sentence.

## Phase 2 — Discover Context

**2a. Project identity:**
```bash
git remote get-url origin
```
Extract `<owner>/<repo>` → derive plugin name:
- kebab-case the repo name (e.g. `voiceCLI` → `voice-cli`, `VaultApp` → `vault-app`)
- Store as `PLUGIN_NAME`

**2b. Locate roxabi-plugins:**

Priority order:
1. `$ROXABI_PLUGINS_DIR` env var
2. Sibling dirs: `ls ../` → find dir named `roxabi-plugins`
3. Known path: `~/projects/roxabi-plugins`

```bash
[ -n "$ROXABI_PLUGINS_DIR" ] && echo "$ROXABI_PLUGINS_DIR" && exit
ls ../ 2>/dev/null | grep -i roxabi-plugins | head -1
echo "$HOME/projects/roxabi-plugins"
```

First hit that exists → `PLUGINS_REPO`.
¬found → warn: "roxabi-plugins not found. Set ROXABI_PLUGINS_DIR or place it as a sibling directory." Update project docs only (skip Phase 4b).

**2c. Locate plugin SKILL.md:**
```bash
ls "$PLUGINS_REPO/plugins/$PLUGIN_NAME/skills/"
```
∃ one skill dir → use it. Multiple → AskUserQuestion: select which skill to update.
¬found → warn + skip SKILL.md update.

## Phase 3 — Read Changed Code

Read the files that changed:
```bash
git diff HEAD~1..HEAD --name-only
```

Read each changed file (or the most relevant ones if many). Understand:
- What feature/behavior changed
- Which user-visible concepts were added/modified/removed
- Any config fields, CLI flags, file paths, or default values that changed

## Phase 4 — Update Docs

For each target doc, make **targeted edits only** — find the section(s) affected by the change and update those lines. ¬rewrite unrelated sections.

**4a. CLAUDE.md:**

- Locate the section describing the changed feature (grep for relevant keywords)
- Update the description, add/remove fields, fix examples
- If no matching section exists → add a new subsection under the most relevant heading

**4b. README.md:**

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

  CLAUDE.md       ✅ updated — <section name>
  README.md       ✅ updated — <section name>
  SKILL.md        ✅ updated — <plugin>/<skill> § <section name>
                  (or ⏭ skipped — roxabi-plugins not found)

  Commit?   git add CLAUDE.md README.md && git commit -m "docs: ..."
            (and a separate commit in roxabi-plugins if SKILL.md updated)
```

AskUserQuestion: **Commit project docs** | **Commit all (project + plugin)** | **Skip commit**

If commit approved → stage specific files + commit with `docs:` prefix.
If plugin repo updated → inform: "Commit `$PLUGINS_REPO` separately."

## Edge Cases

| Scenario | Behavior |
|----------|----------|
| ¬git repo | Read CLAUDE.md/README.md from CWD, skip git-derived context |
| No CLAUDE.md | Skip, warn |
| No README.md | Skip, warn |
| roxabi-plugins not found | Update project docs only |
| Plugin dir not in roxabi-plugins | Update project docs only, warn |
| δ vague / too broad | AskUserQuestion: narrow down which feature changed |
| Multiple files changed, unrelated | Focus on the feature described in δ |

$ARGUMENTS

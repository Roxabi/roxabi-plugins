---
name: doc-sync
argument-hint: '[description of change]'
description: 'Sync all project docs after a code change — scans every doc for stale references, updates affected sections. Triggers: "sync docs" | "update docs" | "doc sync" | "sync plugin docs" | "update skill docs" | "update the docs".'
version: 0.4.0
allowed-tools: Bash, Read, Write, Edit, Glob, Grep
---

# Doc Sync

Let:
  δ := change description
  K := keywords/concepts extracted from δ (tool names, config fields, CLI flags, file paths, function names)
  SRC ∈ {working-tree, staged, last-commit}
  D := set of all doc files that reference K
  EDITED_FILES := [] — accumulator of modified files

Code change → find **every** doc that references affected concepts → update them.

**⚠ Flow: single continuous pipeline. Stop only on: explicit Cancel, or Phase 6 completion.**

```
/doc-sync                             → auto-detect from working tree or last commit
/doc-sync "gitleaks → trufflehog"     → user-supplied description
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
∃ `docs.path` → DOCS_ROOT = docs.path. Else: DOCS_ROOT = project root.

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
First hit → `PLUGINS_REPO`. ¬found → warn + skip plugin doc updates.

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

## Phase 3 — Read Changed Code + Extract Keywords

```bash
git diff --name-only                  # SRC=working-tree
git diff --cached --name-only         # SRC=staged
git diff HEAD~1..HEAD --name-only     # SRC=last-commit
```

Read changed files (most relevant if many). Extract K:
- tool/library names added, removed, or replaced (e.g. `gitleaks`, `trufflehog`)
- config fields, CLI flags, environment variables changed
- file paths, function names, class names modified
- concepts renamed or restructured

K must include **both old and new** names when something is renamed/replaced (grep must find stale references).

## Phase 4 — Scan All Docs for Stale References

Find every doc file in the project that references K:

```bash
# Project docs (exclude node_modules, .venv, vendor, dist, .git)
find . -type f \( -name "*.md" -o -name "*.mdx" \) \
  -not -path "*/node_modules/*" \
  -not -path "*/.venv/*" \
  -not -path "*/vendor/*" \
  -not -path "*/dist/*" \
  -not -path "*/.git/*"
```

∀ keyword ∈ K: grep across all found doc files. Collect:

```
D = { file | file ∈ docs ∧ ∃ k ∈ K : k ∈ file.content }
```

Always include these if they exist (even if K ∉ content — they may need new sections):
- `CLAUDE.md`
- `README.md` (project root)
- Plugin `README.md` (∃ PLUGINS_REPO)
- Matching `SKILL.md` files (∃ PLUGINS_REPO)

Display scan results:

```
Docs referencing changed concepts:
  CLAUDE.md                              2 matches (gitleaks)
  docs/guides/deployment.mdx             1 match (gitleaks)
  plugins/dev-core/hooks/README.md       3 matches (gitleaks, .gitleaks.toml)
  README.md                              0 matches (always checked)
  ...

{|D|} docs to review.
```

|D| = 0 (only always-included files, 0 matches) → display "No docs reference changed concepts" → AskUserQuestion: **Force update core docs anyway** | **Skip** → Skip: jump to Phase 6.

## Phase 5 — Update Docs

∀ file ∈ D (sorted: CLAUDE.md first, README.md second, SKILL.md third, then rest alphabetically):

Targeted edits only — find affected section, update those lines. ¬rewrite unrelated sections. Append to `EDITED_FILES` after each edit.

**Per-file rules:**

| Doc type | Audience | Guidelines |
|----------|----------|------------|
| `CLAUDE.md` | Claude / LLM | Codebase instructions, paths, conventions. Be precise. |
| `README.md` (root) | Humans (users) | User perspective. ¬implementation details. |
| `SKILL.md` | Claude / LLM | Skill instructions. ¬bump version unless behavior changed. |
| Plugin `README.md` | Humans (users) | Plugin usage, install, trigger phrases. |
| `docs/**/*.md{,x}` | Humans (devs) | Standards, guides, architecture. Match existing style. |
| ADRs (`adr/`) | Humans (devs) | ¬edit ADRs — they are immutable records. Warn if stale. |
| `references/*.md` | Claude / LLM | Reference material for skills. Keep factual. |
| Agent files (`agents/*.md`) | Claude / LLM | Agent instructions. Update tool/config references. |

**Edit approach per file:**
1. Grep for K within the file → locate exact lines
2. Read surrounding context (±10 lines)
3. Edit: replace old references with new, update descriptions
4. ¬match but file is in always-included set → check if a new section is needed. Only add if δ introduces a concept that belongs in that doc.

**Stale ADR warning:**
∀ ADR ∈ D: ¬edit. Instead display:
```
⚠️  ADR {number} references {keyword} — consider a new ADR if the decision has changed.
```

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

  {|EDITED_FILES|} files updated, {|D| - |EDITED_FILES|} skipped.
```

AskUserQuestion: **Commit project docs** | **Commit all (project + plugin)** | **Skip**

Commit approved → `git add ${EDITED_FILES}` + commit with `docs:` prefix.
Plugin repo ≠ CWD ∧ plugin files ∈ EDITED_FILES → inform: "Commit `$PLUGINS_REPO` separately."

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
| Rename/replace (A → B) | K includes both A and B; grep finds stale A refs |
| ADR references K | Warn, ¬edit (immutable) |
| |D| > 20 | Display list, AskUserQuestion: **Update all** ∨ **Select** ∨ **Skip** |

$ARGUMENTS

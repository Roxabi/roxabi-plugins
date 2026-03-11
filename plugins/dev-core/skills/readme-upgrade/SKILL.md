---
name: readme-upgrade
argument-hint: '[--target root|plugins|contributing|all] [--plugin <name>] [--force]'
description: 'Audit and upgrade project documentation quality — README.md, CONTRIBUTING.md, plugin READMEs — against the developer-tool pattern (Why, Quick Start, How it works, command tables with categories, diagram). Triggers: "improve readme" | "upgrade docs" | "readme quality" | "improve docs" | "doc audit" | "readme upgrade" | "improve contributing" | "docs health".'
version: 0.1.0
allowed-tools: Bash, Read, Write, Edit, Glob, Grep, ToolSearch, AskUserQuestion
---

# Readme Upgrade

Let:
  σ := `.claude/stack.yml` config
  M := project metadata (name, description, repo URL, license)
  TARGET ∈ {root, plugins, contributing, all} — default: all
  DIAGRAM ∈ {mermaid, ascii} — auto-detected
  FINDINGS := [] — audit findings per file
  EDITED := [] — files actually improved

**Goal:** audit existing docs against the developer-tool quality pattern and apply targeted improvements. Never rewrite sections that already meet the standard — only fill gaps and strengthen weak sections.

**Idempotent** — sections already meeting the checklist are skipped unless `--force` is passed.

```
/readme-upgrade                            → audit + improve all docs
/readme-upgrade --target root              → root README.md only
/readme-upgrade --target plugins           → all plugin READMEs
/readme-upgrade --target contributing      → CONTRIBUTING.md only
/readme-upgrade --plugin dev-core          → one plugin README only
/readme-upgrade --force                    → re-audit even passing sections
```

## Developer-Tool Documentation Pattern

The quality standard used by this skill. Applied to all docs.

### Root README checklist

| # | Section | Required | Pattern |
|---|---------|----------|---------|
| 1 | Title + tagline | ✅ | `# Name` + one bold sentence below or badge row |
| 2 | Badges | ✅ | CI, license, version on one line (shields.io) |
| 3 | One-liner description | ✅ | ≤ 2 sentences: what it is + for whom |
| 4 | Why / Problem | ✅ | 1–3 paragraphs: what problem, why it exists |
| 5 | Quick Start | ✅ | Install + first command, copy-paste ready, < 10 lines |
| 6 | How it works | ✅ | Mental model + optional diagram (≤ 200 words) |
| 7 | Feature/command table | ✅ | Grouped by category, 2–3 columns |
| 8 | Configuration | if applicable | Key config reference |
| 9 | Contributing | ✅ | Link to CONTRIBUTING.md + 1-liner |
| 10 | License | ✅ | `MIT` one-liner |

### Plugin README checklist

| # | Section | Required |
|---|---------|----------|
| 1 | Plugin name + one-liner | ✅ |
| 2 | Why this plugin / use case | ✅ |
| 3 | Install commands | ✅ |
| 4 | Trigger phrases + usage examples | ✅ |
| 5 | How it works (brief) | ✅ |
| 6 | Configuration (if applicable) | if applicable |
| 7 | Attribution (for wrapped plugins) | if applicable |

### CONTRIBUTING.md checklist

| # | Section | Required |
|---|---------|----------|
| 1 | Dev environment setup | ✅ |
| 2 | How to run tests | ✅ |
| 3 | Commit format | ✅ |
| 4 | PR process | ✅ |
| 5 | Code review expectations | ✅ |

## Diagram Format

Auto-detect:
```bash
git remote get-url origin 2>/dev/null
```

- GitHub URL (`github.com`) → DIAGRAM=`mermaid` — GitHub renders ` ```mermaid ` natively since 2022
- npm publish target (check `package.json` `"publishConfig"` or `scripts.publish`) → DIAGRAM=`ascii` — npm page does not render Mermaid
- No remote or other host → DIAGRAM=`ascii`

Use Mermaid `flowchart LR` for workflow diagrams. Use ASCII for sequence/timing if Mermaid adds no clarity.

## Phase 1 — Load Context

**1a.** Read σ (`cat .claude/stack.yml 2>/dev/null`). Extract: `runtime`, `package_manager`, `docs.path`.

**1b.** Project metadata M:
```bash
gh repo view --json name,description,url,licenseInfo 2>/dev/null
# fallback:
cat package.json 2>/dev/null | python3 -m json.tool 2>/dev/null | grep -E '"name"|"description"|"version"|"license"'
cat pyproject.toml 2>/dev/null | grep -E '^name|^description|^version|^license'
```

**1c.** Detect diagram format (see above).

**1d.** Detect plugin marketplace:
```bash
ls .claude-plugin/marketplace.json 2>/dev/null && echo "marketplace"
ls plugins/ 2>/dev/null && echo "has-plugins"
```

**1e.** Parse `$ARGUMENTS`:
- `--target <t>` → TARGET=t
- `--plugin <n>` → TARGET=plugins, filter to `plugins/<n>/README.md`
- `--force` → override idempotency check

## Phase 2 — Discover Target Files

Based on TARGET:

| TARGET | Files to audit |
|--------|---------------|
| `root` | `README.md` |
| `contributing` | `CONTRIBUTING.md` |
| `plugins` | `plugins/*/README.md` (∀ plugins) |
| `all` | all of the above |

For each file: check existence. Missing files → note in FINDINGS as `missing` severity; do not create (use `/seed-community` for that). ¬exist + ≥ 1 file missing → warn once at end.

## Phase 3 — Audit Each File

∀ file ∈ targets (order: README.md → CONTRIBUTING.md → plugins/* alphabetically):

**3a.** Read the file.

**3b.** Run checklist for its type (root / plugin / contributing). For each item:
- ✅ **Pass** — section exists and has ≥ 3 lines of real content
- ⚠️ **Weak** — section exists but is < 3 lines, lacks examples, or is a stub
- ❌ **Missing** — section not found at all

**3c.** Append to FINDINGS:
```
{file}:
  ❌ Missing: Why / Problem statement
  ⚠️ Weak:    Feature table — flat list, no categories, no "Notes" column
  ✅ Pass:    Quick Start
  ✅ Pass:    License
```

**3d.** Skip ✅ items unless `--force`.

## Phase 4 — Present Findings

Display full FINDINGS summary:

```
Readme Upgrade — Audit Report
==============================

README.md (root)
  ❌ Missing: Why / Problem statement
  ❌ Missing: How it works
  ⚠️ Weak:   Feature table — no categories, flat list of 14 items
  ✅ Pass:   Title + tagline
  ✅ Pass:   Quick Start
  ✅ Pass:   Install
  ✅ Pass:   License

CONTRIBUTING.md
  ✅ Pass:   Dev environment setup
  ⚠️ Weak:   Commit format — mentions format but no examples
  ❌ Missing: Code review expectations

plugins/dev-core/README.md
  ✅ Pass:   All sections

plugins/compress/README.md
  ❌ Missing: Why this plugin
  ⚠️ Weak:   Usage — trigger phrases only, no example workflow

  ... (N more)

Summary: {total_missing} missing, {total_weak} weak, {total_pass} passing
         across {N} files
```

AskUserQuestion: **Fix all findings** | **Select files** | **Show me a preview first** | **Cancel**
- "Select" → list files numbered, ask which to fix (comma-separated indices).
- "Preview" → show a before/after for the first ❌ Missing finding, then re-ask.

## Phase 5 — Improve Docs

∀ file ∈ selected (order: root README → CONTRIBUTING → plugins/*):

For each ❌/⚠️ finding in the file, apply a targeted improvement:

### Writing rules

- **Tone:** direct, imperative ("Install with..." not "You can install with..."). No filler.
- **Length:** each new section ≤ 150 words unless it's a reference table.
- **No fabrication:** if M has no description, ask once: AskUserQuestion: "One-liner for {project}?"
- **Diagrams:** use DIAGRAM format. Mermaid → `flowchart LR` unless another type fits better.
- **Tables:** 2–3 columns max. If features > 8, group into categories (H3 headers above each sub-table or a "Category" first column).
- **Callout blocks** (`> [!NOTE]`, `> [!TIP]`, `> [!IMPORTANT]`) — use for key warnings or tips. GitHub renders them as colored panels.
- **Preserve existing structure** — insert new sections at the logical position; don't reorder what already works.

### Section templates

**Why / Problem statement:**
```markdown
## Why

<project> exists because <problem statement>.

<who it's for> — <what they get>.
```

**How it works:**
```markdown
## How it works

<1–3 sentence mental model.>

```mermaid
flowchart LR
  A[Step 1] --> B[Step 2] --> C[Step 3]
```
```

**Feature table with categories:**
```markdown
## <Features / Skills / Commands>

### <Category A>

| Name | Description |
|------|-------------|
| ... | ... |

### <Category B>

| Name | Description |
|------|-------------|
```

**Quick Start:**
```markdown
## Quick Start

```bash
# 1. Install
<install command>

# 2. First run
<first command>
```
```

After each file: display `✅ {file} — {N} sections improved`.
Append file to EDITED.

## Phase 6 — Summary

```
Readme Upgrade Complete
=======================

  Diagram format: {mermaid|ascii}

  Improved:
    README.md                        ✅  Why added, feature table categorized
    CONTRIBUTING.md                  ✅  Commit format examples added
    plugins/compress/README.md       ✅  Why added, workflow example added
    ...

  Skipped (already passing):
    plugins/dev-core/README.md       ⏭  all sections passed

  {|EDITED|} files improved, {skipped} skipped.
```

AskUserQuestion: **Commit improvements** | **Review first, commit manually** | **Skip**

"Commit" → `git add ${EDITED}` + commit:
```
docs: improve readme and contributing quality

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
```

## Edge Cases

| Scenario | Behavior |
|----------|----------|
| ¬CONTRIBUTING.md | Note in summary: "run /seed-community to create it" |
| Plugin README missing entirely | Note: "run /seed-community or create manually" |
| `--plugin` names unknown plugin | List available plugins, AskUserQuestion |
| Mermaid + npm publish | Warn: "npm pages don't render Mermaid — switching to ASCII" |
| M.description empty + ¬gh CLI | AskUserQuestion: "One-liner for <name>?" |
| Wrapped plugin (git subtree) | Note attribution requirement in finding if missing |
| ¬git repo | Skip commit offer |
| Finding count = 0 | "All docs pass the quality checklist. Use --force to re-audit." |
| `--force` on large repo | AskUserQuestion: **Confirm re-audit of {N} passing files** |

$ARGUMENTS

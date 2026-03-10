---
name: seed-docs
argument-hint: '[--docs-path <path>] [--no-scan]'
description: 'Populate scaffolded architecture/standards docs with real content extracted from CLAUDE.md and codebase analysis — fills TODO stubs, writes AI Quick Reference sections. Triggers: "seed docs" | "bootstrap docs" | "populate docs" | "fill architecture docs" | "seed architecture".'
version: 0.1.0
allowed-tools: Bash, Read, Write, Edit, Glob, Grep, ToolSearch, AskUserQuestion
---

# Seed Docs

Let:
  σ := `.claude/stack.yml` config
  DOCS := `docs.path` from σ (default: `docs`)
  FMT := `docs.format` from σ (default: `md`)
  STUBS := files with TODO markers or < 30 lines (excluding frontmatter/blank)
  K := knowledge extracted from CLAUDE.md + codebase scan

**Goal:** fill every stub doc so agents find actionable guidance, not placeholder text.

**Idempotent** — skip files with ≥ 30 lines of real content (no TODOs). Safe to re-run.

```
/seed-docs                   → auto-discover DOCS from stack.yml
/seed-docs --docs-path docs  → explicit path
/seed-docs --no-scan         → skip codebase scan, use CLAUDE.md only
```

## Phase 1 — Load Config

Read σ (`cat .claude/stack.yml 2>/dev/null`). Record DOCS, FMT, `runtime`, `backend.framework`, `frontend.framework`, `backend.orm`.

¬σ → DOCS=`docs`, FMT=`md`.

`$ARGUMENTS` contains `--docs-path <p>` → DOCS=p.
`$ARGUMENTS` contains `--no-scan` → skip Phase 3.

Check DOCS dir exists:
- ∄ → AskUserQuestion: **Run /init first to scaffold docs** | **Create docs dir and seed** | **Cancel**
  - "Run /init" → explain Phase 7a creates the stubs, exit.
  - "Create" → `mkdir -p {DOCS}/{architecture,standards,guides,processes}`, continue.
  - "Cancel" → exit.

## Phase 2 — Read CLAUDE.md

Read `CLAUDE.md` (∃) + any `@`-imported files it references.

Extract into K:
- **Purpose** — one-paragraph project summary (what it does, who uses it)
- **Architecture style** — monolith | monorepo | microservices | plugin-based | other
- **Module/folder structure** — any documented src/ layout, package names, plugin dirs
- **Naming conventions** — file, class, function, DB naming rules (explicit or inferred from examples)
- **Stack** — framework names, ORM, UI library, test runner, deploy target
- **Key commands** — dev, build, test, lint (from `commands.*` in σ or CLAUDE.md)
- **Domain terms** — glossary items, entity names, bounded contexts
- **Patterns** — any explicit "always X", "never Y", "use X for Y" rules
- **Data flow** — request lifecycle, event patterns, module boundaries if described
- **Error handling** — exception hierarchy, boundary rules if mentioned
- **Design principles** — numbered/bulleted principles from CLAUDE.md

Display: `Extracted {|K topics|} topics from CLAUDE.md.`

## Phase 3 — Codebase Scan (skip if `--no-scan`)

**3a. Entry points**
```bash
# Detect runtime entry point
ls {src,app,lib,packages,plugins}/index.{ts,js,py,go,rb} 2>/dev/null | head -5
ls main.{ts,js,py,go,rb} server.{ts,js} app.{ts,js,py} 2>/dev/null | head -5
```

**3b. Module structure** (TS/JS projects)
```bash
# Top-level dirs under src/ or app/ (max depth 2)
find src app lib packages plugins -maxdepth 2 -type d 2>/dev/null | sort | head -40
# Service/controller/repository naming
find . -name "*.service.ts" -o -name "*.controller.ts" -o -name "*.repository.ts" \
  -o -name "*.handler.ts" -o -name "*.resolver.ts" 2>/dev/null \
  | grep -v node_modules | head -20
```

For Python: scan for `*.py` modules, `routers/`, `models/`, `schemas/`, `services/`.
For Go: scan `cmd/`, `internal/`, `pkg/` dirs.

**3c. Naming patterns** — sample 10 files per type (`*.service.ts`, `*.test.ts`, etc.). Infer:
- File naming style (kebab-case, snake_case, PascalCase)
- Class/function naming from exported symbols in sampled files (read first 30 lines of 3 files)

**3d. Dependencies** — read `package.json` (JS) or `pyproject.toml` / `requirements.txt` (Python) or `go.mod`:
- Identify major deps (framework, ORM, validation, auth, HTTP client, testing)
- Note versions if relevant

**3e. Test conventions** — sample 2 test files: check describe/it/test naming, fixture patterns, co-location vs `__tests__/`.

Merge scan results into K. Display: `Codebase scan: {N} source files sampled, {M} patterns extracted.`

## Phase 4 — Identify Stubs

Find all docs under DOCS that are stubs:

```bash
find {DOCS} -type f \( -name "*.md" -o -name "*.mdx" \) | sort
```

For each file — count non-blank, non-frontmatter, non-comment lines. A file is a stub if:
- Contains `TODO:` markers, OR
- Has < 30 lines of real content

Display:
```
Stub files to populate ({N}):
  docs/architecture/index.md         3 lines, 2 TODOs
  docs/architecture/patterns.md      5 lines, 4 TODOs
  docs/standards/backend-patterns.md 8 lines, 5 TODOs
  docs/standards/testing.md          4 lines, 3 TODOs
  ...

Already populated ({M} files) — will skip.
```

N=0 → "All docs appear populated. Use --force to re-seed (not implemented). Exiting." → exit.

AskUserQuestion: **Populate {N} stub files** | **Select files** | **Cancel**
- "Select" → list files numbered, ask which to include (comma-separated indices).

## Phase 5 — Populate Stubs

∀ file ∈ selected stubs (order: architecture/index → architecture/patterns → architecture/ubiquitous-language → standards/* → guides/* → processes/* → rest):

**Read the file** → identify TODO sections → fill each section using K.

**Section filling rules:**

| Section | Source in K | Guidance |
|---------|-------------|----------|
| High-Level Overview / Architecture | K.purpose + K.architecture_style | 1–3 sentences + optional Mermaid if layers are clear |
| Layers | K.module_structure | Map dirs/packages to layer names |
| Naming Conventions | K.naming + scan inferences | Concrete examples from actual file names |
| Error Handling | K.error_handling | Document actual hierarchy if found; else leave TODO with hint |
| Data Flow | K.data_flow + K.module_structure | Request path description |
| Framework & ORM | K.stack + σ fields | State the actual framework/ORM versions |
| Module Structure | K.module_structure + scan | Show actual dir tree snippet |
| API Conventions | K.patterns + scan (controllers) | Concrete rules from CLAUDE.md + inferred |
| Test conventions | K.test + scan findings | Actual test file examples |
| Domain terms / Ubiquitous Language | K.domain_terms | Table: Term | Definition |
| **AI Quick Reference** | K.patterns | ≤ 10 imperative rules, "ALWAYS/NEVER/PREFER" format |

**Writing rules:**
- Replace `TODO: <placeholder text>` with real content. Remove the TODO line.
- Remove <!-- comment blocks --> that are now covered by real content.
- Keep <!-- --> comments only if they provide context the real content doesn't.
- Write for the actual audience: standards docs → developers; AI Quick Reference → agents.
- If K has no data for a section → keep the TODO but add a hint: `TODO: (seed-docs found no data — check CLAUDE.md or run /seed-docs after adding more project context)`.
- Never fabricate — if genuinely unknown, say so with a note.
- Match existing file format (md vs mdx). If mdx, wrap Mermaid in `<Mermaid>` component if Fumadocs is configured.

After each file: display `✅ {relative path} — {N} TODOs filled, {M} sections updated`.

## Phase 6 — AI Quick Reference Audit

After populating, verify every `## AI Quick Reference` section across all standards docs has ≥ 3 imperative rules.

Files with < 3 rules → add from K.patterns or infer from framework conventions.

## Phase 7 — Summary

```
Seed Docs Complete
==================

  Source:      CLAUDE.md{+ codebase scan}
  Topics:      {|K|} knowledge items extracted
  Populated:   {N} files
  Skipped:     {M} already-populated files
  TODOs filled: {total}

  Files updated:
    docs/architecture/index.md          ✅ 2 TODOs filled
    docs/architecture/patterns.md       ✅ 4 TODOs filled
    docs/standards/backend-patterns.md  ✅ 5 TODOs filled
    ...
```

AskUserQuestion: **Commit seeded docs** | **Review first, commit manually** | **Skip**

"Commit" → `git add {DOCS}` + commit message:
```
docs: seed architecture and standards docs from CLAUDE.md

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
```

## Edge Cases

| Scenario | Behavior |
|----------|----------|
| ¬CLAUDE.md | Warn "CLAUDE.md not found — scan only". Proceed with Phase 3. |
| ¬git repo | Skip commit offer |
| Python/Go project | Phase 3 adapts scan patterns; TS-specific patterns skipped |
| Monorepo | Scan top-level packages only; note in summary |
| ¬node_modules but package.json ∃ | Read package.json, skip file sampling |
| ADR files | Skip (immutable) |
| File already fully populated | Skip silently (counted in "Skipped") |
| K topic has no data | Keep TODO + add hint, do not fabricate |

$ARGUMENTS

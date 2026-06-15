---
name: seed-docs
argument-hint: '[--docs-path <path>] [--no-scan]'
description: 'Populate scaffolded architecture/standards docs with real content extracted from CLAUDE.md and codebase analysis — fills TODO stubs, writes AI Quick Reference sections. Triggers: "seed docs" | "bootstrap docs" | "populate docs" | "fill architecture docs" | "seed architecture".'
version: 0.1.0
allowed-tools: Bash, Read, Write, Edit, Glob, Grep, ToolSearch
---

# Seed Docs

Let:
  σ := `.claude/stack.yml` config
  DOCS := `docs.path` from σ (default: `docs`)
  FMT := `docs.format` from σ (default: `md`)
  θ := stub threshold (< 30 non-blank, non-frontmatter lines OR ∃ `TODO:` markers)
  K := knowledge extracted from CLAUDE.md + codebase scan

**Goal:** fill every stub doc so agents find actionable guidance, not placeholder text.

**Idempotent** — skip files with ≥ 30 lines of real content (∄ TODOs). Safe to re-run.

```
/seed-docs                   → auto-discover DOCS from stack.yml
/seed-docs --docs-path docs  → explicit path
/seed-docs --no-scan         → skip codebase scan, use CLAUDE.md only
```

## Phase 1 — Load Config

Read σ (`cat .claude/stack.yml 2>/dev/null`). Record DOCS, FMT, `runtime`, `backend.framework`, `frontend.framework`, `backend.orm`.

¬σ → DOCS=`docs`, FMT=`md`. `--docs-path <p>` ∈ $ARGUMENTS → DOCS=p. `--no-scan` ∈ $ARGUMENTS → skip Phase 3.

DOCS dir ∄ → → DP(A) **Run /init first** | **Create docs dir and seed** | **Cancel**
- "Run /init" → explain Phase 7a creates stubs, exit.
- "Create" → `mkdir -p {DOCS}/{architecture,standards,guides,processes}`, continue.

## Phase 2 — Read CLAUDE.md

Read `CLAUDE.md` (∃) + any `@`-imported files it references.

Extract into K:
- **Purpose** — one-paragraph project summary
- **Architecture style** — monolith | monorepo | microservices | plugin-based | other
- **Module/folder structure** — src/ layout, package names, plugin dirs
- **Naming conventions** — file, class, function, DB naming rules
- **Stack** — framework, ORM, UI lib, test runner, deploy target
- **Key commands** — dev, build, test, lint (from `commands.*` in σ or CLAUDE.md)
- **Domain terms** — glossary items, entity names, bounded contexts
- **Patterns** — "always X", "never Y", "use X for Y" rules
- **Data flow** — request lifecycle, event patterns, module boundaries
- **Error handling** — exception hierarchy, boundary rules
- **Design principles** — numbered/bulleted principles from CLAUDE.md

Display: `Extracted {|K topics|} topics from CLAUDE.md.`

## Phase 3 — Codebase Scan (skip if `--no-scan`)

**3a. Entry points** — Glob: `{src,app,lib,packages,plugins}/index.{ts,js,py,go,rb}`, `main.{ts,js,py,go,rb}`, `server.{ts,js}`, `app.{ts,js,py}`

**3b. Module structure** — Glob `{src,app,lib,packages,plugins}/**` (head_limit: 40) + Bash(`ls`):
- Glob `**/*.{service,controller,repository,handler,resolver}.ts` (TS/JS)
- Python: Glob `**/*.py`, `**/routers/**`, `**/models/**`, `**/schemas/**`, `**/services/**`
- Go: Glob `cmd/**`, `internal/**`, `pkg/**`

**3c. Naming patterns** — Glob 10 files per type. Infer: file naming style, class/function naming (read first 30 lines of 3 files).

**3d. Dependencies** — read `package.json` | `pyproject.toml` / `requirements.txt` | `go.mod`. Identify major deps + versions if relevant.

**3e. Test conventions** — sample 2 test files: check describe/it/test naming, fixture patterns, co-location vs `__tests__/`.

Merge scan results into K. Display: `Codebase scan: {N} source files sampled, {M} patterns extracted.`

## Phase 4 — Identify Stubs

Glob: `{DOCS}/**/*.{md,mdx}`. ∀ file — count non-blank, non-frontmatter, non-comment lines. File matches θ → stub.

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

→ DP(A) **Populate {N} stub files** | **Select files** | **Cancel**
- "Select" → list files numbered, present via protocol: read `${CLAUDE_PLUGIN_ROOT}/../shared/references/decision-presentation.md` (Pattern C): which to include (comma-separated indices).

## Phase 5 — Populate Stubs

∀ file ∈ selected stubs (order: architecture/index → architecture/patterns → architecture/ubiquitous-language → standards/* → guides/* → processes/* → rest):

Read file → identify TODO sections → fill each using K.

**Section filling rules:**

| Section | Source in K | Guidance |
|---------|-------------|----------|
| High-Level Overview / Architecture | K.purpose + K.architecture_style | 1–3 sentences + optional Mermaid if layers clear |
| Layers | K.module_structure | Map dirs/packages to layer names |
| Naming Conventions | K.naming + scan inferences | Concrete examples from actual file names |
| Error Handling | K.error_handling | Actual hierarchy if found; else TODO with hint |
| Data Flow | K.data_flow + K.module_structure | Request path description |
| Framework & ORM | K.stack + σ fields | Actual framework/ORM versions |
| Module Structure | K.module_structure + scan | Actual dir tree snippet |
| API Conventions | K.patterns + scan (controllers) | Concrete rules from CLAUDE.md + inferred |
| Test conventions | K.test + scan findings | Actual test file examples |
| Domain terms / Ubiquitous Language | K.domain_terms | Table: Term \| Definition |
| **AI Quick Reference** | K.patterns | ≤ 10 imperative rules, "ALWAYS/NEVER/PREFER" format |

**Writing rules:**
- Replace `TODO: <placeholder>` with real content; remove the TODO line.
- Remove `<!-- comment blocks -->` covered by real content; keep only if they add context.
- Standards docs → write for developers; AI Quick Reference → write for agents.
- K has no data for section → keep TODO + add hint: `TODO: (seed-docs found no data — check CLAUDE.md or run /seed-docs after adding more project context)`.
- ¬fabricate — if genuinely unknown, say so with a note.
- Match existing FMT. If mdx + Fumadocs configured → wrap Mermaid in `<Mermaid>` component.

After each file: display `✅ {relative path} — {N} TODOs filled, {M} sections updated`.

## Phase 6 — AI Quick Reference Audit

After populating, verify ∀ `## AI Quick Reference` section across all standards docs has ≥ 3 imperative rules. < 3 rules → add from K.patterns or infer from framework conventions.

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

→ DP(A) **Commit seeded docs** | **Review first, commit manually** | **Skip**

"Commit" → `git add {DOCS}` + commit:
```
docs: seed architecture and standards docs from CLAUDE.md
```

## Edge Cases

| Scenario | Behavior |
|----------|----------|
| ¬CLAUDE.md | Warn "CLAUDE.md not found — scan only". Proceed with Phase 3. |
| ¬git repo | Skip commit offer |
| Python/Go project | Phase 3 adapts scan patterns; TS-specific patterns skipped |
| Monorepo | Scan top-level packages only; note in summary |
| ¬node_modules ∧ package.json ∃ | Read package.json, skip file sampling |
| ADR files | Skip (immutable) |
| File fully populated | Skip silently (counted in "Skipped") |
| K topic has no data | Keep TODO + add hint, ¬fabricate |

$ARGUMENTS

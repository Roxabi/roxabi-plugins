# seed-docs

Populate scaffolded architecture and standards docs with real content extracted from `CLAUDE.md` and codebase analysis — fills TODO stubs, writes AI Quick Reference sections.

## Usage

```
/seed-docs                     → Auto-discover docs path from stack.yml
/seed-docs --docs-path docs    → Explicit path
/seed-docs --no-scan           → Skip codebase scan, use CLAUDE.md only
```

## What it does

1. **Reads `CLAUDE.md`** — extracts purpose, architecture style, module structure, naming conventions, stack, key commands, domain terms, patterns, data flow, error handling, design principles
2. **Scans codebase** — samples entry points, module structure, naming patterns, dependencies, test conventions (skip with `--no-scan`)
3. **Identifies stub docs** — files with < 30 lines of real content or `TODO:` markers
4. **Fills each stub** — replaces TODO placeholders with real content from the extracted knowledge; adds an "AI Quick Reference" section with ≤10 imperative rules per standards doc
5. Offers to commit the populated docs

## What gets filled

| Section | Source |
|---------|--------|
| Architecture overview | CLAUDE.md purpose + style |
| Module/layer structure | Actual directory tree |
| Naming conventions | Sampled file names |
| Error handling | CLAUDE.md hierarchy |
| API conventions | Patterns + controllers |
| Test conventions | Sampled test files |
| Domain terms | CLAUDE.md glossary |
| AI Quick Reference | "always/never/prefer" rules |

Idempotent — skips fully-populated files (≥30 lines, no TODOs).

## Triggers

`"seed docs"` | `"bootstrap docs"` | `"populate docs"` | `"fill architecture docs"`

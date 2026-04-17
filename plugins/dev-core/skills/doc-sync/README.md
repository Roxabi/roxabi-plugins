# doc-sync

Sync all project docs after a code change — scans every doc for stale references and updates affected sections.

## Why

After renaming a tool, moving a file, or changing a config field, docs silently go stale — CLAUDE.md references old paths, skill READMEs mention removed flags, guides describe outdated workflows. `/doc-sync` extracts keywords from your change, greps every doc for matches, and makes targeted edits to the affected sections.

## Usage

```
/doc-sync                          Auto-detect change from git working tree or last commit
/doc-sync "gitleaks → trufflehog"  Supply a description directly
```

Triggers: `"sync docs"` | `"update docs"` | `"doc sync"` | `"sync plugin docs"` | `"update the docs"`

## How it works

1. **Parse input** — uses `$ARGUMENTS` as the change description; if absent, derives from `git diff --stat`, staged changes, or last commit message.
2. **Discover context** — finds the docs root from `stack.yml`, locates the plugin repo and matching SKILL.md.
3. **Extract keywords** — from changed files: tool/library names (old and new for renames), config fields, CLI flags, env vars, paths, functions.
4. **Scan docs** — greps all `.md`/`.mdx` files for keyword matches; always checks `CLAUDE.md`, root `README.md`, plugin `README.md`, and matching SKILL.md files regardless of matches.
5. **Update** — targeted edits only (find the affected section, replace those lines). Never rewrites unrelated content.
6. **Summary + commit offer** — lists updated files; offers to commit with a `docs:` prefix.

## Doc types and rules

| Type | Audience | Rule |
|------|----------|------|
| `CLAUDE.md` | LLM | Precise paths and conventions |
| Root `README.md` | Humans | User perspective, no implementation details |
| `SKILL.md` | LLM | Skill instructions, don't bump version unless behavior changed |
| Plugin `README.md` | Humans | Usage, install, triggers |
| ADRs | Devs | Never edited (immutable) — warns if stale |

## Safety

- ADRs are never edited — reports stale references only
- Never rewrites sections unrelated to the detected change

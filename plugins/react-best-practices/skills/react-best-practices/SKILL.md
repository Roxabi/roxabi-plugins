---
name: react-best-practices
description: 'React and Next.js performance optimization guidelines (58 rules, 8 categories). Triggers: "react best practices" | "optimize react" | "review react performance" | "next.js optimization".'
version: 0.1.0
allowed-tools: Read, Glob, Grep
---

# React Best Practices

Let:
  Φ := `references/AGENTS.md`

Apply Vercel Engineering's React and Next.js performance optimization guidelines when writing, reviewing, or refactoring code.

## Workflow

1. Read Φ — all 58 rules across 8 priority categories with code examples.

2. $ARGUMENTS ∃ → read those files. ∄ → ask which files to review.

3. Apply rules by priority:
   - **CRITICAL**: `async-` (waterfalls), `bundle-` (bundle size)
   - **HIGH**: `server-` (server-side performance)
   - **MEDIUM-HIGH**: `client-` (client-side data fetching)
   - **MEDIUM**: `rerender-` (re-render optimization), `rendering-`
   - **LOW-MEDIUM**: `js-` (JavaScript performance)
   - **LOW**: `advanced-`

4. ∀ finding → `file:line — rule-id — description`

5. Group by priority. Summarize total findings per category.

$ARGUMENTS

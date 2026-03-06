---
name: react-best-practices
description: 'React and Next.js performance optimization guidelines (58 rules, 8 categories). Triggers: "react best practices" | "optimize react" | "review react performance" | "next.js optimization".'
version: 0.1.0
allowed-tools: Read, Glob, Grep
---

# React Best Practices

Apply Vercel Engineering's React and Next.js performance optimization guidelines when writing, reviewing, or refactoring code.

## Workflow

1. Read the compiled rules reference:
   ```
   references/AGENTS.md
   ```
   This contains all 58 rules across 8 priority categories with code examples.

2. If the user provided files or a pattern via `$ARGUMENTS`, read those files. Otherwise, ask which files to review.

3. Apply rules by priority:
   - **CRITICAL**: Eliminating waterfalls (`async-`), Bundle size (`bundle-`)
   - **HIGH**: Server-side performance (`server-`)
   - **MEDIUM-HIGH**: Client-side data fetching (`client-`)
   - **MEDIUM**: Re-render optimization (`rerender-`), Rendering (`rendering-`)
   - **LOW-MEDIUM**: JavaScript performance (`js-`)
   - **LOW**: Advanced patterns (`advanced-`)

4. For each finding, output in terse format:
   ```
   file:line — rule-id — description of the issue
   ```

5. Group findings by priority. Summarize total findings per category.

$ARGUMENTS

# react-best-practices

React and Next.js performance optimization guidelines from Vercel Engineering. 58 rules across 8 categories, prioritized by impact.

Forked from [vercel-labs/agent-skills](https://github.com/vercel-labs/agent-skills/tree/main/skills/react-best-practices).

## Install

```bash
claude plugin marketplace add Roxabi/roxabi-plugins
claude plugin install react-best-practices
```

## Usage

Trigger phrases:

- "react best practices"
- "optimize react"
- "review react performance"
- "next.js optimization"

You can pass files or patterns as arguments:

```
/react-best-practices src/components/**/*.tsx
```

## What it does

The skill reads the compiled AGENTS.md reference (all 58 rules with code examples) and applies them to your code, grouped by priority:

| Priority | Category | Prefix |
|----------|----------|--------|
| CRITICAL | Eliminating Waterfalls | `async-` |
| CRITICAL | Bundle Size Optimization | `bundle-` |
| HIGH | Server-Side Performance | `server-` |
| MEDIUM-HIGH | Client-Side Data Fetching | `client-` |
| MEDIUM | Re-render Optimization | `rerender-` |
| MEDIUM | Rendering Performance | `rendering-` |
| LOW-MEDIUM | JavaScript Performance | `js-` |
| LOW | Advanced Patterns | `advanced-` |

Findings are output in `file:line` format, grouped by priority.

## Updating

Run the sync script to pull the latest rules from upstream:

```bash
./tools/sync-vercel-skills.sh
```

## License

MIT — original content by [Vercel](https://github.com/vercel-labs).

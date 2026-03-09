# composition-patterns

React composition patterns that scale. Avoid boolean prop proliferation by using compound components, lifting state, and composing internals.

Forked from [vercel-labs/agent-skills](https://github.com/vercel-labs/agent-skills/tree/main/skills/composition-patterns).

## Install

```bash
claude plugin marketplace add Roxabi/roxabi-plugins
claude plugin install composition-patterns
```

## Usage

Trigger phrases:

- "composition patterns"
- "refactor boolean props"
- "compound components"
- "component architecture"

You can pass files or patterns as arguments:

```
/composition-patterns src/components/Composer.tsx
```

## What it does

The skill reads the compiled AGENTS.md reference and applies composition rules to your code:

| Priority | Category | Prefix |
|----------|----------|--------|
| HIGH | Component Architecture | `architecture-` |
| MEDIUM | State Management | `state-` |
| MEDIUM | Implementation Patterns | `patterns-` |
| MEDIUM | React 19 APIs | `react19-` |

Key rules:
- Avoid boolean prop proliferation — use composition instead
- Structure complex components as compound components with shared context
- Decouple state management from UI via providers
- Create explicit variant components instead of boolean modes
- Prefer children over render props

Findings are output in `file:line` format, grouped by priority.

## Updating

Run the sync script to pull the latest rules from upstream:

```bash
./tools/sync-vercel-skills.sh
```

## License

MIT — original content by [Vercel](https://github.com/vercel-labs).

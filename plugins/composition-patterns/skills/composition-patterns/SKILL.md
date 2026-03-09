---
name: composition-patterns
description: 'React composition patterns that scale — avoid boolean prop proliferation, compound components, context providers. Triggers: "composition patterns" | "refactor boolean props" | "compound components" | "component architecture".'
version: 0.1.0
allowed-tools: Read, Glob, Grep
---

# React Composition Patterns

Apply composition patterns for building flexible, maintainable React components. Avoid boolean prop proliferation by using compound components, lifting state, and composing internals.

## Workflow

1. Read the compiled rules reference:
   ```
   references/AGENTS.md
   ```
   This contains all rules across 4 priority categories with code examples.

2. If the user provided files or a pattern via `$ARGUMENTS`, read those files. Otherwise, ask which files to review.

3. Apply rules by priority:
   - **HIGH**: Component architecture (`architecture-`) — avoid boolean props, compound components
   - **MEDIUM**: State management (`state-`) — decouple implementation, context interfaces, lift state
   - **MEDIUM**: Implementation patterns (`patterns-`) — explicit variants, children over render props
   - **MEDIUM**: React 19 APIs (`react19-`) — no forwardRef, use() instead of useContext()

4. For each finding, output in terse format:
   ```
   file:line — rule-id — description of the issue
   ```

5. Group findings by priority. Summarize total findings per category.

$ARGUMENTS

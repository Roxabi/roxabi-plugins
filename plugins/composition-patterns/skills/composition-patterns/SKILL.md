---
name: composition-patterns
description: 'React composition patterns that scale — avoid boolean prop proliferation, compound components, context providers. Triggers: "composition patterns" | "refactor boolean props" | "compound components" | "component architecture".'
version: 0.1.0
allowed-tools: Read, Glob, Grep
---

# React Composition Patterns

Let:
  Φ := `references/AGENTS.md`

Apply composition patterns for flexible, maintainable React components. Avoid boolean prop proliferation via compound components, state lifting, and composed internals.

## Workflow

1. Read Φ — all rules across 4 priority categories with code examples.

2. $ARGUMENTS ∃ → read those files. ∄ → ask which files to review.

3. Apply rules by priority:
   - **HIGH**: `architecture-` — avoid boolean props, compound components
   - **MEDIUM**: `state-` — decouple impl, context interfaces, lift state
   - **MEDIUM**: `patterns-` — explicit variants, children over render props
   - **MEDIUM**: `react19-` — ¬forwardRef, use() instead of useContext()

4. ∀ finding → `file:line — rule-id — description`

5. Group by priority. Summarize total findings per category.

$ARGUMENTS

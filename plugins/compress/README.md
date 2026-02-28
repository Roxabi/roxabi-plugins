# Compress

A Claude Code plugin that rewrites agent and skill definitions using compact math and logic notation to reduce token usage while preserving all semantics.

## What it does

Claude Code skills and agent definitions can get verbose. Compress takes any `.md` definition file and rewrites it using formal symbols and concise patterns — cutting line count by 30-60% without losing any meaning.

It applies 10 transformation rules:

1. **Definitions** — repeated concepts become Greek variables in a `Let:` block
2. **Predicates** — multi-bullet conditions become `pred(x) ⟺ A ∧ B ∧ C`
3. **Quantifiers** — "for each" becomes `∀`, "if any" becomes `∃`
4. **Implications** — "if X then Y" becomes `X → Y`
5. **Terse imperative** — multi-sentence prose becomes single line + symbols
6. **Tables + lists** — structure kept, text compressed
7. **Prune examples** — removed unless notation is ambiguous
8. **Constants** — repeated literals become named constants
9. **Process encapsulation** — workflows become `O_name { step₁; step₂ } → output`
10. **Parameterized patterns** — repeated patterns become `F(x, y)`

Things it never touches: frontmatter, code blocks, file paths, tool names, safety rules, `$ARGUMENTS`.

## Install

```bash
claude plugin marketplace add Roxabi/roxabi-plugins
claude plugin install compress
```

## Usage

- `compress review` — compresses the skill at `.claude/skills/review/SKILL.md`
- `compress fixer` — compresses the agent at `.claude/agents/fixer.md`
- `compress path/to/file.md` — compresses a file directly

The plugin shows a before/after line count and asks for approval before writing any changes.

## License

MIT

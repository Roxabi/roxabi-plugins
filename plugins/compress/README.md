# Compress

A Claude Code plugin that rewrites agent and skill definitions using compact math and logic notation to reduce token usage while preserving all semantics.

## What it does

Claude Code skills and agent definitions can get verbose. Compress takes any `.md` definition file and rewrites it using formal symbols and concise patterns — savings are measured per run as token counts, not line counts.

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

## Fidelity guardrails

Every output is governed by four guardrails (G1–G4 in `skills/compress/SKILL.md`, evidence pinned in `skills/compress/references/evidence.md`):

- **G1 Polarity** — a negative constraint (`do not use Y`) is rewritten to a concrete alternative (`use Z`) only when Z actually exists; the skill never invents one. No alternative → the constraint is kept and flagged `needs external verification`.
- **G2 No free coinage** — emitted symbols come from the canonical inline whitelist (or a local `Let:` binding). Glyphs are chosen for register and precision, never for token economy — measured savings come from prose pruning.
- **G3 Gloss trigger** — predicates, process blocks, `Let:` bindings, non-whitelist symbols, and chains of more than 3 operators all get a mandatory one-line gloss.
- **G4 Verbatim floor** — commands, tool names, spawn templates, and safety rules stay in words.

The whitelist in SKILL.md is canonical. When the optional shared glossary (`plugins/shared/references/notation.md`) is installed it extends the symbol domain; without it the skill runs fully standalone.

## Install

```bash
claude plugin marketplace add Roxabi/roxabi-plugins
claude plugin install compress
```

## Usage

- `compress code-review` — compresses the skill at `.claude/skills/code-review/SKILL.md`
- `compress fixer` — compresses the agent at `.claude/agents/fixer.md`
- `compress path/to/file.md` — compresses a file directly

The plugin shows per-section before/after token counts and asks for approval before writing any changes.

## License

MIT

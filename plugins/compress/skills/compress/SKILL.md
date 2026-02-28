---
name: compress
description: 'This skill should be used when the user asks to "compress", "compress skill", "compress agent", "shorten this", "make it formal", or wants to rewrite a definition using compact math/logic notation to save tokens.'
version: 0.1.0
argument-hint: '[file path | agent name | skill name]'
allowed-tools: Read, Write, Edit, Glob, Grep, AskUserQuestion
---

# Compress

Formal notation rewrite — reduce tokens, preserve semantics.

```
/compress review    → .claude/skills/review/SKILL.md
/compress fixer     → .claude/agents/fixer.md
/compress file.md   → direct path
```

## Symbols

`∀` all | `∃`/`∄` exists | `∈`/`∉` member | `∧`/`∨` and/or | `¬` not | `→` then | `⟺` iff | `∅` empty | `∩`/`∪` intersect/union | `⊂` subset | `∥` parallel | `|X|` count | `:=`/`←` assign | `{ }` scoped block | `;` sequence | `()` params | `↦` maps to

## Phases

**1 — Resolve:** Parse `$ARGUMENTS`: `*.md` → direct | agent name → `.claude/agents/<name>.md` | skill name → `.claude/skills/<name>/SKILL.md` | ∅ → AskUserQuestion. file ∃ → read. ∄ → halt.

**2 — Analyze:** Read target. Identify: repeated nouns (≥3×) | verbose conditionals | iteration prose | magic numbers | redundant examples | filler. L_before := line count (excl. frontmatter).

**3 — Transform (R1–R10):**
- **R1** Definitions: concept ≥ 3× → Greek var in `Let:` block (after title). Lowercase, mnemonic when possible. Template:
  ```
  Let:
    φ := set of all findings
    γ(f) ∈ [0,100] ∩ ℤ  — confidence
    τ := 80               — threshold
  ```
- **R2** Predicates: multi-bullet conditions → `pred(x) ⟺ A ∧ B ∧ C`
- **R3** Quantifiers: "for each" → `∀ x ∈ Y:` | "if any" → `∃ x:` | "exists" → `X ∃ →`
- **R4** Implications: "if X then Y" → `X → Y`
- **R5** Terse imperative: multi-sentence → single line + symbols
- **R6** Tables + lists: keep structure, compress text, ¬drop items
- **R7** Prune examples: keep only when notation ambiguous
- **R8** Constants: literal ≥ 2× → named constant
- **R9** Process encapsulation: procedure/workflow → `O_name { step₁; step₂; … } → output`
- **R10** Parameterized patterns: repeated pattern(varying inputs) → `F(x, y)`

**¬compress:** frontmatter | code blocks | `$ARGUMENTS` | file paths | tool names | safety rules | table structure

**4 — Present:** Show `L_before → L_after (N%)` + substitutions. AskUserQuestion: "Yes" / "Preview" / "Adjust". Preview → show, re-ask. Adjust → apply, re-present.

**5 — Write:** Write file. Verify: frontmatter ∧ `$ARGUMENTS` ∧ safety rules ∧ ¬semantic loss. Report L + %.

## Edge Cases

| Scenario | Behavior |
|----------|----------|
| Already formal | "already compressed", tweaks only |
| L < 30 | Warn, proceed if confirmed |
| Agent (¬skill) | Preserve agent frontmatter |
| No repeated concepts | Skip R1, apply R2–R10 |
| User rejects | Halt |
| Mixed prose + code | Prose only |

## Safety

1. ¬semantic loss — every condition, rule, edge case survives
2. ¬modify frontmatter
3. ¬delete safety rules
4. ¬auto-write — preview first
5. Preserve `$ARGUMENTS` for skills
6. ¬drop items from enumerations — compress wording only

$ARGUMENTS

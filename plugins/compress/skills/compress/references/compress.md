# Compress Mode

Mode body for `/compress` default mode — loaded by SKILL.md Phase 3. Contains the symbols legend, the transform rules, the do-not-compress list, mode-specific edge cases, and the measured rationale that governs when a substitution is worth making.

## Symbols

`∀` all | `∃`/`∄` exists | `∈`/`∉` member | `∧`/`∨` and/or | `¬` not | `→` then | `⟺` iff | `∅` empty | `∩`/`∪` intersect/union | `⊂` subset | `∥` parallel | `|X|` count | `:=`/`←` assign | `{ }` scoped block | `;` sequence | `()` params | `↦` maps to

## Analyze Targets (Phase 2)

Identify: repeated nouns (≥3×) | verbose conditionals | iteration prose | magic numbers | redundant examples | filler.

## Transform Rules (R1–R10)

- **R1** Definitions: concept ≥ 3× → Greek var in `Let:` block (after title). Lowercase, mnemonic. Template:
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

## Mode Edge Cases

| Scenario | Behavior |
|----------|----------|
| Already formal | "already compressed", tweaks only |
| No repeated concepts | Skip R1, apply R2–R10 |
| Mixed prose + code | Prose only |

## What Actually Saves Tokens (measured)

Per-glyph cost is tokenizer-dependent — glyph substitution alone is not compression:

- `∀ x ∈ Y:` and `for each x in Y:` both encode to 6 tokens — identical.
- A fully symbolic `Let:` block measured 52–53 tokens vs 49–51 for its structured-English equivalent — token-equal-or-worse despite far fewer characters.
- Greek renames (R1) cost ≈1 token per occurrence; they pay off only when the renamed concept is long and used often.
- The bulk of real token gains comes from R5/R6/R7 — prose pruning — not from glyphs. Some substitutions are net-negative.

Consequences: judge every candidate substitution by `Δtokens`, never by character or line counts (both can shrink while tokens increase). R1–R4/R8–R10 buy consistency and unambiguous structure; R5/R6/R7 buy tokens. When Phase 4 flags `Δtokens ≈ 0` for a section, prefer the more readable form.

# Evidence — Pinned Excerpts

Load-bearing evidence behind the SKILL.md guardrails (G1–G4). Each pin: source ID, the finding as measured, and the guardrail it licenses. Extend a guardrail only after re-verifying against the source.

## Tencent — arXiv 2604.07192 (controlled null result + polarity taxonomy)

- Encoding form has no detectable effect on constraint compliance — controlled null result, Cliff's δ < 0.01.
- Compliance is governed by polarity: negative constraints opposing model defaults fail 10–100% regardless of notation; 36/47 observed failures = default bias.
- Classical-Chinese counterexample: 4.6% savings vs 25–30% for tokenizer-aligned English tags — perceived density ≠ tokenizer efficiency.

Licenses: G1 (polarity transform; never invent an alternative the source does not supply) · G2 (glyph substitution is token-neutral at best).

## MetaGlyph — arXiv 2601.07354 (per-operator fidelity)

- Operator fidelity is model-dependent: `→` read as a transformation operator 0% of the time, `∈` at 26%, `∩` read as a list.
- U-curve: mid-size instruction-tuned models perform worst — glyph familiarity cannot be assumed from model capability.

Licenses: G3 (mandatory gloss on non-whitelist and fidelity-warned symbols) · G2 (whitelist over free coinage).

## LILO — ICLR 2024 (NL gloss is load-bearing)

- Named abstractions without natural-language documentation (AutoDoc) become unusable downstream — the gloss carries semantic load; it is not decoration.

Licenses: G3 (`— …` gloss ≤1 line on every Let-bind, predicate, and O-block).

## Pseudo-code ablation note

- Pseudo-code ablations corroborate LILO: symbolic or structural form without an NL gloss degrades downstream execution; exact wording is the reliable floor for anything an agent must execute or obey.

Licenses: G4 (verbatim floor — commands, tool names, spawn templates, safety rules stay in words).

## GEPA — ICLR 2026 (non-load-bearing credit)

- Rule derivation by reflection over execution traces beats RL with 35× fewer rollouts. Prior art for the future derive mode only.

Licenses: none — credited to keep the citation honest; no guardrail depends on it.

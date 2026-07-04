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

## Read-back verification

Fidelity is measured, not self-affirmed. During analysis the writer emits an itemized inventory — every rule, condition, prohibition, threshold, and edge case gets an inline `<!-- INV-<cat>-<n> -->` anchor. Sizable compressions (≥ `VERIFY_THRESHOLD` tokens, or any run with `--verify`) then spawn a fresh reader capped to the compressed artifact alone, and `scripts/inventory_diff.py` diffs the reader's re-expansion against the writer inventory: recall is judged against the pre-registered `RECALL_FLOOR` in `skills/compress/references/verify.md`, with missing/weakened/inverted/invented items blocking the write. Every verdict carries a contamination caveat (the reader shares the host's context, so the result is an upper bound for external consumers), and anchor/legend token costs are subtracted from reported savings.

A golden set of source/compressed/inventory triples under `skills/compress/references/golden/` keeps the anchor grammar honest — `tools/validate_plugins.py` enforces inventory equivalence deterministically in CI, and `re-baselining.md` documents how the expected inventories are regenerated on a model change.

## Compression levels

Four levels, a closed enum ("derived" is a mode, not a level):

- **L0 — verbatim**: safety rules, commands, tool names, spawn templates — copied word-for-word, never anchored.
- **L1 — terse prose**: pruned prose with ASCII digraphs instead of glyphs, for human-facing docs — the home of the measured ~40% savings.
- **L2 — house symbolic (default)**: the full notation catalog — contracts, verify-tables, state maps, subscripted predicates, parameterized ops, status glyphs. Per the First Golden Run consequence, every L2 output also carries a minimal per-file legend of the symbols it uses.
- **L3 — externalize split**: a ~500-token compressed core plus a linked residue doc, both carrying the provenance marker.

Files are auto-classified (safety content → L0, human-facing docs → L1, skill/agent bodies → L2, oversized always-on files → L3), with a `--level` override per file or per section. One rule holds throughout — R13: every section lands entirely at one level; a mixed-register request is refused with a choice to split the section or pick one level.

Every compressed output carries a provenance marker after its frontmatter — `<!-- compress: level=<L> src-sha=<sha> glossary=<v> -->` — so a stale source hash forces re-verification before re-compression.

## Expand mode

`compress expand <target>` reverses a compression: it parses the provenance marker, extracts the anchor inventory, and regenerates structured prose section-by-section — L0 sections pass through verbatim, anchors are stripped from the output, and nothing is written before an explicit approval. On a file without marker or anchors the reconstruction still runs, declared "best-effort, unverified".

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

# Notation — Canonical Glossary

Single source of truth for the formal notation used across this marketplace's skills and agents. It merges the three prior legends (compress `## Symbols`, dev-core `base.md` Notation, dev-core `doc-writer.md` compressed-notation line) — dispositions recorded in the merge audit below. This glossary is writer-side tooling: consumers of compressed files never need it — every emitted symbol must be self-sufficient via the whitelist or a local Let-binding with gloss.

Consumers: compress Phase 0 loads `## Core Table` only; compress Phase 3 checks Let-bindings against the Reserved-Variable Registry; the glossary mode loads Grammar + Maintenance; `tools/validate_plugins.py --check notation-legends` holds the core table set-equal to compress's `Whitelist:` line and gates the dev-core pointer lines.

All counts below: `git grep` over `plugins/`, measured 2026-07-04. Re-measure before citing — counts drift.

## Core Table

Active glyphs only — this table ≡ the compress SKILL.md `Whitelist:` line (validator-enforced). Deprecated or rejected glyphs live in Maintenance Policy, never here. Column 1 carries nothing but the glyph spans (`\|` escapes the table delimiter).

| glyph | senses | gloss? | fidelity ⚠ | notes/adjudication |
|-------|--------|--------|------------|---------------------|
| `∀` | for all / every | — | — | — |
| `∃`/`∄` | exists / does not exist | — | — | — |
| `∈`/`∉` | member of / not member of | mandatory on `∈` | MetaGlyph: membership read ~26% | — |
| `∧`/`∨` | and / or | — | — | — |
| `¬` | not / never / forbidden | — | — | compound idiom `¬do-x` = "do NOT do x" — see Grammar, ¬ registers |
| `→` | 4 positional senses — see Grammar | mandatory | MetaGlyph: transformation-operator read 0% | sense fixed by position, not by the glyph — always gloss or disambiguate |
| `⇒` | implies / contrastive consequence | — | — | Retained (2026-07-04): ×40 across 8 files; sanctioned implies/contrastive register (doc-writer legend origin); never classified as drift |
| `⟺` | if and only if | — | — | Retained over `⇔` (2026-07-04): `⟺` ×12 across 8 files vs `⇔` ×0 in plugins/ |
| `∅` | empty / null / none | — | — | — |
| `∩`/`∪` | intersection / union | mandatory on `∩` | MetaGlyph: `∩` read as a list | — |
| `⊂` | subset of / contained in | — | — | — |
| `∥` | parallel / concurrently | — | — | — |
| `\|X\|` | count / cardinality of X | — | — | escaped as `\|X\|` here only because `\|` delimits table cells |
| `:=`/`←` | define / assign | — | — | — |
| `{ }` | scoped block | — | — | — |
| `;` | step sequence inside a block | — | — | — |
| `()` | parameters / grouping | — | — | — |
| `↦` | maps to (function graph) | — | — | — |
| `≥`/`≤` | threshold comparison | — | — | Promoted from base.md legend (2026-07-04): `≥` ×107/47 files, `≤` ×47/31 — too live to demote |
| `✓`/`✗` | pass / fail | — | — | Promoted from base.md legend (2026-07-04): `✓` ×110/22 files, `✗` ×33/16 |

## Source-Legend Merge Audit

Every entry of the three source legends, with its disposition. Nothing was dropped.

| Source | Entries | Disposition |
|--------|---------|-------------|
| compress `references/compress.md` `## Symbols` | the 22 whitelist glyphs (∀ … ↦) | core-active rows, senses carried over verbatim |
| dev-core `base.md` Notation line | ¬ → ∨ ∧ ∃ ∀ | core-active (already whitelisted) |
| dev-core `base.md` Notation line | ≥/≤ threshold · ✓/✗ pass/fail | core-active rows, promoted into the whitelist (counts above) |
| dev-core `base.md` Notation line | S* next-step variable · Σ state dict | registry entries (variables, not operators — outside the equality domain) |
| dev-core `doc-writer.md` compressed-notation line | ∃ ¬ ∀ ∧ ∨ ∅ | core-active (already whitelisted) |
| dev-core `doc-writer.md` compressed-notation line | ⇒ implies | adjudicated → core-active row (cell above) |
| dev-core `doc-writer.md` compressed-notation line | → maps-to | merged into the `→` row; maps-to is one of its 4 senses (Grammar) |
| dev-core `doc-writer.md` compressed-notation line | ¬do-x idiom | merged into the `¬` core-active row + Grammar ¬ registers |
| dev-core `doc-writer.md` compressed-notation line | S* · Σ state dict | registry entries (same rows as base.md's) |

## Disambiguation Grammar

Loaded by glossary (and future lint) modes — not by compress runs.

### `→` — four positional senses

Classified from 24 fresh samples (`git grep '→' plugins/`, deterministic shuffle, 2026-07-04):

| Sense | Shape | Samples |
|-------|-------|---------|
| guard → action (conditional) | `N = 0 → halt` — left side is a condition | 12/24 |
| pipeline sequence | `parse → render → present` — chain of steps | 6/24 |
| maps-to / rewrite | `lockfile hash → node_modules cache` | 5/24 |
| produces / returns | `trigger → mandatory gloss ≤1 line` | 1/24 |

Position decides the sense: condition on the left reads conditional; a chain of ≥3 reads sequence; a data pair reads maps-to. When position leaves ambiguity, gloss (its `gloss?` flag is mandatory).

### `¬` — modal registers

- predicate negation — `¬valid`, `¬empty`: states a fact.
- imperative prohibition — `¬` before a command or action: "never do this". Strongest form is the compound `¬do-x` idiom ("do NOT do x"), inherited from the doc-writer legend.
- absence — `¬found`, `¬∃`: nothing there (prefer `∄` when quantifying).

### Separator hierarchy

Binding strength, tightest first: `/` and `,` < `·` < `|` < `;` < newline < heading. A slash joins in-cell alternatives (`∃`/`∄`); the interpunct groups short phrases; the pipe separates legend or table entries; the semicolon sequences block steps; structure above that belongs to lines and headings.

## Maintenance Policy

Loaded by glossary mode. The glossary is closed-vocabulary: extension is human-gated, never improvised mid-run.

- **Add** — measure first (`git grep` counts + file spread over `plugins/`), record an adjudication (counts, outcome, rationale, date) in the glyph's notes cell, then → present choice before the row lands. Adding a core-active operator glyph requires the same change to compress SKILL.md's `Whitelist:` line — `--check notation-legends` fails the commit otherwise.
- **Deprecate** — move the row out of `## Core Table` into the table below and drop the glyph from the whitelist in the same change; the equality gate keeps the two in lockstep. Never delete the record.
- **Version** — this file rides normal PRs; the validator (CI + lefthook) is the drift gate. Counts in adjudications are point-in-time and dated, never silently edited.

| Deprecated / rejected glyph | Record |
|-----------------------------|--------|
| `⇔` | Rejected (2026-07-04): ×0 in plugins/ vs `⟺` ×12 across 8 files — `⟺` is the house iff |

## Reserved-Variable Registry

Variables carry file-local bindings — they are NOT operators and sit outside the whitelist equality domain. Counts: `git grep` over `plugins/`, 2026-07-04. Status ∈ canonical / collision / aspirational.

| var | binding(s) | grep counts | status |
|-----|-----------|-------------|--------|
| `σ` | `.claude/stack.yml` (dominant) · spec artifact · status-icon map · staging branch | ×162 · 27 files | collision (4-way) |
| `Ω` | override file (dominant) · `/interview` skill handle | ×14 · 3 files | collision |
| `α` | agent (dominant) · analysis artifact · agent-memory file | ×153 · 20 files | collision |
| `β` | base branch (dominant) · brainstorm artifact · frontend path | ×42 · 7 files | collision |
| `ω` | worktree (dominant) · option/choice | ×36 · 4 files | collision |
| `μ` | mode (compress) · memory file · micro-task · main branch | ×46 · 10 files | collision |
| `τ` | tier (dominant) · memory topic files | ×121 · 26 files | collision |
| `φ` | frame artifact (dominant) · finding · face-reference config | ×79 · 9 files | collision |
| `Δ` | delta — changed files / Δtokens · changelog entry | ×36 · 7 files | canonical (one concept: difference) |
| `Σ` | state map/dict (dominant — the base.md + doc-writer legend sense) · severity icon · testing-standards path | ×52 · 12 files | collision |
| `π` | plan artifact · open PR · test file · proposed config table | ×46 · 7 files | collision (no dominant sense) |
| `S*` | next-step variable (dev-core base legend) | ×42 · 14 files | canonical |

**`(local)` re-binding rule:** a file may re-bind a registry variable by marking it `(local)` in its `Let:` block — e.g. `π := pattern list (local)`. compress Phase 3 flags any un-marked collision against this table; with the glossary absent (standalone install) only whitelist-glyph collisions are checkable — accepted degradation.

## Register Conventions (aspirational)

Uppercase-Latin for sets/collections and lowercase-Greek for scalars, modes, and artifact handles is a direction, not a rule: this corpus does not follow it consistently (`Σ` binds a state map, `T` binds a file set), and no gate enforces it. Scope is this repo's `plugins/` corpus only — the operator's ssot shards follow their own conventions and are out-of-corpus evidence here. Treat the register rule as aspirational until a measured migration says otherwise.

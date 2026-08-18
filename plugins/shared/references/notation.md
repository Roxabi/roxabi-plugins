# Notation — Canonical Glossary

Single source of truth for the formal notation used across this marketplace's skills and agents. It merges the three prior legends (compress `## Symbols`, dev-core `base.md` Notation, dev-core `doc-writer.md` compressed-notation line) — dispositions recorded in the merge audit below. This glossary is writer-side tooling: consumers of compressed files never need it — every emitted symbol must be self-sufficient via the whitelist or a Let-binding with gloss.

Word home (ADR-018): glyphs and English process words live here. A reserved variable has one **target** sense. File-local re-bind of a target binding is not the desired model; `(local)` is a legacy lint escape only.

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

Loaded by glossary (and lint) modes — not by compress runs.

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
- **Word-home lock (2026-08-18)** — ADR-018 cadastre. Bindings locked (`target` column); thin `## English process words` added. Core Table unchanged.

| Deprecated / rejected glyph | Record |
|-----------------------------|--------|
| `⇔` | Rejected (2026-07-04): ×0 in plugins/ vs `⟺` ×12 across 8 files — `⟺` is the house iff |

## Reserved-Variable Registry

Variables are NOT operators and sit outside the whitelist equality domain. Counts: `git grep` over `plugins/`, 2026-07-04. **target** = intended canonical sense. A **dominant** mark is the corpus / compress-Phase-3 lint heuristic — it is the target when one exists, except the unresolved rows below. Other listed senses are **residuals** (still in the corpus; not equal alternatives). Status ∈ canonical / target-locked / collision (unresolved).

| var | binding(s) | target | grep counts | status |
|-----|-----------|--------|-------------|--------|
| `σ` | `.claude/stack.yml` (dominant) · spec artifact · status-icon map · staging branch | — (unresolved) | ×162 · 27 files | collision (4-way) |
| `Ω` | override file (dominant) · `/interview` skill handle (residual) | override file | ×14 · 3 files | target-locked |
| `α` | agent (dominant) · analysis artifact (residual) · agent-memory file (residual) | agent | ×153 · 20 files | target-locked |
| `β` | base branch (dominant) · brainstorm artifact (residual) · frontend path (residual) | base branch | ×42 · 7 files | target-locked |
| `ω` | worktree (dominant) · option/choice (residual) | worktree | ×36 · 4 files | target-locked |
| `μ` | mode (compress) · memory file · micro-task · main branch | — (unresolved) | ×46 · 10 files | collision (no dominant sense) |
| `τ` | tier (dominant) · memory topic files (residual) | tier | ×121 · 26 files | target-locked |
| `φ` | frame artifact (dominant) · finding (residual) · face-reference config (residual) | frame artifact | ×79 · 9 files | target-locked |
| `Δ` | delta — changed files / Δtokens · changelog entry | delta (difference) | ×36 · 7 files | canonical (one concept: difference) |
| `Σ` | state map/dict (dominant — the base.md + doc-writer legend sense) · severity icon (residual) · testing-standards path (residual) | state map/dict | ×52 · 12 files | target-locked |
| `π` | plan artifact · open PR · test file · proposed config table | — (unresolved) | ×46 · 7 files | collision (no dominant sense) |
| `S*` | next-step variable (dev-core base legend) | next-step variable | ×42 · 14 files | canonical |

**Unresolved (follow-up, not this lock):**
- `σ` — factory English word is Spec (`## English process words`). Glyph target is unresolved because `.claude/stack.yml` (registry-dominant / lint heuristic) and spec-artifact both live. Do not treat the dominant mark as the winner.
- `π` — no dominant; stay collision.
- `μ` — no dominant; stay collision.

**`(local)` rule:** desired steady state is no re-bind of a **target** binding. `(local)` remains a **legacy escape** so compress Phase 3 does not explode — it still flags any un-marked non-dominant Let-binding as `reserved-collision` (dominant-sense uses are never findings). New skills must not introduce `(local)` for a target binding. With the glossary absent (standalone install) only whitelist-glyph collisions are checkable — accepted degradation. Legacy form: `π := pattern list (local)`.

## English process words

Word home for factory English that glyphs cannot hold ([ADR-018](../../../docs/architecture/adr/018-skill-system-homes-and-composition.md)). This section owns the English words only — it does not own `τ` / `σ` / `φ`. Authors write with these words; `/dev` may Read this file once. Skills must not recopy this section.

**Issue** — GitHub issue the factory works; identified by N.
Avoid: ticket (except quoting an external tracker).

**Factory** — `/dev` (feature path) and `/ship` (land path). Owns pipeline task lifecycle.
Avoid: "the orchestrator" as a third thing.

**Approval-stop** — skill prints an Executive Summary and stops the turn; human replies in free text.
Avoid: `/dev` treating "summary printed" as done.

**Done-signal** — on-disk fact that completes an approval-stop step (see `artifact-frontmatter.md` / chain-contract table).
Avoid: completing these steps from chat memory (`Σ_s`) alone.

**Principal** — main checkout; always stays on the base branch.
Avoid: "the repo", "cwd".

**Worktree** — isolated checkout on `feat/{N}-*` where code is written.
Avoid: calling the branch itself the worktree (the branch can exist without `ω`).

**Spec** — solution artifact for an Issue.
Avoid: treating the English word as settling the glyph `σ` (named residual collision — registry).

### Relationships

- An Issue has one Tier (glyph `τ` — target binding in the registry).
- Frame / Analysis / Spec / Plan are artifacts of one Issue.
- Approval-stop writes a Done-signal; `/dev` reads it.
- Code is written in a Worktree; Principal never switches to `feat/*`.

## Register Conventions (aspirational)

Uppercase-Latin for sets/collections and lowercase-Greek for scalars, modes, and artifact handles is a direction, not a rule: this corpus does not follow it consistently (`Σ` binds a state map, `T` binds a file set), and no gate enforces it. Scope is this repo's `plugins/` corpus only — the operator's ssot shards follow their own conventions and are out-of-corpus evidence here. Treat the register rule as aspirational until a measured migration says otherwise.

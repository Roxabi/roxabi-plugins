# Glossary Mode

Mode body for `/compress glossary` — loaded by SKILL.md Phase 3 when μ = glossary. Maintains the canonical glossary (`${CLAUDE_PLUGIN_ROOT}/../shared/references/notation.md`): add, deprecate, or version notation entries under closed-vocabulary rules. Cortex link: this mode is closed-vocabulary governance mechanics only — a human-gated add/deprecate/version loop over a fixed symbol set, nothing more.

## Preconditions

- Glossary gate: `${CLAUDE_PLUGIN_ROOT}/../shared/references/notation.md` ∄ → halt: `glossary mode requires the shared glossary — standalone installs carry only the inline whitelist, which this mode does not edit`.
- Load the lazy halves of notation.md: `## Disambiguation Grammar` + `## Maintenance Policy` + `## Reserved-Variable Registry`. (Compress mode loads `## Core Table` only — this mode is the reason the other sections exist.)

## Pipeline

| Step | Action |
|------|--------|
| 1 | Parse request → op ∈ {add, deprecate, version} + target glyph/var |
| 2 | Measure: fresh `git grep` counts + file spread over `plugins/` for the target (and any competing glyph) |
| 3 | Collision protocol (below) for new vars; adjudication draft (counts, outcome, rationale, date) for glyphs |
| 4 | → present choice **Apply** \| **Preview** \| **Abort** — extension is human-gated, never improvised mid-run |
| 5 | Apply per Maintenance Policy; core-active operator changes edit SKILL.md `Whitelist:` in the same change |
| 6 | Verify: `python3 tools/validate_plugins.py --check notation-legends` exits 0 (whitelist ≡ core table, pointers intact) |

## Op semantics

- **add** — new core-active operator glyph → new `## Core Table` row + whitelist span (lockstep, step 5); new reserved variable → registry row with measured bindings + status. Both need the step-4 gate; a rejected candidate is still recorded (Maintenance Policy table) so the adjudication isn't re-litigated from zero.
- **deprecate** — move the core row into Maintenance Policy's deprecated table + drop the whitelist span in the same change. Never delete the record.
- **version** — re-measure dated counts (registry rows, adjudication cells) and update them as a new dated entry; never silently edit an old measurement.

## Collision protocol (vs registry)

New or re-bound variable proposed → look it up in `## Reserved-Variable Registry`:

- var ∄ registry → free; bind it, offer a registry row if the binding recurs (≥3 files).
- var ∃ with the same sense → reuse the canonical binding, no new entry.
- var ∃ with a different sense → either pick an unbound var, or mark the binding `(local)` in the target file's `Let:` block. An un-marked collision is exactly what compress Phase 3 flags — don't ship one from the mode that owns the registry.

## Edge Cases

| Scenario | Behavior |
|----------|----------|
| Request names a glyph already deprecated | Show its Maintenance Policy record; re-adding requires a fresh adjudication through the full pipeline |
| Whitelist edit would push SKILL.md over its line budget | Halt and report — the budget gate (`validate_plugins.py`) wins; rework before extending |
| Counts contradict the requested outcome | Present the numbers and recommend against; the human gate decides |

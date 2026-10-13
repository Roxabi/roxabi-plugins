# Expand Mode

Mode body for `/compress expand <target>` — loaded by SKILL.md Phase 3 when μ = expand. Reconstructs structured prose from a compressed artifact: the inverse of compress mode, built on the same inventory machinery as the read-back instrument (`references/verify.md` owns the anchor grammar — this mode cites it, never duplicates it). Output fidelity is governed by SKILL.md `## Guardrails`. No new description triggers — "expand notation" ships with the skill.

## Preconditions

- Parse the provenance marker (template: `references/compress.md` § Levels): `level` labels drive step 3's register per section; `glossary=<v>` names the notation version the symbols came from; `src-sha` identifies the pre-image (informational here — expand never re-verifies).
- Extract the inventory: every `<!-- INV-<cat>-<n> -->` anchor tags the item on the next non-empty line, per `references/verify.md` § Anchor Grammar.
- No anchors → proceed, but the report and the output header declare "best-effort, unverified reconstruction" — there is no inventory to reconstruct against.

## Pipeline

| Step | Action |
|------|--------|
| 1 | Read the compressed artifact — the sole input file |
| 2 | Parse marker + extract inventory (anchor grammar: `references/verify.md`) |
| 3 | Regenerate structured prose section-by-section — LLM-guided by the inventory + level markers; L0 sections pass through VERBATIM (never re-worded); anchors STRIPPED from the output (no round-trip double-tagging) |
| 4 | Re-count: `python3 S count` on the draft → per-section `tokens_compressed \| tokens_expanded` table |
| 5 | → present choice **Write** \| **Preview** \| **Adjust** before any write. Preview → show full text, re-ask; Adjust → apply feedback, re-present |

Every inventory item must be represented in the regenerated prose — the expansion is complete, or it declares exactly what it could not place.

## Edge Cases

| Scenario | Behavior |
|----------|----------|
| No marker | Treat the whole file as unlabeled compressed content; expansion still runs, declared "best-effort, unverified reconstruction" |
| Marker present, no anchors | Same declaration — level labels guide the register, but nothing pins the items |
| L3 core + residue | Expand the core, then follow its `→ path — gloss` link and expand the residue doc (its marker carries `part=residue`); declare that the expansion spans both files |

## Relation to Verify

Same machinery, inverse direction: Phase 5a (verify) turns compressed content back into an inventory to diff against the writer's; expand turns the inventory back into prose for humans. Expand adds no anchors of its own — a later re-compression of expanded output mints fresh anchors at Phase 2.

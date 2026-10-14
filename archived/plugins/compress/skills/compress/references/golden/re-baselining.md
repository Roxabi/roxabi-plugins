# Golden Set Re-Baselining

The expected inventories in this directory are model-sensitive: a different model (or a changed notation/glossary) may compress the same source into differently worded items. When that happens the goldens are re-baselined, never patched ad hoc.

## Trigger

- Model change (the model that authored the compressed artifacts is replaced), OR
- Intentional notation/glossary change (a new `notation.md` version alters the emitted forms).

Never re-baseline to make a failing CI check pass on unrelated work — a red `Golden inventories` check on an untouched golden set means the triple drifted and must be investigated first.

## Procedure

1. Regenerate the compressed artifacts + expected inventories from the `*.source.md` files with the current model (`/compress` on each source, anchors per `references/verify.md` grammar).
2. Keep the triple naming (`NN-name.source.md` / `NN-name.compressed.md` / `NN-name.inventory.json`) and markers (`src-sha` = `git hash-object` of the source).
3. Run `python3 tools/validate_plugins.py` — the `Golden inventories` check must pass.
4. Record the run in the log table below: model, date, reason.
5. Land as ONE dedicated commit touching only `references/golden/`.

## Log

| Model | Date | Reason |
|-------|------|--------|
| claude-fable-5 | 2026-07-04 | Initial golden set (issue #311, slice V1) |

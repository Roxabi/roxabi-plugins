# Fixture — Drift Classes

Planted proof corpus for `references/lint.md` Step 1: one section per drift class, each holding at least one positive (firing) instance and one adjacent negative (silent) case. All content is fictional. Every plant sits outside excluded regions on purpose — exclusion proofs live in `exclusions.md`.

## arrow-doubling

The handoff chain reads: intake → → review (positive — doubled arrow).
The approved chain reads: intake → review → publish (negative — single arrows only).

## or-drift

Retry policy: attempt ∈ {first || second} before the queue drains (positive — `||` sharing a line with notation glyphs).
The build wrapper chains make check || make fix on failure (negative — no notation glyph on this line).

## assign-drift

Let:
  window := 14 — review window in days (negative — canon `:=`)
  retries = 3
  cache ← warm

The two drifted bindings above (`retries`, `cache`) are the positives. Outside any Let block, prose like "page size = 20" stays silent (negative — the pattern binds to Let blocks only).

## reserved-collision

Let:
  τ := teapot catalog — the shop's product list
  ω := worktree — dominant sense, canonical reuse
  π := pattern list (local) — file-local re-bind, marked
  κ := confidence score — not a registry variable, free to bind

Positive: `τ` re-bound to a non-dominant sense with no `(local)` marker. Negatives: `ω` keeps its dominant sense, `π` carries the `(local)` marker, `κ` is unregistered.

## unknown-symbol

Let:
  ♢ := draft state — file-local symbol, declared here

The pipeline emits ⊕ between stages (positive — ⊕ is neither core-table nor Let-defined).
Every ♢ below rides the Let-binding above, and whitelisted glyphs like ∀ or → never fire (negatives).

## missing-gloss

The intake predicate below lacks its gloss (positive):

ready(x) ⟺ parsed(x) ∧ linted(x) ∧ staged(x)

The release predicate carries one (negative):

done(x) ⟺ merged(x) ∧ tagged(x) — the release predicate, glossed

## stale-marker

<!-- compress: level=L2 src-sha=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa glossary=v1 -->

Positive: the marker above pins a constant `src-sha` that can never equal `git hash-object` of this fixture.

<!-- note: an ordinary comment, not a provenance marker (negative) -->

## negative-polarity

The export pipeline ships the batch exporter for scheduled jobs.
¬use the legacy exporter.

Positive with alternative: the batch exporter is named in the surrounding text, so the proposal may read "use the batch exporter".

Never call the archive endpoint directly.

Positive without alternative: no substitute endpoint appears anywhere near — expect the `needs external verification` flag, no proposal.

¬edit the rendered output — edit the template source instead.

Negative: the positive alternative already sits adjacent on the same line.

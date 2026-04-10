# Brand Book Loader

Runtime instructions for forge skills that need to detect, parse, validate, and apply a `forge.yml`.
Skills cite this document rather than duplicating loader logic in each `SKILL.md`.

## Purpose

This document is a runtime reference for Claude executing a forge skill. It defines the canonical
procedure for consuming a `forge.yml` brand book: how to find one, how to parse each field, how to
apply each field to the Design Phase, and how to report load status to the user.

The problem it solves: every forge skill needs brand book handling (Track A vs. Track B detection,
palette injection, component pre-fill, Deliver constraint checking), but duplicating that logic in
each `SKILL.md` creates drift. Instead, each `SKILL.md` says "run Brand Book Loader" at invocation
start, and all skills behave consistently.

Who reads this: Claude, at the start of a forge skill invocation, before running Frame. Skills that
read this document should not re-implement any of the steps here — they should execute them.

Who does not read this: end users. They receive a one-line report (see Reporting section). The
internals are a skill concern.

---

## Discovery

Run this check at the start of every forge skill invocation, immediately after project detection
(see `forge-ops.md § Project Detection`). Do not defer it — brand book presence determines whether
Frame runs in full or reduced form.

Check order (first match wins — do not continue after a match):

```text
1. If --brand-book PATH was passed as an explicit arg:
     → Load from PATH. If file does not exist, report error and fall through to step 2.

2. Check ~/projects/{PROJECT}/brand/forge.yml
     → If exists, load as Track A (full schema).

3. Check ~/.roxabi/forge/{PROJECT}/brand/forge.yml
     → If exists, load as Track A (full schema). This is the runtime mirror.

4. Check ~/projects/{PROJECT}/brand/BRAND-BOOK.md
     → If exists, load as palette-only mode (partial Track A).

5. Check ~/.roxabi/forge/{PROJECT}/brand/BRAND-BOOK.md
     → If exists, load as palette-only mode (partial Track A). Runtime mirror.

6. If none found → Track B (exploration mode, no brand book).
```

Resolution rules:

- First match wins. Once a file is found and opens without error, stop checking lower-priority paths.
- `forge.yml` found → **Track A, full schema mode**. Aesthetic, palette, typography, components,
  structure defaults, examples, and deliver constraints all apply per their field policies.
- Only legacy `BRAND-BOOK.md` found → **palette-only mode**. Parse the color table in that file
  and emit palette tokens. All other decisions (components, structure, deliver constraints) fall
  through to plugin defaults. This is partial Track A — aesthetic detection still runs priority 3
  in the Aesthetic Detection precedence chain.
- Neither found → **Track B, exploration mode**. Frame runs in full. No brand book fields apply.

After resolution, state the outcome explicitly before proceeding:

```text
Good: "Brand book loaded: ~/projects/lyra/brand/forge.yml (Track A, full schema)"
Good: "Brand book loaded: ~/.roxabi/forge/lyra/brand/BRAND-BOOK.md (palette-only mode)"
Good: "No brand book found — Track B exploration mode"
Bad:  (silently applying or skipping brand book with no report)
```

---

## Parse

Read each field from the `forge.yml` and store it in memory for use across all Design Phase steps.
Missing fields are not errors — treat them as "not specified" and fall through to plugin defaults.
Never fail on a missing field.

### Field extraction

**`schema_version`**
Read as integer. Expected value: `1`. If value is not `1`, warn: `"forge.yml schema_version is
{value}, expected 1 — proceeding but some fields may be misread"`. Do not abort.

**`aesthetic`**
Store the value. If value is `@inherit-palette`, skip loading a CSS file from
`${CLAUDE_PLUGIN_ROOT}/references/aesthetics/` entirely — the aesthetic is derived solely from
the `palette` tokens below. Otherwise, record the CSS filename for injection in Phase 1 Context.

**`palette.dark` and `palette.light`**
Store all entries as CSS custom properties. When emitting into HTML, output:
- `:root, [data-theme="dark"]` block for `palette.dark` entries
- `[data-theme="light"]` block for `palette.light` entries

Each entry becomes `--{token-name}: {value};`. Omitted entries keep the aesthetic file's defaults.

**`typography`**
Store each font name. When emitting into HTML, generate a Google Fonts `<link>` tag for each
specified font and emit corresponding `font-family` CSS rules. Omit any entry not present in the
brand book — aesthetic file's font defaults remain.

**`components`**
Store the full object as the Style phase pre-fill map. Each key corresponds to a Style slot
(hero, section_label, card_default, timeline, badges, mermaid_theme_bias). Pre-fill those slots
before running Style judgment.

**`structure_defaults`**
Store as the Structure phase tiebreaker set. Keys: `prefer_fgraph_under`, `prefer_mermaid_over`,
`comparison_as_table`. Used only when content topology is ambiguous between two equally valid
choices.

**`examples`**
Store as a list of file paths for the Deliver phase. These paths may or may not exist — validate
existence at Deliver time, not at parse time.

**`deliver_must_match`**
Store as a list of constraint strings for the Deliver phase. Each is a human-readable rule the
generated output must satisfy.

**`allow_override`**
Store as a per-key policy map. Valid values per key: `locked`, `partial`, `open`, `advisory`.
Unknown values → treat as `partial` (safe default) and warn.

**`project`**
Store as informational metadata. May be referenced when generating `diagram-meta` entries. Does
not affect any Design Phase decision.

### Validation rules

| Check | Action on failure |
|---|---|
| `schema_version` != `1` | Warn with version found; continue |
| Unknown top-level key | Warn `"unrecognized key '{key}' in forge.yml — ignored"`; continue (forward-compat) |
| `aesthetic:` value not in known CSS list and not `@inherit-palette` | Warn `"aesthetic '{value}' not found in references/aesthetics/ — falling back to project-name inference"`; fall through to priority 4 |
| `components.*` value not in the allowed enum for that field | Warn `"components.{field} value '{value}' not valid — using plugin default"`; apply plugin default for that slot only |
| `allow_override.*` value not in `{locked, partial, open, advisory}` | Warn `"allow_override.{key} has unknown value '{value}' — treating as partial"`; continue |
| YAML parse error | Report error with line number if available; fall back to Track B (exploration mode); do not crash |

---

## Apply

After parsing, the loaded brand book feeds into each Design Phase step. This table is the canonical
reference for how each field is consumed. Skills that read only a subset of these fields must still
execute the full Apply logic for their relevant phases.

| Phase | Brand book fields consulted | How they apply |
|---|---|---|
| Phase 1 — Context | `aesthetic`, `palette`, `typography` | Inject aesthetic CSS file from `references/aesthetics/{value}` into the HTML shell. Then overlay `palette` tokens as CSS custom properties in `:root` and theme blocks, overriding matching tokens in the aesthetic file. Emit `typography` as Google Fonts links + font-family rules, overriding aesthetic defaults. |
| Frame (Phase 1) | `deliver_must_match` (voice / vocabulary rules that pre-constrain tone) | If brand book is present (Track A): skip Frame Q3 (tone). Tone axes are pre-constrained by the brand book's voice rules embedded in `deliver_must_match` (banned vocab, voice register, passive-voice rules). Still ask Q1 (reader-action) and Q2 (takeaway) — these are content-driven, not brand-driven. In Track B: run all four Frame questions in full. Note: the schema has no dedicated `tone` override key — voice constraints live in `deliver_must_match` by convention. |
| Phase 2 — Structure | `structure_defaults`, `allow_override.structure` | Apply `structure_defaults` as tiebreakers only when content topology is genuinely ambiguous between two equally valid choices. If `allow_override.structure: open`, content topology always wins regardless of tiebreakers. If `locked`, the brand default always wins even when content suggests a different topology. |
| Phase 3 — Style | `components`, `allow_override.components` | Pre-fill each Style slot (hero, section_label, card_default, timeline, badges, mermaid_theme_bias) from `components`. If `allow_override.components: partial`, content may substitute a specific slot only when there is no valid option using the brand default (see override rule below). If `locked`, brand component values are immutable. |
| Phase 4 — Deliver | `examples`, `deliver_must_match` | Before writing the output file: (1) run each `deliver_must_match` rule against the generated output and report pass/fail per rule; (2) if `examples` list is non-empty and at least one example path resolves, offer to diff the generated output against one example for visual consistency spot-check. |

### Rule for `components: partial` override

A Style slot override is valid only when the content's Structure output has no valid option that
uses the brand default. The bar is constraint, not preference.

Valid override: brand locks `hero: elevated`, but the output is a single standalone diagram with
no hero section at all. Hero is simply absent — there is no conflict, the brand default is not
violated because it was never invoked.

Invalid override: brand locks `hero: elevated`, content is a multi-section guide that would
"feel warmer" with `hero: left-border`. Warmth is a judgment call, not a constraint. Use the
brand default. Report to the user why the brand default was kept if the user seems to expect
something different.

When in doubt, use the brand default and surface the tension to the user rather than silently
overriding.

---

## Reporting

Report brand book load status immediately after discovery, before asking any Frame questions or
producing any output.

### On invocation

```text
Brand book: Lyra (forge.yml, 117 lines)
Track: A (branded)
Locked fields: aesthetic, palette, typography
Partial fields: components
Open fields: structure
Examples: 5 canonical references for Deliver spot-check
Deliver rules: 11 must-match constraints
```

Omit any line whose count is zero (e.g., omit "Examples: 0 canonical references" — say nothing).

For Track B, the report is a single line:

```text
No brand book found — Track B exploration mode
```

For palette-only mode:

```text
Brand book: Lyra (BRAND-BOOK.md, palette-only)
Track: A (partial — palette only, all other decisions use plugin defaults)
```

### On Deliver phase

After running `deliver_must_match` checks, always report the full result even if all pass:

```text
Deliver constraint check: 11 rules applied, 10 passed, 1 failed
FAILED: 'body copy color is var(--text), not var(--text-muted)'
Location: line 142 in tab-current.html
Fix suggestion: change class on <p> element to use --text token
```

If all pass:

```text
Deliver constraint check: 11 rules applied, 11 passed
```

The goal is to make the brand book's effect **visible**. Do not silently apply constraints and
hope the output is correct. Surface what was checked, what passed, and what failed — with enough
detail that the user can act on a failure without reading the brand book themselves.

---

## Failure Modes and Recovery

| Error | Response |
|---|---|
| `forge.yml` has invalid YAML | Report parse error with line number if available. Fall back to Track B (exploration mode). Do not crash or halt — continue with Frame running in full. |
| `aesthetic:` names a CSS file that does not exist in `references/aesthetics/` | Report: `"aesthetic '{value}' not found — falling back to project-name inference"`. Continue with priority 4 in the Aesthetic Detection chain. |
| `examples:` list contains paths that do not exist | Report each missing path at Deliver time: `"example not found: {path} — skipping"`. Continue with remaining valid examples. If all examples are missing, skip spot-check offer silently. |
| `deliver_must_match` rule is ambiguous (cannot be mechanically verified against the output) | Report: `"Rule '{rule}' cannot be mechanically verified — human review required"`. Do not fail the Deliver phase; surface it as a manual item. |
| `allow_override` key has an unknown value | Treat as `partial`. Warn: `"allow_override.{key}: unknown value '{value}' — treating as partial"`. Continue. |
| Explicit `--brand-book PATH` resolves to a file that does not exist | Report: `"--brand-book {PATH} not found"`. Fall through to step 2 of the Discovery order and continue. |
| Content Structure output has no matching Style row AND brand book does not lock that slot | Do not silently pick. Ask the user which Style row to use. Offer the closest match as a suggestion. |

Recovery principle: brand book failures are recoverable. The goal is always to produce output —
even if degraded (Track B instead of Track A). Never halt a forge skill invocation because the
brand book has a problem. Report, fall back, continue.

---

## See Also

- `forge-ops.md` — Aesthetic Detection precedence chain; Brand Book Detection paths; Project Detection
- `brand-book-schema.md` — full `forge.yml` field reference, component enums, `allow_override` values
- `frame-phase.md` — Frame behavior in Track A (reduced) vs. Track B (full); tone dimension table
- `examples/forge.yml.example` — concrete example filled in for the Lyra project

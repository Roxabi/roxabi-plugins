# Design Phase — Two-Track Reference

This document is the single source of truth for how the four Design Phase sub-phases — Frame,
Structure, Style, and Deliver — behave differently depending on whether a project has a brand book.
Skills (`forge-chart`, `forge-guide`, `forge-gallery`, `forge-epic`) reference this spec from their
own Design Phase sections rather than duplicating the branching logic.

## Purpose

The forge Design Phase serves two user personas with opposite needs:

| Persona | Needs |
|---|---|
| **New user** — no established design | Full judgment in every sub-phase; plugin teaches what good looks like for this content |
| **Mature project** — brand locked (lyra, roxabi) | Plugin applies the brand; stops re-proposing aesthetics, tone, or component variants the project has already decided |

The brand book (`forge.yml`) is the mechanism a project uses to declare its design. When it is
present, the plugin enters **Track A (branded mode)**. When it is absent, the plugin enters
**Track B (exploration mode)**.

Brand book detection (`references/brand-book-schema.md` § Discovery order) runs once at the start
of Phase 1. The outcome determines which track the entire skill invocation follows. Skills load this
spec to understand what is locked, what is pre-filled, and what still requires judgment in each
track.

---

## Track Selection

Track assignment happens at Phase 1 start and does not change for the duration of the invocation.

```
At Phase 1 start:
  brand_book = run brand-book-loader discovery
    # check --brand-book arg (explicit override)
    # check ~/.roxabi/forge/{PROJ}/brand/forge.yml
    # check ~/.roxabi/forge/{PROJ}/brand/BRAND-BOOK.md (legacy palette-only)

  if brand_book found:
    track = A  (branded)
    log: "Track A: {path} — applying locked fields: {list}"

  else:
    track = B  (exploration)
    log: "Track B: no brand book — full Design Phase judgment"
```

**Track is fixed at Phase 1 and does not change.** Skills do not silently switch tracks
mid-generation. If the brand book is found, Track A applies to Frame, Structure, Style, and Deliver
without exception. If it is not found, Track B applies to all four sub-phases.

The logged field list reflects the `allow_override` settings in the brand book — fields marked
`locked` or `partial` are named explicitly so the author can see what is pre-constrained before
judgment phases begin.

---

## Frame in Track A vs Track B

Frame answers: who reads this, what do they do next, what tone does the content deserve? In Track A,
the brand book pre-answers the tone question. In Track B, all axes are open.

| Sub-step | Track A (branded) | Track B (exploration) |
|---|---|---|
| Q1 — Reader + action | ASK — content-driven, not brand-driven | ASK |
| Q2 — Takeaway | ASK — content-driven, not brand-driven | ASK |
| Q3 — Tone (4 axes) | PRE-FILLED from brand book voice rules; only ask for axes the brand leaves open | ASK all 4 tone axes |
| Q4 — Sentence verb (optional) | OPTIONAL — useful if Q1 is ambiguous between two reader types | OPTIONAL |
| Output: purpose statement | Produced — Q1 + Q2 drive it | Produced — Q1 + Q2 + Q3 drive it |
| Output: aesthetic signal | Not produced — brand book locks aesthetic at priority 2 | Produced — flows to Aesthetic Detection priority 5 as content-type fallback |

**Rationale — Track A tone pre-fill:** In branded mode, tone is pre-constrained by the brand. For
example, Lyra's brand book encodes "warm + technical" as a voice rule and prohibits AI marketing
cliches. Asking the author to re-derive tone from scratch would contradict the brand book and
introduce drift. The brand's tone answers Q3 directly; skills read it from `deliver_must_match` or
an equivalent voice field and skip the Q3 elicitation.

**Rationale — Track B aesthetic signal:** In exploration mode, no higher-priority signal exists (no
`forge.yml`, no project-name match). Frame's Q1 + Q3 output produces a content-type signal that
Aesthetic Detection priority 5 maps to a fallback aesthetic CSS file. This is the only path where
Frame indirectly influences aesthetic selection, and only as the lowest-priority fallback.

In both tracks, Q1 and Q2 are always asked because they are content-driven, not brand-driven. A
brand book describes how a project looks and sounds, not what this specific visual is about or who
its reader is.

---

## Structure in Track A vs Track B

Structure chooses a topology (Mermaid flowchart, fgraph, HTML table, steps timeline, etc.). The
choice is always content-driven — the structure of the data determines the structure of the visual.
Brand can only adjust tiebreakers.

| Sub-step | Track A (branded) | Track B (exploration) |
|---|---|---|
| Topology decision | Content-driven; `structure_defaults` act as tiebreakers when content is ambiguous | Content-driven; plugin defaults act as tiebreakers |
| `structure_defaults.prefer_fgraph_under` | Applied — hub-and-spoke with N or fewer peers → fgraph over Mermaid | Plugin default (6) |
| `structure_defaults.prefer_mermaid_over` | Applied — more than N nodes → Mermaid regardless | Plugin default (8) |
| `structure_defaults.comparison_as_table` | Applied if `true` — matrix content uses HTML table, not Grid cards | Plugin default (`true`) |
| `allow_override.structure: open` (typical) | Content topology always wins; brand default is advisory | n/a |
| `allow_override.structure: locked` (rare) | Brand default wins even if content analysis points elsewhere | n/a |

**Rationale:** Structure is intrinsically content-driven. A dependency graph is a directed acyclic
graph regardless of brand. A four-node hub-and-spoke is a radial topology regardless of brand. The
brand book can only break ties — cases where two valid topologies exist and the content does not
strongly favor either. The `allow_override.structure: locked` setting is rare and reserved for
projects with a strict layout mandate (e.g., always use Mermaid for consistency in a documentation
system). Most projects leave structure `open`.

---

## Style in Track A vs Track B

Style selects component variants (hero, section labels, cards, timeline, badges) from the outputs
of Frame (tone) and Structure (topology). In Track A, most slots are pre-filled from the brand
book's `components` field.

| Sub-step | Track A (branded) | Track B (exploration) |
|---|---|---|
| Hero variant | Pre-filled from `brand.components.hero` | Frame tone output drives variant selection |
| Section label | Pre-filled from `brand.components.section_label` | Frame tone output drives |
| Card default | Pre-filled from `brand.components.card_default` | Picked per document type |
| Timeline component | Pre-filled from `brand.components.timeline` | Picked per content |
| Badges style | Pre-filled from `brand.components.badges` | Picked per context |
| Override permitted? | Only if `allow_override.components: partial` AND content has no valid rendering using the brand default | Always |

**Detailed `partial` override rule:** Content may override a Style slot in Track A only when one of
the following conditions holds:

- (a) The Structure output has no valid rendering using the brand's component default — for example,
  a single-diagram chart with no sections to divide has no valid use of `section_label`, so that
  slot is meaningless for this content and the brand default does not apply.
- (b) The brand slot is inherently inapplicable to this content type — for example, `timeline` is
  irrelevant for a pure comparison matrix; the brand's timeline preference does not constrain that
  output.

Content may NOT override a Style slot for stylistic preference. "The left-border hero looks better
here" is not a valid override reason in Track A. "This content has no hero at all" is.

---

## Deliver in Track A vs Track B

Deliver verifies the generated output before writing. In Track A, the brand book's
`deliver_must_match` rules run as additional verification on top of the skill's built-in checklist.

| Sub-step | Track A (branded) | Track B (exploration) |
|---|---|---|
| Skill's built-in Deliver checklist | Runs — a11y, semantic tokens, diagram-shell wrappers, responsive layout | Runs |
| `brand.deliver_must_match` rules | Runs — each rule applied against generated output; failures reported before writing | Not applicable |
| `brand.examples` spot-check | Offered — optional visual diff against one or more canonical examples from the brand book | Not applicable |
| Frame Q2 takeaway verification | Runs — output must visually emphasize the stated takeaway | Runs |
| Failure handling | Report each failed rule with location and suggested fix; do not write the file until the user confirms override or fix is applied | Same, but only built-in checks |

**How `deliver_must_match` rules are applied:** Rules are human-readable constraint strings (e.g.
`"hero uses .hero.left-border variant"`, `"no emoji in section headers"`). Skills interpret each
string against the generated output and report a pass/fail with the location of any violation. The
file is not written until all rules pass or the user explicitly overrides a failing rule.

**Spot-check offer:** If the brand book lists `examples`, the Deliver phase offers to compare the
generated output against one or more canonical files. This is advisory — the author may decline.
The spot-check helps catch visual drift that rule strings cannot express.

---

## Full Trace Example

**Brief:** *"Draw the NATS topology for lyra #477 — help a new contributor understand which
processes talk to which."*

### Track A trace — `forge.yml` found at `~/.roxabi/forge/lyra/brand/forge.yml`

**Phase 1 — Track selection:**
Brand book loaded. Locked fields: aesthetic (`lyra.css`), palette (Forge Orange dark/light),
typography (Chakra Petch / Outfit / Inter / JetBrains Mono), `components.hero` (`left-border`),
`components.section_label` (`dot`). Voice rules: warm + technical; prohibit AI marketing cliches.
Track A fires.

**Frame:**
- Q1 — "New contributor, onboarding" — asked; content-driven
- Q2 — "Three processes communicate only via NATS topics — no direct imports between them" — asked; content-driven
- Q3 — SKIPPED — tone pre-filled from brand book voice rules: warm + technical
- Q4 — OPTIONAL — skipped; Q1 is unambiguous

**Structure:**
Four nodes, hub-and-spoke topology. `prefer_fgraph_under: 6` → fgraph. Content wins; brand
tiebreaker not needed because the content clearly maps to radial fgraph.

**Style:**
`.hero.left-border` (brand default), `.section-label.dot` (brand default), `.card.accent`
(brand default). No overrides — all slots have valid brand renderings for this content.

**Deliver:**
Brand rules run: "accent color is Forge Orange" — pass; "hero uses `.hero.left-border`" — pass;
"section labels use `.section-label.dot`" — pass; "no emoji in section headers" — pass. Q2
takeaway verified: caption explicitly states "no direct imports." Five canonical examples offered
for spot-check; author may accept or decline.

---

### Track B trace — no `forge.yml`, hypothetical new project

**Phase 1 — Track selection:**
No brand book found. No project-name match. Track B fires.

**Frame:**
- Q1 — "New contributor, onboarding" — asked
- Q2 — "Three processes communicate only via NATS topics — no direct imports between them" — asked
- Q3 — FULL — all 4 axes asked: warm + technical + spacious + reflective
- Q4 — OPTIONAL — skipped

Aesthetic signal produced from Q1 + Q3 → warm + agent-adjacent content → Aesthetic Detection
priority 5 → `lyra.css`.

**Structure:**
Four nodes, hub-and-spoke. Plugin default `prefer_fgraph_under: 6` → fgraph. Same result.

**Style:**
Frame tone (warm + reflective) drives: `.hero.left-border` (warm, not elevated/formal),
`.section-label.dot` (narrative, not square/technical), `.card.accent` (semantic color for message
routing). Same component selections as Track A — but derived from tone judgment, not brand lock.

**Deliver:**
Built-in checklist only: a11y, semantic tokens, diagram-shell wrappers. No brand rules. Q2
takeaway verified: caption must state "no direct imports."

---

**The outputs are identical for this brief.** Content-driven answers converged on the same topology
and components regardless of track. The real difference surfaces when content and brand diverge:
Track A would reject an off-brand component choice (e.g., an elevated hero in a lyra output) and
block the file write until corrected. Track B would accept it, because no brand constraint exists
to enforce.

---

## Decision Boundary Summary

| Decision | Track A — branded | Track B — exploration |
|---|---|---|
| Aesthetic | Locked by brand book (`allow_override.aesthetic: locked`) | Content-type fallback (Aesthetic Detection priority 5) |
| Palette | Locked by brand book (`allow_override.palette: locked`) | Aesthetic CSS file defaults |
| Typography | Locked by brand book (`allow_override.typography: locked`) | Aesthetic CSS file defaults |
| Tone | Brand voice rules pre-fill Q3; brand wins | Frame Q3 judgment — all 4 axes asked |
| Topology | Content-driven; brand `structure_defaults` as tiebreakers | Content-driven; plugin defaults as tiebreakers |
| Component slots | Brand defaults; partial override only when slot is inapplicable | Frame tone drives variant selection |
| Deliver verification | Brand `must_match` rules + built-in checklist | Built-in checklist only |
| Examples spot-check | Offered from `brand.examples` list | Not applicable |

---

## See Also

- `brand-book-schema.md` — full `forge.yml` schema, field reference, `allow_override` values, per-skill consumption table
- `brand-book-loader.md` — discovery paths, parse and apply pseudocode, logged output format
- `frame-phase.md` — Frame reference: three Frame questions, reader-action matrix, tone dimensions, how Frame output flows downstream
- `forge-ops.md` — Aesthetic Detection precedence chain (mechanical; runs during Phase 1 in both tracks); content-type fallback matrix

# Frame Phase

Frame is the first sub-phase of the forge Design Phase. It is a judgment step, not a lookup.

Frame answers: *What is this visual for, who reads it, and what do they do next?* The output is a
purpose statement — one reader, one takeaway, one tone profile — that flows into every downstream
phase. Structure uses it to pick a topology. Style uses it to pick component variants. Deliver uses
it to define the verification criterion.

Frame does not select aesthetics. Aesthetic selection is mechanical and handled by the Aesthetic
Detection priority chain (explicit arg → brand book → project name → content fallback → default).
See `forge-ops.md § Aesthetic Detection`. Frame selects PURPOSE, which then informs Structure,
Style, and Deliver.

Skipping Frame produces generic output: a layout that technically renders the data but does not
serve the reader's actual task. A debugging reference and an executive overview can contain
identical data. Frame is what makes them look and feel different.

---

## The Three Frame Questions

Answer all three before entering Structure. The fourth prompt is optional but often clarifies
ambiguity.

**Q1 — Who reads this and what do they do next?**
The reader's role and next action determine topology (dense stat-grid vs. spacious steps vs.
comparison grid). "A stakeholder who will decide budget" and "a contributor who will run a command"
both read technical content — they need completely different layouts.

**Q2 — What is the ONE takeaway the reader should remember?**
Forces commitment to a single claim. If you cannot state it in one sentence, the content scope is
too wide — split the visual or narrow the scope before continuing. The takeaway becomes the Deliver
verification criterion: the finished visual must visually emphasize it.

**Q3 — What tone does the content deserve?**
Four axes, each independent (see Tone Dimensions below). Tone drives component variant selection in
Style: a formal+urgent tone selects elevated hero + verdict badges; a warm+reflective tone selects
left-border hero + narrative labels.

**Q4 (optional) — If this visual were a sentence, what verb does it end with?**
Forces the author to commit to an action the reader takes after seeing the visual: *decide*,
*learn*, *debug*, *celebrate*, *trust*, *configure*. A visual that ends in *understand* tolerates
spacious narrative layout. A visual that ends in *debug* demands dense, scannable, high-contrast
layout. Use this when Q1 is ambiguous between two reader types.

---

## Reader-Action Matrix

The reader's likely next action is the single strongest signal for topology, component, and tone
bias. Use the row that best matches Q1's answer.

| Reader action | Topology bias | Component bias | Tone bias | Example aesthetic fit |
|---|---|---|---|---|
| Debugging a production issue | Stat-grid, dense, multi-column | High-contrast cards, severity badges, monospace values | Technical, formal, urgent | `blueprint.css` |
| Onboarding / learning a new system | Steps timeline, left-to-right flow | Narrative hero, section labels with dots, spacious cards | Warm, casual, reflective | `lyra.css` or `editorial.css` |
| Presenting to stakeholders / execs | Polished hero with summary stat, single focal point | Verdict badges, elevated hero, formal typography | Formal, confident, spacious | `roxabi.css` |
| Quick reference while coding | Minimal chrome, flat table or stat-grid | Monospace values, tight grid, no decorative elements | Technical, casual, dense | `terminal.css` |
| Browsing / comparing options / deciding | Comparison grid, flat card hierarchy | Side-by-side spec cards, filter labels, scannable rows | Neutral, reflective, spacious | `editorial.css` |
| Auditing / reviewing | Finding cards grouped by severity, top-to-bottom scan | Severity badges, finding cards, collapsible sections | Formal, technical, urgent | `blueprint.css` |
| Celebrating / announcing (release, milestone) | Hero with accent color, single dominant message | Warm accent bar, milestone pill, generous whitespace | Warm, casual, spacious | `lyra.css` or `roxabi.css` |

When the reader action falls between two rows (e.g., a contributor onboarding to a CLI tool), bias
toward the row whose topology best tolerates the content volume. A 12-item comparison does not fit
in a steps timeline regardless of reader warmth.

---

## Tone Dimensions

Tone is four independent axes. Pick a point on each independently — they are not correlated.

| Axis | Left pole | Right pole | Notes |
|---|---|---|---|
| Technical ↔ Warm | Monospace values, precise units, low decoration | Conversational labels, rounded components, accent color | Affects component variant and label copy |
| Formal ↔ Casual | Verdict badges, elevated hero, structured sections | Left-border hero, dot labels, narrative flow | Affects hero variant and section dividers |
| Urgent ↔ Reflective | Dense layout, high contrast, minimal whitespace | Spacious margins, muted borders, slow reveal | Affects card spacing and contrast levels |
| Dense ↔ Spacious | Multi-column grid, tight line-height, small type | Single-column, generous padding, large type | Affects grid columns and overall rhythm |

A warm+technical combination is valid: a friendly API reference is warm in copy and formal in data
presentation. A formal+reflective combination is valid: a polished executive summary is formal in
structure but spacious and unhurried in rhythm. Do not conflate warmth with lack of precision or
formality with urgency.

---

## How Frame Output Flows to Downstream Phases

| Downstream phase | What Frame gives it | Example |
|---|---|---|
| Structure | Topology bias from reader-action matrix | Reader is debugging → Structure leans toward stat-grid hero over radial fgraph; reader is onboarding → Structure leans toward steps timeline or hub-and-spoke with narrative labels |
| Style | Component variant from tone axes | Tone is formal+urgent → Style picks elevated hero + verdict badges, not left-border hero + dot labels; tone is warm+reflective → Style picks `.hero.left-border` + `.section-label.dot` |
| Deliver | Verification criterion derived from the Q2 takeaway | Takeaway is "lyra runs 24/7 on your hardware" → Deliver checks that hero copy mentions hardware and always-on, and that any stat-grid numbers support the claim rather than contradict it |

Frame output is additive: Structure, Style, and Deliver each extract the slice they need. A change
to the Q2 takeaway does not force a topology change; a change to Q1 reader-action does. Keep the
three outputs explicit in the trace so downstream phases can re-derive independently if one
constraint changes.

---

## Frame in Two-Track Mode

Frame behavior differs based on whether a brand book is present.

**Track A — Branded mode** (`forge.yml` found in project):

Frame runs in reduced form. The brand book's voice rules pre-fill the tone axes (formal/casual,
warm/technical) — do not re-derive them. Q1 (reader-action) and Q2 (takeaway) are still asked
because they are content-driven, not brand-driven. The aesthetic is already locked by the brand
book at priority 2 in Aesthetic Detection — Frame does not produce an aesthetic signal.

**Track B — Exploration mode** (no brand book found):

Frame runs in full. All four Frame questions are asked. The tone output flows into Style directly.
The Q2 takeaway output flows into Deliver. The Q1 reader-action output, combined with Q3 tone,
produces a content-type signal that feeds Aesthetic Detection priority 5 (content fallback) when
no higher-priority signal exists. This is the only path where Frame indirectly influences aesthetic
selection — and only as the lowest-priority fallback, not a lookup table.

In both tracks, Frame is always faster than generating output without it. Two minutes of judgment
prevents an hour of revision.

---

## Example Frame Trace

**Brief:** *"Visualize the NATS messaging topology for lyra #477 — help a new contributor
understand which processes talk to which."*

**Q1 — Reader + action:** New contributor, onboarding, learning. They need to trust the
architecture in approximately two minutes and leave knowing enough to start reading code.

**Q2 — Takeaway:** Three supervisor processes (hub, telegram, discord) communicate only via NATS
topics — no direct imports between them.

**Q3 — Tone:** Technical + warm + spacious + reflective. The reader should leave feeling "I
understand this now", not "wow that's complex." Dense mermaid with a dozen nodes would produce the
wrong reaction even if technically accurate.

**Q4 — Sentence verb:** *"...lets me see how messages flow."* The verb is *see*, not *decide* or
*debug*. This confirms the topology should prioritize visual clarity over information density.

---

**Flows to Structure:**

Topology is hub-and-spoke with three peers and one central hub — four nodes total, well under the
six-peer fgraph threshold. Reader-action (onboarding) and sentence verb (see) both point away from
dense mermaid and toward the radial fgraph layout. Spacious tone confirms it: fgraph's fixed-
position nodes with explicit whitespace match the "reflective" axis better than dagre's auto-packed
layout.

**Flows to Style:**

Tone is warm + reflective → `.hero.left-border` (warm, not elevated/formal) + `.section-label.dot`
(narrative, not square/technical). Topic labels on edges use `.card.accent` to give semantic color
to message routing without adding extra chrome. No verdict badges (those are formal+urgent). No
severity markers (those are debugging, not onboarding).

**Flows to Deliver:**

Verification criterion: the hub node must be visually dominant, topic labels must be readable at
normal zoom, the node count must not exceed six, and the narrative copy accompanying the diagram
must explicitly state "no direct imports" — because that is the Q2 takeaway, and the visual alone
does not communicate it without a caption.

---

## See Also

- `forge-ops.md` — Aesthetic Detection priority chain, Brand Book Detection, output paths
- `brand-book-schema.md` — full `forge.yml` schema; Track A tone constraints live under `deliver_must_match`
- `../skills/forge-chart/SKILL.md` — single-file chart skill; Frame Q4 verb most relevant here
- `../skills/forge-guide/SKILL.md` — split-file multi-tab guide skill; Frame Q2 takeaway is primary
- `../skills/forge-gallery/SKILL.md` — gallery skill; Frame applies to gallery purpose and viewer action
- `../skills/forge-epic/SKILL.md` — issue-linked epic skill; Frame Q1 reader-action drives tab set

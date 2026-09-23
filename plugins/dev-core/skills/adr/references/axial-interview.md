# Axial ADR — `/R-adr --axial`

Interview + write path for the foundational Axis of Decomposition ADR. Invoked by `/R-adr --axial` (standalone or from `/R-dev-init` Phase 3a). No durable agent manifest.

Let:
  D := `docs/architecture/adr/`
  R := `${CLAUDE_PLUGIN_ROOT}/../shared/references/axial-decomposition.md`
  AQ := ask user directly
  AXES, PRIMARY, ANTI_PATTERN, EXPECTED_DEBT, REVISIT := capture vars

Write-only for this ADR. Drift checking against an existing ADR is **R-architect axial mode** (read-only).

**Rationale:** Read R before starting — framework, 4 mandatory questions, reason categories.

## Phase 1 — Detect existing axial ADR

1. `mkdir -p $D` if missing (Write/Glob; ¬shell mkdir required).
2. `bun ${CLAUDE_PLUGIN_ROOT}/skills/adr/adr.ts axial` → `{count, files, singleton, declared, violated}`.
   The scan covers `D/archived/` as well, so a botched supersede that left
   `axial: true` on an archived ADR still counts here. Exit 1 ⟺ `violated`
   (>1 axial ADR — the invariant). `declared: false` is not a failure: it is a
   repo that has not declared its axis yet, which is why you are running this.
3. `count ≥ 1` → Read **all** `files` (do not `head -1` — singleton invariant is enforced here):
   - Exactly 1 match → display:
     ```
     Axial ADR already exists
     ════════════════════════
       File:    {path}
       Title:   {frontmatter.title}
       Status:  {frontmatter.status}
       Primary: {one-line excerpt from "## Decision"}
     ```
     → AQ:
     - **Keep as-is** → exit `kept`
     - **Supersede** (drift detected, re-decide) → continue Phase 2; remember old path for Phase 5
     - **Review only** → read full content, allow follow-up questions, then re-ask
   - >1 match → emit warning and require resolution before continuing:
     ```
     ⚠️  Multiple ADRs carry `axial: true` — singleton invariant violated.
       Files: {paths}
     ```
     → AQ:
     - **Auto-fix** (recommended) → strip `axial: true` from all but the newest, then re-enter Phase 1
     - **Abort** → exit `cancelled` with the violation surfaced to the caller
4. ∅ match → continue Phase 2.

## Phase 2 — Interview (4 mandatory + 1 optional)

Adapt phrasing to project context. Capture verbatim. Q1–Q4 mandatory.

### Q1 — Axes of variation (required)

Ask: *"What are the axes along which this system varies? For each, name the dimension and list concrete instances (current count + expected growth over 12 months)."*

Probe for ≥2 axes. Patterns:
- `targets × concerns` (Telegram/Discord/CLI × auth/retry/sanitization)
- `domains × layers` (User/Order/Payment × Domain/Application/Infra)
- `stages × pipelines` (parse/validate/route × ingest/enrich/store)

User cannot articulate → offer the 3 templates above.

Record `AXES := [{ name, instances, count_now, growth_12m }]`.

### Q2 — Primary axis (required)

Ask: *"Which axis is primary — i.e., when adding a new instance, which axis grows by 1 row (not by N×M cells)?"*

Probe for reasoning category:

| Category | Pattern |
|----------|---------|
| **Stability** | "Axis X changes rarely; Y multiplies fast" |
| **Composition** | "X primitives compose to express Y instances" |
| **Ownership** | "X is infra-owned (stable); Y is product-owned (volatile)" |

Reject "feels right" — push for one of the three.

Record `PRIMARY := { axis, reason_category, reason_text }`.

Tied candidates → tiebreaker: *"If you HAD to pick one for the next 6 months, which?"*

### Q3 — Anti-pattern signal (required)

Ask: *"What does drift along the wrong axis look like in code? Give 1 grep-able pattern (file glob, regex, symbol)."*

Constraint: R-architect axial mode later parses this and passes it to Grep. The pattern MUST be a single token (no whitespace-separated prose), ≤200 chars, using only `[a-zA-Z0-9_/*.\-\[\]^$|(){}\\]`. Reject prose-shaped answers ("things that look like a god class") and re-ask.

Record `ANTI_PATTERN := { pattern, where_to_grep }`.

### Q4 — Expected debt (required)

Ask: *"What debt do you accept by choosing this axis? Where will it bite later?"*

Force explicit naming. Examples:
- "Cross-target features become harder (Y-axis cost)"
- "Sharing a stage requires extracting an interface (refactor cost)"

Record `EXPECTED_DEBT := [{ description, mitigation_strategy }]`.

### Q5 — Revisit trigger (optional)

Ask: *"Under what condition would you re-open this decision?"*

Default if skipped:
- Sibling-fix rate > 3/week on any concern → auto-trigger review
- 6-monthly axial review (calendar)

Record `REVISIT := [...]`.

## Phase 3 — Synthesize and confirm

Display draft:

```
Draft — Axial ADR
═════════════════
  Axes:         {AXES summary table}
  Primary:      {PRIMARY.axis} ({PRIMARY.reason_category})
  Reason:       {PRIMARY.reason_text}
  Anti-pattern: {ANTI_PATTERN.pattern} @ {ANTI_PATTERN.where_to_grep}
  Debt items:   {len(EXPECTED_DEBT)}
  Revisit:      {REVISIT joined by " | "}
```

→ AQ: **Write ADR** | **Refine Q{N}** | **Cancel**

`Cancel` → exit `cancelled`. Caller decides next steps.

## Phase 4 — Write ADR

1. Next NNN: `bun ${CLAUDE_PLUGIN_ROOT}/skills/adr/adr.ts next-nnn` — scans
   `D/archived/` too, so an archived axial ADR never has its number reissued.
   ¬D → start at `001`.
2. Write `D/{NNN}-axis-of-decomposition.md` (always `.md`).

**Frontmatter and section skeleton: [adr-template.md](adr-template.md).** Use it
verbatim, plus the three deltas it specifies under *Axial delta* — `axial: true`,
the fixed title, and the two extra `## Consequences` subsections. Do not restate
the skeleton here; the copy that used to live in this file is how the axial path
and the skill drifted apart.

`status` := `accepted` (`proposed` when Phase 5 of *Escalation* applies).
`normative` := `true`. `date` := today.

Section content specific to this ADR:

| Section | Content |
|---------|---------|
| `## Context` | `This system varies along {len(AXES)} axes:` + table (Axis \| Instances now \| Growth 12m). Then: without an explicit primary axis, code drifts along the wrong dimension. Reference `shared/references/axial-decomposition.md`. ∃ superseded ADR → reference its NNN. |
| `## Options Considered` | ∀ axis ∈ AXES → `### Option: {axis.name} as primary` with **Pros** (from reason categories), **Cons** (from EXPECTED_DEBT), **Drift signature** (what wrong-axis duplication looks like) |
| `## Decision` | **Primary axis** `{PRIMARY.axis}`, **Reason category** `{PRIMARY.reason_category}`, **Rationale** `{PRIMARY.reason_text}`. Then: new `{PRIMARY.axis}` instance → grows by 1 row, composes existing primitives; new non-primary instance → composes via existing `{PRIMARY.axis}` primitives, does NOT duplicate them |
| `### Positive` | Benefits derived from the PRIMARY choice |
| `### Negative (Expected Debt)` | ∀ d ∈ EXPECTED_DEBT → `- {d.description} — Mitigation: {d.mitigation_strategy}` |
| `### Anti-pattern signal` | `Grep pattern: {ANTI_PATTERN.pattern} in {ANTI_PATTERN.where_to_grep}.` + if this pattern appears, drift along the wrong axis is starting |
| `### Revisit triggers` | ∀ r ∈ REVISIT → `- {r}` |

## Phase 5 — Supersede (if applicable)

From Phase 1 supersede flow, on the previous axial ADR:

```
bun ${CLAUDE_PLUGIN_ROOT}/skills/adr/adr.ts supersede --nnn {OLD} --by ADR-{NNN}
```

That one command does all four things the invariant needs: `status: superseded`,
`normative: false`, `superseded_by: ADR-{NNN}`, **strips `axial: true`**, and
moves the file to `D/archived/`.

Verify afterwards: `bun ${CLAUDE_PLUGIN_ROOT}/skills/adr/adr.ts axial` → exit 0
and `"count": 1`. The archived ADR must no longer answer the singleton grep, and
its number must still be taken.

¬supersede → skip.

## Phase 6 — Report

```
Axial ADR — {created | superseded | kept}
═════════════════════════════════════════
  File:         {path}
  Primary axis: {PRIMARY.axis} ({PRIMARY.reason_category})
  Anti-pattern: {ANTI_PATTERN.pattern}
  Debt items:   {len(EXPECTED_DEBT)}
  Revisit:      {REVISIT summary}

Canonical marker: `axial: true` in frontmatter (grep-discoverable).
Invariant: **at most one** ADR carries `axial: true`, across `$D` and `$D/archived/` — exactly one once this run completes.

Next:
  /R-dev-init can continue (if called from init)
  /R-spec and /R-dev-review dispatch R-architect **axial mode** when scope crosses the non-primary axis
```

Exit status: `created` | `kept` | `superseded` | `cancelled`.

## Edge Cases

| Scenario | Behavior |
|----------|----------|
| `$D` missing | create D, proceed |
| User cannot articulate axes | Offer 3 templates (target×concern, domain×layer, stage×pipeline) |
| Tied primary candidates | Tiebreaker: 6-month horizon |
| Existing axial ADR + supersede | `adr.ts supersede` → `status: superseded` + `normative: false` + `superseded_by` + strip `axial: true` + move to `$D/archived/`; new ADR Context references old |
| Multiple ADRs with `axial: true` | Phase 1: auto-fix (strip from all but newest) or abort |
| Previous axial ADR archived | Its number stays taken and its `axial: true` is gone — `adr.ts axial` must still report `count: 1` |
| Q1–Q4 skipped | Refuse — mandatory |
| Q3 answer is prose, not a grep pattern | Re-ask with the constraint stated |

## Boundaries

- Writes ONE ADR file (+ optional supersede transition of the previous ADR). Nothing else.
- ¬judge axis quality — surface trade-offs; the user owns the decision.
- ¬touch unrelated files in `$D`.
- ¬modify code outside `$D`.
- ¬spawn a dedicated axial-create agent. This reference **is** the procedure.

## Escalation

- User unable to articulate any axes → "Cannot proceed without axes. Suggest `/R-frame` first." Exit `cancelled`.
- Conflict between axes, no clear primary → write ADR with `status: proposed` in frontmatter, document the open question in `## Context`, exit `created` with warning.

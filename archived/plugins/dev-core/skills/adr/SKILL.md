---
name: R-adr
argument-hint: '["Title of decision" | --list | --axial | --migrate]'
description: Create/list Architecture Decision Records. `--axial` elicits the Axis of Decomposition ADR.
version: 0.6.0
allowed-tools: Write, Read, Glob, Grep, Bash, ToolSearch
---

# ADR (Architecture Decision Record)

Let:
  D := `docs/architecture/adr/`
  A := `D/archived/` — superseded ADRs
  A_TS := `${CLAUDE_PLUGIN_ROOT}/skills/adr/adr.ts`
  T := [references/adr-template.md](${CLAUDE_SKILL_DIR}/references/adr-template.md)
  NNN := zero-padded sequence number
  AQ := ask user

Create and manage ADRs — document **why** technical choices were made.

**T is the contract.** Frontmatter fields, the status vocabulary and the section
skeleton are defined there and nowhere else. Read T before writing an ADR; never
restate it here.

**Write format:** always Markdown (`.md`). Legacy `.mdx` ADRs are still readable
for scan/list/migrate; never write new `.mdx`.

```
/R-adr "Title"   → Create mode
/R-adr --list    → List mode
/R-adr --axial   → Axial mode (Axis of Decomposition interview + ADR)
/R-adr --migrate → Migrate mode (backfill the frontmatter contract)
```

`--axial` present → **Axial Mode** (below). Do not also run Create Mode.

## Axial Mode

Follow [references/axial-interview.md](${CLAUDE_SKILL_DIR}/references/axial-interview.md) end-to-end. That file is the procedure (interview, singleton, write, supersede). Exit `created` | `kept` | `superseded` | `cancelled`.

Called from `/R-dev-init` Phase 3a when no unique `axial: true` ADR exists (or singleton is broken). Standalone to re-elicit / supersede. ¬spawn a dedicated agent — this skill **is** the writer.

## Create Mode

**1. Next NNN:** `bun $A_TS next-nnn` → `{"next": "023", "collisions": [], "misnamed": []}`.

The scan **recurses into A**. An archived ADR keeps its number forever: reissuing
it would make `ADR-023` name two unrelated decisions and silently rewrite
history. ¬D → create D, start at `001`.

**Exit 1 ⟺ `collisions` ∨ `misnamed` non-empty — stop, do not write.** `next` is
`max(NNN) + 1` over the corpus, so either fault makes it wrong: a `collisions`
entry is a number already naming two documents, and a `misnamed` entry is a
file whose name can set the maximum without being an ADR (`2026-08-24-notes.md`
beside 001–005 allocated `2027`). Fix the corpus, then re-run.


**2. Resolve title:** ∃ title in `$ARGUMENTS` → use. ¬title → AQ.

**3. Interview:** AQ (1–2 calls, ≤3 questions). Skip if clear from title:

| Topic | Ask |
|-------|-----|
| Context | What problem prompted this decision? |
| Options | What alternatives were considered? (≥2, key pros/cons each) |
| Decision | Which was chosen and why? |
| Consequences | Positive, negative, neutral trade-offs? |

**4. Write ADR:** `D/{NNN}-{slug}.md`, frontmatter and sections exactly per T.
`date` := today. `status` := `accepted` unless the user says otherwise. Min 2 options.

**5. Supersede (∃ ADR this one replaces):**

| Scope | Command | Effect |
|-------|---------|--------|
| Whole ADR | `bun $A_TS supersede --nnn {OLD} --by ADR-{NNN}` | `status: superseded`, `normative: false`, `superseded_by`, strips `axial` and `superseded_in_part_by`, moves to A |
| Part of it | `bun $A_TS supersede-in-part --nnn {OLD} --by ADR-{NNN}` | appends to `superseded_in_part_by`; status, `normative: true` and location unchanged |

Reference the old NNN in the new ADR's `## Context`.

**Partial ⟹ the ADR stays law.** An ADR binding for every part nobody replaced
is `accepted` + `normative: true` + `superseded_in_part_by`. Rounding it to
`superseded` retires clauses still in force; rounding it to plain `accepted`
republishes a retired part as law, silently. See T § `superseded_in_part_by`.

A part retired by a change with no successor ADR is cited as `#{NNN}`:
`bun $A_TS supersede-in-part --nnn 3 --by '#268'`. That shape exists so an
unrecorded retirement can be stated rather than forced into an ADR that does
not exist.

**6. Confirm:** Inform: file path, NNN + title, status; ∃ supersede → old path → new path in A.

## Deprecating

`bun $A_TS deprecate --nnn {NNN}` → `status: deprecated`, `normative: false`.

**The file does not move.** Deprecated means the decision stopped applying and
*nothing replaced it*; there is no successor to file it behind, and moving it
would imply one. Only `superseded` archives.

## List Mode

`bun $A_TS list` → active and archived ADRs, read from frontmatter. ¬∃ → inform + suggest `/R-adr "Title"`.

Archived ADRs are presented separately — they are history, not law:

```
Architecture Decision Records
══════════════════════════════

  #    │ Title                    │ Status    │ Date
  001  │ Fastify over Express     │ accepted  │ 2025-03-15
  002  │ Bun as runtime           │ accepted  │ 2025-04-01
  003  │ REST over GraphQL        │ deprecated│ 2025-04-10

Archived (superseded)
  007  │ Documentation strategy   │ → ADR-016 │ 2025-06-12
```

∅ archived → omit the section.

## Migrate Mode

`bun $A_TS migrate [--dry-run]` — for a corpus written before the contract existed.

Backfills `status`, `normative` and `date` from the body `## Status` section,
reads `superseded_by` out of "Superseded by ADR-NNN" and
`superseded_in_part_by` out of "Partially superseded by ADR-NNN" / "Narrowed by
ADR-NNN" / "Amended by #NNN", then removes that section.

**`date` is the decision date.** The date on a "Superseded — YYYY-MM-DD" line is
when the decision *stopped* applying and is never read as `date`; missing dates
fall back to the file's first commit. See T § `date` for what the field means
when the true date is unrecoverable.

**Its verdict and the gate's agree.** Every violation it can derive a fix for is
fixed — including a `normative` that contradicts its own `status`, which it once
reported as already clean while leaving the file red. Every violation it cannot
fix is a warning, so `clean: false` and a red gate name the same corpus.

It never invents a value. Cases that need a human are reported, not guessed:

| Report | Why | Resolution |
|--------|-----|------------|
| `superseded_by` needs a human | Body says superseded but names no replacement | **Write the missing ADR** and name it. Reclassify as `deprecated` only if nothing replaced the decision — never to silence the report |
| `date` needs a human | No date in the body, no git history | Supply the decision date |
| status not in the vocabulary | Authored status is outside the closed set | Map it onto the vocabulary, or extend the contract in T and bump its version |
| `superseded_by` present but status is `X` | The two disagree | Decide which is true; the gate rejects both spellings of the contradiction |

> **Never resolve a report by editing the record it describes.** These findings
> are the corpus telling you a decision was taken and never written down.
> Downgrading a `superseded` ADR to `accepted` or `deprecated` makes the gate
> green by falsifying the decision log — the one move a decision log must never
> make. [ADR-023](../../../../docs/architecture/adr/023-plugin-cache-refresh-via-marketplace-install.md)
> § Decision is this repository's own instance: the fix was to write the
> successor, not to retract the record that pointed at the gap.

`clean: false` in the output → violations remain. Run `--dry-run` first, then
re-check with `scripts/check-agents-adr-hygiene.sh`.

## Hygiene Gate

`scripts/check-agents-adr-hygiene.sh` (seeded by `/R-dev-init`) enforces T in CI:
`status` + `normative` + `date` on every ADR (A included), `superseded_by` when
superseded, `superseded_in_part_by` only while the ADR still binds, one number
per document, a closed frontmatter fence, and **at most one** `axial: true`.
Booleans must be spelled `true`/`false` — `True` and `yes` are the same value to
a YAML parser and invisible to a reader matching the literal. Defaults: bare-ref
heuristic `warn` (`AGENTS_ADR_MODE`), frontmatter contract `fail`
(`AGENTS_ADR_CONTRACT_MODE`). Exit is 0 or 1, never anything else.

The gate ships **by value**, so it names the contract version it implements
(`CONTRACT_VERSION`, declared once in T). An ADR legal upstream but rejected
locally means the copy is frozen behind — `bun init.ts seed-adr-hygiene` reports
`stale`.

Two axial ADRs name two axes of decomposition — a contradiction, always a
violation. **Zero** is a repo that has not run `/R-adr --axial` yet, so
requiring one is opt-in: `AGENTS_ADR_AXIAL_MODE=warn|fail` (default `off`).
Turn it on once the axis is declared, and the corpus can never silently lose it.

## Edge Cases

| Scenario | Behavior |
|----------|----------|
| First ADR ever | Create D from scratch, start at `001` |
| ¬title provided | AQ before proceeding |
| Superseding an ADR | `bun $A_TS supersede` — flips status + normative, records `superseded_by`, moves to A |
| Deprecating an ADR | `bun $A_TS deprecate` — flips status + normative, file stays in D |
| Legacy `.mdx` present | Included in NNN scan, list and migrate; new ADRs still write `.md` |
| Same NNN as both `.md` and `.mdx` | Prefer `.md` for display; do not write over either |
| ADR corpus predates the contract | `/R-adr --migrate`, then resolve whatever it reports |
| `--axial` | Axial Mode only — see `references/axial-interview.md` |

$ARGUMENTS

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

**1. Next NNN:** `bun $A_TS next-nnn` → `{"next": "023"}`.

The scan **recurses into A**. An archived ADR keeps its number forever: reissuing
it would make `ADR-023` name two unrelated decisions and silently rewrite
history. ¬D → create D, start at `001`.

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

**5. Supersede (∃ ADR this one replaces):** `bun $A_TS supersede --nnn {OLD} --by ADR-{NNN}`.
Sets `status: superseded`, `normative: false`, `superseded_by`, strips `axial: true`,
moves the file to A. Reference the old NNN in the new ADR's `## Context`.

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
reads `superseded_by` out of "Superseded by ADR-NNN", then removes that section.
Dates absent from the body fall back to the file's first commit date.

It never invents a value. Two cases need a human and are reported, not guessed:

| Report | Why | Resolution |
|--------|-----|------------|
| `superseded_by` needs a human | Body says superseded but names no replacement | Name the ADR, or reclassify as `deprecated` — nothing replaced it |
| `date` needs a human | No date in the body, no git history | Supply the decision date |

`clean: false` in the output → violations remain. Run `--dry-run` first, then
re-check with `scripts/check-agents-adr-hygiene.sh`.

## Hygiene Gate

`scripts/check-agents-adr-hygiene.sh` (seeded by `/R-dev-init`) enforces T in CI:
`status` + `normative` + `date` on every ADR (A included), `superseded_by` when
superseded, **at most one** `axial: true`. Defaults: bare-ref heuristic `warn`
(`AGENTS_ADR_MODE`), frontmatter contract `fail` (`AGENTS_ADR_CONTRACT_MODE`).

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

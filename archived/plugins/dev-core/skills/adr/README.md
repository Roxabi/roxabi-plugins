# adr

Create and list Architecture Decision Records — document why technical choices were made.

## Why

Architectural decisions made today are forgotten next quarter. ADRs create a permanent, searchable record of *what was decided and why* — including alternatives considered and trade-offs accepted. Future contributors (and future you) can understand the intent behind the codebase without reading git blame.

## Usage

```
/R-adr "Fastify over Express"    Create a new ADR
/R-adr --list                    List active ADRs (archived shown separately)
/R-adr --axial                   Axis of Decomposition interview + ADR (`axial: true`)
/R-adr --migrate                 Backfill the frontmatter contract on an old corpus
```

Triggers: `"create an ADR"` | `"architecture decision"` | `"document why we chose"` | `"list ADRs"`

## How it works

### Create mode

1. **Next number** — `adr.ts next-nnn` scans `docs/architecture/adr/` for `{NNN}-*.md` (and legacy `{NNN}-*.mdx`), **including `archived/`**, and assigns the next number. Archiving never frees a number: reissuing one would make `ADR-007` name two decisions.
2. **Interview** — asks about: context (what triggered the decision), options considered (≥2, with pros/cons), decision and rationale, consequences (positive, negative, neutral). Skips questions clear from the title.
3. **Write ADR** — creates `docs/architecture/adr/{NNN}-{slug}.md` per the canonical template.

### Axial mode (`--axial`)

Elicits the unique Axis of Decomposition ADR (4 mandatory questions + optional revisit). Writes `axial: true` frontmatter. `/R-dev-init` Phase 3a calls this skill — no separate agent. Procedure: [references/axial-interview.md](references/axial-interview.md). Drift review later is **R-architect axial mode**.

### List mode

Reads each ADR's frontmatter — the same fields create mode writes — and shows active ADRs, with archived (superseded) ones in a separate section:

```
Architecture Decision Records
══════════════════════════════
  #    │ Title                │ Status    │ Date
  001  │ Fastify over Express │ accepted  │ 2025-03-15
  002  │ Bun as runtime       │ accepted  │ 2025-04-01
```

### Migrate mode (`--migrate`)

For a corpus written before the contract existed: backfills `status`, `normative` and `date` from the body `## Status` section, reads `superseded_by` out of "Superseded by ADR-NNN", then removes that section. It never invents a value — a superseded ADR that names no replacement, or an ADR with no findable date, is reported for a human instead of guessed.

## ADR structure

Frontmatter fields, the status vocabulary and the section skeleton are defined in exactly one place: **[references/adr-template.md](references/adr-template.md)**. Both writers (this skill and the axial path) derive from it, the hygiene gate enforces it, and a guard test fails on a second embedded copy — the two copies that used to exist had already drifted.

## Lifecycle

| Transition | Effect |
|------------|--------|
| `adr.ts supersede --nnn N --by ADR-M` | `status: superseded`, `normative: false`, `superseded_by`, strips `axial: true`, moves to `archived/` |
| `adr.ts deprecate --nnn N` | `status: deprecated`, `normative: false`. **Stays in place** — deprecated is not replaced |

`normative` marks binding authority, so one grep separates law from working notes. It only keeps that meaning because both transitions flip it to `false`.

## Hygiene gate

`scripts/check-agents-adr-hygiene.sh`, seeded into projects by `/R-dev-init` → `/R-ci-setup`. Asserts the contract on every ADR (`archived/` included) and **at most one** `axial: true`. Contract family defaults to `fail`; the AGENTS.md bare-ref heuristic defaults to `warn`.

Two axial ADRs is a contradiction and always fails. Zero is a repo that has not run `/R-adr --axial` yet — requiring an axis is opt-in via `AGENTS_ADR_AXIAL_MODE=warn|fail` (default `off`), so the gate is not red on arrival in the situation it exists to help.

## Storage

ADRs live in `docs/architecture/adr/` as Markdown. Their **content** is immutable — a decision is not rewritten, it is superseded or deprecated — and `/R-doc-sync` warns about stale ADR references but never edits them. Lifecycle frontmatter (`status`, `normative`, `superseded_by`) is the exception, and only the transitions above may change it. Legacy `.mdx` ADRs are read-only.

# adr

Create and list Architecture Decision Records — document why technical choices were made.

## Why

Architectural decisions made today are forgotten next quarter. ADRs create a permanent, searchable record of *what was decided and why* — including alternatives considered and trade-offs accepted. Future contributors (and future you) can understand the intent behind the codebase without reading git blame.

## Usage

```
/adr "Fastify over Express"    Create a new ADR
/adr --list                    List all existing ADRs
```

Triggers: `"create an ADR"` | `"architecture decision"` | `"document why we chose"` | `"list ADRs"`

## How it works

### Create mode

1. **Next number** — scans `docs/architecture/adr/` for existing `{NNN}-*.mdx` files; assigns next sequential number.
2. **Interview** — asks about: context (what triggered the decision), options considered (≥2, with pros/cons), decision and rationale, consequences (positive, negative, neutral). Skips questions clear from the title.
3. **Write ADR** — creates `docs/architecture/adr/{NNN}-{slug}.mdx` with standard MDX structure.
4. **Update meta** — appends the new slug to `docs/architecture/adr/meta.json` (Fumadocs-compatible format).

### List mode

Reads `meta.json` and each ADR's frontmatter to display:

```
Architecture Decision Records
══════════════════════════════
  #    │ Title                │ Status    │ Date
  001  │ Fastify over Express │ Accepted  │ 2025-03-15
  002  │ Bun as runtime       │ Accepted  │ 2025-04-01
```

## ADR structure

```mdx
---
title: "ADR-001: Fastify over Express"
description: one-line summary
---

## Status
Accepted

## Context
## Options Considered
## Decision
## Consequences
```

## Status values

`Proposed` | `Accepted` | `Deprecated` | `Superseded by ADR-XXX`

## Storage

ADRs are stored in `docs/architecture/adr/` and are **immutable** — `/doc-sync` warns about stale ADR references but never edits them.

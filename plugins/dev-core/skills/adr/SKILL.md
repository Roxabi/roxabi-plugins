---
name: adr
argument-hint: ["Title of decision" | --list]
description: Create/list Architecture Decision Records. Triggers: "create an ADR" | "architecture decision" | "document why we chose" | "list ADRs".
version: 0.4.0
allowed-tools: Write, Read, Glob, ToolSearch
---

# ADR (Architecture Decision Record)

Let:
  D := `docs/architecture/adr/`
  NNN := zero-padded 3-digit sequence number
  AQ := ask user
  ADR_GLOB := `{NNN}-*.md` + legacy `{NNN}-*.mdx` (read only)

Create and manage ADRs — document **why** technical choices were made.

**Write format:** always Markdown (`.md`). Legacy `.mdx` ADRs are still readable for list/scan; never write new `.mdx`.

```
/adr "Title"   → Create mode
/adr --list    → List mode
```

## Create Mode

**1. Next NNN:** Scan D for `{NNN}-*.md` and legacy `{NNN}-*.mdx` → highest + 1. ¬D ∨ ¬files → create D, start at `001`.

**2. Resolve title:** ∃ title in `$ARGUMENTS` → use. ¬title → AQ.

**3. Interview:** AQ (1–2 calls, ≤3 questions). Skip if clear from title:

| Topic | Ask |
|-------|-----|
| Context | What problem prompted this decision? |
| Options | What alternatives were considered? (≥2, key pros/cons each) |
| Decision | Which was chosen and why? |
| Consequences | Positive, negative, neutral trade-offs? |

**4. Write ADR:** `D/{NNN}-{slug}.md` (slug = kebab-case title).

```md
---
title: "ADR-{NNN}: {Title}"
description: {one-line summary}
---

## Status

{Proposed | Accepted | Deprecated | Superseded by ADR-XXX}

## Context

{What is the issue? Why does this decision need to be made?}

## Options Considered

### Option A: {Name}
- **Pros:** {advantages}
- **Cons:** {disadvantages}

### Option B: {Name}
- **Pros:** {advantages}
- **Cons:** {disadvantages}

## Decision

{What was decided and why.}

## Consequences

### Positive
- {benefit}

### Negative
- {trade-off}

### Neutral
- {side effect}
```

Default status: **Accepted** unless stated otherwise. Min 2 options.

**5. Confirm:** Inform: file path, NNN + title, status.

## List Mode

Scan D for `.md` and legacy `.mdx` files. ¬∃ → inform + suggest `/adr "Title"`.

∃ → ∀ file: read frontmatter for title, status, date. Sort by NNN ascending.

```
Architecture Decision Records
══════════════════════════════

  #    │ Title                    │ Status    │ Date
  001  │ Fastify over Express     │ Accepted  │ 2025-03-15
  002  │ Bun as runtime           │ Accepted  │ 2025-04-01
  003  │ REST over GraphQL        │ Deprecated│ 2025-04-10
```

## Edge Cases

| Scenario | Behavior |
|----------|----------|
| First ADR ever | Create D from scratch |
| ¬title provided | AQ before proceeding |
| Superseding an ADR | Update old status to `Superseded by ADR-{NNN}`; reference old in new context |
| Legacy `.mdx` present | Include in NNN scan + list; new ADRs still write `.md` |
| Same NNN as both `.md` and `.mdx` | Prefer `.md` for display; do not write over either |

$ARGUMENTS

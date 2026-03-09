---
name: adr
argument-hint: ["Title of decision" | --list]
description: Create/list Architecture Decision Records. Triggers: "create an ADR" | "architecture decision" | "document why we chose" | "list ADRs".
version: 0.3.0
allowed-tools: Write, Read, Glob, ToolSearch, AskUserQuestion
---

# ADR (Architecture Decision Record)

Let:
  D := `docs/architecture/adr/`
  NNN := zero-padded 3-digit sequence number

Create and manage Architecture Decision Records — document **why** technical choices were made.

```
/adr "Title"   → Create mode
/adr --list    → List mode
```

## Create Mode

**1. Next NNN:** Scan D for `{NNN}-*.mdx` → extract highest NNN → next = highest + 1.
¬D ∨ ¬files → create D, start at `001`.

**2. Resolve title:** ∃ title in `$ARGUMENTS` → use it. ¬title → AskUserQuestion.

**3. Interview:** AskUserQuestion (1–2 calls, ≤3 questions). Skip questions clear from title:

| Topic | Ask |
|-------|-----|
| Context | What problem prompted this decision? |
| Options | What alternatives were considered? (≥2, key pros/cons each) |
| Decision | Which was chosen and why? |
| Consequences | Positive, negative, neutral trade-offs? |

**4. Write ADR:** `D/{NNN}-{slug}.mdx` (slug = kebab-case title).

```mdx
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

Default status: **Accepted** unless stated otherwise. Include all options discussed (min 2).

**5. Update meta.json:** Read `D/meta.json`. ¬∃ → create: `{ "title": "ADRs", "pages": [] }`.

∃ `pages` array (Fumadocs format) → append new slug.
∃ array-of-objects (legacy) → migrate: extract `file` values, strip `.mdx`, rebuild as `{ "title": "ADRs", "pages": [...] }`, append new slug. ¬write legacy format.

**6. Confirm:** Inform: file path, NNN + title, status.

## List Mode

Scan D for `.mdx` files.
¬∃ → inform + suggest `/adr "Title"`.

∃ → read `meta.json`. ∃ `pages` array → iterate in order; ∀ slug: read frontmatter for title, status, date.
¬meta.json ∨ ¬recognised format → scan `.mdx` files directly.

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
| First ADR ever | Create D + `meta.json` from scratch |
| ¬title provided | AskUserQuestion before proceeding |
| Superseding an ADR | Update old ADR status to `Superseded by ADR-{NNN}`; reference old ADR in new context |
| meta.json out of sync | Rebuild from file frontmatter |
| meta.json in legacy format | Migrate transparently; user sees only new ADR confirmed |

$ARGUMENTS

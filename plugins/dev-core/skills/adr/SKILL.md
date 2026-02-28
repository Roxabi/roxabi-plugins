---
name: adr
argument-hint: ["Title of decision" | --list]
description: Create/list Architecture Decision Records. Triggers: "create an ADR" | "architecture decision" | "document why we chose" | "list ADRs".
version: 0.1.0
allowed-tools: AskUserQuestion, Write, Read, Glob
---

# ADR (Architecture Decision Record)

Create and manage Architecture Decision Records that document **why** technical choices were made.

## Instructions

### Determine Mode

- If `--list` flag is present: go to **List Mode**
- Otherwise: go to **Create Mode**

---

### Create Mode

#### 1. Determine Next ADR Number

```
Scan docs/architecture/adr/ for existing *.mdx files.
Extract the highest NNN from filenames matching {NNN}-*.mdx.
Next number = highest + 1 (zero-padded to 3 digits).
```

- If `docs/architecture/adr/` does not exist, create it and start at `001`.
- If no `.mdx` files exist, start at `001`.

#### 2. Resolve Title

- If a title was provided as argument, use it.
- If no title was provided, ask for one via **AskUserQuestion**.

#### 3. Interview (Brief)

Use **AskUserQuestion** to gather the decision context. Keep it short -- 2-3 questions max, grouped into a single call when possible.

Ask about:

| Topic | What to ask |
|-------|-------------|
| **Context** | What problem or need prompted this decision? |
| **Options** | What alternatives were considered? (at least 2) With key pros/cons for each. |
| **Decision** | Which option was chosen and why? |
| **Consequences** | What are the positive trade-offs, negative trade-offs, and neutral side effects? |

Adapt questions based on what the title already reveals. Skip questions whose answers are obvious from context.

#### 4. Generate ADR File

Write to `docs/architecture/adr/{NNN}-{slug}.mdx` where `slug` is a kebab-case version of the title.

Use this exact template:

```mdx
---
title: "ADR-{NNN}: {Title}"
description: {One-line summary of the decision}
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

- Default status to **Accepted** unless the user indicates otherwise.
- Include as many options as were discussed (minimum 2).

#### 5. Update meta.json

Read `docs/architecture/adr/meta.json` if it exists. If it does not exist, create it with:

```json
{ "title": "ADRs", "pages": [] }
```

The file uses the Fumadocs navigation format — a plain object with a `pages` array of ADR slugs (filename without `.mdx` extension):

```json
{ "title": "ADRs", "pages": ["001-fastify-over-express", "002-bun-as-runtime"] }
```

Read the parsed content:
- If the content is a plain object with a `pages` array (Fumadocs format) — append the new slug to `pages` and write the updated object back.
- If the content is an array (old array-of-objects format) — migrate: extract the `file` field from each entry, strip the `.mdx` extension to reconstruct slugs, rebuild as `{ "title": "ADRs", "pages": ["001-slug", "002-slug", ...] }`, then append the new slug and write.
- Never write the old array-of-objects format.

#### 6. Confirm

Tell the user the ADR was created, showing:
- File path
- ADR number and title
- Status

---

### List Mode

When `--list` flag is used:

1. Scan `docs/architecture/adr/` for all `.mdx` files.
2. If no ADRs exist, inform the user and suggest creating one with `/adr "Title"`.
3. If ADRs exist, read `meta.json` and check for the Fumadocs `{ title, pages }` format. If `pages` is present, iterate the slugs in order to list each ADR. For each slug, derive the filename (`{slug}.mdx`) and read its frontmatter for title, status, and date. Present a table:

```
Architecture Decision Records
══════════════════════════════

  #    │ Title                              │ Status    │ Date
  001  │ Fastify over Express               │ Accepted  │ 2025-03-15
  002  │ Bun as runtime                     │ Accepted  │ 2025-04-01
  003  │ REST over GraphQL                  │ Deprecated│ 2025-04-10
```

If `meta.json` is missing or is not in the recognised `{ title, pages }` format, fall back to scanning all `.mdx` files directly and reading frontmatter from each file.

## Edge Cases

- **First ADR ever:** Create `docs/architecture/adr/` directory and `meta.json` from scratch.
- **No title provided:** Ask for one via AskUserQuestion before proceeding.
- **Superseding an ADR:** When the user mentions superseding an existing ADR, update the old ADR's status to `Superseded by ADR-{NNN}` and the new ADR's context should reference the old one.
- **meta.json out of sync:** If `.mdx` files exist but `meta.json` is missing or incomplete, rebuild it from file frontmatter.
- **meta.json in old format:** If the file contains an array of objects `[{ number, title, ... }]` (legacy format), migrate it to Fumadocs format by extracting `file` values and stripping `.mdx`. Append the new slug and write the updated object. The migration is performed transparently — the user sees only the new ADR being confirmed.

$ARGUMENTS

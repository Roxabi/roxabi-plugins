---
title: "ADR-016: Plain Markdown docs — drop Fumadocs scaffold"
description: Write path for project docs is always Markdown (.md). Fumadocs scaffolding and MDX verification are removed; legacy .mdx remains read-only.
---

## Status

Accepted

## Context

ADR-007 standardized documentation on per-project Fumadocs (`apps/docs/` + MDX content). In practice the ecosystem abandoned Fumadocs: plain Markdown is enough for agent-driven docs, ADRs, standards, and guides. Keeping dual write paths (`.md` / `.mdx`), Fumadocs CLI scaffolds, VS Code MDX checks, and Vercel docs deploy phases added maintenance cost without product value.

## Options Considered

### Option A: Keep Fumadocs as optional framework
- **Pros:** Existing projects with `apps/docs/` still get first-class support.
- **Cons:** Continues to ship a large scaffold surface, MDX defaults, and verification scripts for a stack nobody wants to start new.

### Option B: Full kill Fumadocs; Markdown write-only (chosen)
- **Pros:** Single write format; simpler `/env-setup`, `/checkup`, `/adr`, `stack.yml.example`; agents stop creating `.mdx` by habit.
- **Cons:** Existing `.mdx` trees are not auto-migrated (must be read as legacy).

### Option C: Soft default to MD, keep Fumadocs scaffold
- **Pros:** Less churn.
- **Cons:** Dead code remains; defaults still drift.

## Decision

1. **Write always `.md`** — `scaffold-docs`, `/adr`, `/seed-docs`, `/promote` changelog pages, doc-writer, standards paths.
2. **Remove Fumadocs** — delete `lib/fumadocs.ts`, `scaffold-fumadocs` / `scaffold-fumadocs-vercel` CLI, env-setup Fumadocs phase, ci-setup Vercel docs phase, checkup Fumadocs + VS Code MDX verification.
3. **Legacy read** — skills may still **open** `*.mdx` (artifacts, ADRs, standards) but must not create new `.mdx` or fail health checks because MDX tooling is missing.
4. Supersedes **ADR-007**.

## Consequences

### Positive
- One mental model for docs and ADRs.
- Smaller plugin surface; fewer false health warnings.

### Negative
- Projects still on Fumadocs sites must maintain them outside dev-core/dev-init.
- Historical ADRs remain `.mdx` until manually renamed.

### Neutral
- `docs.framework` may stay in stack.yml as `none` / optional site name; no longer drives scaffold.

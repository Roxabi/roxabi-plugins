# Spec file contract (L)

Required path: `artifacts/specs/{N}-{slug}-spec.md` (or explicit `--spec <path>`).

## Frontmatter

```yaml
---
title: Short feature title
type: feat          # feat | fix | chore | … → git branch <type>/<issue>-<slug>
issue: 42           # number — required before ω
spark: silex#12     # optional Spark ticket (client#ref)
status: validated   # draft | validated | built
---

## Required sections

### ## TL;DR

One-paragraph summary. First line becomes the GitHub issue title when minting.

### ## Data model

Entities, fields, relationships, persistence boundaries.

### ## Acceptance

Observable criteria — testable, numbered if helpful.

### ## Out of scope

Explicit non-goals for this build.

### ## Invariants

Rules that must hold before, during, and after implementation.

### ## CONTEXT terms

Links to domain vocabulary in:

- `docs/kit/CONTEXT.md`
- `docs/product/CONTEXT.md`

Use markdown links to anchored headings where terms are defined.

## Bus field

After issue mint or when `#N` is supplied, frontmatter MUST include `issue: <N>`.

Optional trailing metadata line in body (not a heading):

```
issue: #42
```

Prefer frontmatter `issue:` as source of truth.

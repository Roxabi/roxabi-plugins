# Analysis: Typed Workspace Projects (Technical vs Company)

**Date:** 2026-03-03
**Status:** Draft
**Author:** Mickael + Claude

---

## Problem

The dev-core dashboard currently assumes all GitHub Projects are *technical* — fields are hardcoded (Status, Size, Priority), field IDs come from global `.env` vars, and column rendering is uniform across all projects.

This breaks as soon as a second project type is introduced. Ryvo's case is the concrete trigger: they need both a **tech issues board** (engineering, sprints, `/dev #N` workflow) and a **company roadmap board** (product initiatives, quarters, pillars) displayed in the same dashboard.

---

## Current State

### WorkspaceProject interface

```typescript
export interface WorkspaceProject {
  repo: string
  projectId: string
  label: string
  vercelProjectId?: string
  vercelTeamId?: string
}
```

### Field ID sourcing

Field IDs (status, size, priority) are read from `.env` globally:

```typescript
// shared/config.ts
export const PROJECT_ID = process.env.PROJECT_ID ?? ''
export const STATUS_FIELD_ID = process.env.STATUS_FIELD_ID ?? ''
export const SIZE_FIELD_ID = process.env.SIZE_FIELD_ID ?? ''
export const PRIORITY_FIELD_ID = process.env.PRIORITY_FIELD_ID ?? ''
```

### Consequences

- Adding a second project with different fields (Quarter, Pillar) to workspace causes silent failures on inline edits — the wrong field IDs are used.
- Column headers and sort order are hardcoded for the technical schema.
- `update.ts` FIELD_MAP is global; it can't dispatch to the right project's fields.
- CI/Vercel integration is rendered for every project tab, even roadmap ones where it makes no sense.

---

## Proposed Design

### Core principle

> `type` = what to render (UI hint). `fieldIds` = where the data lives (schema). Keep them separate.

### Extended WorkspaceProject

```typescript
export type ProjectType = 'technical' | 'company'

export interface ProjectFieldIds {
  status: string
  col2?: string                        // Size (technical) | Quarter (company)
  col3?: string                        // Priority (technical) | Pillar (company)
  statusOptions?: Record<string, string>  // { 'Planned': 'f75ad846', ... }
  col2Options?: Record<string, string>
  col3Options?: Record<string, string>
}

export interface WorkspaceProject {
  repo: string
  projectId: string
  label: string
  type?: ProjectType                   // defaults to 'technical'
  fieldIds?: ProjectFieldIds           // stored at /init time
  vercelProjectId?: string
  vercelTeamId?: string
}
```

`col2` / `col3` are semantic slots, not named fields. The dashboard reads whatever field ID is stored there. Column headers and icons are derived from `type`.

### Column schemas by type

| Slot | Technical | Company |
|------|-----------|---------|
| col2 header | Size | Quarter |
| col2 icon | 📐 | 📅 |
| col3 header | Priority | Pillar |
| col3 icon | 🔥 | 🏛 |
| CI/Vercel tab | Yes | No |
| `/dev #N` links | Yes | No |
| Default sort | Priority desc | Quarter asc |
| Sub-issue graph | Yes | No |

### workspace.json shape (after change)

```json
{
  "projects": [
    {
      "repo": "ryvo-ai/ryvo_app",
      "projectId": "PVT_kwDOD8yDV84BQoxQ",
      "label": "ryvo-tech",
      "type": "technical",
      "fieldIds": {
        "status": "PVTSSF_...",
        "col2": "PVTSSF_...",
        "col3": "PVTSSF_...",
        "statusOptions": { "Todo": "f75ad846", "In Progress": "47fc9ee4", "Done": "98236657" },
        "col2Options": { "XS": "bdeac9b0", "S": "480e133f", "M": "63f52f4f", "L": "54b2e87a", "XL": "1a56df0c" },
        "col3Options": { "P0 - Urgent": "ea44f84b", "P1 - High": "3ff05141", "P2 - Medium": "b91d4432", "P3 - Low": "76119955" }
      }
    },
    {
      "repo": "ryvo-ai/ryvo_app",
      "projectId": "PVT_kwDOD8yDV84BQozQ",
      "label": "ryvo-roadmap",
      "type": "company",
      "fieldIds": {
        "status": "PVTSSF_lADOD8yDV84BQozQzg-sw20",
        "col2": "PVTSSF_lADOD8yDV84BQozQzg-sw6c",
        "col3": "PVTSSF_lADOD8yDV84BQozQzg-sw8c",
        "statusOptions": { "Planned": "f75ad846", "In Progress": "47fc9ee4", "Done": "98236657" },
        "col2Options": { "Q1 2026": "4edf1ce4", "Q2 2026": "dfb62b2e", "Q3 2026": "52ea8119", "Q4 2026": "256f3d22" },
        "col3Options": { "Product": "2963e678", "Growth": "541b81b6", "Infra": "feb1f7cf", "Team": "2ab9c987", "Finance": "cb54e194" }
      }
    }
  ]
}
```

---

## Files to Change

| File | Change |
|------|--------|
| `skills/shared/workspace.ts` | Add `ProjectType`, `ProjectFieldIds`, extend `WorkspaceProject` |
| `skills/shared/config.ts` | `resolveConfig()` returns full `fieldIds` from workspace, falls back to env |
| `skills/issues/lib/update.ts` | Accept `fieldIds` param; stop reading from global env |
| `skills/issues/lib/page.ts` | Column headers/icons/sort driven by `project.type`; hide CI/Vercel for company |
| `skills/issues/lib/fetch.ts` | Pass `fieldIds` through to update paths |
| `skills/issues/lib/types.ts` | Add `type` to any project-level types |
| `skills/init/init.ts` | `scaffold` writes `fieldIds` to workspace instead of `.env`; add `--type` flag to `create-project` |
| `skills/init/SKILL.md` | Document `--type` option |

---

## Migration / Backwards Compatibility

- `type` defaults to `'technical'` — zero breaking change for existing configs.
- `fieldIds` in workspace is optional — if absent, fall back to `.env` field ID vars (current behaviour).
- Existing users see no difference until they re-run `/init` or manually add `fieldIds` to `workspace.json`.

---

## What We Are NOT Doing

- **Fully dynamic schema** (introspect GitHub fields at runtime) — too complex, unpredictable column order, makes typed inline edits hard.
- **More than two types now** — `hiring`, `legal`, `support` can be added later without breaking this interface.
- **Field IDs staying in `.env`** — `.env` is for secrets/tokens only going forward. Field IDs are schema metadata, not secrets.

---

## Open Questions

- [ ] Should `company` type support inline field edits at all, or be display-only in v1?
- [ ] Should `/init` auto-detect project type by inspecting which fields exist (if no Size/Priority → company)?
- [ ] Should the dashboard support a `type: 'company'` roadmap-style timeline view (not just a table) in a future iteration?

---

## Scope Estimate

~3-4h focused plugin work. Not a rewrite — a targeted extension of existing structure.

Phases:
1. Extend types + workspace interface (30min)
2. Migrate `config.ts` + `update.ts` to use per-project `fieldIds` (45min)
3. `page.ts` conditional rendering by type (1h)
4. `init.ts` writes `fieldIds` to workspace on scaffold (45min)
5. Test with ryvo dual-board setup (30min)
6. Update SKILL.md docs (30min)

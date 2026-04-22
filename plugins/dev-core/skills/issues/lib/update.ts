import { readWorkspace } from '../../../cli/lib/workspace-store'
import {
  FIELD_MAP,
  isProjectConfigured,
  NOT_CONFIGURED_MSG,
  resolveFieldIds,
} from '../../shared/adapters/config-helpers'
import { getItemId, updateField } from '../../shared/adapters/github-adapter'
import type { ProjectFieldIds } from '../../shared/domain/types'

// Map legacy field names (from browser context menu) to slot names
const FIELD_ALIAS: Record<string, string> = { size: 'col2', priority: 'col3' }

export async function handleUpdate(req: Request): Promise<Response> {
  try {
    const body = (await req.json()) as {
      issueNumber: number
      field: string
      value: string
      projectLabel?: string
    }
    const { issueNumber, field, value, projectLabel } = body

    // Find project in workspace when projectLabel is provided
    const project = projectLabel ? readWorkspace().projects.find((p) => p.label === projectLabel) : undefined

    if (projectLabel && !project) {
      return Response.json({ ok: false, error: 'Unknown project' }, { status: 400 })
    }

    let fieldIds: ProjectFieldIds | null = null
    if (project) {
      fieldIds = resolveFieldIds(project)
    } else {
      // Legacy mode: no per-project fieldIds — check env config
      if (!isProjectConfigured()) {
        return Response.json({ ok: false, error: NOT_CONFIGURED_MSG }, { status: 400 })
      }
    }

    // Map 'size'→'col2', 'priority'→'col3' for legacy callers; pass 'col2'/'col3'/'status' through
    const slot = FIELD_ALIAS[field] ?? field

    const effectiveFieldIds: ProjectFieldIds = fieldIds ?? {
      status: FIELD_MAP.status.fieldId,
      col2: FIELD_MAP.size.fieldId,
      col3: FIELD_MAP.priority.fieldId,
      statusOptions: FIELD_MAP.status.options,
      col2Options: FIELD_MAP.size.options,
      col3Options: FIELD_MAP.priority.options,
    }

    const fieldId = effectiveFieldIds[slot as keyof ProjectFieldIds] as string | undefined
    if (!fieldId) return Response.json({ ok: true }) // no-op when slot absent

    const options = effectiveFieldIds[`${slot}Options` as keyof ProjectFieldIds] as Record<string, string> | undefined
    const optionId = options?.[value]
    if (!optionId) return Response.json({ ok: false, error: `Unknown value: ${value}` }, { status: 400 })

    const overrides = project ? { projectId: project.projectId, repo: project.repo } : undefined
    const itemId = await getItemId(issueNumber, overrides)
    await updateField(itemId, fieldId, optionId, project?.projectId)

    return Response.json({ ok: true })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[update] handleUpdate error:', msg)
    return Response.json({ ok: false, error: 'Update failed — check server logs' }, { status: 500 })
  }
}

/**
 * Create GitHub Project V2 board + 3 standard fields.
 */

import { run, parseProjectFields } from '../../shared/github'
import type { ParsedField } from '../../shared/github'
import { DEFAULT_STATUS_OPTIONS, DEFAULT_SIZE_OPTIONS, DEFAULT_PRIORITY_OPTIONS } from '../../shared/config'

export interface CreateProjectResult {
  id: string
  number: number
  fields: { status: ParsedField; size: ParsedField; priority: ParsedField }
}

const FIELD_DEFS = [
  { name: 'Status', options: DEFAULT_STATUS_OPTIONS.join(',') },
  { name: 'Size', options: DEFAULT_SIZE_OPTIONS.join(',') },
  { name: 'Priority', options: DEFAULT_PRIORITY_OPTIONS.join(',') },
]

export async function createProject(owner: string, repoName: string): Promise<CreateProjectResult> {
  // Create project
  const createJson = await run(['gh', 'project', 'create', '--owner', owner, '--title', `${repoName} board`, '--format', 'json'])
  const project = JSON.parse(createJson) as { id: string; number: number }

  const pn = String(project.number)

  // Create single-select fields — each may already exist (Status is a built-in)
  for (const field of FIELD_DEFS) {
    try {
      await run(['gh', 'project', 'field-create', pn, '--owner', owner, '--name', field.name, '--data-type', 'SINGLE_SELECT', '--single-select-options', field.options])
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (!msg.includes('already been taken') && !msg.includes('already exists')) throw err
    }
  }

  // Fetch field IDs + option IDs
  const fieldsJson = await run(['gh', 'project', 'field-list', pn, '--owner', owner, '--format', 'json'])
  const parsed = parseProjectFields(fieldsJson)

  return {
    id: project.id,
    number: project.number,
    fields: {
      status: parsed.status ?? { id: '', options: {} },
      size: parsed.size ?? { id: '', options: {} },
      priority: parsed.priority ?? { id: '', options: {} },
    },
  }
}

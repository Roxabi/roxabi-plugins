/**
 * Create GitHub Project V2 board + 3 standard fields.
 */

import { run } from '../../shared/github'

interface FieldResult {
  id: string
  options: Record<string, string>
}

export interface CreateProjectResult {
  id: string
  number: number
  fields: { status: FieldResult; size: FieldResult; priority: FieldResult }
}

export async function createProject(owner: string, repoName: string): Promise<CreateProjectResult> {
  // Create project
  const createJson = await run(['gh', 'project', 'create', '--owner', owner, '--title', `${repoName} board`, '--format', 'json'])
  const project = JSON.parse(createJson) as { id: string; number: number }

  const pn = String(project.number)

  // Create single-select fields (Status may already exist as a built-in field)
  try {
    await run(['gh', 'project', 'field-create', pn, '--owner', owner, '--name', 'Status', '--data-type', 'SINGLE_SELECT', '--single-select-options', 'Backlog,Analysis,Specs,In Progress,Review,Done'])
  } catch (err) {
    // Status is a built-in field on GitHub Projects V2 — skip if it already exists
    const msg = err instanceof Error ? err.message : String(err)
    if (!msg.includes('already been taken') && !msg.includes('already exists')) throw err
  }
  await run(['gh', 'project', 'field-create', pn, '--owner', owner, '--name', 'Size', '--data-type', 'SINGLE_SELECT', '--single-select-options', 'XS,S,M,L,XL'])
  await run(['gh', 'project', 'field-create', pn, '--owner', owner, '--name', 'Priority', '--data-type', 'SINGLE_SELECT', '--single-select-options', 'P0 - Urgent,P1 - High,P2 - Medium,P3 - Low'])

  // Fetch field IDs + option IDs
  const fieldsJson = await run(['gh', 'project', 'field-list', pn, '--owner', owner, '--format', 'json'])
  const fields = JSON.parse(fieldsJson) as { fields: Array<{ id: string; name: string; options?: Array<{ id: string; name: string }> }> }

  const result: CreateProjectResult = {
    id: project.id,
    number: project.number,
    fields: {
      status: { id: '', options: {} },
      size: { id: '', options: {} },
      priority: { id: '', options: {} },
    },
  }

  for (const f of fields.fields ?? []) {
    const key = f.name.toLowerCase() as 'status' | 'size' | 'priority'
    if (key === 'status' || key === 'size' || key === 'priority') {
      const options: Record<string, string> = {}
      for (const opt of f.options ?? []) options[opt.name] = opt.id
      result.fields[key] = { id: f.id, options }
    }
  }

  return result
}

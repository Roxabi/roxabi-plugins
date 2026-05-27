/**
 * Create GitHub Project V2 board + 3 standard fields.
 * Supports --type technical|company to configure per-project field slots.
 */

import { readWorkspace, writeWorkspace } from '../../../cli/lib/workspace-store'
import {
  DEFAULT_PRIORITY_OPTIONS,
  DEFAULT_SIZE_OPTIONS,
  DEFAULT_STATUS_OPTIONS,
} from '../../shared/adapters/config-helpers'
import type { ParsedField } from '../../shared/adapters/github-adapter'
import { ghGraphQL, linkProjectToRepo, parseProjectFields, run } from '../../shared/adapters/github-adapter'
import type { ProjectFieldIds } from '../../shared/domain/types'
import type { ProjectType, WorkspaceProject } from '../../shared/ports/workspace'
import { PROJECT_WORKFLOWS_QUERY, UPDATE_FIELD_OPTIONS_MUTATION } from '../../shared/queries'

export interface ProjectWorkflow {
  id: string
  name: string
  enabled: boolean
}

export interface CreateProjectResult {
  id: string
  number: number
  fields: { status: ParsedField; size: ParsedField; priority: ParsedField }
  entry: WorkspaceProject
}

// Field slot names per project type (maps to GitHub field names to look up)
const SLOT_NAMES: Record<ProjectType, { col2: string[]; col3: string[] }> = {
  technical: { col2: ['Size'], col3: ['Priority'] },
  company: { col2: ['Quarter'], col3: ['Pillar'] },
}

// Colors applied in order to single-select options when replacing field options via GraphQL
const STATUS_COLORS = ['GRAY', 'BLUE', 'PURPLE', 'YELLOW', 'ORANGE', 'GREEN', 'RED', 'PINK'] as const

const FIELD_DEFS: Record<ProjectType, Array<{ name: string; options: string }>> = {
  technical: [
    { name: 'Status', options: DEFAULT_STATUS_OPTIONS.join(',') },
    { name: 'Size', options: DEFAULT_SIZE_OPTIONS.join(',') },
    { name: 'Priority', options: DEFAULT_PRIORITY_OPTIONS.join(',') },
  ],
  company: [
    { name: 'Status', options: DEFAULT_STATUS_OPTIONS.join(',') },
    { name: 'Quarter', options: 'Q1,Q2,Q3,Q4' },
    { name: 'Pillar', options: 'Engineering,Product,Operations,Strategy' },
  ],
}

/**
 * Query GitHub Project V2 fields and map to ProjectFieldIds.
 * Missing fields → console.warn + returns {} so workspace entry is written with empty fieldIds.
 */
async function resolveProjectFieldIds(
  projectNumber: number,
  owner: string,
  type: ProjectType,
): Promise<ProjectFieldIds> {
  try {
    const fieldsJson = await run([
      'gh',
      'project',
      'field-list',
      String(projectNumber),
      '--owner',
      owner,
      '--format',
      'json',
    ])
    if (!fieldsJson) return {} as ProjectFieldIds

    const raw = JSON.parse(fieldsJson) as {
      fields: Array<{ id: string; name: string; options?: Array<{ id: string; name: string }> }>
    }
    const fields = raw.fields ?? []

    const toOptionMap = (f: { options?: Array<{ id: string; name: string }> }): Record<string, string> => {
      const map: Record<string, string> = {}
      for (const opt of f.options ?? []) map[opt.name] = opt.id
      return map
    }

    const statusField = fields.find((f) => f.name === 'Status')
    const slotNames = SLOT_NAMES[type]
    const col2Field = fields.find((f) => slotNames.col2.includes(f.name))
    const col3Field = fields.find((f) => slotNames.col3.includes(f.name))

    if (!statusField || !col2Field || !col3Field) {
      console.warn(`[init] some fields not found for project (type=${type}); writing fieldIds: {}`)
      return {} as ProjectFieldIds
    }

    return {
      status: statusField.id,
      col2: col2Field.id,
      col3: col3Field.id,
      statusOptions: toOptionMap(statusField),
      col2Options: toOptionMap(col2Field),
      col3Options: toOptionMap(col3Field),
    }
  } catch {
    console.warn('[init] field resolution failed; writing fieldIds: {}')
    return {} as ProjectFieldIds
  }
}

export async function createProject(
  owner: string,
  repoName: string,
  type: ProjectType = 'technical',
): Promise<CreateProjectResult> {
  const fieldDefs = FIELD_DEFS[type]

  // Create project board
  const createJson = await run([
    'gh',
    'project',
    'create',
    '--owner',
    owner,
    '--title',
    `${repoName} board`,
    '--format',
    'json',
  ])
  const project = JSON.parse(createJson) as { id: string; number: number }
  const pn = String(project.number)

  // Link the project to the repository so it appears in repository.projectsV2
  await linkProjectToRepo(project.id, owner, repoName)

  // Fetch existing fields — GitHub auto-creates Status with Todo/In Progress/Done
  const existingJson = await run(['gh', 'project', 'field-list', pn, '--owner', owner, '--format', 'json'])
  const existingFields = (JSON.parse(existingJson) as { fields: Array<{ id: string; name: string }> }).fields ?? []
  const existingByName = Object.fromEntries(existingFields.map((f) => [f.name, f.id]))

  // Create or update single-select fields for this project type
  for (const field of fieldDefs) {
    const existingId = existingByName[field.name]
    if (existingId) {
      // Field already exists (e.g. GitHub's default Status) — replace its options
      const options = field.options.split(',').map((name, i) => ({
        name: name.trim(),
        color: STATUS_COLORS[i] ?? 'GRAY',
        description: '',
      }))
      await ghGraphQL(UPDATE_FIELD_OPTIONS_MUTATION, { fieldId: existingId, options: options as unknown as boolean })
    } else {
      await run([
        'gh',
        'project',
        'field-create',
        pn,
        '--owner',
        owner,
        '--name',
        field.name,
        '--data-type',
        'SINGLE_SELECT',
        '--single-select-options',
        field.options,
      ])
    }
  }

  // Fetch field IDs + option IDs via gh field-list
  const fieldsJson = await run(['gh', 'project', 'field-list', pn, '--owner', owner, '--format', 'json'])
  const parsed = parseProjectFields(fieldsJson)

  // Resolve per-project fieldIds for workspace entry
  const fieldIds = await resolveProjectFieldIds(project.number, owner, type)

  // Register in workspace
  const ws = readWorkspace()
  const entry: WorkspaceProject = {
    repo: `${owner}/${repoName}`,
    projectId: project.id,
    label: repoName,
    type,
    fieldIds: Object.keys(fieldIds).length > 0 ? fieldIds : ({} as ProjectFieldIds),
  }
  writeWorkspace({ ...ws, projects: [...ws.projects, entry] })

  return {
    id: project.id,
    number: project.number,
    fields: {
      status: parsed.status ?? { id: '', options: {} },
      size: parsed.size ?? { id: '', options: {} },
      priority: parsed.priority ?? { id: '', options: {} },
    },
    entry,
  }
}

/** List all built-in workflows on a GitHub Project V2. */
export async function listProjectWorkflows(projectId: string): Promise<ProjectWorkflow[]> {
  const data = (await ghGraphQL(PROJECT_WORKFLOWS_QUERY, { projectId })) as {
    data: { node: { workflows: { nodes: ProjectWorkflow[] } } }
  }
  return data.data.node.workflows.nodes
}

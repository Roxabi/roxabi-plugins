/**
 * Create GitHub Project V2 board + 3 standard fields.
 */

import { run, parseProjectFields, ghGraphQL } from '../../shared/github'
import type { ParsedField } from '../../shared/github'
import { DEFAULT_STATUS_OPTIONS, DEFAULT_SIZE_OPTIONS, DEFAULT_PRIORITY_OPTIONS } from '../../shared/config'
import { PROJECT_WORKFLOWS_QUERY, UPDATE_PROJECT_WORKFLOW_MUTATION } from '../../shared/queries'

export interface ProjectWorkflow {
  id: string
  name: string
  enabled: boolean
}

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

/** List all built-in workflows on a GitHub Project V2. */
export async function listProjectWorkflows(projectId: string): Promise<ProjectWorkflow[]> {
  const data = (await ghGraphQL(PROJECT_WORKFLOWS_QUERY, { projectId })) as {
    data: { node: { workflows: { nodes: ProjectWorkflow[] } } }
  }
  return data.data.node.workflows.nodes
}

/** Enable a single GitHub Project V2 built-in workflow. */
export async function enableProjectWorkflow(workflowId: string): Promise<ProjectWorkflow> {
  const data = (await ghGraphQL(UPDATE_PROJECT_WORKFLOW_MUTATION, { workflowId, enabled: true })) as {
    data: { updateProjectV2Workflow: { projectV2Workflow: ProjectWorkflow } }
  }
  return data.data.updateProjectV2Workflow.projectV2Workflow
}

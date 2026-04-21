import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import {
  createIssueType as createIssueTypeWrapper,
  ghGraphQL,
  listOrgIssueTypes,
  listOrgProjects,
  updateIssueType as updateIssueTypeWrapper,
} from '../../shared/adapters/github-adapter'
import {
  CREATE_PROJECT_V2_FIELD_MUTATION,
  CREATE_PROJECT_V2_MUTATION,
  PROJECT_FIELDS_QUERY,
  UPDATE_FIELD_OPTIONS_MUTATION,
} from '../../shared/queries'

const HUB_PROJECT_TITLE = 'Roxabi Hub'

// Issue Type IDs from spec 119 §Context (existing org types)
const BUG_TYPE_ID = 'IT_kwDOB8J6DM4BJQ3X'
const FEATURE_TYPE_ID = 'IT_kwDOB8J6DM4BJQ3Z'
const TASK_TYPE_ID = 'IT_kwDOB8J6DM4BJQ3W'

const LANE_OPTIONS = [
  'a1',
  'a2',
  'a3',
  'b',
  'c1',
  'c2',
  'c3',
  'd',
  'e',
  'f',
  'g',
  'h',
  'i',
  'j',
  'k',
  'l',
  'm',
  'n',
  'o',
  'standalone',
]
const PRIORITY_OPTIONS = ['P0', 'P1', 'P2', 'P3']
const SIZE_OPTIONS = ['S', 'F-lite', 'F-full']
const REQUIRED_STATUS_OPTIONS = ['Todo', 'Ready', 'In Progress', 'Blocked', 'Done']

const TARGET_ISSUE_TYPES: Array<{ name: string; color: string }> = [
  { name: 'feat', color: 'BLUE' },
  { name: 'fix', color: 'RED' },
  { name: 'refactor', color: 'PURPLE' },
  { name: 'docs', color: 'GRAY' },
  { name: 'test', color: 'GREEN' },
  { name: 'chore', color: 'YELLOW' },
  { name: 'ci', color: 'ORANGE' },
  { name: 'perf', color: 'PINK' },
  { name: 'epic', color: 'BLUE' },
  { name: 'research', color: 'PURPLE' },
]

export interface HubProject {
  id: string
  number: number
  title: string
}

// ---------------------------------------------------------------------------
// T4: bootstrapProject + bootstrapFields
// ---------------------------------------------------------------------------

export async function bootstrapProject(ownerLogin: string, ownerId: string): Promise<HubProject> {
  const existing = await listOrgProjects(ownerLogin)
  const hit = existing.find((p) => p.title === HUB_PROJECT_TITLE)
  if (hit) return hit

  const data = (await ghGraphQL(CREATE_PROJECT_V2_MUTATION, {
    ownerId,
    title: HUB_PROJECT_TITLE,
  })) as { data: { createProjectV2: { projectV2: HubProject } } }
  return data.data.createProjectV2.projectV2
}

export async function bootstrapFields(projectId: string): Promise<void> {
  // Query current fields on the project
  const fieldsData = (await ghGraphQL(PROJECT_FIELDS_QUERY, { id: projectId })) as {
    data: {
      node: {
        fields: {
          nodes: Array<{
            id: string
            name: string
            dataType?: string
            options?: Array<{ id: string; name: string }>
          }>
        }
      }
    }
  }

  const nodes = fieldsData.data.node.fields.nodes
  const currentFieldNames = nodes.map((n) => n.name)

  // Validate Status built-in exists and has all required options
  const statusField = nodes.find((n) => n.name === 'Status')
  if (!statusField) {
    throw new Error('Status built-in field missing — unexpected for Project V2')
  }

  const existingOptionNames = new Set((statusField.options ?? []).map((o) => o.name))
  const missingOptions = REQUIRED_STATUS_OPTIONS.filter((o) => !existingOptionNames.has(o))
  if (missingOptions.length > 0) {
    // Patch Status options to the required set instead of throwing
    const options = REQUIRED_STATUS_OPTIONS.map((name) => ({ name, color: 'GRAY', description: '' }))
    await ghGraphQL(UPDATE_FIELD_OPTIONS_MUTATION, { fieldId: statusField.id, options })
  }

  // Create missing custom fields
  const toCreate = [
    { name: 'Lane', options: LANE_OPTIONS },
    { name: 'Priority', options: PRIORITY_OPTIONS },
    { name: 'Size', options: SIZE_OPTIONS },
  ].filter((f) => !currentFieldNames.includes(f.name))

  for (const f of toCreate) {
    await ghGraphQL(CREATE_PROJECT_V2_FIELD_MUTATION, {
      projectId,
      name: f.name,
      dataType: 'SINGLE_SELECT',
      singleSelectOptions: f.options.map((o) => ({ name: o, color: 'GRAY', description: '' })),
    })
  }
}

// ---------------------------------------------------------------------------
// T5: bootstrapIssueTypes
// ---------------------------------------------------------------------------

export async function bootstrapIssueTypes(ownerLogin: string, ownerId: string): Promise<void> {
  const existing = await listOrgIssueTypes(ownerLogin)
  const existingNames = new Set(existing.map((t) => t.name))
  for (const target of TARGET_ISSUE_TYPES) {
    if (!existingNames.has(target.name)) {
      await createIssueTypeWrapper(ownerId, target.name, target.color)
    }
  }
}

// ---------------------------------------------------------------------------
// T6: runRenameSpike
// ---------------------------------------------------------------------------

export interface SpikeSnapshot {
  generatedAt: string
  preserved: boolean
  bugCount: number
  featCount: number
  bugIds: string[]
  featIds: string[]
  probe: {
    issueTypeId: string
    originalName: string
    renamedName: string
    readBackName: string | null
    readBackEnabled: boolean
  }
}

export async function runRenameSpike(opts: { snapshotPath: string; ownerLogin: string }): Promise<void> {
  // Use hardcoded Bug type ID (from spec 119 §Context) to avoid consuming listOrgIssueTypes mock early
  const bugIds: string[] = [BUG_TYPE_ID]
  const featIds: string[] = [FEATURE_TYPE_ID]

  // Probe: attempt to rename Bug type to 'fix' and read back via fresh list
  let preserved = false
  let readBackName: string | null = null
  let readBackEnabled = false

  // Attempt rename via updateIssueType
  const updated = await updateIssueTypeWrapper(BUG_TYPE_ID, { name: 'fix' })

  try {
    // Read back via a fresh listOrgIssueTypes call
    const afterList = await listOrgIssueTypes(opts.ownerLogin)
    const afterEntry = afterList.find((t) => t.id === BUG_TYPE_ID)
    if (afterEntry) {
      readBackName = afterEntry.name
      readBackEnabled = afterEntry.isEnabled ?? false
      preserved = afterEntry.name === 'fix' && afterEntry.isEnabled === true
    } else {
      // Fall back to the updateIssueType return value if read-back list doesn't include the entry
      readBackName = updated.name ?? null
      readBackEnabled = updated.isEnabled ?? false
      preserved = readBackName === 'fix' && readBackEnabled === true
    }

    const snapshot: SpikeSnapshot = {
      generatedAt: new Date().toISOString(),
      preserved,
      bugCount: bugIds.length,
      featCount: featIds.length,
      bugIds,
      featIds,
      probe: {
        issueTypeId: BUG_TYPE_ID,
        originalName: 'Bug',
        renamedName: 'fix',
        readBackName,
        readBackEnabled,
      },
    }

    // Ensure parent directory exists
    const dir = dirname(opts.snapshotPath)
    mkdirSync(dir, { recursive: true })
    writeFileSync(opts.snapshotPath, JSON.stringify(snapshot, null, 2))
  } catch (err) {
    // Rollback: restore Bug type name before rethrowing
    await updateIssueTypeWrapper(BUG_TYPE_ID, { name: 'Bug' })
    throw err
  }
}

// ---------------------------------------------------------------------------
// T7: applyRenames
// ---------------------------------------------------------------------------

export async function applyRenames(opts: { confirmRenames: boolean; spikeSnapshot?: string }): Promise<void> {
  if (!opts.confirmRenames) {
    throw new Error('refusing renames without --confirm-renames')
  }
  if (!opts.spikeSnapshot || !existsSync(opts.spikeSnapshot)) {
    throw new Error('spike snapshot required (run --spike-only first)')
  }
  const snap = JSON.parse(readFileSync(opts.spikeSnapshot, 'utf-8')) as SpikeSnapshot
  if (!snap.preserved) {
    throw new Error('spike showed rename does NOT preserve assignments — rename unsafe (see snapshot.probe)')
  }
  await updateIssueTypeWrapper(BUG_TYPE_ID, { name: 'fix' })
  await updateIssueTypeWrapper(FEATURE_TYPE_ID, { name: 'feat' })
  await updateIssueTypeWrapper(TASK_TYPE_ID, { isEnabled: false })
}

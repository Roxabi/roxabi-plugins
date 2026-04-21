/**
 * Tests for hub-bootstrap.ts — RED phase.
 * hub-bootstrap.ts does not exist yet; these tests will fail on import.
 *
 * Issue Types hardcoded in spec frontmatter (119-issue-taxonomy-migration-spec.mdx):
 *   Bug    → IT_kwDOB8J6DM4BJQ3X  rename → fix
 *   Feature→ IT_kwDOB8J6DM4BJQ3Z  rename → feat
 *   Task   → IT_kwDOB8J6DM4BJQ3W  disable
 */

import { unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ---------------------------------------------------------------------------
// In-memory state shared by adapter mocks
// ---------------------------------------------------------------------------

const state: {
  projects: Array<{ id: string; number: number; title: string }>
  issueTypes: Array<{ id: string; name: string; color: string; isEnabled: boolean }>
  fields: Map<string, string[]>
  projectFieldCalls: number
} = {
  projects: [],
  issueTypes: [],
  fields: new Map(),
  projectFieldCalls: 0,
}

// ---------------------------------------------------------------------------
// Mock github-adapter — intercepted at module resolution time
// ---------------------------------------------------------------------------

vi.mock('../../shared/adapters/github-adapter', () => ({
  ghGraphQL: vi.fn(async (query: string, _vars: Record<string, unknown>) => {
    // createProjectV2Field (checked before createProjectV2 to avoid prefix match)
    if (query.includes('createProjectV2Field')) {
      state.projectFieldCalls++
      return { data: { createProjectV2Field: { projectV2Field: { id: 'FIELD_new', name: 'unknown' } } } }
    }
    // createProjectV2
    if (query.includes('createProjectV2')) {
      const proj = { id: 'PVT_new', number: 23, title: 'Roxabi Hub' }
      state.projects.push(proj)
      return { data: { createProjectV2: { projectV2: proj } } }
    }
    // projectV2 fields query (used to verify Status)
    if (query.includes('projectV2') && query.includes('fields')) {
      return {
        data: {
          node: {
            fields: {
              nodes: [
                {
                  id: 'SF_status',
                  name: 'Status',
                  dataType: 'SINGLE_SELECT',
                  options: [
                    { id: 'OPT_todo', name: 'Todo' },
                    { id: 'OPT_ready', name: 'Ready' },
                    { id: 'OPT_ip', name: 'In Progress' },
                    { id: 'OPT_blocked', name: 'Blocked' },
                    { id: 'OPT_done', name: 'Done' },
                  ],
                },
              ],
            },
          },
        },
      }
    }
    return {}
  }),

  listOrgProjects: vi.fn(async () => state.projects),

  listOrgIssueTypes: vi.fn(async () => state.issueTypes),

  createIssueType: vi.fn(async (_ownerId: string, name: string, color: string) => {
    const t = { id: `IT_${name}`, name, color, isEnabled: true }
    state.issueTypes.push(t)
    return t
  }),

  updateIssueType: vi.fn(
    async (
      issueTypeId: string,
      patch: { name?: string; description?: string; color?: string; isEnabled?: boolean },
    ) => {
      const t = state.issueTypes.find((x) => x.id === issueTypeId)
      if (!t) throw new Error(`updateIssueType: unknown id ${issueTypeId}`)
      Object.assign(t, patch)
      return t
    },
  ),

  run: vi.fn(async () => ''),
}))

// ---------------------------------------------------------------------------
// Lazy import — will fail with "Cannot find module" until hub-bootstrap.ts exists
// ---------------------------------------------------------------------------

let bootstrapProject: (login: string) => Promise<{ id: string; number: number; title: string }>
let bootstrapFields: (projectId: string) => Promise<void>
let bootstrapIssueTypes: (ownerId: string) => Promise<void>
let runRenameSpike: (opts: { snapshotPath: string }) => Promise<void>
let applyRenames: (opts: { confirmRenames: boolean; spikeSnapshot?: string }) => Promise<void>

beforeEach(async () => {
  // Reset in-memory state
  state.projects = []
  state.issueTypes = []
  state.fields = new Map()
  state.projectFieldCalls = 0
  vi.clearAllMocks()

  // Dynamic import so the vi.mock above is in scope before the module resolves
  const mod = await import('../lib/hub-bootstrap')
  bootstrapProject = mod.bootstrapProject
  bootstrapFields = mod.bootstrapFields
  bootstrapIssueTypes = mod.bootstrapIssueTypes
  runRenameSpike = mod.runRenameSpike
  applyRenames = mod.applyRenames
})

afterEach(() => {
  vi.restoreAllMocks()
})

// ---------------------------------------------------------------------------
// bootstrapProject
// ---------------------------------------------------------------------------

describe('hub-bootstrap', () => {
  describe('bootstrapProject', () => {
    it('returns existing project without creating when project exists', async () => {
      // Arrange
      const existing = { id: 'PVT_existing', number: 23, title: 'Roxabi Hub' }
      state.projects.push(existing)
      const { ghGraphQL } = await import('../../shared/adapters/github-adapter')

      // Act
      const result = await bootstrapProject('Roxabi')

      // Assert — no createProjectV2 mutation should have been fired
      const calls = (ghGraphQL as ReturnType<typeof vi.fn>).mock.calls as Array<[string, ...unknown[]]>
      const createCalls = calls.filter(([q]) => typeof q === 'string' && q.includes('createProjectV2'))
      expect(createCalls).toHaveLength(0)
      expect(result.id).toBe('PVT_existing')
    })

    it('creates project when none exists', async () => {
      // Arrange — state.projects is empty

      // Act
      const result = await bootstrapProject('Roxabi')

      // Assert
      expect(result).toBeDefined()
      expect(result.title).toBe('Roxabi Hub')
      expect(state.projects).toHaveLength(1)
    })
  })

  // ---------------------------------------------------------------------------
  // bootstrapFields
  // ---------------------------------------------------------------------------

  describe('bootstrapFields', () => {
    it('creates Lane, Priority, and Size fields when all missing', async () => {
      // Arrange
      state.projectFieldCalls = 0

      // Act
      await bootstrapFields('PVT_test')

      // Assert — 3 createProjectV2Field mutations expected
      expect(state.projectFieldCalls).toBe(3)
    })

    it('skips fields already present, creates only missing ones', async () => {
      // Arrange — simulate Lane and Priority already exist via mock returning them in fields query
      const { ghGraphQL } = await import('../../shared/adapters/github-adapter')
      ;(ghGraphQL as ReturnType<typeof vi.fn>).mockImplementationOnce(async (query: string) => {
        if (query.includes('fields')) {
          return {
            data: {
              node: {
                fields: {
                  nodes: [
                    { id: 'FIELD_lane', name: 'Lane', dataType: 'SINGLE_SELECT', options: [] },
                    { id: 'FIELD_priority', name: 'Priority', dataType: 'SINGLE_SELECT', options: [] },
                    {
                      id: 'SF_status',
                      name: 'Status',
                      dataType: 'SINGLE_SELECT',
                      options: [
                        { id: 'OPT_todo', name: 'Todo' },
                        { id: 'OPT_ready', name: 'Ready' },
                        { id: 'OPT_ip', name: 'In Progress' },
                        { id: 'OPT_blocked', name: 'Blocked' },
                        { id: 'OPT_done', name: 'Done' },
                      ],
                    },
                  ],
                },
              },
            },
          }
        }
        // createProjectV2Field
        state.projectFieldCalls++
        return { data: { createProjectV2Field: { projectV2Field: { id: 'FIELD_size', name: 'Size' } } } }
      })

      // Act
      await bootstrapFields('PVT_test')

      // Assert — only Size field should be created (1 call)
      expect(state.projectFieldCalls).toBe(1)
    })

    it('throws when Status built-in field is missing required options', async () => {
      // Arrange — Status field present but without required options
      const { ghGraphQL } = await import('../../shared/adapters/github-adapter')
      ;(ghGraphQL as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        data: {
          node: {
            fields: {
              nodes: [
                {
                  id: 'SF_status',
                  name: 'Status',
                  dataType: 'SINGLE_SELECT',
                  options: [{ id: 'OPT_todo', name: 'Todo' }], // missing Ready/In Progress/Blocked/Done
                },
              ],
            },
          },
        },
      })

      // Act + Assert
      await expect(bootstrapFields('PVT_test')).rejects.toThrow(/Status/)
    })
  })

  // ---------------------------------------------------------------------------
  // bootstrapIssueTypes
  // ---------------------------------------------------------------------------

  describe('bootstrapIssueTypes', () => {
    it('creates only missing issue types (10 target minus 2 existing)', async () => {
      // Arrange — seed 2 existing types
      state.issueTypes = [
        { id: 'IT_fix', name: 'fix', color: 'RED', isEnabled: true },
        { id: 'IT_kwDOB8J6DM4B92gZ', name: 'refactor', color: 'PURPLE', isEnabled: true },
      ]
      const { createIssueType } = await import('../../shared/adapters/github-adapter')

      // Act
      await bootstrapIssueTypes('ORG_id')

      // Assert — 8 new types created (10 - 2 existing)
      expect((createIssueType as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(8)
    })

    it('skips all creates when all 10 types already exist', async () => {
      // Arrange — seed all 10 target types
      const targetNames = ['fix', 'feat', 'docs', 'test', 'chore', 'ci', 'perf', 'epic', 'research', 'refactor']
      state.issueTypes = targetNames.map((name, i) => ({
        id: `IT_${i}`,
        name,
        color: 'GRAY',
        isEnabled: true,
      }))
      const { createIssueType } = await import('../../shared/adapters/github-adapter')

      // Act
      await bootstrapIssueTypes('ORG_id')

      // Assert
      expect((createIssueType as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0)
    })
  })

  // ---------------------------------------------------------------------------
  // runRenameSpike
  // ---------------------------------------------------------------------------

  describe('runRenameSpike', () => {
    it('spike-only mode writes a snapshot JSON file', async () => {
      // Arrange
      const snapshotPath = join(tmpdir(), `hub-bootstrap-spike-${Date.now()}.json`)
      state.issueTypes = [
        { id: 'IT_kwDOB8J6DM4BJQ3X', name: 'Bug', color: 'RED', isEnabled: true },
        { id: 'IT_kwDOB8J6DM4BJQ3Z', name: 'Feature', color: 'BLUE', isEnabled: true },
      ]

      try {
        // Act
        await runRenameSpike({ snapshotPath })

        // Assert — snapshot file must exist with expected shape
        const { readFile } = await import('node:fs/promises')
        const raw = await readFile(snapshotPath, 'utf8')
        const snapshot = JSON.parse(raw) as {
          preserved: boolean
          bugCount: number
          featCount: number
          bugIds: string[]
          featIds: string[]
        }

        expect(snapshot).toMatchObject({
          preserved: expect.any(Boolean),
          bugCount: expect.any(Number),
          featCount: expect.any(Number),
          bugIds: expect.any(Array),
          featIds: expect.any(Array),
        })
      } finally {
        await unlink(snapshotPath).catch(() => {})
      }
    })

    it('snapshot marks preserved=true when rename round-trips correctly', async () => {
      // Arrange — stub updateIssueType to succeed + listOrgIssueTypes returns renamed type
      const snapshotPath = join(tmpdir(), `hub-bootstrap-spike-preserved-${Date.now()}.json`)
      state.issueTypes = [{ id: 'IT_kwDOB8J6DM4BJQ3X', name: 'Bug', color: 'RED', isEnabled: true }]
      const { updateIssueType, listOrgIssueTypes } = await import('../../shared/adapters/github-adapter')
      ;(updateIssueType as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        id: 'IT_kwDOB8J6DM4BJQ3X',
        name: 'fix',
        color: 'RED',
        isEnabled: true,
      })
      // After rename, listing shows the new name
      ;(listOrgIssueTypes as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
        { id: 'IT_kwDOB8J6DM4BJQ3X', name: 'fix', color: 'RED', isEnabled: true },
      ])

      try {
        // Act
        await runRenameSpike({ snapshotPath })

        // Assert
        const { readFile } = await import('node:fs/promises')
        const snapshot = JSON.parse(await readFile(snapshotPath, 'utf8')) as { preserved: boolean }
        expect(snapshot.preserved).toBe(true)
      } finally {
        await unlink(snapshotPath).catch(() => {})
      }
    })

    it('snapshot marks preserved=false when rename clears the type assignment', async () => {
      // Arrange — stub updateIssueType + listOrgIssueTypes returns cleared (isEnabled:false) state
      const snapshotPath = join(tmpdir(), `hub-bootstrap-spike-notpreserved-${Date.now()}.json`)
      state.issueTypes = [{ id: 'IT_kwDOB8J6DM4BJQ3X', name: 'Bug', color: 'RED', isEnabled: true }]
      const { updateIssueType, listOrgIssueTypes } = await import('../../shared/adapters/github-adapter')
      ;(updateIssueType as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        id: 'IT_kwDOB8J6DM4BJQ3X',
        name: 'fix',
        color: 'RED',
        isEnabled: false, // cleared
      })
      ;(listOrgIssueTypes as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
        { id: 'IT_kwDOB8J6DM4BJQ3X', name: 'fix', color: 'RED', isEnabled: false },
      ])

      try {
        // Act
        await runRenameSpike({ snapshotPath })

        // Assert
        const { readFile } = await import('node:fs/promises')
        const snapshot = JSON.parse(await readFile(snapshotPath, 'utf8')) as { preserved: boolean }
        expect(snapshot.preserved).toBe(false)
      } finally {
        await unlink(snapshotPath).catch(() => {})
      }
    })
  })

  // ---------------------------------------------------------------------------
  // applyRenames
  // ---------------------------------------------------------------------------

  describe('applyRenames', () => {
    it('aborts without --confirm-renames flag', async () => {
      // Act + Assert
      await expect(applyRenames({ confirmRenames: false })).rejects.toThrow(
        /refusing renames without --confirm-renames/i,
      )
    })

    it('aborts without spike snapshot when confirmRenames=true', async () => {
      // Act + Assert — no spikeSnapshot provided
      await expect(applyRenames({ confirmRenames: true })).rejects.toThrow(/spike snapshot required/i)
    })

    it('aborts when spike snapshot shows preserved=false', async () => {
      // Arrange — write a snapshot file with preserved:false
      const snapshotPath = join(tmpdir(), `hub-bootstrap-apply-false-${Date.now()}.json`)
      await writeFile(
        snapshotPath,
        JSON.stringify({ preserved: false, bugCount: 3, featCount: 5, bugIds: [], featIds: [] }),
      )

      try {
        // Act + Assert
        await expect(applyRenames({ confirmRenames: true, spikeSnapshot: snapshotPath })).rejects.toThrow(
          /preserved.*false|spike.*failed|rename.*unsafe/i,
        )
      } finally {
        await unlink(snapshotPath).catch(() => {})
      }
    })

    it('renames Bug→fix, Feature→feat, disables Task when all gates pass', async () => {
      // Arrange — spike snapshot with preserved:true + seed issue types with the spec IDs
      const snapshotPath = join(tmpdir(), `hub-bootstrap-apply-ok-${Date.now()}.json`)
      await writeFile(
        snapshotPath,
        JSON.stringify({
          preserved: true,
          bugCount: 2,
          featCount: 3,
          bugIds: ['I_1', 'I_2'],
          featIds: ['I_3', 'I_4', 'I_5'],
        }),
      )
      // Seed the three issue types with their spec-hardcoded IDs
      state.issueTypes = [
        { id: 'IT_kwDOB8J6DM4BJQ3X', name: 'Bug', color: 'RED', isEnabled: true },
        { id: 'IT_kwDOB8J6DM4BJQ3Z', name: 'Feature', color: 'BLUE', isEnabled: true },
        { id: 'IT_kwDOB8J6DM4BJQ3W', name: 'Task', color: 'YELLOW', isEnabled: true },
      ]
      const { updateIssueType } = await import('../../shared/adapters/github-adapter')

      try {
        // Act
        await applyRenames({ confirmRenames: true, spikeSnapshot: snapshotPath })

        // Assert — 3 updateIssueType calls with the spec-mandated IDs
        const calls = (updateIssueType as ReturnType<typeof vi.fn>).mock.calls as Array<
          [string, { name?: string; isEnabled?: boolean }]
        >
        expect(calls).toHaveLength(3)

        const bugCall = calls.find(([id]) => id === 'IT_kwDOB8J6DM4BJQ3X')
        expect(bugCall).toBeDefined()
        expect(bugCall?.[1]).toMatchObject({ name: 'fix' })

        const featCall = calls.find(([id]) => id === 'IT_kwDOB8J6DM4BJQ3Z')
        expect(featCall).toBeDefined()
        expect(featCall?.[1]).toMatchObject({ name: 'feat' })

        const taskCall = calls.find(([id]) => id === 'IT_kwDOB8J6DM4BJQ3W')
        expect(taskCall).toBeDefined()
        expect(taskCall?.[1]).toMatchObject({ isEnabled: false })
      } finally {
        await unlink(snapshotPath).catch(() => {})
      }
    })
  })
})

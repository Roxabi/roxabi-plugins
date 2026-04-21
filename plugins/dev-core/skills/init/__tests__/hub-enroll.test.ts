/**
 * Tests for hub-enroll.ts — RED phase.
 * hub-enroll.ts does not exist yet; these tests will fail on import.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// ---------------------------------------------------------------------------
// In-memory state shared by adapter mocks
// ---------------------------------------------------------------------------

const state: {
  issueTypes: Array<{ id: string; name: string; color: string; isEnabled: boolean }>
  milestonesMissing: string[]
  testIssueInHub: boolean
} = {
  issueTypes: [],
  milestonesMissing: [],
  testIssueInHub: true,
}

// All 10 required issue type names
const ALL_TEN_ISSUE_TYPES = ['fix', 'feat', 'docs', 'test', 'chore', 'ci', 'perf', 'epic', 'research', 'refactor']

// ---------------------------------------------------------------------------
// Mock github-adapter — intercepted at module resolution time
// ---------------------------------------------------------------------------

vi.mock('../../shared/adapters/github-adapter', () => ({
  ghGraphQL: vi.fn(async (query: string, _vars: Record<string, unknown>) => {
    // milestone query
    if (query.includes('milestone')) {
      const ALL_MILESTONES = ['M0', 'M1', 'M2']
      return {
        data: {
          repository: {
            milestones: {
              nodes: ALL_MILESTONES.filter((n) => !state.milestonesMissing.includes(n)).map((n, i) => ({
                id: `ML_${i}`,
                title: n,
              })),
            },
          },
        },
      }
    }
    // projectV2 verify test issue
    if (query.includes('projectV2')) {
      return {
        data: {
          node: {
            items: {
              nodes: state.testIssueInHub ? [{ id: 'PVTI_test' }] : [],
            },
          },
        },
      }
    }
    return {}
  }),

  listOrgIssueTypes: vi.fn(async () => state.issueTypes),

  run: vi.fn(async () => ''),
}))

// ---------------------------------------------------------------------------
// Mock workflows — generateAutoAddToProjectYml + pushWorkflow
// ---------------------------------------------------------------------------

const pushWorkflowMock = vi.fn(async () => ({ file: 'auto-add-to-project.yml', status: 'created' as const }))

vi.mock('../lib/workflows', () => ({
  generateAutoAddToProjectYml: vi.fn(() => 'stub-auto-add-yml-content'),
  pushWorkflow: pushWorkflowMock,
}))

// ---------------------------------------------------------------------------
// Lazy import — will fail with "Cannot find module" until hub-enroll.ts exists
// ---------------------------------------------------------------------------

let enrollRepo: (opts: {
  org: string
  repo: string
  projectUrl: string
  dryRun?: boolean
}) => Promise<{ enrolled: boolean; milestonesMissing: string[]; verified: boolean; dryRun?: boolean }>

beforeAll(async () => {
  const mod = await import('../lib/hub-enroll')
  enrollRepo = mod.enrollRepo
})

beforeEach(() => {
  // Reset in-memory state
  state.issueTypes = ALL_TEN_ISSUE_TYPES.map((name, i) => ({
    id: `IT_${i}`,
    name,
    color: 'GRAY',
    isEnabled: true,
  }))
  state.milestonesMissing = []
  state.testIssueInHub = true
  vi.clearAllMocks()
})

afterEach(() => {
  vi.restoreAllMocks()
})

// ---------------------------------------------------------------------------
// enrollRepo
// ---------------------------------------------------------------------------

describe('hub-enroll', () => {
  describe('enrollRepo', () => {
    it('verifies all 10 Issue Types exist before enrolling', async () => {
      // Arrange — seed state.issueTypes with 9 types (missing one)
      state.issueTypes = ALL_TEN_ISSUE_TYPES.slice(0, 9).map((name, i) => ({
        id: `IT_${i}`,
        name,
        color: 'GRAY',
        isEnabled: true,
      }))

      // Act + Assert — expect enrollRepo to throw because one issue type is missing
      await expect(
        enrollRepo({
          org: 'Roxabi',
          repo: 'test-repo',
          projectUrl: 'https://github.com/orgs/Roxabi/projects/42',
        }),
      ).rejects.toThrow(/issue type|missing/i)
    })

    it('pushes auto-add workflow to the repo (idempotent)', async () => {
      // Arrange — all 10 types present (set by beforeEach)

      // Act
      await enrollRepo({
        org: 'Roxabi',
        repo: 'test-repo',
        projectUrl: 'https://github.com/orgs/Roxabi/projects/42',
      })

      // Assert — pushWorkflow called once
      expect(pushWorkflowMock).toHaveBeenCalledTimes(1)

      // Act again (idempotent: same content, overwriting OK)
      await enrollRepo({
        org: 'Roxabi',
        repo: 'test-repo',
        projectUrl: 'https://github.com/orgs/Roxabi/projects/42',
      })

      // Assert — called once more (total 2) — content unchanged is acceptable
      expect(pushWorkflowMock).toHaveBeenCalledTimes(2)
    })

    it('warns when milestones M0/M1/M2 missing — emits no mutation', async () => {
      // Arrange — two milestones missing
      state.milestonesMissing = ['M1', 'M2']
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

      // Act
      const result = await enrollRepo({
        org: 'Roxabi',
        repo: 'test-repo',
        projectUrl: 'https://github.com/orgs/Roxabi/projects/42',
      })

      // Assert — warn called with milestones-sync hint
      expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/milestones missing.*M1.*M2.*milestones-sync/is))

      // Assert — no createMilestone mutation (listOrgIssueTypes only, no mutation fn called)
      // The adapter mock has no createMilestone — absence of that call = no mutation
      expect(result.milestonesMissing).toEqual(['M1', 'M2'])
    })

    it('returns enrolled:true, verified:true on happy path', async () => {
      // Arrange — all types present, workflow pushes, testIssueInHub=true (set by beforeEach)

      // Act
      const result = await enrollRepo({
        org: 'Roxabi',
        repo: 'test-repo',
        projectUrl: 'https://github.com/orgs/Roxabi/projects/42',
      })

      // Assert
      expect(result).toMatchObject({
        enrolled: true,
        milestonesMissing: [],
        verified: true,
      })
    })

    it('dry-run emits planned actions without executing', async () => {
      // Arrange — dryRun flag

      // Act
      const result = await enrollRepo({
        org: 'Roxabi',
        repo: 'test-repo',
        projectUrl: 'https://github.com/orgs/Roxabi/projects/42',
        dryRun: true,
      })

      // Assert — no pushWorkflow call
      expect(pushWorkflowMock).not.toHaveBeenCalled()

      // Assert — result signals dry-run mode
      expect(result.dryRun).toBe(true)
    })
  })
})

/**
 * Tests for hub-enroll.ts — RED phase.
 * hub-enroll.ts does not exist yet; these tests will fail on import.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { MILESTONE_QUERY, REPO_DEFAULT_BRANCH_QUERY, VERIFY_PROJECT_ITEMS_QUERY } from '../../shared/queries'

// ---------------------------------------------------------------------------
// In-memory state shared by adapter mocks
// ---------------------------------------------------------------------------

const state: {
  issueTypes: Array<{ id: string; name: string; color: string; isEnabled: boolean }>
  milestonesMissing: string[]
  testIssueInHub: boolean
  defaultBranch: string | null
  repositoryNull: boolean
} = {
  issueTypes: [],
  milestonesMissing: [],
  testIssueInHub: true,
  defaultBranch: 'staging',
  repositoryNull: false,
}

// All 10 required issue type names
const ALL_TEN_ISSUE_TYPES = ['fix', 'feat', 'docs', 'test', 'chore', 'ci', 'perf', 'epic', 'research', 'refactor']

// ---------------------------------------------------------------------------
// Mock github-adapter — intercepted at module resolution time
// ---------------------------------------------------------------------------

// Mock routing: exact-match on imported query constants.
// If a query doesn't match, throw explicit error (no silent {} fallback).
// This makes query refactors immediately visible in test output.
vi.mock('../../shared/adapters/github-adapter', () => ({
  ghGraphQL: vi.fn(async (query: string, _vars: Record<string, unknown>) => {
    // default branch query
    if (query === REPO_DEFAULT_BRANCH_QUERY) {
      return {
        data: {
          repository: state.repositoryNull
            ? null
            : state.defaultBranch
              ? { defaultBranchRef: { name: state.defaultBranch } }
              : { defaultBranchRef: null },
        },
      }
    }
    // milestone query
    if (query === MILESTONE_QUERY) {
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
    if (query === VERIFY_PROJECT_ITEMS_QUERY) {
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
    throw new Error(`Unexpected GraphQL query: ${query.slice(0, 50)}...`)
  }),

  listOrgIssueTypes: vi.fn(async () => state.issueTypes),

  run: vi.fn(async () => ''),
}))

// ---------------------------------------------------------------------------
// Mock workflows — generateAutoAddToProjectYml + pushWorkflow
// ---------------------------------------------------------------------------

const pushWorkflowMock = vi.fn(async () => 'created' as const)

vi.mock('../lib/workflows', () => ({
  generateAutoAddToProjectYml: vi.fn(() => 'stub-auto-add-yml-content'),
  pushWorkflowFile: pushWorkflowMock,
}))

// ---------------------------------------------------------------------------
// Lazy import — will fail with "Cannot find module" until hub-enroll.ts exists
// ---------------------------------------------------------------------------

let enrollRepo: (opts: {
  org: string
  repo: string
  projectUrl: string
  projectId: string
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
  state.defaultBranch = 'staging'
  state.repositoryNull = false
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
          projectId: 'PVT_test42',
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
        projectId: 'PVT_test42',
      })

      // Assert — pushWorkflow called once
      expect(pushWorkflowMock).toHaveBeenCalledTimes(1)

      // Act again (idempotent: same content, overwriting OK)
      await enrollRepo({
        org: 'Roxabi',
        repo: 'test-repo',
        projectUrl: 'https://github.com/orgs/Roxabi/projects/42',
        projectId: 'PVT_test42',
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
        projectId: 'PVT_test42',
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
        projectId: 'PVT_test42',
      })

      // Assert
      expect(result).toMatchObject({
        enrolled: true,
        milestonesMissing: [],
        verified: true,
      })
    })

    it("pushes the workflow to the repo's detected default branch (not hardcoded 'main')", async () => {
      // Act
      await enrollRepo({
        org: 'Roxabi',
        repo: 'test-repo',
        projectUrl: 'https://github.com/orgs/Roxabi/projects/42',
        projectId: 'PVT_test42',
      })

      // Assert — pushWorkflowFile called with branch: 'staging'
      expect(pushWorkflowMock).toHaveBeenCalledWith(
        'Roxabi',
        'test-repo',
        '.github/workflows/hub-add.yml',
        expect.any(String),
        expect.objectContaining({ branch: 'staging' }),
      )
    })

    it('threads non-standard default branches (e.g. trunk) through to pushWorkflowFile', async () => {
      state.defaultBranch = 'trunk'

      await enrollRepo({
        org: 'Roxabi',
        repo: 'weird-repo',
        projectUrl: 'https://github.com/orgs/Roxabi/projects/42',
        projectId: 'PVT_test42',
      })

      expect(pushWorkflowMock).toHaveBeenCalledWith(
        'Roxabi',
        'weird-repo',
        '.github/workflows/hub-add.yml',
        expect.any(String),
        expect.objectContaining({ branch: 'trunk' }),
      )
    })

    it('throws when default branch cannot be resolved', async () => {
      state.defaultBranch = null

      await expect(
        enrollRepo({
          org: 'Roxabi',
          repo: 'ghost-repo',
          projectUrl: 'https://github.com/orgs/Roxabi/projects/42',
          projectId: 'PVT_test42',
        }),
      ).rejects.toThrow(/default branch/i)

      expect(pushWorkflowMock).not.toHaveBeenCalled()
    })

    it('throws when repository is null (wrong org / missing repo)', async () => {
      state.repositoryNull = true

      await expect(
        enrollRepo({
          org: 'Roxabi',
          repo: 'nonexistent-repo',
          projectUrl: 'https://github.com/orgs/Roxabi/projects/42',
          projectId: 'PVT_test42',
        }),
      ).rejects.toThrow(/default branch/i)

      expect(pushWorkflowMock).not.toHaveBeenCalled()
    })

    it('dry-run emits planned actions without executing', async () => {
      // Arrange — dryRun flag

      // Act
      const result = await enrollRepo({
        org: 'Roxabi',
        repo: 'test-repo',
        projectUrl: 'https://github.com/orgs/Roxabi/projects/42',
        projectId: 'PVT_test42',
        dryRun: true,
      })

      // Assert — no pushWorkflow call
      expect(pushWorkflowMock).not.toHaveBeenCalled()

      // Assert — result signals dry-run mode
      expect(result.dryRun).toBe(true)
    })

    it('throws on unexpected GraphQL query', async () => {
      const { ghGraphQL } = await import('../../shared/adapters/github-adapter')
      await expect(ghGraphQL('bad query', {})).rejects.toThrow(/Unexpected GraphQL query/)
    })
  })
})

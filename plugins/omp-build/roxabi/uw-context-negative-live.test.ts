import { expect, test } from 'vitest'
import { failedCheckEvidenceDigest } from '../engine/record-digests.ts'
import type { UwActionRequest } from './uw-action-contract.ts'
import { validateExpandedWorkflowLive } from './uw-context-negative-live.ts'
import type { NonPlanExpansion } from './uw-context-negative-workflow.ts'

test('refuses expanded CI attribution when native failed-check identity changes', async () => {
  const candidateGitSHA = 'a'.repeat(40)
  const scope = { repository: 'acme/app', target: 'acme/app#42' }
  const failures = [
    { name: 'test', source: 'github-check-run' as const, observationId: 'old-id', conclusion: 'failure' },
  ]
  const evidenceDigest = failedCheckEvidenceDigest({ candidateGitSHA, scope, failures })
  if (evidenceDigest === null) throw new Error('expected valid CI identity')
  const origin = {
    slot: {
      action: 'attribute-ci',
      exact: { candidateGitSHA, scope, failedChecks: ['test'], failures, evidenceDigest },
    },
  } as NonPlanExpansion
  const request = { code: { head: candidateGitSHA } } as UwActionRequest
  const result = await validateExpandedWorkflowLive(
    {
      cwd: '/fixture',
      gh: async () =>
        JSON.stringify({
          data: {
            repository: {
              object: {
                statusCheckRollup: {
                  contexts: {
                    pageInfo: { hasNextPage: false, endCursor: null },
                    nodes: [
                      {
                        __typename: 'CheckRun',
                        id: 'new-id',
                        name: 'test',
                        status: 'completed',
                        conclusion: 'failure',
                      },
                    ],
                  },
                },
              },
            },
          },
        }),
    },
    request,
    origin,
  )
  expect(result.ok).toBe(false)
  if (!result.ok) expect(result.diagnostics[0]?.code).toBe('review-input-changed')
})

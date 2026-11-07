import { expect, it } from 'vitest'
import { reconstructWorkflow } from '../../engine/workflow-reconstruction-admission.ts'
import { observeFixtureNativeWorld } from '../action-input-fixtures.ts'
import { nativeImplementationGit } from '../native-implementation-git.ts'
import { roxabiWorkflowFixtures } from '../roxabi-presets.ts'
import { nativeDecisionBody, nativeDecisionMandate } from './support/native-decision-spec.ts'
import {
  decisions,
  eligiblePlan,
  PR,
  SCOPE,
  shippedFacts,
  shippedMandate,
} from './support/workflow-decision-fixtures.ts'

it('does not replay a rejected implementation when a bound pull request exists', async () => {
  const git = nativeImplementationGit(42)
  try {
    const mandate = nativeDecisionMandate(shippedMandate())
    if (mandate.kind !== 'mandate') throw new Error('expected a mandate')
    const codeRange = { repository: SCOPE.repository, base: git.p0, head: git.p0, referenceCommit: git.p0 }
    const workflow = roxabiWorkflowFixtures(undefined, undefined, undefined, codeRange)
    const seed = workflow.historyFrom([mandate])
    const issue = workflow.historyFrom([
      ...eligiblePlan(mandate, [seed], undefined, undefined, codeRange),
      workflow.implementStart(mandate),
      workflow.rejectedImplementResult(mandate),
    ])
    const pullRequest = workflow.historyFrom(
      [workflow.workflowBinding(PR, mandate, 'feat/42-save', 'main')],
      'operator',
      'operator',
      [issue],
    )
    const causal = await observeFixtureNativeWorld({
      root: SCOPE,
      nodes: [
        {
          scope: SCOPE,
          title: 'Save the selected region',
          body: nativeDecisionBody,
          updatedAt: '2026-10-21T12:00:00Z',
          labels: ['size:S'],
          parent: null,
          children: [],
          blockers: [],
          state: 'OPEN',
          stateReason: null,
        },
      ],
      histories: [issue, pullRequest],
      pullRequests: [
        {
          scope: PR,
          branch: 'feat/42-save',
          base: 'main',
          head: git.p0,
          baseTip: git.p0,
          state: 'OPEN',
          mergeCommit: null,
          author: 'operator',
        },
      ],
      commits: [{ repository: SCOPE.repository, sha: git.p0, parents: [] }],
      comparisons: [{ repository: SCOPE.repository, base: git.p0, head: git.p0, status: 'identical', commits: [] }],
    })
    const pull = { scope: PR, head: git.p0, base: 'main', associatedIssue: SCOPE }
    const decision = reconstructWorkflow({
      evidence: { issue, pullRequest, parents: [], causal },
      facts: { ...shippedFacts(mandate, pull), candidateGitSHA: git.p0 },
      decisions: decisions(),
    })
    expect(decision).toMatchObject({ status: 'blocked', reason: 'unconfirmed' })
  } finally {
    git.cleanup()
  }
})

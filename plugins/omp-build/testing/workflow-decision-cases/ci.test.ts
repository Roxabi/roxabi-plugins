import { describe, expect, it } from 'vitest'
import { reconstructWorkflow } from '../../engine/workflow-reconstruction-admission.ts'
import { roxabiWorkflowFixtures } from '../roxabi-presets.ts'
import {
  admittedImplement,
  BODY,
  BRANCH,
  blank,
  decisions,
  eligiblePlan,
  factsForMandate,
  graphConfig,
  hasAction,
  PR,
  SCOPE,
  shippedFacts,
  shippedMandate,
} from './support/workflow-decision-fixtures.ts'

const { featureMandate, historyFrom, implementStart, workflowBinding } = roxabiWorkflowFixtures()

describe('workflow CI decisions', () => {
  it('does not lift a review-bound stop after a later green check', () => {
    const mandate = featureMandate(SCOPE, { body: BODY, config: graphConfig('stop') })
    const decision = reconstructWorkflow({
      evidence: { issue: historyFrom([mandate]), pullRequest: null, parents: [] },
      facts: factsForMandate(mandate),
      decisions: decisions('stop', 'green'),
    })
    expect(decision).toMatchObject({ status: 'terminal', reason: 'bound-stop' })
    expect(decision).not.toMatchObject({ status: 'action' })
  })

  it('dispatches publish, a bound first or moved-head review, and land without a duplicate receipt', () => {
    const mandate = shippedMandate()
    if (mandate.kind !== 'mandate') throw new Error('expected a mandate')
    const pull = { scope: PR, head: BRANCH, base: 'main', associatedIssue: SCOPE }
    const issue = historyFrom([...eligiblePlan(mandate), implementStart(mandate), admittedImplement(mandate)])
    const bound = historyFrom([workflowBinding(PR, mandate, 'feat/42-save', 'main')], 'operator', 'operator', [issue])
    const published = { issue, pullRequest: null, parents: [] }
    expect(hasAction(published.issue, 'publish')).toBe(false)
    expect(
      reconstructWorkflow({ evidence: published, facts: shippedFacts(mandate), decisions: decisions() }),
    ).toMatchObject({
      status: 'action',
      action: 'publish',
    })
    const afterPublished = { ...decisions(), publish: { status: 'published' as const, evidence: [] } }
    const barePull = { issue: historyFrom([mandate]), pullRequest: blank(PR), parents: [] }
    const bareDecision = reconstructWorkflow({
      evidence: barePull,
      facts: shippedFacts(mandate, pull),
      decisions: decisions(),
    })
    expect(bareDecision).toMatchObject({ status: 'action', action: 'plan' })
    const review = { issue, pullRequest: bound, parents: [] }
    expect(hasAction(review.issue, 'review')).toBe(false)
    expect(
      reconstructWorkflow({ evidence: review, facts: shippedFacts(mandate, pull), decisions: afterPublished }),
    ).toMatchObject({
      status: 'action',
      action: 'review',
    })
    const movedCandidate = '2222222222222222222222222222222222222222'
    expect(
      reconstructWorkflow({
        evidence: review,
        facts: { ...shippedFacts(mandate, pull), candidateGitSHA: movedCandidate },
        decisions: afterPublished,
      }),
    ).toMatchObject({ status: 'action', action: 'review' })
    expect(hasAction(review.issue, 'land')).toBe(false)
    expect(
      reconstructWorkflow({
        evidence: review,
        facts: shippedFacts(mandate, pull),
        decisions: { ...afterPublished, reviewStep: 'land' },
      }),
    ).toMatchObject({ status: 'action', action: 'land' })
  })
})

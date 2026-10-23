import { describe, expect, it } from 'vitest'
import { actionCompletion } from '../../engine/workflow-action-completion.ts'
import { reconstructWorkflow } from '../../engine/workflow-reconstruction-admission.ts'
import { roxabiWorkflowFixtures } from '../roxabi-presets.ts'
import {
  admittedImplement,
  BODY,
  blank,
  decisions,
  eligiblePlan,
  factsForMandate,
  graphConfig,
  HEAD,
  hasAction,
  openProof,
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

  it('dispatches publish, proof, review, and land from the shipped selectors without a duplicate receipt', () => {
    const mandate = shippedMandate()
    if (mandate.kind !== 'mandate') throw new Error('expected a mandate')
    const pull = { scope: PR, head: HEAD, base: 'main', associatedIssue: SCOPE }
    const issue = historyFrom([...eligiblePlan(mandate), implementStart(mandate), admittedImplement(mandate)])
    const bound = historyFrom([workflowBinding(PR, mandate, 'feat/42-save', 'main')], 'operator', 'operator', [issue])
    const published = { issue, pullRequest: null, parents: [] }
    expect(hasAction(published.issue, 'publish')).toBe(false)
    expect(reconstructWorkflow({ evidence: published, facts: shippedFacts(), decisions: openProof() })).toMatchObject({
      status: 'action',
      action: 'publish',
    })
    const barePull = { issue: historyFrom([mandate]), pullRequest: blank(PR), parents: [] }
    expect(hasAction(barePull.issue, 'proof')).toBe(false)
    const bareDecision = reconstructWorkflow({ evidence: barePull, facts: shippedFacts(pull), decisions: openProof() })
    expect(bareDecision).toMatchObject({ status: 'action', action: 'plan' })
    expect(bareDecision).not.toMatchObject({ action: 'proof' })
    const proof = { issue, pullRequest: bound, parents: [] }
    expect(hasAction(proof.issue, 'proof')).toBe(false)
    expect(reconstructWorkflow({ evidence: proof, facts: shippedFacts(pull), decisions: openProof() })).toMatchObject({
      status: 'action',
      action: 'proof',
    })
    const review = { issue, pullRequest: bound, parents: [] }
    expect(hasAction(review.issue, 'review')).toBe(false)
    expect(
      reconstructWorkflow({
        evidence: review,
        facts: shippedFacts(pull),
        decisions: { ...openProof(), reviewStep: 'review' },
      }),
    ).toMatchObject({ status: 'action', action: 'review' })
    expect(hasAction(review.issue, 'land')).toBe(false)
    expect(
      reconstructWorkflow({
        evidence: review,
        facts: shippedFacts(pull),
        decisions: { ...openProof(), reviewStep: 'land' },
      }),
    ).toMatchObject({ status: 'action', action: 'land' })
  })

  it('advances proof from the native admission selector without a duplicate proof receipt', () => {
    const mandate = featureMandate(SCOPE, { body: BODY })
    if (mandate.kind !== 'mandate') throw new Error('expected a mandate')
    const evidence = { issue: historyFrom([mandate]), pullRequest: blank(PR), parents: [] }
    const completion = actionCompletion(
      'proof',
      evidence,
      {
        ...decisions(),
        proof: {
          admission: { ok: true, candidateGitSHA: HEAD, input: 'candidate-input', recordIds: ['proof-1'] },
          candidateGitSHA: HEAD,
          input: 'candidate-input',
          applicability: 'required',
          evidence: [],
        },
      },
      mandate,
    )
    expect(completion.status).toBe('confirmed')
    expect(evidence.issue.operations.some((operation) => operation.kind === 'proof')).toBe(false)
  })
})

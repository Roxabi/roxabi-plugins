import type { ScopedRecordRef } from '../engine/record-references.ts'
import type { WorkflowDecision } from '../engine/workflow-reconstruction-types.ts'
import { startImplement, startModelReceiptAction } from './feature-action-start.ts'
import type { SelectedFeature } from './feature-continuation-selection.ts'
import type { ContinueFeatureInput, ContinueFeatureResult } from './feature-contract.ts'
import type { FeatureObservation } from './feature-observation-contract.ts'
import { planAction } from './feature-plan-start.ts'
import { openPullRequestAfterRemoteProof, reviewAfterBinding } from './feature-publication-review.ts'

export async function coordinatePlanAndReceiptAction(
  input: ContinueFeatureInput,
  exactMandateRef: ScopedRecordRef | undefined,
  selected: SelectedFeature,
  observation: FeatureObservation,
  action: Extract<WorkflowDecision, { status: 'action' }>['action'],
  continueAt: (input: ContinueFeatureInput, exactMandateRef?: ScopedRecordRef) => Promise<ContinueFeatureResult>,
): Promise<ContinueFeatureResult | null> {
  const { authority, number, issue, mandate } = selected
  const { context, scope, target } = authority
  const history = observation.evidence.issue
  switch (action) {
    case 'plan':
      return mandate === null
        ? missingMandate()
        : planAction(
            context.engine,
            observation.evidence,
            history,
            context.gh,
            context.cwd,
            scope,
            mandate,
            input.uw,
            context.git,
          )
    case 'implement':
      return mandate === null
        ? missingMandate()
        : startImplement(
            context.engine,
            observation.evidence,
            history,
            scope,
            issue,
            context.git,
            context.gh,
            context.cwd,
            mandate,
            input.uw,
          )
    case 'assess-spec':
      return mandate === null
        ? missingMandate()
        : startModelReceiptAction({
            action,
            loaded: context.engine,
            history,
            mandate,
            evidence: observation.evidence,
            scope,
            currentSpec: observation.facts.currentSpec,
            identityAllocations: observation.facts.identityAllocations,
            target,
            gh: context.gh,
            cwd: context.cwd,
            uw: input.uw,
            git: context.git,
          })
    case 'attribute-ci': {
      if (observation.delivery === null || mandate === null)
        return { kind: 'blocked', reason: 'ci-attribution-requires-pull-request' }
      const delivery = observation.delivery
      return startModelReceiptAction({
        action,
        loaded: context.engine,
        history: delivery.history,
        mandateHistory: history,
        mandate,
        evidence: observation.evidence,
        scope: delivery.scope,
        currentSpec: observation.facts.currentSpec,
        identityAllocations: observation.facts.identityAllocations,
        target: {
          status: 'pull-request',
          scope: delivery.scope,
          pullRequest: { pr: delivery.number, head: delivery.head, base: delivery.base, branch: delivery.branch },
        },
        gh: context.gh,
        cwd: context.cwd,
        uw: input.uw,
        git: context.git,
      })
    }
    case 'frame':
      return { kind: 'operator-decision', reason: 'needs-scope' }
    case 'publish': {
      if (mandate === null) return missingMandate()
      const published = await openPullRequestAfterRemoteProof(
        history,
        issue,
        number,
        context.git,
        context.gh,
        context.cwd,
        mandate,
      )
      return (
        published ??
        continueAt(
          {
            cwd: context.cwd,
            reference: input.reference,
            control: 'continue',
            principal: false,
            git: context.git,
            gh: context.gh,
            ...(selected.reader === null ? {} : { read: selected.reader }),
          },
          exactMandateRef,
        )
      )
    }
    case 'review':
      return reviewAfterBinding(context.engine, history, observation.delivery, observation.evidence.parents)
    case 'stop':
    case 'done':
      return { kind: 'terminal', reason: action }
    default:
      return null
  }
}

function missingMandate(): ContinueFeatureResult {
  return { kind: 'blocked', reason: 'mandate-missing' }
}

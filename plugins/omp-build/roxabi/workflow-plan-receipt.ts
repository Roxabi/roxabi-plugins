import type { ScopedRecordRef } from '../engine/record-references.ts'
import type { WorkflowDecision, WorkflowFacts } from '../engine/workflow-reconstruction-types.ts'
import { startImplement, startModelReceiptAction } from './feature-action-start.ts'
import type { SelectedFeature } from './feature-continuation-selection.ts'
import type { ContinueFeatureInput, ContinueFeatureResult } from './feature-contract.ts'
import type { FeatureObservation } from './feature-observation-contract.ts'
import { planAction } from './feature-plan-start.ts'
import { openPullRequestAfterRemoteProof, reviewAfterBinding } from './feature-publication-review.ts'
import type { PreparedUwAction, UwActionRequest } from './uw-action-contract.ts'

export async function coordinatePlanAndReceiptAction(
  input: ContinueFeatureInput,
  exactMandateRef: ScopedRecordRef | undefined,
  selected: SelectedFeature,
  observation: FeatureObservation,
  action: Extract<WorkflowDecision, { status: 'action' }>['action'],
  continueAt: (input: ContinueFeatureInput, exactMandateRef?: ScopedRecordRef) => Promise<ContinueFeatureResult>,
  disposedStarts: ReadonlySet<string>,
  recovery?: { request: UwActionRequest; prepared: PreparedUwAction },
  facts?: WorkflowFacts,
): Promise<ContinueFeatureResult | null> {
  const { authority, issue, mandate } = selected
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
            recovery,
            facts,
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
            disposedStarts,
            recovery,
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
            ...(recovery === undefined ? {} : { recovery }),
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
        ...(recovery === undefined ? {} : { recovery }),
      })
    }
    case 'frame':
      return { kind: 'operator-decision', reason: 'needs-scope' }
    case 'publish':
      return publishAndContinue(input, exactMandateRef, selected, observation, continueAt)
    case 'review':
      return reviewAfterBinding(
        context.engine,
        history,
        observation.delivery,
        observation.evidence.parents,
        observation.evidence.causal,
      )
    case 'stop':
    case 'done':
      return { kind: 'terminal', reason: action }
    default:
      return null
  }
}

async function publishAndContinue(
  input: ContinueFeatureInput,
  exactMandateRef: ScopedRecordRef | undefined,
  selected: SelectedFeature,
  observation: FeatureObservation,
  continueAt: (input: ContinueFeatureInput, exactMandateRef?: ScopedRecordRef) => Promise<ContinueFeatureResult>,
): Promise<ContinueFeatureResult> {
  const { authority, issue, number, mandate } = selected
  const { context } = authority
  if (mandate === null) return missingMandate()
  const published = await openPullRequestAfterRemoteProof(
    observation.evidence.issue,
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

function missingMandate(): ContinueFeatureResult {
  return { kind: 'blocked', reason: 'mandate-missing' }
}

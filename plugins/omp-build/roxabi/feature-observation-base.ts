import type { WorkflowFacts } from '../engine/workflow-reconstruction-types.ts'
import type { SelectedFeature } from './feature-continuation-selection.ts'
import type { FeatureControl } from './feature-contract.ts'
import { inhibition } from './feature-control.ts'
import type { FeatureObservation, FreshUwDeliveryAdmission } from './feature-observation-contract.ts'
import { configPinDigest, type effectiveWorkflowConfig } from './workflow-config-digest.ts'
import { SUPPORTED_CONFIG_VERSIONS, WORKFLOW_CONFIG_VERSION } from './workflow-graph.ts'

type ObservationBase = Omit<FeatureObservation, 'decisions' | 'reviewId'> & { merged: boolean }
type CurrentSpecObservation = Pick<WorkflowFacts, 'currentSpec' | 'identityAllocations'> & {
  deliveryAdmission: FreshUwDeliveryAdmission
}

function observedPullRequest(delivery: ObservationBase['delivery']) {
  if (delivery === null) return null
  return { scope: delivery.scope, head: delivery.branch, base: delivery.base, associatedIssue: delivery.issueScope }
}

export function buildObservationBase(input: {
  evidence: ObservationBase['evidence']
  delivery: ObservationBase['delivery']
  merged: boolean
  currentFacts: CurrentSpecObservation
  head: string | null
  sessionCwd: string | null
  completedDelivery: boolean
  control: FeatureControl
  scope: SelectedFeature['authority']['scope']
  productVersion: string
  effectiveConfig: ReturnType<typeof effectiveWorkflowConfig>
}): ObservationBase {
  const { evidence, delivery, merged, currentFacts, head, sessionCwd, completedDelivery, control, scope } = input
  return {
    evidence,
    delivery,
    merged,
    deliveryAdmission: currentFacts.deliveryAdmission,
    facts: {
      currentSpec: currentFacts.currentSpec,
      identityAllocations: currentFacts.identityAllocations,
      base: delivery?.base ?? null,
      candidateGitSHA: head,
      lineageHead: head,
      pullRequest: observedPullRequest(delivery),
      merged,
      sessionCwd,
      preparedWorktree: sessionCwd,
      productVersion: input.productVersion,
      configVersion: WORKFLOW_CONFIG_VERSION,
      configDigest: configPinDigest(input.effectiveConfig),
      supportedConfigVersions: SUPPORTED_CONFIG_VERSIONS,
      explicitSelection: control === 'select' || control === 'new',
      explicitResume: control === 'resume',
      successorAntecedent: null,
      endObligationsMet: completedDelivery,
      localInhibit: inhibition(scope) ?? null,
      failedChecks: null,
      evidenceDigest: null,
    },
  }
}

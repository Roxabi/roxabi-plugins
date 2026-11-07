import { canonicalValueDigest } from './action-input.ts'
import type { ActionInputManifest } from './action-input-schema.ts'
import { equalScope, sameOwnSpecRef, sameRef } from './record-diagnostics.ts'
import type { ExternalRecordRef } from './record-references.ts'
import type { Scope } from './record-values.ts'
import type { SpecEffective } from './spec-effective-schema.ts'
import type { NativeDeliveryPullRequest, UwCompletion, UwCompletionObservation } from './uw-completion-types.ts'
import { assessParentIntegration } from './uw-delivery-integration.ts'
import {
  actualMergedLineage,
  deliveryFactsFor,
  type ObservedCommitIndex,
  observedAncestors,
} from './uw-delivery-lineage.ts'
import {
  authenticatedDeliveryRecord,
  deliveryFailure,
  inspectDeliveryReview,
  recordRef,
  type SelectedDeliveryReview,
  selectDeliveryReview,
} from './uw-delivery-review.ts'
import type { UwResult } from './uw-diagnostics.ts'
import type { AcceptedOwnSpec } from './workflow-accepted-spec-types.ts'
import { selectWorkflowBinding, type WorkflowBindingSelection } from './workflow-pr-binding.ts'

type DeliveryProof = {
  code: ActionInputManifest['code']
  sources: readonly ExternalRecordRef[]
  authority: readonly ExternalRecordRef[]
}
export type CompleteDeliveryChild = Extract<UwCompletion, { state: 'complete' }> & {
  authority: readonly ExternalRecordRef[]
}
type Bound = Extract<WorkflowBindingSelection, { status: 'bound' }>

function uniqueSources(refs: readonly ExternalRecordRef[]): ExternalRecordRef[] {
  const seen = new Set<string>()
  return refs.filter((ref) => {
    const key = `${ref.scope.repository}\0${ref.scope.target}\0${ref.kind}\0${ref.recordId}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function leafBinding(
  observation: UwCompletionObservation,
  uw: Scope,
  accepted: AcceptedOwnSpec,
): UwResult<{ native: NativeDeliveryPullRequest; binding: Bound }> {
  const facts = deliveryFactsFor(observation.delivery, uw)
  if (facts === null)
    return deliveryFailure(uw, 'delivery-facts-ambiguous', 'No unique complete binding-scoped delivery fact set')
  const mandate = accepted.chain[0]?.source
  if (mandate?.kind !== 'mandate')
    return deliveryFailure(uw, 'delivery-mandate-absent', 'Accepted Spec has no initial authenticated mandate')
  const candidates: { native: NativeDeliveryPullRequest; binding: Bound }[] = []
  for (const native of facts.pullRequests) {
    const binding = selectWorkflowBinding({ pullRequest: native.pullRequest, histories: observation.histories, native })
    if (binding.status !== 'bound' || !sameRef(binding.mandate, mandate)) continue
    candidates.push({ native, binding })
  }
  const [candidate] = candidates
  return candidates.length === 1 && candidate !== undefined
    ? { ok: true, value: candidate }
    : deliveryFailure(
        uw,
        'delivery-binding-ambiguous',
        'Accepted delivery mandate has no unique authenticated native PR binding',
      )
}

function assessLeaf(
  observation: UwCompletionObservation,
  uw: Scope,
  accepted: AcceptedOwnSpec,
  effective: SpecEffective,
  index: ObservedCommitIndex,
): UwResult<DeliveryProof> {
  const bound = leafBinding(observation, uw, accepted)
  if (!bound.ok) return bound
  const { native, binding } = bound.value
  const selected = selectDeliveryReview(observation, uw, native.pullRequest, effective, 'pull-request')
  if (!selected.ok) return selected
  const subject = selected.value.inputs.manifest.subject
  const expected = recordRef(binding.binding)
  if (
    subject.kind !== 'uw' ||
    subject.pullRequest === null ||
    !equalScope(subject.pullRequest, native.pullRequest) ||
    subject.binding === null ||
    !sameRef(subject.binding.record, expected) ||
    subject.binding.selector !== '/payload' ||
    subject.binding.digest !== canonicalValueDigest(binding.binding.payload)
  )
    return deliveryFailure(uw, 'delivery-binding-mismatch', 'Final review does not use the current actual PR binding')
  const authenticated = authenticatedDeliveryRecord(observation, expected)
  if (!authenticated.ok) return authenticated
  const facts = deliveryFactsFor(observation.delivery, uw)
  if (facts === null)
    return deliveryFailure(uw, 'delivery-facts-ambiguous', 'No unique complete binding-scoped delivery fact set')
  const code = selected.value.inputs.manifest.code
  if (!actualMergedLineage(facts, native, code, index))
    return deliveryFailure(
      uw,
      'delivery-not-merged',
      'Actual bound merge identity and observed commit parents do not prove this reviewed delivery',
    )
  return {
    ok: true,
    value: {
      code,
      sources: uniqueSources([...selected.value.sources, expected, binding.mandate]),
      authority: [recordRef(selected.value.review), expected],
    },
  }
}

function assessParent(
  observation: UwCompletionObservation,
  uw: Scope,
  accepted: AcceptedOwnSpec,
  effective: SpecEffective,
  children: readonly CompleteDeliveryChild[],
  index: ObservedCommitIndex,
): UwResult<DeliveryProof> {
  const selected = selectDeliveryReview(observation, uw, uw, effective, 'epic-range')
  if (!selected.ok) return selected
  const facts = deliveryFactsFor(observation.delivery, uw)
  if (facts === null)
    return deliveryFailure(uw, 'integration-facts-ambiguous', 'Parent integration facts are absent or ambiguous')
  const code = selected.value.inputs.manifest.code
  const ancestors = observedAncestors(index, code.repository, code.head)
  if (ancestors === null || !ancestors.has(code.base))
    return deliveryFailure(
      uw,
      'integration-range-unobserved',
      'Actual integrated commit range is not backed by observed ancestry',
    )
  const integration = assessParentIntegration(
    observation,
    uw,
    accepted,
    selected.value,
    facts,
    children,
    index,
    ancestors,
  )
  if (!integration.ok) return integration
  return {
    ok: true,
    value: {
      code,
      sources: uniqueSources([...selected.value.sources, ...integration.value]),
      authority: [recordRef(selected.value.review), ...integration.value],
    },
  }
}

export function selectUwDeliveryReview(
  observation: UwCompletionObservation,
  uw: Scope,
  accepted: AcceptedOwnSpec,
  effective: SpecEffective,
): UwResult<SelectedDeliveryReview> {
  if (accepted.children.length !== 0) return inspectDeliveryReview(observation, uw, uw, effective, 'epic-range')
  const bound = leafBinding(observation, uw, accepted)
  return bound.ok
    ? inspectDeliveryReview(observation, uw, bound.value.native.pullRequest, effective, 'pull-request')
    : bound
}

export function assessUwDeliveryProof(
  observation: UwCompletionObservation,
  uw: Scope,
  accepted: AcceptedOwnSpec,
  effective: SpecEffective,
  children: readonly CompleteDeliveryChild[],
  index: ObservedCommitIndex,
): UwResult<DeliveryProof> {
  if (observation.status !== 'complete') return { ok: false, diagnostics: [...observation.diagnostics] }
  if (
    !equalScope(uw, accepted.ref.uw) ||
    !sameOwnSpecRef(effective.own, accepted.ref) ||
    canonicalValueDigest(effective.versionVector) !==
      canonicalValueDigest([accepted.ref, ...accepted.inheritedOwnSpecRefs])
  )
    return deliveryFailure(
      uw,
      'delivery-spec-mismatch',
      'Delivery proof does not bind the exact accepted current version vector',
    )
  if (accepted.children.length !== children.length)
    return deliveryFailure(
      uw,
      'integration-child-proofs-missing',
      'Delivery proof requires every accepted child result from the same bottom-up calculation',
    )
  return accepted.children.length === 0
    ? assessLeaf(observation, uw, accepted, effective, index)
    : assessParent(observation, uw, accepted, effective, children, index)
}

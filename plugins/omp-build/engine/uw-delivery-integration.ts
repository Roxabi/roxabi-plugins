import { acceptedMetadataOwner } from './accepted-metadata-owner.ts'
import { canonicalValueDigest } from './action-input.ts'
import { equalScope, sameOwnSpecRef, sameRef } from './record-diagnostics.ts'
import type { ExternalRecordRef } from './record-references.ts'
import type { Scope } from './record-values.ts'
import { authenticateReviewIntegrationPin } from './review-integration-pin.ts'
import type { UwCompletion, UwCompletionObservation, UwDeliveryFacts } from './uw-completion-types.ts'
import { deliveredChildCommit, type ObservedCommitIndex } from './uw-delivery-lineage.ts'
import { deliveryFailure, type SelectedDeliveryReview } from './uw-delivery-review.ts'
import type { UwResult } from './uw-diagnostics.ts'
import type { IntegrationOutput } from './uw-integration-schema.ts'
import type { AcceptedOwnSpec } from './workflow-accepted-spec-types.ts'

type CompleteChild = Extract<UwCompletion, { state: 'complete' }>

function matchedChildren(
  observation: UwCompletionObservation,
  output: IntegrationOutput,
  children: readonly CompleteChild[],
  index: ObservedCommitIndex,
  ancestors: ReadonlySet<string>,
): boolean {
  if (output.children.length !== children.length) return false
  const seen = new Set<string>()
  for (const item of output.children) {
    const child = children.find((candidate) => sameOwnSpecRef(candidate.spec, item.spec))
    if (child === undefined || seen.has(`${item.spec.uw.repository}\0${item.spec.uw.target}`)) return false
    seen.add(`${item.spec.uw.repository}\0${item.spec.uw.target}`)
    if (
      child.code.repository !== output.code.repository ||
      canonicalValueDigest(child.code) !== canonicalValueDigest(item.code)
    )
      return false
    if (
      child.sources.length !== item.sources.length ||
      child.sources.some((source) => !item.sources.some((ref) => sameRef(source, ref)))
    )
      return false
    const commit = deliveredChildCommit(observation.delivery, child, index)
    if (commit === null || !ancestors.has(commit)) return false
  }
  return true
}

function citedAssignments(
  accepted: AcceptedOwnSpec,
  owner: { record: ExternalRecordRef; selector: string },
  selected: SelectedDeliveryReview,
  children: readonly CompleteChild[],
): boolean {
  if (accepted.coverage === null) return false
  for (const [index, assignment] of accepted.coverage.assignments.entries()) {
    const verdict = selected.facts.verdicts.find(
      (row) => row.target.id === assignment.criterion && sameOwnSpecRef(row.target.spec, accepted.ref),
    )
    if (verdict === undefined) return false
    const refs = verdict.examined.flatMap((row) => {
      if (row.truth !== 'supported' || row.applicability !== 'applies') return []
      const judgment = row.codeLink.method === 'test' ? row.codeLink.after : row.codeLink.current
      return judgment.support === 'supported' ? judgment.references.filter((ref) => ref.source === 'record') : []
    })
    const coverageRef = refs.some(
      (ref) =>
        sameRef(ref.record, owner.record) &&
        ref.selector === `${owner.selector}/coverage/assignments/${index}` &&
        ref.digest === canonicalValueDigest(assignment),
    )
    if (!coverageRef) return false
    for (const assigned of assignment.children) {
      const child = children.find((candidate) => equalScope(candidate.uw, assigned))
      if (child === undefined || !refs.some((ref) => child.sources.some((source) => sameRef(source, ref.record))))
        return false
    }
  }
  return true
}

export function assessParentIntegration(
  observation: UwCompletionObservation,
  uw: Scope,
  accepted: AcceptedOwnSpec,
  selected: SelectedDeliveryReview,
  facts: UwDeliveryFacts,
  children: readonly CompleteChild[],
  index: ObservedCommitIndex,
  ancestors: ReadonlySet<string>,
): UwResult<readonly ExternalRecordRef[]> {
  const pinned = authenticateReviewIntegrationPin(selected.inputs, observation.histories)
  if (!pinned.ok) {
    const first = pinned.diagnostics[0]
    return deliveryFailure(
      uw,
      first?.code ?? 'integration-result-unconfirmed',
      first?.message ?? 'Integration receipt is unavailable',
    )
  }
  const selectedPin = selected.inputs.manifest.deliveryData.find((item) => item.role === 'integration')
  const candidates = facts.integrations.filter(
    (item) =>
      selectedPin !== undefined &&
      sameRef(item.source.record, pinned.value.source) &&
      item.source.selector === selectedPin.selector &&
      item.source.digest === selectedPin.digest &&
      canonicalValueDigest(item.code) === canonicalValueDigest(pinned.value.output.code),
  )
  const [candidate] = candidates
  if (candidates.length !== 1 || candidate === undefined)
    return deliveryFailure(
      uw,
      'integration-result-ambiguous',
      'The selected integration receipt is not uniquely observed',
    )
  const output = pinned.value.output
  if (
    canonicalValueDigest(output.coverage) !== canonicalValueDigest(accepted.coverage) ||
    !matchedChildren(observation, output, children, index, ancestors)
  )
    return deliveryFailure(
      uw,
      'integration-children-unbound',
      'Integrated child versions, proof sources, ancestry or coverage do not match accepted completed children',
    )
  const step = accepted.chain.at(-1)
  if (step === undefined)
    return deliveryFailure(uw, 'integration-metadata-unbound', 'Accepted parent has no authenticated metadata owner')
  const owner = acceptedMetadataOwner(step, observation.histories)
  if (!owner.ok) return owner
  if (!citedAssignments(accepted, owner.value, selected, children))
    return deliveryFailure(
      uw,
      'integration-coverage-not-cited',
      'Every final own-criterion verdict must cite its exact accepted coverage assignment and actual child proof sources',
    )
  return { ok: true, value: [candidate.source.record] }
}

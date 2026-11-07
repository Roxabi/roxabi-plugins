import {
  canonicalValueDigest,
  sameScope,
  selectApplicableMandate,
  workflowOperationProblem,
} from '../../dist/contracts.js'
import type { DecodedHistory } from '../../engine/history-schema.ts'
import type { UwAdmission } from '../../engine/uw-admission.ts'
import type { UwRead } from '../../roxabi/uw-contract.ts'
import { readCurrentFramingFacts } from '../../roxabi/uw-current-facts.ts'

/** A same-cut scheduling observation, never accepted-Spec or completion authority. */
export type InitialMandateReadiness = { status: 'ready' } | { status: 'held'; reason: string }

export async function initialMandateReadiness(
  parent: UwRead,
  parentAdmission: UwAdmission,
  child: UwRead,
): Promise<InitialMandateReadiness> {
  const held = (reason: string): InitialMandateReadiness => ({ status: 'held', reason })
  const observation = sameCompleteObservation(parent, child)
  if (observation === null) return held('complete same-cut Parent and child observations are required')
  if (!parentAdmission.deliverable.ok || parent.accepted.status !== 'accepted')
    return held('Parent accepted delivery admission is unavailable')
  const histories = observation.histories
  const parentHistories = histories.filter((history) => sameScope(history.source.scope, parent.uw))
  const childHistories = histories.filter((history) => sameScope(history.source.scope, child.uw))
  const parentHistory = parentHistories[0]
  const childHistory = childHistories[0]
  if (parentHistories.length !== 1 || childHistories.length !== 1 || !parentHistory || !childHistory)
    return held('Parent or child history is unavailable or ambiguous')
  if (workflowOperationProblem(parentHistory) !== null || workflowOperationProblem(childHistory) !== null)
    return held('Parent or child workflow history is incomplete or invalid')
  const causal = { histories, catalogues: observation.catalogues, observation }
  const selected = selectApplicableMandate(
    parentHistory,
    histories.filter((history) => history !== parentHistory),
    causal,
  )
  if (
    selected.status !== 'applicable' ||
    !selected.mandate.payload.permissions.landing ||
    !selected.mandate.payload.permissions.correct
  )
    return held('Parent active mandate or child permissions are unavailable')
  const source = parent.accepted.value.chain[0]?.source
  if (
    source?.kind !== 'mandate' ||
    source.recordId !== selected.mandate.recordId ||
    !sameScope(source.scope, parent.uw)
  )
    return held('Parent accepted commitment does not belong to its active mandate')
  const childProblem = childEligibility(parent, child, childHistory)
  if (childProblem !== null) return childProblem
  const framing = await readCurrentFramingFacts({ uw: child.uw, read: child })
  if (!framing.ok)
    return held(framing.diagnostics.map((entry) => entry.message).join('; ') || 'Child framing cannot be reconstructed')
  if (
    canonicalValueDigest(framing.value.currentSpec.inheritedOwnSpecRefs) !==
    canonicalValueDigest([parent.accepted.value.ref, ...parent.accepted.value.inheritedOwnSpecRefs])
  )
    return held('Child inherited Spec vector differs from the active Parent ancestry')
  return { status: 'ready' }
}

function sameCompleteObservation(
  parent: UwRead,
  child: UwRead,
): Extract<UwRead['observation'], { status: 'complete' }> | null {
  if (
    parent.observation.status !== 'complete' ||
    child.observation.status !== 'complete' ||
    parent.graph.status !== 'complete' ||
    child.graph.status !== 'complete' ||
    parent.observation !== child.observation
  )
    return null
  return parent.observation
}

function matchesCommitment(parent: UwRead, child: UwRead, root: UwRead['graph']['nodes'][number]): boolean {
  if (parent.accepted.status !== 'accepted' || !child.proposed.ok) return false
  const grants = parent.accepted.value.children.filter((grant) => sameScope(grant.scope, child.uw))
  const grant = grants[0]
  const labels = root.labels.filter((label) => label === 'size:S' || label === 'size:F-lite' || label === 'size:F-full')
  return (
    grants.length === 1 &&
    grant !== undefined &&
    labels.length === 1 &&
    labels[0] === `size:${grant.tier}` &&
    grant.specVersion === child.proposed.snapshot.spec.version &&
    canonicalValueDigest(grant.snapshot.spec) === canonicalValueDigest(child.proposed.snapshot.spec)
  )
}

function childEligibility(parent: UwRead, child: UwRead, childHistory: DecodedHistory): InitialMandateReadiness | null {
  const held = (reason: string): InitialMandateReadiness => ({ status: 'held', reason })
  if (
    child.accepted.status !== 'absent' ||
    childHistory.operations.some(
      (operation) =>
        operation.authority !== 'foreign' &&
        (operation.kind === 'mandate' || operation.claimedKinds.includes('mandate')),
    )
  )
    return held('Child own mandate is not genuinely absent')
  const root = child.graph.nodes.find((node) => sameScope(node.uw, child.uw))
  if (root === undefined || root.parent === null || !sameScope(root.parent, parent.uw) || root.native.state !== 'OPEN')
    return held('Child is not an open native child of the accepted Parent')
  if (!child.identity.ok || !child.proposed.ok || !child.admission.framed.ok || !child.admission.deliverable.ok)
    return held(
      child.admission.deliverable.diagnostics.map((entry) => entry.message).join('; ') ||
        'Child framing, identities, or blockers are unavailable',
    )
  if (!matchesCommitment(parent, child, root))
    return held('Child framing or tier differs from the accepted Parent commitment')
  return null
}

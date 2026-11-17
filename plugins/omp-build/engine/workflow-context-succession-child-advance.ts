import { equalScope } from './record-diagnostics.ts'
import { assessUwCompletion } from './uw-completion.ts'
import type { UwCompletionObservation } from './uw-completion-types.ts'
import { buildObservedCommitIndex, deliveredChildCommit, type ObservedCommitIndex } from './uw-delivery-lineage.ts'
import { scopeKey } from './uw-graph.ts'
import { resolveAcceptedSpec } from './workflow-accepted-spec.ts'
import type { AcceptedOwnSpec } from './workflow-accepted-spec-types.ts'
import type { ContextSuccessionAdmission } from './workflow-context-succession.ts'
import { prepareContextSuccessionInspection } from './workflow-context-succession-inspection.ts'
import type { MandateRecord } from './workflow-control.ts'
import type { WorkflowEvidence } from './workflow-plan.ts'

/** Every first-parent base advance must be one authenticated, accepted child delivery. */
export function authenticatedChildAdvance(
  evidence: WorkflowEvidence,
  mandate: MandateRecord,
  succession: Pick<ContextSuccessionAdmission, 'replacementAccepted' | 'baselineCode'>,
  head: string,
): boolean {
  const observation = evidence.causal.observation
  const inspection = prepareContextSuccessionInspection(evidence, mandate)
  if (!inspection.ok) return false
  const current = resolveAcceptedSpec(
    mandate,
    evidence.causal.histories,
    undefined,
    inspection.value === undefined ? undefined : { kind: 'selected-succession', succession: inspection.value },
  )
  if (!current.ok) return false
  const accepted = current.spec
  if (
    observation.status !== 'complete' ||
    mandate.payload.branch !== null ||
    accepted.children.length === 0 ||
    !equalScope(accepted.ref.uw, { repository: mandate.repository, target: mandate.target })
  )
    return false
  const index = buildObservedCommitIndex(observation)
  if (!index.ok) return false
  const allowed = acceptedChildDeliveries(observation, accepted, index.value)
  if (allowed === null) return false
  const commits = index.value.get(mandate.repository)
  if (commits === undefined) return false
  return followsAcceptedChildren(commits, allowed, succession.baselineCode.head, head)
}

function acceptedChildDeliveries(
  observation: Extract<UwCompletionObservation, { status: 'complete' }>,
  accepted: AcceptedOwnSpec,
  index: ObservedCommitIndex,
): Set<string> | null {
  const completion = assessUwCompletion(observation)
  const allowed = new Set<string>()
  for (const child of accepted.children) {
    const dependency = completion.dependencies.get(scopeKey(child.scope))
    const done = dependency?.completion
    if (dependency?.state !== 'satisfied' || done?.state !== 'complete') continue
    if (done.spec.version !== child.specVersion || !equalScope(done.uw, child.scope)) return null
    const delivered = deliveredChildCommit(observation.delivery, done, index)
    if (delivered === null || allowed.has(delivered)) return null
    allowed.add(delivered)
  }
  return allowed
}

function followsAcceptedChildren(
  commits: ReadonlyMap<string, readonly string[]>,
  allowed: ReadonlySet<string>,
  baseline: string,
  head: string,
): boolean {
  let cursor = head
  const visited = new Set<string>()
  while (cursor !== baseline) {
    if (visited.has(cursor) || !allowed.has(cursor)) return false
    visited.add(cursor)
    const parents = commits.get(cursor)
    if (parents === undefined || parents.length === 0 || parents[0] === undefined) return false
    cursor = parents[0]
  }
  return true
}

import { canonicalValueDigest } from '../engine/action-input.ts'
import type { CauseSisterInput, ParentCoverageIntent } from '../engine/cause-disposition-schema.ts'
import { acceptedConstraints, proposedConstraints } from '../engine/workflow-constraint-compatibility.ts'
import type { SpecAssessment } from '../engine/workflow-output-schema.ts'
import type { NativeTask } from '../omp/review-runtime/contracts.ts'

type SisterWorld = {
  parent: { scope: ParentCoverageIntent['parent']['uw']; version: string; coverage: ParentCoverageIntent | null } | null
  request(index: number): CauseSisterInput
}

/** The existing fixture owns all native issue, history and publication state. */
export function composedSisterRequest(world: SisterWorld): CauseSisterInput {
  const parent = world.parent
  if (parent === null || parent.coverage === null) throw new Error('Expected an accepted parent with coverage')
  return {
    ...world.request(0),
    parentCoverage: {
      parent: { uw: parent.scope, version: parent.version },
      assignments: parent.coverage.assignments.map((row) => ({
        criterion: row.criterion,
        children: [...row.children, { kind: 'created-child' as const }],
      })),
    },
  }
}

/** Declared assessment judgment over the actual sealed task operands, not a published receipt. */
export function composedAssessmentJudgment(task: NativeTask): SpecAssessment {
  const operands = task.action.inputs.manifest.operands
  if (operands?.action !== 'assess-spec' || operands.origin.kind !== 'cause-created-child')
    throw new Error('Expected the sealed cause-created-child assessment')
  const exact = operands.exactInputs
  if (
    exact.accepted.inheritedOwnSpecRefs.length !== 0 ||
    exact.proposed.inheritedOwnSpecRefs.length !== 0 ||
    exact.accepted.children.length !== 1 ||
    exact.attachedChildren.length !== 0
  )
    throw new Error('Unexpected composed scenario constraint closure')
  const current = exact.accepted.children[0]
  const source = exact.childOwnSources.find(
    (entry) => entry.uw.repository === current.scope.repository && entry.uw.target === current.scope.target,
  )
  if (!source?.own || source.own.version !== current.specVersion)
    throw new Error('Current child source does not match its engagement')
  const created = exact.proposed.children.filter((child) => 'kind' in child)
  const existing = exact.proposed.children.filter((child) => 'scope' in child)
  if (
    created.length !== 1 ||
    existing.length !== 1 ||
    existing[0]?.scope.repository !== current.scope.repository ||
    existing[0].scope.target !== current.scope.target ||
    existing[0].specVersion !== current.specVersion ||
    existing[0].tier !== current.tier ||
    canonicalValueDigest(existing[0].snapshot.spec) !== canonicalValueDigest(current.snapshot.spec)
  )
    throw new Error('Unexpected proposed child commitments')
  const slot = created[0]
  if (!slot) throw new Error('Missing created-child slot')
  const constraints = [
    ...acceptedConstraints(exact.accepted.ref, exact.accepted.snapshot.spec, true),
    ...proposedConstraints(exact.accepted.ref.uw, exact.proposed.snapshot.spec),
    ...acceptedConstraints(source.own, current.snapshot.spec, true),
    ...proposedConstraints(exact.accepted.ref.uw, slot.plan.allocation.spec, {
      kind: 'created-by',
      operationId: slot.operationId,
    }),
  ]
  const unique = [...new Map(constraints.map((value) => [canonicalValueDigest(value), value])).values()]
  const first = unique[0]
  if (!first) throw new Error('Assessment requires a nonempty constraint set')
  return {
    classification: 'material',
    compatibility: {
      state: 'consistent',
      examined: [first, ...unique.slice(1)],
      references: [],
      reason: 'The declared parent and child constraints are compatible.',
    },
  }
}

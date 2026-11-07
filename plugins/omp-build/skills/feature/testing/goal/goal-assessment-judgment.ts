import { canonicalValueDigest } from '../../../../engine/action-input.ts'
import type { AssessSpecExact } from '../../../../engine/workflow-action-operands.ts'
import { acceptedConstraints, proposedConstraints } from '../../../../engine/workflow-constraint-compatibility.ts'
import type { SpecAssessment } from '../../../../engine/workflow-output-schema.ts'

export function goalAssessmentJudgment(exact: AssessSpecExact): SpecAssessment {
  if (
    exact.accepted.inheritedOwnSpecRefs.length ||
    exact.proposed.inheritedOwnSpecRefs.length ||
    exact.attachedChildren.length ||
    exact.attachedWayfinders.length
  )
    throw new Error('Unexpected Goal assessment closure')
  const constraints = [
    ...acceptedConstraints(exact.accepted.ref, exact.accepted.snapshot.spec, true),
    ...proposedConstraints(exact.accepted.ref.uw, exact.proposed.snapshot.spec),
  ]
  for (const child of exact.accepted.children) {
    const source = exact.childOwnSources.find(
      (item) => item.uw.repository === child.scope.repository && item.uw.target === child.scope.target,
    )
    if (!source?.own || source.own.version !== child.specVersion)
      throw new Error('Goal child accepted authority missing')
    constraints.push(...acceptedConstraints(source.own, child.snapshot.spec, true))
  }
  const unique = [...new Map(constraints.map((value) => [canonicalValueDigest(value), value])).values()]
  const first = unique[0]
  if (!first) throw new Error('Goal assessment constraints are empty')
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

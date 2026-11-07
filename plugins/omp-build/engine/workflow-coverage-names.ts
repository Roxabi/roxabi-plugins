import type { ExternalRecordRef } from './record-references.ts'
import type { Scope } from './record-values.ts'
import type { OwnSpecRef } from './uw-spec-schema.ts'
import type { ProposedAssessmentState } from './workflow-action-operands.ts'
import type { AcceptedChildCommitment } from './workflow-mandate-schema.ts'
import type { SpecAssessment } from './workflow-output-schema.ts'

type ChildSubject = NonNullable<ProposedAssessmentState['coverage']>['assignments'][number]['children'][number]

export function coverageSpecName(uw: Scope, version: string): string {
  return `${uw.repository}:${uw.target}@${version}`
}

export function coverageCriterionName(uw: Scope, version: string, criterion: string): string {
  return `criterion ${criterion} of ${coverageSpecName(uw, version)}`
}

export function coverageAcceptedChildName(uw: Scope, children: readonly AcceptedChildCommitment[]): string {
  const child = children.find(
    (candidate) => candidate.scope.repository === uw.repository && candidate.scope.target === uw.target,
  )
  return child
    ? coverageSpecName(child.scope, child.specVersion)
    : `${uw.repository}:${uw.target} (not an accepted child)`
}

export function coverageProposedChildName(
  subject: ChildSubject,
  children: ProposedAssessmentState['children'],
): string {
  if ('kind' in subject) {
    const child = children.find((candidate) => 'kind' in candidate && candidate.operationId === subject.operationId)
    return child !== undefined && 'kind' in child
      ? `created-by ${child.operationId}@${child.plan.allocation.spec.version}`
      : `created-by ${subject.operationId} (not a proposed child)`
  }
  const child = children.find(
    (candidate) =>
      !('kind' in candidate) &&
      candidate.scope.repository === subject.repository &&
      candidate.scope.target === subject.target,
  )
  return child !== undefined && !('kind' in child)
    ? coverageSpecName(child.scope, child.specVersion)
    : `${subject.repository}:${subject.target} (not a proposed child)`
}

type Constraint = SpecAssessment['compatibility']['examined'][number]
type Compatibility = SpecAssessment['compatibility']
type Element = Extract<Constraint, { kind: 'proposed' }>['element']

function elementName(element: Element): string {
  return element.kind === 'exclusion' ? `exclusion[${element.index}]` : `${element.kind} ${element.id}`
}

function referenceName(ref: ExternalRecordRef): string {
  return `${ref.scope.repository}:${ref.scope.target} ${ref.kind} ${ref.recordId}`
}

function acceptedSpecName(ref: OwnSpecRef): string {
  return `${coverageSpecName(ref.uw, ref.version)} accepted by ${referenceName(ref.sourceAccepted)}`
}

function constraintName(constraint: Constraint): string {
  switch (constraint.kind) {
    case 'accepted':
      return `accepted ${constraint.target.kind} ${constraint.target.id} of ${acceptedSpecName(constraint.target.spec)}`
    case 'accepted-exclusion':
      return `accepted exclusion[${constraint.ref.index}] of ${acceptedSpecName(constraint.ref.spec)}`
    case 'engaged':
      return `engaged ${elementName(constraint.element)} of ${coverageSpecName(constraint.child, constraint.version)} via parent ${acceptedSpecName(constraint.parent)}; engagement ${referenceName(constraint.engagement.record)} selector ${constraint.engagement.selector}`
    case 'proposed': {
      const subject =
        constraint.subject.kind === 'existing'
          ? coverageSpecName(constraint.subject.uw, constraint.version)
          : `created-by ${constraint.subject.operationId}@${constraint.version}`
      return `proposed ${elementName(constraint.element)} of ${subject}`
    }
  }
}

/** Call only after exact operand and citation authentication; this is not an authority check. */
export function compatibilityStateProblem(compatibility: Compatibility): string | null {
  switch (compatibility.state) {
    case 'consistent':
      return null
    case 'conflicting':
      return `Constraint compatibility is conflicting: ${compatibility.conflicts.map((conflict) => `${constraintName(conflict.left)} conflicts with ${constraintName(conflict.right)}: ${conflict.reason}`).join('; ')}`
    case 'undetermined':
      return `Constraint compatibility is undetermined: ${compatibility.constraints.map(constraintName).join(', ')}: ${compatibility.reason}`
  }
}

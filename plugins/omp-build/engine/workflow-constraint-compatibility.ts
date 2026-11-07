import { acceptedMetadataOwner } from './accepted-metadata-owner.ts'
import { canonicalValueDigest } from './canonical-value.ts'
import { FINDING_TARGET_FORMAT } from './finding-target-schema.ts'
import type { DecodedHistory } from './history-schema.ts'
import { equalScope, sameOwnSpecRef } from './record-diagnostics.ts'
import type { ExternalRecordRef } from './record-references.ts'
import type { OwnSpecRef, Spec } from './uw-spec-schema.ts'
import type { CompatibilityOperandReader } from './workflow-accepted-spec-types.ts'
import { constraintExaminationProblem } from './workflow-compatibility-citations.ts'
import type { AcceptedChildCommitment } from './workflow-mandate-schema.ts'
import type { SpecAssessment } from './workflow-output-schema.ts'
import type { AssessSpecExact } from './workflow-receipt-schema.ts'
import type { AssessResultRecord } from './workflow-spec-assessment.ts'

type Constraint = SpecAssessment['compatibility']['examined'][number]
type ProposedSubject = Extract<Constraint, { kind: 'proposed' }>['subject']

export function acceptedConstraints(ref: OwnSpecRef, spec: Spec, includeCriteria: boolean): Constraint[] {
  return [
    ...(includeCriteria
      ? spec.criteria.map(
          (item): Constraint => ({
            kind: 'accepted',
            target: { format: FINDING_TARGET_FORMAT, kind: 'criterion', spec: ref, id: item.id },
          }),
        )
      : []),
    ...spec.invariants.map(
      (item): Constraint => ({
        kind: 'accepted',
        target: { format: FINDING_TARGET_FORMAT, kind: 'invariant', spec: ref, id: item.id },
      }),
    ),
    ...spec.exclusions.map((_, index): Constraint => ({ kind: 'accepted-exclusion', ref: { spec: ref, index } })),
  ]
}

export function proposedConstraints(
  uw: OwnSpecRef['uw'],
  spec: Spec,
  subject: ProposedSubject = { kind: 'existing', uw },
): Constraint[] {
  return [
    ...spec.criteria.map(
      (item): Constraint => ({
        kind: 'proposed',
        subject,
        version: spec.version,
        element: { kind: 'criterion', id: item.id },
      }),
    ),
    ...spec.invariants.map(
      (item): Constraint => ({
        kind: 'proposed',
        subject,
        version: spec.version,
        element: { kind: 'invariant', id: item.id },
      }),
    ),
    ...spec.exclusions.map(
      (_, index): Constraint => ({
        kind: 'proposed',
        subject,
        version: spec.version,
        element: { kind: 'exclusion', index },
      }),
    ),
  ]
}

type MetadataOwner = { record: ExternalRecordRef; selector: string }

class CompatibilityConstraints {
  readonly constraints: Constraint[]

  constructor(
    private readonly exact: AssessSpecExact,
    private readonly owner: MetadataOwner,
    private readonly operands: CompatibilityOperandReader,
  ) {
    this.constraints = [
      ...acceptedConstraints(exact.accepted.ref, exact.accepted.snapshot.spec, true),
      ...proposedConstraints(exact.accepted.ref.uw, exact.proposed.snapshot.spec),
    ]
  }

  inheritedProblem(): string | null {
    const inherited = [...this.exact.accepted.inheritedOwnSpecRefs, ...this.exact.proposed.inheritedOwnSpecRefs]
    const seenRefs: OwnSpecRef[] = []
    for (const ref of inherited) {
      if (seenRefs.some((prior) => sameOwnSpecRef(prior, ref))) continue
      seenRefs.push(ref)
      const source = this.operands.prefix(ref)
      if (!source.ok) return 'Inherited constraint source is not uniquely authenticated'
      this.constraints.push(...acceptedConstraints(ref, source.value.snapshot.spec, false))
    }
    return null
  }

  private appendOwn(child: AcceptedChildCommitment, ref: OwnSpecRef, message: string): string | null {
    const own = this.operands.prefix(ref)
    if (
      !own.ok ||
      own.value.ref.version !== child.specVersion ||
      own.value.tier !== child.tier ||
      canonicalValueDigest(own.value.snapshot.spec) !== canonicalValueDigest(child.snapshot.spec)
    )
      return message
    this.constraints.push(...acceptedConstraints(ref, own.value.snapshot.spec, true))
    return null
  }

  private appendEngaged(child: AcceptedChildCommitment, index: number): void {
    const engagement = {
      source: 'record' as const,
      record: this.owner.record,
      selector: `${this.owner.selector}/children/${index}`,
      digest: canonicalValueDigest(child),
    }
    const elements = [
      ...child.snapshot.spec.criteria.map((item) => ({ kind: 'criterion' as const, id: item.id })),
      ...child.snapshot.spec.invariants.map((item) => ({ kind: 'invariant' as const, id: item.id })),
      ...child.snapshot.spec.exclusions.map((_, index) => ({ kind: 'exclusion' as const, index })),
    ]
    for (const element of elements)
      this.constraints.push({
        kind: 'engaged',
        parent: this.exact.accepted.ref,
        engagement,
        child: child.scope,
        version: child.specVersion,
        element,
      })
  }

  acceptedChildrenProblem(): string | null {
    for (const [index, child] of this.exact.accepted.children.entries()) {
      const declared = this.exact.childOwnSources.find((entry) => equalScope(entry.uw, child.scope))
      if (!declared) return 'Accepted child lacks an own-source declaration'
      if (declared.own !== null) {
        const problem = this.appendOwn(
          child,
          declared.own,
          'Declared child own authority does not match the engaged child snapshot/version/tier',
        )
        if (problem !== null) return problem
      } else this.appendEngaged(child, index)
    }
    return null
  }

  private proposedExistingProblem(child: AcceptedChildCommitment): string | null {
    const prior = this.exact.accepted.children.find((item) => equalScope(item.scope, child.scope))
    if (
      !prior ||
      prior.specVersion !== child.specVersion ||
      prior.tier !== child.tier ||
      canonicalValueDigest(prior.snapshot.spec) !== canonicalValueDigest(child.snapshot.spec)
    )
      this.constraints.push(...proposedConstraints(child.scope, child.snapshot.spec))
    const declared = this.exact.childOwnSources.find((entry) => equalScope(entry.uw, child.scope))
    if (!declared) return 'Proposed existing child lacks an own-source declaration'
    return !prior && declared.own !== null
      ? this.appendOwn(child, declared.own, 'Proposed child own authority does not match its snapshot/version/tier')
      : null
  }

  proposedChildrenProblem(): string | null {
    for (const child of this.exact.proposed.children) {
      if ('kind' in child) {
        this.constraints.push(
          ...proposedConstraints(this.exact.accepted.ref.uw, child.plan.allocation.spec, {
            kind: 'created-by',
            operationId: child.operationId,
          }),
        )
        continue
      }
      const problem = this.proposedExistingProblem(child)
      if (problem !== null) return problem
    }
    return null
  }

  attachedChildrenProblem(): string | null {
    for (const child of this.exact.attachedChildren) {
      this.constraints.push(...proposedConstraints(child.scope, child.snapshot.spec))
      const declared = this.exact.childOwnSources.find((entry) => equalScope(entry.uw, child.scope))
      if (!declared) return 'Attached child lacks an own-source declaration'
      if (declared.own !== null) {
        const problem = this.appendOwn(
          child,
          declared.own,
          'Attached child own authority does not match its snapshot/version/tier',
        )
        if (problem !== null) return problem
      }
    }
    return null
  }
}

/** Called only after the lexical replay frame has structurally indexed its complete dependency closure. */
export function constraintCompatibilityProblem(
  record: AssessResultRecord,
  assessment: SpecAssessment,
  histories: readonly DecodedHistory[],
  operands: CompatibilityOperandReader,
): string | null {
  const exact = record.payload.exactInputs
  const parent = operands.acceptedMetadata(exact.accepted, record.payload.inputs.manifest.acceptedSources)
  if (!parent.ok) return 'Accepted parent constraint source is unavailable'
  const parentStep = parent.value.chain[parent.value.chain.length - 1]
  if (!parentStep) return 'Accepted parent metadata step is missing'
  const owner = acceptedMetadataOwner(parentStep, histories)
  if (!owner.ok) return 'Accepted parent metadata source is not authenticated'
  const collected = new CompatibilityConstraints(exact, owner.value, operands)
  const problem =
    collected.inheritedProblem() ??
    collected.acceptedChildrenProblem() ??
    collected.proposedChildrenProblem() ??
    collected.attachedChildrenProblem()
  return problem ?? constraintExaminationProblem(collected.constraints, record, assessment, histories)
}

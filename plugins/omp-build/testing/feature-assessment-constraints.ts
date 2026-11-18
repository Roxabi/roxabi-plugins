import { canonicalValueDigest } from '../engine/action-input.ts'
import type { ExternalRecordRef } from '../engine/record-references.ts'
import type { OwnSpecRef } from '../engine/uw-spec-schema.ts'
import type { AssessSpecExact } from '../engine/workflow-action-operands.ts'
import { acceptedConstraints, proposedConstraints } from '../engine/workflow-constraint-compatibility.ts'
import type { SpecAssessment } from '../engine/workflow-output-schema.ts'

type Constraint = SpecAssessment['compatibility']['examined'][number]

/** Enumerate the actual accepted and proposed operands for a fictional assessment judgment. */
export function assessmentConstraints(
  exact: AssessSpecExact,
  metadata?: { record: ExternalRecordRef; selector: string },
) {
  if (exact.accepted.inheritedOwnSpecRefs.length || exact.proposed.inheritedOwnSpecRefs.length)
    throw new Error('Inherited assessment constraint closure requires an explicit source')
  const constraints = [
    ...acceptedConstraints(exact.accepted.ref, exact.accepted.snapshot.spec, true),
    ...proposedConstraints(exact.accepted.ref.uw, exact.proposed.snapshot.spec),
  ]
  addAcceptedChildren(constraints, exact, metadata)
  addProposedChildren(constraints, exact)
  addAttachedChildren(constraints, exact)
  return [...new Map(constraints.map((item) => [canonicalValueDigest(item), item])).values()]
}

const sameScope = (a: OwnSpecRef['uw'], b: OwnSpecRef['uw']) => a.repository === b.repository && a.target === b.target

function addAcceptedChildren(
  constraints: Constraint[],
  exact: AssessSpecExact,
  metadata?: { record: ExternalRecordRef; selector: string },
) {
  for (const [index, child] of exact.accepted.children.entries()) {
    const source = exact.childOwnSources.find((entry) => sameScope(entry.uw, child.scope))
    if (!source) throw new Error('Assessment child source unavailable')
    if (source.own !== null) {
      if (source.own.version !== child.specVersion) throw new Error('Assessment child version mismatch')
      constraints.push(...acceptedConstraints(source.own, child.snapshot.spec, true))
      continue
    }
    const owner =
      metadata ??
      (exact.accepted.ref.sourceAccepted.kind === 'mandate'
        ? { record: exact.accepted.ref.sourceAccepted, selector: '/payload' }
        : undefined)
    if (owner === undefined) throw new Error('Unmanaged child requires authenticated accepted metadata')
    const engagement = {
      source: 'record' as const,
      record: owner.record,
      selector: `${owner.selector}/children/${index}`,
      digest: canonicalValueDigest(child),
    }
    const elements = [
      ...child.snapshot.spec.criteria.map((item) => ({ kind: 'criterion' as const, id: item.id })),
      ...child.snapshot.spec.invariants.map((item) => ({ kind: 'invariant' as const, id: item.id })),
      ...child.snapshot.spec.exclusions.map((_, index) => ({ kind: 'exclusion' as const, index })),
    ]
    for (const element of elements)
      constraints.push({
        kind: 'engaged',
        parent: exact.accepted.ref,
        engagement,
        child: child.scope,
        version: child.specVersion,
        element,
      })
  }
}

function addProposedChildren(constraints: Constraint[], exact: AssessSpecExact) {
  const scope = exact.accepted.ref.uw
  for (const child of exact.proposed.children) {
    if ('kind' in child) {
      constraints.push(
        ...proposedConstraints(scope, child.plan.allocation.spec, {
          kind: 'created-by',
          operationId: child.operationId,
        }),
      )
      continue
    }
    const prior = exact.accepted.children.find((entry) => sameScope(entry.scope, child.scope))
    if (
      !prior ||
      prior.specVersion !== child.specVersion ||
      prior.tier !== child.tier ||
      canonicalValueDigest(prior.snapshot.spec) !== canonicalValueDigest(child.snapshot.spec)
    )
      constraints.push(...proposedConstraints(child.scope, child.snapshot.spec))
    if (!prior) {
      const source = exact.childOwnSources.find((entry) => sameScope(entry.uw, child.scope))
      if (source?.own) constraints.push(...acceptedConstraints(source.own, child.snapshot.spec, true))
      else if (!source) throw new Error('Proposed child source unavailable')
    }
  }
}

function addAttachedChildren(constraints: Constraint[], exact: AssessSpecExact) {
  for (const child of exact.attachedChildren) {
    constraints.push(...proposedConstraints(child.scope, child.snapshot.spec))
    const source = exact.childOwnSources.find((entry) => sameScope(entry.uw, child.scope))
    if (source?.own) constraints.push(...acceptedConstraints(source.own, child.snapshot.spec, true))
    else if (!source) throw new Error('Attached child source unavailable')
  }
}

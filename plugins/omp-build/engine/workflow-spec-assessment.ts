import { diagnostic } from './record-diagnostics.ts'
import { specDigest } from './record-digests.ts'
import type { ExternalRecordRef } from './record-references.ts'
import type { CanonicalRecord } from './record-schema.ts'
import type { Scope } from './record-values.ts'
import type { SpecItemId } from './uw-spec-schema.ts'
import type { AcceptedSpecResult } from './workflow-accepted-spec-types.ts'
import type { AcceptedChildCommitment } from './workflow-mandate-schema.ts'
import type { AssessSpecExact, AssessSpecResultPayload } from './workflow-receipt-schema.ts'

export type AssessResultRecord = {
  repository: string
  target: string
  version: 1
  recordId: string
  runId: string
  operationId: string
  inputs: string[]
  kind: 'action-receipt'
  payload: AssessSpecResultPayload
}
export type AssessedOwnState = AssessSpecExact['accepted']
export type MechanicalSpecDelta = AssessSpecExact['mechanical']

export function isAssessResult(record: CanonicalRecord): record is AssessResultRecord {
  return (
    record.kind === 'action-receipt' && record.payload.action === 'assess-spec' && record.payload.phase === 'result'
  )
}

function itemIds(items: readonly { id: SpecItemId; statement: string }[]): SpecItemId[] {
  return items.map((item) => item.id)
}

function changedItemStatements(
  accepted: readonly { id: SpecItemId; statement: string }[],
  proposed: readonly { id: SpecItemId; statement: string }[],
): SpecItemId[] {
  const previous = new Map(accepted.map((item) => [item.id, item.statement]))
  return proposed
    .filter((item) => previous.get(item.id) !== undefined && previous.get(item.id) !== item.statement)
    .map((item) => item.id)
}

function changedChildren(
  accepted: readonly AcceptedChildCommitment[],
  proposed: readonly AcceptedChildCommitment[],
): boolean {
  const key = (child: AcceptedChildCommitment) => `${child.scope.repository}\0${child.scope.target}`
  if (accepted.length !== proposed.length) return true
  const prior = new Map(accepted.map((child) => [key(child), `${child.specVersion}\0${child.tier}`]))
  return proposed.some((child) => prior.get(key(child)) !== `${child.specVersion}\0${child.tier}`)
}

export function mechanicalSpecDelta(
  accepted: Omit<AssessedOwnState, 'ref'>,
  proposed: Omit<AssessedOwnState, 'ref'>,
): MechanicalSpecDelta {
  const acceptedCriteria = accepted.snapshot.spec.criteria
  const proposedCriteria = proposed.snapshot.spec.criteria
  const acceptedInvariants = accepted.snapshot.spec.invariants
  const proposedInvariants = proposed.snapshot.spec.invariants
  const acceptedIds = new Set([...itemIds(acceptedCriteria), ...itemIds(acceptedInvariants)])
  const proposedIds = new Set([...itemIds(proposedCriteria), ...itemIds(proposedInvariants)])
  const added = [...proposedIds].filter((id) => !acceptedIds.has(id))
  const removed = [...acceptedIds].filter((id) => !proposedIds.has(id))
  const changedStatements = [
    ...changedItemStatements(acceptedCriteria, proposedCriteria),
    ...changedItemStatements(acceptedInvariants, proposedInvariants),
  ]
  const sectionsOrOrderChanged =
    JSON.stringify(accepted.snapshot.spec.sections) !== JSON.stringify(proposed.snapshot.spec.sections) ||
    JSON.stringify(itemIds(acceptedCriteria)) !== JSON.stringify(itemIds(proposedCriteria)) ||
    JSON.stringify(itemIds(acceptedInvariants)) !== JSON.stringify(itemIds(proposedInvariants)) ||
    JSON.stringify(accepted.snapshot.spec.openQuestions) !== JSON.stringify(proposed.snapshot.spec.openQuestions)
  return {
    added,
    removed,
    changedStatements,
    exclusionsChanged:
      JSON.stringify(accepted.snapshot.spec.exclusions) !== JSON.stringify(proposed.snapshot.spec.exclusions),
    tierChanged: accepted.tier !== proposed.tier,
    childrenChanged: changedChildren(accepted.children, proposed.children),
    sectionsOrOrderChanged,
  }
}

export function sameMechanicalDelta(left: MechanicalSpecDelta, right: MechanicalSpecDelta): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

export function isMechanical(delta: MechanicalSpecDelta): boolean {
  return (
    delta.added.length > 0 ||
    delta.removed.length > 0 ||
    delta.exclusionsChanged ||
    delta.tierChanged ||
    delta.childrenChanged
  )
}
export type AssessmentClassification = 'editorial' | 'material' | 'unknown'

export function hasMaterialAcceptanceContent(delta: MechanicalSpecDelta): boolean {
  return isMechanical(delta) || delta.changedStatements.length > 0 || delta.sectionsOrOrderChanged
}

export function requiresMaterialAcceptance(
  delta: MechanicalSpecDelta,
  classification: AssessmentClassification,
): boolean {
  return (
    isMechanical(delta) ||
    ((classification === 'material' || classification === 'unknown') && hasMaterialAcceptanceContent(delta))
  )
}

function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_, entry) => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return entry
    return Object.fromEntries(
      Object.keys(entry)
        .sort()
        .map((key) => [key, (entry as Record<string, unknown>)[key]]),
    )
  })
}

export function sameAssessedState(left: AssessedOwnState, right: AssessedOwnState): boolean {
  return stableStringify(left) === stableStringify(right)
}

export type MaterialAcceptanceProposal = {
  format: 'omp-build-material-acceptance/1'
  operationId: string
  uw: Scope
  mandate: ExternalRecordRef
  predecessor: ExternalRecordRef
  assessment: ExternalRecordRef
  classification: AssessmentClassification
  exactInputs: AssessSpecExact
}
export type PreparedMaterialAcceptance = { proposal: MaterialAcceptanceProposal; digest: string }

function refProjection(ref: ExternalRecordRef) {
  return {
    scope: { repository: ref.scope.repository, target: ref.scope.target },
    recordId: ref.recordId,
    kind: ref.kind,
  }
}

function snapshotProjection(snapshot: AssessSpecExact['proposed']['snapshot']) {
  return {
    spec: {
      format: snapshot.spec.format,
      criteria: snapshot.spec.criteria.map((item) => ({ id: item.id, statement: item.statement })),
      invariants: snapshot.spec.invariants.map((item) => ({ id: item.id, statement: item.statement })),
      exclusions: [...snapshot.spec.exclusions],
      openQuestions: [...snapshot.spec.openQuestions],
      sections: { ...snapshot.spec.sections },
      version: snapshot.spec.version,
    },
    raw: {
      reference: snapshot.raw.reference,
      body: snapshot.raw.body,
      bodySha256: snapshot.raw.bodySha256,
      lastEditedAt: snapshot.raw.lastEditedAt,
    },
  }
}

function childrenProjection(children: AssessSpecExact['proposed']['children']) {
  return children.map((child) => ({
    scope: { repository: child.scope.repository, target: child.scope.target },
    specVersion: child.specVersion,
    snapshot: snapshotProjection(child.snapshot),
    tier: child.tier,
  }))
}

function currentSnapshotProjection(snapshot: AssessSpecExact['proposed']['snapshot']) {
  return {
    spec: {
      format: snapshot.spec.format,
      criteria: snapshot.spec.criteria.map((item) => ({ id: item.id, statement: item.statement })),
      invariants: snapshot.spec.invariants.map((item) => ({ id: item.id, statement: item.statement })),
      exclusions: [...snapshot.spec.exclusions],
      openQuestions: [...snapshot.spec.openQuestions],
      sections: { ...snapshot.spec.sections },
      version: snapshot.spec.version,
    },
    raw: {
      reference: snapshot.raw.reference,
      body: snapshot.raw.body,
      bodySha256: snapshot.raw.bodySha256,
    },
  }
}

function currentChildrenProjection(children: AssessSpecExact['proposed']['children']) {
  return children.map((child) => ({
    scope: { repository: child.scope.repository, target: child.scope.target },
    specVersion: child.specVersion,
    snapshot: currentSnapshotProjection(child.snapshot),
    tier: child.tier,
  }))
}

/**
 * Compares a persisted proposal with freshly observed native state. Timestamps
 * are descriptive observation metadata; every content, identity, tier, and
 * child commitment field remains exact.
 */
export function sameCurrentAssessedState(
  left: AssessSpecExact['proposed'],
  right: AssessSpecExact['proposed'],
): boolean {
  return (
    JSON.stringify({
      snapshot: currentSnapshotProjection(left.snapshot),
      tier: left.tier,
      children: currentChildrenProjection(left.children),
    }) ===
    JSON.stringify({
      snapshot: currentSnapshotProjection(right.snapshot),
      tier: right.tier,
      children: currentChildrenProjection(right.children),
    })
  )
}

export function materialAcceptanceDigest(value: MaterialAcceptanceProposal): string {
  const exact = value.exactInputs
  const projection = {
    format: value.format,
    operationId: value.operationId,
    uw: { repository: value.uw.repository, target: value.uw.target },
    mandate: refProjection(value.mandate),
    predecessor: refProjection(value.predecessor),
    assessment: refProjection(value.assessment),
    classification: value.classification,
    exactInputs: {
      format: exact.format,
      accepted: {
        ref: {
          uw: { repository: exact.accepted.ref.uw.repository, target: exact.accepted.ref.uw.target },
          version: exact.accepted.ref.version,
          sourceAccepted: refProjection(exact.accepted.ref.sourceAccepted),
        },
        snapshot: snapshotProjection(exact.accepted.snapshot),
        tier: exact.accepted.tier,
        children: childrenProjection(exact.accepted.children),
      },
      proposed: {
        snapshot: snapshotProjection(exact.proposed.snapshot),
        tier: exact.proposed.tier,
        children: childrenProjection(exact.proposed.children),
      },
      identityAllocations: exact.identityAllocations.map(refProjection),
      mechanical: {
        added: [...exact.mechanical.added],
        removed: [...exact.mechanical.removed],
        changedStatements: [...exact.mechanical.changedStatements],
        exclusionsChanged: exact.mechanical.exclusionsChanged,
        tierChanged: exact.mechanical.tierChanged,
        childrenChanged: exact.mechanical.childrenChanged,
        sectionsOrOrderChanged: exact.mechanical.sectionsOrOrderChanged,
      },
    },
  }
  return specDigest(JSON.stringify(projection))
}

export function sameAssessInputs(left: AssessSpecExact, right: AssessSpecExact): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

type SpecChainFailure = Extract<AcceptedSpecResult, { ok: false }>

export function specChainFailure(reason: SpecChainFailure['reason'], message: string, code?: string): SpecChainFailure {
  return { ok: false, reason, evidence: [diagnostic(code ?? reason, message)] }
}

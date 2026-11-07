import { canonicalValueDigest } from './canonical-value.ts'
import type { DecodedHistory } from './history-schema.ts'
import { sameOwnSpecRef, sameRef } from './record-diagnostics.ts'
import type { ExternalRecordRef } from './record-references.ts'
import type { OwnSpecRef } from './uw-spec-schema.ts'
import type { AcceptedOwnSpec, AcceptedSpecResult, AcceptedSpecStep } from './workflow-accepted-spec-types.ts'
import { type MandateRecord, recordsOf } from './workflow-control.ts'
import { qualifyEditorialCandidate } from './workflow-editorial-qualification.ts'
import { concreteAcceptedStateSchema } from './workflow-mandate-schema.ts'
import { type MaterialControl, materialContinuation } from './workflow-material-continuation.ts'
import type { SpecAssessment } from './workflow-output-schema.ts'
import { type AssessResultRecord, specChainFailure } from './workflow-spec-assessment.ts'
import { receiptRef } from './workflow-spec-authentication.ts'

type SpecChainFailure = Extract<AcceptedSpecResult, { ok: false }>
type EditorialCandidates =
  | { status: 'refused'; result: SpecChainFailure }
  | { status: 'candidates'; editorials: AssessResultRecord[]; materialClaims: number }
type Continuation =
  | { status: 'complete' }
  | { status: 'refused'; result: SpecChainFailure }
  | {
      status: 'continued'
      spec: AcceptedOwnSpec
      predecessor: ExternalRecordRef
      applied: string
      step: AcceptedSpecStep
      refs: ExternalRecordRef[]
    }

function editorialCandidates(
  home: DecodedHistory,
  histories: readonly DecodedHistory[],
  mandateRef: ExternalRecordRef,
  applied: ReadonlySet<string>,
  accepted: AcceptedOwnSpec,
  deferCompatibility: (record: AssessResultRecord, assessment: SpecAssessment, refusal?: SpecChainFailure) => void,
): EditorialCandidates {
  const editorials: AssessResultRecord[] = []
  let materialClaims = 0
  for (const record of recordsOf(home)) {
    const qualified = qualifyEditorialCandidate(record, {
      histories,
      mandateRef,
      applied,
      accepted,
      deferCompatibility,
    })
    if (qualified.status === 'refused') return qualified
    if (qualified.status === 'material') {
      materialClaims += 1
      continue
    }
    if (qualified.status === 'editorial') editorials.push(qualified.record)
  }
  return { status: 'candidates', editorials, materialClaims }
}

function materialCandidates(
  home: DecodedHistory,
  mandateRef: ExternalRecordRef,
  applied: ReadonlySet<string>,
  predecessor: ExternalRecordRef,
): MaterialControl[] {
  return recordsOf(home).filter(
    (record): record is MaterialControl =>
      record.kind === 'operator-control' &&
      record.payload.control === 'accept-material' &&
      sameRef(record.payload.mandate, mandateRef) &&
      !applied.has(record.recordId) &&
      sameRef(record.payload.predecessor, predecessor),
  )
}

function nextAcceptedSpecStep(input: {
  home: DecodedHistory
  histories: readonly DecodedHistory[]
  mandateRef: ExternalRecordRef
  applied: ReadonlySet<string>
  accepted: AcceptedOwnSpec
  predecessor: ExternalRecordRef
  deferCompatibility: (record: AssessResultRecord, assessment: SpecAssessment, refusal?: SpecChainFailure) => void
}): Continuation {
  const { home, histories, mandateRef, applied, accepted, predecessor, deferCompatibility } = input
  const candidates = editorialCandidates(home, histories, mandateRef, applied, accepted, deferCompatibility)
  if (candidates.status === 'refused') return candidates
  const materials = materialCandidates(home, mandateRef, applied, predecessor)
  if (
    candidates.editorials.length > 1 ||
    materials.length > 1 ||
    (candidates.editorials.length > 0 && (materials.length > 0 || candidates.materialClaims > 0))
  )
    return {
      status: 'refused',
      result: specChainFailure('ambiguous', 'Competing Spec successors continue the same accepted Spec'),
    }
  const editorial = candidates.editorials[0]
  if (editorial !== undefined) {
    const parsedProposed = concreteAcceptedStateSchema.safeParse(editorial.payload.exactInputs.proposed)
    if (!parsedProposed.success)
      return {
        status: 'refused',
        result: specChainFailure('material-spec', 'Editorial acceptance cannot bind a created child slot'),
      }
    const proposed = parsedProposed.data
    const source = receiptRef(editorial)
    return {
      status: 'continued',
      spec: {
        ref: { uw: accepted.ref.uw, version: proposed.snapshot.spec.version, sourceAccepted: source },
        snapshot: proposed.snapshot,
        tier: proposed.tier,
        children: proposed.children,
        inheritedOwnSpecRefs: proposed.inheritedOwnSpecRefs,
        coverage: proposed.coverage,
        chain: accepted.chain,
        sourceRefs: accepted.sourceRefs,
      },
      predecessor: source,
      applied: editorial.recordId,
      step: { kind: 'editorial', source, from: accepted.snapshot.spec.version, to: proposed.snapshot.spec.version },
      refs: [source, ...editorial.payload.exactInputs.identityAllocations],
    }
  }
  const material = materials[0]
  if (material === undefined) return { status: 'complete' }
  const continued = materialContinuation(material, histories, mandateRef, predecessor, accepted, deferCompatibility)
  if (!continued.ok) return { status: 'refused', result: continued.result }
  const proposed = continued.state
  const source = receiptRef(material)
  const sameOwn =
    accepted.tier === proposed.tier &&
    canonicalValueDigest(accepted.inheritedOwnSpecRefs) === canonicalValueDigest(proposed.inheritedOwnSpecRefs) &&
    canonicalValueDigest({ ...accepted.snapshot, raw: { ...accepted.snapshot.raw, lastEditedAt: null } }) ===
      canonicalValueDigest({ ...proposed.snapshot, raw: { ...proposed.snapshot.raw, lastEditedAt: null } })
  return {
    status: 'continued',
    spec: {
      ref: sameOwn
        ? accepted.ref
        : { uw: accepted.ref.uw, version: proposed.snapshot.spec.version, sourceAccepted: source },
      snapshot: sameOwn ? accepted.snapshot : proposed.snapshot,
      tier: proposed.tier,
      children: proposed.children,
      inheritedOwnSpecRefs: proposed.inheritedOwnSpecRefs,
      coverage: proposed.coverage,
      chain: accepted.chain,
      sourceRefs: accepted.sourceRefs,
    },
    predecessor: source,
    applied: material.recordId,
    step: {
      kind: 'accept-material',
      source,
      assessment: material.payload.assessment,
      from: accepted.snapshot.spec.version,
      to: proposed.snapshot.spec.version,
      proposalDigest: material.payload.proposalDigest,
    },
    refs: [source, material.payload.assessment, ...continued.assessment.payload.exactInputs.identityAllocations],
  }
}

export function resolveAcceptedSpecChain(input: {
  confirmed: MandateRecord
  home: DecodedHistory
  histories: readonly DecodedHistory[]
  mandateRef: ExternalRecordRef
  target?: OwnSpecRef
  prefixes?: AcceptedOwnSpec[]
  scope: ExternalRecordRef['scope']
  deferCompatibility: (record: AssessResultRecord, assessment: SpecAssessment, refusal?: SpecChainFailure) => void
}): AcceptedSpecResult {
  const { confirmed, home, histories, mandateRef } = input
  const initial: AcceptedOwnSpec = {
    ref: {
      uw: confirmed.payload.ownSpec.uw,
      version: confirmed.payload.ownSpec.version,
      sourceAccepted: mandateRef,
    },
    snapshot: confirmed.payload.ownSpec.snapshot,
    tier: confirmed.payload.tier,
    children: confirmed.payload.children,
    inheritedOwnSpecRefs: confirmed.payload.inheritedOwnSpecRefs,
    coverage: confirmed.payload.coverage,
    chain: [{ kind: 'mandate', source: mandateRef, version: confirmed.payload.ownSpec.version }],
    sourceRefs: [mandateRef, ...confirmed.payload.ownSpec.identityAllocations],
  }
  const applied = new Set<string>([confirmed.recordId])
  let accepted = initial
  input.prefixes?.push(initial)
  let selected = input.target && sameOwnSpecRef(initial.ref, input.target) ? initial : undefined
  let predecessor = mandateRef
  for (let guard = 0; guard < recordsOf(home).length + 1; guard += 1) {
    const step = nextAcceptedSpecStep({
      home,
      histories,
      mandateRef,
      applied,
      accepted,
      predecessor,
      deferCompatibility: input.deferCompatibility,
    })
    if (step.status === 'refused') return step.result
    if (step.status === 'complete') break
    accepted = {
      ...step.spec,
      chain: [...accepted.chain, step.step],
      sourceRefs: [...accepted.sourceRefs, ...step.refs],
    }
    if (input.target && selected === undefined && sameOwnSpecRef(accepted.ref, input.target)) selected = accepted
    input.prefixes?.push(accepted)
    predecessor = step.predecessor
    applied.add(step.applied)
  }
  if (input.target) {
    if (!selected) return specChainFailure('incomplete', 'Requested Spec is not an authenticated accepted prefix')
    return { ok: true, spec: selected }
  }
  return { ok: true, spec: accepted }
}

import type { DecodedHistory } from './history-schema.ts'
import { sameRef } from './record-diagnostics.ts'
import type { ExternalRecordRef } from './record-references.ts'
import type { AcceptedOwnSpec, AcceptedSpecResult, AcceptedSpecStep } from './workflow-accepted-spec-types.ts'
import {
  bindExternalRef,
  type ControlRecord,
  historyFor,
  type MandateRecord,
  recordsOf,
  workflowOperationProblem,
} from './workflow-control.ts'
import { qualifyEditorialCandidate } from './workflow-editorial-qualification.ts'
import { specAssessmentSchema } from './workflow-output-schema.ts'
import {
  type AssessResultRecord,
  type MaterialAcceptanceProposal,
  materialAcceptanceDigest,
  mechanicalSpecDelta,
  requiresMaterialAcceptance,
  sameAssessedState,
  sameMechanicalDelta,
  specChainFailure,
} from './workflow-spec-assessment.ts'
import { receiptRef } from './workflow-spec-authentication.ts'
import { authenticatedAssessResult } from './workflow-spec-authentication-chain.ts'

type SpecChainFailure = Extract<AcceptedSpecResult, { ok: false }>
type EditorialCandidates =
  | { status: 'refused'; result: SpecChainFailure }
  | { status: 'candidates'; editorials: AssessResultRecord[]; materialClaims: number }
type MaterialControl = ControlRecord & {
  payload: Extract<ControlRecord['payload'], { control: 'accept-material' }>
}
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
): EditorialCandidates {
  const editorials: AssessResultRecord[] = []
  let materialClaims = 0
  for (const record of recordsOf(home)) {
    const qualified = qualifyEditorialCandidate(record, { histories, mandateRef, applied, accepted })
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

function bindingFailure(diagnostics: SpecChainFailure['evidence']): SpecChainFailure {
  const code = diagnostics[0]?.code
  return {
    ok: false,
    reason:
      code === 'conflict' || code === 'ambiguous'
        ? 'ambiguous'
        : code === 'missing-history'
          ? 'missing-history'
          : 'incomplete',
    evidence: diagnostics,
  }
}

function materialContinuation(
  material: MaterialControl,
  histories: readonly DecodedHistory[],
  mandateRef: ExternalRecordRef,
  predecessor: ExternalRecordRef,
  accepted: AcceptedOwnSpec,
): { ok: true; assessment: AssessResultRecord } | { ok: false; result: SpecChainFailure } {
  const assessmentHistory = historyFor(material.payload.assessment.scope, histories)
  if (assessmentHistory === null)
    return { ok: false, result: specChainFailure('missing-history', 'Spec assessment history is missing') }
  const problem = workflowOperationProblem(assessmentHistory)
  if (problem === 'ambiguous')
    return { ok: false, result: specChainFailure('ambiguous', 'Spec assessment history conflicts') }
  if (problem === 'unconfirmed' || problem === 'incomplete')
    return { ok: false, result: specChainFailure('incomplete', 'Spec assessment history is not confirmed', problem) }
  const bound = bindExternalRef(material.payload.assessment, assessmentHistory)
  if (!bound.ok) return { ok: false, result: bindingFailure(bound.diagnostics) }
  const authenticated = authenticatedAssessResult(bound.value, histories, mandateRef)
  if (!authenticated.ok) return { ok: false, result: authenticated }
  const assessment = authenticated.record
  const parsed = specAssessmentSchema.safeParse(assessment.payload.structured)
  if (!parsed.success)
    return { ok: false, result: specChainFailure('incomplete', 'Applicable spec assessment is malformed') }
  const exact = assessment.payload.exactInputs
  if (
    !sameAssessedState(exact.accepted, {
      ref: accepted.ref,
      snapshot: accepted.snapshot,
      tier: accepted.tier,
      children: accepted.children,
    })
  )
    return {
      ok: false,
      result: specChainFailure('material-spec', 'Material assessment does not continue the accepted Spec'),
    }
  const mechanical = mechanicalSpecDelta(exact.accepted, exact.proposed)
  if (!sameMechanicalDelta(mechanical, exact.mechanical))
    return { ok: false, result: specChainFailure('incomplete', 'Material assessment mechanical delta is inconsistent') }
  if (!requiresMaterialAcceptance(mechanical, parsed.data.classification))
    return {
      ok: false,
      result: specChainFailure('material-spec', 'Material assessment does not require material acceptance'),
    }
  const proposal: MaterialAcceptanceProposal = {
    format: 'omp-build-material-acceptance/1',
    operationId: material.operationId,
    uw: accepted.ref.uw,
    mandate: mandateRef,
    predecessor,
    assessment: material.payload.assessment,
    classification: parsed.data.classification,
    exactInputs: exact,
  }
  if (
    material.payload.specVersion !== exact.proposed.snapshot.spec.version ||
    material.payload.proposalDigest !== materialAcceptanceDigest(proposal) ||
    material.payload.confirmation.operationId !== proposal.operationId ||
    material.payload.confirmation.proposalDigest !== material.payload.proposalDigest ||
    JSON.stringify(material.payload.identityDelta.retired) !== JSON.stringify(mechanical.removed)
  )
    return {
      ok: false,
      result: specChainFailure('material-spec', 'Material acceptance does not bind the exact proposal'),
    }
  return { ok: true, assessment }
}

function nextAcceptedSpecStep(input: {
  home: DecodedHistory
  histories: readonly DecodedHistory[]
  mandateRef: ExternalRecordRef
  applied: ReadonlySet<string>
  accepted: AcceptedOwnSpec
  predecessor: ExternalRecordRef
}): Continuation {
  const { home, histories, mandateRef, applied, accepted, predecessor } = input
  const candidates = editorialCandidates(home, histories, mandateRef, applied, accepted)
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
    const proposed = editorial.payload.exactInputs.proposed
    const source = receiptRef(editorial)
    return {
      status: 'continued',
      spec: {
        ref: { uw: accepted.ref.uw, version: proposed.snapshot.spec.version, sourceAccepted: source },
        snapshot: proposed.snapshot,
        tier: proposed.tier,
        children: proposed.children,
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
  const continued = materialContinuation(material, histories, mandateRef, predecessor, accepted)
  if (!continued.ok) return { status: 'refused', result: continued.result }
  const proposed = continued.assessment.payload.exactInputs.proposed
  const source = receiptRef(material)
  return {
    status: 'continued',
    spec: {
      ref: { uw: accepted.ref.uw, version: proposed.snapshot.spec.version, sourceAccepted: source },
      snapshot: proposed.snapshot,
      tier: proposed.tier,
      children: proposed.children,
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
  scope: ExternalRecordRef['scope']
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
    chain: [{ kind: 'mandate', source: mandateRef, version: confirmed.payload.ownSpec.version }],
    sourceRefs: [mandateRef, ...confirmed.payload.ownSpec.identityAllocations],
  }
  const applied = new Set<string>([confirmed.recordId])
  let accepted = initial
  let predecessor = mandateRef
  for (let guard = 0; guard < recordsOf(home).length + 1; guard += 1) {
    const step = nextAcceptedSpecStep({ home, histories, mandateRef, applied, accepted, predecessor })
    if (step.status === 'refused') return step.result
    if (step.status === 'complete') break
    accepted = {
      ...step.spec,
      chain: [...accepted.chain, step.step],
      sourceRefs: [...accepted.sourceRefs, ...step.refs],
    }
    predecessor = step.predecessor
    applied.add(step.applied)
  }
  return { ok: true, spec: accepted }
}

import type { DecodedHistory } from './history-schema.ts'
import { specDigest } from './record-digests.ts'
import type { ExternalRecordRef } from './record-references.ts'
import type { AcceptedSpec, AcceptedSpecRef, AcceptedSpecResult } from './workflow-accepted-spec.ts'
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
import { type AssessResultRecord, receiptRef, specChainFailure } from './workflow-spec-authentication.ts'
import { authenticatedAssessResult } from './workflow-spec-authentication-chain.ts'
import { equalScope, sameRef } from './workflow-support.ts'

type SpecChainFailure = Extract<AcceptedSpecResult, { ok: false }>
type EditorialCandidates =
  | { status: 'refused'; result: SpecChainFailure }
  | { status: 'candidates'; editorials: AssessResultRecord[]; materialClaims: number }
type MaterialContinuation =
  | { status: 'refused'; result: SpecChainFailure }
  | { status: 'continued'; assessment: AssessResultRecord }
type MaterialControl = ControlRecord & {
  payload: Extract<ControlRecord['payload'], { control: 'accept-material' }>
}

function editorialCandidates(
  home: DecodedHistory,
  histories: readonly DecodedHistory[],
  mandateRef: ExternalRecordRef,
  applied: ReadonlySet<string>,
  body: string,
  digest: string,
): EditorialCandidates {
  const editorials: AssessResultRecord[] = []
  let materialClaims = 0
  for (const record of recordsOf(home)) {
    const qualified = qualifyEditorialCandidate(record, { histories, mandateRef, applied, body, digest })
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
  head: string,
  scope: ExternalRecordRef['scope'],
): MaterialControl[] {
  return recordsOf(home).filter(
    (record): record is MaterialControl =>
      record.kind === 'operator-control' &&
      record.payload.control === 'accept-material' &&
      sameRef(record.payload.mandate, mandateRef) &&
      !applied.has(record.recordId) &&
      record.payload.predecessor.recordId === head &&
      equalScope(record.payload.predecessor.scope, scope),
  )
}

function bindingFailure(diagnostics: SpecChainFailure['evidence']): SpecChainFailure {
  const code = diagnostics[0]?.code
  const reason =
    code === 'conflict' || code === 'ambiguous'
      ? 'ambiguous'
      : code === 'missing-history'
        ? 'missing-history'
        : 'incomplete'
  return { ok: false, reason, evidence: diagnostics }
}

function authenticatedMaterialAssessment(
  material: MaterialControl,
  histories: readonly DecodedHistory[],
  mandateRef: ExternalRecordRef,
): MaterialContinuation {
  const assessmentHistory = historyFor(material.payload.assessment.scope, histories)
  if (assessmentHistory === null) {
    return { status: 'refused', result: specChainFailure('missing-history', 'Spec assessment history is missing') }
  }
  const assessmentProblem = workflowOperationProblem(assessmentHistory)
  if (assessmentProblem === 'ambiguous') {
    return { status: 'refused', result: specChainFailure('ambiguous', 'Spec assessment history conflicts') }
  }
  if (assessmentProblem === 'unconfirmed' || assessmentProblem === 'incomplete') {
    return {
      status: 'refused',
      result: specChainFailure('incomplete', 'Spec assessment history is not confirmed', assessmentProblem),
    }
  }
  const bound = bindExternalRef(material.payload.assessment, assessmentHistory)
  if (!bound.ok) return { status: 'refused', result: bindingFailure(bound.diagnostics) }
  const authenticated = authenticatedAssessResult(bound.value, histories, mandateRef)
  if (!authenticated.ok) return { status: 'refused', result: authenticated }
  const parsed = specAssessmentSchema.safeParse(authenticated.record.payload.structured)
  if (!parsed.success) {
    return { status: 'refused', result: specChainFailure('incomplete', 'Applicable spec assessment is malformed') }
  }
  if (parsed.data.classification === 'unknown') {
    return { status: 'refused', result: specChainFailure('ambiguous', 'Applicable spec assessment is unknown') }
  }
  return { status: 'continued', assessment: authenticated.record }
}

function materialMatchesAcceptedSpec(
  material: MaterialControl,
  assessment: AssessResultRecord,
  body: string,
  digest: string,
): SpecChainFailure | null {
  const assessed = assessment.payload.exactInputs
  if (assessed.acceptedBody !== body || assessed.acceptedDigest !== digest) {
    return specChainFailure('material-spec', 'Material assessment does not continue the accepted spec')
  }
  if (
    assessed.currentDigest !== material.payload.specDigest ||
    specDigest(assessed.currentBody) !== material.payload.specDigest
  ) {
    return specChainFailure('material-spec', 'Accepted material spec does not match its assessment')
  }
  return null
}

type AcceptedSpecStep =
  | { status: 'refused'; result: SpecChainFailure }
  | { status: 'complete' }
  | {
      status: 'continued'
      body: string
      digest: string
      head: string
      applied: string
      chainRef: AcceptedSpecRef
      sourceRefs: readonly ExternalRecordRef[]
    }

function nextAcceptedSpecStep(input: {
  home: DecodedHistory
  histories: readonly DecodedHistory[]
  mandateRef: ExternalRecordRef
  scope: ExternalRecordRef['scope']
  applied: ReadonlySet<string>
  body: string
  digest: string
  head: string
}): AcceptedSpecStep {
  const { home, histories, mandateRef, scope, applied, body, digest, head } = input
  const candidates = editorialCandidates(home, histories, mandateRef, applied, body, digest)
  if (candidates.status === 'refused') return candidates
  const materials = materialCandidates(home, mandateRef, applied, head, scope)
  if (candidates.editorials.length > 1)
    return {
      status: 'refused',
      result: specChainFailure('ambiguous', 'Competing editorial successors continue the same accepted spec'),
    }
  if (candidates.editorials.length > 0 && candidates.materialClaims > 0)
    return {
      status: 'refused',
      result: specChainFailure('ambiguous', 'Editorial and material assessments both continue the accepted spec'),
    }
  if (materials.length > 1)
    return {
      status: 'refused',
      result: specChainFailure('ambiguous', 'Competing material acceptances continue the same accepted spec'),
    }
  if (candidates.editorials.length === 1 && materials.length === 1)
    return {
      status: 'refused',
      result: specChainFailure('ambiguous', 'Editorial and material successors both continue the accepted spec'),
    }
  const editorial = candidates.editorials[0]
  if (editorial !== undefined) {
    const inputs = editorial.payload.exactInputs
    return {
      status: 'continued',
      body: inputs.currentBody,
      digest: inputs.currentDigest,
      head: editorial.recordId,
      applied: editorial.recordId,
      chainRef: {
        kind: 'editorial',
        recordId: editorial.recordId,
        scope,
        acceptedDigest: inputs.acceptedDigest,
        currentDigest: inputs.currentDigest,
      },
      sourceRefs: [receiptRef(editorial)],
    }
  }
  const material = materials[0]
  if (material === undefined) return { status: 'complete' }
  const continuation = authenticatedMaterialAssessment(material, histories, mandateRef)
  if (continuation.status === 'refused') return continuation
  const mismatch = materialMatchesAcceptedSpec(material, continuation.assessment, body, digest)
  if (mismatch !== null) return { status: 'refused', result: mismatch }
  const assessed = continuation.assessment.payload.exactInputs
  return {
    status: 'continued',
    body: assessed.currentBody,
    digest: assessed.currentDigest,
    head: material.recordId,
    applied: material.recordId,
    chainRef: {
      kind: 'accept-material',
      recordId: material.recordId,
      scope,
      specDigest: assessed.currentDigest,
      assessment: material.payload.assessment,
    },
    sourceRefs: [receiptRef(material), material.payload.assessment],
  }
}

export function resolveAcceptedSpecChain(input: {
  confirmed: MandateRecord
  home: DecodedHistory
  histories: readonly DecodedHistory[]
  mandateRef: ExternalRecordRef
  scope: ExternalRecordRef['scope']
}): AcceptedSpecResult {
  const { confirmed, home, histories, mandateRef, scope } = input
  const applied = new Set<string>([confirmed.recordId])
  let body = confirmed.payload.spec.body
  let digest = confirmed.payload.spec.bodySha256
  let head = confirmed.recordId
  const chain: AcceptedSpecRef[] = [{ kind: 'mandate', recordId: confirmed.recordId, scope, specDigest: digest }]
  const sourceRefs: ExternalRecordRef[] = [mandateRef]
  for (let guard = 0; guard < recordsOf(home).length + 1; guard += 1) {
    const step = nextAcceptedSpecStep({ home, histories, mandateRef, scope, applied, body, digest, head })
    if (step.status === 'refused') return step.result
    if (step.status === 'complete') break
    body = step.body
    digest = step.digest
    head = step.head
    applied.add(step.applied)
    chain.push(step.chainRef)
    sourceRefs.push(...step.sourceRefs)
  }
  const spec: AcceptedSpec = {
    reference: confirmed.payload.spec.reference,
    body,
    digest,
    lastEditedAt: confirmed.payload.spec.lastEditedAt,
    chain,
    sourceRefs,
  }
  return { ok: true, spec }
}

import { canonicalValueDigest } from '../engine/action-input.ts'
import type { ActionInputs } from '../engine/action-input-schema.ts'
import { type CriterionEvidence, criterionEvidenceSchema } from '../engine/criterion-evidence-schema.ts'
import type { CanonicalRecord } from '../engine/record-schema.ts'
import type { MandateRecord } from '../engine/workflow-control.ts'

function declarationAt(record: CanonicalRecord | undefined, selector: string, mandate: MandateRecord) {
  if (record?.kind === 'fix-result') {
    const match = /^\/payload\/criterionReceipt\/criteria\/(0|[1-9]\d*)$/.exec(selector)
    return match === null ? undefined : record.payload.criterionReceipt?.criteria[Number(match[1])]
  }
  const match = /^\/payload\/structured\/criteria\/(0|[1-9]\d*)$/.exec(selector)
  if (
    match === null ||
    record?.kind !== 'action-receipt' ||
    (record.payload.action !== 'implement' && record.payload.action !== 'integrate') ||
    record.payload.phase !== 'result' ||
    record.payload.admission?.admitted !== true ||
    record.repository !== mandate.repository ||
    record.target !== mandate.target ||
    record.payload.structured === null ||
    !('criteria' in record.payload.structured)
  )
    return undefined
  return record.payload.structured.criteria[Number(match[1])]
}

export function capturedCriterionEvidence(options: {
  mandate: MandateRecord
  inputs: Pick<ActionInputs, 'manifest'>
  head: string
  issueRecords: readonly CanonicalRecord[]
}) {
  const { mandate, inputs, head, issueRecords } = options
  if (
    inputs.manifest.spec.kind !== 'accepted' ||
    inputs.manifest.code.head !== head ||
    inputs.manifest.spec.effective.own.sourceAccepted.recordId !== mandate.recordId
  )
    throw new Error('Expected captured accepted inputs for the mandate and candidate head')
  const acceptedOwn = inputs.manifest.spec.effective.own
  const evidenceForTarget = (value: unknown, target: CriterionEvidence['target']) => {
    const captured = criterionEvidenceSchema.safeParse(value)
    if (!captured.success || captured.data.method !== 'test') return undefined
    const evidence = captured.data
    if (
      canonicalValueDigest(evidence.target) !== canonicalValueDigest(target) ||
      canonicalValueDigest(evidence.target.spec) !== canonicalValueDigest(acceptedOwn) ||
      evidence.code.repository !== inputs.manifest.code.repository ||
      evidence.code.commit !== head
    )
      return undefined
    return evidence
  }
  const selectedEvidence = (selection: ActionInputs['manifest']['deliveryData'][number]) => {
    if (selection.role !== 'implementation') return undefined
    const record = issueRecords.find(
      (candidate) =>
        candidate.kind === selection.record.kind &&
        candidate.recordId === selection.record.recordId &&
        candidate.repository === selection.record.scope.repository &&
        candidate.target === selection.record.scope.target,
    )
    const declaration = declarationAt(record, selection.selector, mandate)
    if (
      declaration?.target.id !== 'C1' ||
      declaration.verification !== 'evidence' ||
      declaration.evidence.length !== 1 ||
      canonicalValueDigest(declaration) !== selection.digest
    )
      return undefined
    const evidence = evidenceForTarget(declaration.evidence[0], declaration.target)
    if (evidence === undefined) return undefined
    return { selection, evidence }
  }
  const matches: {
    selection: ActionInputs['manifest']['deliveryData'][number]
    evidence: Extract<CriterionEvidence, { method: 'test' }>
  }[] = []
  for (const selection of inputs.manifest.deliveryData) {
    const match = selectedEvidence(selection)
    if (match !== undefined) matches.push(match)
  }
  if (matches.length !== 1 || !matches[0]) throw new Error('Expected exactly one captured criterion evidence pin')
  return matches[0]
}

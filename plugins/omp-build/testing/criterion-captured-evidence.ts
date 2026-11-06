import { canonicalValueDigest } from '../engine/action-input.ts'
import type { ActionInputs } from '../engine/action-input-schema.ts'
import { type CriterionEvidence, criterionEvidenceSchema } from '../engine/criterion-evidence-schema.ts'
import type { CanonicalRecord } from '../engine/record-schema.ts'
import type { MandateRecord } from '../engine/workflow-control.ts'

export function capturedCriterionEvidence(options: {
  mandate: MandateRecord
  inputs: ActionInputs
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
    if (selection.role !== 'implementation' || selection.record.kind !== 'action-receipt') return undefined
    const match = /^\/payload\/structured\/criteria\/(0|[1-9]\d*)$/.exec(selection.selector)
    if (match === null) return undefined
    const implementation = issueRecords.find(
      (record) =>
        record.kind === 'action-receipt' &&
        record.recordId === selection.record.recordId &&
        record.repository === selection.record.scope.repository &&
        record.target === selection.record.scope.target,
    )
    if (
      implementation?.kind !== 'action-receipt' ||
      (implementation.payload.action !== 'implement' && implementation.payload.action !== 'integrate') ||
      implementation.payload.phase !== 'result' ||
      implementation.payload.admission?.admitted !== true ||
      implementation.repository !== mandate.repository ||
      implementation.target !== mandate.target ||
      implementation.payload.structured === null ||
      !('criteria' in implementation.payload.structured)
    )
      return undefined
    const declaration = implementation.payload.structured.criteria[Number(match[1])]
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

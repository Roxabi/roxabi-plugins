import { diagnostic } from './record-diagnostics.ts'
import type { CanonicalRecord } from './record-schema.ts'
import type { Diagnostic } from './record-values.ts'

function validateFixRequest(
  record: Extract<CanonicalRecord, { kind: 'fix-request' }>,
  records: Map<string, CanonicalRecord>,
  diagnostics: Diagnostic[],
): void {
  const request = records.get(record.payload.requestContributionId)
  if (request?.kind !== 'contribution')
    diagnostics.push(diagnostic('unknown-reference', `Fix request ${record.recordId} lacks its request contribution`))
  if (!record.inputs.includes(record.payload.requestContributionId))
    diagnostics.push(diagnostic('unbound', `Fix request ${record.recordId} does not bind its request contribution`))
  if (record.payload.existingReviewId !== null) {
    const review = records.get(record.payload.existingReviewId)
    if (review?.kind !== 'review' || !record.inputs.includes(record.payload.existingReviewId))
      diagnostics.push(diagnostic('unknown-reference', `Fix request ${record.recordId} lacks its existing review`))
  }
}

function validateCorrectionResult(
  record: Extract<CanonicalRecord, { kind: 'correction-result' }>,
  records: Map<string, CanonicalRecord>,
  diagnostics: Diagnostic[],
): void {
  const decision = records.get(record.payload.decisionId)
  if (
    decision?.kind !== 'decision' ||
    !decision.payload.judgment.causes.some((cause) => cause.id === record.payload.causeId)
  )
    diagnostics.push(diagnostic('unknown-reference', `Correction ${record.recordId} lacks its decision cause`))
  if (!record.inputs.includes(record.payload.decisionId))
    diagnostics.push(diagnostic('unbound', `Correction ${record.recordId} does not bind its decision`))
}

function validateFalsificationResult(
  record: Extract<CanonicalRecord, { kind: 'falsification-result' }>,
  records: Map<string, CanonicalRecord>,
  diagnostics: Diagnostic[],
): void {
  const correction = records.get(record.payload.correctionResultId)
  if (correction?.kind !== 'correction-result')
    diagnostics.push(diagnostic('unknown-reference', `Falsification ${record.recordId} lacks its correction result`))
  if (!record.inputs.includes(record.payload.correctionResultId))
    diagnostics.push(diagnostic('unbound', `Falsification ${record.recordId} does not bind its correction result`))
}

function validateDebtReceipt(
  record: Extract<CanonicalRecord, { kind: 'debt-receipt' }>,
  records: Map<string, CanonicalRecord>,
  diagnostics: Diagnostic[],
): void {
  const decision = records.get(record.payload.decisionId)
  if (decision?.kind !== 'decision')
    diagnostics.push(diagnostic('unknown-reference', `Debt receipt ${record.recordId} lacks its decision`))
  else {
    const findings = new Set(decision.payload.judgment.findings.map((finding) => finding.id))
    const causes = new Set(decision.payload.judgment.causes.map((cause) => cause.id))
    if (
      record.payload.findingIds.some((id) => !findings.has(id)) ||
      record.payload.causeIds.some((id) => !causes.has(id))
    )
      diagnostics.push(diagnostic('unknown-reference', `Debt receipt ${record.recordId} references another decision`))
  }
  if (!record.inputs.includes(record.payload.decisionId))
    diagnostics.push(diagnostic('unbound', `Debt receipt ${record.recordId} does not bind its decision`))
}

function validateFixResultLinks(
  record: Extract<CanonicalRecord, { kind: 'fix-result' }>,
  ids: string[],
  expectedKind: CanonicalRecord['kind'],
  label: string,
  records: Map<string, CanonicalRecord>,
  diagnostics: Diagnostic[],
): void {
  for (const id of ids)
    if (records.get(id)?.kind !== expectedKind || !record.inputs.includes(id))
      diagnostics.push(diagnostic('unknown-reference', `Fix result ${record.recordId} lacks ${label} ${id}`))
}

function validateFixResult(
  record: Extract<CanonicalRecord, { kind: 'fix-result' }>,
  records: Map<string, CanonicalRecord>,
  diagnostics: Diagnostic[],
): void {
  const request = records.get(record.payload.requestId)
  const decision = records.get(record.payload.decisionId)
  if (request?.kind !== 'fix-request' || decision?.kind !== 'decision')
    diagnostics.push(diagnostic('unknown-reference', `Fix result ${record.recordId} lacks request or decision`))
  if (!record.inputs.includes(record.payload.requestId) || !record.inputs.includes(record.payload.decisionId))
    diagnostics.push(diagnostic('unbound', `Fix result ${record.recordId} does not bind request and decision`))
  validateFixResultLinks(
    record,
    record.payload.correctionResultIds,
    'correction-result',
    'correction',
    records,
    diagnostics,
  )
  validateFixResultLinks(
    record,
    record.payload.falsificationResultIds,
    'falsification-result',
    'falsification',
    records,
    diagnostics,
  )
  validateFixResultLinks(record, record.payload.debtReceiptIds, 'debt-receipt', 'debt receipt', records, diagnostics)
}

export function validateFixLinks(records: Map<string, CanonicalRecord>, diagnostics: Diagnostic[]): void {
  for (const record of records.values()) {
    if (record.kind === 'fix-request') validateFixRequest(record, records, diagnostics)
    if (record.kind === 'correction-result') validateCorrectionResult(record, records, diagnostics)
    if (record.kind === 'falsification-result') validateFalsificationResult(record, records, diagnostics)
    if (record.kind === 'debt-receipt') validateDebtReceipt(record, records, diagnostics)
    if (record.kind === 'fix-result') validateFixResult(record, records, diagnostics)
  }
}

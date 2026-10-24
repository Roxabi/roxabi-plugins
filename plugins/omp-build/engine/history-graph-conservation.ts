import { capturedFindingMembers, sameJson } from './history-conservation.ts'
import { diagnostic } from './record-diagnostics.ts'
import type { CanonicalRecord } from './record-schema.ts'
import type { Diagnostic } from './record-values.ts'
import { unique } from './result.ts'

type Contribution = Extract<CanonicalRecord, { kind: 'contribution' }>

function validateContributionFindings(record: Contribution, diagnostics: Diagnostic[]): void {
  const contribution = record.payload
  if (contribution.content === 'decision' && contribution.findings !== null)
    diagnostics.push(diagnostic('malformed', `Decision contribution ${record.recordId} must not carry findings`))
  if (contribution.content === 'operator-request' && contribution.findings !== null)
    diagnostics.push(diagnostic('malformed', `Operator request ${record.recordId} must not carry findings`))
  if (contribution.findings === null) return
  if (!unique(contribution.findings.map((finding) => finding.id)))
    diagnostics.push(diagnostic('duplicate-reference', `Contribution ${record.recordId} repeats original finding IDs`))
  for (const [index, finding] of contribution.findings.entries())
    if (finding.id !== `${record.recordId}:f${index}`)
      diagnostics.push(diagnostic('unbound', `Original finding ${finding.id} does not retain its source allocation`))
}

function captureSummary(contribution: Contribution['payload']): {
  submissions: Map<number, (typeof contribution.rawAttempts)[number]>
  duplicateSubmission: boolean
  structuredCaptured: boolean
} {
  const submissions = new Map<number, (typeof contribution.rawAttempts)[number]>()
  let duplicateSubmission = false
  let structuredCaptured = false
  for (const attempt of contribution.rawAttempts) {
    if (submissions.has(attempt.attemptIndex)) duplicateSubmission = true
    submissions.set(attempt.attemptIndex, attempt)
    if (attempt.data !== null && contribution.structured !== null && sameJson(attempt.data, contribution.structured))
      structuredCaptured = true
  }
  return { submissions, duplicateSubmission, structuredCaptured }
}

function validateCapturedStructure(
  record: Contribution,
  duplicateSubmission: boolean,
  structuredCaptured: boolean,
  diagnostics: Diagnostic[],
): void {
  if (duplicateSubmission)
    diagnostics.push(
      diagnostic('duplicate-reference', `Contribution ${record.recordId} repeats a captured submission index`),
    )
  if (record.payload.structured !== null && !structuredCaptured)
    diagnostics.push(
      diagnostic('unbound', `Contribution ${record.recordId} structured output is not a captured model submission`),
    )
}

function validateCapturedFindings(
  record: Contribution,
  submissions: Map<number, Contribution['payload']['rawAttempts'][number]>,
  diagnostics: Diagnostic[],
): void {
  const contribution = record.payload
  if (contribution.content !== 'findings' || contribution.findings === null) return
  for (const original of contribution.findings) {
    const attempt = submissions.get(original.attemptIndex)
    const capturedFindings =
      attempt === undefined || attempt.data === null ? null : capturedFindingMembers(attempt.data)
    if (capturedFindings === null || !capturedFindings.some((finding) => sameJson(finding, original.data)))
      diagnostics.push(
        diagnostic('unbound', `Original finding ${original.id} is not retained in its captured submission`),
      )
  }
  for (const attempt of submissions.values()) {
    const capturedFindings = attempt.data === null ? null : capturedFindingMembers(attempt.data)
    if (
      capturedFindings?.some(
        (finding) =>
          !contribution.findings?.some(
            (original) => original.attemptIndex === attempt.attemptIndex && sameJson(original.data, finding),
          ),
      )
    )
      diagnostics.push(
        diagnostic('unusable-finding', `Finding contribution ${record.recordId} loses a captured submission finding`),
      )
  }
}

function validateContributionInventory(
  record: Contribution,
  records: Map<string, CanonicalRecord>,
  diagnostics: Diagnostic[],
): void {
  if (record.payload.inventoryId === null) return
  const inventory = records.get(record.payload.inventoryId)
  if (inventory?.kind !== 'review-attempt')
    diagnostics.push(diagnostic('unknown-reference', `Contribution ${record.recordId} references unknown inventory`))
  else if (!record.inputs.includes(inventory.recordId))
    diagnostics.push(diagnostic('unbound', `Contribution ${record.recordId} is not bound to its inventory input`))
}

function validateContribution(
  record: Contribution,
  records: Map<string, CanonicalRecord>,
  diagnostics: Diagnostic[],
): void {
  validateContributionFindings(record, diagnostics)
  const { submissions, duplicateSubmission, structuredCaptured } = captureSummary(record.payload)
  validateCapturedStructure(record, duplicateSubmission, structuredCaptured, diagnostics)
  validateCapturedFindings(record, submissions, diagnostics)
  validateContributionInventory(record, records, diagnostics)
}

export function validateContributionConservation(
  records: Map<string, CanonicalRecord>,
  diagnostics: Diagnostic[],
): void {
  for (const record of records.values())
    if (record.kind === 'contribution') validateContribution(record, records, diagnostics)
}

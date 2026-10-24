import type { CanonicalRecord, DecodedHistory } from '../dist/contracts.js'
import type { DebtFilingInput, Source } from './debt-filing-contract.ts'
import { RECEIPT_ID } from './debt-filing-contract.ts'

export function selectedDecision(
  input: DebtFilingInput,
  history: DecodedHistory,
): Extract<CanonicalRecord, { kind: 'decision' }> | null {
  if (!history.source.complete || history.diagnostics.length > 0 || history.source.diagnostics.length > 0) return null
  const matches = history.operations.filter(
    (operation) =>
      operation.status === 'complete' &&
      operation.kind === 'decision' &&
      operation.recordId === input.decisionId &&
      operation.record?.kind === 'decision',
  )
  return matches.length === 1 && matches[0]?.record?.kind === 'decision' ? matches[0].record : null
}

export function reviewBoundDecision(
  input: DebtFilingInput,
  decision: Extract<CanonicalRecord, { kind: 'decision' }>,
  records: ReadonlyMap<string, CanonicalRecord>,
): boolean {
  const request = records.get(input.fixRequestId)
  if (request?.kind !== 'fix-request') return false
  if (decision.payload.judgment.purpose !== 'review') return true
  const reviewId = request.payload.existingReviewId
  const review = reviewId === null ? null : records.get(reviewId)
  return (
    review?.kind === 'review' &&
    review.payload.decisionId === decision.recordId &&
    review.payload.candidateGitSHA === input.target.candidateGitSHA
  )
}

export function obligationBody(
  input: DebtFilingInput,
  decision: Extract<CanonicalRecord, { kind: 'decision' }>,
  source: Source,
): { title: string; body: string } {
  if (!RECEIPT_ID.test(input.receiptId) || !RECEIPT_ID.test(input.decisionId))
    throw new Error('debt-receipt-or-decision-id-invalid')
  const ids = (values: readonly string[]) =>
    new Set(values).size === values.length && values.every((value) => RECEIPT_ID.test(value))
  if ((input.findingIds.length === 0 && input.causeIds.length === 0) || !ids(input.findingIds) || !ids(input.causeIds))
    throw new Error('debt-member-ids-invalid')
  if (
    input.retentionDiagnostics.length === 0 ||
    input.retentionDiagnostics.some((diagnostic) => diagnostic.trim().length === 0)
  )
    throw new Error('debt-retention-diagnostics-invalid')
  const judgment = decision.payload.judgment
  const findings = input.findingIds.map((id) => judgment.findings.find((finding) => finding.id === id) ?? null)
  const causes = input.causeIds.map((id) => judgment.causes.find((cause) => cause.id === id) ?? null)
  if (findings.some((finding) => finding === null) || causes.some((cause) => cause === null))
    throw new Error('debt-member-unconfirmed')
  const selectedFindings = findings.filter((finding): finding is NonNullable<typeof finding> => finding !== null)
  const selectedCauses = causes.filter((cause): cause is NonNullable<typeof cause> => cause !== null)
  const selectedFindingIds = new Set(input.findingIds)
  if (selectedCauses.some((cause) => cause.findingIds.some((id) => !selectedFindingIds.has(id))))
    throw new Error('debt-obligation-membership-invalid')
  const causedFindingIds = new Set(selectedCauses.flatMap((cause) => cause.findingIds))
  const detail = [
    ...selectedCauses.map((cause) =>
      [
        `### ${cause.id}: ${cause.title}`,
        '',
        '## Acceptance criteria',
        `- [ ] ${cause.fix}`,
        '',
        `- **Mechanism:** ${cause.mechanism}`,
        `- **Failure:** ${cause.failure}`,
        `- **Restored behavior:** ${cause.restored}`,
        `- **Paths:** ${cause.paths.join(', ')}`,
        `- **Proof:** ${cause.proof}`,
      ].join('\n'),
    ),
    ...selectedFindings
      .filter((finding) => !causedFindingIds.has(finding.id))
      .map((finding) =>
        [
          `### ${finding.id}: uncited correction obligation`,
          '',
          '## Acceptance criteria',
          `- [ ] Resolve confirmed finding \`${finding.id}\` while preserving its retained provenance.`,
          '',
          '- **Canonical correction cause:** none retained',
        ].join('\n'),
      ),
  ].join('\n\n')
  const findingText = selectedFindings
    .map((finding) =>
      [
        `### ${finding.id}`,
        `- **State:** ${finding.state}`,
        `- **Label:** ${finding.label ?? 'unlabelled'}`,
        `- **Impact:** ${finding.impactReason}`,
        ...('description' in finding ? [`- **Finding:** ${finding.description}`] : []),
        `- **Provenance:** ${finding.sourceFindingIds.join(', ')}`,
      ].join('\n'),
    )
    .join('\n\n')
  return {
    title: `Deferred correction obligations for ${input.target.target}`,
    body: [
      `<!-- omp-build-debt-receipt:${input.receiptId} -->`,
      `**Origin:** ${source.origin}`,
      '',
      '## Scope',
      `- decision: \`${decision.recordId}\``,
      `- fix request: \`${input.fixRequestId}\``,
      `- original contribution: \`${decision.payload.originalContributionId}\``,
      `- source contributions: ${judgment.sourceContributionIds.map((id) => `\`${id}\``).join(', ') || 'none'}`,
      `- policy: \`${judgment.policy.version}\``,
      `- receipt: \`${input.receiptId}\``,
      '',
      '## Retained correction obligations',
      detail,
      '',
      '## Confirmed findings',
      findingText,

      '## Retention diagnostics',
      ...input.retentionDiagnostics.map((diagnostic) => `- \`${diagnostic}\``),
      '',
      '## Filing evidence',
      `\`\`\`json\n${JSON.stringify(input.evidence.evidence)}\n\`\`\``,
    ].join('\n'),
  }
}

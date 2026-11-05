import { canonicalValueDigest } from './action-input.ts'
import type { AssessmentState } from './cause-assessment-state.ts'
import { observationRefDiagnostics } from './delivery-observation-authentication.ts'
import { producerSourceDiagnostics } from './observation-input-authentication.ts'
import { diagnostic, equalScope } from './record-diagnostics.ts'
import type { Diagnostic } from './record-values.ts'
import type { Cause, CauseJudgment, FinalFinding } from './review-schema.ts'

type SupportInput = Pick<AssessmentState, 'selectedInputs' | 'records' | 'histories'> & {
  cause: Cause
  findings: FinalFinding[]
  effectiveJudgment: CauseJudgment
  localDiagnostics: Diagnostic[]
}
function isFindingSource(
  ref: Parameters<typeof observationRefDiagnostics>[1],
  findings: FinalFinding[],
  records: AssessmentState['records'],
): boolean {
  if (ref.source !== 'record') return false
  return findings.some((finding) =>
    finding.sourceFindingIds.some((id) => {
      const source = [...records.values()].find(
        (entry) => entry.kind === 'contribution' && entry.payload.findings?.some((original) => original.id === id),
      )
      return source?.recordId === ref.record.recordId && equalScope(ref.record.scope, source)
    }),
  )
}
function referenceErrors(input: SupportInput, ref: Parameters<typeof observationRefDiagnostics>[1]): Diagnostic[] {
  const { selectedInputs, histories, cause, findings, records } = input
  const pins = selectedInputs.flatMap((entry) => [
    ...entry.manifest.repositoryReferences,
    ...entry.manifest.plugin.files,
    ...entry.manifest.expandedContext.filter((item) => item.source === 'git-file'),
  ])
  const selected =
    isFindingSource(ref, findings, records) ||
    selectedInputs.some((entry) => producerSourceDiagnostics(cause.id, [ref], entry).length === 0)
  return [
    ...(selected ? [] : [diagnostic('unknown-reference', `Cause ${cause.id} cites an unselected source`)]),
    ...observationRefDiagnostics(cause.id, ref, histories, pins),
  ]
}
export function hasSupportedJudgments(input: SupportInput): boolean {
  const { effectiveJudgment, localDiagnostics } = input
  const judgments = [effectiveJudgment.necessary, effectiveJudgment.urgent, effectiveJudgment.tooLarge]
  let supported = true
  for (const judgment of judgments) {
    if (
      judgment.state !== 'supported' ||
      judgment.reason.trim() === '' ||
      new Set(judgment.references.map(canonicalValueDigest)).size !== judgment.references.length
    ) {
      supported = false
      continue
    }
    const errors = judgment.references.flatMap((ref) => referenceErrors(input, ref))
    if (errors.length) {
      supported = false
      localDiagnostics.push(...errors)
    }
  }
  return supported
}

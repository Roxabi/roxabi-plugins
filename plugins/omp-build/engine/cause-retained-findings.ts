import { blockingLabels } from './cause-assessment.ts'
import type { AssessmentState } from './cause-assessment-state.ts'
import type { Ref } from './cause-disposition.ts'
import type { CauseDispositionPayload } from './cause-disposition-schema.ts'
import { inspectFinding } from './producer-schema.ts'
import type { CanonicalRecord } from './record-schema.ts'
import type { DecisionBindings } from './review-decision.ts'

type UnassignedInput = {
  decision: Extract<CanonicalRecord, { kind: 'decision' }>
  records: ReadonlyMap<string, CanonicalRecord>
  bindings: DecisionBindings
  decisionRef: Ref<'decision'>
  base: Pick<CauseDispositionPayload, 'format' | 'origin' | 'previous' | 'adjudication'>
  outcomes: CauseDispositionPayload[]
}

function appendSourceFindings(
  input: UnassignedInput,
  sourceId: string,
  entry: UnassignedInput['decision']['payload']['judgment']['unassignedFindings'][number] | undefined,
): void {
  const { records, base, outcomes } = input
  for (const source of records.values()) {
    if (source.kind !== 'contribution') continue
    const original = source.payload.findings?.find((item) => item.id === sourceId)
    if (!original) continue
    const inspection = input.bindings.inspections.get(sourceId) ?? inspectFinding(original.data, [])
    const blocking = inspection.knownLabel === null || blockingLabels.has(inspection.knownLabel)
    const sourceDiagnostics = [...inspection.diagnostics, ...(entry?.diagnostics ?? [])]
    outcomes.push({
      ...base,
      subject: {
        kind: 'retained-finding',
        contribution: {
          scope: { repository: source.repository, target: source.target },
          recordId: source.recordId,
          kind: 'contribution',
        },
        finding: original,
        diagnostics: sourceDiagnostics,
      },
      outcome: blocking
        ? { state: 'pending-blocking', reason: entry?.reason ?? 'Unusable blocking or indeterminate finding' }
        : {
            state: 'final',
            disposition: 'report',
            blocking: false,
            reason: entry?.reason ?? 'Unusable nonblocking finding',
          },
      diagnostics: sourceDiagnostics,
    })
  }
}
export function appendUnassignedClaimErrors(state: AssessmentState): void {
  const { decision, bindings, claimDiagnostics, diagnostics, outcomes, base, decisionRef } = state
  const assigned = new Set(
    decision.payload.judgment.causes.flatMap((cause) =>
      decision.payload.judgment.findings
        .filter((finding) => cause.findingIds.includes(finding.id))
        .flatMap((finding) => finding.sourceFindingIds),
    ),
  )
  for (const [source, errors] of claimDiagnostics) {
    if (bindings.admissible && assigned.has(source)) continue
    for (const item of errors) {
      diagnostics.push(item)
      outcomes.push({
        ...base,
        subject: { kind: 'rule-error', source: decisionRef, diagnostic: item },
        outcome: { state: 'pending-blocking', reason: 'Exclusion claim requires adjudication' },
        diagnostics: [item],
      })
    }
  }
}

export function appendUnassignedOutcomes(input: UnassignedInput): void {
  const { decision, bindings, decisionRef, base, outcomes } = input
  const unassignedIds = new Set(decision.payload.judgment.unassignedFindings.map((entry) => entry.findingId))
  for (const finding of decision.payload.judgment.findings) {
    if (!unassignedIds.has(finding.id)) continue
    const entry = decision.payload.judgment.unassignedFindings.find((item) => item.findingId === finding.id)
    for (const sourceId of finding.sourceFindingIds) appendSourceFindings(input, sourceId, entry)
  }
  for (const item of bindings.diagnostics)
    outcomes.push({
      ...base,
      subject: { kind: 'rule-error', source: decisionRef, diagnostic: item },
      outcome: { state: 'pending-blocking', reason: 'Decision conservation requires resynthesis' },
      diagnostics: [item],
    })
}

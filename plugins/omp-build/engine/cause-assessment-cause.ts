import { assessCauseAdjudication } from './cause-adjudication-assessment.ts'
import { blockingLabels } from './cause-assessment.ts'
import type { AssessmentState } from './cause-assessment-state.ts'
import { hasSupportedJudgments } from './cause-assessment-support.ts'
import { validateLocalFindingTarget } from './finding-target.ts'
import { diagnostic } from './record-diagnostics.ts'
import type { Diagnostic } from './record-values.ts'
import type { Cause, FinalFinding } from './review-schema.ts'

type Disposition = 'fix-original' | 'sister-blocking' | 'sister-after' | 'report' | null
type DispositionInput = {
  assessment: ReturnType<typeof assessCauseAdjudication>
  cause: Cause
  excluded: boolean[]
  mixed: boolean
  blocking: boolean
  supported: boolean
  admissible: boolean
}

function mechanicalDisposition(input: DispositionInput): Disposition {
  const { assessment, excluded, mixed, blocking, supported } = input
  const { adjudication, effectiveFindings, effectiveJudgment, localDiagnostics } = assessment
  if (adjudication !== null && effectiveFindings.length === 0) return 'report'
  if (excluded.length && excluded.every(Boolean)) return 'report'
  if (mixed) return null
  if (
    !supported ||
    localDiagnostics.length ||
    (blocking && (!effectiveJudgment.necessary.value || !effectiveJudgment.urgent.value))
  )
    return blocking ? null : 'report'
  if (!effectiveJudgment.necessary.value || !effectiveJudgment.urgent.value) return 'report'
  if (!effectiveJudgment.tooLarge.value) return 'fix-original'
  return blocking ? 'sister-blocking' : 'sister-after'
}

function selectDisposition(input: DispositionInput): Disposition {
  const { assessment, cause, mixed, blocking, admissible } = input
  const { adjudication, localDiagnostics } = assessment
  let disposition = mechanicalDisposition(input)
  if (adjudication === null && cause.proposedDisposition !== disposition) {
    localDiagnostics.push(
      diagnostic('cause-disposition-mismatch', `Cause ${cause.id} proposal differs from mechanical disposition`),
    )
    disposition = blocking || mixed ? null : 'report'
  }
  if (!admissible && disposition === 'fix-original') disposition = null
  return disposition
}

function excludedSources(input: AssessmentState, findings: FinalFinding[], diagnostics: Diagnostic[]): Set<string> {
  const excluded = new Set<string>()
  for (const finding of findings) {
    for (const source of finding.sourceFindingIds) {
      const claims = input.decision.payload.judgment.exclusionClaims.filter((claim) => claim.sourceFindingId === source)
      const errors = input.claimDiagnostics.get(source) ?? []
      diagnostics.push(...errors)
      if (claims.length > 0 && errors.length === 0) excluded.add(source)
    }
  }
  return excluded
}

export function assessCause(input: AssessmentState, cause: Cause): void {
  const {
    context,
    histories,
    adjudications,
    decision,
    decisionRef,
    selectedInputs,
    records,
    bindings,
    base,
    outcomes,
    executableCauseIds,
    diagnostics,
  } = input
  const findings = cause.findingIds
    .map((id) => decision.payload.judgment.findings.find((item) => item.id === id))
    .filter((item): item is FinalFinding => item !== undefined)
  const assessment = assessCauseAdjudication({ context, histories, adjudications, cause, findings, decisionRef })
  const { effectiveJudgment, effectiveFindings, predecessor, adjudication, localDiagnostics } = assessment
  for (const finding of findings) {
    if (finding.target === null)
      localDiagnostics.push(diagnostic('finding-target-invalid', `Finding ${finding.id} has no target`))
    else {
      const target = validateLocalFindingTarget({ context, target: finding.target })
      if (!target.ok) localDiagnostics.push(...target.diagnostics)
    }
  }
  const blocking = effectiveFindings.some((item) => item.label === null || blockingLabels.has(item.label))
  const supported = hasSupportedJudgments({
    effectiveJudgment,
    localDiagnostics,
    selectedInputs,
    records,
    histories,
    cause,
    findings,
  })
  const excludedIds = excludedSources(input, findings, localDiagnostics)
  const excluded = effectiveFindings.map((finding) =>
    finding.sourceFindingIds.every((sourceId) => excludedIds.has(sourceId)),
  )
  const mixed = excluded.some(Boolean) && !excluded.every(Boolean)
  if (mixed)
    localDiagnostics.push(
      diagnostic('cause-mixes-excluded-work', `Cause ${cause.id} mixes excluded and actionable work`),
    )
  const disposition = selectDisposition({
    assessment,
    cause,
    excluded,
    mixed,
    blocking,
    supported,
    admissible: bindings.admissible,
  })
  const outcome =
    disposition === null
      ? { state: 'pending-blocking' as const, reason: 'Cause requires authenticated adjudication or resynthesis' }
      : {
          state: 'final' as const,
          disposition,
          blocking: disposition === 'report' && excluded.every(Boolean) ? false : blocking,
          reason: 'Mechanical D14 assessment',
        }
  if (disposition === 'fix-original') executableCauseIds.push(cause.id)
  diagnostics.push(...localDiagnostics)
  outcomes.push({
    ...base,
    previous: predecessor,
    adjudication,
    subject: { kind: 'cause', decision: decisionRef, cause, findings },
    outcome,
    diagnostics: localDiagnostics,
  })
}

import { blockingLabels } from './cause-assessment.ts'
import type { AssessmentState } from './cause-assessment-state.ts'
import { authenticateCauseCapture } from './cause-capture-authentication.ts'
import type { CauseAssessment, DispositionSource } from './cause-disposition.ts'
import type { CauseDispositionPayload } from './cause-disposition-schema.ts'
import type { DecodedHistory } from './history-schema.ts'
import { inspectFinding } from './producer-schema.ts'
import { diagnostic, equalScope } from './record-diagnostics.ts'
import type { CanonicalRecord } from './record-schema.ts'
import type { Result } from './result.ts'
import { bindExternalRef } from './workflow-control.ts'

type Base = AssessmentState['base']
export function assessRetainedOutput(input: {
  source: Extract<DispositionSource, { kind: 'retained-output' }>
  histories: readonly DecodedHistory[]
  base: Base
}): Result<CauseAssessment> {
  const { histories, base } = input
  const outcomes: CauseDispositionPayload[] = []
  const executableCauseIds: string[] = []
  for (const contribution of input.source.contributions) {
    const scope = { repository: contribution.repository, target: contribution.target }
    const history = histories.find((item) => equalScope(item.source.scope, scope))
    const ref = { scope, recordId: contribution.recordId, kind: 'contribution' as const }
    const bound = history && bindExternalRef(ref, history)
    if (!bound?.ok || JSON.stringify(bound.value) !== JSON.stringify(contribution))
      return {
        ok: false,
        diagnostics: [diagnostic('unconfirmed', `Contribution ${contribution.recordId} is not authenticated`)],
      }
    for (const finding of contribution.payload.findings ?? []) {
      const inspection = inspectFinding(finding.data, [])
      const blocking = inspection.knownLabel === null || blockingLabels.has(inspection.knownLabel)
      outcomes.push({
        ...base,
        subject: { kind: 'retained-finding', contribution: ref, finding, diagnostics: inspection.diagnostics },
        outcome: blocking
          ? { state: 'pending-blocking', reason: 'Retained blocking or indeterminate source requires adjudication' }
          : { state: 'final', disposition: 'report', blocking: false, reason: 'Retained nonblocking source' },
        diagnostics: inspection.diagnostics,
      })
    }
    for (const item of input.source.diagnostics)
      outcomes.push({
        ...base,
        subject: { kind: 'rule-error', source: ref, diagnostic: item },
        outcome: { state: 'pending-blocking', reason: 'Unclassified rule error requires adjudication' },
        diagnostics: [item],
      })
  }
  if (input.source.contributions.length === 0)
    return {
      ok: false,
      diagnostics: [diagnostic('missing-contribution', 'Cannot retain output without an authenticated source')],
    }
  return { ok: true, value: { outcomes, executableCauseIds, diagnostics: [...input.source.diagnostics] } }
}

type Contribution = Extract<CanonicalRecord, { kind: 'contribution' }>
function retainSource(
  input: AssessmentState,
  source: Contribution,
  inventory: Extract<CanonicalRecord, { kind: 'review-attempt' }>,
): Result<null> {
  const { decisionRef, history, base, outcomes } = input
  const decisionScope = decisionRef.scope
  const contributionRef = { scope: decisionScope, recordId: source.recordId, kind: 'contribution' as const }
  const sourceBinding = bindExternalRef(contributionRef, history)
  const inventoryBinding = bindExternalRef(
    { scope: decisionScope, recordId: inventory.recordId, kind: 'review-attempt' },
    history,
  )
  if (
    !sourceBinding.ok ||
    !inventoryBinding.ok ||
    !source.inputs.includes(inventory.recordId) ||
    source.payload.findings === null
  )
    return {
      ok: false,
      diagnostics: [
        diagnostic('cause-source-unconfirmed', `Source ${source.recordId} cannot be authenticated for retention`),
      ],
    }
  const capture = authenticateCauseCapture({
    context: input.context,
    capture: base.basis.capture,
    source: { kind: 'retained-output', contributions: [source], diagnostics: [] },
    histories: input.histories,
    catalogues: input.catalogues,
  })
  if (!capture.ok) return capture
  for (const finding of source.payload.findings) {
    const inspection = inspectFinding(finding.data, [])
    const blocking = inspection.knownLabel === null || blockingLabels.has(inspection.knownLabel)
    outcomes.push({
      ...base,
      subject: {
        kind: 'retained-finding',
        contribution: contributionRef,
        finding,
        diagnostics: inspection.diagnostics,
      },
      outcome: blocking
        ? {
            state: 'pending-blocking',
            reason: 'Blocking or indeterminate finding retained after invalid synthesis partition',
          }
        : {
            state: 'final',
            disposition: 'report',
            blocking: false,
            reason: 'Nonblocking finding retained after invalid synthesis partition',
          },
      diagnostics: inspection.diagnostics,
    })
  }
  return { ok: true, value: null }
}

export function assessInvalidPartition(input: AssessmentState): Result<CauseAssessment> {
  const { decision, records, bindings, decisionRef, base, outcomes, diagnostics } = input
  const synthesis = records.get(decision.payload.originalContributionId)
  const synthesisInventory =
    synthesis?.kind === 'contribution' && synthesis.payload.inventoryId !== null
      ? records.get(synthesis.payload.inventoryId)
      : null
  if (synthesisInventory?.kind !== 'review-attempt')
    return { ok: false, diagnostics: [diagnostic('cause-source-unconfirmed', 'Synthesis root is unavailable')] }
  const root = synthesisInventory.payload.rootAttemptId
  for (const source of records.values()) {
    if (source.kind !== 'contribution' || source.payload.content !== 'findings' || source.payload.inventoryId === null)
      continue
    const inventory = records.get(source.payload.inventoryId)
    if (inventory?.kind !== 'review-attempt' || inventory.payload.rootAttemptId !== root) continue
    const retained = retainSource(input, source, inventory)
    if (!retained.ok) return retained
  }
  for (const item of bindings.diagnostics)
    outcomes.push({
      ...base,
      subject: { kind: 'rule-error', source: decisionRef, diagnostic: item },
      outcome: { state: 'pending-blocking', reason: 'Decision conservation requires resynthesis' },
      diagnostics: [item],
    })
  return { ok: true, value: { outcomes, executableCauseIds: [], diagnostics } }
}

import { resolveCauseActionInputs } from './cause-adjudication.ts'
import { authenticateCauseContext } from './cause-assessment-authority.ts'
import { assessCause } from './cause-assessment-cause.ts'
import { assessInvalidPartition, assessRetainedOutput } from './cause-assessment-retention.ts'
import type { AssessmentState } from './cause-assessment-state.ts'
import type { CauseAssessment, DispositionSource } from './cause-disposition.ts'
import type { CauseDispositionPayload } from './cause-disposition-schema.ts'
import { appendUnassignedOutcomes } from './cause-retained-findings.ts'
import type { CauseContext } from './finding-target.ts'
import type { DecodedHistory } from './history-schema.ts'
import { diagnostic, equalScope } from './record-diagnostics.ts'
import type { CanonicalRecord } from './record-schema.ts'
import type { Diagnostic } from './record-values.ts'
import type { Result } from './result.ts'
import { validateDecisionBindings } from './review-decision.ts'
import { bindExternalRef } from './workflow-control.ts'
export const blockingLabels = new Set(['issue', 'issue(blocking)', 'todo', 'suggestion(blocking)'])
export function assessCauseDispositions(input: {
  context: CauseContext
  source: DispositionSource
  histories: readonly DecodedHistory[]
  adjudications: readonly Extract<CanonicalRecord, { kind: 'cause-operation' }>[]
}): Result<CauseAssessment> {
  const { context, histories } = input
  const authority = authenticateCauseContext(context, histories)
  if (!authority.ok) return authority
  const outcomes: CauseDispositionPayload[] = []
  const diagnostics: Diagnostic[] = []
  const executableCauseIds: string[] = []
  const base = {
    format: 'omp-build-cause-disposition/1' as const,
    origin: context.effective.own,
    previous: null,
    adjudication: null,
  }
  if (input.source.kind === 'retained-output') return assessRetainedOutput({ source: input.source, histories, base })
  const decision = input.source.decision
  const decisionScope = { repository: decision.repository, target: decision.target }
  const history = histories.find((item) => equalScope(item.source.scope, decisionScope))
  if (!history) return { ok: false, diagnostics: [diagnostic('missing-history', 'Decision history is unavailable')] }
  const decisionRef = { scope: decisionScope, recordId: decision.recordId, kind: 'decision' as const }
  const bound = bindExternalRef(decisionRef, history)
  if (!bound.ok) return bound
  if (JSON.stringify(bound.value) !== JSON.stringify(decision))
    return { ok: false, diagnostics: [diagnostic('unbound', 'Decision differs from its authenticated record')] }
  const bindings = validateDecisionBindings(decision, history)
  diagnostics.push(...bindings.diagnostics)
  const resolvedInputs = resolveCauseActionInputs({ decision, history, context })
  if (!resolvedInputs.ok) return resolvedInputs
  const selectedInputs = resolvedInputs.value
  const records = bindings.records
  const state: AssessmentState = {
    context,
    histories,
    adjudications: input.adjudications,
    history,
    decision,
    decisionRef,
    selectedInputs,
    records,
    bindings,
    base,
    outcomes,
    executableCauseIds,
    diagnostics,
  }
  if (!bindings.admissible) return assessInvalidPartition(state)
  for (const cause of decision.payload.judgment.causes) assessCause(state, cause)
  appendUnassignedOutcomes({ decision, records, bindings, decisionRef, base, outcomes })
  return { ok: true, value: { outcomes, executableCauseIds, diagnostics } }
}

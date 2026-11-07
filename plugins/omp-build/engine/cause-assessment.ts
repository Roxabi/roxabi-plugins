import { canonicalValueDigest } from './action-input.ts'
import type { RecordInputRef } from './action-input-refs.ts'
import { resolveCauseActionInputs } from './cause-adjudication.ts'
import {
  authenticateCauseContext,
  authenticateFrameContext,
  authenticateHistoricalCauseContext,
} from './cause-assessment-authority.ts'
import { assessCause } from './cause-assessment-cause.ts'
import { assessInvalidPartition, assessRetainedOutput } from './cause-assessment-retention.ts'
import type { AssessmentState } from './cause-assessment-state.ts'
import { authenticateCauseCapture } from './cause-capture-authentication.ts'
import type { CauseAssessment, DispositionSource } from './cause-disposition.ts'
import type { CauseAdjudicationProposal, CauseDispositionPayload } from './cause-disposition-schema.ts'
import { appendUnassignedClaimErrors, appendUnassignedOutcomes } from './cause-retained-findings.ts'
import type { CauseValidationFrame } from './cause-validation-frame.ts'
import { validateExclusionClaims } from './exclusion-claims.ts'
import type { CauseContext } from './finding-target.ts'
import type { DecodedHistory } from './history-schema.ts'
import { diagnostic, equalScope } from './record-diagnostics.ts'
import type { CanonicalRecord } from './record-schema.ts'
import type { Diagnostic } from './record-values.ts'
import type { Result } from './result.ts'
import type { ReviewClassCatalogues } from './review-class-catalogue.ts'
import { validateDecisionBindings } from './review-decision.ts'
import type { UwGraphObservation } from './uw-graph.ts'
import { bindExternalRef } from './workflow-control.ts'
export const blockingLabels = new Set(['issue', 'issue(blocking)', 'todo', 'suggestion(blocking)'])
type AssessmentInput = {
  context: CauseContext
  capture: RecordInputRef | null
  graph?: UwGraphObservation
  source: DispositionSource
  histories: readonly DecodedHistory[]
  catalogues: ReviewClassCatalogues
  adjudications: readonly Extract<CanonicalRecord, { kind: 'cause-operation' }>[]
}

function assess(
  input: AssessmentInput,
  historical: boolean,
  validatedPrefix?: readonly CauseAdjudicationProposal[],
  frame?: CauseValidationFrame,
): Result<CauseAssessment> {
  const { context, histories } = input
  if (!historical && input.graph === undefined)
    return {
      ok: false,
      diagnostics: [diagnostic('missing-graph', 'Current cause assessment requires the complete native graph')],
    }
  const capture = authenticateCauseCapture(input)
  if (!capture.ok) return capture
  const authority = frame
    ? authenticateFrameContext(frame, context, historical, input.graph)
    : !historical && input.graph !== undefined
      ? authenticateCauseContext(context, histories, input.graph)
      : authenticateHistoricalCauseContext(context, histories)
  if (!authority.ok) return authority
  const outcomes: CauseDispositionPayload[] = []
  const diagnostics: Diagnostic[] = []
  const executableCauseIds: string[] = []
  const base = {
    format: 'omp-build-cause-disposition/2' as const,
    origin: context.effective.own,
    basis: { versionVector: context.effective.versionVector, capture: input.capture },
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
  const bindings = decisionBindings(decision, history, input.catalogues, frame)
  diagnostics.push(...bindings.diagnostics)
  const resolvedInputs = resolveCauseActionInputs({ decision, history, context })
  if (!resolvedInputs.ok) return resolvedInputs
  const selectedInputs = resolvedInputs.value
  const records = bindings.records
  const claimDiagnostics = validateExclusionClaims({
    spec: context.effective,
    claims: decision.payload.judgment.exclusionClaims,
    findings: decision.payload.judgment.findings,
    retained: new Set(bindings.originals.keys()),
  })
  const state: AssessmentState = {
    context,
    histories,
    catalogues: input.catalogues,
    adjudications: input.adjudications,
    validatedPrefix,
    validationFrame: frame,
    history,
    decision,
    decisionRef,
    selectedInputs,
    records,
    claimDiagnostics,
    bindings,
    base,
    outcomes,
    executableCauseIds,
    diagnostics,
  }
  appendUnassignedClaimErrors(state)
  if (!bindings.admissible) return assessInvalidPartition(state)
  for (const cause of decision.payload.judgment.causes) assessCause(state, cause)
  appendUnassignedOutcomes({ decision, records, bindings, decisionRef, base, outcomes })
  return { ok: true, value: { outcomes, executableCauseIds, diagnostics } }
}

function decisionBindings(
  decision: Extract<CanonicalRecord, { kind: 'decision' }>,
  history: DecodedHistory,
  catalogues: ReviewClassCatalogues,
  frame?: CauseValidationFrame,
) {
  const bindingKey = canonicalValueDigest([{ repository: decision.repository, target: decision.target }, decision])
  let bindings = frame?.bindings.get(bindingKey)
  if (bindings === undefined) {
    bindings = validateDecisionBindings(decision, history, frame?.catalogues ?? catalogues)
    frame?.bindings.set(bindingKey, bindings)
  }
  return bindings
}

export function assessCauseDispositions(input: AssessmentInput): Result<CauseAssessment> {
  return assess(input, false)
}

/** Reassess an immutable disposition under its authenticated accepted prefix. */
export function assessHistoricalCauseDispositions(
  input: AssessmentInput,
  frame?: CauseValidationFrame,
): Result<CauseAssessment> {
  return assess(input, true, undefined, frame)
}

/** Internal replay path: the caller has validated these exact predecessor transitions. */
export function assessValidatedCauseDispositions(
  input: AssessmentInput,
  historical: boolean,
  validatedPrefix: readonly CauseAdjudicationProposal[],
  frame: CauseValidationFrame,
): Result<CauseAssessment> {
  return assess(input, historical, validatedPrefix, frame)
}

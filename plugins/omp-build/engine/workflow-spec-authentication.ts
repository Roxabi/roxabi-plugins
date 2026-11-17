import { validateActionInputs } from './action-input.ts'
import type { ActionInputs } from './action-input-schema.ts'
import type { DecodedHistory } from './history-schema.ts'
import { equalScope, sameRef } from './record-diagnostics.ts'
import type { ExternalRecordRef } from './record-references.ts'
import type { CanonicalRecord } from './record-schema.ts'
import type { Scope } from './record-values.ts'
import type { AcceptedSpecResult } from './workflow-accepted-spec-types.ts'

export { sameAssessInputs } from './workflow-spec-assessment.ts'

import { startResolution } from './workflow-action-interruption.ts'
import { hasNewLineageContext } from './workflow-context-lineage.ts'
import {
  type ContextNegativeInspection,
  inspectContextNegativeReceipt,
} from './workflow-context-negative-inspection.ts'
import { workflowContextNegative } from './workflow-context-output.ts'
import {
  type ContextSuccessionInspection,
  contextSuccessionInspectionStarts,
  contextSuccessionInspectionSubject,
  type HistoricalAcceptedSpecContext,
  historicalAcceptedSpecPriorStarts,
} from './workflow-context-succession-inspection.ts'
import {
  observeAssessmentContextReplay,
  workflowContextResolution,
  workflowContextTerminal,
} from './workflow-context-terminal.ts'
import { bindExternalRef, type ReceiptRecord, recordsOf, scopedStartKey } from './workflow-control.ts'
import { resolutionIndex } from './workflow-interruption-resolution.ts'
import type { WorkflowFacts } from './workflow-reconstruction-types.ts'
import { authenticatedReplayStart, receiptRef } from './workflow-replay-start.ts'
import { specChainFailure } from './workflow-spec-assessment.ts'
import { authenticatedAssessResult } from './workflow-spec-authentication-chain.ts'

export { authenticateActionReplayStart, authenticatedReplayStart, receiptRef } from './workflow-replay-start.ts'

export type AssessmentReplayContext = {
  uw: Scope
  actionId: string
  fingerprint: string
} & (
  | { prestart: { negative: ExternalRecordRef; inputs: ActionInputs }; start?: never }
  | { start: ExternalRecordRef; prestart?: never }
)
export type AcceptedSpecInspection =
  | (ContextNegativeInspection & { succession?: ContextSuccessionInspection })
  | { kind: 'selected-succession'; succession: ContextSuccessionInspection }

/** Validate the proof before narrowing it to the mandate whose holds it can inspect. */
export function scopeAcceptedSpecInspection(
  histories: readonly DecodedHistory[],
  mandate: ExternalRecordRef,
  inspection?: AcceptedSpecInspection,
): AcceptedSpecInspection | undefined | null {
  if (inspection?.succession === undefined) return inspection
  const subject = contextSuccessionInspectionSubject(inspection.succession, histories)
  if (!subject.ok) return null
  if (sameRef(subject.value, mandate)) return inspection
  return inspection.kind === 'context-negative-inspection'
    ? { kind: inspection.kind, mandate: inspection.mandate, negative: inspection.negative }
    : undefined
}

function inspectionExcluded(
  histories: readonly DecodedHistory[],
  mandate: ExternalRecordRef,
  excluded: ReadonlySet<string>,
  inspection?: AcceptedSpecInspection,
): ReadonlySet<string> | null {
  const scoped = scopeAcceptedSpecInspection(histories, mandate, inspection)
  if (scoped === null) return null
  if (scoped?.succession === undefined) return excluded
  if (mandate.kind !== 'mandate') return null
  const starts = contextSuccessionInspectionStarts(scoped.succession, histories, { ...mandate, kind: 'mandate' })
  return starts.ok ? new Set([...excluded, ...starts.value]) : null
}

export function assessmentPrestartContext(facts: WorkflowFacts): AssessmentReplayContext | undefined {
  const recovery = facts.contextRecovery
  if (recovery === undefined || recovery.inputs.manifest.purpose !== 'assess-spec') return undefined
  return {
    uw: recovery.negative.scope,
    actionId: recovery.actionId,
    fingerprint: recovery.inputs.fingerprint,
    prestart: { negative: recovery.negative, inputs: recovery.inputs },
  }
}

export function authenticatedAssessmentPrestart(
  home: DecodedHistory,
  histories: readonly DecodedHistory[],
  mandateRef: ExternalRecordRef,
  excluded: ReadonlySet<string>,
  context: AssessmentReplayContext | undefined,
  inspection?: AcceptedSpecInspection,
): ReceiptRecord | null {
  const selected = context?.prestart
  if (
    context === undefined ||
    selected === undefined ||
    !equalScope(context.uw, home.source.scope) ||
    !equalScope(context.uw, mandateRef.scope) ||
    !equalScope(selected.negative.scope, context.uw) ||
    selected.negative.kind !== 'action-receipt' ||
    context.actionId.length === 0 ||
    context.fingerprint !== selected.inputs.fingerprint ||
    !validateActionInputs(selected.inputs).ok ||
    selected.inputs.manifest.purpose !== 'assess-spec'
  )
    return null
  const remainingExcluded = inspectionExcluded(histories, mandateRef, excluded, inspection)
  if (remainingExcluded === null) return null
  const bound = bindExternalRef(selected.negative, home)
  if (!bound.ok || bound.value.kind !== 'action-receipt') return null
  const negative = bound.value
  if (
    negative.payload.action !== 'assess-spec' ||
    negative.payload.phase !== 'result' ||
    !sameRef(negative.payload.mandate, mandateRef) ||
    !workflowContextNegative(negative) ||
    negative.payload.actionId === context.actionId ||
    recordsOf(home).some(
      (record) => record.kind === 'action-receipt' && record.payload.actionId === context.actionId,
    ) ||
    negative.payload.inputs.fingerprint === selected.inputs.fingerprint ||
    !hasNewLineageContext(home, negative, negative.payload.inputs, selected.inputs) ||
    workflowContextResolution(home, negative, remainingExcluded) !== 'missing'
  )
    return null
  for (const history of histories) {
    for (const action of ['frame', 'plan', 'plan-review', 'assess-spec', 'attribute-ci', 'implement', 'integrate']) {
      if (workflowContextTerminal(history, action, negative, remainingExcluded) !== 'clear') return null
    }
  }
  return negative
}

export function confirmedAssessPairs(
  home: DecodedHistory,
  histories: readonly DecodedHistory[],
  mandateRef: ExternalRecordRef,
  replayContext?: AssessmentReplayContext,
  inspection?: AcceptedSpecInspection,
  historical?: HistoricalAcceptedSpecContext,
): AcceptedSpecResult | { ok: true } {
  const resolutions = resolutionIndex(histories)
  if (!resolutions.ok) return { ok: false, reason: 'incomplete', evidence: resolutions.diagnostics }
  const excluded = inspectionExcluded(histories, mandateRef, new Set(resolutions.value.resolved.keys()), inspection)
  if (excluded === null)
    return specChainFailure('incomplete', 'Succession inspection is not authenticated', 'action-context-missing')
  const prestart = authenticatedAssessmentPrestart(home, histories, mandateRef, excluded, replayContext, inspection)
  const metadata = assessmentMetadataExclusions(home, histories, mandateRef, excluded, historical)
  if (!metadata.ok) return metadata
  const metadataExcluded = metadata.value
  const inspected = authenticatedInspectionStarts(home, histories, mandateRef, inspection)
  if (!inspected.ok) return inspected
  if (replayContext?.prestart !== undefined && prestart === null)
    return specChainFailure('incomplete', 'Spec assessment recovery is not authenticated', 'action-context-missing')
  if (
    replayContext !== undefined &&
    replayContext.prestart === undefined &&
    !recordsOf(home).some((record) => authenticatedReplayStart(record, home, mandateRef, replayContext))
  )
    return specChainFailure('incomplete', 'Spec assessment replay start is not authenticated', 'action-uncertain')
  for (const record of recordsOf(home)) {
    const checked = confirmedAssessStart(
      record,
      home,
      histories,
      mandateRef,
      metadataExcluded,
      replayContext,
      prestart,
      inspected.value,
    )
    if (!checked.ok) return checked
  }
  return { ok: true }
}

function authenticatedInspectionStarts(
  home: DecodedHistory,
  histories: readonly DecodedHistory[],
  mandateRef: ExternalRecordRef,
  inspection?: AcceptedSpecInspection,
): Extract<AcceptedSpecResult, { ok: false }> | { ok: true; value: ReadonlySet<string> | undefined } {
  const negativeInspection = inspection?.kind === 'context-negative-inspection' ? inspection : undefined
  const bound = negativeInspection === undefined ? null : bindExternalRef(negativeInspection.mandate, home)
  const inspected =
    bound?.ok && bound.value.kind === 'mandate'
      ? inspectContextNegativeReceipt({ mandate: bound.value, histories, negative: negativeInspection?.negative })
      : null
  if (negativeInspection !== undefined && (!sameRef(negativeInspection.mandate, mandateRef) || !inspected?.ok))
    return specChainFailure('incomplete', 'Spec assessment inspection is not authenticated', 'action-context-missing')
  return {
    ok: true,
    value:
      inspected?.ok && inspected.value.negativeLeaf.payload.action === 'assess-spec'
        ? inspected.value.negativeStartKeys
        : undefined,
  }
}

function assessmentMetadataExclusions(
  home: DecodedHistory,
  histories: readonly DecodedHistory[],
  mandateRef: ExternalRecordRef,
  excluded: ReadonlySet<string>,
  historical?: HistoricalAcceptedSpecContext,
): Extract<AcceptedSpecResult, { ok: false }> | { ok: true; value: ReadonlySet<string> } {
  if (historical === undefined) return { ok: true, value: excluded }
  const bound = bindExternalRef(mandateRef, home)
  if (!bound.ok || bound.value.kind !== 'mandate')
    return specChainFailure(
      'incomplete',
      'Historical assessment mandate is not authenticated',
      'action-context-missing',
    )
  const prior = historicalAcceptedSpecPriorStarts(historical, histories, bound.value)
  return prior.ok
    ? { ok: true, value: new Set([...excluded, ...prior.value]) }
    : { ok: false, reason: 'incomplete', evidence: prior.diagnostics }
}

function confirmedAssessStart(
  record: CanonicalRecord,
  home: DecodedHistory,
  histories: readonly DecodedHistory[],
  mandateRef: ExternalRecordRef,
  excluded: ReadonlySet<string>,
  replayContext?: AssessmentReplayContext,
  prestart: ReceiptRecord | null = null,
  inspected?: ReadonlySet<string>,
): AcceptedSpecResult | { ok: true } {
  if (record.kind !== 'action-receipt' || record.payload.action !== 'assess-spec' || record.payload.phase !== 'start')
    return { ok: true }
  if (!sameRef(record.payload.mandate, mandateRef)) return { ok: true }
  const startRef = receiptRef(record)
  const resolution = startResolution(histories, startRef)
  if (!resolution.ok) return { ok: false, reason: 'incomplete', evidence: resolution.diagnostics }
  if (resolution.value !== null) return { ok: true }
  const results = recordsOf(home).filter(
    (candidate) =>
      candidate.kind === 'action-receipt' &&
      candidate.payload.action === 'assess-spec' &&
      candidate.payload.phase === 'result' &&
      candidate.payload.actionId === record.payload.actionId &&
      sameRef(candidate.payload.start, startRef) &&
      sameRef(candidate.payload.mandate, mandateRef),
  )
  if (results.length === 0) {
    if (authenticatedReplayStart(record, home, mandateRef, replayContext)) return { ok: true }
    return specChainFailure('incomplete', 'Spec assessment start has no confirmed result', 'action-uncertain')
  }
  if (results.length > 1) return specChainFailure('ambiguous', 'Spec assessment start has competing results')
  const result = results[0]
  if (result !== undefined && result.kind === 'action-receipt' && workflowContextNegative(result))
    return contextAssessment(home, mandateRef, excluded, replayContext, prestart, result, inspected)
  const authenticated = authenticatedAssessResult(result ?? record, histories, mandateRef)
  return authenticated.ok ? { ok: true } : authenticated
}

function contextAssessment(
  home: DecodedHistory,
  mandateRef: ExternalRecordRef,
  excluded: ReadonlySet<string>,
  replayContext: AssessmentReplayContext | undefined,
  prestart: ReceiptRecord | null,
  result: ReceiptRecord,
  inspected: ReadonlySet<string> | undefined,
): AcceptedSpecResult | { ok: true } {
  if (prestart !== null) return { ok: true }
  if (result.payload.phase === 'result' && inspected?.has(scopedStartKey(result.payload.start))) return { ok: true }
  const replayStart = recordsOf(home).find(
    (record): record is ReceiptRecord =>
      record.kind === 'action-receipt' && authenticatedReplayStart(record, home, mandateRef, replayContext),
  )
  const terminal =
    replayStart === undefined
      ? workflowContextTerminal(home, 'assess-spec', undefined, excluded)
      : observeAssessmentContextReplay(home, replayStart, excluded)
  if (terminal === 'clear' || terminal === 'observed') return { ok: true }
  if (terminal === 'ambiguous') return specChainFailure('ambiguous', 'Spec assessment context has competing successors')
  return specChainFailure(
    'incomplete',
    'Spec assessment requires authenticated expanded context',
    terminal === 'missing' ? 'action-context-missing' : 'action-uncertain',
  )
}

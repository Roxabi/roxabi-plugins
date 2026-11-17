import { readFileSync } from 'node:fs'
import { actionEnvelopeSchema, canonicalValueDigest, recordsOf, workflowContextNegative } from '../dist/contracts.js'
import type { ScopedRecordRef } from '../engine/record-references.ts'
import type { ContextSuccessionInspection } from '../engine/workflow-context-succession-inspection.ts'
import type { WorkflowDecision } from '../engine/workflow-reconstruction-types.ts'
import type { AcceptedSpecInspection, AssessmentReplayContext } from '../engine/workflow-spec-authentication.ts'
import { confirmPreparedAction, prepareRefusal } from './delivery-action.ts'
import type { FeatureAuthority } from './feature-continuation-admission.ts'
import type { SelectedFeature } from './feature-continuation-selection.ts'
import type { ContinueFeatureInput, ContinueFeatureResult } from './feature-contract.ts'
import type { FeatureObservation } from './feature-observation-contract.ts'
import { plannerSuccessionStarts } from './feature-planner-succession.ts'
import type { PreparedUwAction, UwActionRequest } from './uw-action-contract.ts'
import { plannerExpansion } from './uw-action-negative-expansion.ts'
import { currentAccountedMandate } from './uw-action-selection.ts'
import { assessmentRecoveryReplay, assessmentSuccessionInspection } from './uw-assessment-prestart.ts'
import { nonPlanExpansion } from './uw-context-negative-workflow.ts'
/** Establish only a provisional, engine-authenticated assessment authority before UW preparation. */
export async function assessmentRecoveryBeforeSelection(
  input: ContinueFeatureInput,
  authority: FeatureAuthority,
  proof: ContextSuccessionInspection | undefined,
): Promise<{ replay: AssessmentReplayContext; inspection?: AcceptedSpecInspection } | ContinueFeatureResult | null> {
  if (input.control !== 'recover-context' || input.contextRecovery === undefined) return null
  let body: unknown
  try {
    body = JSON.parse(readFileSync(input.contextRecovery.actionFile, 'utf8'))
  } catch {
    return { kind: 'blocked', reason: 'context-recovery-input-invalid' }
  }
  const parsed = actionEnvelopeSchema.safeParse(body)
  if (!parsed.success || 'reviewed' in parsed.data) return { kind: 'blocked', reason: 'context-recovery-input-invalid' }
  const request = parsed.data.request
  if (request.purpose !== 'assess-spec') return null
  const mandate = currentAccountedMandate(authority.history)
  const disposition = mandate.ok
    ? await plannerSuccessionStarts(mandate.value, authority.causal, authority.context)
    : { ok: true as const, value: new Set<string>() }
  if (!disposition.ok)
    return { kind: 'blocked', reason: prepareRefusal(disposition.diagnostics), diagnostics: disposition.diagnostics }
  const replay = assessmentRecoveryReplay(
    request,
    authority.causal.histories,
    { kind: 'prepublication' },
    undefined,
    disposition.value,
  )
  if (!replay.ok)
    return { kind: 'blocked', reason: prepareRefusal(replay.diagnostics), diagnostics: replay.diagnostics }
  const inspection = assessmentSuccessionInspection(proof)
  if (replay.value === undefined) return { kind: 'blocked', reason: 'context-recovery-negative-missing' }
  const own = authority.context.engine.resolveOwnSpecAuthority(
    authority.history,
    authority.parentHistories,
    authority.causal,
    new Set(),
    replay.value,
    inspection,
  )
  if (!own.ok)
    return { kind: 'blocked', reason: 'context-recovery-authority-unconfirmed', diagnostics: own.diagnostics }
  return { replay: replay.value, inspection }
}
export async function prepareContextRecovery(
  input: ContinueFeatureInput,
  observation: FeatureObservation,
  disposedStarts: ReadonlySet<string>,
): Promise<
  { request: UwActionRequest; prepared: PreparedUwAction; negative: ScopedRecordRef } | ContinueFeatureResult | null
> {
  if (input.control !== 'recover-context') return null
  if (input.contextRecovery === undefined || input.uw === undefined)
    return { kind: 'blocked', reason: 'context-recovery-input-missing' }
  let body: unknown
  try {
    body = JSON.parse(readFileSync(input.contextRecovery.actionFile, 'utf8'))
  } catch {
    return { kind: 'blocked', reason: 'context-recovery-input-invalid' }
  }
  const parsed = actionEnvelopeSchema.safeParse(body)
  if (
    !parsed.success ||
    'reviewed' in parsed.data ||
    !['plan', 'plan-review', 'assess-spec', 'attribute-ci', 'implement', 'integrate'].includes(
      parsed.data.request.purpose,
    )
  )
    return { kind: 'blocked', reason: 'context-recovery-input-invalid' }
  const request = parsed.data.request
  const histories = observation.evidence.causal.histories
  const planner = request.purpose === 'plan' || request.purpose === 'plan-review'
  const expansion = planner
    ? plannerExpansion(request, histories)
    : nonPlanExpansion(request, histories, disposedStarts)
  if (!expansion.ok)
    return { kind: 'blocked', reason: prepareRefusal(expansion.diagnostics), diagnostics: expansion.diagnostics }
  if (expansion.value === null) return { kind: 'blocked', reason: 'context-recovery-negative-missing' }
  const matches =
    planner && 'leaf' in expansion.value
      ? [expansion.value.leaf]
      : histories
          .flatMap(recordsOf)
          .filter(
            (record) =>
              record.kind === 'action-receipt' &&
              record.payload.phase === 'result' &&
              workflowContextNegative(record) &&
              request.expandedContext.some(
                (ref) =>
                  ref.source === 'record' &&
                  ref.selector === '/payload' &&
                  ref.record.recordId === record.recordId &&
                  ref.record.scope.repository === record.repository &&
                  ref.record.scope.target === record.target &&
                  ref.digest === canonicalValueDigest(record.payload),
              ) &&
              canonicalValueDigest(record.payload.inputs) === canonicalValueDigest(expansion.value?.previous),
          )
  const negative = matches[0]
  if (matches.length !== 1 || negative === undefined)
    return { kind: 'blocked', reason: 'context-recovery-negative-ambiguous' }
  const prepared = await confirmPreparedAction(input.uw, request)
  if (!prepared.ok)
    return { kind: 'blocked', reason: prepareRefusal(prepared.diagnostics), diagnostics: prepared.diagnostics }
  return {
    request,
    prepared: prepared.value,
    negative: {
      scope: { repository: negative.repository, target: negative.target },
      kind: 'action-receipt',
      recordId: negative.recordId,
    },
  }
}

export function contextRecoveryStop(
  input: ContinueFeatureInput,
  baseline: WorkflowDecision,
  facts: FeatureObservation['facts'],
  mandate: SelectedFeature['mandate'],
): ContinueFeatureResult | null {
  if (input.control !== 'recover-context') return null
  if (
    !(
      (baseline.status === 'blocked' || (baseline.status === 'terminal' && baseline.reason === 'spec-ambiguous')) &&
      baseline.evidence.some((item) => item.code === 'action-context-missing')
    )
  )
    return {
      kind: 'blocked',
      reason: baseline.status === 'blocked' ? baseline.reason : 'context-recovery-not-required',
      diagnostics: baseline.evidence,
    }
  if (mandate === null) return null
  if (
    facts.productVersion !== mandate.payload.config.productVersion ||
    facts.configVersion !== mandate.payload.config.version ||
    facts.configDigest !== mandate.payload.config.digest
  )
    return { kind: 'blocked', reason: 'config-drift' }
  return facts.supportedConfigVersions.includes(mandate.payload.config.version)
    ? null
    : { kind: 'blocked', reason: 'unsupported-config' }
}

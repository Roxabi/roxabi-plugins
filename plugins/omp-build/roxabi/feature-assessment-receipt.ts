import {
  canonicalValueDigest,
  capturedChildOwnSources,
  createHistoricalAcceptedSpecContext,
  mechanicalSpecDelta,
} from '../dist/contracts.js'
import type { AssessSpecExact } from '../engine/workflow-receipt-schema.ts'
import {
  actionRequest,
  blocks,
  observeHeadCode,
  prepareDeliveryAction,
  prepareRefusal,
  uwSubject,
} from './delivery-action.ts'
import { type ModelReceiptActionInput, type ReceiptStartContext, sealReceipt } from './feature-action-receipt.ts'
import type { ContinueFeatureResult } from './feature-contract.ts'
import { plannerSuccessionInspection, plannerSuccessionStarts } from './feature-planner-succession.ts'
import { assessmentRecoveryReplay, assessmentSuccessionInspection } from './uw-assessment-prestart.ts'

async function publishAssessmentReceipt(
  input: ModelReceiptActionInput,
  context: ReceiptStartContext,
  exactInputs: AssessSpecExact,
): Promise<ContinueFeatureResult> {
  const code = await observeHeadCode(input.git, input.cwd, input.scope.repository)
  if (!code.ok) return blocks(code.reason)
  if (input.uw === undefined) return blocks('prepare-action-unavailable')
  const request = actionRequest({
    actionId: context.operationId,
    purpose: 'assess-spec',
    subject: uwSubject(context.mandateScope, input.target.status === 'pull-request' ? input.target.scope : null),
    code: code.code,
    stageSources: input.recovery?.request.stageSources,
    expandedContext: input.recovery?.request.expandedContext,
    operands: { action: 'assess-spec', origin: { kind: 'native-current' }, exactInputs },
  })
  const prepared =
    input.recovery === undefined
      ? await prepareDeliveryAction(input.uw, request)
      : canonicalValueDigest(request) !== canonicalValueDigest(input.recovery.request) ||
          !(await input.uw.verifyAction(input.recovery.prepared.snapshot)).ok
        ? null
        : { ok: true as const, value: input.recovery.prepared }
  if (prepared === null) return blocks('context-recovery-input-changed')
  if (!prepared.ok) return blocks(prepareRefusal(prepared.diagnostics), prepared.diagnostics)
  return sealReceipt({
    loaded: input.loaded,
    history: input.history,
    scope: input.scope,
    cwd: input.cwd,
    gh: input.gh,
    parents: input.evidence.parents,
    operationId: context.operationId,
    action: 'assess-spec',
    mandate: { scope: context.mandateScope, recordId: input.mandate.recordId, kind: 'mandate' },
    origin: { kind: 'native-current' },
    exactInputs,
    prepared: prepared.value,
  })
}

export async function startAssessmentReceipt(
  input: ModelReceiptActionInput,
  context: ReceiptStartContext,
): Promise<ContinueFeatureResult> {
  if (input.mandate.kind !== 'mandate' || input.currentSpec === null || input.identityAllocations === null)
    return { kind: 'blocked', reason: 'mandate-spec-missing' }
  const histories = input.evidence.causal.histories
  const historical = createHistoricalAcceptedSpecContext(histories)
  if (!historical.ok) return blocks(prepareRefusal(historical.diagnostics), historical.diagnostics)
  const proof = await plannerSuccessionInspection(input.mandate, input.evidence.causal)
  if (!proof.ok) return blocks(prepareRefusal(proof.diagnostics), proof.diagnostics)
  const disposition =
    input.recovery === undefined
      ? { ok: true as const, value: new Set<string>() }
      : await plannerSuccessionStarts(input.mandate, input.evidence.causal, {
          cwd: input.cwd,
          gh: input.gh,
          git: input.git,
        })
  if (!disposition.ok) return blocks(prepareRefusal(disposition.diagnostics), disposition.diagnostics)
  const replay =
    input.recovery === undefined
      ? { ok: true as const, value: undefined }
      : assessmentRecoveryReplay(
          input.recovery.request,
          histories,
          { kind: 'prepublication' },
          input.recovery.prepared.inputs.fingerprint,
          disposition.value,
        )
  if (!replay.ok) return blocks(prepareRefusal(replay.diagnostics), replay.diagnostics)
  const accepted = input.loaded.resolveAcceptedSpec(
    input.mandate,
    histories,
    replay.value,
    assessmentSuccessionInspection(proof.value),
    historical.value,
  )
  if (!accepted.ok) return { kind: 'blocked', reason: 'mandate-spec-missing' }
  const baseline = {
    ref: accepted.spec.ref,
    snapshot: accepted.spec.snapshot,
    tier: accepted.spec.tier,
    children: accepted.spec.children,
    inheritedOwnSpecRefs: accepted.spec.inheritedOwnSpecRefs,
    coverage: accepted.spec.coverage,
  }
  const childOwnSources = capturedChildOwnSources(
    baseline,
    input.currentSpec,
    histories,
    [],
    replay.value,
    historical.value,
  )
  if (childOwnSources === null) return blocks('assessment-child-authority-unavailable')
  return publishAssessmentReceipt(input, context, {
    format: 'omp-build-spec-assessment/3',
    accepted: baseline,
    proposed: input.currentSpec,
    attachedChildren: [],
    attachedWayfinders: [],
    childOwnSources: childOwnSources.childOwnSources,
    identityAllocations: input.identityAllocations,
    mechanical: mechanicalSpecDelta(baseline, input.currentSpec),
  })
}

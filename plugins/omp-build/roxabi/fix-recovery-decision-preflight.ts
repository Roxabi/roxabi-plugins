import { sameOwnSpecRef } from '../dist/contracts.js'
import { prepareCorrectionApplyAction } from './correction-native-apply.ts'
import { createCorrectionNativeRuntime } from './correction-native-execution.ts'
import { bindCorrectionAction } from './fix-action-binding.ts'
import type { FixActionResult, FixIdentity, FixRecord, PreparedFix } from './fix-contract.ts'
import { failure } from './fix-contract.ts'
import { correctionObservationRefs } from './fix-correction-observation-refs.ts'
import { previewCapturedCauseDispositions } from './fix-disposition-capture.ts'
import { admitStoredDecision, authorizeCorrectionContinuation, correctionStarted } from './fix-execution-authority.ts'
import type { DefaultFixWorkflow } from './fix-execution-policy.ts'
import { resolveFixOrigin } from './fix-origin.ts'
import type { PreparedUwAction } from './uw-action-contract.ts'

type Product = Pick<
  DefaultFixWorkflow,
  'native' | 'publisher' | 'runtime' | 'readHistory' | 'dispositionStore' | 'github'
>

/**
 * Replays the ordinary current source, disposition and first-action preparation without
 * entering the correction plan or dispatching. The caller must separately authenticate
 * the bounded, unspent owner lineage before using attempt one.
 */
export async function preflightRecoveryDecision(
  prepared: PreparedFix,
  decision: Extract<FixRecord, { kind: 'decision' }>,
  product: Product,
  identity: FixIdentity,
): Promise<
  FixActionResult<
    | { kind: 'prepared'; causeId: string; actionId: string; inputs: PreparedUwAction['inputs'] }
    | { kind: 'no-native-action' }
  >
> {
  if (product.runtime.signal.aborted) return failure('fix-run-interrupted-cleanup-unproven')
  const origin = await resolveFixOrigin(prepared.causeContext.original, product.runtime.uw)
  if (!origin.ok) return origin
  if (!sameOwnSpecRef(origin.value.effective.own, prepared.causeContext.effective.own))
    return failure('correction-origin-stale')
  const admitted = await admitStoredDecision(
    decision,
    product,
    'correction-decision-history-incomplete',
    'correction-decision-history-unreadable',
  )
  if (!admitted.ok) return admitted
  const disposition = await previewCapturedCauseDispositions(
    prepared.causeContext,
    { kind: 'decision', decision },
    product.dispositionStore,
    product.runtime.uw,
  )
  if (!disposition.ok) return disposition
  const selected = decision.payload.judgment.causes.find((cause) =>
    disposition.value.executableCauseIds.includes(cause.id),
  )
  if (selected === undefined) return { ok: true, value: { kind: 'no-native-action' } }
  const runtime = createCorrectionNativeRuntime({
    native: product.native,
    prepared,
    operationId: identity.operationId,
    decisionId: decision.recordId,
    decision: {
      repository: decision.repository,
      target: decision.target,
      kind: 'decision',
      recordId: decision.recordId,
      payload: decision.payload,
    },
    correctionObservationRefs: () => correctionObservationRefs(prepared, decision, product),
    operations: product.runtime.uw,
    authorizeContinuation: async () => {
      const allowed = await authorizeCorrectionContinuation(product.runtime)
      if (!allowed.ok) return allowed
      const latestOrigin = await resolveFixOrigin(prepared.causeContext.original, product.runtime.uw)
      if (!latestOrigin.ok) return latestOrigin
      if (!sameOwnSpecRef(latestOrigin.value.effective.own, prepared.causeContext.effective.own))
        return failure('correction-origin-stale')
      const current = await previewCapturedCauseDispositions(
        prepared.causeContext,
        { kind: 'decision', decision },
        product.dispositionStore,
        product.runtime.uw,
      )
      if (!current.ok) return current
      if (JSON.stringify(current.value.executableCauseIds) !== JSON.stringify(disposition.value.executableCauseIds))
        return failure('correction-disposition-changed')
      const admitted = await admitStoredDecision(
        decision,
        product,
        'correction-decision-history-incomplete',
        'correction-decision-history-unreadable',
      )
      return admitted.ok ? { ok: true, value: undefined } : admitted
    },
    signal: product.runtime.signal,
    bindAction: (binding) =>
      bindCorrectionAction(
        prepared,
        identity,
        product.publisher,
        decision.recordId,
        product.runtime,
        binding,
        product.readHistory,
      ),
    onStarted: (batch) => correctionStarted(product.runtime, batch),
  })
  const action = await prepareCorrectionApplyAction(runtime, selected, 1)
  if (!action.ok) return failure(...action.diagnostics)
  return {
    ok: true,
    value: {
      kind: 'prepared',
      causeId: selected.id,
      actionId: action.value.task.action.snapshot.actionId,
      inputs: action.value.task.action.inputs,
    },
  }
}

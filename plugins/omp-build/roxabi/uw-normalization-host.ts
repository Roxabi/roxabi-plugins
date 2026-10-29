import type { Diagnostic } from '../engine/record-values.ts'
import type { NativeBatchResult } from '../omp/review-runtime/contracts.ts'
import { observeHeadCode } from './delivery-action.ts'
import type { ContinueFeatureInput, ContinueFeatureResult, FeatureCommandHost } from './feature-contract.ts'
import { featureErrorMessage } from './feature-presentation.ts'
import type { PreparedUwAction } from './uw-action-contract.ts'
import type { NormalizationProposalRequest, UwOperations } from './uw-contract.ts'
import { settleNormalizationNegative } from './uw-normalization-negative.ts'
import {
  normalizationDeliveryBatch,
  normalizationOperationId,
  prepareNormalizationAction,
} from './uw-normalization-proposal.ts'
import {
  type NormalizationSettlement,
  nativeReferenceText,
  nativeResultDiagnostic,
  nativeResultReference,
  resultOf,
  sealNormalizationResult,
  sealNormalizationStart,
  writeNormalization,
} from './uw-normalization-settlement.ts'
import { defaultGit } from './workflow-checkout.ts'

type OpenedNormalization =
  | { kind: 'deliver'; reason: string }
  | { kind: 'stopped' }
  | { kind: 'ready'; operations: UwOperations; operationId: string; prepared: PreparedUwAction; startId: string }

function normalizationReady(
  canContinue: () => boolean,
  scheduled: boolean,
  cancelled: boolean,
  settlement: NormalizationSettlement | null,
  host: FeatureCommandHost,
): settlement is Extract<NormalizationSettlement, { ok: true }> {
  return canContinue() && !scheduled && !cancelled && settlement?.ok === true && !host.featureContinuationInhibited()
}

async function openNormalization(input: {
  request: NormalizationProposalRequest
  original: ContinueFeatureInput
  host: FeatureCommandHost
}): Promise<OpenedNormalization> {
  const { host, request } = input
  if (host.uw === undefined) return { kind: 'deliver', reason: 'prepare-action-unavailable' }
  if (host.featureContinuationInhibited() || host.principal) {
    await host.send('feature-stopped: continuation-inhibited')
    return { kind: 'stopped' }
  }
  const observed = await observeHeadCode(input.original.git ?? defaultGit(), input.original.cwd, request.uw.repository)
  if (!observed.ok) return { kind: 'deliver', reason: observed.reason }
  const operationId = normalizationOperationId(request)
  const prepared = await prepareNormalizationAction({
    operations: host.uw,
    request,
    operationId,
    code: observed.code,
  })
  if (!prepared.ok) return { kind: 'deliver', reason: prepared.reason }
  const sealed = await sealNormalizationStart({
    request,
    original: input.original,
    prepared: prepared.value,
    operationId,
  })
  if (!sealed.ok) return { kind: 'deliver', reason: sealed.reason }
  return { kind: 'ready', operations: host.uw, operationId, prepared: prepared.value, startId: sealed.startId }
}

/**
 * Announces once and schedules all UI/write work after bridge settlement. No callback awaits a
 * human interaction or a continuation; every post-native failure is delivered as one blocker.
 */
export async function announceUwNormalization(input: {
  reference: string
  request: NormalizationProposalRequest
  original: ContinueFeatureInput
  host: FeatureCommandHost
  deliver: (result: ContinueFeatureResult) => Promise<void>
}): Promise<void> {
  const { host, request } = input
  const opened = await openNormalization(input)
  if (opened.kind === 'deliver') {
    await input.deliver({ kind: 'blocked', reason: opened.reason })
    return
  }
  if (opened.kind === 'stopped') return
  const { operations, operationId, prepared, startId } = opened
  const batch = normalizationDeliveryBatch(operationId, prepared)
  let settlement: NormalizationSettlement | null = null
  let scheduled = false
  let cancelled = false
  let outcome = false
  const stopped = async (
    reason: string,
    diagnostics: readonly Diagnostic[] = [],
    result: NativeBatchResult | null = null,
  ): Promise<void> => {
    if (outcome) return
    outcome = true
    try {
      await input.deliver({
        kind: 'blocked',
        reason,
        ...(diagnostics.length === 0 ? {} : { diagnostics }),
      })
    } catch (error) {
      await host.send(
        [
          featureErrorMessage(error),
          `normalization-blocked: ${reason}`,
          ...diagnostics.map((diagnostic) => `normalization-diagnostic: ${diagnostic.code}`),
          `normalization-native: ${nativeReferenceText(result)}`,
        ].join('\n'),
      )
    }
  }
  const stopForError = async (error: unknown, result: NativeBatchResult | null): Promise<void> => {
    const reason = error instanceof Error ? error.message : String(error)
    await stopped(
      reason,
      [
        {
          code: 'normalization-settlement-failed',
          message: reason,
          ...(result === null ? {} : { operationId: result.batch.operationId }),
          detail: { native: nativeResultReference(result) },
        },
      ],
      result,
    )
  }
  const continueAfterNormalization = async (
    accepted: Extract<NormalizationSettlement, { ok: true }>,
    canContinue: () => boolean,
  ): Promise<void> => {
    if (!(await writeNormalization({ request, original: input.original, operations, accepted, stopped }))) return
    if (!canContinue() || host.featureContinuationInhibited()) return
    const next = await host.workflow.continueFeature({
      ...input.original,
      control: input.original.control === 'new' ? 'new' : 'continue',
      principal: false,
      uw: operations,
    })
    if (!canContinue()) return
    try {
      await input.deliver(next)
      outcome = true
    } catch (error) {
      await stopForError(error, accepted.result)
    }
  }
  const finish = async (canContinue: () => boolean): Promise<void> => {
    if (!normalizationReady(canContinue, scheduled, cancelled, settlement, host)) return
    const accepted = settlement
    scheduled = true
    try {
      const resultReceipt = await sealNormalizationResult({
        request,
        original: input.original,
        prepared,
        operationId,
        startId,
        judgement: accepted.judgement,
        result: accepted.result,
      })
      if (!canContinue() || !resultReceipt.ok) {
        if (!resultReceipt.ok) await stopped(resultReceipt.reason, [], accepted.result)
        return
      }
      await continueAfterNormalization(accepted, canContinue)
    } catch (error) {
      await stopForError(error, accepted.result)
    }
  }
  const reportDeferredFailure = async (error: unknown): Promise<void> => {
    try {
      await host.send(featureErrorMessage(error))
    } catch (reportError) {
      console.error(featureErrorMessage(reportError))
    }
  }
  const schedule = (run: () => Promise<void>): Promise<void> =>
    new Promise((resolve) => {
      setTimeout(() => {
        void run().catch(reportDeferredFailure).finally(resolve)
      }, 0)
    })
  try {
    host.native.activate(batch, {
      onComplete: (result, canContinue) => {
        if (!canContinue()) return
        settlement = resultOf(request, result, operations)
      },
      onSettled: (result, canContinue) => {
        if (!canContinue() || cancelled) return
        if (settlement === null) {
          return schedule(() =>
            stopped(
              'normalization-native-unsettled',
              [nativeResultDiagnostic(result, 'Native normalization result settled before completion')],
              result,
            ),
          )
        }
        if (!settlement.ok) {
          const blocked = settlement
          return schedule(() => stopped(blocked.reason, blocked.diagnostics, blocked.result))
        }
        return schedule(async () => {
          if (!canContinue()) return
          await finish(canContinue)
        })
      },
      onStop: async (reason, result) => {
        cancelled = true
        if (reason === 'action-context-missing' && result !== null)
          return settleNormalizationNegative({
            request,
            original: input.original,
            prepared,
            operationId,
            startId,
            result,
            stopped,
            stopForError,
          })
        await schedule(() =>
          stopped(
            `normalization-${reason}`,
            [nativeResultDiagnostic(result, `Native normalization stopped: ${reason}`)],
            result,
          ),
        )
      },
    })
    await host.native.announce(batch)
  } catch (error) {
    cancelled = true
    const reason = error instanceof Error ? error.message : String(error)
    let stopError: unknown = null
    try {
      await host.native.stopOwned(batch, reason)
    } catch (failedStop) {
      stopError = failedStop
    }
    await stopped(reason, [
      {
        code: 'normalization-announcement-failed',
        message: reason,
        ...(stopError === null
          ? {}
          : { detail: { stopError: stopError instanceof Error ? stopError.message : String(stopError) } }),
      },
    ])
  }
}

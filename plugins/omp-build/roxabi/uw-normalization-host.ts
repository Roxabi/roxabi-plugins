import { randomUUID } from 'node:crypto'
import { toDiagnostic, toDiagnostics } from '../dist/contracts.js'
import type { Diagnostic } from '../engine/record-values.ts'
import type { UwDiagnostic } from '../engine/uw-diagnostics.ts'
import type { NormalizationJudgement } from '../engine/uw-normalization-schema.ts'
import type { NativeBatch, NativeBatchResult } from '../omp/review-runtime/contracts.ts'
import type { ContinueFeatureInput, ContinueFeatureResult, FeatureCommandHost } from './feature-contract.ts'
import { featureErrorMessage } from './feature-presentation.ts'
import type { NormalizationProposalRequest, UwOperations } from './uw-contract.ts'
import { normalizationInput } from './uw-normalization-proposal.ts'

function normalizationBatch(request: NormalizationProposalRequest): NativeBatch {
  return {
    operationId: `uw-normalize:${request.uw.target}:${randomUUID()}`,
    tasks: {
      context: JSON.stringify({
        uw: request.uw,
        title: request.title,
        parsed: request.parsed,
        graph: request.graph,
        writes: request.writes,
      }),
      tasks: [
        {
          name: 'R-uw-normalize',
          agent: 'R-uw-normalize',
          tools: ['read', 'grep', 'glob'],
          task: 'Return the typed uw-normalization proposal from the supplied observed UW source facts only.',
          solutionSpace: 'one typed normalization judgement; no IDs, writes, or freeform scope',
        },
      ],
    },
  }
}
type NormalizationSettlement =
  | { ok: true; judgement: NormalizationJudgement; result: NativeBatchResult }
  | { ok: false; reason: string; diagnostics: readonly Diagnostic[]; result: NativeBatchResult }

function nativeResultReference(result: NativeBatchResult | null) {
  return {
    complete: result?.complete ?? false,
    childIds: result?.children.flatMap((child) => (child.id === null ? [] : [child.id])) ?? [],
  }
}

function nativeReferenceText(result: NativeBatchResult | null): string {
  const reference = nativeResultReference(result)
  return [
    `operationId=${result?.batch.operationId ?? 'absent'}`,
    `childIds=${reference.childIds.length === 0 ? 'none' : reference.childIds.join(',')}`,
  ].join(' ')
}

function nativeResultDiagnostic(result: NativeBatchResult | null, message: string): Diagnostic {
  return {
    code: 'normalization-native-result',
    message,
    ...(result === null ? {} : { operationId: result.batch.operationId }),
    detail: { native: nativeResultReference(result) },
  }
}

function operationDiagnostics(
  diagnostics: readonly (UwDiagnostic | { code: string; message: string })[],
): Diagnostic[] {
  return diagnostics.map((diagnostic) =>
    'location' in diagnostic ? toDiagnostic(diagnostic) : { code: diagnostic.code, message: diagnostic.message },
  )
}

function resultOf(
  request: NormalizationProposalRequest,
  settled: NativeBatchResult,
  operations: UwOperations,
): NormalizationSettlement {
  if (!settled.complete || settled.children.length !== 1)
    return {
      ok: false,
      reason: 'normalization-native-incomplete',
      diagnostics: [nativeResultDiagnostic(settled, 'Native normalization result was incomplete')],
      result: settled,
    }
  const child = settled.children[0]
  if (child === undefined || !child.usable || child.structured === null)
    return {
      ok: false,
      reason: child?.reason ?? 'normalization-native-unusable',
      diagnostics: [
        nativeResultDiagnostic(settled, `Native normalization result is unusable: ${child?.reason ?? 'unknown'}`),
      ],
      result: settled,
    }
  const parsed = operations.validateNormalization(request, child.structured)
  return parsed.ok
    ? { ok: true, judgement: parsed.value, result: settled }
    : {
        ok: false,
        reason: parsed.diagnostics[0]?.code ?? 'normalization-native-invalid',
        diagnostics: [
          ...toDiagnostics(parsed.diagnostics),
          nativeResultDiagnostic(settled, 'Native normalization result failed validation'),
        ],
        result: settled,
      }
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
  if (host.uw === undefined) {
    await host.send('feature-stopped: uw-unavailable')
    return
  }
  if (host.featureContinuationInhibited() || host.principal) {
    await host.send('feature-stopped: continuation-inhibited')
    return
  }
  const batch = normalizationBatch(request)
  const operations = host.uw
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
  const finish = async (): Promise<void> => {
    if (scheduled || cancelled || settlement === null || !settlement.ok || host.featureContinuationInhibited()) return
    const accepted = settlement
    scheduled = true
    try {
      const written = await operations.write(normalizationInput(request, accepted.judgement))
      if (written.status !== 'written') {
        const diagnostics =
          'diagnostics' in written
            ? operationDiagnostics(written.diagnostics)
            : [
                {
                  code: 'uw-normalization-write-status-invalid',
                  message: `Normalization write returned unexpected status: ${written.status}`,
                },
              ]
        await stopped(
          `uw-normalization-${written.status}`,
          [...diagnostics, nativeResultDiagnostic(accepted.result, 'Native normalization result could not be written')],
          accepted.result,
        )
        return
      }
      if (host.featureContinuationInhibited()) return
      const next = await host.workflow.continueFeature({
        ...input.original,
        control: 'continue',
        principal: false,
        uw: operations,
      })
      try {
        await input.deliver(next)
        outcome = true
      } catch (error) {
        await stopForError(error, accepted.result)
      }
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
  const schedule = (run: () => Promise<void>): void => {
    setTimeout(() => {
      void run().catch((error) => void reportDeferredFailure(error))
    }, 0)
  }
  try {
    host.native.activate(batch, {
      onComplete: (result) => {
        settlement = resultOf(request, result, operations)
      },
      onSettled: (result) => {
        if (cancelled) return
        if (settlement === null) {
          schedule(() =>
            stopped(
              'normalization-native-unsettled',
              [nativeResultDiagnostic(result, 'Native normalization result settled before completion')],
              result,
            ),
          )
          return
        }
        if (!settlement.ok) {
          const blocked = settlement
          schedule(() => stopped(blocked.reason, blocked.diagnostics, blocked.result))
          return
        }
        schedule(finish)
      },
      onStop: (reason, result) => {
        cancelled = true
        schedule(() =>
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

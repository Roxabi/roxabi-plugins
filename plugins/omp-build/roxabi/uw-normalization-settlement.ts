import { randomUUID } from 'node:crypto'
import { toDiagnostic, toDiagnostics } from '../dist/contracts.js'
import type { MissingContextOutput } from '../engine/action-context.ts'
import type { Diagnostic } from '../engine/record-values.ts'
import type { UwDiagnostic } from '../engine/uw-diagnostics.ts'
import type { NormalizationJudgement } from '../engine/uw-normalization-schema.ts'
import type { NativeBatchResult } from '../omp/review-runtime/contracts.ts'
import { confirmStartReadback, preMandateMandate } from './delivery-action.ts'
import type { ContinueFeatureInput } from './feature-contract.ts'
import { defaultGh, type History, loadContracts, publishRecord } from './feature-engine.ts'
import type { PreparedUwAction } from './uw-action-contract.ts'
import type { NormalizationProposalRequest, UwOperationResult, UwOperations } from './uw-contract.ts'
import { writeSuccessorNormalization } from './uw-normalization-internal.ts'
import { normalizationNegativeBinding } from './uw-normalization-negative-binding.ts'
import { normalizationInput, normalizationSourceDigest } from './uw-normalization-proposal.ts'

export type NormalizationSettlement =
  | { ok: true; judgement: NormalizationJudgement; result: NativeBatchResult }
  | { ok: false; reason: string; diagnostics: readonly Diagnostic[]; result: NativeBatchResult }

export function nativeResultReference(result: NativeBatchResult | null) {
  return {
    complete: result?.complete ?? false,
    childIds: result?.children.flatMap((child) => (child.id === null ? [] : [child.id])) ?? [],
  }
}

export function nativeReferenceText(result: NativeBatchResult | null): string {
  const reference = nativeResultReference(result)
  return [
    `operationId=${result?.batch.operationId ?? 'absent'}`,
    `childIds=${reference.childIds.length === 0 ? 'none' : reference.childIds.join(',')}`,
  ].join(' ')
}

export function nativeResultDiagnostic(result: NativeBatchResult | null, message: string): Diagnostic {
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

export function resultOf(
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

function normalizationWriteDiagnostics(written: Exclude<UwOperationResult, { status: 'written' }>): Diagnostic[] {
  return 'diagnostics' in written
    ? operationDiagnostics(written.diagnostics)
    : [
        {
          code: 'uw-normalization-write-status-invalid',
          message: `Normalization write returned unexpected status: ${written.status}`,
        },
      ]
}

export async function writeNormalization(input: {
  request: NormalizationProposalRequest
  original: ContinueFeatureInput
  operations: UwOperations
  accepted: Extract<NormalizationSettlement, { ok: true }>
  stopped: (reason: string, diagnostics?: readonly Diagnostic[], result?: NativeBatchResult | null) => Promise<void>
}): Promise<boolean> {
  const { request, original, operations, accepted, stopped } = input
  const proposal = normalizationInput(request, accepted.judgement)
  const pending =
    original.control === 'new' ? writeSuccessorNormalization(operations, request, proposal) : operations.write(proposal)
  if (pending === null) {
    await stopped('uw-normalization-ineligible')
    return false
  }
  const written = await pending
  if (written.status === 'written') return true
  await stopped(
    `uw-normalization-${written.status}`,
    [
      ...normalizationWriteDiagnostics(written),
      nativeResultDiagnostic(accepted.result, 'Native normalization result could not be written'),
    ],
    accepted.result,
  )
  return false
}

export async function sealNormalizationStart(input: {
  request: NormalizationProposalRequest
  original: ContinueFeatureInput
  prepared: PreparedUwAction
  operationId: string
}): Promise<{ ok: true; startId: string } | { ok: false; reason: string }> {
  const loaded = await loadContracts()
  if ('missing' in loaded) return { ok: false, reason: 'prepare-action-unavailable' }
  const gh = input.original.gh ?? defaultGh()
  const cwd = input.original.cwd
  const read = await loaded.readComposedWorkflowHistory([input.request.uw], { cwd, gh })
  const history: History | undefined = read.ok ? read.histories[0] : undefined
  if (history === undefined) return { ok: false, reason: 'action-start-unconfirmed' }
  const startId = randomUUID()
  const published = await publishRecord(
    loaded,
    history,
    {
      repository: input.request.uw.repository,
      target: input.request.uw.target,
      version: 1,
      recordId: startId,
      runId: randomUUID(),
      operationId: input.operationId,
      kind: 'action-receipt',
      payload: {
        format: 'omp-build-action-receipt/2',
        phase: 'start',
        action: 'normalize',
        actionId: input.operationId,
        mandate: preMandateMandate(),
        inputs: input.prepared.inputs,
        exactInputs: { uw: input.request.uw, bodySha256: normalizationSourceDigest(input.request) },
      },
    },
    gh,
    cwd,
  )
  if (!published.ok) return { ok: false, reason: published.reason }
  const confirmed = await confirmStartReadback({
    read: (scopes) => loaded.readComposedWorkflowHistory(scopes, { cwd, gh }),
    scope: input.request.uw,
    recordId: startId,
    inputs: input.prepared.inputs,
  })
  return confirmed.ok ? { ok: true, startId } : { ok: false, reason: confirmed.reason }
}

export async function sealNormalizationResult(input: {
  request: NormalizationProposalRequest
  original: ContinueFeatureInput
  prepared: PreparedUwAction
  operationId: string
  startId: string
  judgement: NormalizationJudgement | MissingContextOutput
  result: NativeBatchResult
}): Promise<{ ok: true; recordId: string } | { ok: false; reason: string }> {
  const loaded = await loadContracts()
  if ('missing' in loaded) return { ok: false, reason: 'prepare-action-unavailable' }
  const gh = input.original.gh ?? defaultGh()
  const cwd = input.original.cwd
  const read = await loaded.readComposedWorkflowHistory([input.request.uw], { cwd, gh })
  const history: History | undefined = read.ok ? read.histories[0] : undefined
  if (history === undefined) return { ok: false, reason: 'action-start-unconfirmed' }
  const child = input.result.children[0]
  if ('outcome' in input.judgement && input.judgement.outcome === 'missing-context') {
    const reason = normalizationNegativeBinding(input, history)
    if (reason !== null) return { ok: false, reason }
  }
  const recordId = randomUUID()
  const published = await publishRecord(
    loaded,
    history,
    {
      repository: input.request.uw.repository,
      target: input.request.uw.target,
      version: 1,
      recordId,
      runId: randomUUID(),
      operationId: `${input.operationId}:result`,
      kind: 'action-receipt',
      payload: {
        format: 'omp-build-action-receipt/2',
        phase: 'result',
        action: 'normalize',
        actionId: input.operationId,
        mandate: preMandateMandate(),
        inputs: input.prepared.inputs,
        start: { scope: input.request.uw, recordId: input.startId, kind: 'action-receipt' },
        exactInputs: { uw: input.request.uw, bodySha256: normalizationSourceDigest(input.request) },
        native: {
          completion: input.result.complete ? 'completed' : 'incomplete',
          strict: child?.usable === true ? 'valid' : 'invalid',
          raw: child?.raw ?? null,
        },
        structured: input.judgement,
        admission: null,
        diagnostics: [],
      },
    },
    gh,
    cwd,
    undefined,
    input.result.canPublishContext,
  )
  return published.ok ? { ok: true, recordId } : { ok: false, reason: published.reason }
}

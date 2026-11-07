import type { GitHubOptions } from '../adapters/github/types.ts'
import { buildRecord, publishConfirmedWorkflowRecord } from '../dist/contracts.js'
import type { DecodedHistory } from '../engine/history-schema.ts'
import type { Scope } from '../engine/record-values.ts'
import type { UwDiagnostic } from '../engine/uw-diagnostics.ts'
import type { FramingReceiptPayload, FramingReceiptRef } from '../engine/uw-framing-receipt-schema.ts'
import type { FramingMemberKey } from '../engine/uw-framing-schema.ts'
import { createPublicationContextResolver } from './publication-context.ts'
import type { FramingEffectGuard } from './uw-framing-contract.ts'

export type FramingReceiptPublication =
  | { status: 'confirmed'; ref: FramingReceiptRef }
  | { status: 'refused' | 'partial' | 'uncertain'; diagnostics: readonly UwDiagnostic[]; ref?: FramingReceiptRef }

function diagnostic(uw: Scope, code: string, message: string): UwDiagnostic {
  return { code, message, location: { kind: 'native', uw, connection: 'state' }, related: [] }
}

/** Publish one real canonical receipt, with the installed workflow publisher's readback. */
export async function publishFramingReceipt(input: {
  scope: Scope
  operationId: string
  proposalDigest: string
  effectId: string
  member: FramingMemberKey | null
  payload: FramingReceiptPayload
  histories: readonly DecodedHistory[]
  github: GitHubOptions
  guard: FramingEffectGuard
}): Promise<FramingReceiptPublication> {
  const recordId = `framing-receipt:${input.effectId}`
  const record = buildRecord({
    version: 1,
    repository: input.scope.repository,
    target: input.scope.target,
    recordId,
    runId: input.operationId,
    operationId: input.effectId,
    kind: 'framing-receipt',
    payload: input.payload,
  })
  if (!record.ok)
    return {
      status: 'refused',
      diagnostics: record.diagnostics.map((item) => diagnostic(input.scope, item.code, item.message)),
    }
  const point = {
    operationId: input.operationId,
    proposalDigest: input.proposalDigest,
    member: input.member,
    effectId: input.effectId,
  }
  try {
    await input.guard.check({ ...point, at: 'before-effect' })
  } catch (error) {
    return {
      status: 'refused',
      diagnostics: [
        diagnostic(input.scope, 'framing-guard-refused', error instanceof Error ? error.message : String(error)),
      ],
    }
  }
  try {
    const published = await publishConfirmedWorkflowRecord(
      record.value,
      input.github,
      createPublicationContextResolver(input.github, null),
      input.histories,
    )
    if (published.status !== 'confirmed')
      return {
        status: published.status,
        diagnostics: published.diagnostics.map((item) => diagnostic(input.scope, item.code, item.message)),
      }
  } catch (error) {
    return {
      status: 'uncertain',
      diagnostics: [
        diagnostic(
          input.scope,
          'framing-publication-uncertain',
          error instanceof Error ? error.message : String(error),
        ),
      ],
    }
  }
  try {
    await input.guard.check({ ...point, at: 'after-readback' })
  } catch (error) {
    return {
      status: 'partial',
      ref: { scope: input.scope, kind: 'framing-receipt', recordId },
      diagnostics: [
        diagnostic(input.scope, 'framing-guard-changed', error instanceof Error ? error.message : String(error)),
      ],
    }
  }
  return { status: 'confirmed', ref: { scope: input.scope, kind: 'framing-receipt', recordId } }
}

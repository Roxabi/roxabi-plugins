import { expect } from 'vitest'
import { decodeHistory } from '../../adapters/github/history-codec.ts'
import { encodeParts } from '../../adapters/github/history-encoder.ts'
import type { DecodedHistory } from '../../engine/history-schema.ts'
import { resolveAcceptedSpec } from '../../engine/workflow-accepted-spec.ts'
import { contextHandoffPrefixHistories } from '../../engine/workflow-context-handoff-history.ts'
import { admitContextSuccession } from '../../engine/workflow-context-succession.ts'
import {
  createHistoricalAcceptedSpecContext,
  historicalAcceptedSpecFrame,
  historicalAcceptedSpecOwnedHistories,
} from '../../engine/workflow-context-succession-inspection.ts'
import { selectIncoming, validateCapturedCut } from '../../engine/workflow-context-succession-inspection-phases.ts'
import { type ControlRecord, recordsOf } from '../../engine/workflow-control.ts'

export function assertConfirmationRollback(
  histories: readonly DecodedHistory[],
  home: DecodedHistory,
  selection: ControlRecord,
  parts: DecodedHistory['operations'][number]['parts'],
) {
  if (selection.payload.control !== 'select-successor' || !selection.payload.contextDisposition)
    throw new Error('Context succession control unavailable')
  const disposition = selection.payload.contextDisposition
  const { successor: successorRef, predecessor: predecessorRef } = selection.payload
  const confirmation = disposition.confirmation
  const replacementDigest = `${confirmation.proposalDigest[0] === '0' ? '1' : '0'}${confirmation.proposalDigest.slice(1)}`
  const changed = {
    ...selection,
    payload: {
      ...selection.payload,
      contextDisposition: { ...disposition, confirmation: { ...confirmation, proposalDigest: replacementDigest } },
    },
  }
  const encoded = encodeParts(changed, '# Successor selection', 65_536)
  if (!encoded.ok || parts.length === 0) throw new Error('Confirmation variant could not be framed')
  const ids = new Set(parts.map((part) => part.nativeId))
  const firstId = parts[0]?.nativeId
  const comments = home.source.comments.flatMap((comment) => {
    if (!ids.has(comment.nativeId)) return [comment]
    if (comment.nativeId !== firstId) return []
    return encoded.value.map((body, index) => ({
      ...comment,
      body,
      nativeId: index === 0 ? comment.nativeId : `confirmation-variant-${index}`,
      locator: index === 0 ? comment.locator : `${home.source.scope.target}:confirmation-variant-${index}`,
    }))
  })
  const changedHome = decodeHistory({ ...home.source, comments })
  const changedHistories = histories.map((history) => (history === home ? changedHome : history))
  const successor = recordsOf(changedHome).find((record) => record.recordId === successorRef.recordId)
  const predecessor = recordsOf(changedHome).find((record) => record.recordId === predecessorRef.recordId)
  if (successor?.kind !== 'mandate' || predecessor?.kind !== 'mandate')
    throw new Error('Succession mandates unavailable')
  const originalContext = createHistoricalAcceptedSpecContext(histories)
  if (!originalContext.ok) throw new Error('Original historical context unavailable')
  expect(resolveAcceptedSpec(successor, histories, undefined, undefined, originalContext.value)).toMatchObject({
    ok: true,
  })
  const incoming = selectIncoming(changedHistories, successor)
  if (!incoming.ok || !incoming.value)
    throw new Error(`Unique incoming selection unavailable: ${JSON.stringify(incoming)}`)
  expect(incoming.value.control).toEqual(changed)
  const cut = contextHandoffPrefixHistories(changedHistories, disposition.reconciliation.cuts)
  if (!cut) throw new Error('Confirmation variant cut unavailable')
  expect(validateCapturedCut(cut, changedHistories, incoming.value, successor)).toEqual({ ok: true, value: undefined })
  expect(admitContextSuccession(incoming.value.control, changedHistories)).toMatchObject({
    ok: false,
    diagnostics: expect.arrayContaining([
      expect.objectContaining({ message: 'Context succession confirmation is not bound' }),
    ]),
  })
  const context = createHistoricalAcceptedSpecContext(changedHistories)
  const independent = createHistoricalAcceptedSpecContext(cut)
  if (!context.ok || !independent.ok) throw new Error('Historical contexts unavailable')
  expect(resolveAcceptedSpec(predecessor, structuredClone(cut), undefined, undefined, independent.value)).toMatchObject(
    { ok: true },
  )
  expect(historicalAcceptedSpecFrame(context.value, changedHistories, successor).ok).toBe(false)
  expect(resolveAcceptedSpec(successor, changedHistories, undefined, undefined, context.value)).toMatchObject({
    ok: false,
  })
  const externalCut = structuredClone(cut)
  expect(historicalAcceptedSpecOwnedHistories(context.value, externalCut).ok).toBe(false)
  expect(historicalAcceptedSpecFrame(context.value, externalCut, predecessor).ok).toBe(false)
  expect(resolveAcceptedSpec(predecessor, externalCut, undefined, undefined, context.value)).toMatchObject({
    ok: false,
  })
}
